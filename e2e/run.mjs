// End-to-end suite: drives real Chromium against the real app, dev server (same API router as the Cloudflare Function),
// a mock BDIX server on a real socket, and (later steps) the real gateway.   npm run e2e
import assert from 'node:assert/strict';
import { startApp, startGateway, createBdixMock, launch, shot, waitFor, sleep, repointProviders, MEDIA_DIR } from './lib.mjs';
import { steps2 } from './steps2.mjs';
import { steps4 } from './steps4.mjs';
import { steps5 } from './steps5.mjs';

const only = process.argv[2];
const results = [];
export async function step(name, fn) {
  if (only && !name.toLowerCase().includes(only.toLowerCase())) return;
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`\u2714 ${name} (${Date.now() - t0}ms)`); } catch (e) { results.push({ name, ok: false, err: e }); console.log(`\u2716 ${name}\n    ${String(e.message).split('\n').slice(0, 4).join('\n    ')}\n    at ${String(e.stack).split('\n').find((l) => /e2e\//.test(l) && !/node:/.test(l)) || ''}`); }
}

const bdix = createBdixMock(); await bdix.listen();
const app = await startApp({ bdix });
const b = await launch();
const ctx = { bdix, app, b, step, assert, shot, waitFor, sleep, repointProviders, startGateway, startApp, createBdixMock, MEDIA_DIR, results };

