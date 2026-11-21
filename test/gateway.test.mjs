import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway, classify } from '../gateway/bdix-gateway.mjs';

const FILE = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
let up, upPort, gw, gwPort, seen;
const hlsLog = [];
const SEGMENT = Buffer.from(Array.from({ length: 700 }, (_, i) => (i * 7) % 256)); // binary, starts with 0x00 like a TS/fMP4 segment
let HLS = {};

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

before(async () => {
  up = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
      if (req.url === '/api') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ search: [{ href: '/x.mkv' }] })); }
      if (req.url === '/redir') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }); return res.end(); }
      if (req.url === '/big') { res.end(Buffer.alloc(3000)); return; }
      if (req.url.startsWith('/hls/')) {
        // like the Fendrix CDN: any request with an Origin gets 404; playlists are served as image/jpeg under .jpg names
        hlsLog.push({ path: req.url, origin: req.headers.origin || null, referer: req.headers.referer || null, range: req.headers.range || null });
        if (req.headers.origin) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found/removed\n'); }
        const body = HLS[req.url.split('?')[0]];
        if (body === undefined) { res.statusCode = 404; return res.end('nf'); }
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
        if (m) { const e = m[2] ? +m[2] : buf.length - 1; res.writeHead(206, { 'content-type': 'image/jpeg', 'content-range': `bytes ${m[1]}-${e}/${buf.length}` }); return res.end(buf.subarray(+m[1], e + 1)); }
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        return res.end(buf);
      }
      if (req.url.startsWith('/movie.mov')) {
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
        const s = m ? +m[1] : 0, e = m && m[2] ? +m[2] : FILE.length - 1;
        res.writeHead(m ? 206 : 200, { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', 'content-length': e - s + 1, ...(m ? { 'content-range': `bytes ${s}-${e}/${FILE.length}` } : {}) });
        return res.end(FILE.subarray(s, e + 1));
      }
      res.statusCode = 404; res.end('nf');
    });
  });
  upPort = await listen(up);
  gw = createGateway({ host: '127.0.0.1', token: 'secret', allowPrivate: ['127.0.0.1'], origins: ['https://site.example'], referers: { '127.0.0.1': 'http://ref.test/' }, maxTextResponseBytes: 2000 });
  gwPort = await listen(gw);
});
after(() => { up.close(); gw.close(); });

const G = (p, init) => fetch(`http://127.0.0.1:${gwPort}${p}`, init);
const T = '&k=secret';
const target = (p) => encodeURIComponent(`http://127.0.0.1:${upPort}${p}`);

test('refuses to start on a non-loopback address without a token', () => {
  assert.throws(() => createGateway({ host: '0.0.0.0', token: '' }), /open proxy/);
  assert.doesNotThrow(() => createGateway({ host: '0.0.0.0', token: 'x' }));
});

test('health is public; everything else needs the token', async () => {
  assert.equal((await G('/health')).status, 200);
  assert.equal((await G('/s?u=' + target('/movie.mov'))).status, 401);
  assert.equal((await G('/s?u=' + target('/movie.mov') + '&k=wrong')).status, 401);
  assert.equal((await G('/s?u=' + target('/movie.mov') + T)).status, 200);
});

