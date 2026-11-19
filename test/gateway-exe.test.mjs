// The packaged gateway (raftv-gateway.exe): the BUNDLED launcher (dist/gateway/raftv-gateway.cjs, the exact file that is
// put into the executable) is started as its own process and used the way the site uses a gateway.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(root, 'dist', 'gateway', 'raftv-gateway.cjs');
const SITE = 'https://raftv.pages.dev';
const BYTES = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));

/** Local upstream: echoes request headers, serves a file with Range, and an HLS playlist. */
function upstream() {
  const srv = http.createServer((req, res) => {
    if (req.url === '/echo') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ headers: req.headers })); }
    if (req.url === '/file.mp4') {
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (m) { const s = +m[1]; const e = +m[2]; res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes ${s}-${e}/${BYTES.length}`, 'content-length': e - s + 1, 'accept-ranges': 'bytes' }); return res.end(BYTES.subarray(s, e + 1)); }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': BYTES.length }); return res.end(BYTES);
    }
    if (req.url === '/hls/master.m3u8') { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\n360p/playlist.jpg\n'); }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

/** Starts the bundled launcher in `dir`; resolves with the address it prints. */
function start(dir, env = {}) {
  const child = spawn(process.execPath, [BUNDLE], { cwd: dir, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no start: ' + out)), 8000);
    const on = (d) => {
      out += d;
      const m = /Address\s+(http:\/\/[\d.]+:\d+)/.exec(out);
      const tok = /Token\s+(\S+)/.exec(out);
      if (m && tok && /Stop:/.test(out)) { clearTimeout(timer); resolve({ child, out, base: m[1], local: (/(http:\/\/127\.0\.0\.1:\d+)/.exec(out) || [])[1], token: tok[1] }); }
    };
    child.stdout.on('data', on); child.stderr.on('data', on);
    child.on('exit', (c) => { clearTimeout(timer); reject(new Error(`exited ${c}: ${out}`)); });
  });
  ready.child = child;
  return ready;
}
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

test.before(() => { execFileSync(process.execPath, [path.join(root, 'scripts', 'build-gateway-exe.mjs'), '--bundle-only'], { cwd: root, stdio: 'ignore' }); });

test('packaged gateway: first start writes its settings (random token, LAN, RafTV site only); later starts reuse them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgw-'));
  const a = await start(dir, { HOST: '127.0.0.1', PORT: '0' });
  a.child.kill();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'raftv-gateway.json'), 'utf8'));
  assert.equal(saved.host, '0.0.0.0'); assert.equal(saved.port, 8787); assert.deepEqual(saved.allowedOrigins, [SITE]);
  assert.match(saved.token, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(a.token, saved.token);
  const b = await start(dir, { HOST: '127.0.0.1', PORT: '0' });
  b.child.kill();
  assert.equal(b.token, saved.token, 'same token after a restart (the phone keeps working)');
});

test('packaged gateway: everything the site uses works through it (health, token, CORS, lookups with Referer, video Range, HLS rewrite)', async () => {
  const up = await upstream();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgw-'));
  // ALLOW_PRIVATE: the test upstream is on loopback, which the gateway otherwise refuses (SSRF policy)
  const g = await start(dir, { HOST: '127.0.0.1', PORT: '0', ALLOW_PRIVATE: '127.0.0.1' });
  try {
    assert.equal((await fetch(g.base + '/health')).status, 200);
    const env = (url, headers = {}) => JSON.stringify({ url, method: 'GET', headers });
    const p = (q, body, origin = SITE) => fetch(`${g.base}/p${q}`, { method: 'POST', headers: { 'content-type': 'text/plain', origin }, body });
    assert.equal((await p('', env(up.base + '/echo'))).status, 401, 'token required');
    // a lookup the way Mavonyx sends it (movie-page Referer); the BDIX providers send the same envelope
    const r = await p(`?k=${g.token}`, env(up.base + '/echo', { Referer: 'https://movie-box.co/movies/x?id=1', 'User-Agent': 'UA-test', Cookie: 'dropped=1' }));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), SITE);
    const seen = (await r.json()).headers;
    assert.equal(seen.referer, 'https://movie-box.co/movies/x?id=1');
    assert.equal(seen['user-agent'], 'UA-test');
    assert.equal(seen.cookie, undefined, 'cookies are never forwarded');
    const foreign = await p(`?k=${g.token}`, env(up.base + '/echo'), 'https://evil.example');
    assert.equal(foreign.headers.get('access-control-allow-origin'), null, 'other sites cannot read replies');
    // video with seeking (Range), as <video> requests it
    const v = await fetch(`${g.base}/s?u=${encodeURIComponent(up.base + '/file.mp4')}&k=${g.token}&h=${b64url({ Referer: 'https://x.test/' })}`, { headers: { range: 'bytes=100-199' } });
    assert.equal(v.status, 206);
    assert.deepEqual(Buffer.from(await v.arrayBuffer()), BYTES.subarray(100, 200));
    // HLS through the gateway (Fendrix without built-in HLS): playlist URIs come back through it
    const h = await (await fetch(`${g.base}/s?u=${encodeURIComponent(up.base + '/hls/master.m3u8')}&k=${g.token}&hls=1`)).text();
    assert.match(h, /^s\?u=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fhls%2F360p%2Fplaylist\.jpg&k=/m);
    // SSRF policy still applies inside the program: cloud metadata address refused
    assert.equal((await p(`?k=${g.token}`, env('http://169.254.169.254/latest'))).status, 403);
  } finally { g.child.kill(); up.srv.close(); }
});

test('packaged gateway: default start listens on the local network and prints the phone address and this PC\'s address', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgw-'));
  const g = await start(dir, { PORT: '0' });
  try {
    assert.match(g.out, /\(on this PC itself: http:\/\/127\.0\.0\.1:\d+\)/);
    assert.equal((await fetch(g.local + '/health')).status, 200);
    assert.match(g.out, /Allowed site\(s\): https:\/\/raftv\.pages\.dev/);
  } finally { g.child.kill(); }
});

test('packaged gateway: a busy port gives a readable message instead of a crash', async () => {
  const blocker = http.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgw-'));
  const child = spawn(process.execPath, [BUNDLE], { cwd: dir, env: { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: String(blocker.address().port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((r) => child.on('exit', r));
  blocker.close();
  assert.equal(code, 1);
  assert.match(err, /already in use/);
});
