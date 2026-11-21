// The ONLY place BDIX providers get queried, and only after the user clicks Play or Download.
import { h, mount, sanitizeFilename, copyText, progressKey } from '../util.js';
import { resolveStreams, PROVIDERS } from '../providers/index.js';
import { net, caps } from '../core.js';
import { store } from '../store.js';
import { rank, sourceLabel, filenameFor, externalLinks, m3uPlaylist } from '../streams.js';
import { openSheet, icon, toast } from './components.js';
import { mpvLink } from '../mpv.js';

const CACHE_MS = 10 * 60_000;
const cache = new Map();
export const metaKey = (m) => `${m.type}:${m.tmdbId}:${m.season || ''}:${m.episode || ''}`;

export async function lookupSources(meta, { signal, onProgress, force = false, settleMs = 0 } = {}) {
  const s = store.settings();
  const gw = !!String(s.gatewayUrl || '').trim();
  const mpv = s.playIn === 'mpv';
  const key = metaKey(meta) + (gw ? '|gw' : '') + (mpv ? '|mpv' : ''); // ranking depends on the gateway (Fendrix HLS without built-in HLS) and on mpv
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.t < CACHE_MS) return hit.out;
  const res = await resolveStreams(meta, { net, enabled: s.providers, signal, onProgress, compat: s.compat, settleMs });
  const out = { streams: rank(res.streams, { ...caps(), gateway: gw, mpv }, { preferCompatible: s.preferCompatible }), status: res.status, partial: res.partial };
  if (!(signal && signal.aborted) && out.streams.length && !out.partial) cache.set(key, { t: Date.now(), out });
  return out;
}

const STATE_TEXT = { start: 'searching', ok: null, empty: 'no match', unreachable: 'unreachable', error: 'server error', timeout: 'timed out', slow: 'still searching', cancelled: 'cancelled', blocked: 'needs gateway' };
export function providerChips(status) {
  return h('div', { class: 'pstat', 'aria-label': 'Source servers' }, PROVIDERS.map((p) => {
    const st = status[p.id];
    const enabled = store.settings().providers[p.id] !== false;
    if (!enabled) return h('span', { class: 'chip run' }, `${p.name}: off`);
    if (!st || st.state === 'start') return h('span', { class: 'chip run', dataset: { provider: p.id, state: 'start' } }, `${p.name}: searching`);
    const cls = st.state === 'ok' ? 'ok' : st.state === 'unreachable' || st.state === 'error' || st.state === 'timeout' || st.state === 'blocked' ? 'bad' : 'run';
    return h('span', { class: `chip ${cls}`, dataset: { provider: p.id, state: st.state } }, `${p.name}: ${st.state === 'ok' ? `${st.count} found` : STATE_TEXT[st.state]}`);
  }));
}

export function openSettingsEvent() { document.dispatchEvent(new CustomEvent('rh:settings')); }

/** Explains an empty result in terms the user can act on. BDIX servers and online sources fail for different
 * reasons (network vs. the site itself), so each group is judged on its own. */
