// Mavonyx (mx.js, the MovieBox API): parity with the ORIGINAL eclipsia "mavonyx.js" scraper, executed as-is in a vm
// sandbox against the same mock upstream, plus the documented deviations. The mock checks every signed request with
// an independent HMAC-MD5 (node:crypto), so neither implementation gets data unless it signs exactly like the app.
// Response shapes follow the live web API (h5-api.aoneroom.com, Nov 2026); the mobile API answers
// "Service not available in current region" outside its regions, so its shapes come from the original parser.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import * as mx from '../public/js/providers/mx-api.js'; // the lookup; ./mx.js is the lazy stub in PROVIDERS
import { makeCtx, resolveStreams, PROVIDERS } from '../public/js/providers/index.js';
import { createNet } from '../public/js/net.js';
import { playability, rank } from '../public/js/streams.js';

const REF = new URL('../cloudstream-main/cloudstream/providers/mavonyx.js', import.meta.url);
const TMDB = {
  'movie/27205': { title: 'Inception', original_title: 'Inception', release_date: '2010-07-15', vote_average: 8.4 },
  'movie/496243': { title: 'Parasite', original_title: '기생충', release_date: '2019-05-30', vote_average: 8.5 },
  'tv/1396': { name: 'Breaking Bad', original_name: 'Breaking Bad', first_air_date: '2008-01-20', vote_average: 8.9 },
};
const META = {
  movie: { type: 'movie', tmdbId: '27205', title: 'Inception', originalTitle: 'Inception', year: '2010', rating: 8.4 },
  parasite: { type: 'movie', tmdbId: '496243', title: 'Parasite', originalTitle: '기생충', year: '2019', rating: 8.5 },
  tv: { type: 'tv', tmdbId: '1396', title: 'Breaking Bad', originalTitle: 'Breaking Bad', year: '2008', rating: 8.9, season: 1, episode: 2 },
};
const ARGS = { movie: ['27205', 'movie'], parasite: ['496243', 'movie'], tv: ['1396', 'tv', 1, 2] };

// ---------------------------------------------------------------- independent signature check ----
const SIGN_KEY = Buffer.from(Buffer.from('NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw==', 'base64').toString('latin1'), 'base64');
const md5 = (s) => createHash('md5').update(s).digest('hex');
function signatureOk(method, url, h, body) {
  const ts = String(h.get('x-client-token') || '').split(',')[0];
  if (!/^\d+$/.test(ts) || h.get('x-client-token') !== `${ts},${md5(ts.split('').reverse().join(''))}`) return false;
  const u = new URL(url);
  const q = u.search ? u.search.slice(1).split('&').map((p, i) => { const [k, v = ''] = p.split('='); return { k, v, i }; }) : [];
  q.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i));
  const canonicalUrl = u.pathname + (q.length ? '?' + q.map((p) => `${p.k}=${p.v}`).join('&') : '');
  const hasBody = body != null;
  const canonical = [method, h.get('accept'), h.get('content-type'), hasBody ? String(Buffer.byteLength(body)) : '', ts, hasBody ? md5(body) : '', canonicalUrl].join('\n');
  return h.get('x-tr-signature') === `${ts}|2|${createHmac('md5', SIGN_KEY).update(canonical).digest('base64')}`;
}

