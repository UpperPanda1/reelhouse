// Mavonyx (MovieBox apps' API): the lookup itself, loaded by ./mx.js on the first click (keeps it off the home page).
// Port of the eclipsia "mavonyx.js" scraper (GPL-3.0, see /NOTICE.md). Same signed requests (x-client-token,
// HMAC-MD5 x-tr-signature, x-user token refresh on 401/441), same search scoring, audio tracks, resolution filters,
// stream selection and order. Differences:
//   * title, original title, year and rating come from the TMDB details the site already loaded (no own TMDB call)
//   * User-Agent / Origin / Referer / Cookie are not sent: browsers forbid them. The signature does not cover them,
//     and the APIs answer any Origin with CORS (measured Nov 2026: preflight allows every signed header,
//     `access-control-expose-headers: *`, so the `x-user` token header is readable with credentials omitted)
//   * cancelling (AbortError/TimeoutError) is not swallowed, so the orchestrator can report it
//   * the stream headers are kept for external tools; a browser cannot send them (Cookie: see streams.js)
// The mobile API is region-gated: elsewhere it answers 403 "Service not available in current region".
import { makeStream, unlessAbort } from './common.js';
import { id, name } from './mx.js';

export { id, name, direct, group } from './mx.js';

export const endpoints = {
  token: 'https://apig.inmoviebox.com/wefeed-mobile-bff/tab/ranking-list?tabId=0&categoryType=4516404531735022304&page=1&perPage=1',
  mobile: 'https://api3.aoneroom.com',
  web: 'https://h5-api.aoneroom.com',
  site: 'https://themoviebox.xyz',
  /** this site's Function (lib/mavonyx.js): the web API with the Referer a page cannot send */
  edgePlay: '/api/mavonyx/play',
};
/** The original's SCRAPER_SETTINGS (toggles: subtitles, res_2160p, res_1080p, res_720p, dub_<label>). Empty = its defaults. */
export const settings = {};

const ALWAYS_ENABLED_TRACKS = ['Original', 'English Dub'];
const DEFAULT_ENABLED_TRACKS = ['Hindi Dub'];
const WEB_USER_AGENT = 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36';
const REGIONAL_AUDIO_LABELS = { esla: 'Español [Latino]', ptbr: 'Português [Brasil]', es: 'Español', spanish: 'Español', pt: 'Português', portuguese: 'Português' };
const LANGUAGE_NAMES = {
  en: 'English', hi: 'Hindi', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', kn: 'Kannada', bn: 'Bengali', pa: 'Punjabi', mr: 'Marathi', gu: 'Gujarati',
  ur: 'Urdu', ar: 'Arabic', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian', ru: 'Russian', ja: 'Japanese', ko: 'Korean',
  zh: 'Chinese', th: 'Thai', id: 'Indonesian', in: 'Indonesian', ms: 'Malay', tl: 'Tagalog', fil: 'Filipino', tr: 'Turkish', vi: 'Vietnamese', nl: 'Dutch',
  pl: 'Polish', sv: 'Swedish', fa: 'Persian', he: 'Hebrew', el: 'Greek', ro: 'Romanian', hu: 'Hungarian', cs: 'Czech', uk: 'Ukrainian', da: 'Danish',
  fi: 'Finnish', no: 'Norwegian', bg: 'Bulgarian', hr: 'Croatian', sr: 'Serbian', sk: 'Slovak', si: 'Sinhala', ne: 'Nepali', my: 'Burmese', km: 'Khmer',
};
const RESOLUTION_OPTIONS = [
  { settingKey: 'res_2160p', resolution: '2160p', enabledByDefault: true },
  { settingKey: 'res_1080p', resolution: '1080p', enabledByDefault: true },
  { settingKey: 'res_720p', resolution: '720p', enabledByDefault: false },
];
const KNOWN_RESOLUTIONS = ['2160', '1440', '1080', '720', '480', '360', '240'];
const RESOLUTION_RANK = { '2160p': 5, '1440p': 4, '1080p': 3, '720p': 2, '480p': 1 };
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SIGN_KEY_B64B64 = 'NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw==';
const PLACEHOLDER = 'b164fbfb4347792950bdfbfb563d39d9';
const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- settings and labels (as the original) ----
const audioTrackSettingKey = (label) => 'dub_' + label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
function readToggle(key, fallback) {
  const value = settings[key];
  if (value == null || value === '') return fallback;
  return !(value === false || value === 'false');
}
function isResolutionEnabled(resolution) {
  if (resolution === 'Unknown') return true;
  const o = RESOLUTION_OPTIONS.find((r) => r.resolution === resolution);
  return o ? readToggle(o.settingKey, o.enabledByDefault) : false;
}
const capitalize = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
const extractLanguageBase = (raw) => String(raw || '').split(/\sdub/i)[0].split(/\ssub/i)[0].trim();
export function toAudioTrackLabel(rawName) {
  const raw = String(rawName || '');
  if (/original/i.test(raw)) return 'Original';
  const isHardsub = /\ssub/i.test(raw);
  const base = extractLanguageBase(raw);
  if (!base) return capitalize(raw.trim());
  const regional = REGIONAL_AUDIO_LABELS[base.toLowerCase()];
  if (regional) return isHardsub ? regional + ' Hardsub' : regional;
  return capitalize(base) + (isHardsub ? ' Hardsub' : ' Dub');
}
export const toAudioDisplayName = (raw) => REGIONAL_AUDIO_LABELS[extractLanguageBase(raw).toLowerCase()] || String(raw).replace(/dub/g, 'Audio');
function toLanguageName(rawLanguage) {
  const raw = String(rawLanguage || '').trim();
  const code = raw.toLowerCase();
  return LANGUAGE_NAMES[code] || LANGUAGE_NAMES[code.split('-')[0]] || raw;
}
const isArabicLanguage = (raw, name) => /^(ar|ara|arabic)\b/i.test(String(raw || '').trim()) || name === 'Arabic';
function isTrackEnabled(track) {
  const label = toAudioTrackLabel(track.language);
  if (label === 'Arabic Hardsub') return false;
  return ALWAYS_ENABLED_TRACKS.includes(label) || readToggle(audioTrackSettingKey(label), DEFAULT_ENABLED_TRACKS.includes(label));
}