export function guidance(status, meta, { retry } = {}) {
  const active = Object.values(status).filter((s) => s.state !== 'cancelled');
  const gw = !!store.settings().gatewayUrl;
  const asked = (group) => PROVIDERS.filter((p) => (p.group === 'bdix') === (group === 'bdix') && status[p.id] && status[p.id].state !== 'cancelled').map((p) => status[p.id].state);
  const bdix = asked('bdix');
  const online = asked('public');
  const down = (st) => st === 'unreachable' || st === 'timeout';
  const bdixDown = bdix.length > 0 && bdix.every(down);
  const onlineDown = online.length > 0 && online.every((st) => down(st) || st === 'error' || st === 'blocked');
  const blockedHint = !gw && online.includes('blocked') ? h('li', null, 'Hexion\u2019s sites refuse requests from this website\u2019s edge server. The gateway (Connection settings) fetches them over your own connection.') : null;
  const btns = h('div', { class: 'actions' },
    retry ? h('button', { class: 'btn small', type: 'button', onClick: retry }, 'Try again') : null,
    h('button', { class: 'btn small', type: 'button', onClick: openSettingsEvent }, 'Connection settings'));
  if (!active.length) return h('div', { class: 'notice' }, h('h3', null, 'All sources are switched off'), h('p', null, 'Turn at least one source on in Settings.'), btns);
  const onlineHint = onlineDown && !blockedHint ? h('li', null, 'The online sources did not answer either: check this device\u2019s internet connection, or try again later.') : null;
  if (bdixDown) {
    return h('div', { class: 'notice warn' }, h('h3', null, gw ? 'The gateway could not reach the BDIX servers' : 'Could not reach the BDIX servers'),
      gw ? h('ul', null, h('li', null, 'Is the gateway still running and reachable from this device?'), h('li', null, 'Is this device\u2019s network (or the gateway\u2019s) connected to BDIX?'), h('li', null, 'Check the gateway address and token in Connection settings.'), onlineHint)
        : h('ul', null,
          h('li', null, 'You need to be on a BDIX-connected network (the servers are not on the public internet).'),
          h('li', null, 'Browsers block plain-http servers from an https site. Chrome/Edge ask for \u201clocal network\u201d permission for private addresses; Firefox/Safari do not allow it.'),
          h('li', null, 'The most reliable fix is the small gateway app (see Connection settings).'), onlineHint, blockedHint),
      btns);
  }
  if (onlineDown && !bdix.length) {
    return h('div', { class: 'notice warn' }, h('h3', null, blockedHint ? 'This source needs the gateway here' : 'Could not reach the online sources'),
      blockedHint ? h('ul', null, blockedHint) : h('ul', null, h('li', null, 'Check this device\u2019s internet connection.'), h('li', null, 'The sources may be down or may have moved; try again later.')), btns);
  }
  if (active.every((s) => s.state === 'empty' || down(s.state) || s.state === 'error' || s.state === 'blocked')) {
    return h('div', { class: 'notice' }, h('h3', null, 'No matching files found'), h('p', null, `Nothing on the connected servers matches \u201c${meta.title}${meta.year ? ` (${meta.year})` : ''}\u201d${meta.type === 'tv' ? ` S${meta.season} E${meta.episode}` : ''}. Some servers may be unreachable (see above).`), btns);
  }
  return null;
}

const copy = (text) => copyText(text).then((ok) => (ok ? toast('Link copied') : toast('Could not copy. Long-press the download link instead.', { error: true })));

