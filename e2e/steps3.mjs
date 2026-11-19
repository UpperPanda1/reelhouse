import { video, currentFile, waitPlaying, text, hasText, clickByText } from './helpers.mjs';

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36';
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export async function steps3(ctx) {
  const { step, assert, b, bdix, app, open, waitFor, sleep, shot, startGateway, startApp } = ctx;

  const openSettings = async (page) => {
    await page.evaluate(() => document.querySelector('button[aria-label="Settings"]').click());
    await page.waitForSelector('dialog.sheet[open] .set-group');
  };
  const openDownload = async (page) => {
    await clickByText(page, 'button', /Download/);
    await page.waitForSelector('dialog.sheet[open]');
    await waitFor(() => page.$('.ticket, .notice'), { timeout: 40000, what: 'tickets or guidance' });
  };
  const rowToggle = (page, label) => page.evaluate((l) => { const row = [...document.querySelectorAll('dialog.sheet .row')].find((r) => r.textContent.includes(l)); row.querySelector('input[type=checkbox]').click(); }, label);
  const diagnosis = async (page) => {
    await waitFor(() => page.$$eval('.diag > div', (r) => r.length >= 5 && r.every((x) => x.dataset.state)), { timeout: 45000, what: 'connection diagnosis' });
    return Object.fromEntries(await page.$$eval('.diag > div', (r) => r.map((x) => [x.dataset.host, x.dataset.state])));
  };

  await step('gateway: lookups, playback and downloads all go through the real gateway (UA injected, Range streamed, token enforced)', async () => {
    const gw = await startGateway({ origin: app.origin });
    const page = await b.newPage({ width: 1280, height: 900, label: 'gateway' });
    try {
      await open(page, '#/movie/603');
      // with a gateway, FlixHub (BDIX) and Hexion lookups go through it, and the gateway may reach public hosts:
      // point them at the local mock so this step never touches the real internet
      await page.evaluate(async (base) => { (await import('/js/providers/fh.js')).endpoints.base = base; (await import('/js/providers/hx.js')).endpoints.base = base; }, bdix.base);
      await waitFor(() => page.$('.dinfo h1'), { what: 'details' });
      await openSettings(page);
      await page.type('input[aria-label="Gateway address"]', gw.url);
      await page.type('input[aria-label="Gateway token"]', gw.token);
      await clickByText(page, 'dialog.sheet .btn', /^Save$/);
      await clickByText(page, 'dialog.sheet .btn', /Test connection/);
      const diag = await diagnosis(page);
      assert.equal(diag['Gateway'], 'ok'); assert.equal(diag['DhakaFlix 12'], 'ok'); assert.equal(diag['DhakaFlix 14'], 'ok'); assert.equal(diag['Circle FTP'], 'ok');
      await shot(page, 'settings-connection');
      await page.keyboard.press('Escape');
      bdix.log.length = 0;
      await page.click('.dinfo .btn.primary');
      await waitPlaying(page, 1.0, 40000);
      const src = await video(page, (v) => v.currentSrc);
      assert.ok(src.startsWith(gw.url + '/s?u='), 'media is streamed through the gateway: ' + src.slice(0, 80));
      assert.equal(await currentFile(page), 'The.Matrix.1999.1080p.WEB-DL.x264.AAC.mp4');
      const posts = bdix.log.filter((r) => r.method === 'POST');
      assert.equal(posts.length, 4);
      assert.ok(posts.every((r) => /Chrome\/151/.test(r.headers['user-agent']) && !/Headless/.test(r.headers['user-agent'])), 'gateway sets the extension\u2019s User-Agent (browsers cannot)');
      assert.ok(posts.every((r) => !r.headers.origin), 'upstream sees no browser Origin');
      assert.ok(bdix.log.some((r) => r.method === 'GET' && r.path.includes('The.Matrix.1999.1080p.WEB-DL') && r.headers.range), 'Range requests were proxied');
      await clickByText(page, '.toolrow .btn', /Download/);
      await page.waitForSelector('dialog.sheet[open] .ticket');
      const href = await page.$eval('dialog.sheet .ticket .btn', (a) => a.href);
      assert.ok(href.startsWith(gw.url + '/s?') && href.includes('dl=1') && href.includes('k=' + gw.token));
      const r = await fetch(href, { headers: { range: 'bytes=0-99' } });
      assert.equal(r.status, 206); assert.match(r.headers.get('content-disposition'), /^attachment; filename="The\.Matrix\.1999\.1080p\.WEB-DL\.x264\.AAC\.mp4"/);
      assert.equal((await r.arrayBuffer()).byteLength, 100);
      assert.equal((await fetch(href.replace('k=' + gw.token, 'k=wrong'))).status, 401);
    } finally { await page.evaluate(() => localStorage.removeItem('rh:settings')).catch(() => {}); await page.close(); gw.close(); }
  });

  await step('failure UX (direct mode): unreachable servers explain what to do; CORS-less servers are diagnosed; no-sources page', async () => {
    const page = await b.newPage({ width: 1280, height: 900, label: 'failures' });
    page.__expectErrors = true;
    try {
      await open(page, '#/movie/603');
      await waitFor(() => page.$('.dinfo h1'), { what: 'details' });
      await page.evaluate(() => localStorage.setItem('rh:settings', JSON.stringify({ providers: { 'bdix-fh': false, fendrix: false, hexion: false, mavonyx: false } })));
      bdix.state.down = true;
      await openDownload(page);
      assert.deepEqual(await page.$$eval('.pstat .chip', (e) => e.map((x) => x.textContent)), ['DhakaFlix: unreachable', 'Circle FTP: unreachable', 'FlixHub: off', 'Fendrix: off', 'Hexion: off', 'Mavonyx: off']);
      assert.match(await text(page, 'dialog.sheet .notice h3'), /Could not reach the BDIX servers/);
      assert.ok(await hasText(page, 'dialog.sheet .notice li', /BDIX-connected network/));
      await shot(page, 'guidance-unreachable');
      await clickByText(page, 'dialog.sheet .notice .btn', /Connection settings/);
      await waitFor(() => hasText(page, 'dialog.sheet h3', /Connection to BDIX servers/), { what: 'settings opened from the guidance' });
      await ctx.reload(page);
      await open(page, '#/watch/movie/603');
      await waitFor(() => hasText(page, '.stage h2', /No sources found/), { timeout: 40000, what: 'no sources state' });
      assert.equal(await page.$$eval('.art-video-player', (e) => e.length), 0);
      bdix.state.down = false; bdix.state.cors = false;
      await open(page, '#/movie/603');
      await waitFor(() => page.$('.dinfo h1'), { what: 'details' });
      await openSettings(page);
      await clickByText(page, 'dialog.sheet .btn', /Test connection/);
      const diag = await diagnosis(page);
      assert.equal(diag['DhakaFlix 12'], 'cors', 'reachable-but-unreadable is reported as CORS, not as unreachable');
      assert.equal(diag['Circle FTP'], 'cors');
      assert.ok((await page.$$eval('.diag > div', (r) => r.map((x) => x.textContent))).some((t) => /CORS/.test(t)));
    } finally { bdix.state.down = false; bdix.state.cors = true; await page.evaluate(() => localStorage.removeItem('rh:settings')).catch(() => {}); await page.close(); }
  });

  await step('settings: toggles change real behaviour (compat hides .mov, provider off skips requests, ranking preference), persist, reset', async () => {
    const page = await b.newPage({ width: 1280, height: 900, label: 'settings' });
    try {
      await open(page, '#/movie/603');
      await waitFor(() => page.$('.dinfo h1'), { what: 'details' });
      await openSettings(page);
      await rowToggle(page, 'Original file types only');
      assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('rh:settings')))).compat, true);
      await rowToggle(page, 'DhakaFlix');
      await page.keyboard.press('Escape');
      bdix.log.length = 0;
      await openDownload(page);
      assert.equal(bdix.log.filter((r) => r.method === 'POST').length, 0, 'DhakaFlix switched off: no requests');
      assert.ok((await page.$$eval('.pstat .chip', (e) => e.map((x) => x.textContent))).includes('DhakaFlix: off'));
      await page.keyboard.press('Escape');
      await openSettings(page);
      await rowToggle(page, 'DhakaFlix');
      await page.keyboard.press('Escape');
      await ctx.reload(page); await open(page, '#/movie/603'); await waitFor(() => page.$('.dinfo h1'), { what: 'details' });
      await openDownload(page);
      let names = await page.$$eval('.ticket .name', (e) => e.map((x) => x.textContent));
      assert.ok(!names.some((n) => /\.mov$/i.test(n)), 'compat mode: .mov hidden'); assert.ok(names.some((n) => /\.mkv$/.test(n)));
      await page.keyboard.press('Escape');
      await openSettings(page);
      await rowToggle(page, 'Original file types only');
      await rowToggle(page, 'Prefer sources my browser can play');
      await page.keyboard.press('Escape');
      await ctx.reload(page); await open(page, '#/movie/603'); await waitFor(() => page.$('.dinfo h1'), { what: 'details' });
      await openDownload(page);
      names = await page.$$eval('.ticket .name', (e) => e.map((x) => x.textContent));
      assert.ok(/2160p.*x265/.test(names[0]), 'without the compatibility preference the 2160p HEVC file ranks first: ' + names[0]);
      await page.keyboard.press('Escape');
      await openSettings(page);
      await page.evaluate(() => [...document.querySelectorAll('dialog.sheet .langs label')].find((l) => /Bangla|Bengali/.test(l.textContent)).querySelector('input').click());
      assert.deepEqual((await page.evaluate(() => JSON.parse(localStorage.getItem('rh:settings')))).subLangs, ['en', 'bn']);
      const before = await page.$eval('#sub-preview', (e) => parseFloat(getComputedStyle(e).fontSize));
      await page.evaluate(() => { const r = document.querySelector('dialog.sheet input[aria-label=Size]'); r.value = '200'; r.dispatchEvent(new Event('input', { bubbles: true })); });
      assert.ok((await page.$eval('#sub-preview', (e) => parseFloat(getComputedStyle(e).fontSize))) > before * 1.8, 'live subtitle preview follows the size slider');
      await shot(page, 'settings-desktop');
      await clickByText(page, 'dialog.sheet .btn', /Reset settings/);
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('rh:settings'))), {});
    } finally { await page.evaluate(() => localStorage.removeItem('rh:settings')).catch(() => {}); await page.close(); }
  });

  await step('platforms: Android gets VLC/MX intents, iOS gets VLC/Infuse + MKV warning, desktop gets the .m3u playlist only', async () => {
    const cases = [
      ['android', ANDROID, (l) => l.some((x) => /^intent:\/\/127\.0\.0\.1:\d+\/.*package=org\.videolan\.vlc/.test(x)) && l.some((x) => /package=com\.mxtech/.test(x))],
      ['ios', IOS, (l) => l.some((x) => x.startsWith('vlc-x-callback://x-callback-url/stream?url=http%3A%2F%2F127.0.0.1')) && l.some((x) => x.startsWith('infuse://'))],
      ['desktop', null, (l) => l.length === 0],
    ];
    for (const [label, ua, expect] of cases) {
      const page = await b.newPage({ width: 420, height: 900, touch: label !== 'desktop', label });
      if (ua) await page.setUserAgent(ua);
      try {
        await open(page, '#/movie/603');
        await waitFor(() => page.$('.dinfo h1'), { what: 'details' });
        await openDownload(page);
        await page.evaluate(() => document.querySelector('.ticket .btn.ghost').click());
        const links = await page.$$eval('.ticket .menu a:not([download])', (a) => a.map((x) => x.getAttribute('href')));
        assert.ok(expect(links), `${label}: ${JSON.stringify(links)}`);
        assert.equal(await page.$$eval('.ticket:first-child .menu a[download$=".m3u"]', (a) => a.length), 1, `${label}: .m3u always offered`);
        if (label === 'ios') {
          const lv = await page.$$eval('.ticket', (t) => t.map((x) => [x.querySelector('.name').textContent, x.dataset.level]));
          assert.ok(lv.filter(([n]) => /\.mkv$/.test(n)).every(([, l]) => l === 'bad'), 'iOS Safari cannot open MKV');
          assert.ok(/\.mp4$/.test(lv[0][0]) && lv[0][1] === 'ok', 'an mp4 is still ranked first');
        }
      } finally { await page.close(); }
    }
  });

  await step('routes: malformed -> not found, unknown title -> not found, bad episode -> message, bad season param falls back', async () => {
    const page = await b.newPage({ width: 1000, height: 800, label: 'routes' });
    await open(page, '#/movie/abc');
    await waitFor(() => hasText(page, '#main h2', /Page not found/), { what: 'page not found' });
    await open(page, '#/nothing/here'); await waitFor(() => hasText(page, '#main h2', /Page not found/), { what: 'page not found 2' });
    await open(page, '#/movie/999999'); await waitFor(() => hasText(page, '#main h2', /^Not found$/), { what: 'title not found' });
    await open(page, '#/watch/tv/1396/9/9'); await waitFor(() => hasText(page, '.stage h2', /Episode not found/), { what: 'episode not found' });
    await open(page, '#/tv/1396?s=99'); await waitFor(() => page.$('.ep'), { what: 'episodes' });
    assert.equal(await page.$$eval('.ep', (e) => e.length), 7, 'unknown season falls back to the first');
    await page.close();
  });

  await step('setup: without a TMDB key the home page explains how to get one', async () => {
    const bare = await startApp({ env: {} });
    const page = await b.newPage({ width: 900, height: 800, label: 'nokey' });
    try {
      await page.goto(bare.origin + '/', { waitUntil: 'domcontentloaded' });
      await waitFor(() => hasText(page, '.notice h2', /TMDB API key needed/), { what: 'setup notice' });
      assert.ok(await hasText(page, '.notice li', /TMDB_API_KEY/));
      assert.equal(await page.$$eval('.hero', (e) => e.length), 0);
      await shot(page, 'setup-notice');
    } finally { await page.close(); bare.close(); }
  });

  await step('performance + a11y: player code loads only on the watch page; byte budget; every control named; skip link first', async () => {
    const page = await b.newPage({ width: 1280, height: 800, label: 'perf' });
    await open(page, '#/');
    await waitFor(() => page.$('.rail .card'), { what: 'home' });
    await page.waitForNetworkIdle({ idleTime: 400 }).catch(() => {});
    const m = await page.evaluate(() => {
      const res = performance.getEntriesByType('resource');
      const sum = (re) => res.filter((r) => re.test(r.name)).reduce((a, r) => a + (r.decodedBodySize || 0), 0);
      const nameOf = (e) => (e.getAttribute('aria-label') || e.textContent || e.getAttribute('title') || (e.id && document.querySelector(`label[for="${e.id}"]`)?.textContent) || e.getAttribute('placeholder') || '').trim();
      const unnamed = [...document.querySelectorAll('button, a[href], input, select')].filter((e) => !nameOf(e)).map((e) => e.outerHTML.slice(0, 80));
      return { player: res.some((r) => /artplayer|hls-light/.test(r.name)), js: sum(/\/js\/.*\.js$/), css: sum(/\.css$/), font: sum(/\.woff2$/), count: res.length, noAlt: [...document.images].filter((i) => !i.hasAttribute('alt')).length, lazy: [...document.images].filter((i) => i.loading === 'lazy').length, heroPriority: document.querySelector('.hero img')?.getAttribute('fetchpriority'), h1: document.querySelectorAll('h1').length, lang: document.documentElement.lang, unnamed, tmdbSizes: [...new Set(res.filter((r) => r.name.includes('image.tmdb.org')).map((r) => r.name.split('/t/p/')[1].split('/')[0]))], dcl: performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd | 0 };
    });
    console.log(`    home: ${m.count} requests, JS ${(m.js / 1024).toFixed(0)} KB, CSS ${(m.css / 1024).toFixed(0)} KB, font ${(m.font / 1024).toFixed(0)} KB, DOMContentLoaded ${m.dcl} ms, TMDB image sizes ${m.tmdbSizes.join('/')}`);
    assert.equal(m.player, false, 'player libraries are not loaded on the home page');
    assert.ok(m.js < 170 * 1024, `app JS budget (${m.js} bytes)`); assert.ok(m.css < 40 * 1024); assert.ok(m.font < 50 * 1024);
    assert.equal(m.noAlt, 0); assert.ok(m.lazy > 10, 'posters are lazy-loaded'); assert.equal(m.heroPriority, 'high'); assert.equal(m.h1, 1); assert.equal(m.lang, 'en');
    assert.deepEqual(m.unnamed, [], 'every control has an accessible name');
    assert.ok(m.tmdbSizes.every((s) => ['w185', 'w342', 'w500', 'w780', 'w1280', 'original'].includes(s)), 'only valid TMDB image sizes requested: ' + m.tmdbSizes);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'skip');
    await open(page, '#/watch/movie/603');
    await waitPlaying(page, 0.5);
    assert.ok(await page.evaluate(() => performance.getEntriesByType('resource').some((r) => /artplayer-/.test(r.name))), 'player loaded on demand for the watch page');
    assert.ok(!(await page.evaluate(() => performance.getEntriesByType('resource').some((r) => /hls-light/.test(r.name)))), 'hls.js is not loaded for an mp4');
    await page.close();
  });

  await step('keyboard: m mutes, c toggles captions, space pauses', async () => {
    const page = await b.newPage({ width: 1280, height: 800, label: 'keys' });
    await open(page, '#/watch/movie/603');
    await waitPlaying(page, 0.6);
    await waitFor(async () => /Hello from/.test(await page.evaluate(() => document.querySelector('.art-subtitle')?.textContent || '')), { what: 'subtitle' });
    // no click on the player first: shortcuts must work right after arriving on the page
    await page.keyboard.press('KeyM'); assert.equal(await video(page, (v) => v.muted), true);
    await page.keyboard.press('KeyM'); assert.equal(await video(page, (v) => v.muted), false);
    await page.keyboard.press('KeyC'); await sleep(150);
    assert.equal(await page.$eval('.art-video-player', (e) => e.classList.contains('art-subtitle-show')), false, 'c hides captions');
    await page.keyboard.press('KeyC'); await sleep(150);
    assert.equal(await page.$eval('.art-video-player', (e) => e.classList.contains('art-subtitle-show')), true);
    await page.keyboard.press('Space'); await sleep(200);
    assert.equal(await video(page, (v) => v.paused), true, 'space pauses');
    await page.keyboard.press('Space'); await sleep(200);
    assert.equal(await video(page, (v) => v.paused), false);
    // after a sheet was open on top of the player, shortcuts come back when it closes
    await clickByText(page, '.toolrow .btn', /Subtitles/);
    await page.waitForSelector('dialog.sheet[open]');
    await page.keyboard.press('Escape');
    await waitFor(async () => !(await page.$('dialog.sheet')), { what: 'sheet closed' });
    await page.keyboard.press('Space'); await sleep(200);
    assert.equal(await video(page, (v) => v.paused), true, 'space works again after closing a sheet');
    await page.close();
  });

  await step('race regression: leaving the home page while it loads never corrupts the next page (8 cold navigations)', async () => {
    for (let i = 0; i < 8; i++) {
      const page = await b.newPage({ width: 1000, height: 700, label: 'race' });
      await page.goto(app.origin + '/', { waitUntil: 'domcontentloaded' });
      await ctx.repointProviders(page, bdix.base);
      await page.evaluate(() => { location.hash = '#/watch/movie/603'; });
      await waitFor(() => page.$('.art-video-player'), { timeout: 20000, what: `player (run ${i})` });
      assert.ok(!(await hasText(page, '#main', /Something went wrong/)), 'no stale error overwrote the watch page');
      await page.close();
    }
  });

  await step('mobile: watch page fits phone portrait and landscape; tablet and phone details have no overflow', async () => {
    const phone = await b.newPage({ width: 390, height: 844, touch: true, label: 'watch-phone' });
    await open(phone, '#/watch/movie/603');
    await waitPlaying(phone, 0.8);
    const p = await phone.evaluate(() => { const s = document.querySelector('.stage').getBoundingClientRect(); return { w: Math.round(s.width), h: Math.round(s.height), overflow: document.documentElement.scrollWidth - innerWidth, tools: document.querySelectorAll('.toolrow .btn').length, ctrl: !!document.querySelector('.art-bottom') }; });
    assert.equal(p.w, 390); assert.ok(Math.abs(p.h - 390 * 9 / 16) < 3, 'stage keeps 16:9: ' + p.h); assert.equal(p.overflow, 0); assert.equal(p.tools, 3); assert.ok(p.ctrl);
    await shot(phone, 'watch-phone');
    await phone.setViewport({ width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await sleep(500);
    const l = await phone.evaluate(() => { const s = document.querySelector('.stage').getBoundingClientRect(); return { h: Math.round(s.height), overflow: document.documentElement.scrollWidth - innerWidth }; });
    assert.ok(l.h <= 390, `landscape stage fits the screen height (${l.h}px)`); assert.equal(l.overflow, 0);
    await shot(phone, 'watch-phone-landscape');
    await phone.close();
    const tab = await b.newPage({ width: 820, height: 1180, touch: true, label: 'tablet' });
    await open(tab, '#/tv/1396');
    await waitFor(() => tab.$('.ep'), { what: 'episodes' });
    assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    await shot(tab, 'details-tv-tablet');
    await open(tab, '#/movie/603'); await waitFor(() => tab.$('.dinfo h1'), { what: 'details' });
    await shot(tab, 'details-movie-tablet');
    await tab.close();
    const ph = await b.newPage({ width: 390, height: 844, touch: true, label: 'phone-details' });
    await open(ph, '#/tv/1396'); await waitFor(() => ph.$('.ep'), { what: 'episodes' });
    assert.equal(await ph.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0);
    await shot(ph, 'details-tv-phone');
    await ph.close();
  });
}