// ---------------------------------------------------------------- mock upstream ----
const b64std = (s) => Buffer.from(s).toString('base64');
const EDGE_COOKIE = `Edge-Cache-Cookie=urlprefix=${b64std('https://cdn.test/dash/111/').replace(/\//g, '_').replace(/\+/g, '-')}:Expires=1:KeyName=k:Signature=s`;
const CF_POLICY = b64std(JSON.stringify({ Statement: [{ Resource: 'https://cdn.test/cf/111/*' }] })).replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');
const CF_COOKIE = `CloudFront-Policy=${CF_POLICY}; CloudFront-Signature=x; CloudFront-Key-Pair-Id=k`;
const SUBJECTS = {
  Inception: [
    { subjectId: '113', title: 'Inception: The Cobol Job', releaseDate: '2010-12-07', imdbRatingValue: '7.0', subjectType: 1 },
    { subjectId: '112', title: 'Inception [Hindi]', releaseDate: '2010-07-16', imdbRatingValue: '8.8', subjectType: 1 },
    { subjectId: '111', title: 'Inception', releaseDate: '2010-07-16', imdbRatingValue: '8.8', subjectType: 1 },
    { subjectId: '114', title: 'Inception', releaseDate: '2016-01-01', subjectType: 2 },
  ],
  Parasite: [{ subjectId: '201', title: 'Parasite Eve', releaseDate: '1997-03-29', subjectType: 1 }],
  '기생충': [{ subjectId: '202', title: '기생충', releaseDate: '2019-05-30', imdbRatingValue: '8.5', subjectType: 1 }],
  'Breaking Bad': [{ subjectId: '301', title: 'Breaking Bad', releaseDate: '2008-01-20', imdbRatingValue: '9.5', subjectType: 2 }],
};
const DETAIL = {
  111: { detailUrl: 'https://site.test/movies/inception-abc', dubs: [
    { subjectId: '111', lanName: 'English' },
    { subjectId: '121', lanName: 'Hindi dub', detailUrl: 'https://site.test/movies/inception-hindi' },
    { subjectId: '122', lanName: 'Tamil dub' }, // off by default: never requested
    { subjectId: '123', lanName: 'Arabic sub' }, // "Arabic Hardsub": always off
    { subjectId: '124', lanName: 'English dub' }, // always on; no detailUrl -> its own detail lookup
    { subjectId: '121', lanName: 'Hindi dub' }, // duplicate id
  ] },
  124: { detailPath: 'inception-en' },
  202: { detailPath: 'parasite-xyz', dubs: [] },
  301: { detailUrl: 'https://site.test/tv/breaking-bad-q1', dubs: [{ subjectId: '301', lanName: 'Original Audio' }] },
};
const PLAY = {
  '111|0|0': [
    { id: 's1', format: 'MP4', url: 'https://cdn.test/m/111.mp4', resolutions: '1080' }, // MP4 from the mobile API: dropped
    { id: 's3', format: 'HLS', url: 'https://cdn.test/h/111-720.m3u8', resolutions: '720' }, // 720p is off by default
    { id: 's4', format: 'HLS', url: 'https://cdn.test/h/111-1080.m3u8', resolutions: '1080P' },
    { id: 's2', format: 'DASH', url: 'https://cdn.test/raw/111', resolutions: '2160', signCookie: EDGE_COOKIE },
    { id: 's5', format: '', url: 'https://cdn.test/raw/111b', resolutions: '1080', signCookie: CF_COOKIE, signHeaderKey: 'X-Sign' },
    { id: 's6', format: 'DASH', url: 'https://cdn.test/p/b164fbfb4347792950bdfbfb563d39d9/index.mpd', resolutions: '1080' }, // placeholder
  ],
  '121|0|0': [{ id: 'h1', format: 'HLS', url: 'https://cdn.test/h/121.m3u8', resolutions: '1080' }],
  '202|0|0': [{ id: 'p1', format: 'HLS', url: 'https://cdn.test/h/202.m3u8', resolutions: '2160' }],
  '301|1|2': [{ id: 't1', format: 'HLS', url: 'https://cdn.test/h/301-1-2.m3u8', resolutions: '1080' }],
  // shaped like the owner's live trace (19 Nov 2026): the app API's only stream is an MP4, the web API has nothing
  '301|1|4': [{ id: 't4', format: 'MP4', url: 'https://cdn.test/m/301-1-4.mp4', resolutions: '1080,720,480' }],
  '301|1|5': [{ id: 't5', format: 'MP4', url: 'https://cdn.test/m/301-1-5.mp4', resolutions: '480' }],
};
const WEB = {
  111: [{ id: 'w1', url: 'https://web.test/111-1080.mp4', resolutions: '1080' }, { id: 'w2', url: 'https://web.test/111-480.mp4', resolutions: '480' }],
  124: [{ id: 'e1', url: 'https://web.test/124.mp4', resolutions: '' }, { id: 'e2', url: 'https://web.test/111-1080.mp4', resolutions: '1080' }],
};
const CAPTIONS = {
  'stream|111|s2': [{ url: 'https://sub.test/en.srt', lanName: 'English' }, { url: 'https://sub.test/ar.srt', lan: 'ar' }],
  'ext|111|s2': [{ url: 'https://sub.test/en.srt', lanName: 'English' }, { url: 'https://sub.test/bn.srt', language: 'bn' }],
};

