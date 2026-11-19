import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
// Runs the REAL Cloudflare Pages runtime locally (wrangler -> workerd) and checks the Function, routing and headers.
// The Function's TMDB base URL is pointed at a local mock, so no internet or API key is needed.   npm run smoke:cf
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createMockFetch } from '../dev/mock-upstream.mjs';

const MOCK_PORT = 8765;
const CF_PORT = 8799;
const KEY = 'secret-test-key-123';

const mock = createMockFetch({ mediaBase: 'http://127.0.0.1:1' });
const seen = [];
const mockSrv = http.createServer(async (req, res) => {
  seen.push(req.url);
  const r = await mock('https://api.themoviedb.org' + req.url);
  res.writeHead(r.status, { 'content-type': 'application/json' });
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(MOCK_PORT, '127.0.0.1');

// a throw-away local D1 database for the account checks
const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-d1-'));
const wr = spawn('npx', ['wrangler', 'pages', 'dev', 'public', '--port', String(CF_PORT), '--ip', '127.0.0.1', '--binding', `TMDB_API_KEY=${KEY}`, `TMDB_API_BASE=http://127.0.0.1:${MOCK_PORT}/3`, '--binding', 'ADMIN_USERNAME=owner', '--binding', 'ADMIN_PASSWORD=smoke admin passphrase', '--d1', 'DB', '--persist-to', persistDir, '--log-level=warn'], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
wr.stdout.on('data', (d) => { logs += d; }); wr.stderr.on('data', (d) => { logs += d; });
const B = `http://127.0.0.1:${CF_PORT}`;
const results = [];
const t = async (name, fn) => { try { await fn(); results.push(1); console.log('\u2714', name); } catch (e) { results.push(0); console.log('\u2716', name, '\n   ', e.message.split('\n').slice(0, 6).join('\n    ')); } };
const get = (p, init) => fetch(B + p, init);
const json = async (p) => (await get(p)).json();

try {
  for (let i = 0; i < 60; i++) { try { if ((await get('/api/health')).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 1000)); }

  await t('static site served; index.html carries the real _headers (CSP, nosniff, no-referrer)', async () => {
    const r = await get('/');
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/html/);
    const csp = r.headers.get('content-security-policy');
    assert.ok(csp.includes("default-src 'self'") && csp.includes("frame-ancestors 'none'") && csp.includes('media-src'), csp);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.match(await r.text(), /<main id="main"/);
  });
  await t('versioned vendor assets are immutable; JS modules and the font are served', async () => {
    const v = await json('/vendor/versions.json');
    const r = await get('/vendor/' + v.artplayer);
    assert.equal(r.status, 200); assert.match(r.headers.get('cache-control'), /immutable/);
    assert.equal((await get('/js/main.js')).status, 200); assert.equal((await get('/' + 'vendor/' + v.font)).status, 200);
  });
  await t('/api/health reports configuration without leaking secrets', async () => {
    const h = await json('/api/health');
    assert.deepEqual([h.ok, h.tmdb, h.subtitles.opensubtitles, h.subtitles.stremio], [true, true, false, true]);
    assert.ok(!JSON.stringify(h).includes(KEY));
  });
  await t('/api/home: Function (workerd) -> TMDB mock; 5 rows, hero, slimmed items, edge cache headers', async () => {
    const r = await get('/api/home'); const d = await r.json();
    assert.deepEqual(d.rows.map((x) => x.id), ['trending', 'popular-movies', 'popular-tv', 'top-movies', 'top-tv']);
    assert.ok(d.hero.title && d.hero.backdrop);
    assert.deepEqual(Object.keys(d.rows[1].items[0]).sort(), ['backdrop', 'id', 'overview', 'poster', 'rating', 'title', 'type', 'year']);
    assert.match(r.headers.get('cache-control'), /s-maxage=900/);
    assert.ok(seen.length > 0 && seen.every((u) => u.includes('api_key=' + KEY)), 'key sent upstream: ' + JSON.stringify(seen.slice(0, 3))); assert.ok(!JSON.stringify(d).includes(KEY), 'never returned to the browser');
  });
  await t('title / season / search / recs work in workerd; subtitle search degrades gracefully when its upstream is down', async () => {
    const m = await json('/api/title/movie/603'); assert.deepEqual([m.title, m.runtime, m.imdbId, m.cast.length], ['The Matrix', 136, 'tt0133093', 14], JSON.stringify(m).slice(0, 200)); assert.equal(m.trailer.key, 'dQw4w9WgXcQ');
    const tv = await json('/api/title/tv/1396'); assert.deepEqual(tv.seasons.map((s) => s.n), [1, 2]);
    assert.equal((await json('/api/season/1396/2')).episodes.length, 13);
    assert.ok((await json('/api/search?q=orchard')).items.every((i) => /orchard/i.test(i.title)));
    assert.ok((await json('/api/recs/movie/603')).items.length >= 10);
    // only TMDB is redirected to the mock here, so the subtitle upstream is unreachable: it must degrade to an empty list, not an error
    const sr = await get('/api/subs?type=movie&imdb=tt0133093&lang=en,bn'); assert.equal(sr.status, 200);
    const s = await sr.json(); assert.deepEqual([Array.isArray(s.items), s.items.length], [true, 0]);
  });
  await t('subtitle download validates ids and hosts inside workerd (SSRF guards)', async () => {
    assert.equal((await get('/api/sub?id=nonsense')).status, 400);
    const evil = 'sv:' + Buffer.from('https://evil.example/x.srt').toString('base64url');
    assert.equal((await get('/api/sub?id=' + evil)).status, 403);
  });
  await t('errors map to the right status; methods and routes are validated', async () => {
    assert.equal((await get('/api/title/movie/abc')).status, 400);
    assert.equal((await get('/api/title/movie/999999')).status, 404);
    assert.equal((await get('/api/nope')).status, 404);
    assert.equal((await get('/api/search')).status, 400);
    assert.equal((await get('/api/home', { method: 'POST' })).status, 405);
    // Mavonyx web-stream route: validated inside workerd before any upstream request (valid calls are not made here)
    for (const q of ['', 'subjectId=x&se=0&ep=0&detailPath=a', 'subjectId=1&se=0&ep=0&detailPath=..%2Fx', 'subjectId=1&se=0&ep=0&detailPath=a%40evil.com']) assert.equal((await get('/api/mavonyx/play?' + q)).status, 400, q);
  });
  await t('edge proxy only allows https + allowlisted hosts (no ports, no userinfo, no lookalikes)', async () => {
    for (const u of ['https://example.com/', 'https://flixhub.net/', 'http://4khdhub.one/', 'https://4khdhub.one:8443/', 'https://4khdhub.one@evil.com/', 'https://4khdhub.one.evil.com/']) {
      const r = await get('/api/proxy?u=' + encodeURIComponent(u)); assert.ok([400, 403].includes(r.status), `${u} -> ${r.status}`);
    }
  });
  await t('accounts in workerd + local D1: admin bootstrap (PBKDF2 100k), invite, sign-up, session cookie, sync, CSRF', async () => {
    const jar = {};
    const call = async (who, method, p, body, extra = {}) => {
      const r = await get(p, { method, headers: { 'content-type': 'application/json', origin: B, ...(jar[who] ? { cookie: jar[who] } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
      const c = r.headers.get('set-cookie'); if (c) jar[who] = /rh_session=[^;]*/.exec(c)[0];
      return { status: r.status, data: await r.json().catch(() => null), cookie: c };
    };
    assert.equal((await (await get('/api/health')).json()).accounts, true);
    const login = await call('admin', 'POST', '/api/auth/login', { username: 'owner', password: 'smoke admin passphrase' });
    assert.equal(login.status, 200, JSON.stringify(login.data)); assert.match(login.cookie, /HttpOnly; SameSite=Strict/);
    const inv = await call('admin', 'POST', '/api/admin/invites', { maxUses: 1 });
    assert.equal(inv.status, 201);
    const su = await call('u', 'POST', '/api/auth/signup', { username: 'smoker', password: 'a long enough password', invite: inv.data.code });
    assert.equal(su.status, 201, JSON.stringify(su.data));
    assert.equal((await call('u2', 'POST', '/api/auth/signup', { username: 'second', password: 'a long enough password', invite: inv.data.code })).data.error, 'bad_invite');
    assert.equal((await call('u', 'PUT', '/api/sync', { doc: { history: { 'movie:1': { type: 'movie', id: 1, ts: 1 } } }, version: 0 })).data.version, 1);
    assert.equal((await call('u', 'GET', '/api/sync')).data.version, 1);
    assert.equal((await call('u', 'GET', '/api/admin/users')).status, 403);
    assert.equal((await call('u', 'POST', '/api/auth/logout', {}, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await get('/api/auth/me', { headers: { cookie: jar.u } })).headers.get('cache-control'), 'no-store');
  });
} finally {
  const ok = results.filter(Boolean).length;
  console.log(`\n${ok}/${results.length} Cloudflare runtime checks passed`);
  if (ok !== results.length) console.log('wrangler output:\n' + logs.split('\n').filter((l) => !/Request\.cf|ENOTFOUND|onlookupall|callbackTrampoline/.test(l)).slice(-20).join('\n'));
  wr.kill('SIGTERM'); mockSrv.close();
  try { fs.rmSync(persistDir, { recursive: true, force: true }); } catch { /* temp */ }
  setTimeout(() => { wr.kill('SIGKILL'); process.exit(ok === results.length ? 0 : 1); }, 1500);
}
