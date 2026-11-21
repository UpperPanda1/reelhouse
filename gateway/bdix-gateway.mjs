#!/usr/bin/env node
// RafTV BDIX gateway: run it on a machine that can reach your BDIX servers (your PC, a Raspberry Pi, a VPS in Bangladesh).
// It fixes the four things a browser cannot do by itself: set Referer/User-Agent, get CORS headers from servers that
// do not send them, avoid HTTPS->HTTP mixed content (when served from localhost or with TLS), and force real downloads.
//
//   POST /p   JSON envelope {url, method, headers, body}  -> small text/JSON/HTML responses (provider lookups)
//   GET  /s   ?u=<url>&h=<b64url json headers>&n=<filename>&dl=1&k=<token>  -> streamed media with Range support
//             &hls=1: if the body is an HLS playlist (sniffed: CDNs serve them under any name and type), every URI in it
//             is rewritten to come back through /s with the same token and headers, so players work without CORS/Origin
//   GET  /health
//
// Zero dependencies, Node >= 20. Configuration is by environment variables (see README).
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import fs from 'node:fs';
import { pipeline } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const DEFAULT_ALLOW_PRIVATE = ['172.16.50.12', '172.16.50.14']; // DhakaFlix, same as the CloudStream extension
export const DEFAULT_REFERERS = { 'new.circleftp.net': 'http://new.circleftp.net/', '15.1.1.50': 'http://new.circleftp.net/', 'flixhub.net': 'https://flixhub.net/', 'www.flixhub.net': 'https://flixhub.net/' };
const MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo', ts: 'video/mp2t', m3u8: 'application/vnd.apple.mpegurl', mpd: 'application/dash+xml', srt: 'text/plain', vtt: 'text/vtt' };
const FORWARD_FROM_CLIENT_ENVELOPE = new Set(['user-agent', 'referer', 'accept', 'accept-language', 'content-type']);

// ---------------- address policy ----------------
function ip4ToInt(ip) { return ip.split('.').reduce((a, b) => (a * 256 + Number(b)) >>> 0, 0); }
const inCidr = (ip, base, bits) => { const m = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0; return (ip4ToInt(ip) & m) === (ip4ToInt(base) & m); };
function ip6ToBytes(ip) {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%'); if (zone >= 0) s = s.slice(0, zone);
  const tail4 = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail4) { const b = tail4.slice(1).map(Number); s = s.slice(0, -tail4[0].length) + ((b[0] << 8) | b[1]).toString(16) + ':' + ((b[2] << 8) | b[3]).toString(16); }
  const [head, rest] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = rest ? rest.split(':') : [];
  const groups = rest === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => { const v = parseInt(g || '0', 16); bytes[i * 2] = v >> 8; bytes[i * 2 + 1] = v & 255; });
  return bytes;
}
const v4FromBytes = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;

/** 'never' = can never be allowlisted, 'private' = only reachable if explicitly allowlisted, null = public. */
export function classify(ip) {
  if (net.isIPv6(ip)) {
    const b = ip6ToBytes(ip);
    const zeros = (from, to) => { for (let i = from; i < to; i++) if (b[i] !== 0) return false; return true; };
    if (zeros(0, 16)) return 'never';                                   // ::
    if (zeros(0, 15) && b[15] === 1) return 'private';                  // ::1 loopback
    if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return classify(v4FromBytes(b, 12));  // ::ffff:a.b.c.d (any textual form)
    if (zeros(0, 12)) return classify(v4FromBytes(b, 12));              // deprecated IPv4-compatible
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return classify(v4FromBytes(b, 12)); // NAT64 64:ff9b::/96
    if (b[0] === 0x20 && b[1] === 0x02) return classify(v4FromBytes(b, 2)); // 6to4 2002::/16 embeds an IPv4 address
    if ((b[0] & 0xfe) === 0xfc) return 'private';                       // fc00::/7
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'never';        // fe80::/10 link-local
    if (b[0] === 0xff) return 'never';                                  // multicast
    return null;
  }
  if (!net.isIPv4(ip)) return 'never';
  if (inCidr(ip, '0.0.0.0', 8) || inCidr(ip, '169.254.0.0', 16) || inCidr(ip, '224.0.0.0', 4) || inCidr(ip, '240.0.0.0', 4)) return 'never';
  if (inCidr(ip, '127.0.0.0', 8) || inCidr(ip, '10.0.0.0', 8) || inCidr(ip, '172.16.0.0', 12) || inCidr(ip, '192.168.0.0', 16) || inCidr(ip, '100.64.0.0', 10)) return 'private';
  return null;
}