/** Live-shaped MovieBox upstream. `expire`: the first token is refused once (401) to exercise the refresh path.
 *  `region`: every mobile API host answers like it does outside its regions (403). */
/*  `hideAppToken`: apig's x-user cannot be read (live in a browser: apig sends no access-control-expose-headers).
 *  `acceptWebToken`: the app API accepts the web API's anonymous token. `webDown`: the web API answers 503. */
// `api3IssuesToken`: the app API host answers the token request too (its replies expose x-user)
// `searchCode`: the app search answers HTTP 200 with this error code in the body
function upstream({ expire = false, region = false, hideAppToken = false, acceptWebToken = false, webDown = false, api3IssuesToken = false, searchCode = null } = {}) {
  const calls = [];
  let issued = 0;
  let refused = false;
  const json = (status, data, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
  const f = async (url, init = {}) => {
    url = String(url);
    const method = (init.method || 'GET').toUpperCase();
    const h = new Headers(init.headers || {});
    const body = init.body == null ? null : String(init.body);
    calls.push({ method, url, headers: Object.fromEntries(h), body });
    const u = new URL(url);
    const tm = /^\/3\/(movie|tv)\/(\d+)$/.exec(u.pathname);
    if (u.host === 'api.themoviedb.org' && tm) return json(200, TMDB[tm[1] + '/' + tm[2]]);
    const mobile = u.host === 'apig.inmoviebox.com' || u.host === 'api3.aoneroom.com';
    if (mobile && region) return json(403, { code: 403, reason: 'FORBIDDEN', message: 'Service not available in current region' });
    if (mobile && !signatureOk(method, url, h, body)) return json(403, { code: 403, message: 'bad signature' });
    if (u.host === 'apig.inmoviebox.com' && u.pathname === '/wefeed-mobile-bff/tab/ranking-list') {
      issued++;
      return json(200, { code: 0, data: {} }, hideAppToken ? {} : { 'x-user': JSON.stringify({ token: `hdr.tok${issued}.sig`, userType: 0 }) });
    }
    if (u.host === 'api3.aoneroom.com' && u.pathname === '/wefeed-mobile-bff/tab/ranking-list') {
      if (!api3IssuesToken) return json(404, {});
      issued++;
      return json(200, { code: 0, data: {} }, { 'x-user': JSON.stringify({ token: `hdr.tok${issued}.sig`, userType: 0 }) });
    }
    if (u.host === 'api3.aoneroom.com') {
      const auth = h.get('authorization') || '';
      if (!/^Bearer hdr\.tok\d+\.sig$/.test(auth) && !(acceptWebToken && auth === 'Bearer hdr.web.sig')) return json(401, { code: 401 });
      if (expire && !refused && auth === 'Bearer hdr.tok1.sig') { refused = true; return json(401, { code: 401, message: 'token expired' }); }
      const p = u.pathname;
      const q = u.searchParams;
      if (p === '/wefeed-mobile-bff/subject-api/search/v2' && method === 'POST' && searchCode) return json(200, { code: searchCode, message: 'token invalid' });
      if (p === '/wefeed-mobile-bff/subject-api/search/v2' && method === 'POST') {
        const { keyword } = JSON.parse(body);
        return json(200, { code: 0, data: { results: [{ subjects: SUBJECTS[keyword] || [] }, { subjects: null }] } });
      }
      if (p === '/wefeed-mobile-bff/subject-api/get') { const d = DETAIL[q.get('subjectId')]; return d ? json(200, { code: 0, data: d }) : json(404, {}); }
      if (p === '/wefeed-mobile-bff/subject-api/play-info') return json(200, { code: 0, data: { streams: PLAY[`${q.get('subjectId')}|${q.get('se')}|${q.get('ep')}`] || [] } });
      if (p === '/wefeed-mobile-bff/subject-api/get-stream-captions') return json(200, { code: 0, data: { extCaptions: CAPTIONS[`stream|${q.get('subjectId')}|${q.get('streamId')}`] || [] } });
      if (p === '/wefeed-mobile-bff/subject-api/get-ext-captions') return json(200, { code: 0, data: { extCaptions: CAPTIONS[`ext|${q.get('subjectId')}|${q.get('resourceId')}`] || [] } });
      return json(404, {});
    }
    if (u.host === 'h5-api.aoneroom.com' && webDown) return json(503, { code: 503 });
    const webTok = { 'x-user': JSON.stringify({ token: 'hdr.web.sig', appType: 3 }) }; // live: every web reply carries one
    if (u.host === 'h5-api.aoneroom.com' && u.pathname === '/wefeed-h5api-bff/subject/play') {
      const streams = WEB[u.searchParams.get('subjectId')] || [];
      return json(200, { code: 0, message: 'ok', data: { streams, dash: [], hls: [], hasResource: streams.length > 0 } }, webTok);
    }
    if (u.host === 'h5-api.aoneroom.com' && u.pathname === '/wefeed-h5api-bff/subject/search' && method === 'POST') {
      if (!h.get('authorization')) return json(200, { code: 400, reason: 'PARAMS_ERROR', message: 'invalid token' });
      const { keyword } = JSON.parse(body);
      const items = (SUBJECTS[keyword] || []).map((x) => ({ ...x, detailPath: (DETAIL[x.subjectId] && DETAIL[x.subjectId].detailPath) || `${x.title.toLowerCase().replace(/\W+/g, '-')}-w`, dubs: (DETAIL[x.subjectId] && DETAIL[x.subjectId].dubs) || [] }));
      return json(200, { code: 0, message: 'ok', data: { items } }, webTok);
    }
    return new Response('404 page not found', { status: 404 });
  };
  f.calls = calls;
  return f;
}

/** Runs the original scraper file unchanged; `fetch` is the only host capability it uses. */
async function runReference(f, args, settings) {
  const sandbox = { fetch: f, module: { exports: {} }, console, ...(settings ? { SCRAPER_SETTINGS: settings } : {}) };
  vm.runInNewContext(readFileSync(REF, 'utf8'), sandbox, { filename: 'mavonyx.js' });
  const out = await sandbox.module.exports.getStreams(...args);
  // JSON round trip: objects built inside the vm carry another realm's prototypes, which deepStrictEqual rejects
  return JSON.parse(JSON.stringify(out)).map((s) => ({ ...s, name: s.name.replace(/[​﻿]/g, ''), title: s.title.replace(/[​﻿]/g, '') }));
}
const direct = (f) => createNet(() => ({ edge: false }), f);
const signedOrApi = (calls) => calls.filter((c) => !c.url.includes('themoviedb')).map((c) => `${c.method} ${c.url} ${c.body || ''}`).sort();
const FORBIDDEN = ['user-agent', 'referer', 'origin', 'cookie'];

async function both(kind, opts) {
  const fr = upstream(opts);
  const ref = await runReference(fr, ARGS[kind]);
  const fp = upstream(opts);
  const ctx = makeCtx(direct(fp), mx);
  const port = await mx.lookup(META[kind], ctx);
  return { ref, port, refCalls: fr.calls, portCalls: fp.calls, ctx };
}

for (const kind of ['movie', 'parasite', 'tv']) {
  test(`mavonyx parity (${kind}): same streams, order, headers, subtitles and the same signed requests as the original`, async () => {
    const { ref, port, refCalls, portCalls } = await both(kind);
    assert.ok(ref.length > 0, 'scenario must produce streams');
    assert.deepEqual(port.map(mx.toReference), ref);
    assert.deepEqual(signedOrApi(portCalls), signedOrApi(refCalls));
  });
}

test('mavonyx: the movie scenario covers DASH from both cookie kinds, HLS, web MP4, filters, dubs and captions', async () => {
  const { port } = await both('movie');
  assert.deepEqual(port.map((c) => [c.url, c.resolution, c.format, c.language]), [
    ['https://cdn.test/dash/111/index.mpd', '2160p', 'DASH', 'English'], // Edge-Cache-Cookie prefix
    ['https://cdn.test/h/111-1080.m3u8', '1080p', 'HLS', 'English'],
    ['https://cdn.test/cf/111/index.mpd', '1080p', 'DASH', 'English'], // CloudFront policy resource
    ['https://web.test/111-1080.mp4', '1080p', 'MP4', 'English'],
    ['https://cdn.test/h/121.m3u8', '1080p', 'HLS', 'Hindi dub'],
    ['https://web.test/124.mp4', 'Unknown', 'MP4', 'English dub'],
  ]);
  assert.equal(port[2].headers['X-Sign'], CF_COOKIE);
  // captions are asked for the track's first candidate (DASH first, like the original) and ride on all of them
  assert.deepEqual(port[0].subtitles.map((s) => s.language), ['English', 'Bengali']); // Arabic dropped, duplicate URL once
  assert.deepEqual(port[1].subtitles, port[0].subtitles);
  assert.equal(port[4].subtitles.length, 0); // Hindi track: none
});

test('mavonyx: an expired token is refreshed once and the request repeated, like the original', async () => {
  const { ref, port, refCalls, portCalls } = await both('movie', { expire: true });
  assert.deepEqual(port.map(mx.toReference), ref);
  assert.deepEqual(signedOrApi(portCalls), signedOrApi(refCalls));
  assert.ok(portCalls.filter((c) => c.url.includes('ranking-list')).length >= 2, 'token requested again');
});

test('mavonyx: app API refused (403 region) and web API down: the provider reports an error, not "no match"', async () => {
  const f = upstream({ region: true, webDown: true });
  assert.deepEqual(await runReference(f, ARGS.movie), []);
  const r = await resolveStreams(META.movie, { net: direct(upstream({ region: true, webDown: true })), enabled: Object.fromEntries(PROVIDERS.map((p) => [p.id, p.id === 'mavonyx'])) });
  assert.equal(r.status.mavonyx.state, 'error');
  assert.equal(r.streams.length, 0);
});

test('mavonyx: requests carry no headers a browser forbids; the signature does not depend on them', async () => {
  const { portCalls, port } = await both('movie');
  assert.ok(port.length > 0);
  for (const c of portCalls) for (const k of FORBIDDEN) assert.ok(!(k in c.headers), `${k} sent to ${c.url}`);
  // ... while the original sends them (the stream headers keep them, for external tools)
  assert.equal(port[0].headers.Referer, 'https://site.test/movies/inception-abc?id=111&type=/movie/detail&detailSe=&detailEp=&lang=en');
});

test('mavonyx: search() builds app streams: container from the format, language in the name, flags, captions', async () => {
  const ctx = makeCtx(direct(upstream()), mx);
  const streams = await mx.search(META.movie, ctx);
  const byUrl = Object.fromEntries(streams.map((s) => [s.url, s]));
  const dash = byUrl['https://cdn.test/dash/111/index.mpd'];
  assert.equal(dash.container, 'mpd');
  assert.equal(dash.provider, 'mavonyx');
  assert.equal(dash.providerName, 'Mavonyx (English)');
  assert.equal(dash.quality, '2160p');
  assert.equal(dash.direct, true);
  assert.equal(dash.signedCookie, true);
  const hls = byUrl['https://cdn.test/h/111-1080.m3u8'];
  assert.equal(hls.container, 'm3u8');
  assert.equal(hls.signedCookie, undefined);
  assert.deepEqual(hls.subtitles, [{ url: 'https://sub.test/en.srt', lang: 'english', label: 'English' }, { url: 'https://sub.test/bn.srt', lang: 'bengali', label: 'Bengali' }]);
  assert.equal(byUrl['https://cdn.test/h/121.m3u8'].providerName, 'Mavonyx (Hindi Audio)');
  assert.equal(byUrl['https://web.test/124.mp4'].quality, 'Unknown');
  assert.equal(byUrl['https://web.test/124.mp4'].filename, 'Inception (2010)');
});

test('mavonyx: invalid input is rejected without a request', async () => {
  for (const meta of [{ type: 'tv', tmdbId: '1', title: 'X' }, { type: 'person', tmdbId: '1', title: 'X' }, { type: 'movie', tmdbId: '1', title: '' }]) {
    const f = upstream();
    assert.deepEqual(await mx.search(meta, makeCtx(direct(f), mx)), []);
    assert.equal(f.calls.length, 0);
  }
});

test('mavonyx: goes straight from the browser even with a gateway; cancelling aborts the lookup (no swallowed AbortError)', async () => {
  const f = upstream();
  const net = createNet(() => ({ gatewayUrl: 'http://127.0.0.1:8090' }), f);
  assert.equal(net.mode(mx), 'direct');
  const streams = await mx.search(META.movie, makeCtx(net, mx));
  assert.ok(streams.length > 0 && f.calls.every((c) => !c.url.startsWith('http://127.0.0.1')));
  assert.equal(net.mediaUrl(streams[0], { player: true }), streams[0].url);
  const ctrl = new AbortController();
  const slow = async (url, init) => { await new Promise((r, j) => { init.signal.addEventListener('abort', () => j(init.signal.reason)); }); };
  const p = resolveStreams(META.movie, { net: direct(slow), signal: ctrl.signal, enabled: { mavonyx: true, 'bdix-df': false, 'bdix-cf': false, 'bdix-fh': false, fendrix: false, hexion: false } });
  setTimeout(() => ctrl.abort(), 20);
  assert.equal((await p).status.mavonyx.state, 'cancelled');
});

test('mavonyx helpers: MD5, HMAC-MD5 and the canonical string match node:crypto', () => {
  for (const s of ['', 'abc', 'Inception', '기생충', 'x'.repeat(200)]) assert.equal(mx.md5Hex(s), md5(s));
  const msg = 'GET\napplication/json\napplication/json\n\n1\n\n/a?b=2&a=1';
  assert.equal(mx.base64Encode(mx.hmacMd5Bytes([...SIGN_KEY], mx.utf8Bytes(msg))), createHmac('md5', SIGN_KEY).update(msg).digest('base64'));
  assert.equal(mx.canonicalString({ method: 'get', accept: 'A', contentType: 'C', url: 'https://h.test/p/q?z=1&a=2&a=1', body: null, timestamp: 5 }), 'GET\nA\nC\n\n5\n\n/p/q?a=2&a=1&z=1');
});

test('playability: DASH is not playable in the built-in player yet; sign-cookie streams are risky', () => {
  const caps = { mkv: true, hevc: false, nativeHls: true };
  assert.equal(playability({ container: 'mpd', info: {} }, caps).level, 'bad');
  assert.match(playability({ container: 'mpd', info: {} }, caps).reasons[0], /DASH/);
  assert.equal(playability({ container: 'm3u8', signedCookie: true, info: {} }, caps).level, 'warn');
  assert.equal(playability({ container: 'm3u8', info: {} }, caps).level, 'ok');
  const ranked = rank([{ id: 'a', container: 'mpd', height: 2160, info: {} }, { id: 'b', container: 'mp4', height: 1080, info: {} }], caps);
  assert.deepEqual(ranked.map((s) => s.id), ['b', 'a']);
});

test('mavonyx: cancelling while the stream lists are loading reports cancelled, not empty', async () => {
  const live = upstream();
  const ctrl = new AbortController();
  const f = async (url, init) => {
    if (!String(url).includes('/play')) return live(url, init); // search and details answer; stream lists hang
    setTimeout(() => ctrl.abort(), 5);
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  };
  const only = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.id === 'mavonyx']));
  const r = await resolveStreams(META.movie, { net: direct(f), signal: ctrl.signal, enabled: only });
  assert.equal(r.status.mavonyx.state, 'cancelled');
});

