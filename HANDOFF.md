# HANDOFF: start here

**RafTV**: a streaming-style website on Cloudflare Pages (`*.pages.dev`, https). It browses TMDB (free key), and plays or downloads titles from **BDIX-only servers** (Bangladesh local network) when the user presses Play or Download. Built-in player (ArtPlayer), OpenSubtitles subtitles, phone/tablet/desktop layout. It is a browser port of the GPL-3.0 "eclipsia-bdix" CloudStream plugin.

## Status

* Built and tested: 177 unit and integration tests, 39 browser end-to-end steps (real Chromium, real gateway, real video files), 9 Cloudflare runtime checks (real `workerd`).
* **Connection and playback fixes (Nov 19, 2026)**, from the owner's report "Fendrix: 1 found but never plays; Hexion and BDIX unreachable" and live checks against the deployment (`VERIFICATION.md` section 18):
  * *Endless spinner*: the player's watchdog was armed only after the first `canplay`, and hls.js failures were never reported. Without built-in HLS (Firefox, older Chrome) Fendrix's CDN refuses hls.js (it 404s any foreign `Origin`), so the page spun forever. Now the player gives up in about a second and explains (built-in HLS, gateway or external player).
  * *FlixHub is a BDIX server* (original: "FlixHub FTP: BDIX"); it was wrongly sent through the Cloudflare edge proxy (504). Now it is treated like DhakaFlix and Circle FTP.
  * *Hexion's sites block Cloudflare* (403 "error code: 1106" / bot challenge from the edge). Not fixable from Cloudflare: Hexion needs the gateway on `pages.dev`; the app now says "Hexion: needs gateway" instead of "server error". Through the real gateway Hexion returned 8 streams in 3.4 s.
  * *DhakaFlix / Circle FTP without a gateway*: no code bug; the browser rules (CORS, mixed content) make the gateway necessary on `pages.dev`. The port still matches the original scrapers (golden parity test).