function ticket(stream, { mode, title, onPlay, selectedId, first, mpvStart }) {
  const q = stream.quality && stream.quality !== 'Unknown' && stream.quality !== 'auto' ? stream.quality : 'Auto';
  const info = stream.info || {};
  const tags = [stream.sizeLabel, info.source, info.hdr, info.dv ? 'Dolby Vision' : '', info.codecLabel, info.audioLabel, info.tenBit ? '10-bit' : '', info.imax ? 'IMAX' : '', ...(info.langs || [])].filter(Boolean);
  const play = stream.play || { level: 'ok', reasons: [] };
  const name = filenameFor(stream, title);
  const platform = caps().platform;
  const playUrl = net.mediaUrl(stream);
  const menu = h('div', { class: 'menu', hidden: true });
  const ext = externalLinks(playUrl, title, platform);
  menu.append(
    h('button', { class: 'btn small', type: 'button', onClick: () => copy(playUrl) }, icon('copy'), 'Copy link'),
    ...ext.map((l) => h('a', { class: 'btn small', href: l.href }, icon('external'), `Open in ${l.label}`)),
    h('a', { class: 'btn small', href: 'data:audio/x-mpegurl;charset=utf-8,' + encodeURIComponent(m3uPlaylist(playUrl, title)), download: sanitizeFilename(title) + '.m3u' }, icon('external'), 'Playlist (.m3u) for VLC / mpv'));
  const pri = first ? ' primary' : '';
  // mpv (Settings, Play in): the link carries the file's own address, so mpv needs no gateway once it is open
  const primary = mode === 'download'
    ? h('a', { class: `btn small${pri}`, href: net.mediaUrl(stream, { download: true, filename: name }), download: name, target: '_blank', rel: 'noopener noreferrer' }, icon('download'), 'Download')
    : mpvStart != null
      ? h('a', { class: `btn small${pri}`, href: mpvLink(stream, { title, start: mpvStart }), dataset: { mpv: '1' } }, icon('play'), 'Open in mpv')
      : h('button', { class: `btn small${selectedId === stream.id ? ' primary' : pri}`, type: 'button', onClick: () => onPlay && onPlay(stream) }, icon('play'), selectedId === stream.id ? 'Playing' : 'Play');
  return h('li', { class: `ticket${selectedId === stream.id ? ' sel' : ''}`, dataset: { provider: stream.provider, level: play.level } },
    h('div', { class: 'stub' }, h('b', null, q), h('small', null, stream.container !== 'unknown' ? stream.container.toUpperCase() : '')),
    h('div', { class: 'tbody' },
      h('div', { class: 'name' }, stream.filename || sourceLabel(stream)),
      h('div', { class: 'from' }, stream.providerName),
      h('div', { class: 'tags' }, first && play.level === 'ok' ? h('span', { class: 'tag good' }, 'Recommended') : null, tags.map((t) => h('span', { class: 'tag' }, t)), play.level === 'warn' ? h('span', { class: 'tag warn' }, 'May lack audio') : null, play.level === 'bad' ? h('span', { class: 'tag bad' }, 'Unlikely to play here') : null),
      play.reasons.length ? h('div', { class: 'why' }, play.reasons.join('. ') + '.') : null,
      h('div', { class: 'tact' }, primary, h('button', { class: 'btn small ghost', type: 'button', 'aria-expanded': 'false', onClick: (e) => { menu.hidden = !menu.hidden; e.currentTarget.setAttribute('aria-expanded', String(!menu.hidden)); } }, 'More')),
      menu));
}

/** Renders the result list into `container`. */
export function renderResult(container, result, { mode, meta, title, onPlay, selectedId, retry }) {
  const nodes = [providerChips(result.status)];
  const mpvStart = mode === 'play' && store.settings().playIn === 'mpv' && meta ? store.resumePoint(progressKey(meta.type, meta.tmdbId, meta.season, meta.episode)) : null;
  if (result.streams.length) nodes.push(h('ul', { class: 'tickets' }, result.streams.map((s, i) => ticket(s, { mode, title, onPlay, selectedId, first: i === 0, mpvStart }))));
  else { const g = guidance(result.status, meta, { retry }); if (g) nodes.push(g); }
  mount(container, ...nodes);
}

/** Sheet used by the Download buttons (and by the player's "all sources" list). */
export function openSources({ meta, title, mode = 'download', onPlay, selectedId }) {
  const ctrl = new AbortController();
  const sheet = openSheet({ title: mode === 'download' ? 'Download' : 'Sources', subtitle: title, onClose: () => ctrl.abort() });
  const status = {};
  const drawLoading = () => mount(sheet.body, providerChips(status), h('div', { class: 'spin', role: 'status', 'aria-label': 'Searching' }));
  const run = async (force) => {
    for (const k of Object.keys(status)) delete status[k];
    drawLoading();
    try {
      const result = await lookupSources(meta, {
        signal: ctrl.signal, force,
        onProgress: (id, ev, st) => { status[id] = ev === 'done' ? st : { state: 'start' }; if (!ctrl.signal.aborted) drawLoading(); },
      });
      if (ctrl.signal.aborted) return;
      renderResult(sheet.body, result, { mode, meta, title, selectedId, onPlay: (s) => { sheet.close(); onPlay && onPlay(s); }, retry: () => run(true) });
    } catch (e) { if (!(e && e.name === 'AbortError')) mount(sheet.body, h('div', { class: 'notice' }, h('h3', null, 'Lookup failed'), h('p', null, e.message || 'Unexpected error'))); }
  };
  run(false);
  return sheet;
}