/** Open a route; the first call for a page loads the app and points the providers at the mock BDIX server. */
const loaded = new WeakSet();
export async function open(page, hash = '') {
  if (!loaded.has(page)) {
    await page.goto(app.origin + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#main');
    await repointProviders(page, bdix.base);
    loaded.add(page);
    if (hash) await page.evaluate((h) => { location.hash = h; }, hash);
  } else await page.evaluate((h) => { location.hash = h || '#/'; }, hash);
}
ctx.open = open;
ctx.reload = async (page) => { await page.reload({ waitUntil: 'domcontentloaded' }); await repointProviders(page, bdix.base); };
const q = (page, sel) => page.$eval(sel, (e) => e.textContent.trim());

try {
  // ---------------------------------------------------------------- home + responsive layout
  await step('home: hero + 5 rails render, nothing queried on BDIX servers', async () => {
    const page = await b.newPage({ width: 1280, height: 800, label: 'home' });
    await open(page, '#/');
    await waitFor(() => page.$('.rail .card'), { what: 'rails' });
    const m = await page.evaluate(() => ({ rails: [...document.querySelectorAll('.rail h2')].map((h) => h.textContent), hero: document.querySelector('.hero h1')?.textContent, persons: document.querySelectorAll('.card.person').length }));
    assert.deepEqual(m.rails, ['Trending today', 'Popular movies', 'Popular series', 'Top rated movies', 'Top rated series']);
    assert.ok(m.hero && m.hero.length > 2); assert.equal(m.persons, 0);
    assert.equal(bdix.log.length, 0, 'no BDIX request before the user clicks Play/Download');
    assert.ok(!app.mockLog.some((l) => l.includes('4khdhub') || l.includes('flixhub')), 'edge proxy not used before a click');
    assert.deepEqual(await b.cspViolations(page), []);
    await page.close();
  });

  for (const [label, w, h, touch] of [['phone', 390, 844, true], ['tablet', 820, 1180, true], ['desktop', 1440, 900, false]]) {
    await step(`layout @${label} ${w}px: nav mode, no overflow, poster density, hero above fold`, async () => {
      const page = await b.newPage({ width: w, height: h, touch, label });
      await open(page, '#/');
      await waitFor(() => page.$('.rail .card'), { what: 'rails' });
      await sleep(300);
      const m = await page.evaluate(() => {
        const vis = (e) => e && getComputedStyle(e).display !== 'none';
        const first = [...document.querySelectorAll('.rail')].find((r) => r.querySelector('.card'));
        const cards = [...first.querySelectorAll('.card')];
        const inView = cards.filter((c) => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 2; }).length;
        const rail = first.getBoundingClientRect();
        return { tabbar: vis(document.getElementById('tabbar')), nav: vis(document.querySelector('.nav')), search: vis(document.querySelector('.searchbox')), overflow: document.documentElement.scrollWidth - innerWidth, inView, railTop: Math.round(rail.top), vh: innerHeight, cardW: Math.round(cards[0].getBoundingClientRect().width) };
      });
      assert.equal(m.overflow, 0, 'horizontal overflow');
      assert.equal(m.tabbar, w < 768, 'bottom tab bar only on phones'); assert.equal(m.nav, w >= 768); assert.equal(m.search, w >= 768);
      assert.ok(m.railTop < m.vh - 40, `first rail should peek above the fold (top ${m.railTop} of ${m.vh})`);
      if (w < 560) assert.ok(m.inView >= 2 && m.inView <= 3, `phone shows 2-3 whole posters, saw ${m.inView}`);
      if (w >= 1280) assert.ok(m.inView >= 6, `desktop shows 6+ posters, saw ${m.inView}`);
      assert.ok(m.cardW >= 90, 'poster width is tappable');
      await shot(page, `home-${label}`);
      await page.close();
    });
  }

  // ---------------------------------------------------------------- search
  await step('search: desktop top bar searches live; no-results state; phone has its own field', async () => {
    const page = await b.newPage({ width: 1280, height: 800, label: 'search' });
    await open(page, '#/');
    await page.waitForSelector('.searchbox input');
    await page.type('.searchbox input', 'orchard');
    await waitFor(async () => (await page.evaluate(() => location.hash)).startsWith('#/search?q=orchard'), { what: 'search route' });
    await waitFor(() => page.$('.grid .card'), { what: 'results' });
    const titles = await page.$$eval('.grid .card .t', (els) => els.map((e) => e.textContent));
    assert.ok(titles.length >= 2 && titles.every((t) => /orchard/i.test(t)), titles.join(' | '));
    assert.equal(await page.$eval('.mobile-only', (e) => getComputedStyle(e).display), 'none', 'in-page search field hidden on desktop');
    await shot(page, 'search-desktop');
    await page.evaluate(() => { location.hash = '#/search?q=zzzzqqq'; });
    await waitFor(async () => /No matches/.test(await q(page, '#main')), { what: 'empty state' });
    await page.close();
    const phone = await b.newPage({ width: 390, height: 844, touch: true, label: 'search-phone' });
    await open(phone, '#/search');
    await phone.waitForSelector('.mobile-only input');
    assert.notEqual(await phone.$eval('.mobile-only', (e) => getComputedStyle(e).display), 'none');
    await phone.close();
  });

  // ---------------------------------------------------------------- details
  await step('movie details: data from TMDB, actions present, still NO BDIX traffic; My List persists across reload', async () => {
    const page = await b.newPage({ width: 1280, height: 800, label: 'movie' });
    await open(page, '#/');
    await waitFor(() => page.$('a.card[href="#/movie/603"]'), { what: 'matrix card' });
    await page.click('a.card[href="#/movie/603"]');
    await waitFor(() => page.$('.dinfo h1'), { what: 'details' });
    assert.equal(await q(page, '.dinfo h1'), 'The Matrix');
    const chips = await page.$$eval('.dinfo .chip', (e) => e.map((x) => x.textContent.trim()));
    assert.ok(chips.includes('2h 16m') && chips.includes('1999') && chips.includes('Drama'), chips.join(','));
    assert.equal(await page.$$eval('.rail[data-rail=cast] .card.person', (e) => e.length), 14);
    assert.ok((await page.$$eval('.rail[data-rail=recs] .card', (e) => e.length)) >= 10);
    const actions = await page.$$eval('.dinfo .actions > *', (e) => e.map((x) => (x.textContent || x.getAttribute('aria-label')).trim()));
    assert.ok(actions.includes('Play') && actions.includes('Download') && actions.includes('Trailer') && actions.includes('Save to a list'), actions.join('|'));
    assert.equal(await page.$eval('a[href^="https://www.youtube.com"]', (a) => a.rel), 'noopener noreferrer');
    assert.equal(bdix.log.length, 0, 'details page must not query BDIX');
    await shot(page, 'details-movie-desktop');
    await page.click('button[aria-label="Save to a list"]');
    await page.waitForSelector('dialog.sheet[open] .row input[type=checkbox]');
    await page.click('dialog.sheet .row input[type=checkbox]'); // My List
    await page.keyboard.press('Escape');
    await waitFor(() => page.$('.dinfo .iconbtn.on[aria-label="Saved to a list: change lists"]'), { what: 'saved state' });
    await ctx.reload(page);
    await waitFor(() => page.$('.dinfo h1'), { what: 'details after reload' });
    assert.ok(await page.$('.dinfo .iconbtn.on'), 'saved state persisted');
    await open(page, '#/list');
    await waitFor(() => page.$('.grid .card'), { what: 'list grid' });
    assert.equal(await page.$eval('.grid .card .t', (e) => e.textContent), 'The Matrix');
    await page.close();
  });

  await step('series details: seasons (specials hidden), episodes per season, per-episode play+download, no BDIX traffic', async () => {
    const page = await b.newPage({ width: 1280, height: 900, label: 'tv' });
    await open(page, '#/tv/1396');
    await waitFor(() => page.$('.ep'), { what: 'episodes' });
    assert.deepEqual(await page.$$eval('select[aria-label=Season] option', (o) => o.map((x) => x.textContent)), ['Season 1', 'Season 2']);
    assert.equal(await page.$$eval('.ep', (e) => e.length), 7);
    assert.equal(await page.$eval('.ep h3', (e) => e.textContent), '1. Pilot');
    const noStill = await page.$$eval('.ep .still', (s) => s.filter((x) => !x.querySelector('img')).length);
    assert.ok(noStill >= 1, 'episode without still renders without crashing');
    assert.equal(await page.$$eval('.ep .acts .iconbtn', (e) => e.length), 14);
    await shot(page, 'details-tv-desktop');
    await page.select('select[aria-label=Season]', '2');
    await waitFor(async () => (await page.$$eval('.ep', (e) => e.length)) === 13, { what: 'season 2 episodes' });
    assert.ok((await page.evaluate(() => location.hash)).includes('s=2'), 'season kept in URL');
    assert.equal(bdix.log.length, 0);
    assert.equal(await page.$eval('.dinfo .actions a.btn.primary', (e) => e.getAttribute('href')), '#/watch/tv/1396/1/1');
    await page.close();
  });

  // ---------------------------------------------------------------- download sheet (first BDIX lookup, on click)
  await step('download: BDIX queried only after the click, 4 parallel DhakaFlix POSTs, ranked tickets with warnings', async () => {
    const page = await b.newPage({ width: 1280, height: 900, label: 'download' });
    await page.evaluateOnNewDocument(() => { window.__clip = null; });
    await open(page, '#/movie/603');
    await waitFor(() => page.$('.dinfo h1'), { what: 'details' });
    await page.evaluate(() => { navigator.clipboard.writeText = async (t) => { window.__clip = t; }; });
    bdix.log.length = 0; app.mockLog.length = 0;
    await sleep(500);
    assert.equal(bdix.log.length, 0);
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /Download/.test(b.textContent)).click());
    await page.waitForSelector('dialog.sheet[open]');
    await waitFor(() => page.$('.ticket'), { what: 'tickets' });
    const posts = bdix.log.filter((r) => r.method === 'POST');
    assert.equal(posts.length, 4, '2 patterns x 2 servers, in parallel');
    assert.ok(posts.every((r) => r.headers['content-type'] === 'application/json'));
    assert.deepEqual(posts.map((p) => JSON.parse(p.body).search.pattern).sort(), ['The.Matrix', 'The.Matrix', 'The\\ Matrix', 'The\\ Matrix']);
    assert.ok(bdix.log.some((r) => r.path.startsWith('/api/posts?searchTerm=The%20Matrix')), 'Circle search');
    assert.ok(bdix.log.some((r) => r.path === '/watch/movie/the-matrix'), 'FlixHub (a BDIX server) fetched by the browser');
    assert.ok(!app.mockLog.some((l) => l.includes('flixhub')), 'FlixHub never through the Cloudflare edge proxy');
    const chips = await page.$$eval('.pstat .chip', (e) => e.map((x) => x.textContent));
    assert.deepEqual(chips, ['DhakaFlix: 5 found', 'Circle FTP: 1 found', 'FlixHub: 1 found', 'Fendrix: no match', 'Hexion: no match', 'Mavonyx: no match'], 'online sources are asked too (in this test none has the title)');
    const t = await page.$$eval('.ticket', (els) => els.map((e) => ({ name: e.querySelector('.name').textContent, q: e.querySelector('.stub b').textContent, level: e.dataset.level, tags: [...e.querySelectorAll('.tag')].map((x) => x.textContent) })));
    assert.equal(t.length, 6, 'Circle and FlixHub return the same file URL in this mock; identical URLs are de-duplicated into one ticket');
    assert.ok(t[0].name.endsWith('1080p.WEB-DL.x264.AAC.mp4') && t[0].level === 'ok', 'best playable source first: ' + t[0].name);
    assert.equal(t[t.length - 1].level, 'bad'); assert.ok(/2160p.*x265/.test(t[t.length - 1].name), 'HEVC ranked last');
    assert.ok(t[t.length - 1].tags.includes('Unlikely to play here'));
    const ddp = t.find((x) => /DDP5\.1/.test(x.name)); assert.equal(ddp.level, 'warn'); assert.ok(ddp.tags.includes('May lack audio'));
    const mov = t.find((x) => /\.mov$/.test(x.name)); assert.ok(mov && mov.level === 'ok', '.mov listed and playable');
    await shot(page, 'download-sheet-desktop');
    // actions
    const dl = await page.$eval('.ticket .btn.primary', (a) => ({ href: a.href, download: a.getAttribute('download'), target: a.target, rel: a.rel }));
    assert.equal(dl.href, `${bdix.base}/DHAKA-FLIX-12/English%20Movies/The%20Matrix%20(1999)/The.Matrix.1999.1080p.WEB-DL.x264.AAC.mp4`);
    assert.equal(dl.download, 'The.Matrix.1999.1080p.WEB-DL.x264.AAC.mp4'); assert.equal(dl.target, '_blank'); assert.equal(dl.rel, 'noopener noreferrer');
    await page.click('.ticket .btn.ghost');
    const menuOpen = await page.$eval('.ticket .menu', (m) => !m.hidden); assert.ok(menuOpen);
    await page.evaluate(() => [...document.querySelectorAll('.ticket .menu button')].find((b) => /Copy link/.test(b.textContent)).click());
    await waitFor(async () => /Link copied/.test(await q(page, '#toasts')), { what: 'copy toast' });
    assert.equal(await page.evaluate(() => window.__clip), dl.href, 'Clipboard API path');
    // plain-http pages have no navigator.clipboard: the execCommand fallback must still copy
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); window.__legacy = null; document.execCommand = (c) => { const ta = document.activeElement; window.__legacy = c === 'copy' && ta && ta.tagName === 'TEXTAREA' ? ta.value : null; return true; }; });
    await page.evaluate(() => [...document.querySelectorAll('.ticket .menu button')].find((b) => /Copy link/.test(b.textContent)).click());
    await waitFor(() => page.evaluate(() => window.__legacy), { what: 'legacy copy' });
    assert.equal(await page.evaluate(() => window.__legacy), dl.href, 'execCommand fallback path');
    const m3u = await page.$eval('.ticket .menu a[download$=".m3u"]', (a) => decodeURIComponent(a.href.split(',').slice(1).join(',')));
    assert.equal(m3u, `#EXTM3U\n#EXTINF:-1,The Matrix (1999)\n${dl.href}\n`);
    await page.keyboard.press('Escape');
    await waitFor(async () => !(await page.$('dialog.sheet')), { what: 'sheet closed' });
    assert.deepEqual(await b.cspViolations(page), []);
    await page.close();
  });

  await steps2(ctx);
  await steps4(ctx);
  await steps5(ctx);
} finally {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  if (b.problems.length) console.log('Browser console/page errors:\n  ' + b.problems.join('\n  '));
  await b.close(); app.close(); bdix.close();
  process.exitCode = failed.length || b.problems.length ? 1 : 0;
}