* Online source **Mavonyx** (MovieBox API, Nov 19, 2026): port of `mavonyx.js` with the same signed requests (HMAC-MD5 `x-tr-signature`, token from the `x-user` header, refresh on 401/441). Straight from the browser, like Fendrix. **First live test by the owner: "no match" everywhere.** Cause: the token host `apig.inmoviebox.com` sends no `access-control-expose-headers`, so the page could not read the token and every app-API call failed (the classification then said "no match"). Fixed with a web-API token fallback, a web-search fallback, "server error" when no search answered, and a Mavonyx row in Settings → Test connection that names the failing step. Then: token via the app host works; the app API's only stream is a placeholder announcement video (dropped now); real files come from the web API only with a movie-page Referer on a MovieBox host, which MovieBox refuses to Cloudflare (429), so on `pages.dev` Mavonyx's files come **through the gateway** (live-checked with the real gateway). Still unverified: whether the video server (`hakunaymatata`) accepts a browser without a Referer (the trace's media probe tells). It is **region-gated** (403 "Service not available in current region" from the US sandbox; the owner reports lookup and playback working in their browser), so live streams were never seen here. MP4/HLS play in the built-in player; DASH (`.mpd`) is ranked "unlikely to play" until a DASH player is added. Parity test runs the original file in a `vm` against a mock that checks every signature with `node:crypto`; a real-Chromium E2E step proves the preflight, the readable token header and playback. The 29 KB lookup (`mx-api.js`) loads on the first click; the home page only gets a 0.5 KB stub.
* Online sources **Fendrix** and **Hexion** (Nov 2026): ported, checked against the live services from the sandbox (VERIFICATION section 18) and covered by parity tests against the original scraper files. Fendrix plays with built-in HLS (Chrome/Edge 142+, Safari), through the gateway in other browsers (Firefox: HLS playlists rewritten, tested with hls.js), or in an external player; Hexion's link domains rotate (`EDGE_PROXY_HOSTS`).
* **Accounts, lists, sync** (Nov 2026): invite-only accounts on Cloudflare D1, sign-in, password change, admin page (invites, users), named watch lists, history removal with Undo, and a merge-based sync of history/lists/resume positions/settings between devices. Unit, multi-device browser and real-`workerd`+D1 tests. Deploy steps: README *Accounts*.
* **Not verified**: Mavonyx against the live API (region-gated from the sandbox: real stream URLs, formats, sign cookies and caption hosts unseen); a live D1 database on Cloudflare (local D1 in workerd only); the real BDIX servers (DhakaFlix, Circle FTP, FlixHub), TMDB and OpenSubtitles were unreachable during development (mocks used); the deployment `raftv.pages.dev` was only read (public GETs), nothing was deployed from a session; Fendrix playback in the owner's own browser; Firefox/Safari; real phones; https `pages.dev` with the gateway. See `VERIFICATION.md` section 14.
* **Gateway as a Windows program** (`raftv-gateway.exe`, Nov 19, 2026): the unchanged gateway plus a small launcher (`gateway/exe-main.mjs`: writes nothing to disk, token derived from the PC's machine id and user name, optional read-only settings file, listens on this PC only (127.0.0.1), only the RafTV origin), packed with Node's single-executable feature (`npm run build:gateway`). GitHub Actions builds it on Windows, runs it (`scripts/smoke-gateway-exe.mjs`) and attaches it to a release on a `gateway-v*` tag. Tested: the bundled launcher with every gateway feature the site uses; a Linux build of the same program run and measured (0.04 s start, ~60 MB idle, ~100 MB streaming). Not run here: the Windows `.exe` itself (only in CI), SmartScreen.
* **Play in mpv** (Nov 21, 2026): Settings → Playback → *Play videos in: mpv on this computer* (device-only). The search still uses the gateway; the watch page then offers *Open in mpv* (`raftv-mpv://` link with the file's own address and Referer/UA/cookies, `public/js/mpv.js`), so the gateway can be closed while mpv plays. On the PC, `raftv-gateway.exe --mpv-register` (once, HKCU registry) makes such links run `raftv-gateway.exe --mpv-open`, which checks the link (`gateway/mpv-handler.mjs`), starts mpv detached and exits: no gateway, nothing written. Verified: unit tests with mutation checks, E2E step 16b (gateway closed, the file still answers directly), the packaged Linux program with **real mpv 0.37** (Referer/UA/cookie arrived at the server, mpv log empty), release smoke test (Windows registry part runs only in CI). The watch page now loads lazily (home page JS 174 → 144 KB). Not run here: the Windows registry part and a browser opening the link on Windows.
* Key constraint: **Cloudflare cannot reach BDIX**, and an https page cannot freely call http BDIX servers. On `pages.dev` the user normally needs the **gateway** (`gateway/bdix-gateway.mjs`) on their own device or network.

## Read order

1. This file. 2. `CLAUDE.md` (rules, file map, design control, video logic, BDIX limits). 3. The relevant sections of `docs/IMPLEMENTATION.md` (CLAUDE.md has a task-to-section map). 4. `VERIFICATION.md` before touching tests. `README.md` is for the owner (setup, deploy).

## File map

```
public/                  deployed as-is
  index.html  css/app.css  icon.svg  manifest.webmanifest  _headers  _routes.json
  js/brand.js            name, tagline, theme colour, logo path (single source)
  js/main.js router.js api.js store.js net.js player.js streams.js subs.js util.js core.js
  js/account.js          sign-in state + sync engine;  js/sync-merge.js  merge rules (tombstones, last-writer-wins)
  js/providers/          df.js cf.js fh.js (BDIX servers), fn.js (Fendrix) hx.js (Hexion) mx.js + mx-api.js (Mavonyx) aesgcm.js, common.js, index.js (orchestrator)
  js/ui/                 home details watch browse settings sources shell components
  vendor/                committed player (ArtPlayer), hls.js light, font (versioned, immutable)
functions/api/[[path]].js   the single Pages Function -> lib/api.js
lib/                     api.js (router)  tmdb.js  subs.js   (shared by Function, dev server, tests)
gateway/bdix-gateway.mjs optional proxy for BDIX (Node, zero dependencies)
dev/                     server.mjs (local site + API + _headers)  mock-upstream.mjs
scripts/                 build-vendor  rebrand  check-docs  make-golden  extension-harness
test/                    *.test.mjs  fixtures/ (scenarios, golden.json from the original scrapers)
e2e/                     run.mjs steps2.mjs steps3.mjs lib.mjs helpers.mjs make-media.mjs cloudflare-smoke.mjs
docs/                    IMPLEMENTATION.md  screenshots/
README.md CLAUDE.md HANDOFF.md VERIFICATION.md NOTICE.md LICENSE
```

## Packages needed

Runtime on Cloudflare: **none** (no build step; `public/vendor/` is committed).

Dev/test (exact versions pinned in `package.json`): `artplayer` 5.4.0, `hls.js` 1.7.4, `esbuild` 0.28.2, `@fontsource-variable/bricolage-grotesque` 5.3.0, `linkedom` 0.18.15, `puppeteer-core` 25.17.0, `@sparticuz/chromium` 153.0.0 (Chromium via npm), `wrangler` 4.160.0.

Outside npm: **Node 22+**; **ffmpeg** with libx264/libx265/vpx/aac/ac3/opus for `npm run e2e:media` (e.g. `pip install imageio-ffmpeg --break-system-packages`, then `export FFMPEG=$(python3 -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())")`).

## Prepare the environment

```bash
npm ci                    # installs everything incl. Chromium and workerd binaries (no other downloads needed)
npm test                  # 177 tests, ~3 s
npm run e2e:media         # once; writes e2e/media/ (git-ignored)
npm run e2e               # ~4 min; add a word to run matching steps only
npm run smoke:cf          # ~20 s
npm run check:docs        # docs vs code
```

Local site: copy `.dev.vars.example` to `.dev.vars`, set `TMDB_API_KEY`, then `npm run dev` (http://localhost:8788).

Sandbox reminders (details: `VERIFICATION.md` section 3): network reach varies by session (Nov 2026 cloud sessions reached public sites through a proxy, never BDIX; tests must still use mocks only); Chromium is installed by `npm ci` (`@sparticuz/chromium`), ffmpeg may already be at `/usr/bin/ffmpeg`; shell is dash (no `{a,b}`); background processes do not persist between tool calls; never `pkill -f` your own command text; kill orphan `workerd`; `create_file` will not overwrite.

## Deploy and customise (owner tasks)

* Deploy: Cloudflare Pages, build command empty, output directory `public`, secret `TMDB_API_KEY` (README). Run the gateway on a BDIX machine and set `ALLOWED_ORIGINS=https://<project>.pages.dev`.
* Accounts (optional): create a D1 database, bind it as `DB` in `wrangler.toml` (commented block there), add secrets `ADMIN_USERNAME` / `ADMIN_PASSWORD`, redeploy, sign in once to create the admin (README *Accounts*).
* Rename / new logo: edit `public/js/brand.js` and replace `public/icon.svg`, then `npm run rebrand` and `npm test` (README section "Change the name or logo").

## Open items

Real-network validation on BDIX (with the gateway); a DASH player for Mavonyx's `.mpd` streams (dash.js or Shaka, lazy-loaded; signed cookies would have to become signed-URL query parameters); Firefox/Safari pass; a browser extension as a no-gateway route for Hexion and BDIX (would need its own review); gateway setup helper page; WebAssembly decode fallback for HEVC/DTS; episode list on the watch page. Full list in `CLAUDE.md`.

## Prompt to start a new session

Copy, fill the `<...>` parts, and paste as the first message:

```text
You are continuing work on "RafTV", a streaming-style website on Cloudflare Pages that
plays titles from BDIX-only servers and some online sources. This is a cloud session on the
GitHub repository UpperPanda1/reelhouse (already cloned; work on the branch you are given).

READ FIRST, in this order, before changing anything:
1. HANDOFF.md  2. CLAUDE.md  3. the sections of docs/IMPLEMENTATION.md that CLAUDE.md maps to
my task  4. VERIFICATION.md (before touching tests).

SETUP: Node 22+, run `npm ci`, then `npm test` and confirm the baseline before
you change code (177 passing). For browser tests run `npm run e2e:media` once (needs ffmpeg), then `npm run e2e`
(39 steps).

TASK: <one or two sentences: what I want, and why>

CONTEXT / CONSTRAINTS:
- Hosting: pages.dev (https). BDIX servers (DhakaFlix, Circle FTP, FlixHub) are only reachable
  from my network; use the gateway design, never server-side BDIX code. Hexion's sites block
  Cloudflare, so Hexion also needs the gateway on pages.dev.
- <anything specific: devices, browsers, files not to touch, deadlines>

HOW TO WORK:
- Plan first: tell me which files you will change and how you will verify it.
- Write the failing test first, see it fail, then fix (mutation-check logic and security fixes).
- Run `npm test`, the relevant `npm run e2e -- <word>`, and `npm run check:docs`; before finishing
  run the full e2e and look at screenshots for UI changes (phone + desktop).
- Do not weaken browser security flags in the test harness; do not query BDIX outside a user click.
- Update HANDOFF/CLAUDE/IMPLEMENTATION/VERIFICATION where they are affected.

REPORT BACK: what changed (files), what you verified and how (commands + results), what you
could NOT verify, and any bugs found along the way.
```
