// Shared helpers for the end-to-end run: a mock BDIX server on a real socket, the dev server with mocked upstreams,
// and a Chromium launcher that records console errors and Content-Security-Policy violations.
import { createD1 } from '../dev/d1-sqlite.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { createDevServer } from '../dev/server.mjs';
import { createMockFetch, placeholderSvg } from '../dev/mock-upstream.mjs';
import { createGateway } from '../gateway/bdix-gateway.mjs';

export const MEDIA_DIR = process.env.E2E_MEDIA || new URL('./media/', import.meta.url).pathname; // generate with: npm run e2e:media
export const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
fs.mkdirSync(SHOTS, { recursive: true });

const listen = (srv, host = '127.0.0.1') => new Promise((r) => srv.listen(0, host, () => r(srv.address().port)));

// File names (as DhakaFlix would list them) -> real test media with the codec behaviour in the name
const MATRIX = [
  ['English Movies/The Matrix (1999)/The.Matrix.1999.2160p.UHD.BluRay.HDR10.x265.10bit.AAC.Atmos.mkv', 'test_hevc.mp4'],
  ['English Movies/The Matrix (1999)/The.Matrix.1999.1080p.BluRay.x264.DDP5.1.mkv', 'test_ac3.mkv'],
  ['English Movies/The Matrix (1999)/The.Matrix.1999.1080p.WEB-DL.x264.AAC.mp4', 'test.mp4'],
  ['English Movies/The Matrix (1999)/The.Matrix.1999.720p.WEB-DL.x264.AAC.mov', 'test.mov'],
  ['English Movies/The Matrix (1999)/The.Matrix.1999.720p.WEB-DL.x264.AAC.mkv', 'test.mkv'],
];
const BB = [
  ['TV-WEB-SERIES/Breaking Bad/Season 1/Breaking.Bad.S01E02.720p.WEB-DL.x264.AAC.mp4', 'test_long.mp4'],
  ['TV-WEB-SERIES/Breaking Bad/Season 1/Breaking.Bad.S01E03.720p.WEB-DL.x264.AAC.mp4', 'test_long.mp4'],
];
const CONTENT_TYPES = { '.mp4': 'video/mp4', '.mov': 'application/octet-stream', '.mkv': 'application/octet-stream', '.webm': 'video/webm' };

/** One server that speaks DhakaFlix (/DHAKA-FLIX-12|14/), the Circle FTP API (/api/posts), FlixHub watch pages (/watch/...)
 * and serves media with Range support. All three are BDIX servers, so the browser (or the gateway) talks to them. */