// ---------------------------------------------------------------- signing (WebCrypto has no MD5: ported as is) ----
export function utf8Bytes(text) {
  return [...new TextEncoder().encode(String(text))];
}
export function base64Encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const hasB = i + 1 < bytes.length;
    const hasC = i + 2 < bytes.length;
    const a = bytes[i];
    const b = hasB ? bytes[i + 1] : 0;
    const c = hasC ? bytes[i + 2] : 0;
    out += B64.charAt(a >> 2) + B64.charAt(((a & 3) << 4) | (b >> 4)) + (hasB ? B64.charAt(((b & 15) << 2) | (c >> 6)) : '=') + (hasC ? B64.charAt(c & 63) : '=');
  }
  return out;
}
/** Base64 -> binary string (one char per byte), padding added as needed. Throws on invalid input. */
export function decodeBase64(value) {
  let padded = String(value).replace(/\s/g, '');
  while (padded.length % 4) padded += '=';
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded)) throw new Error('invalid base64');
  let text = '';
  for (let i = 0; i < padded.length; i += 4) {
    const n0 = B64.indexOf(padded.charAt(i));
    const n1 = B64.indexOf(padded.charAt(i + 1));
    const n2 = padded.charAt(i + 2) === '=' ? -1 : B64.indexOf(padded.charAt(i + 2));
    const n3 = padded.charAt(i + 3) === '=' ? -1 : B64.indexOf(padded.charAt(i + 3));
    text += String.fromCharCode((n0 << 2) | (n1 >> 4));
    if (n2 !== -1) text += String.fromCharCode(((n1 & 15) << 4) | (n2 >> 2));
    if (n3 !== -1) text += String.fromCharCode(((n2 & 3) << 6) | n3);
  }
  return text;
}
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0);
const MD5_S = [[7, 12, 17, 22], [5, 9, 14, 20], [4, 11, 16, 23], [6, 10, 15, 21]];
export function md5Bytes(input) {
  const message = input.slice(0);
  message.push(128);
  while (message.length % 64 !== 56) message.push(0);
  const bits = input.length * 8;
  const low = bits % 4294967296;
  const high = Math.floor(bits / 4294967296);
  for (let i = 0; i < 4; i++) message.push((low >>> (8 * i)) & 255);
  for (let i = 0; i < 4; i++) message.push((high >>> (8 * i)) & 255);
  let a0 = 1732584193, b0 = -271733879, c0 = -1732584194, d0 = 271733878;
  for (let offset = 0; offset < message.length; offset += 64) {
    const m = [];
    for (let i = 0; i < 16; i++) m[i] = message[offset + i * 4] | (message[offset + i * 4 + 1] << 8) | (message[offset + i * 4 + 2] << 16) | (message[offset + i * 4 + 3] << 24);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; } else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; } else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; } else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      f = (f + a + MD5_K[i] + m[g]) | 0;
      a = d; d = c; c = b;
      const s = MD5_S[i >> 4][i & 3];
      b = (b + ((f << s) | (f >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = [];
  for (const w of [a0, b0, c0, d0]) for (let j = 0; j < 4; j++) out.push((w >>> (8 * j)) & 255);
  return out;
}
export const md5Hex = (text) => md5Bytes(utf8Bytes(text)).map((b) => ('0' + b.toString(16)).slice(-2)).join('');
export function hmacMd5Bytes(keyBytes, messageBytes) {
  const inner = [];
  const outer = [];
  for (let i = 0; i < 64; i++) { const k = i < keyBytes.length ? keyBytes[i] : 0; inner.push(k ^ 54); outer.push(k ^ 92); }
  return md5Bytes(outer.concat(md5Bytes(inner.concat(messageBytes))));
}
export const clientToken = (timestamp) => { const v = String(timestamp); return v + ',' + md5Hex(v.split('').reverse().join('')); };
/** method, Accept, Content-Type, body length, timestamp, body MD5, path + query sorted by key (stable). */
export function canonicalString(r) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)(?:\?([^#]*))?/i.exec(r.url);
  const path = match ? match[1] || '' : '';
  const rawQuery = match && match[2] ? match[2] : '';
  let canonicalUrl = path;
  if (rawQuery) {
    const pairs = rawQuery.split('&').map((part, index) => { const p = part.split('='); return { key: p[0], value: p[1] === undefined ? '' : p[1], index }; });
    pairs.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index));
    canonicalUrl = path + '?' + pairs.map((p) => p.key + '=' + p.value).join('&');
  }
  const hasBody = r.body != null;
  return [r.method.toUpperCase(), r.accept, r.contentType, hasBody ? String(utf8Bytes(r.body).length) : '', r.timestamp, hasBody ? md5Hex(r.body) : '', canonicalUrl].join('\n');
}
let signKey;
export function requestSignature(r) {
  signKey ||= [...decodeBase64(decodeBase64(SIGN_KEY_B64B64))].map((ch) => ch.charCodeAt(0));
  return r.timestamp + '|2|' + base64Encode(hmacMd5Bytes(signKey, utf8Bytes(canonicalString(r))));
}
function parseTokenHeader(value) {
  if (!value) return '';
  try { const t = JSON.parse(value).token; return typeof t === 'string' && t.split('.').length === 3 ? t : ''; } catch { return ''; }
}
function randomDeviceId() {
  const b = new Uint8Array(16);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return [...b].map((x) => ('0' + x.toString(16)).slice(-2)).join('');
}
const clientInfo = (deviceId) => JSON.stringify({
  package_name: 'com.community.mbox.in', version_name: '4.0.03.0920.03', version_code: 50020130, os: 'android', os_version: '14', device_id: deviceId,
  install_store: 'official', brand: 'Google', model: 'Pixel 8', system_language: 'en', net: 'NETWORK_WIFI', region: 'IN', timezone: 'Asia/Calcutta', sp_code: '',
});

// ---------------------------------------------------------------- one lookup's API session ----
/** `log`: an array to record each stage in (Settings -> Test connection trace); normal lookups pass none. */
function session(ctx, log = null) {
  const info = clientInfo(randomDeviceId());
  const s = { token: '', pending: null };
  const note = (t) => { if (log) log.push(t); };

  async function signed(method, url, body, withAuth) {
    const timestamp = Date.now();
    const accept = 'application/json';
    const contentType = method === 'POST' ? 'application/json; charset=utf-8' : 'application/json';
    const headers = {
      Accept: accept, 'Content-Type': contentType,
      'x-client-token': clientToken(timestamp),
      'x-tr-signature': requestSignature({ method, accept, contentType, url, body, timestamp }),
      'x-client-info': info, 'x-client-status': '0',
    };
    if (withAuth) { const token = await ensureToken(false); if (token) headers.Authorization = 'Bearer ' + token; }
    const res = await ctx.response(url, body != null ? { method, headers, body } : { method, headers });
    const refreshed = res && parseTokenHeader(res.headers.get('x-user'));
    if (refreshed) { s.token = refreshed; s.pending = Promise.resolve(refreshed); }
    return res;
  }
  async function requestToken() {
    try { const res = await signed('GET', endpoints.token, null, false); const t = res && parseTokenHeader(res.headers.get('x-user')); if (t) s.token = t; } catch (e) { unlessAbort(null)(e); }
    // DEVIATION: apig.inmoviebox.com sends no access-control-expose-headers (measured 19 Nov 2026), so a page cannot
    // read its x-user header. The web API exposes it and hands out anonymous tokens: take one from there.
    // DEVIATION, step 2: the same request to the app API host, whose replies expose every header (the original reads
    // x-user from any reply). Unverified live: the host refuses the build machine's region before answering.
    if (!s.token) {
      try { const res = await signed('GET', endpoints.mobile + endpoints.token.slice(endpoints.token.indexOf('/wefeed')), null, false); const t = res && parseTokenHeader(res.headers.get('x-user')); if (t) { s.token = t; s.source = 'app host'; } } catch (e) { unlessAbort(null)(e); }
    }
    if (!s.token) { s.webToken = true; s.token = await webToken(); if (s.token) s.source = 'web API'; }
    note(`token: ${s.token ? (s.source || 'apig') : 'none readable'}`);
    return s.token;
  }
  async function webToken() {
    try {
      const res = await ctx.response(`${endpoints.web}/wefeed-h5api-bff/subject/play?subjectId=1&se=0&ep=0`, { headers: { Accept: 'application/json' } });
      return (res && parseTokenHeader(res.headers.get('x-user'))) || '';
    } catch (e) { return unlessAbort('')(e); }
  }
  function ensureToken(force) {
    if (force || !s.pending) s.pending = requestToken();
    return s.pending;
  }
  async function mobile(method, pathAndQuery, body) {
    // the app API already refused the web API's token in this lookup: do not ask (and refresh) again for every call
    if (s.refused) return null;
    const url = endpoints.mobile + pathAndQuery;
    const before = s.token;
    try {
      let res = await signed(method, url, body, true);
      if (res && (res.status === 401 || res.status === 441)) {
        if (!s.token || s.token === before) await ensureToken(true);
        res = await signed(method, url, body, true);
        if (res && (res.status === 401 || res.status === 441) && s.webToken) s.refused = true;
      }
      return res && res.status > 0 && res.status < 500 ? res : null;
    } catch (e) { return unlessAbort(null)(e); }
  }
  async function mobileJson(method, pathAndQuery, payload) {
    const res = await mobile(method, pathAndQuery, payload ? JSON.stringify(payload) : null);
    const path = pathAndQuery.split('?')[0].split('/').pop();
    if (!res || res.status !== 200) { note(`${path}: ${res ? 'HTTP ' + res.status : s.refused ? 'skipped (token refused)' : 'no reply'}`); return null; }
    try {
      const json = await res.json();
      // the API also reports errors inside an HTTP 200 (measured on the web API: {"code":400,"message":"invalid token"})
      if (json && json.code !== undefined && String(json.code) !== '0') note(`${path}: HTTP 200 but code ${json.code} ${json.message || json.reason || ''}`.trim());
      return json;
    } catch (e) { note(`${path}: unreadable reply`); return unlessAbort(null)(e); }
  }
  return { s, ensureToken, mobileJson, signed, note };
}

// ---------------------------------------------------------------- matching (as the original) ----
const normalizeTitle = (t) => String(t || '').toLowerCase().replace(/[‘’‛′]/g, "'").replace(/[^a-z0-9À-￿ ]/g, ' ')
  .replace(/[ -⁯　-〿＀-／：-＠]/g, ' ').replace(/\s+/g, ' ').trim();
const stripTitleNoise = (t) => String(t || '').replace(/\[.*?\]/g, ' ').replace(/\(.*?\)/g, ' ').replace(/\b(dub|dubbed|hd|4k|hindi|tamil|telugu|dual audio)\b/gi, ' ');
const tokenSet = (t) => [...new Set(t.split(' ').filter(Boolean))];
function titlesOverlap(a, b) {
  const ta = tokenSet(a);
  const tb = new Set(tokenSet(b));
  if (!ta.length || !tb.size) return false;
  const shared = ta.filter((x) => tb.has(x)).length;
  return shared >= Math.max(1, Math.floor((Math.min(ta.length, tb.size) * 3) / 4));
}
function scoreTitleMatch(rawTitle, expected) {
  const variants = [normalizeTitle(rawTitle.split('[')[0].replace(/\(.*?\)/g, ' ')), normalizeTitle(stripTitleNoise(rawTitle))];
  let score = 0;
  for (const e of expected) {
    const ne = normalizeTitle(e);
    if (!ne) continue;
    for (const v of variants) {
      if (!v) continue;
      if (titlesOverlap(ne, v)) return 50;
      if (ne.includes(v) || v.includes(ne)) score = Math.max(score, 20);
    }
  }
  return score;
}
function scoreYearMatch(expectedYear, releaseDate) {
  const found = parseInt(String(releaseDate || '').slice(0, 4), 10);
  if (expectedYear == null || isNaN(found)) return 0;
  const d = Math.abs(found - expectedYear);
  return d === 0 ? 40 : d === 1 ? 20 : d >= 4 ? -40 : d >= 2 ? -15 : 0;
}
function scoreRatingMatch(expectedRating, value) {
  const found = parseFloat(value);
  if (expectedRating == null || isNaN(found)) return 0;
  const d = Math.abs(found - expectedRating);
  return d <= 0.5 ? 10 : d <= 1.0 ? 5 : 0;
}
function scoreSearchResult(r, md) {
  const rawTitle = String(r.title || '');
  const t = parseInt(r.subjectType, 10);
  const resultIsTv = t === 2 || t === 7;
  return scoreTitleMatch(rawTitle, md.titles) + scoreYearMatch(md.year, r.releaseDate) + scoreRatingMatch(md.rating, r.imdbRatingValue)
    + (md.isTv === resultIsTv ? 15 : -30) + (rawTitle.includes('[') ? 0 : 2);
}
const usable = (x) => x && x.subjectId != null && x.title;
/** App-API search. null = no usable reply (refused, unreachable), [] = answered with nothing. */
async function searchCatalog(api, keyword) {
  const json = await api.mobileJson('POST', '/wefeed-mobile-bff/subject-api/search/v2', { page: 1, perPage: 20, keyword, restrictKid: 0 });
  const groups = json && json.data && json.data.results;
  if (!Array.isArray(groups)) { api.note(`app search "${keyword}": no result list`); return null; }
  const list = groups.flatMap((g) => (g && Array.isArray(g.subjects) ? g.subjects.filter(usable) : []));
  api.note(`app search "${keyword}": ${list.length} results${list.length ? ' (' + list.slice(0, 4).map((x) => `${x.title} ${String(x.releaseDate || '').slice(0, 4)} t${x.subjectType}`).join('; ') + ')' : ''}`);
  return list;
}
/** DEVIATION: web-API search (h5-api, CORS with exposed headers; same item fields as the app API: subjectId, title,
 *  releaseDate, imdbRatingValue, subjectType, detailPath, dubs). Used only when the app API's search gave no usable reply. */
async function searchWeb(ctx, api, keyword) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (api.s.token) headers.Authorization = 'Bearer ' + api.s.token;
  try {
    const res = await ctx.response(`${endpoints.web}/wefeed-h5api-bff/subject/search`, { method: 'POST', headers, body: JSON.stringify({ keyword, page: 1, perPage: 20, subjectType: 0 }) });
    if (!res || res.status !== 200) { api.note(`web search "${keyword}": ${res ? 'HTTP ' + res.status : 'no reply'}`); return null; }
    const json = await res.json();
    const items = json && json.data && json.data.items;
    api.note(`web search "${keyword}": ${Array.isArray(items) ? items.length + ' results' : `code ${json && json.code} ${(json && json.message) || ''}`}`);
    return Array.isArray(items) ? items.filter(usable) : null;
  } catch (e) { return unlessAbort(null)(e); }
}
const pickBest = (lists, md, note = () => {}) => {
  for (const list of lists) {
    let best = null;
    let bestScore = -Infinity;
    for (const r of list || []) { const sc = scoreSearchResult(r, md); if (sc > bestScore) { bestScore = sc; best = r; } }
    if (best) note(`best: "${best.title}" ${String(best.releaseDate || '').slice(0, 4)} score ${bestScore} (needs 40) for ${md.titles.join(' / ')} ${md.year || ''} rating ${md.rating ?? '-'}`);
    if (best && bestScore >= 40) return best;
  }
  return null;
};
/** @returns {{subjectId: string, item: object|null}|null}; throws when no search could be done at all. */
async function findMatchingSubject(ctx, api, md) {
  const queries = [md.titles[0]];
  if (md.titles[1] && normalizeTitle(md.titles[1]) !== normalizeTitle(md.titles[0])) queries.push(md.titles[1]);
  const lists = await Promise.all(queries.map((k) => searchCatalog(api, k)));
  if (lists.some(Boolean)) { const best = pickBest(lists, md, api.note); return best ? { subjectId: String(best.subjectId), item: null } : null; }
  const web = await Promise.all(queries.map((k) => searchWeb(ctx, api, k)));
  // "no match" only when a search really answered; otherwise the provider reports an error
  if (!web.some(Boolean)) {
    if (ctx.network === ctx.attempts) return null; // all offline: classify() reports "unreachable"
    throw new Error('Mavonyx: no search answered (app API refused, web API unavailable)');
  }
  const best = pickBest(web, md, api.note);
  return best ? { subjectId: String(best.subjectId), item: best } : null;
}

