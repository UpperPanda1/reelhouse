import { h, mount, imgUrl, srcset, runtimeText, formatDate, progressKey, clamp } from '../util.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { card, personCard, rail, icon, toast, openSheet, toggleRow } from './components.js';
import { errorNotice } from './home.js';
import { hrefWatch, href } from '../router.js';
import { openSources } from './sources.js';
import { BRAND } from '../brand.js';

const metaOf = (d, season, episode) => ({ type: d.type, tmdbId: String(d.id), title: d.title, originalTitle: d.originalTitle, year: d.year, rating: d.rating, imdbId: d.imdbId || '', season, episode });

/** + / check button: opens "Save to list" (a switch per list, and a field to start a new one). */
function listButton(d) {
  const on = () => store.inAnyList(d.type, d.id);
  const btn = h('button', { class: 'iconbtn', type: 'button', 'aria-haspopup': 'dialog' });
  const paint = () => { btn.replaceChildren(icon(on() ? 'check' : 'plus')); btn.className = `iconbtn${on() ? ' on' : ''}`; btn.setAttribute('aria-label', on() ? 'Saved to a list: change lists' : 'Save to a list'); };
  btn.addEventListener('click', () => saveSheet(d, paint));
  paint();
  return btn;
}

function saveSheet(d, onDone) {
  const item = { type: d.type, id: d.id, title: d.title, year: d.year, poster: d.poster, rating: d.rating };
  const sheet = openSheet({ title: 'Save to list', subtitle: d.title, onClose: onDone });
  const rows = h('div', { class: 'stack' });
  const drawRows = () => mount(rows, store.lists().map((l) => toggleRow(l.name, null, store.listsWith(d.type, d.id).includes(l.id), (checked) => {
    if (checked) store.addToList(l.id, item); else store.removeFromList(l.id, d.type, d.id);
    toast(checked ? `Saved to ${l.name}` : `Removed from ${l.name}`);
  })));
  const input = h('input', { class: 'field', type: 'text', maxlength: 60, placeholder: 'New list name', 'aria-label': 'New list name', autocomplete: 'off' });
  const msg = h('p', { class: 'err-text', role: 'alert' });
  const form = h('form', { class: 'form', novalidate: true }, h('div', { class: 'row' }, input, h('button', { class: 'btn small', type: 'submit' }, icon('plus'), 'Create')), msg);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    try {
      const id = store.createList(input.value);
      store.addToList(id, item);
      toast(`Saved to ${input.value.trim()}`);
      input.value = ''; msg.textContent = '';
      drawRows();
    } catch (err) { msg.textContent = err.message; input.focus(); }
  });
  drawRows();
  mount(sheet.body, rows, h('h3', null, 'New list'), form);
}

/** Where "Play" should start for a series: the last episode watched here, otherwise S1E1. */
function continueTarget(d) {
  const last = store.history().find((e) => e.type === 'tv' && e.id === d.id);
  const first = d.seasons[0] ? d.seasons[0].n : 1;
  return last ? { season: last.season, episode: last.episode, resumed: true } : { season: first, episode: 1, resumed: false };
}

