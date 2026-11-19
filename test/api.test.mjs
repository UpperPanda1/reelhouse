import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { handleApi } from '../lib/api.js';

const KEY = 'k'.repeat(32);
const results = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: i + 1, title: 'M' + i, name: 'T' + i, poster_path: `/p${i}.jpg`, backdrop_path: `/b${i}.jpg`, vote_average: 7.456, overview: 'o'.repeat(400), release_date: '2020-05-01', first_air_date: '2019-01-01', ...extra }));

/** Fake upstream; records every call. */
function upstream(overrides = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u, init });
    const r = (body, status = 200, headers = {}) => new Response(typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body), { status, headers });
    if (overrides[u.pathname]) return overrides[u.pathname](u, init, r);
    if (u.hostname === 'api.themoviedb.org') {
      const p = u.pathname.replace('/3', '');
      if (p === '/trending/all/day') return r({ results: [...results(3, { media_type: 'movie' }), { id: 99, media_type: 'person', name: 'X', profile_path: '/x' }] });
      if (p.endsWith('/popular') || p.endsWith('/top_rated')) return r({ results: results(4) });
      if (p === '/search/multi') return r({ page: 1, total_pages: 1, results: [{ id: 1, media_type: 'movie', title: 'A', poster_path: '/a' }, { id: 2, media_type: 'person', name: 'P', poster_path: '/p' }, { id: 3, media_type: 'tv', name: 'B', poster_path: '/b' }, { id: 4, media_type: 'movie', title: 'NoPoster' }] });
      if (p === '/movie/603') return r({ id: 603, title: 'The Matrix', original_title: 'The Matrix', release_date: '1999-03-31', runtime: 136, imdb_id: 'tt0133093', genres: [{ name: 'Action' }], vote_average: 8.2, poster_path: '/m.jpg', videos: { results: [{ site: 'YouTube', type: 'Trailer', official: true, key: 'abc' }, { site: 'Vimeo', type: 'Trailer', key: 'zzz' }] }, credits: { cast: results(30).map((c) => ({ name: c.name, character: 'c', profile_path: '/h' })) }, recommendations: { results: results(30) } });
      if (p === '/tv/1396') return r({ id: 1396, name: 'Breaking Bad', original_name: 'Breaking Bad', first_air_date: '2008-01-20', episode_run_time: [47], seasons: [{ season_number: 0, episode_count: 5, name: 'Specials' }, { season_number: 1, episode_count: 7, name: 'Season 1', air_date: '2008-01-20' }, { season_number: 2, episode_count: 0, name: 'Empty' }], external_ids: { imdb_id: 'tt0903747' }, genres: [], credits: {}, recommendations: {}, videos: {} });
      if (p === '/tv/1396/season/1') return r({ season_number: 1, name: 'Season 1', episodes: [{ episode_number: 1, name: 'Pilot', overview: 'x'.repeat(500), still_path: '/s1', runtime: 58, air_date: '2008-01-20', vote_average: 8.04 }] });
      if (p === '/movie/603/recommendations') return r({ results: results(30) });
      if (p === '/movie/0') return r({ status_message: 'nf' }, 404);
      if (p === '/movie/401') return r({}, 401);
      if (p === '/movie/429') return r({}, 429);
      return r({}, 500);
    }
    return r({}, 404);
  };
  return { f, calls };
}
const get = (path, env = { TMDB_API_KEY: KEY }, up = upstream()) => handleApi(new Request('http://x.test' + path), env, { fetch: up.f }).then(async (res) => ({ res, body: await res.clone().json().catch(() => null), up }));

test('home: aggregates 5 rows, slims payload, drops persons and posterless items', async () => {
  const { res, body, up } = await get('/api/home');
  assert.equal(res.status, 200);
  assert.deepEqual(body.rows.map((r) => r.id), ['trending', 'popular-movies', 'popular-tv', 'top-movies', 'top-tv']);
  assert.equal(body.rows[0].items.length, 3, 'person removed');
  assert.ok(body.hero && body.hero.backdrop && body.hero.overview);
  const first = body.rows[1].items[0];
  assert.deepEqual(Object.keys(first).sort(), ['backdrop', 'id', 'overview', 'poster', 'rating', 'title', 'type', 'year']);
  assert.equal(first.type, 'movie'); assert.equal(first.rating, 7.5); assert.ok(first.overview.length <= 220);
  assert.equal(up.calls.length, 5, 'exactly one upstream call per row');
  assert.match(res.headers.get('cache-control'), /s-maxage=900/);
});

test('API key: sent upstream as api_key (v3) or Bearer (v4), never returned to the client', async () => {
  const a = await get('/api/home');
  assert.equal(a.up.calls[0].url.searchParams.get('api_key'), KEY);
  assert.ok(!JSON.stringify(a.body).includes(KEY));
  const jwt = 'eyJhbGciOi.' + 'p'.repeat(60) + '.sig';
  const b = await get('/api/home', { TMDB_API_KEY: jwt });
  assert.equal(b.up.calls[0].init.headers.authorization, 'Bearer ' + jwt);
  assert.equal(b.up.calls[0].url.searchParams.get('api_key'), null);
});

