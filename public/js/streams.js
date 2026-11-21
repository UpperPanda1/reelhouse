// Decide which source to try first, warn about files a browser is likely to mishandle, and offer external-player links.
// Why this exists: measured in Chromium, HEVC video decodes as a 0x0 picture and AC-3 audio decodes to silence,
// both WITHOUT a media error. MOV/MKV with H.264+AAC play fine whatever Content-Type the server sends.
import { sanitizeFilename } from './util.js';

const PROVIDER_ORDER = { 'bdix-df': 0, 'bdix-cf': 1, 'bdix-fh': 2, fendrix: 3, hexion: 4, mavonyx: 5 };
const CONTAINER_SCORE = { mp4: 4, m4v: 4, mov: 3, webm: 3, m3u8: 3, mkv: 2, ts: 1, avi: 0, unknown: 1 };
const LEVEL = { ok: 0, warn: 1, bad: 2 };

/** What this browser can decode, from canPlayType probes (never used to *reject* MOV/MKV, see header). */
export function browserCaps(video = typeof document !== 'undefined' ? document.createElement('video') : null, ua = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  const can = (t) => { try { return !!video && video.canPlayType(t) !== ''; } catch { return false; } };
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
  const safari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(ua);
  return {
    hevc: can('video/mp4; codecs="hvc1.1.6.L93.B0"') || can('video/mp4; codecs="hev1.1.6.L93.B0"'),
    av1: can('video/mp4; codecs="av01.0.05M.08"'),
    vp9: can('video/webm; codecs="vp9"'),
    ac3: can('audio/mp4; codecs="ac-3"'),
    eac3: can('audio/mp4; codecs="ec-3"'),
    mkv: !(ios || safari), // Safari/iOS cannot open Matroska
    // built-in HLS (Safari, iOS, Chrome 142+): media-element requests carry no Origin header, which some CDNs require
    nativeHls: can('application/vnd.apple.mpegurl'),
    platform: /Android/i.test(ua) ? 'android' : ios ? 'ios' : 'desktop',
  };
}

/** @returns {{level:'ok'|'warn'|'bad', reasons:string[]}} */
export function playability(stream, caps) {
  // caps.mpv: the video goes to mpv (Settings, Play in), which plays every container, codec and DASH, and sends cookies
  if (caps.mpv) return { level: 'ok', reasons: [] };
  const reasons = [];
  let level = 'ok';
  const bump = (l, why) => { reasons.push(why); if (LEVEL[l] > LEVEL[level]) level = l; };
  const info = stream.info || {};
  if (stream.container === 'avi') bump('bad', 'AVI files are not supported by browsers');
  if (stream.container === 'mkv' && !caps.mkv) bump('bad', 'This browser cannot open MKV files');
  if (info.video === 'hevc' && !caps.hevc) bump('bad', 'HEVC (H.265) video is not supported by this browser');
  if (info.video === 'xvid') bump('bad', 'XviD video is not supported by browsers');
  // caps.gateway: a gateway is configured; it fetches such streams without an Origin (net.mediaUrl, player only)
  if (stream.needsNativeHls && !caps.nativeHls && !caps.gateway) bump('bad', 'This server only plays in browsers with built-in HLS (Chrome 142+, Edge, Safari), through the gateway (Settings, Connection) or in an external player');
  if (stream.container === 'mpd') bump('bad', 'DASH does not play here yet; try an external player');
  if (stream.signedCookie) bump('warn', 'May need a cookie a browser cannot send');
  if (info.video === 'vc1') bump('bad', 'VC-1 video is not supported by browsers');
  if (info.video === 'av1' && !caps.av1) bump('bad', 'AV1 video is not supported by this browser');
  const audio = info.audio || [];
  if (audio.length) {
    const playable = audio.some((a) => ['aac', 'opus', 'mp3', 'flac'].includes(a) || (a === 'ac3' && caps.ac3) || (a === 'eac3' && caps.eac3));
    if (!playable) bump('warn', `Audio (${audio.map((a) => ({ eac3: 'DD+', ac3: 'AC-3', truehd: 'TrueHD', dts: 'DTS' }[a] || a)).join(', ')}) may be silent in a browser`);
  }
  return { level, reasons };
}

/** Best first: playable before risky, then resolution, then container friendliness, then provider order. Stable. */
export function rank(streams, caps, { preferCompatible = true } = {}) {
  const scored = streams.map((s, i) => ({ s, i, p: playability(s, caps) }));
  scored.sort((a, b) => {
    if (preferCompatible && LEVEL[a.p.level] !== LEVEL[b.p.level]) return LEVEL[a.p.level] - LEVEL[b.p.level];
    return (b.s.height || 0) - (a.s.height || 0)
      || (CONTAINER_SCORE[b.s.container] ?? 1) - (CONTAINER_SCORE[a.s.container] ?? 1)
      || (PROVIDER_ORDER[a.s.provider] ?? 9) - (PROVIDER_ORDER[b.s.provider] ?? 9)
      || a.i - b.i;
  });
  return scored.map(({ s, p }) => ({ ...s, play: p }));
}

export const sourceLabel = (s) => [s.quality && s.quality !== 'Unknown' && s.quality !== 'auto' ? s.quality : '', s.container !== 'unknown' ? s.container.toUpperCase() : ''].filter(Boolean).join(' ');

export function filenameFor(stream, title) {
  const ext = stream.container !== 'unknown' ? stream.container : 'mp4';
  return sanitizeFilename(stream.filename && /\.[a-z0-9]{2,4}$/i.test(stream.filename) ? stream.filename : `${title}.${ext}`);
}

/** Links that open the file in an installed external player. `playUrl` is whatever URL the browser can reach. */
export function externalLinks(playUrl, title, platform) {
  const enc = encodeURIComponent(playUrl);
  const links = [];
  if (platform === 'android') {
    const m = playUrl.match(/^(https?):\/\/(.*)$/i);
    if (m) {
      const intent = (pkg) => `intent://${m[2]}#Intent;scheme=${m[1].toLowerCase()};action=android.intent.action.VIEW;type=video/*;package=${pkg};S.title=${encodeURIComponent(title)};end`;
      links.push({ id: 'vlc', label: 'VLC', href: intent('org.videolan.vlc') }, { id: 'mx', label: 'MX Player', href: intent('com.mxtech.videoplayer.ad') });
    }
  } else if (platform === 'ios') {
    links.push({ id: 'vlc', label: 'VLC', href: `vlc-x-callback://x-callback-url/stream?url=${enc}` }, { id: 'infuse', label: 'Infuse', href: `infuse://x-callback-url/play?url=${enc}` });
  }
  return links;
}

/** A one-entry playlist that VLC, mpv, PotPlayer, etc. open directly. Works on every desktop OS. */
export function m3uPlaylist(playUrl, title) {
  return `#EXTM3U\n#EXTINF:-1,${String(title).replace(/[\r\n]+/g, ' ')}\n${playUrl}\n`;
}