function makeLookup(cfg) {
  // Validates the address actually used to connect (defeats DNS rebinding) and returns it.
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    const finish = (addr, family) => (options.all ? cb(null, [{ address: addr, family }]) : cb(null, addr, family));
    const check = (addr, family) => {
      const c = classify(addr);
      if (c === 'never') return cb(Object.assign(new Error('address blocked'), { code: 'EBLOCKED' }));
      if (c === 'private' && !cfg.allowPrivate.has(hostname) && !cfg.allowPrivate.has(addr)) return cb(Object.assign(new Error('private address not allowlisted'), { code: 'EBLOCKED' }));
      finish(addr, family);
    };
    if (net.isIP(hostname)) return check(hostname, net.isIPv6(hostname) ? 6 : 4);
    dns.lookup(hostname, { all: false }, (err, addr, family) => (err ? cb(err) : check(addr, family)));
  };
}

// ---------------- upstream fetch (manual redirects, vetted lookup) ----------------
function requestOnce(cfg, url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method, headers, lookup: makeLookup(cfg), timeout: cfg.upstreamTimeoutMs, signal }, resolve);
    req.on('timeout', () => req.destroy(Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(body || undefined);
  });
}

export async function fetchUpstream(cfg, rawUrl, init, hops = 5) {
  let url = new URL(rawUrl);
  let { method } = init; let body = init.body;
  for (let i = 0; i <= hops; i++) {
    validateUrl(cfg, url);
    const res = await requestOnce(cfg, url, { ...init, method, body });
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      url = new URL(res.headers.location, url);
      if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
      continue;
    }
    res.finalUrl = url.toString();
    return res;
  }
  throw Object.assign(new Error('too many redirects'), { code: 'EREDIRECTS' });
}

function validateUrl(cfg, url) {
  if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('only http(s) is allowed'), { code: 'EBADURL' });
  if (url.username || url.password) throw Object.assign(new Error('credentials in URL are not allowed'), { code: 'EBADURL' });
  // Node does not call `lookup` for IP-literal hosts, so literals (incl. 2130706433 / 0x7f.1 forms, which URL normalises) are vetted here.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    const c = classify(host);
    if (c === 'never' || (c === 'private' && !cfg.allowPrivate.has(host))) throw Object.assign(new Error('address blocked'), { code: 'EBLOCKED' });
  }
}

// ---------------- HLS playlists ----------------
/**
 * Rewrites every URI of an HLS playlist (segment/variant lines and URI="..." attributes) to a relative `s?u=...` link,
 * which resolves against the playlist's own gateway URL. Non-http(s) URIs (data:, skd:) are left alone.
 * `params` (k, h) are carried over so child requests are authorised and keep their headers.
 */
export function rewritePlaylist(text, baseUrl, params = {}) {
  const wrap = (uri) => {
    let abs;
    try { abs = new URL(uri.trim(), baseUrl); } catch { return uri; }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return uri;
    const p = new URLSearchParams({ u: abs.toString() });
    for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
    p.set('hls', '1');
    return 's?' + p;
  };
  return String(text).split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return '';
    if (t.startsWith('#')) return t.replace(/URI="([^"]*)"/g, (m, u) => `URI="${wrap(u)}"`);
    return wrap(t);
  }).join('\n');
}

/** Reads at least `n` bytes (or to the end) without consuming them: the caller unshifts them back. */
async function readPrefix(stream, n) {
  const chunks = []; let len = 0;
  while (len < n) {
    const c = stream.read();
    if (c) { chunks.push(c); len += c.length; continue; }
    if (stream.readableEnded || stream.destroyed) break;
    await new Promise((resolve, reject) => {
      const done = () => { stream.off('readable', done); stream.off('end', done); stream.off('close', done); stream.off('error', fail); resolve(); };
      const fail = (e) => { done(); reject(e); };
      stream.on('readable', done); stream.on('end', done); stream.on('close', done); stream.on('error', fail);
    });
  }
  return Buffer.concat(chunks);
}
const isPlaylist = (buf) => /^\uFEFF?\s*#EXTM3U/.test(buf.toString('utf8'));