test('POST /p envelope: forwards method/body/headers, injects UA and per-host Referer, mirrors status + CORS', async () => {
  const r = await G('/p?k=secret', { method: 'POST', headers: { origin: 'https://site.example', 'content-type': 'text/plain' }, body: JSON.stringify({ url: `http://127.0.0.1:${upPort}/api`, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Evil': '1', Cookie: 'a=b' }, body: '{"action":"get"}' }) });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { search: [{ href: '/x.mkv' }] });
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://site.example');
  assert.equal(seen.method, 'POST'); assert.equal(seen.body, '{"action":"get"}');
  assert.equal(seen.headers['content-type'], 'application/json'); assert.match(seen.headers['user-agent'], /Chrome\/151/);
  assert.equal(seen.headers.referer, 'http://ref.test/');
  assert.equal(seen.headers['x-evil'], undefined, 'non-allowlisted headers are not forwarded'); assert.equal(seen.headers.cookie, undefined);
  const nf = await G('/p?k=secret', { method: 'POST', body: JSON.stringify({ url: `http://127.0.0.1:${upPort}/missing` }) });
  assert.equal(nf.status, 404, 'upstream status mirrored');
  assert.equal((await G('/p?k=secret', { method: 'POST', body: 'not json' })).status, 400);
  assert.equal((await G('/p?k=secret', { method: 'POST', body: JSON.stringify({ url: `http://127.0.0.1:${upPort}/big` }) })).status, 502, 'text response cap enforced');
});

test('CORS: only the configured origin is echoed; preflight allows private network', async () => {
  const bad = await G('/health', { headers: { origin: 'https://evil.example' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  const pre = await G('/p', { method: 'OPTIONS', headers: { origin: 'https://site.example', 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' } });
  assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-private-network'), 'true');
  assert.match(pre.headers.get('access-control-allow-headers'), /range/);
});

test('GET /s streams with Range -> 206 and exact bytes; normalises octet-stream by extension', async () => {
  const full = await G('/s?u=' + target('/movie.mov') + T);
  assert.equal(full.status, 200); assert.equal(full.headers.get('content-type'), 'video/quicktime');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), FILE);
  const part = await G('/s?u=' + target('/movie.mov') + T, { headers: { range: 'bytes=100-199' } });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 100-199/1000');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), FILE.subarray(100, 200));
  assert.equal(seen.headers.range, 'bytes=100-199'); assert.equal(seen.headers.referer, 'http://ref.test/');
});

test('download mode sets a sanitised Content-Disposition', async () => {
  const r = await G('/s?u=' + target('/movie.mov') + T + '&dl=1&n=' + encodeURIComponent('Bad"Name\r\nX: y é.mov'));
  const cd = r.headers.get('content-disposition');
  assert.match(cd, /^attachment; filename="Bad_Name__X: y _\.mov"; filename\*=UTF-8''/);
  assert.ok(!/[\r\n]/.test(cd)); await r.arrayBuffer();
});

test('SSRF: blocks loopback (not allowlisted), metadata, literal/decimal IPs, IPv6, odd schemes, credentials, redirects into blocked space', async () => {
  const strict = createGateway({ host: '127.0.0.1', token: 'secret', allowPrivate: [], privateNetworks: false });
  const sp = await listen(strict);
  const S = (u) => fetch(`http://127.0.0.1:${sp}/s?k=secret&u=${encodeURIComponent(u)}`).then((r) => r.status);
  try {
    assert.equal(await S(`http://127.0.0.1:${upPort}/movie.mov`), 403, 'loopback not allowlisted');
    assert.equal(await S('http://2130706433/'), 403, 'decimal form of 127.0.0.1');
    assert.equal(await S('http://0x7f.1/'), 403, 'hex form');
    assert.equal(await S('http://[::1]/'), 403);
    assert.equal(await S('http://[::ffff:127.0.0.1]/'), 403, 'IPv4-mapped IPv6 (URL normalises to hex form)');
    assert.equal(await S('http://[::ffff:169.254.169.254]/'), 403, 'mapped metadata address');
    assert.equal(await S('http://[64:ff9b::a00:1]/'), 403, 'NAT64-embedded private IPv4');
    assert.equal(await S('http://10.0.0.5/'), 403);
    assert.equal(await S('http://192.168.1.1/'), 403);
    assert.equal(await S('http://localhost:1/'), 403, 'hostname resolving to loopback');
    assert.equal(await S('file:///etc/passwd'), 400);
    assert.equal(await S('ftp://example.com/x'), 400);
    assert.equal(await S('http://user:pw@example.com/'), 400);
  } finally { strict.close(); }
  // metadata address can never be allowlisted, even explicitly
  const lax = createGateway({ host: '127.0.0.1', token: 'secret', allowPrivate: ['127.0.0.1', '169.254.169.254'] });
  const lp = await listen(lax);
  try {
    assert.equal(await fetch(`http://127.0.0.1:${lp}/s?k=secret&u=${encodeURIComponent('http://169.254.169.254/latest')}`).then((r) => r.status), 403);
    // allowlisted upstream redirecting to the metadata address is re-validated per hop
    assert.equal(await fetch(`http://127.0.0.1:${lp}/s?k=secret&u=${target('/redir')}`).then((r) => r.status), 403);
  } finally { lax.close(); }
});

test('classify(): address policy matrix', () => {
  const cases = { '8.8.8.8': null, '15.1.1.50': null, '172.16.50.12': 'private', '172.32.0.1': null, '10.1.2.3': 'private', '192.168.0.1': 'private', '100.64.0.1': 'private', '127.0.0.1': 'loopback', '169.254.169.254': 'never', '0.0.0.0': 'never', '224.0.0.1': 'never', '::1': 'loopback', 'fd00::1': 'private', 'fe80::1': 'never', '::ffff:10.0.0.1': 'private', '2606:4700::1111': null, '::ffff:7f00:1': 'loopback', '::ffff:a9fe:a9fe': 'never', '::ffff:808:808': null, '64:ff9b::a00:1': 'private', '2002:a00:1::': 'private', '2002:808:808::': null, '::7f00:1': 'loopback', '::': 'never' };
  for (const [ip, want] of Object.entries(cases)) assert.equal(classify(ip), want, ip);
});

// ---------------- HLS through the gateway (players without built-in HLS, e.g. Firefox + Fendrix) ----------------
test('GET /s?hls=1: playlists are rewritten to come back through the gateway; segments stream unchanged; no Origin upstream', async () => {
  const U = `http://127.0.0.1:${upPort}`;
  HLS = {
    '/hls/a/master.m3u8': '#EXTM3U\r\n#EXT-X-VERSION:3\r\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="audio/en.jpg"\r\n#EXT-X-STREAM-INF:BANDWIDTH=4692000,RESOLUTION=1920x1080\r\n1080p/playlist.jpg\r\n',
    '/hls/a/1080p/playlist.jpg': `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../key.bin"\n#EXTINF:2.0,\nplaylist_000.jpg\n#EXTINF:2.0,\n${U}/hls/a/1080p/playlist_001.jpg\n#EXT-X-ENDLIST\n`,
    '/hls/a/audio/en.jpg': '#EXTM3U\n#EXTINF:2.0,\nen_000.jpg\n#EXT-X-ENDLIST\n',
    '/hls/a/1080p/playlist_000.jpg': SEGMENT,
    '/hls/a/1080p/playlist_001.jpg': SEGMENT,
  };
  hlsLog.length = 0;
  const h = Buffer.from(JSON.stringify({ Origin: 'https://cinejoy.pk', Referer: 'https://cinejoy.pk/' })).toString('base64url');
  const base = `http://127.0.0.1:${gwPort}/s?u=${target('/hls/a/master.m3u8')}&h=${h}&hls=1${T}`;
  const r = await fetch(base, { headers: { origin: 'https://site.example' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/vnd.apple.mpegurl');
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://site.example', 'readable by the page (hls.js)');
  const master = await r.text();
  assert.equal(Number(r.headers.get('content-length')), Buffer.byteLength(master));
  const lines = master.split('\n');
  assert.equal(lines[0], '#EXTM3U');
  // every URI points back at the gateway, absolute upstream URL inside, token + headers carried
  const variant = lines.find((l) => l.startsWith('s?'));
  const vp = new URLSearchParams(variant.slice(2));
  assert.equal(vp.get('u'), `${U}/hls/a/1080p/playlist.jpg`); assert.equal(vp.get('k'), 'secret'); assert.equal(vp.get('h'), h); assert.equal(vp.get('hls'), '1');
  assert.match(master, /URI="s\?u=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fhls%2Fa%2Faudio%2Fen\.jpg&k=secret&h=[^"]+&hls=1"/, 'URI= attributes rewritten too');
  // follow it like a player: relative "s?..." resolves against the playlist URL
  const vr = await fetch(new URL(variant, base));
  const media = await vr.text();
  const segs = media.split('\n').filter((l) => l.startsWith('s?'));
  assert.equal(segs.length, 2, 'relative and absolute segment URIs both rewritten');
  assert.match(media, /URI="s\?u=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fhls%2Fa%2Fkey\.bin/, '../key.bin resolved against the playlist URL');
  for (const sgm of segs) {
    const sr = await fetch(new URL(sgm, base));
    assert.equal(sr.status, 200);
    assert.ok(Buffer.from(await sr.arrayBuffer()).equals(SEGMENT), 'segment bytes unchanged (not mistaken for a playlist)');
  }
  // a Range request for a segment is passed straight through
  const rr = await fetch(new URL(segs[0], base), { headers: { range: 'bytes=10-19' } });
  assert.equal(rr.status, 206); assert.ok(Buffer.from(await rr.arrayBuffer()).equals(SEGMENT.subarray(10, 20)));
  assert.ok(hlsLog.length >= 5 && hlsLog.every((l) => l.origin === null), 'the CDN never saw an Origin (it would answer 404)');
  assert.ok(hlsLog.every((l) => l.referer === 'https://cinejoy.pk/'), 'the stream Referer is still sent');
});

test('GET /s?hls=1 safety: child URLs are re-validated (SSRF), token required, oversize playlists refused; no rewrite without hls=1', async () => {
  HLS = {
    '/hls/evil.m3u8': '#EXTM3U\n#EXTINF:2,\nhttp://169.254.169.254/latest/meta-data\n#EXTINF:2,\nhttp://[::ffff:127.0.0.2]/x\n',
    '/hls/big.m3u8': '#EXTM3U\n' + '#EXTINF:2,\nseg.ts\n'.repeat(400),
    '/hls/plain.m3u8': '#EXTM3U\n#EXTINF:2,\nseg.ts\n',
  };
  const r = await G(`/s?u=${target('/hls/evil.m3u8')}&hls=1${T}`);
  const kids = (await r.text()).split('\n').filter((l) => l.startsWith('s?'));
  assert.equal(kids.length, 2);
  for (const k of kids) assert.equal((await G('/' + k)).status, 403, 'rewritten URL goes through the same address policy');
  assert.equal((await G(`/s?u=${target('/hls/plain.m3u8')}&hls=1`)).status, 401, 'token still required');
  assert.equal((await G(`/s?u=${target('/hls/big.m3u8')}&hls=1${T}`)).status, 502, 'playlist larger than the text limit is refused');
  const raw = await (await G(`/s?u=${target('/hls/plain.m3u8')}${T}`)).text();
  assert.equal(raw, '#EXTM3U\n#EXTINF:2,\nseg.ts\n', 'without hls=1 the body is untouched (existing behaviour)');
});