export function createBdixMock({ cors = true } = {}) {
  const log = [];
  const state = { cors, down: false };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const url = new URL(req.url, 'http://x');
      log.push({ method: req.method, path: url.pathname + url.search, headers: req.headers, body });
      if (state.down) { req.socket.destroy(); return; }
      const h = { 'cache-control': 'no-store' };
      if (state.cors) Object.assign(h, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'content-range,content-length,accept-ranges' });
      if (req.method === 'OPTIONS') { res.writeHead(204, h); return res.end(); }
      const send = (status, data, type = 'application/json') => { res.writeHead(status, { ...h, 'content-type': type }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };

      if (req.method === 'POST' && /^\/DHAKA-FLIX-1[24]\/$/.test(url.pathname)) {
        let pattern = ''; try { pattern = JSON.parse(body).search.pattern; } catch { return send(400, {}); }
        const root = url.pathname;
        const norm = pattern.replace(/\\ /g, ' ').replace(/\./g, ' ').toLowerCase();
        const list = norm === 'the matrix' ? MATRIX : norm === 'breaking bad' ? BB : [];
        // list only under the first variant + first server so results are not duplicated
        if (pattern.includes('\\') && root.endsWith('12/')) return send(200, { search: list.map(([p]) => ({ href: `/DHAKA-FLIX-12/${encodeURI(p)}` })) });
        return send(200, { search: [] });
      }
      if (req.method === 'GET' && url.pathname === '/api/posts') {
        return send(200, url.searchParams.get('searchTerm') === 'The Matrix' ? { posts: [{ id: 11, type: 'singleVideo', title: 'The Matrix (1999) 1080p', name: 'The Matrix', categories: [] }] } : { posts: [] });
      }
      if (req.method === 'GET' && url.pathname === '/watch/movie/the-matrix') return send(200, `<html><body><video id="theaterPlayer" data-stream-url="http://127.0.0.1:${srv.address().port}/media/test.mp4"></video></body></html>`, 'text/html');
      if (req.method === 'GET' && url.pathname === '/api/posts/11') return send(200, { post: { type: 'singleVideo', title: 'The Matrix (1999) 1080p', content: `http://127.0.0.1:${srv.address().port}/media/test.mp4` } });
      if (req.method === 'GET' && url.pathname === '/') return send(200, 'ok', 'text/plain');

      // media files
      let file = null;
      const decoded = decodeURIComponent(url.pathname);
      if (decoded.startsWith('/media/')) file = path.join(MEDIA_DIR, path.basename(decoded));
      else for (const [p, f] of [...MATRIX, ...BB]) if (decoded.endsWith(p.split('/').pop())) file = path.join(MEDIA_DIR, f);
      if (file && fs.existsSync(file)) {
        const st = fs.statSync(file); const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
        let s = 0; let e = st.size - 1;
        if (m) { if (m[1]) s = Number(m[1]); if (m[2]) e = Number(m[2]); }
        res.writeHead(m ? 206 : 200, { ...h, 'content-type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream', 'accept-ranges': 'bytes', 'content-length': e - s + 1, ...(m ? { 'content-range': `bytes ${s}-${e}/${st.size}` } : {}) });
        return fs.createReadStream(file, { start: s, end: e }).pipe(res);
      }
      send(404, { error: 'nf' });
    });
  });
  return { srv, log, state, listen: async () => (state.port = await listen(srv)), close: () => srv.close(), get base() { return `http://127.0.0.1:${state.port}`; } };
}

export const E2E_ADMIN = { username: 'owner', password: 'e2e admin passphrase' };
export async function startApp({ env = { TMDB_API_KEY: 'test-key' }, bdix, accounts = true } = {}) {
  const mockLog = [];
  // accounts: an in-memory database and a first admin (dev/d1-sqlite.mjs stands in for Cloudflare D1)
  if (accounts && !env.DB) env = { ...env, DB: createD1(), ADMIN_USERNAME: E2E_ADMIN.username, ADMIN_PASSWORD: E2E_ADMIN.password, PBKDF2_ITERATIONS: '10000' };
  const sources = { hexion: false }; // the Hexion step switches its mock site on; other steps see "not on that site"
  const dev = createDevServer({ env, fetchImpl: createMockFetch({ mediaBase: bdix ? bdix.base : 'http://127.0.0.1:1', log: mockLog, sources }) });
  const port = await listen(dev);
  return { dev, port, origin: `http://127.0.0.1:${port}`, mockLog, sources, close: () => dev.close() };
}

export async function startGateway({ origin, token = 'tok', allowPrivate = ['127.0.0.1'] }) {
  const gw = createGateway({ host: '127.0.0.1', token, allowPrivate, origins: [origin] });
  const port = await listen(gw);
  return { gw, url: `http://127.0.0.1:${port}`, token, close: () => gw.close() };
}

/** Hosts the browser contacts directly for Fendrix (and Hexion's file hosts); aborted unless a step mocks them. */
export const PUBLIC_SOURCE_HOSTS = /^(enc-dec\.app|.*\.aoneroom\.com|.*\.inmoviebox\.com|themoviebox\.xyz|api\.wing\.st|api\.shegu\.st|api\.shegu\.xyz|.*\.workers\.dev|.*\.r2\.dev|.*\.r2\.cloudflarestorage\.com|pixeldrain\.com)$/;

