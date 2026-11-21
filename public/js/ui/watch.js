import { h, mount, imgUrl, progressKey } from '../util.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { net, caps } from '../core.js';
import { createPlayer } from '../player.js';
import { fetchSubtitleList, loadSubtitleBlob, loadSourceSubtitle, vttBlobUrl, decodeBytes, langName, SUB_LANGS } from '../subs.js';
import { icon, openSheet, toast } from './components.js';
import { lookupSources, providerChips, guidance, openSources } from './sources.js';
import { hrefWatch, hrefTitle } from '../router.js';
import { externalLinks, m3uPlaylist, filenameFor, sourceLabel } from '../streams.js';
import { mpvLink } from '../mpv.js';
import { BRAND } from '../brand.js';

function nextEpisode(d, season, episode) {
  const s = d.seasons.find((x) => x.n === season);
  if (s && episode < s.episodes) return { season, episode: episode + 1 };
  const nextSeason = d.seasons.find((x) => x.n > season);
  return nextSeason ? { season: nextSeason.n, episode: 1 } : null;
}

export function watchView({ root, route, signal }) {
  const { type, id } = route.params;
  const season = route.params.season;
  const episode = route.params.episode;
  const key = progressKey(type, id, season, episode);
  const status = {};
  let player = null;
  let d = null;
  let results = null;
  const tried = new Set();
  const subBlobs = [];

  const loading = h('div', { class: 'loading', role: 'status' }, h('div', { class: 'spin' }), h('h2', null, 'Finding sources\u2026'), h('div', { class: 'chips-slot' }));
  const stage = h('div', { class: 'stage' }, loading);
  const banners = h('div');
  const tools = h('div', { class: 'toolrow' });
  const titleEl = h('h1', null, '');
  const back = h('a', { class: 'iconbtn', href: hrefTitle(type, id), 'aria-label': 'Back to details' }, icon('left'));
  mount(root, h('div', { class: 'watch' }, h('div', { class: 'watch-top' }, back, titleEl), stage, h('div', { class: 'watch-below' }, banners, tools)));

  const paintChips = () => { const slot = loading.querySelector('.chips-slot'); if (slot) mount(slot, providerChips(status)); };
  // sheets (sources, subtitles) sit above the player; when one closes, give keyboard shortcuts back to the player
  const refocus = () => { if (player) player.focus(); };
  document.addEventListener('close', refocus, true);
  signal.addEventListener('abort', () => { document.removeEventListener('close', refocus, true); if (player) player.destroy(); subBlobs.forEach((u) => URL.revokeObjectURL(u)); });

  function showStageError(node) { mount(stage, h('div', { class: 'loading msg' }, node)); }

  // ---------------- fallback handling ----------------
  function nextCandidate({ strict }) {
    return results.streams.find((s) => !tried.has(s.id) && (strict ? s.play.level === 'ok' : s.play.level !== 'bad'));
  }
  function banner(kind, titleText, text, actions) {
    mount(banners, h('div', { class: `banner${kind === 'bad' ? ' bad' : ''}`, role: 'alert' }, icon('warn'),
      h('div', null, h('h3', null, titleText), h('p', null, text), h('div', { class: 'acts' }, actions))));
  }
  function externalActions(stream) {
    const url = net.mediaUrl(stream);
    const name = filenameFor(stream, d.title);
    return [
      ...externalLinks(url, d.title, caps().platform).map((l) => h('a', { class: 'btn small', href: l.href }, icon('external'), `Open in ${l.label}`)),
      h('a', { class: 'btn small', href: 'data:audio/x-mpegurl;charset=utf-8,' + encodeURIComponent(m3uPlaylist(url, d.title)), download: name.replace(/\.[^.]+$/, '') + '.m3u' }, icon('external'), 'Open in VLC / mpv (.m3u)'),
      h('a', { class: 'btn small', href: net.mediaUrl(stream, { download: true, filename: name }), download: name, target: '_blank', rel: 'noopener noreferrer' }, icon('download'), 'Download'),
    ];
  }
  function onIssue({ kind, stream }) {
    tried.add(stream.id);
    const next = nextCandidate({ strict: false });
    if (kind === 'audio-unsupported') {
      const alt = nextCandidate({ strict: true });
      banner('warn', 'No sound from this file', 'Your browser cannot decode this file\u2019s audio (common with Dolby Digital+/AC-3/DTS). Try another source or play it in an external player.',
        [alt ? h('button', { class: 'btn small primary', type: 'button', onClick: () => { mount(banners); player.switchTo(alt); } }, 'Try another source') : null, ...externalActions(stream)]);
      return;
    }
    const why = kind === 'video-unsupported' ? 'Your browser cannot decode this video (for example HEVC/H.265).' : kind === 'timeout' ? 'This source did not respond in time.' : 'This source could not be played.';
    if (next) { toast(`${why} Trying another source\u2026`); mount(banners); player.switchTo(next); return; }
    const known = stream.play && stream.play.reasons && stream.play.reasons.length ? ` ${stream.play.reasons.join('. ')}.` : '';
    player.fail('This source will not play here. See below for other ways to watch.');
    banner('bad', 'This source will not play here', `${why}${known} No other playable source was found.`, [...externalActions(stream), h('button', { class: 'btn small', type: 'button', onClick: () => openSourcesSheet() }, 'All sources')]);
  }

  // ---------------- subtitles ----------------
  async function addSubtitleFromBlob(url, label, idKey, short) { subBlobs.push(url); await player.addSubtitle({ id: idKey, label, url, short }, { select: true }); }

  function openSubtitleSheet() {
    const s = store.settings();
    const sheet = openSheet({ title: 'Subtitles', subtitle: d.title });
    const langSel = h('select', { 'aria-label': 'Language' }, SUB_LANGS.map((l) => h('option', { value: l, selected: l === (s.subLangs[0] || 'en') }, langName(l))));
    const out = h('div', { class: 'stack' });
    const search = async () => {
      mount(out, h('div', { class: 'spin', role: 'status' }));
      try {
        const r = await fetchSubtitleList({ type, tmdbId: id, imdbId: d.imdbId, season, episode, langs: [langSel.value], signal });
        if (!r.items.length) return mount(out, h('p', { class: 'empty' }, 'No subtitles found for this title and language.'));
        mount(out, r.items.map((it) => h('button', { class: 'btn', type: 'button', style: { justifyContent: 'space-between', textAlign: 'left' }, onClick: async (e) => {
          const b = e.currentTarget; b.disabled = true;
          try { const url = await loadSubtitleBlob(it.id, signal); await addSubtitleFromBlob(url, `${langName(it.lang)}: ${it.name}`, it.id, langName(it.lang)); toast('Subtitles loaded'); sheet.close(); } catch (err) { toast(err.message, { error: true }); b.disabled = false; }
        } }, h('span', null, it.name), h('small', { style: { color: 'var(--faint)' } }, `${langName(it.lang)}${it.downloads ? `  ${it.downloads.toLocaleString()} downloads` : ''}`))));
      } catch (err) { mount(out, h('p', { class: 'empty' }, err.message || 'Subtitle search failed.')); }
    };
    const file = h('input', { type: 'file', accept: '.srt,.vtt,text/vtt,application/x-subrip', class: 'sr', id: 'subfile' });
    file.addEventListener('change', async () => {
      const f = file.files[0]; if (!f) return;
      try { const url = vttBlobUrl(decodeBytes(await f.arrayBuffer())); await addSubtitleFromBlob(url, f.name, 'file:' + f.name, 'File'); toast('Subtitles loaded'); sheet.close(); } catch (err) { toast(err.message, { error: true }); }
    });
    // subtitles delivered with the source that is playing (Fendrix sends captions with its streams)
    const fromSource = (player && player.stream && player.stream.subtitles) || [];
    const sourceList = fromSource.length ? h('div', { class: 'stack', 'aria-label': 'Subtitles from this source' }, h('h3', null, 'From this source'),
      fromSource.map((it) => h('button', { class: 'btn', type: 'button', style: { justifyContent: 'space-between', textAlign: 'left' }, onClick: async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try { const url = await loadSourceSubtitle(it.url, signal); await addSubtitleFromBlob(url, `${it.label} (source)`, 'src:' + it.url, it.label); toast('Subtitles loaded'); sheet.close(); } catch (err) { if (!signal.aborted) toast(err.message, { error: true }); b.disabled = false; }
      } }, h('span', null, it.label), h('small', { style: { color: 'var(--faint)' } }, player.stream.providerName)))) : null;
    mount(sheet.body, sourceList, h('div', { class: 'stack' }, h('div', { class: 'row' }, langSel, h('button', { class: 'btn primary', type: 'button', onClick: search }, 'Search')), h('label', { class: 'btn ghost', for: 'subfile', tabindex: '0' }, 'Use a file from this device (.srt, .vtt)'), file), out);
    search();
  }

  function autoSubtitles() {
    const s = store.settings();
    if (!s.autoSubs) return;
    fetchSubtitleList({ type, tmdbId: id, imdbId: d.imdbId, season, episode, langs: s.subLangs, signal }).then(async (r) => {
      const pick = r.items.find((i) => i.lang === s.subLangs[0]) || r.items[0];
      if (!pick || (player && player.activeSubtitle)) return;
      const url = await loadSubtitleBlob(pick.id, signal);
      if (!signal.aborted && player && !player.activeSubtitle) await addSubtitleFromBlob(url, `${langName(pick.lang)}: ${pick.name}`, pick.id, langName(pick.lang));
    }).catch(() => { /* subtitles are optional; the Subtitles button still works */ });
  }

  function openSourcesSheet() {
    openSources({ meta: metaFor(), title: displayTitle(), mode: 'play', selectedId: player ? player.stream.id : undefined, onPlay: (st) => { mount(banners); player ? player.switchTo(st) : startPlayer(st); } });
  }
  const metaFor = () => ({ type, tmdbId: id, title: d.title, originalTitle: d.originalTitle, year: d.year, rating: d.rating, imdbId: d.imdbId || '', season, episode });
  const displayTitle = () => d.title + (type === 'tv' ? ` S${season}E${episode}` : d.year ? ` (${d.year})` : '');

  // ---------------- mpv (Settings, Play in) ----------------
  // No built-in player: the best source goes to mpv on this computer. The link holds the file's own address (not the
  // gateway's), so the gateway is needed only for the search and can be closed once mpv plays.
  function showMpv(stream) {
    const start = store.resumePoint(key);
    mount(stage, h('div', { class: 'loading msg mpv-ready', dataset: { mpvReady: '1' } }, h('div', null,
      h('h2', null, 'Ready to play in mpv'),
      h('p', null, stream.filename || sourceLabel(stream) || stream.providerName),
      h('p', { style: { color: 'var(--dim)' } }, `From ${stream.providerName}`),
      h('div', { class: 'actions', style: { justifyContent: 'center' } },
        h('a', { class: 'btn primary', href: mpvLink(stream, { title: displayTitle(), start }), dataset: { mpv: '1' } }, icon('play'), start ? 'Resume in mpv' : 'Open in mpv'),
        h('button', { class: 'btn', type: 'button', onClick: () => openSourcesSheet() }, icon('film'), 'Other sources')),
      h('p', { style: { color: 'var(--dim)', fontSize: '14px', marginTop: '16px' } }, 'mpv loads the video straight from the server, so you can close the gateway once mpv is playing.'),
      h('p', { style: { color: 'var(--faint)', fontSize: '13px' } }, 'Nothing opens? Set up mpv links once: Settings, Playback, How to set up mpv.'))));
  }

  // ---------------- start ----------------
  async function startPlayer(first) {
    mount(stage);
    const ranked = results.streams;
    const index = Math.max(0, ranked.findIndex((s) => s.id === first.id));
    tried.add(first.id);
    const nxt = type === 'tv' ? nextEpisode(d, season, episode) : null;
    const goNext = () => { if (nxt) location.hash = hrefWatch('tv', id, nxt.season, nxt.episode); };
    try {
      player = await createPlayer({
        container: stage, streams: ranked, index, net,
        poster: d.backdrop ? imgUrl(d.backdrop, 'w1280') : '',
        startAt: store.resumePoint(key), hasNext: !!nxt,
        prefs: () => store.settings(), save: (patch) => store.saveSettings(patch),
        cb: {
          onProgress: (pos, dur) => store.saveProgress(key, pos, dur),
          onEnded: () => { if (store.settings().autoNext && nxt) { toast('Playing next episode\u2026'); goNext(); } },
          onIssue,
          onFindSubtitles: openSubtitleSheet,
          onNext: goNext,
        },
      });
      if (signal.aborted) { player.destroy(); return; }
      autoSubtitles();
    } catch (e) {
      showStageError(h('div', null, h('h2', null, 'The player failed to load'), h('p', null, e.message || '')));
    }
  }

  (async () => {
    try {
      d = await api.title(type, id, signal);
      if (type === 'tv' && !d.seasons.some((s) => s.n === season)) { showStageError(h('div', null, h('h2', null, 'Episode not found'), h('a', { class: 'btn', href: hrefTitle(type, id) }, 'Back'))); return; }
      document.title = `${displayTitle()} \u2013 ${BRAND.name}`;
      mount(titleEl, d.title, type === 'tv' ? h('small', null, `Season ${season}, Episode ${episode}`) : d.year ? h('small', null, d.year) : null);
      store.pushHistory({ type, id: d.id, title: d.title, year: d.year, poster: d.poster, backdrop: d.backdrop, season, episode });
      paintChips();
      results = await lookupSources(metaFor(), { signal, settleMs: 1500, onProgress: (pid, ev, st) => { status[pid] = ev === 'done' ? st : { state: 'start' }; paintChips(); } });
      if (signal.aborted) return;
      const toMpv = store.settings().playIn === 'mpv';
      mount(tools,
        h('button', { class: 'btn', type: 'button', onClick: openSourcesSheet }, icon('film'), 'Sources'),
        toMpv ? null : h('button', { class: 'btn', type: 'button', onClick: () => player ? openSubtitleSheet() : toast('Start playback first') }, 'Subtitles'),
        h('button', { class: 'btn', type: 'button', onClick: () => openSources({ meta: metaFor(), title: displayTitle(), mode: 'download' }) }, icon('download'), 'Download'));
      if (!results.streams.length) {
        showStageError(h('div', null, h('h2', null, 'No sources found'), providerChips(results.status), guidance(results.status, metaFor(), { retry: () => location.reload() })));
        return;
      }
      if (toMpv) { showMpv(results.streams[0]); return; }
      await startPlayer(results.streams[0]);
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      showStageError(h('div', null, h('h2', null, e.code === 'not_found' ? 'Title not found' : 'Could not start playback'), h('p', null, e.message || ''), h('a', { class: 'btn', href: hrefTitle(type, id) }, 'Back to details')));
    }
  })();
}