function episodeRow(d, ep, season) {
  const key = progressKey('tv', d.id, season, ep.n);
  const p = store.progress(key);
  const pct = p && p.dur ? clamp(Math.round((p.pos / p.dur) * 100), 0, 100) : 0;
  return h('article', { class: 'ep', dataset: { episode: ep.n } },
    h('a', { class: 'still', href: hrefWatch('tv', d.id, season, ep.n), 'aria-label': `Play episode ${ep.n}: ${ep.name}` },
      ep.still ? h('img', { src: imgUrl(ep.still, 'w300'), srcset: srcset(ep.still, [185, 300]), sizes: '200px', alt: '', width: 300, height: 169, loading: 'lazy', decoding: 'async' }) : null,
      pct ? h('div', { class: 'bar' }, h('i', { style: { width: pct + '%' } })) : null),
    h('div', null,
      h('h3', null, `${ep.n}. ${ep.name}`),
      h('div', { class: 'sub' }, [formatDate(ep.airDate), ep.runtime ? runtimeText(ep.runtime) : '', ep.rating ? `\u2605 ${ep.rating.toFixed(1)}` : ''].filter(Boolean).join('   ')),
      ep.overview ? h('p', null, ep.overview) : null),
    h('div', { class: 'acts' },
      h('a', { class: 'iconbtn', href: hrefWatch('tv', d.id, season, ep.n), 'aria-label': `Play episode ${ep.n}` }, icon('play')),
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': `Download episode ${ep.n}`, onClick: () => openSources({ meta: metaOf(d, season, ep.n), title: `${d.title} S${season}E${ep.n}`, mode: 'download' }) }, icon('download'))));
}

export function detailsView({ root, route, signal }) {
  const { type, id } = route.params;
  mount(root, h('div', { class: 'dhead', style: { minHeight: '46vh' } }), h('p', { class: 'empty' }, 'Loading\u2026'));
  api.title(type, id, signal).then((d) => {
    document.title = `${d.title} \u2013 ${BRAND.name}`;
    const isTv = d.type === 'tv';
    const target = isTv && d.seasons.length ? continueTarget(d) : null;
    const chips = [
      d.rating ? h('span', { class: 'chip star' }, icon('star'), d.rating.toFixed(1)) : null,
      d.year ? h('span', { class: 'chip' }, d.year) : null,
      d.runtime ? h('span', { class: 'chip' }, runtimeText(d.runtime) + (isTv ? ' / ep' : '')) : null,
      isTv && d.seasons.length ? h('span', { class: 'chip' }, `${d.seasons.length} season${d.seasons.length > 1 ? 's' : ''}`) : null,
      ...d.genres.slice(0, 3).map((g) => h('span', { class: 'chip' }, g)),
    ];
    const playBtn = isTv
      ? (d.seasons.length ? h('a', { class: 'btn primary', href: hrefWatch('tv', d.id, target.season, target.episode) }, icon('play'), target.resumed ? `Continue S${target.season} E${target.episode}` : 'Play S1 E1') : null)
      : h('a', { class: 'btn primary', href: hrefWatch('movie', d.id) }, icon('play'), store.resumePoint(progressKey('movie', d.id)) ? 'Resume' : 'Play');
    const dlBtn = !isTv ? h('button', { class: 'btn', type: 'button', onClick: () => openSources({ meta: metaOf(d), title: d.title + (d.year ? ` (${d.year})` : ''), mode: 'download' }) }, icon('download'), 'Download') : null;

    const head = h('section', { class: 'dhead' },
      d.backdrop ? h('img', { class: 'bg', src: imgUrl(d.backdrop, 'w1280'), srcset: srcset(d.backdrop, [780, 1280]), sizes: '100vw', alt: '', fetchpriority: 'high', decoding: 'async' }) : null,
      h('div', { class: 'dwrap' },
        h('div', { class: 'dposter' }, d.poster ? h('img', { src: imgUrl(d.poster, 'w500'), alt: `${d.title} poster`, width: 500, height: 750, decoding: 'async' }) : null),
        h('div', { class: 'dinfo' },
          h('h1', null, d.title),
          d.tagline ? h('p', { class: 'tagline' }, d.tagline) : null,
          h('div', { class: 'chips' }, chips),
          d.overview ? h('p', { class: 'overview' }, d.overview) : null,
          h('div', { class: 'actions' }, playBtn, dlBtn, listButton(d),
            d.trailer ? h('a', { class: 'btn ghost', href: `https://www.youtube.com/watch?v=${encodeURIComponent(d.trailer.key)}`, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), 'Trailer') : null))));

    const body = h('div', { class: 'dbody' });
    const nodes = [head, body];
    if (isTv && d.seasons.length) {
      const wanted = Number(route.query.get('s')) || (target && target.resumed ? target.season : d.seasons[0].n);
      const current = d.seasons.some((s) => s.n === wanted) ? wanted : d.seasons[0].n;
      const list = h('div', { class: 'eps', 'aria-live': 'polite' });
      const select = h('select', { 'aria-label': 'Season' }, d.seasons.map((s) => h('option', { value: s.n, selected: s.n === current }, s.name || `Season ${s.n}`)));
      const loadSeason = (n) => {
        mount(list, h('p', { class: 'empty' }, 'Loading episodes\u2026'));
        api.season(d.id, n, signal).then((s) => mount(list, s.episodes.length ? s.episodes.map((e) => episodeRow(d, e, n)) : h('p', { class: 'empty' }, 'No episodes listed yet.')))
          .catch((e) => { if (!(e && e.name === 'AbortError')) mount(list, errorNotice(e, () => loadSeason(n))); });
      };
      select.addEventListener('change', () => { history.replaceState(null, '', href(`/tv/${d.id}`, { s: select.value })); loadSeason(Number(select.value)); });
      body.append(h('h2', { class: 'section-title' }, 'Episodes'), h('div', { class: 'seasonbar' }, select), list);
      loadSeason(current);
    }
    mount(root, ...nodes);
    if (d.cast.length) body.append(rail('Cast', d.cast.map(personCard), { id: 'cast' }));
    if (d.recs.length) body.append(rail('More like this', d.recs.map((i) => card(i)), { id: 'recs' }));
  }).catch((e) => { if (!(e && e.name === 'AbortError')) mount(root, h('div', { class: 'dhead', style: { minHeight: '20vh' } }), e.code === 'not_found' ? h('div', { class: 'empty' }, h('h2', null, 'Not found'), h('p', null, 'This title does not exist on TMDB.')) : errorNotice(e, () => detailsView({ root, route, signal }))); });
}