test('mavonyx parity with non-default settings: audio-track, resolution and subtitle toggles act like the original', async () => {
  // the original's keys and string/boolean forms: 720p on, 2160p off, Hindi off, Tamil on, captions off
  const SETTINGS = { res_720p: true, res_2160p: 'false', dub_hindi_dub: false, dub_tamil_dub: 'true', subtitles: false };
  const fr = upstream();
  const ref = await runReference(fr, ARGS.movie, SETTINGS);
  const fp = upstream();
  const saved = { ...mx.settings };
  Object.assign(mx.settings, SETTINGS);
  try {
    const port = await mx.lookup(META.movie, makeCtx(direct(fp), mx));
    assert.deepEqual(port.map(mx.toReference), ref);
    assert.deepEqual(signedOrApi(fp.calls), signedOrApi(fr.calls));
    assert.ok(port.some((c) => c.resolution === '720p') && !port.some((c) => c.resolution === '2160p'));
    assert.ok(!fp.calls.some((c) => /subjectId=121\b/.test(c.url)), 'Hindi track never requested');
    assert.ok(fp.calls.some((c) => /play-info\?subjectId=122\b/.test(c.url)), 'Tamil track requested');
    assert.ok(!fp.calls.some((c) => c.url.includes('captions')), 'no caption requests');
  } finally { for (const k of Object.keys(mx.settings)) delete mx.settings[k]; Object.assign(mx.settings, saved); }
});

