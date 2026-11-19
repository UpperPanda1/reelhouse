// Public online sources in a real browser: Fendrix (encrypted API called directly, HLS from a CDN that rejects any
// page Origin) and Hexion (4kHdHub link chain through the edge proxy, file from a *.workers.dev host).
// No real internet: the browser's requests to the provider hosts are answered here; the CDN is a local server.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto, createHash, createHmac } from 'node:crypto';
import { video, waitPlaying, text, hasText } from './helpers.mjs';

const ONLY = (id) => JSON.stringify({ providers: { 'bdix-df': false, 'bdix-cf': false, 'bdix-fh': false, fendrix: id === 'fendrix', hexion: id === 'hexion', mavonyx: id === 'mavonyx' } });

/** Local stand-in for the Fendrix CDN: HLS named .jpg, served as image/jpeg, and 404 for ANY request with an Origin header. */
function startCdn(dir) {
  const log = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://cdn');
    log.push({ path: u.pathname, origin: req.headers.origin || null });
    const file = path.join(dir, path.normalize(u.pathname.replace(/^\/hls\/e2e\//, '')).replace(/^(\.\.[/\\])+/, ''));
    if (req.headers.origin || !u.pathname.startsWith('/hls/e2e/') || !fs.existsSync(file)) { res.writeHead(404, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' }); return res.end('not found/removed\n'); }
    res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'image/jpeg' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${server.address().port}`, log, close: () => server.close() })));
}

async function sealedSession(streams) {
  const key = webcrypto.getRandomValues(new Uint8Array(32));
  const aad = webcrypto.getRandomValues(new Uint8Array(24));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const k = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, k, new TextEncoder().encode(JSON.stringify({ data: { stream: streams }, status: 200 }))));
  const b64 = (u) => Buffer.from(u).toString('base64');
  return { request: webcrypto.getRandomValues(new Uint8Array(40)), sealed: Buffer.from([...iv, ...ct]), session: { status: 200, result: { data: '', state: { responseKey: b64(key), aad: b64(aad) } } } };
}

/** Answers the Fendrix API hosts in the browser: one sealed session whose stream list points at `playlist`. */
async function mockFendrixApi(page, playlist, seen = []) {
  const s = await sealedSession([{ type: 'hls', id: 'primary', playlist, captions: [] }]);
  s.session.result.data = Buffer.from(s.request).toString('base64');
  const cors = { 'access-control-allow-origin': '*' };
  const prev = page.__intercept;
  page.__intercept = (r, u) => {
    if (u.hostname === 'enc-dec.app') { seen.push('enc-dec'); r.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(s.session) }); return true; }
    if (u.hostname === 'api.wing.st') { seen.push('wing'); r.respond({ status: 200, contentType: 'application/octet-stream', headers: cors, body: s.sealed }); return true; }
    if (u.hostname === 'api.shegu.st') { r.respond({ status: 502, contentType: 'text/html', body: 'origin down' }); return true; }
    return prev ? prev(r, u) : false;
  };
  page.__ignoreErrors = /api\.shegu\.st|^Failed to load resource: net::ERR_FAILED$/;
  return seen;
}
/** Answers the MovieBox API hosts (Mavonyx) in the browser, CORS shaped like the live servers (Nov 2026): the Origin is
 *  echoed, preflights allow the requested headers, `expose-headers: *`. Every signed request is checked with node:crypto,
 *  so the step proves what Chromium really sends (unchanged Content-Type/Accept, readable x-user token). */
function mockMavonyxApi(page, { mp4Url, expose = true }) {
  const seen = [];
  const key = Buffer.from(Buffer.from('NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw==', 'base64').toString('latin1'), 'base64');
  const md5 = (x) => createHash('md5').update(x).digest('hex');
  const signed = (r, u) => {
    const h = r.headers();
    const body = r.postData() ?? null;
    const ts = String(h['x-client-token'] || '').split(',')[0];
    const q = u.search ? u.search.slice(1).split('&').map((p, i) => { const [k, v = ''] = p.split('='); return { k, v, i }; }).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i)) : [];
    const canon = [r.method(), h.accept, h['content-type'], body == null ? '' : String(Buffer.byteLength(body)), ts, body == null ? '' : md5(body), u.pathname + (q.length ? '?' + q.map((p) => `${p.k}=${p.v}`).join('&') : '')].join('\n');
    return h['x-client-token'] === `${ts},${md5(ts.split('').reverse().join(''))}` && h['x-tr-signature'] === `${ts}|2|${createHmac('md5', key).update(canon).digest('base64')}`;
  };
  const MB = /^(apig\.inmoviebox\.com|api3\.aoneroom\.com|h5-api\.aoneroom\.com)$/;
  const prev = page.__intercept;
  page.__intercept = (r, u) => {
    if (!MB.test(u.hostname)) return prev ? prev(r, u) : false;
    const origin = r.headers().origin || '*';
    const cors = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', ...(expose ? { 'access-control-expose-headers': '*' } : {}) };
    const json = (status, data, extra = {}) => r.respond({ status, contentType: 'application/json', headers: { ...cors, ...extra }, body: JSON.stringify(data) });
    if (r.method() === 'OPTIONS') {
      seen.push('OPTIONS ' + u.hostname);
      return r.respond({ status: 200, headers: { ...cors, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': r.headers()['access-control-request-headers'] || '', 'access-control-max-age': '86400' }, body: '' }), true;
    }
    const h = r.headers();
    if (u.hostname !== 'h5-api.aoneroom.com') {
      const ok = signed(r, u);
      seen.push(`${r.method()} ${u.pathname} ${ok ? 'signed' : 'BAD-SIGNATURE'} ${h.authorization ? 'auth' : 'no-auth'} ua:${/inmoviebox|mbox|Cronet/.test(h['user-agent'] || '') ? 'spoofed' : 'browser'}`);
      if (!ok) return json(403, { code: 403, message: 'bad signature' }), true;
    } else seen.push(`${r.method()} h5 ${u.pathname} ${h.authorization ? 'auth' : 'no-auth'}`);
    if (u.pathname.endsWith('/tab/ranking-list')) return json(200, { code: 0 }, { 'x-user': JSON.stringify({ token: 'hdr.e2e.sig' }) }), true;
    if (u.hostname === 'api3.aoneroom.com' && h.authorization !== 'Bearer hdr.e2e.sig') return json(401, { code: 401 }), true;
    if (u.pathname.endsWith('/search/v2')) return json(200, { code: 0, data: { results: [{ subjects: [{ subjectId: '603', title: 'The Matrix', releaseDate: '1999-03-31', imdbRatingValue: '8.7', subjectType: 1 }] }] } }), true;
    if (u.pathname.endsWith('/subject-api/get')) return json(200, { code: 0, data: { detailPath: 'the-matrix-x1', dubs: [] } }), true;
    if (u.pathname.endsWith('/play-info')) {
      const cookie = `Edge-Cache-Cookie=urlprefix=${Buffer.from('https://cdn.moviebox.test/dash/603/').toString('base64').replace(/\//g, '_').replace(/\+/g, '-')}:Expires=1:KeyName=k:Signature=s`;
      return json(200, { code: 0, data: { streams: [{ id: 'd1', format: 'DASH', url: 'https://cdn.moviebox.test/raw', resolutions: '2160', signCookie: cookie }] } }), true;
    }
    if (u.pathname.endsWith('/captions') || u.pathname.endsWith('-captions')) return json(200, { code: 0, data: { extCaptions: [] } }), true;
    if (u.pathname === '/wefeed-h5api-bff/subject/play') return json(200, { code: 0, data: { streams: h.authorization ? [{ id: 'w1', url: mp4Url, resolutions: '1080' }] : [] } }), true;
    return json(404, {}), true;
  };
  return seen;
}
/** Make Chromium report no built-in HLS, like Firefox (the app and the player both decide by canPlayType). */
const withoutNativeHls = (page) => page.evaluateOnNewDocument(() => {
  const orig = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function (t) { return /mpegurl/i.test(t) ? '' : orig.call(this, t); };
});

export async function steps4(ctx) {
  const { step, assert, b, bdix, app, open, waitFor, shot, MEDIA_DIR, startGateway } = ctx;

  await step('fendrix: encrypted lookup straight from the browser (even with a gateway set); HLS from a CDN that refuses page origins plays through built-in HLS', async () => {
    const cdn = await startCdn(path.join(MEDIA_DIR, 'hls'));
    const s = await sealedSession([{ type: 'hls', id: 'primary', playlist: cdn.base + '/hls/e2e/master.m3u8', captions: [] }]);
    s.session.result.data = Buffer.from(s.request).toString('base64');
    const seen = [];
    const page = await b.newPage({ width: 1280, height: 800, label: 'fendrix' });
    // like the live fallback endpoint (530 without CORS headers), api.shegu.st fails here; Chrome logs that, nothing else
    page.__ignoreErrors = /api\.shegu\.st|^Failed to load resource: net::ERR_FAILED$/;
    const cors = { 'access-control-allow-origin': '*' };
    page.__intercept = (r, u) => {
      if (u.hostname === 'enc-dec.app') { seen.push(`GET enc-dec ${new URL(u.searchParams.get('url')).searchParams.get('server')}`); r.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(s.session) }); return true; }
      if (u.hostname === 'api.wing.st') { seen.push(`${r.method()} wing ${r.headers()['content-type'] || 'no content-type'}`); r.respond({ status: 200, contentType: 'application/octet-stream', headers: cors, body: s.sealed }); return true; }
      if (u.hostname === 'api.shegu.st') { r.respond({ status: 502, contentType: 'text/html', body: 'origin down' }); return true; } // live answers 530; CDP cannot send that code
      if (u.hostname === '127.0.0.1' && u.port === '8787') { seen.push('GATEWAY ' + u.pathname); r.abort(); return true; }
      return false;
    };
    try {
      await open(page, '#/movie/603');
      await waitFor(() => page.$('.dinfo h1'), { what: 'details' });
      // a gateway is configured, yet Fendrix must not use it (its API and CDN are public and send CORS headers)
      await page.evaluate((st) => localStorage.setItem('rh:settings', st), JSON.stringify({ ...JSON.parse(ONLY('fendrix')), gatewayUrl: 'http://127.0.0.1:8787' }));
      bdix.log.length = 0;
      await page.evaluate(() => { location.hash = '#/watch/movie/603'; });
      await waitPlaying(page, 1.0);
      const v = await video(page, (v) => ({ src: v.currentSrc, w: v.videoWidth, audio: v.webkitAudioDecodedByteCount }));
      // the provider's own read of the master carries an Origin and is refused (as by the real CDN), so the master
      // itself is offered and the built-in HLS player picks the variant
      assert.equal(v.src, cdn.base + '/hls/e2e/master.m3u8', 'master playlist, played straight from the CDN');
      assert.equal(v.w, 640); assert.ok(v.audio > 0, 'sound is decoded');
      assert.ok(seen.includes('GET enc-dec Nebula') && seen.includes('GET enc-dec Secret'), 'both servers asked');
      assert.ok(seen.includes('POST wing no content-type'), 'binary POST without Content-Type (CORS simple request)');
      assert.ok(!seen.some((x) => x.startsWith('GATEWAY')), 'never routed through the gateway');
      assert.equal(bdix.log.length, 0);
      const withOrigin = cdn.log.filter((l) => l.origin);
      assert.ok(withOrigin.length >= 1 && withOrigin.every((l) => l.path === '/hls/e2e/master.m3u8'), 'only the lookup\u2019s master read carried an Origin (and got 404)');
      const media = cdn.log.filter((l) => l.path.includes('/1080p/'));
      assert.ok(media.length >= 2 && media.every((l) => l.origin === null), 'built-in HLS requests carry no Origin, so the CDN serves them');
      // the reason an in-page player (hls.js) cannot be used: page requests always send Origin
      assert.equal(await page.evaluate((u) => fetch(u).then((r) => r.status), cdn.base + '/hls/e2e/master.m3u8'), 404);
      // the source list shows the provider and its server
      await page.evaluate(() => [...document.querySelectorAll('.toolrow .btn')].find((x) => /Sources/.test(x.textContent)).click());
      await waitFor(() => page.$('dialog.sheet .ticket'), { what: 'tickets' });
      assert.equal(await text(page, 'dialog.sheet .ticket .from'), 'Fendrix (Nebula)');
      assert.equal(await text(page, 'dialog.sheet .ticket .name'), 'The Matrix (1999)', 'named after the title, not "master.m3u8"');
      assert.ok(await hasText(page, 'dialog.sheet .pstat .chip', /^Fendrix: 1 found$/));
      await shot(page, 'fendrix-sources');
      assert.deepEqual(await b.cspViolations(page), []);
    } finally { await page.close(); cdn.close(); }
  });

  await step('fendrix without built-in HLS (Firefox-like): flagged with the gateway hint; with a gateway it plays through hls.js, playlists rewritten', async () => {
    const cdn = await startCdn(path.join(MEDIA_DIR, 'hls'));
    const gw = await startGateway({ origin: app.origin });
    const page = await b.newPage({ width: 1280, height: 800, label: 'fendrix-nohls', setup: withoutNativeHls });
    try {
      await mockFendrixApi(page, cdn.base + '/hls/e2e/master.m3u8');
      await open(page, '#/movie/603');
      await waitFor(() => page.$('.dinfo h1'), { what: 'details' });
      assert.equal(await page.evaluate(() => document.createElement('video').canPlayType('application/vnd.apple.mpegurl')), '', 'no built-in HLS in this page');
      // 1) no gateway: the source is honestly marked and the reason names the way out
      await page.evaluate((st) => localStorage.setItem('rh:settings', st), ONLY('fendrix'));
      await page.evaluate(() => [...document.querySelectorAll('button')].find((x) => /Download/.test(x.textContent)).click());
      await waitFor(() => page.$('dialog.sheet .ticket'), { what: 'tickets' });
      assert.equal(await page.$eval('dialog.sheet .ticket', (e) => e.dataset.level), 'bad');
      assert.match(await text(page, 'dialog.sheet .ticket .why'), /through the gateway/);
      await page.keyboard.press('Escape');
      // 2) with a gateway: plays in the page through hls.js; every CDN request comes from the gateway without an Origin
      await page.evaluate((st) => localStorage.setItem('rh:settings', st), JSON.stringify({ ...JSON.parse(ONLY('fendrix')), gatewayUrl: gw.url, gatewayToken: gw.token }));
      cdn.log.length = 0;
      await page.evaluate(() => { location.hash = '#/watch/movie/603'; });
      await waitPlaying(page, 1.5);
      const v = await video(page, (v) => ({ src: v.currentSrc, w: v.videoWidth, audio: v.webkitAudioDecodedByteCount }));
      assert.match(v.src, /^blob:/, 'Media Source playback (hls.js), not <video src>');
      assert.equal(v.w, 640); assert.ok(v.audio > 0, 'sound is decoded');
      assert.ok(cdn.log.some((l) => l.path === '/hls/e2e/1080p/playlist.jpg') && cdn.log.filter((l) => /playlist_\d+\.jpg$/.test(l.path)).length >= 1, 'variant playlist and segments fetched');
      // only the lookup's own read of the master carries an Origin (refused, as by the real CDN); playback never does
      assert.ok(cdn.log.filter((l) => l.origin).every((l) => l.path === '/hls/e2e/master.m3u8'), JSON.stringify(cdn.log));
      assert.ok(cdn.log.filter((l) => l.path !== '/hls/e2e/master.m3u8').every((l) => l.origin === null), 'variant and segments fetched without an Origin');
      assert.ok(cdn.log.some((l) => l.path === '/hls/e2e/master.m3u8' && l.origin === null), 'the master itself came through the gateway');
      const loaded = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));
      assert.ok(loaded.some((n) => /\/vendor\/hls/.test(n)), 'hls.js was loaded');
      assert.ok(loaded.some((n) => n.startsWith(gw.url + '/s?') && n.includes('hls=1')), 'playlists requested through the gateway with hls=1');
      assert.deepEqual([...new Set(loaded.filter((n) => n.startsWith(cdn.base)))], [cdn.base + '/hls/e2e/master.m3u8'], 'the page touched the CDN only for the lookup\u2019s master read');
      assert.equal(await page.$$eval('.banner', (e) => e.length), 0, 'no error banner');
      await shot(page, 'fendrix-firefox-gateway');
      assert.deepEqual(await b.cspViolations(page), []);
    } finally { await page.close(); cdn.close(); gw.close(); }
  });

  await step('fendrix without built-in HLS and no gateway: the watch page gives up fast and explains, instead of spinning forever', async () => {
    // Reported bug (Nov 2026): "Fendrix: 1 found" but playback never starts. Without built-in HLS the player falls back
    // to hls.js; its requests carry an Origin, the CDN answers 404, and nothing reported it (no media error event, and
    // the 25 s watchdog was only armed after the first `canplay`, which never came).
    const cdn = await startCdn(path.join(MEDIA_DIR, 'hls'));
    const page = await b.newPage({ width: 1280, height: 800, label: 'fendrix-nohls-nogw', setup: withoutNativeHls });
    try {
      await mockFendrixApi(page, cdn.base + '/hls/e2e/master.m3u8');
      page.__ignoreErrors = /api\.shegu\.st|Failed to load resource|CORS policy/; // hls.js reads the CDN and is refused, as live
      await open(page, '#/movie/603');
      await waitFor(() => page.$('.dinfo h1'), { what: 'details' });
      await page.evaluate((st) => localStorage.setItem('rh:settings', st), ONLY('fendrix'));
      const t0 = Date.now();
      await page.evaluate(() => { location.hash = '#/watch/movie/603'; });
      await waitFor(() => page.$('.watch .banner'), { timeout: 12000, what: 'an explanation banner (not an endless spinner)' });
      assert.ok(Date.now() - t0 < 12000);
      const banner = await text(page, '.watch .banner');
      assert.match(banner, /will not play here/);
      assert.match(banner, /built-in HLS|gateway/, 'the banner names the reason and the way out: ' + banner);
      assert.ok(await page.$('.watch .banner a[href^="data:audio/x-mpegurl"]'), 'external player (.m3u) offered');
      // the player itself stops spinning and says so (the banner can be below the fold on a desktop screen)
      await waitFor(() => page.$('.stage .rh-fail'), { what: 'message in the player' });
      assert.match(await text(page, '.stage .rh-fail'), /will not play here/);
      assert.equal(await page.$eval('.art-loading', (e) => getComputedStyle(e).display), 'none', 'no endless spinner');
      await shot(page, 'fendrix-nohls-explained');
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow at phone width');
      await shot(page, 'fendrix-nohls-explained-phone');
      assert.deepEqual(await b.cspViolations(page), []);
    } finally { await page.close(); cdn.close(); }
  });

  await step('hexion: 4kHdHub chain via the edge proxy (wrapper -> HubCloud -> file page), size shown, file plays from its host', async () => {
    const mp4 = fs.readFileSync(path.join(MEDIA_DIR, 'test.mp4'));
    const page = await b.newPage({ width: 1280, height: 800, label: 'hexion' });
    await page.setCacheEnabled(false); // edge-proxy replies are cacheable (max-age=60); earlier steps asked the same URLs
    app.sources.hexion = true;
    const fileHits = [];
    page.__intercept = (r, u) => {
      if (u.hostname === 'e2e-media.workers.dev') { fileHits.push(u.pathname); r.respond({ status: 200, contentType: 'video/mp4', headers: { 'access-control-allow-origin': '*', 'accept-ranges': 'none' }, body: mp4 }); return true; }
      return false;
    };
    try {
      await open(page, '#/movie/603');
      await waitFor(() => page.$('.dinfo h1'), { what: 'details' });
      await page.evaluate((st) => localStorage.setItem('rh:settings', st), ONLY('hexion'));
      app.mockLog.length = 0;
      await page.evaluate(() => [...document.querySelectorAll('button')].find((x) => /Download/.test(x.textContent)).click());
      await waitFor(() => page.$('dialog.sheet .ticket'), { what: 'tickets' });
      const t = await page.$$eval('dialog.sheet .ticket', (els) => els.map((e) => ({ from: e.querySelector('.from').textContent, name: e.querySelector('.name').textContent, tags: [...e.querySelectorAll('.tag')].map((x) => x.textContent) })));
      assert.equal(t.length, 1, 'the pixel.hubcloud interstitial link is not offered');
      assert.equal(t[0].from, 'Hexion (FSL)'); assert.equal(t[0].name, 'The.Matrix.1999.1080p.WEB-DL.x264.AAC.mp4');
      assert.ok(t[0].tags.includes('1.4 GB') && t[0].tags.includes('Recommended'), JSON.stringify(t[0].tags));
      for (const host of ['4khdhub.one/', 'greenmotors.club/', 'hubcloud.mov/drive/m1', 'gamerxyt.com/hubcloud.php']) assert.ok(app.mockLog.some((l) => l.startsWith(host)), `${host} fetched through the edge proxy`);
      assert.equal(fileHits.length, 0, 'nothing downloaded during lookup');
      await shot(page, 'hexion-download');
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 }); // no isMobile: toggling it reloads the page and closes the sheet
      await waitFor(() => page.$('dialog.sheet[open] .ticket'), { what: 'sheet still open at phone width' });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow at phone width');
      await shot(page, 'hexion-download-phone');
      await page.setViewport({ width: 1280, height: 800 });
      await page.keyboard.press('Escape');
      await page.evaluate(() => { location.hash = '#/watch/movie/603'; });
      await waitPlaying(page, 1.0);
      assert.equal(await video(page, (v) => v.currentSrc), 'https://e2e-media.workers.dev/files/The.Matrix.1999.1080p.WEB-DL.x264.AAC.mp4', 'played straight from the file host');
      assert.deepEqual(await b.cspViolations(page), []);
    } finally { app.sources.hexion = false; await page.close(); }
  });

  await step('hexion blocked at the edge (the site refuses Cloudflare): the chip says "needs gateway" and the notice explains it', async () => {
    const page = await b.newPage({ width: 1280, height: 900, label: 'hexion-blocked' });
    await page.setCacheEnabled(false);
    page.__ignoreErrors = /Failed to load resource: the server responded with a status of 403/;
    app.sources.hexion = 'blocked';
    try {
      await open(page, '#/movie/603');
      await waitFor(() => page.$('.dinfo h1'), { what: 'details' });
      await page.evaluate((st) => localStorage.setItem('rh:settings', st), ONLY('hexion'));
      await page.evaluate(() => { location.hash = '#/watch/movie/603'; });
      await waitFor(() => page.$('.stage .notice'), { what: 'guidance' });
      assert.ok(await hasText(page, '.stage .pstat .chip', /^Hexion: needs gateway$/), 'not a vague "server error"');
      assert.match(await text(page, '.stage .notice'), /refuse.*edge|gateway/i);
      assert.ok(await hasText(page, '.stage .notice li', /gateway/));
      await shot(page, 'hexion-blocked');
      assert.deepEqual(await b.cspViolations(page), []);
    } finally { app.sources.hexion = false; await page.close(); }
  });

  await step('mavonyx: signed MovieBox lookup straight from the browser (preflight, readable token header), web MP4 plays, DASH ranked unplayable', async () => {
    const page = await b.newPage({ width: 1280, height: 800, label: 'mavonyx' });
    const seen = mockMavonyxApi(page, { mp4Url: bdix.base + '/media/test.mp4' });
    const prev = page.__intercept;
    page.__intercept = (r, u) => (u.hostname === '127.0.0.1' && u.port === '8787' ? (seen.push('GATEWAY ' + u.pathname), r.abort(), true) : prev(r, u));
    try {
      await open(page, '#/movie/603');
      await waitFor(() => page.$('.dinfo h1'), { what: 'details' });
      // a gateway is configured, yet Mavonyx must not use it (the API sends CORS headers and is region-gated by IP)
      await page.evaluate((st) => localStorage.setItem('rh:settings', st), JSON.stringify({ ...JSON.parse(ONLY('mavonyx')), gatewayUrl: 'http://127.0.0.1:8787' }));
      bdix.log.length = 0;
      await page.evaluate(() => { location.hash = '#/watch/movie/603'; });
      await waitPlaying(page, 1.0);
      const v = await video(page, (v) => ({ src: v.currentSrc, w: v.videoWidth, audio: v.webkitAudioDecodedByteCount }));
      assert.equal(v.src, bdix.base + '/media/test.mp4', 'the web API’s MP4, played straight from its host');
      assert.equal(v.w, 640); assert.ok(v.audio > 0, 'sound is decoded');
      assert.ok(!seen.some((x) => /BAD-SIGNATURE/.test(x)), 'Chromium sent every signed request unchanged: ' + seen.join(' | '));
      assert.ok(seen.includes('POST /wefeed-mobile-bff/subject-api/search/v2 signed auth ua:browser'), 'search signed, with the token read from the x-user response header');
      assert.ok(seen.includes('GET h5 /wefeed-h5api-bff/subject/play auth'), 'web API called with the token');
      assert.ok(seen.includes('OPTIONS api3.aoneroom.com') && seen.includes('OPTIONS apig.inmoviebox.com'), 'CORS preflights were made, and answered here (not by the internet)');
      assert.ok(!seen.some((x) => x.startsWith('GATEWAY')), 'never routed through the gateway');
      assert.ok(!bdix.log.some((r) => r.method === 'POST' || r.path.startsWith('/api/')), 'no BDIX lookups (only the media file)');
      await page.evaluate(() => [...document.querySelectorAll('button')].find((x) => /Sources/.test(x.textContent)).click());
      await waitFor(() => page.$('dialog.sheet[open] .ticket'), { what: 'tickets' });
      assert.equal(await text(page, 'dialog.sheet .pstat .chip[data-provider="mavonyx"]'), 'Mavonyx: 2 found');
      const t = await page.$$eval('dialog.sheet .ticket', (els) => els.map((e) => ({ name: e.querySelector('.name').textContent, level: e.dataset.level, text: e.textContent })));
      assert.equal(t.length, 2);
      assert.equal(t[0].level, 'ok'); assert.match(t[0].text, /1080p/);
      assert.equal(t[1].level, 'bad', 'the 2160p DASH stream ranks last'); assert.match(t[1].text, /DASH/);
      await shot(page, 'mavonyx-sources');
      assert.deepEqual(await b.cspViolations(page), []);
    } finally { await page.close(); }
    // control: without `expose-headers` the browser hides x-user, the API refuses the unauthenticated calls, nothing is found
    const page2 = await b.newPage({ width: 390, height: 844, touch: true, label: 'mavonyx-hidden-token' });
    page2.__expectErrors = true;
    const seen2 = mockMavonyxApi(page2, { mp4Url: bdix.base + '/media/test.mp4', expose: false });
    try {
      await open(page2, '#/movie/603');
      await waitFor(() => page2.$('.dinfo h1'), { what: 'details' });
      await page2.evaluate((st) => localStorage.setItem('rh:settings', st), ONLY('mavonyx'));
      await page2.evaluate(() => { location.hash = '#/watch/movie/603'; });
      await waitFor(() => page2.$('.pstat .chip[data-provider="mavonyx"]:not([data-state="start"])'), { what: 'mavonyx chip' });
      assert.equal(await text(page2, '.pstat .chip[data-provider="mavonyx"]'), 'Mavonyx: no match'); // the token request itself succeeded
      assert.ok(seen2.some((x) => /search\/v2 signed no-auth/.test(x)), 'token not readable, so sent without it: ' + seen2.join(' | '));
      await shot(page2, 'mavonyx-hidden-token-phone');
    } finally { await page2.close(); }
  });

  await step('online sources down + BDIX down: guidance names the BDIX problem and mentions the online sources', async () => {
    const page = await b.newPage({ width: 1280, height: 900, label: 'public-down' });
    page.__expectErrors = true;
    page.__intercept = (r, u) => (u.hostname === 'enc-dec.app' || /aoneroom\.com$|inmoviebox\.com$/.test(u.hostname) ? (r.abort('internetdisconnected'), true) : false); // Fendrix and Mavonyx unreachable
    try {
      await open(page, '#/movie/603');
      await waitFor(() => page.$('.dinfo h1'), { what: 'details' });
      await page.evaluate(() => localStorage.setItem('rh:settings', JSON.stringify({ providers: { 'bdix-fh': false, hexion: false } })));
      bdix.state.down = true;
      await page.evaluate(() => [...document.querySelectorAll('button')].find((x) => /Download/.test(x.textContent)).click());
      await waitFor(() => page.$('dialog.sheet .notice'), { what: 'guidance' });
      assert.deepEqual(await page.$$eval('.pstat .chip', (e) => e.map((x) => x.textContent)), ['DhakaFlix: unreachable', 'Circle FTP: unreachable', 'FlixHub: off', 'Fendrix: unreachable', 'Hexion: off', 'Mavonyx: unreachable']);
      assert.match(await text(page, 'dialog.sheet .notice h3'), /Could not reach the BDIX servers/);
      assert.ok(await hasText(page, 'dialog.sheet .notice li', /BDIX-connected network/));
      assert.ok(await hasText(page, 'dialog.sheet .notice li', /online sources did not answer either/));
    } finally { bdix.state.down = false; await page.close(); }
  });
}