// ---------------------------------------------------------------- streams (as the original) ----
function parseResolution(text) {
  const s = String(text || '').toLowerCase();
  const r = KNOWN_RESOLUTIONS.find((k) => s.includes(k));
  return r ? r + 'p' : 'Unknown';
}
/** Signed cookies (Google Cloud CDN prefix or CloudFront policy) name the real manifest. */
export function manifestUrlFromCookie(signCookie) {
  if (!signCookie) return null;
  const edge = /Edge-Cache-Cookie=urlprefix=([^:;\s]+)/.exec(signCookie);
  if (edge) {
    try { return decodeBase64(edge[1].replace(/_/g, '/').replace(/-/g, '+')).replace(/\/+$/, '') + '/index.mpd'; } catch { return null; }
  }
  const policy = /CloudFront-Policy=([^;]+)/.exec(signCookie);
  if (!policy) return null;
  for (const attempt of [policy[1].replace(/-/g, '+').replace(/~/g, '/').replace(/_/g, '='), policy[1].replace(/-/g, '+').replace(/_/g, '/')]) {
    try {
      const p = JSON.parse(decodeBase64(attempt));
      const resource = p && p.Statement && p.Statement[0] && p.Statement[0].Resource;
      if (resource) { const trimmed = String(resource).replace(/[*/]+$/, ''); return /\.mpd$/i.test(trimmed) ? trimmed : trimmed + '/index.mpd'; }
    } catch { continue; }
  }
  return null;
}
// DEVIATION: the original matches only "/other/2026/09/"; the announcement video moved on (owner, 19 Nov 2026:
// macdn.aoneroom.com/other/2026/10/10/...mp4, a 10 s notice instead of the film). Any dated /other/ path counts.
const isPlaceholderStream = (resolved, original) => resolved.includes(PLACEHOLDER) || (resolved === original && /\/other\/\d{4}\/\d{2}\/(\d{2}\/)?/.test(original));
function detectFormat(declared, url) {
  const f = String(declared || '').toUpperCase();
  if (f === 'DASH' || url.includes('.mpd')) return 'DASH';
  if (f === 'HLS' || url.includes('.m3u8')) return 'HLS';
  return 'MP4';
}
function parseDetailUrl(detailUrl) {
  const m = /^(https?):\/\/([^/?#:@]+)(?::\d+)?/i.exec(String(detailUrl || ''));
  if (!m) return null;
  const cleaned = String(detailUrl).replace(/\/+$/, '').split('?')[0];
  return { origin: m[1] + '://' + m[2], path: cleaned.substring(cleaned.lastIndexOf('/') + 1) };
}
function siteHeaders(origin, path, subjectId) {
  const o = origin || endpoints.site;
  return { Origin: o, Referer: path ? `${o}/movies/${path}?id=${subjectId}&type=/movie/detail&detailSe=&detailEp=&lang=en` : o + '/', 'User-Agent': WEB_USER_AGENT, Accept: '*/*' };
}
function streamCandidate(stream, baseHeaders, declaredFormat, playback) {
  const originalUrl = stream && stream.url ? String(stream.url) : '';
  if (!originalUrl) return null;
  const signCookie = stream.signCookie ? String(stream.signCookie) : '';
  const url = manifestUrlFromCookie(signCookie) || originalUrl;
  if (isPlaceholderStream(url, originalUrl)) return null;
  const headers = { ...baseHeaders };
  if (signCookie) { headers[stream.signHeaderKey ? String(stream.signHeaderKey) : 'X-MB-Token'] = signCookie; headers.Cookie = signCookie; }
  return { url, format: detectFormat(declaredFormat, url), resolution: parseResolution(stream.resolutions), headers, signedCookie: !!signCookie, codec: stream.codecName ? String(stream.codecName).toLowerCase() : '',
    streamId: stream.id != null ? String(stream.id) : `${playback.subjectId}|${playback.season}|${playback.episode}` };
}
async function fetchSubtitles(api, streamId, trackLanguage, subjectId) {
  const sid = encodeURIComponent(streamId);
  const replies = await Promise.all([
    `/wefeed-mobile-bff/subject-api/get-stream-captions?subjectId=${subjectId}&streamId=${sid}`,
    `/wefeed-mobile-bff/subject-api/get-ext-captions?subjectId=${subjectId}&resourceId=${sid}&episode=0`,
  ].map((e) => api.mobileJson('GET', e, null)));
  const audioName = toAudioDisplayName(trackLanguage);
  const seen = new Set();
  const out = [];
  for (const json of replies) {
    const captions = json && json.data && json.data.extCaptions;
    if (!Array.isArray(captions)) continue;
    for (const c of captions) {
      const url = c && c.url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const raw = c.lanName || c.language || c.lan || 'Unknown';
      const language = toLanguageName(raw);
      if (isArabicLanguage(raw, language)) continue;
      out.push({ url, language, name: `${language} (${audioName})` });
    }
  }
  return out;
}
const isDash = (s) => String(s.format || '').toUpperCase() === 'DASH' || String(s.url || '').includes('.mpd');
async function fetchMobileStreams(api, playback, site) {
  const json = await api.mobileJson('GET', `/wefeed-mobile-bff/subject-api/play-info?subjectId=${playback.subjectId}&se=${playback.season}&ep=${playback.episode}`, null);
  const streams = json && json.data && json.data.streams;
  api.note(`play-info ${playback.subjectId}: ${Array.isArray(streams) ? streams.length + ' streams' + (streams.length ? ' (' + streams.map((x) => `${x.format || '?'} ${x.resolutions || '?'}${x.signCookie ? ' signed' : ''}`).join(', ') + ')' : '') : 'no stream list'}`);
  if (!Array.isArray(streams)) return [];
  const base = siteHeaders(site.origin, site.path, playback.subjectId);
  const dashFirst = streams.filter(isDash).concat(streams.filter((s) => !isDash(s)));
  // MP4 kept here; resolveAudioTrack drops it like the original unless the track would end up empty
  return dashFirst.map((s) => streamCandidate(s, base, s.format, playback)).filter(Boolean);
}
async function fetchWebStreamsFromOrigin(ctx, api, origin, path, playback) {
  // the original also sends User-Agent and Referer here; a browser cannot
  const headers = { Accept: 'application/json', 'x-client-info': JSON.stringify({ timezone: 'Asia/Calcutta' }), 'x-request-lang': 'en', 'x-vip-restrict': '0', 'x-no-high-risk-restrict': '0', 'x-source': '' };
  try {
    const token = api.s.token ? api.s.token : await api.ensureToken(false);
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await ctx.response(`${origin}/wefeed-h5api-bff/subject/play?subjectId=${playback.subjectId}&se=${playback.season}&ep=${playback.episode}&detailPath=${path}&streamSignType=1&supportCodecs%5Bhevc%5D=1&supportCodecs%5Bh264%5D=1`, { headers });
    if (!res || res.status !== 200) { api.note(`web play ${playback.subjectId} @ ${origin.replace(/^https?:\/\//, '')}: ${res ? 'HTTP ' + res.status : 'no reply'}`); return null; }
    const json = await res.json();
    const d = (json && json.data) || {};
    const streams = d.streams;
    api.note(`web play ${playback.subjectId} @ ${origin.replace(/^https?:\/\//, '')}: code ${json && json.code}, ${Array.isArray(streams) ? streams.length : 'no'} streams, hasResource ${d.hasResource}, limited ${d.limited}${d.limitedCode ? ' ' + d.limitedCode : ''}, maxResolution ${d.playConfig && d.playConfig.maxResolution}`);
    return Array.isArray(streams) && streams.length ? { origin, streams } : null;
  } catch (e) { return unlessAbort(null)(e); }
}
/** DEVIATION: the web API gives real files only with the movie page on a MovieBox host as Referer (measured), which a
 *  page cannot send; the site's Function sends it (lib/mavonyx.js). Asked only when the direct calls found nothing. */
async function fetchEdgeWebStreams(ctx, api, path, playback) {
  if (!path) return null;
  try {
    const res = await ctx.response(`${endpoints.edgePlay}?subjectId=${encodeURIComponent(playback.subjectId)}&se=${playback.season}&ep=${playback.episode}&detailPath=${encodeURIComponent(path)}`);
    if (!res || res.status !== 200) { api.note(`site web play ${playback.subjectId}: ${res ? 'HTTP ' + res.status : 'no reply'}`); return null; }
    const json = await res.json();
    const streams = json && Array.isArray(json.streams) ? json.streams : [];
    api.note(`site web play ${playback.subjectId}: ${streams.length} streams, hasResource ${json && json.hasResource}`);
    return streams.length ? streams : null;
  } catch (e) { return unlessAbort(null)(e); }
}
async function fetchWebStreams(ctx, api, origins, path, playback) {
  const replies = await Promise.all(origins.map((o) => fetchWebStreamsFromOrigin(ctx, api, o, path, playback)));
  let hit = replies.find(Boolean);
  if (!hit) { const edge = await fetchEdgeWebStreams(ctx, api, path, playback); if (edge) hit = { origin: origins[0], streams: edge }; }
  if (!hit) return [];
  const base = siteHeaders(hit.origin, path, playback.subjectId);
  return hit.streams.map((s) => streamCandidate(s, base, 'MP4', playback)).filter(Boolean);
}
function resolveMainSite(subject) {
  const parsed = subject.detailUrl ? parseDetailUrl(subject.detailUrl) : null;
  return { origin: parsed ? parsed.origin : null, path: (parsed && parsed.path) || subject.detailPath || null };
}
const fetchSubjectDetail = async (api, subjectId) => { const j = await api.mobileJson('GET', `/wefeed-mobile-bff/subject-api/get?subjectId=${subjectId}`, null); return j && j.data ? j.data : null; };
async function resolveTrackSite(api, context, track) {
  if (track.subjectId === context.originalSubjectId) return context.mainSite;
  let found;
  if (track.detailUrl) found = { detailUrl: track.detailUrl, detailPath: null };
  else {
    const d = await fetchSubjectDetail(api, track.subjectId);
    found = d ? { detailUrl: d.detailUrl || null, detailPath: d.detailUrl ? null : d.detailPath || null } : { detailUrl: null, detailPath: null };
  }
  const parsed = found.detailUrl ? parseDetailUrl(found.detailUrl) : null;
  if (parsed) return parsed;
  if (found.detailPath) return { origin: context.mainSite.origin, path: found.detailPath };
  return context.mainSite;
}
function extractAudioTracks(subject, subjectId) {
  let originalLanguage = 'Original';
  const seen = new Set();
  const tracks = [];
  for (const dub of Array.isArray(subject.dubs) ? subject.dubs : []) {
    const dubId = dub && dub.subjectId != null ? String(dub.subjectId) : '';
    const language = dub && dub.lanName ? String(dub.lanName) : '';
    if (!dubId || !language) continue;
    if (dubId === subjectId) { originalLanguage = language; continue; }
    if (seen.has(dubId)) continue;
    seen.add(dubId);
    tracks.push({ subjectId: dubId, language, detailUrl: dub.detailUrl || null });
  }
  tracks.unshift({ subjectId, language: originalLanguage, detailUrl: null });
  return tracks;
}
async function resolveAudioTrack(ctx, api, context, track) {
  try {
    const site = await resolveTrackSite(api, context, track);
    const origins = [];
    if (site.origin) origins.push(String(site.origin).replace(/\/+$/, ''));
    if (!origins.includes(endpoints.web)) origins.push(endpoints.web);
    const playback = { subjectId: track.subjectId, season: context.season, episode: context.episode };
    const [mobAll, web] = await Promise.all([
      fetchMobileStreams(api, playback, site).catch(unlessAbort([])),
      fetchWebStreams(ctx, api, origins, site.path || '', playback).catch(unlessAbort([])),
    ]);
    const mob = mobAll.filter((c) => c.format !== 'MP4'); // the original takes MP4 only from the web API
    const all = mob.concat(web);
    let candidates = all.filter((c) => isResolutionEnabled(c.resolution));
    // DEVIATION (owner's live trace, 19 Nov 2026): in a browser the web API returns no streams, and the app API's
    // only stream is often an MP4 ("1080,720,480"). Rather than end with nothing, keep that MP4 (same resolution filter).
    let fallback = '';
    if (!candidates.length) {
      candidates = mobAll.filter((c) => c.format === 'MP4' && isResolutionEnabled(c.resolution));
      if (candidates.length) fallback = `, app MP4 used (${candidates.map((c) => { try { return new URL(c.url).host; } catch { return '?'; } }).join(', ')})`;
    }
    api.note(`track ${track.language}: app ${mob.length} (+${mobAll.length - mob.length} MP4), web ${web.length}${all.length ? ' [' + all.map((c) => `${c.format} ${c.resolution}`).join(', ') + ']' : ''}, kept ${candidates.length}${fallback} (resolutions on: 2160p, 1080p, unknown${readToggle('res_720p', false) ? ', 720p' : ''})`);
    if (!candidates.length) return [];
    const subtitles = readToggle('subtitles', true) ? await fetchSubtitles(api, candidates[0].streamId, track.language, track.subjectId).catch(unlessAbort([])) : [];
    return candidates.map((c) => ({ ...c, language: track.language, subtitles }));
  } catch (e) { return unlessAbort([])(e); }
}

export function buildQuery(meta) {
  const isTv = meta.type === 'tv';
  if (!isTv && meta.type !== 'movie') return null;
  if (isTv && (meta.season == null || meta.episode == null)) return null;
  const titles = [];
  for (const t of [meta.title, meta.originalTitle]) { const v = t ? String(t).trim() : ''; if (v && !titles.includes(v)) titles.push(v); }
  if (!titles.length) return null;
  const year = parseInt(String(meta.year || '').slice(0, 4), 10);
  const rating = typeof meta.rating === 'number' && meta.rating > 0 ? meta.rating : null;
  return { isTv, season: isTv ? Number(meta.season) : 0, episode: isTv ? Number(meta.episode) : 0, md: { titles, year: isNaN(year) ? null : year, rating, isTv } };
}

/** The original's candidate list, in its order (deduplicated by URL, then by resolution, stable). */
export async function lookup(meta, ctx, log = null) {
  const q = buildQuery(meta);
  if (!q) return [];
  const api = session(ctx, log);
  await api.ensureToken(false);
  const match = await findMatchingSubject(ctx, api, q.md);
  if (!match) return [];
  const { subjectId } = match;
  // the web search item carries the same dubs/detailPath when the app API refuses the detail call
  const subject = (await fetchSubjectDetail(api, subjectId)) || match.item;
  if (!subject) { api.note(`subject ${subjectId}: no detail`); return []; }
  const allTracks = extractAudioTracks(subject, subjectId);
  const tracks = allTracks.filter(isTrackEnabled);
  api.note(`subject ${subjectId}: ${allTracks.length} audio tracks (${allTracks.map((t) => t.language).join(', ')}), enabled ${tracks.length}`);
  if (!tracks.length) return [];
  const context = { originalSubjectId: subjectId, mainSite: resolveMainSite(subject), season: q.season, episode: q.episode };
  const results = await Promise.all(tracks.map((t) => resolveAudioTrack(ctx, api, context, t)));
  const seen = new Set();
  const unique = results.flat().filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
  // Array.prototype.sort is stable: ties keep discovery order, like the original's index tie-break
  return unique.sort((a, b) => (RESOLUTION_RANK[b.resolution] || 0) - (RESOLUTION_RANK[a.resolution] || 0));
}

/** Settings -> Test connection: runs the real first steps and names the one that fails. {ok, text} */
export async function diagnose(ctx) {
  const api = session(ctx);
  const tokRes = await api.signed('GET', endpoints.token, null, false);
  if (!tokRes) return { ok: false, text: 'unreachable' };
  if (tokRes.status === 403) return { ok: false, text: 'refused: not available in this region (403)' };
  const appToken = !!parseTokenHeader(tokRes.headers.get('x-user'));
  if (!appToken) { api.s.token = ''; api.s.pending = null; api.s.webToken = false; }
  await api.ensureToken(false); // falls back to the web API's token when the app token header is hidden
  const tokenNote = appToken ? '' : api.s.token ? ` (token via ${api.s.source})` : ' (no token readable)';
  const search = await api.signed('POST', endpoints.mobile + '/wefeed-mobile-bff/subject-api/search/v2', JSON.stringify({ page: 1, perPage: 1, keyword: 'Inception', restrictKid: 0 }), true);
  if (search && search.status === 200) {
    let json = null;
    try { json = await search.json(); } catch (e) { unlessAbort(null)(e); }
    if (json && String(json.code) === '0') return { ok: true, text: 'reachable' + tokenNote };
    return { ok: false, text: `app API answered HTTP 200 but code ${json ? json.code : '?'} ${(json && (json.message || json.reason)) || ''}`.trim() + tokenNote };
  }
  const web = await searchWeb(ctx, api, 'Inception');
  const why = !search ? 'unreachable' : search.status === 403 ? 'not available in this region' : `refused (${search.status})`;
  if (web) return { ok: true, text: `web API only: app API ${why}` + tokenNote };
  return { ok: false, text: `app API ${why}; web API unavailable` };
}

/** Settings -> Test connection: a real lookup for a known film, every stage written down (copy it into a bug report). */
export async function trace(ctx, meta = { type: 'movie', tmdbId: '27205', title: 'Inception', originalTitle: 'Inception', year: '2010', rating: 8.4 }) {
  const log = [];
  try { log.push(`streams found: ${(await lookup(meta, ctx, log)).length}`); } catch (e) { if (isAbortErr(e)) throw e; log.push(`stopped: ${e.message}`); }
  return log;
}
const isAbortErr = (e) => !!e && (e.name === 'AbortError' || e.name === 'TimeoutError');

/** What the original returns for a candidate (minus its invisible sort prefix). Used by the parity test. */
export function toReference(c) {
  const label = `MovieBox • ${toAudioDisplayName(c.language)} • ${c.resolution}`;
  const r = { name: label, title: label, url: c.url, quality: `${c.resolution} • ${c.format}`, headers: c.headers };
  if (c.subtitles.length) r.subtitles = c.subtitles;
  return r;
}

const CONTAINER = { DASH: 'mpd', HLS: 'm3u8', MP4: 'mp4' };

export async function search(meta, ctx) {
  const q = buildQuery(meta);
  if (!q) return [];
  const list = await lookup(meta, ctx);
  // URLs end in index.mpd / a hash: name the stream after the title instead (also the download name)
  const label = `${meta.title}${q.isTv ? ` S${pad2(q.season)}E${pad2(q.episode)}` : meta.year ? ` (${meta.year})` : ''}`;
  return list.map((c) => {
    const stream = makeStream({ provider: id, providerName: `${name} (${toAudioDisplayName(c.language)})`, url: c.url, quality: c.resolution, filename: label, headers: c.headers, container: CONTAINER[c.format] });
    stream.direct = true;
    // the web API names the real codec (h264 / hevc): better than guessing from the URL ("/h265/")
    if (c.codec === 'hevc' || c.codec === 'h265') stream.info = { ...stream.info, video: 'hevc', codecLabel: 'H.265' };
    else if (c.codec === 'h264' || c.codec === 'avc') stream.info = { ...stream.info, video: 'avc', codecLabel: 'H.264' };
    // the CDN may want this cookie on every request; a page cannot send cookies for another site (streams.js warns)
    if (c.signedCookie) stream.signedCookie = true;
    if (c.subtitles.length) stream.subtitles = c.subtitles.map((s) => ({ url: s.url, lang: s.language.toLowerCase(), label: s.language }));
    return stream;
  });
}