const ONLY_MX = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.id === 'mavonyx']));

test('mavonyx deviation: app token header hidden (live CORS of apig) -> the web API\'s token is used; app API accepts it: same streams', async () => {
  const normal = await mx.lookup(META.movie, makeCtx(direct(upstream()), mx));
  const f = upstream({ hideAppToken: true, acceptWebToken: true });
  const port = await mx.lookup(META.movie, makeCtx(direct(f), mx));
  assert.deepEqual(port.map((c) => c.url), normal.map((c) => c.url));
  assert.ok(f.calls.some((c) => c.url.includes('/subject/play?subjectId=1&') && !c.headers.authorization), 'anonymous web token fetched');
  assert.ok(f.calls.filter((c) => c.url.includes('api3.aoneroom.com/wefeed-mobile-bff/subject-api/')).every((c) => c.headers.authorization === 'Bearer hdr.web.sig'));
});

test('mavonyx deviation: app API refuses the web token -> web search finds the title, web streams play (MP4)', async () => {
  const f = upstream({ hideAppToken: true });
  const port = await mx.lookup(META.movie, makeCtx(direct(f), mx));
  assert.deepEqual(port.map((c) => [c.url, c.format, c.language]), [['https://web.test/111-1080.mp4', 'MP4', 'English'], ['https://web.test/124.mp4', 'MP4', 'English dub']]);
  assert.ok(f.calls.some((c) => c.url.endsWith('/wefeed-h5api-bff/subject/search') && c.headers.authorization === 'Bearer hdr.web.sig'));
  const tv = await mx.lookup(META.tv, makeCtx(direct(upstream({ hideAppToken: true })), mx));
  assert.deepEqual(tv, [], 'series: web search matched, but no web streams in this mock');
  const r = await resolveStreams(META.movie, { net: direct(upstream({ hideAppToken: true })), enabled: ONLY_MX });
  assert.equal(r.status.mavonyx.state, 'ok');
});