test('missing key -> 501 with a setup hint; /health reports configuration without secrets', async () => {
  const a = await get('/api/home', {});
  assert.equal(a.res.status, 501); assert.equal(a.body.error, 'tmdb_not_configured');
  const h = await get('/api/health', { TMDB_API_KEY: KEY, OPENSUBTITLES_API_KEY: 'osk' });
  assert.deepEqual([h.body.tmdb, h.body.subtitles.opensubtitles], [true, true]);
  assert.ok(!JSON.stringify(h.body).includes(KEY) && !JSON.stringify(h.body).includes('osk'));
});

test('title: movie and tv shapes (specials/empty seasons removed, trailer, imdb id, caps)', async () => {
  const m = (await get('/api/title/movie/603')).body;
  assert.equal(m.imdbId, 'tt0133093'); assert.equal(m.runtime, 136); assert.equal(m.trailer.key, 'abc');
  assert.equal(m.originalTitle, 'The Matrix'); assert.equal(m.rating, 8.2); // Mavonyx searches by both titles and scores the rating
  assert.equal(m.cast.length, 14); assert.equal(m.recs.length, 18); assert.deepEqual(m.genres, ['Action']);
  const t = (await get('/api/title/tv/1396')).body;
  assert.deepEqual(t.seasons.map((s) => s.n), [1]); assert.equal(t.imdbId, 'tt0903747'); assert.equal(t.runtime, 47);
  assert.equal(t.originalTitle, 'Breaking Bad');
});

test('season: episode fields trimmed and rounded', async () => {
  const s = (await get('/api/season/1396/1')).body;
  assert.equal(s.episodes[0].n, 1); assert.ok(s.episodes[0].overview.length <= 260); assert.equal(s.episodes[0].rating, 8);
});

test('search + recs', async () => {
  const s = (await get('/api/search?q=matrix')).body;
  assert.deepEqual(s.items.map((i) => i.id), [1, 3], 'person and posterless result removed');
  assert.equal((await get('/api/recs/movie/603')).body.items.length, 18);
});

test('validation and error mapping', async () => {
  for (const p of ['/api/title/anime/1', '/api/title/movie/abc', '/api/season/1', '/api/search', '/api/search?q=' + 'a'.repeat(101)]) assert.equal((await get(p)).res.status, 400, p);
  assert.equal((await get('/api/title/movie/0')).res.status, 404);
  const u = await get('/api/title/movie/401');
  assert.equal(u.res.status, 502); assert.equal(u.body.error, 'tmdb_auth_failed'); assert.ok(!JSON.stringify(u.body).includes(KEY));
  assert.equal((await get('/api/title/movie/429')).res.status, 503);
  assert.equal((await get('/api/nope')).res.status, 404);
  const post = await handleApi(new Request('http://x.test/api/home', { method: 'POST' }), { TMDB_API_KEY: KEY });
  assert.equal(post.status, 405);
});

test('subs: OpenSubtitles params are lowercase + sorted; tv uses parent_tmdb_id', async () => {
  const up = upstream({ '/api/v1/subtitles': (u, i, r) => r({ data: [{ attributes: { language: 'en', release: 'Rel.1', download_count: 9, hearing_impaired: true, files: [{ file_id: 77, file_name: 'a.srt' }] } }, { attributes: { language: 'bn', files: [] } }] }) });
  const { body } = await get('/api/subs?type=tv&tmdb=1396&season=1&episode=2&lang=EN,bn', { TMDB_API_KEY: KEY, OPENSUBTITLES_API_KEY: 'osk' }, up);
  const call = up.calls.find((c) => c.url.pathname === '/api/v1/subtitles');
  assert.equal(call.url.search, '?episode_number=2&languages=en%2Cbn&order_by=download_count&order_direction=desc&parent_tmdb_id=1396&season_number=1');
  assert.equal(call.init.headers['Api-Key'], 'osk'); assert.match(call.init.headers['User-Agent'], /RafTV/);
  assert.deepEqual(body.items, [{ id: 'os:77', provider: 'opensubtitles', lang: 'en', name: 'Rel.1', downloads: 9, hi: true }]);
});

test('subs: falls back to keyless Stremio addon (3-letter codes mapped, hosts filtered)', async () => {
  const up = upstream({ '/subtitles/series/tt0903747:1:2.json': (u, i, r) => r({ subtitles: [{ id: '1', lang: 'eng', url: 'https://subs5.strem.io/en/a.srt' }, { id: '2', lang: 'ben', url: 'https://subs5.strem.io/bn/b.srt' }, { id: '3', lang: 'fre', url: 'https://subs5.strem.io/fr/c.srt' }, { id: '4', lang: 'eng', url: 'https://evil.example/x.srt' }] }) });
  const { body } = await get('/api/subs?type=tv&imdb=tt0903747&season=1&episode=2&lang=en,bn', { TMDB_API_KEY: KEY }, up);
  assert.deepEqual(body.items.map((i) => i.lang), ['en', 'bn']);
  assert.equal(body.used.stremio, true); assert.equal(body.used.opensubtitles, false);
});

