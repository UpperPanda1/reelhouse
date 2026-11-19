import { h, mount } from '../util.js';
import { store } from '../store.js';
import { net } from '../core.js';
import { api } from '../api.js';
import { PROVIDERS } from '../providers/index.js';
import { SERVERS } from '../providers/df.js';
import { endpoints as cfEndpoints } from '../providers/cf.js';
import { endpoints as fhEndpoints } from '../providers/fh.js';
import * as fendrix from '../providers/fn.js';
import * as hexion from '../providers/hx.js';
import { SUB_LANGS, langName, subtitleStyle, SUB_COLORS } from '../subs.js';
import { openSheet, toast, toggleRow } from './components.js';
import { clearHistoryFlow } from './browse.js';
import { accountSection } from './account.js';

const DIAG_TEXT = {
  ok: ['reachable', 'ok'], cors: ['reachable, but the browser may not read it (CORS)', 'bad'], unreachable: ['unreachable', 'bad'],
  auth: ['gateway token rejected', 'bad'], blocked: ['blocked by the gateway (not on its allow-list)', 'bad'],
};

export function openSettings() {
  const sheet = openSheet({ title: 'Settings' });
  const draw = () => {
    const s = store.settings();
    const mode = net.mode(null);

    // ----- connection -----
    const gw = h('input', { class: 'field', type: 'url', placeholder: 'http://127.0.0.1:8787', value: s.gatewayUrl, 'aria-label': 'Gateway address', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const tok = h('input', { class: 'field', type: 'password', placeholder: 'Gateway token (if set)', value: s.gatewayToken, 'aria-label': 'Gateway token', autocomplete: 'off' });
    const save = () => { store.saveSettings({ gatewayUrl: gw.value.trim().replace(/\/+$/, ''), gatewayToken: tok.value }); toast('Connection saved'); draw(); };
    const diag = h('div', { class: 'diag', 'aria-live': 'polite' });
    const test = async () => {
      store.saveSettings({ gatewayUrl: gw.value.trim().replace(/\/+$/, ''), gatewayToken: tok.value });
      const gwOn = !!store.settings().gatewayUrl;
      const targets = [
        ...(gwOn ? [['Gateway', store.settings().gatewayUrl + '/health', null]] : []),
        ['DhakaFlix 12', SERVERS[0].url + SERVERS[0].root, null],
        ['DhakaFlix 14', SERVERS[1].url + SERVERS[1].root, null],
        ['Circle FTP', cfEndpoints.primary + '/', null],
        ['Circle FTP (fallback)', cfEndpoints.fallback + '/', null],
        ['FlixHub', fhEndpoints.base + '/', null],
        ['Fendrix', fendrix.API_BASE[0] + '/', fendrix],
        ['Hexion', hexion.endpoints.base + '/', hexion],
      ];
      mount(diag, targets.map(([name]) => h('div', { dataset: { host: name } }, h('span', null, name), h('span', null, 'testing\u2026'))));
      await Promise.all(targets.map(async ([name, url, provider], i) => {
        let state;
        if (name === 'Gateway') { try { const r = await fetch(url); state = r.ok ? 'ok' : 'unreachable'; } catch { state = 'unreachable'; } } else if (provider && (provider.direct || !gwOn)) {
          try { const r = await net.request(url, { provider, timeoutMs: 8000 }); state = r.ok ? 'ok' : 'unreachable'; } catch { state = 'unreachable'; }
        } else state = await net.diagnose(url);
        const [text, cls] = DIAG_TEXT[state];
        const row = diag.children[i];
        row.replaceChildren(h('span', null, name), h('span', { class: cls === 'ok' ? 'pstat ok' : 'pstat bad', style: { margin: 0 } }, text));
        row.dataset.state = state;
      }));
    };
    const connection = h('section', { class: 'set-group' },
      h('h3', null, 'Connection to BDIX servers'),
      h('p', { style: { color: 'var(--dim)', fontSize: '14px' } }, mode === 'gateway' ? 'Requests go through your gateway (Fendrix still connects directly: it does not need it).' : 'Requests go straight from this browser (Hexion via the site\u2019s edge proxy). Browsers block this for BDIX servers (DhakaFlix, Circle FTP, FlixHub), and Hexion\u2019s sites refuse the edge proxy; the gateway fixes both. Fendrix always connects directly.'),
      h('div', { class: 'stack', style: { marginTop: '10px' } }, gw, tok,
        h('div', { class: 'actions', style: { marginTop: 0 } }, h('button', { class: 'btn small primary', type: 'button', onClick: save }, 'Save'), h('button', { class: 'btn small', type: 'button', onClick: test }, 'Test connection'))),
      diag,
      h('details', { style: { marginTop: '12px' } }, h('summary', { style: { cursor: 'pointer' } }, 'How do I run the gateway?'),
        h('div', { class: 'stack', style: { marginTop: '8px', color: 'var(--dim)', fontSize: '14px' } },
          h('p', null, 'On a computer that is on your BDIX network (Node 22+):'),
          h('code', { class: 'code' }, 'node gateway/bdix-gateway.mjs'),
          h('p', null, 'Enter ', h('code', { class: 'code' }, 'http://127.0.0.1:8787'), ' above if the gateway runs on this device. For another device on your network set ', h('code', { class: 'code' }, 'HOST=0.0.0.0 GATEWAY_TOKEN=secret'), ' and use its LAN address. Note: an https site can only call http://localhost directly; for a LAN address either serve the gateway with TLS or open this site over http.'))));

    // ----- sources -----
    const sources = h('section', { class: 'set-group' }, h('h3', null, 'Sources'),
      ...PROVIDERS.map((p) => toggleRow(p.name, p.note || (p.group === 'bdix' ? 'BDIX server: needs a BDIX network' : 'Online source: works on any internet connection'), s.providers[p.id] !== false, (v) => { store.saveSettings({ providers: { [p.id]: v } }); })),
      toggleRow('Original file types only', 'Off also lists .mov, .m4v and .webm files from DhakaFlix.', s.compat, (v) => store.saveSettings({ compat: v })));

    // ----- playback -----
    const langBox = h('div', { class: 'langs', role: 'group', 'aria-label': 'Preferred subtitle languages' }, SUB_LANGS.map((l) => {
      const input = h('input', { type: 'checkbox', checked: s.subLangs.includes(l), value: l });
      input.addEventListener('change', () => {
        const cur = store.settings().subLangs.filter((x) => x !== l);
        const next = input.checked ? [...cur, l] : cur;
        store.saveSettings({ subLangs: next.length ? next : ['en'] });
      });
      return h('label', null, input, langName(l));
    }));
    const playback = h('section', { class: 'set-group' }, h('h3', null, 'Playback'),
      toggleRow('Prefer sources my browser can play', 'Ranks HEVC and Dolby/DTS audio files lower, since browsers often cannot decode them.', s.preferCompatible, (v) => store.saveSettings({ preferCompatible: v })),
      toggleRow('Play next episode automatically', null, s.autoNext, (v) => store.saveSettings({ autoNext: v })),
      toggleRow('Load subtitles automatically', 'Uses OpenSubtitles. The first language below is tried first.', s.autoSubs, (v) => store.saveSettings({ autoSubs: v })),
      langBox);

    // ----- subtitle appearance -----
    const preview = h('div', { class: 'preview' }, h('span', { id: 'sub-preview' }, 'The quick brown fox jumps over the lazy dog'));
    const paint = () => {
      const st = store.settings().subStyle;
      const css = subtitleStyle(st, 560);
      const el = preview.firstChild;
      Object.assign(el.style, { fontSize: css.fontSize, color: css.color, textShadow: css.textShadow, background: css.background, padding: '0 .4em', borderRadius: '4px' });
    };
    const range = (label, min, max, step, value, key, suffix) => {
      const out = h('span', null, value + suffix);
      const input = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
      input.addEventListener('input', () => { out.textContent = input.value + suffix; store.saveSettings({ subStyle: { [key]: Number(input.value) } }); paint(); });
      return h('div', { class: 'stack' }, h('div', { class: 'row' }, h('label', null, label), out), input);
    };
    const sel = (label, options, value, key) => {
      const select = h('select', { 'aria-label': label }, options.map(([v, t]) => h('option', { value: v, selected: v === value }, t)));
      select.addEventListener('change', () => { store.saveSettings({ subStyle: { [key]: select.value } }); paint(); });
      return h('div', { class: 'row' }, h('label', null, label), select);
    };
    const subs = h('section', { class: 'set-group' }, h('h3', null, 'Subtitle appearance'),
      range('Size', 50, 250, 10, s.subStyle.size, 'size', '%'), range('Height from bottom', 2, 30, 1, s.subStyle.bottom, 'bottom', '%'),
      sel('Color', SUB_COLORS, s.subStyle.color, 'color'), sel('Background', [['none', 'None'], ['shadow', 'Shadow'], ['box', 'Box']], s.subStyle.bg, 'bg'), preview);

    // ----- server status + data -----
    const status = h('div', { class: 'stack', style: { color: 'var(--dim)', fontSize: '14px' } }, 'Checking\u2026');
    api.health().then((hl) => mount(status,
      h('div', null, hl.tmdb ? 'TMDB: configured' : 'TMDB: API key missing on the server'),
      h('div', null, hl.subtitles.opensubtitles ? 'Subtitles: OpenSubtitles API' : 'Subtitles: keyless OpenSubtitles fallback (set OPENSUBTITLES_API_KEY for the official API)')))
      .catch(() => mount(status, 'Could not read server status.'));
    const data = h('section', { class: 'set-group' }, h('h3', null, 'This device'),
      status,
      h('div', { class: 'actions' },
        h('button', { class: 'btn small danger', type: 'button', onClick: () => clearHistoryFlow() }, 'Clear history'),
        h('button', { class: 'btn small', type: 'button', onClick: () => { store.clearAllProgress(); toast('Resume positions cleared'); } }, 'Clear resume positions'),
        h('button', { class: 'btn small', type: 'button', onClick: () => { store.resetSettings(); toast('Settings reset'); draw(); } }, 'Reset settings')),
      h('p', { style: { color: 'var(--faint)', fontSize: '13px', marginTop: '12px' } }, 'This product uses the TMDB API but is not endorsed or certified by TMDB. Player: ArtPlayer (MIT). Provider logic is a port of the eclipsia-bdix CloudStream scrapers (GPL-3.0).'));

    mount(sheet.body, accountSection(draw, () => sheet.close()), connection, sources, playback, subs, data);
    paint();
  };
  draw();
  return sheet;
}
