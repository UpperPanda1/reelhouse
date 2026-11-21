// The gateway's network rules against the original extension's host (cloudstream shared/.../net: address-policy.kt,
// safe-http.kt; the BDIX plugin turns allowPrivateNetworks on): private LAN ranges allowed, loopback not, special-use
// ranges never, up to 10 redirects, no https -> http downgrade, POST -> GET drops the body and its headers.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway, classify, loadConfig, addressAllowed, redirectStep } from '../gateway/bdix-gateway.mjs';

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

test('address classes: loopback separate from LAN; special-use ranges the original blocks are never reachable', () => {
  const cases = {
    '127.0.0.1': 'loopback', '127.9.9.9': 'loopback', '::1': 'loopback', '::ffff:7f00:1': 'loopback', '::7f00:1': 'loopback',
    '10.1.2.3': 'private', '172.16.50.12': 'private', '192.168.1.1': 'private', '100.64.0.1': 'private', 'fd00::1': 'private', '::ffff:a00:1': 'private',
    '192.0.0.1': 'never', '192.0.2.1': 'never', '192.88.99.1': 'never', '198.18.0.1': 'never', '198.19.255.1': 'never', '198.51.100.1': 'never', '203.0.113.1': 'never',
    '2001:db8::1': 'never', '2001::1': 'never', '100::1': 'never', '64:ff9b:1::1': 'never', 'fec0::1': 'never',
    '198.20.0.1': null, '2001:4860::8888': null, '8.8.8.8': null, '15.1.1.50': null,
  };
  for (const [ip, want] of Object.entries(cases)) assert.equal(classify(ip), want, ip);
});

test('address policy: by default every private LAN range is allowed (like the original BDIX plugin); loopback only when listed', () => {
  const def = { privateNetworks: true, allowPrivate: new Set() };
  for (const ip of ['10.1.2.3', '172.16.50.7', '192.168.1.1', '100.64.0.1', 'fd00::1', '8.8.8.8']) assert.equal(addressAllowed(def, 'h', ip), true, ip);
  for (const ip of ['127.0.0.1', '::1', '169.254.169.254', '0.0.0.0', '198.51.100.1']) assert.equal(addressAllowed(def, 'h', ip), false, ip);
  assert.equal(addressAllowed({ ...def, allowPrivate: new Set(['127.0.0.1']) }, 'h', '127.0.0.1'), true, 'listed loopback');
  assert.equal(addressAllowed({ ...def, allowPrivate: new Set(['localhost']) }, 'localhost', '127.0.0.1'), true, 'listed by host name');
  assert.equal(addressAllowed({ ...def, allowPrivate: new Set(['169.254.169.254']) }, 'h', '169.254.169.254'), false, 'never stays never');
  const strict = { privateNetworks: false, allowPrivate: new Set(['172.16.50.12']) };
  assert.equal(addressAllowed(strict, 'h', '10.1.2.3'), false);
  assert.equal(addressAllowed(strict, 'h', '172.16.50.12'), true);
});

test('config: PRIVATE_NETWORKS defaults on, "off" turns it off; ALLOW_PRIVATE="" means none (not the defaults)', () => {
  assert.equal(loadConfig({}).privateNetworks, true);
  for (const v of ['off', '0', 'false', 'no', 'OFF']) assert.equal(loadConfig({ PRIVATE_NETWORKS: v }).privateNetworks, false, v);
  assert.equal(loadConfig({ PRIVATE_NETWORKS: 'on' }).privateNetworks, true);
  assert.deepEqual([...loadConfig({}).allowPrivate], ['172.16.50.12', '172.16.50.14']);
  assert.deepEqual([...loadConfig({ ALLOW_PRIVATE: '' }).allowPrivate], []);
  assert.deepEqual([...loadConfig({ ALLOW_PRIVATE: ' 127.0.0.1 , localhost ' }).allowPrivate], ['127.0.0.1', 'localhost']);
});