test('sub download: OS flow (login -> download -> gz link) and SSRF guards', async () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nHi\n';
  const up = upstream({
    '/api/v1/login': (u, i, r) => r({ token: 'tok' }),
    '/api/v1/download': (u, i, r) => r({ link: 'https://dl.opensubtitles.org/file/1.srt.gz' }),
    '/file/1.srt.gz': (u, i, r) => r(new Uint8Array(gzipSync(srt))),
  });
  const env = { TMDB_API_KEY: KEY, OPENSUBTITLES_API_KEY: 'osk', OPENSUBTITLES_USERNAME: 'u', OPENSUBTITLES_PASSWORD: 'p' };
  const res = await handleApi(new Request('http://x.test/api/sub?id=os:77'), env, { fetch: up.f });
  assert.equal(res.status, 200); assert.equal(await res.text(), srt);
  assert.equal(up.calls.find((c) => c.url.pathname === '/api/v1/download').init.headers.Authorization, 'Bearer tok');

  const evil = 'sv:' + Buffer.from('https://evil.example/x.srt').toString('base64url');
  assert.equal((await get('/api/sub?id=' + evil)).res.status, 403);
  const http = 'sv:' + Buffer.from('http://subs5.strem.io/x.srt').toString('base64url');
  assert.equal((await get('/api/sub?id=' + http)).res.status, 403, 'https only');
  const lookalike = 'sv:' + Buffer.from('https://strem.io.evil.example/x.srt').toString('base64url');
  assert.equal((await get('/api/sub?id=' + lookalike)).res.status, 403, 'suffix lookalike rejected');
  assert.equal((await get('/api/sub?id=nonsense')).res.status, 400);
});

test('edge proxy: allowlisted https hosts only', async () => {
  const up = upstream({ '/the-matrix/': (u, i, r) => r('<html>movie page</html>') });
  const ok = await handleApi(new Request('http://x.test/api/proxy?u=' + encodeURIComponent('https://4khdhub.one/the-matrix/')), {}, { fetch: up.f });
  assert.equal(ok.status, 200); assert.match(await ok.text(), /movie page/);
  // FlixHub is a BDIX server (Cloudflare cannot reach it): not proxied by default
  for (const u of ['https://flixhub.net/watch/movie/x', 'https://example.com/', 'http://4khdhub.one/x', 'https://4khdhub.one:8443/x', 'https://4khdhub.one@evil.com/', 'https://user:p@4khdhub.one/', 'https://4khdhub.one.evil.com/', 'nonsense']) {
    const r = await handleApi(new Request('http://x.test/api/proxy?u=' + encodeURIComponent(u)), {}, { fetch: up.f });
    assert.ok([400, 403].includes(r.status), `${u} -> ${r.status}`);
  }
});

test('edge proxy: a Cloudflare block of the upstream (error 1106, bot challenge) is marked, so the app can say "needs gateway"', async () => {
  // measured Nov 2026 from the deployed site: 4khdhub.one answers Cloudflare Workers with 403 "error code: 1106",
  // hubdrive.blog / hubcloud.mov with a 403 "Just a moment..." challenge page
  const pages = {
    '/ban/': (u, i, r) => r('error code: 1106', 403),
    '/challenge/': (u, i, r) => r('<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head></html>', 403, { 'cf-mitigated': 'challenge' }),
    '/challenge-nohdr/': (u, i, r) => r('<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>', 503),
    '/missing/': (u, i, r) => r('not found', 404),
    '/forbidden/': (u, i, r) => r('<html>members only</html>', 403),
    '/ok/': (u, i, r) => r('<html>ok</html>'),
    '/ok-lookalike/': (u, i, r) => r('error code: 1106 <title>Just a moment...</title> (an article about Cloudflare errors)'),
  };
  const up = upstream(pages);
  const call = (p) => handleApi(new Request('http://x.test/api/proxy?u=' + encodeURIComponent('https://4khdhub.one' + p)), {}, { fetch: up.f });
  for (const p of ['/ban/', '/challenge/', '/challenge-nohdr/']) {
    const r = await call(p);
    assert.ok(!r.ok, p); assert.equal(r.headers.get('x-upstream-blocked'), 'cloudflare', p);
  }
  for (const p of ['/missing/', '/forbidden/', '/ok/', '/ok-lookalike/']) assert.equal((await call(p)).headers.get('x-upstream-blocked'), null, p + ' is an ordinary answer');
});

test('APP_NAME sets the OpenSubtitles User-Agent (must match your registered consumer); default is RafTV', async () => {
  for (const [env, want] of [[{ TMDB_API_KEY: KEY, OPENSUBTITLES_API_KEY: 'k' }, 'RafTV v1.0'], [{ TMDB_API_KEY: KEY, OPENSUBTITLES_API_KEY: 'k', APP_NAME: 'MyCinema' }, 'MyCinema v1.0']]) {
    const up = upstream({ '/api/v1/subtitles': (u, i, r) => r({ data: [] }) });
    await get('/api/subs?type=movie&tmdb=603&lang=en', env, up);
    assert.equal(up.calls.find((c) => c.url.pathname === '/api/v1/subtitles').init.headers['User-Agent'], want);
  }
});