test('mavonyx: "no match" only when a search answered; both refused -> error', async () => {
  const none = await resolveStreams({ ...META.movie, title: 'Zzz Unknown', originalTitle: '' }, { net: direct(upstream({ hideAppToken: true })), enabled: ONLY_MX });
  assert.equal(none.status.mavonyx.state, 'empty');
  const both = await resolveStreams(META.movie, { net: direct(upstream({ hideAppToken: true, webDown: true })), enabled: ONLY_MX });
  assert.equal(both.status.mavonyx.state, 'error');
  const offline = await resolveStreams(META.movie, { net: direct(async () => { throw new TypeError('Failed to fetch'); }), enabled: ONLY_MX });
  assert.equal(offline.status.mavonyx.state, 'unreachable');
});

test('mavonyx diagnose (Settings -> Test connection) names the failing step', async () => {
  const d = (o) => mx.diagnose(makeCtx(direct(upstream(o)), mx));
  assert.deepEqual(await d({}), { ok: true, text: 'reachable' });
  assert.deepEqual(await d({ hideAppToken: true, acceptWebToken: true }), { ok: true, text: 'reachable (token via web API)' });
  assert.deepEqual(await d({ hideAppToken: true }), { ok: true, text: 'web API only: app API refused (401) (token via web API)' });
  assert.deepEqual(await d({ region: true }), { ok: false, text: 'refused: not available in this region (403)' });
  assert.deepEqual(await d({ hideAppToken: true, webDown: true }), { ok: false, text: 'app API refused (401); web API unavailable' });
  assert.deepEqual(await mx.diagnose(makeCtx(direct(async () => { throw new TypeError('Failed to fetch'); }), mx)), { ok: false, text: 'unreachable' });
});