export async function launch() {
  // @sparticuz/chromium ships Lambda-oriented flags that switch browser security OFF (CORS, mixed content, site isolation).
  // A test run with those flags would not behave like a user's browser, so they are removed.
  // --single-process is also unlike a user's browser, and it cannot open a second profile (used as a second device).
  const RELAXED = /^--(disable-web-security|allow-running-insecure-content|disable-site-isolation-trials|single-process|disable-features=.*(IsolateOrigins|site-per-process).*)$/;
  const args = chromium.args.filter((a) => !RELAXED.test(a));
  const browser = await puppeteer.launch({ args: [...args, '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'], executablePath: await chromium.executablePath(), headless: 'shell' });
  const problems = [];
  /** `context`: a separate browser profile (own cookies and storage), i.e. a second device. */
  async function newPage({ width = 1280, height = 800, touch = false, label = 'page', setup, context } = {}) {
    const page = await (context || browser).newPage();
    await page.setViewport({ width, height, deviceScaleFactor: touch ? 2 : 1, isMobile: touch, hasTouch: touch });
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const u = new URL(r.url());
      // a step may answer requests itself (public-source mocks); everything else below is the default
      if (page.__intercept && page.__intercept(r, u)) return;
      // the browser calls these public sources directly; never let a test reach the real internet.
      // Fendrix's session broker answers "no session" (a valid reply: no console noise), anything else is cut off.
      if (u.hostname === 'enc-dec.app') return r.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"status":404,"error":"not found"}' });
      if (u.hostname === 'api.wing.st') return r.respond({ status: 404, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'not found' }); // Settings -> Test connection
      // Mavonyx (MovieBox API): CORS like the live servers, an empty catalogue (a valid reply: "no match")
      if (/^(apig\.inmoviebox\.com|api3\.aoneroom\.com|h5-api\.aoneroom\.com)$/.test(u.hostname)) {
        const rh = r.headers();
        return r.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': rh.origin || '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': rh['access-control-request-headers'] || '', 'access-control-expose-headers': '*' }, body: r.method() === 'OPTIONS' ? '' : '{"code":0,"data":{"results":[],"streams":[]}}' });
      }
      if (PUBLIC_SOURCE_HOSTS.test(u.hostname)) return r.abort('internetdisconnected');
      if (u.hostname === 'image.tmdb.org') {
        return r.respond({ status: 200, contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' }, body: placeholderSvg('/' + u.pathname.split('/').pop().replace(/\.\w+$/, '')) });
      }
      if (u.hostname === 'www.youtube.com') return r.abort();
      r.continue();
    });
    page.on('console', (m) => {
      const t = m.text();
      if (page.__expectErrors) return; // failure-injection steps deliberately provoke network/CORS errors
      if (page.__ignoreErrors && page.__ignoreErrors.test(t)) return; // a step names the exact errors it expects
      if (m.type() === 'error' && !/Failed to load resource.*(404|5\d\d)/.test(t)) problems.push(`[${label}] console.error: ${t}`);
    });
    page.on('pageerror', (e) => problems.push(`[${label}] pageerror: ${e.message}`));
    await page.evaluateOnNewDocument(() => {
      window.__csp = [];
      addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI}`));
    });
    if (setup) await setup(page);
    page.label = label;
    return page;
  }
  async function cspViolations(page) { return page.evaluate(() => window.__csp || []); }
  return { browser, newPage, problems, cspViolations, newDevice: () => browser.createBrowserContext(), close: () => browser.close() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(fn, { timeout = 15000, interval = 100, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(interval); }
  throw new Error(`Timed out waiting for ${what}${last instanceof Error ? ': ' + last.message : ''}`);
}
export const shot = async (page, name) => { const f = path.join(SHOTS, name + '.png'); await page.screenshot({ path: f }); return f; };
/** Point the provider modules at the mock BDIX server (same module instances the app uses). */
export async function repointProviders(page, base) {
  await page.evaluate(async (b) => {
    const df = await import('/js/providers/df.js'); const cf = await import('/js/providers/cf.js'); const fh = await import('/js/providers/fh.js');
    df.SERVERS[0].url = b; df.SERVERS[1].url = b; cf.endpoints.primary = b; cf.endpoints.fallback = b; fh.endpoints.base = b;
  }, base);
}
