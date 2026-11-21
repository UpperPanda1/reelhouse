// "Play in mpv": a raftv-mpv:// link that the gateway program (raftv-gateway.exe --mpv-register, once) hands to
// mpv. The link carries the stream's OWN URL and the headers it needs, never the gateway's address: mpv runs on this
// computer, which is on the BDIX network, and is not a browser (no CORS, no mixed-content rule, may send Referer and
// User-Agent), so once the search is done the gateway can be closed. Read by gateway/mpv-handler.mjs.
export const MPV_SCHEME = 'raftv-mpv';
// the same per-host Referers the gateway adds (gateway/bdix-gateway.mjs DEFAULT_REFERERS; a test keeps them equal)
export const MPV_DEFAULT_REFERERS = { 'new.circleftp.net': 'http://new.circleftp.net/', '15.1.1.50': 'http://new.circleftp.net/', 'flixhub.net': 'https://flixhub.net/', 'www.flixhub.net': 'https://flixhub.net/' };
const HEADER_NAME = /^[a-z0-9-]{1,40}$/;
const BAD_VALUE = /[\u0000-\u001f\u007f]/;

const b64url = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** @returns {string} raftv-mpv://play?d=<base64url JSON {v, u, t, h, s}> */
export function mpvLink(stream, { title = '', start = 0 } = {}) {
  const h = {};
  for (const [k, v] of Object.entries(stream.headers || {})) {
    const name = k.toLowerCase();
    if (HEADER_NAME.test(name) && typeof v === 'string' && !BAD_VALUE.test(v)) h[name] = v;
  }
  if (!h.referer) { try { const r = MPV_DEFAULT_REFERERS[new URL(stream.url).hostname]; if (r) h.referer = r; } catch { /* no host */ } }
  const d = { v: 1, u: stream.url, t: String(title || ''), h };
  if (Number.isFinite(start) && start > 0) d.s = Math.floor(start);
  return `${MPV_SCHEME}://play?d=${b64url(JSON.stringify(d))}`;
}