test('mavonyx deviation: app token hidden on apig but issued by the app API host -> full app-API results, no web token', async () => {
  const normal = await mx.lookup(META.movie, makeCtx(direct(upstream()), mx));
  const f = upstream({ hideAppToken: true, api3IssuesToken: true });
  const port = await mx.lookup(META.movie, makeCtx(direct(f), mx));
  assert.deepEqual(port.map((c) => c.url), normal.map((c) => c.url));
  assert.ok(f.calls.some((c) => c.url.startsWith('https://api3.aoneroom.com/wefeed-mobile-bff/tab/ranking-list')));
  assert.ok(!f.calls.some((c) => c.url.includes('/subject/play?subjectId=1&')), 'web token not needed');
  assert.deepEqual(await mx.diagnose(makeCtx(direct(upstream({ hideAppToken: true, api3IssuesToken: true })), mx)), { ok: true, text: 'reachable (token via app host)' });
});

test('mavonyx: once the app API refuses the web token, the lookup stops asking it (no refresh storm)', async () => {
  const f = upstream({ hideAppToken: true });
  await mx.lookup(META.movie, makeCtx(direct(f), mx));
  const app = f.calls.filter((c) => c.url.startsWith('https://api3.aoneroom.com/wefeed-mobile-bff/subject-api/'));
  assert.ok(app.length <= 2, `app API calls after the refusal: ${app.length}`);
});