test('real requests: a LAN address is attempted by default (no 403) and refused with PRIVATE_NETWORKS off', async () => {
  const on = createGateway({ host: '127.0.0.1', token: 't', upstreamTimeoutMs: 300 });
  const off = createGateway({ host: '127.0.0.1', token: 't', upstreamTimeoutMs: 300, privateNetworks: false, allowPrivate: [] });
  const [a, b] = [await listen(on), await listen(off)];
  // the gateway's own refusal is a JSON {error: 'blocked'}; anything else means it tried to connect (what answers then
  // depends on the network: a timeout, "unreachable", or a sandbox's own refusal page)
  const get = (p) => fetch(`http://127.0.0.1:${p}/s?k=t&u=${encodeURIComponent('http://10.255.255.1/x.mkv')}`).then(async (r) => { const t = await r.text(); try { return JSON.parse(t).error || 'other'; } catch { return 'other'; } });
  try {
    assert.notEqual(await get(a), 'blocked', 'allowed: the gateway tried to connect');
    // the default opens the LAN, not this machine: loopback still needs ALLOW_PRIVATE
    for (const u of [`http://127.0.0.1:${a}/health`, `http://localhost:${a}/health`, 'http://[::1]/']) {
      const r = await fetch(`http://127.0.0.1:${a}/s?k=t&u=${encodeURIComponent(u)}`);
      assert.equal(r.status, 403, u); assert.equal((await r.json()).error, 'blocked');
    }
    assert.equal(await get(b), 'blocked');
  } finally { on.close(); off.close(); }
});

test('redirect step: https -> http refused; POST -> GET on 301/302/303 drops body, content-type and content-length; 307/308 keep them', () => {
  const headers = { 'user-agent': 'UA', referer: 'R', 'content-type': 'application/json', 'content-length': '2' };
  assert.throws(() => redirectStep(new URL('https://a.example/x'), 302, 'http://a.example/y', 'GET', undefined, headers), (e) => e.code === 'EDOWNGRADE');
  assert.equal(redirectStep(new URL('http://a.example/x'), 302, 'https://b.example/y', 'GET', undefined, headers).url.href, 'https://b.example/y', 'upgrade is fine');
  for (const code of [301, 302, 303]) {
    const n = redirectStep(new URL('http://a.example/x'), code, '/y', 'POST', Buffer.from('{}'), headers);
    assert.equal(n.method, 'GET'); assert.equal(n.body, undefined);
    assert.deepEqual(n.headers, { 'user-agent': 'UA', referer: 'R' }, String(code));
  }
  for (const code of [307, 308]) {
    const n = redirectStep(new URL('http://a.example/x'), code, '/y', 'POST', Buffer.from('{}'), headers);
    assert.equal(n.method, 'POST'); assert.equal(String(n.body), '{}'); assert.deepEqual(n.headers, headers);
  }
  assert.equal(redirectStep(new URL('http://a.example/x'), 302, '/y', 'GET', undefined, headers).headers, headers, 'GET after 302 unchanged');
  assert.equal(redirectStep(new URL('http://a.example/x'), 303, '/y', 'GET', undefined, headers).headers['content-type'], undefined, '303 always drops it (as the original)');
});

test('real requests: up to 10 redirects are followed (11 fail); a POST redirected with 303 arrives as a clean GET', async () => {
  let last = null;
  const up = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const m = /^\/loop\/(\d+)$/.exec(req.url);
      if (m) { const n = +m[1]; if (n > 0) { res.writeHead(302, { location: `/loop/${n - 1}` }); return res.end(); } res.end('done'); return; }
      if (req.url === '/post') { res.writeHead(303, { location: '/after' }); return res.end(); }
      last = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
      res.end('ok');
    });
  });
  const upPort = await listen(up);
  const gw = createGateway({ host: '127.0.0.1', token: 't', allowPrivate: ['127.0.0.1'], upstreamTimeoutMs: 2000 });
  const gp = await listen(gw);
  const P = (url, method = 'GET', body) => fetch(`http://127.0.0.1:${gp}/p?k=t`, { method: 'POST', body: JSON.stringify({ url, method, headers: { 'Content-Type': 'application/json' }, body }) });
  try {
    const ten = await P(`http://127.0.0.1:${upPort}/loop/10`);
    assert.equal(ten.status, 200); assert.equal(await ten.text(), 'done');
    const eleven = await P(`http://127.0.0.1:${upPort}/loop/11`);
    assert.equal(eleven.status, 502); assert.match(await eleven.text(), /EREDIRECTS/);
    const t0 = Date.now();
    const r = await P(`http://127.0.0.1:${upPort}/post`, 'POST', '{"q":"matrix"}');
    assert.equal(r.status, 200, 'answered, not stuck waiting for a body that never comes');
    assert.ok(Date.now() - t0 < 1500);
    assert.equal(last.method, 'GET'); assert.equal(last.url, '/after'); assert.equal(last.body, '');
    assert.equal(last.headers['content-length'], undefined); assert.equal(last.headers['content-type'], undefined);
  } finally { gw.close(); up.close(); }
});