// ---------------- server ----------------
export function loadConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1';
  const cfg = {
    host,
    port: Number(env.PORT || 8787),
    token: env.GATEWAY_TOKEN || '',
    origins: String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    allowPrivate: new Set((env.ALLOW_PRIVATE ? env.ALLOW_PRIVATE.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ALLOW_PRIVATE)),
    referers: { ...DEFAULT_REFERERS },
    upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS || 20000),
    maxEnvelopeBytes: 1_000_000,
    maxTextResponseBytes: 8_000_000,
    tls: env.TLS_KEY && env.TLS_CERT ? { key: fs.readFileSync(env.TLS_KEY), cert: fs.readFileSync(env.TLS_CERT) } : null,
  };
  return cfg;
}

const isLoopback = (h) => h === '127.0.0.1' || h === '::1' || h === 'localhost';

export function createGateway(userCfg = {}) {
  const cfg = { ...loadConfig({}), ...userCfg };
  cfg.allowPrivate = userCfg.allowPrivate instanceof Set ? userCfg.allowPrivate : new Set(userCfg.allowPrivate || DEFAULT_ALLOW_PRIVATE);
  if (!isLoopback(cfg.host) && !cfg.token) throw new Error('Refusing to listen on a non-loopback address without GATEWAY_TOKEN (it would be an open proxy on your network).');

  const corsHeaders = (req) => {
    const origin = req.headers.origin;
    const h = { vary: 'Origin', 'access-control-expose-headers': 'content-range, content-length, accept-ranges, content-type, x-up-url, x-up-status' };
    if (!origin) return h;
    if (!cfg.origins.length || cfg.origins.includes(origin)) h['access-control-allow-origin'] = cfg.origins.length ? origin : '*';
    return h;
  };
  const send = (req, res, status, body, extra = {}) => {
    res.writeHead(status, { ...corsHeaders(req), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
    res.end(body);
  };
  const sendJson = (req, res, status, obj) => send(req, res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' });
  const authed = (req, url) => {
    if (!cfg.token) return true;
    const given = String(url.searchParams.get('k') || req.headers['x-rh-token'] || '');
    const a = Buffer.from(given); const b = Buffer.from(cfg.token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const upstreamError = (req, res, e) => {
    if (e.code === 'EBLOCKED') return sendJson(req, res, 403, { error: 'blocked', message: e.message });
    if (e.code === 'EBADURL') return sendJson(req, res, 400, { error: 'bad_url', message: e.message });
    if (e.code === 'ETIMEDOUT') return sendJson(req, res, 504, { error: 'upstream_timeout' });
    return sendJson(req, res, 502, { error: 'upstream_error', message: e.code || 'unreachable' });
  };
  const upstreamHeaders = (target, fromClient, range) => {
    const h = { 'user-agent': CHROME_UA };
    for (const [k, v] of Object.entries(fromClient || {})) if (FORWARD_FROM_CLIENT_ENVELOPE.has(k.toLowerCase()) && typeof v === 'string' && !/[\r\n]/.test(v)) h[k.toLowerCase()] = v;
    if (!h.referer && cfg.referers[target.hostname]) h.referer = cfg.referers[target.hostname];
    if (range) h.range = range;
    return h;
  };
  const guessType = (upType, pathname) => {
    if (upType && !/^(application\/octet-stream|binary\/octet-stream|text\/plain)/i.test(upType)) return upType;
    const ext = pathname.split('.').pop().toLowerCase();
    return MIME[ext] || upType || 'application/octet-stream';
  };

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://gateway.local');
    try {
      if (req.method === 'OPTIONS') {
        const h = { ...corsHeaders(req), 'access-control-allow-methods': 'GET, POST, HEAD, OPTIONS', 'access-control-allow-headers': 'range, content-type, x-rh-token', 'access-control-max-age': '600' };
        if (req.headers['access-control-request-private-network']) h['access-control-allow-private-network'] = 'true';
        res.writeHead(204, h); return res.end();
      }
      if (url.pathname === '/health') return sendJson(req, res, 200, { ok: true, name: 'raftv-gateway', auth: !!cfg.token });
      if (!authed(req, url)) return sendJson(req, res, 401, { error: 'unauthorized' });

      if (url.pathname === '/p' && req.method === 'POST') {
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > cfg.maxEnvelopeBytes) return sendJson(req, res, 413, { error: 'envelope_too_large' }); chunks.push(c); }
        let env;
        try { env = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return sendJson(req, res, 400, { error: 'bad_envelope' }); }
        const method = String(env.method || 'GET').toUpperCase();
        if (!['GET', 'POST', 'HEAD'].includes(method)) return sendJson(req, res, 400, { error: 'bad_method' });
        let target; try { target = new URL(String(env.url)); } catch { return sendJson(req, res, 400, { error: 'bad_url' }); }
        const body = typeof env.body === 'string' && method === 'POST' ? Buffer.from(env.body) : undefined;
        const headers = upstreamHeaders(target, env.headers);
        if (body) headers['content-length'] = String(body.length);
        const ac = new AbortController(); res.on('close', () => ac.abort());
        let up;
        try { up = await fetchUpstream(cfg, target.toString(), { method, headers, body, signal: ac.signal }); } catch (e) { return upstreamError(req, res, e); }
        const parts = []; let n = 0;
        for await (const c of up) { n += c.length; if (n > cfg.maxTextResponseBytes) { up.destroy(); return sendJson(req, res, 502, { error: 'response_too_large' }); } parts.push(c); }
        return send(req, res, up.statusCode, Buffer.concat(parts), { 'content-type': up.headers['content-type'] || 'application/octet-stream', 'x-up-url': up.finalUrl, 'x-up-status': String(up.statusCode) });
      }

      if (url.pathname === '/s' && (req.method === 'GET' || req.method === 'HEAD')) {
        let target; try { target = new URL(url.searchParams.get('u') || ''); } catch { return sendJson(req, res, 400, { error: 'bad_url' }); }
        let extra = {};
        const hParam = url.searchParams.get('h');
        if (hParam) { try { extra = JSON.parse(Buffer.from(hParam, 'base64url').toString('utf8')); } catch { return sendJson(req, res, 400, { error: 'bad_headers' }); } }
        const ac = new AbortController(); res.on('close', () => ac.abort());
        let up;
        try { up = await fetchUpstream(cfg, target.toString(), { method: req.method, headers: upstreamHeaders(target, extra, req.headers.range), signal: ac.signal }); } catch (e) { return upstreamError(req, res, e); }
        if (url.searchParams.get('hls') === '1' && req.method === 'GET' && !req.headers.range && up.statusCode === 200) {
          const head = await readPrefix(up, 64);
          if (isPlaylist(head)) {
            const parts = [head]; let n = head.length;
            for await (const c of up) { n += c.length; parts.push(c); if (n > cfg.maxTextResponseBytes) break; }
            if (n > cfg.maxTextResponseBytes) { up.destroy(); return sendJson(req, res, 502, { error: 'response_too_large' }); } // also when it all came in the first chunk
            const carry = { k: url.searchParams.get('k') || '', h: hParam || '' };
            const body = Buffer.from(rewritePlaylist(Buffer.concat(parts).toString('utf8'), up.finalUrl, carry), 'utf8');
            return send(req, res, 200, body, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': String(body.length) });
          }
          if (head.length) up.unshift(head); // not a playlist (a segment): stream it unchanged below
        }
        const out = { ...corsHeaders(req), 'x-content-type-options': 'nosniff', 'accept-ranges': up.headers['accept-ranges'] || 'bytes', 'content-type': guessType(up.headers['content-type'], new URL(up.finalUrl).pathname), 'cache-control': 'no-store' };
        for (const k of ['content-length', 'content-range', 'etag', 'last-modified']) if (up.headers[k]) out[k] = up.headers[k];
        if (url.searchParams.get('dl') === '1') {
          const name = String(url.searchParams.get('n') || decodeURIComponent(new URL(up.finalUrl).pathname.split('/').pop() || 'video')).replace(/[\r\n"\\/\0]/g, '_').slice(0, 180);
          out['content-disposition'] = `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
        }
        res.writeHead(up.statusCode, out);
        if (req.method === 'HEAD') { up.destroy(); return res.end(); }
        return pipeline(up, res, () => {});
      }
      return sendJson(req, res, 404, { error: 'not_found' });
    } catch (e) {
      if (!res.headersSent) sendJson(req, res, 500, { error: 'internal_error' }); else res.destroy();
    }
  };
  const server = cfg.tls ? https.createServer(cfg.tls, handler) : http.createServer(handler);
  server.cfg = cfg;
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const cfg = loadConfig();
  let server;
  try { server = createGateway(cfg); } catch (e) { console.error(e.message); process.exit(1); }
  server.listen(cfg.port, cfg.host, () => {
    console.log(`RafTV gateway listening on ${cfg.tls ? 'https' : 'http'}://${cfg.host}:${cfg.port}`);
    console.log(`  auth token : ${cfg.token ? 'required' : 'none (loopback only)'}`);
    console.log(`  allow-list : private hosts ${[...cfg.allowPrivate].join(', ') || '(none)'}`);
    console.log(`  origins    : ${cfg.origins.join(', ') || '* (any)'}`);
  });
}