test('mavonyx trace (Settings): every stage of a real lookup is written down', async () => {
  const lines = await mx.trace(makeCtx(direct(upstream({ hideAppToken: true, api3IssuesToken: true })), mx));
  const text = lines.join('\n');
  for (const re of [/^token: app host$/m, /^app search "Inception": 4 results/m, /^best: "Inception" 2010 score \d+ \(needs 40\)/m,
    /^subject 111: 5 audio tracks \(English, Hindi dub, Tamil dub, Arabic sub, English dub\), enabled 3$/m,
    /^play-info 111: 6 streams \(MP4 1080, HLS 720, HLS 1080P, DASH 2160 signed, \? 1080 signed, DASH 1080\)$/m,
    /^track English: app 4 \(\+1 MP4\), web 2 \[.*MP4 480p\], kept 4/m, /^streams found: 6$/m]) assert.match(text, re);
  // an episode with no streams: the trace says where it ended
  const tv = (await mx.trace(makeCtx(direct(upstream()), mx), { ...META.tv, episode: 3 })).join('\n');
  assert.match(tv, /^play-info 301: 0 streams$/m);
  assert.match(tv, /^streams found: 0$/m);
});

test('mavonyx diagnose: an HTTP 200 carrying an error code is not "reachable"', async () => {
  assert.deepEqual(await mx.diagnose(makeCtx(direct(upstream({ searchCode: 401 })), mx)), { ok: false, text: 'app API answered HTTP 200 but code 401 token invalid' });
  const t = (await mx.trace(makeCtx(direct(upstream({ searchCode: 401 })), mx))).join('\n');
  assert.match(t, /search\/v2|v2: HTTP 200 but code 401 token invalid/);
});

test('mavonyx deviation: a track whose only stream is the app API\'s MP4 keeps it (the web API gives a browser nothing)', async () => {
  const ep4 = await mx.lookup({ ...META.tv, episode: 4 }, makeCtx(direct(upstream()), mx));
  assert.deepEqual(ep4.map((c) => [c.url, c.resolution, c.format]), [['https://cdn.test/m/301-1-4.mp4', '1080p', 'MP4']]);
  // the original's resolution filter still applies: a 480p-only MP4 is dropped, as the original drops it
  assert.deepEqual(await mx.lookup({ ...META.tv, episode: 5 }, makeCtx(direct(upstream()), mx)), []);
  // the original returns nothing for episode 4 (it drops every app-API MP4)
  assert.deepEqual(await runReference(upstream(), ['1396', 'tv', 1, 4]), []);
});
