# CLAUDE.md: working on RafTV

Instructions for an AI coding session continuing this project. Read this fully before editing. Start with `HANDOFF.md` (two minutes), then this file, then only the parts of `docs/IMPLEMENTATION.md` your task needs (map below). Read `VERIFICATION.md` before running or changing tests.

## What this project is

**RafTV** is a streaming-style website (TMDB discovery, BDIX source lookup, built-in player, subtitles) hosted on **Cloudflare Pages** (`*.pages.dev`, https). It is a browser port of the "eclipsia-bdix" CloudStream plugin (GPL-3.0). Vanilla ES modules, no framework, no build step on Cloudflare. The owner is a Bangladeshi user whose media comes from BDIX-only servers; they browse mostly on a phone.

## How to read `docs/IMPLEMENTATION.md`

Do not read it end to end. Jump by task:

| If your task is about... | Read section |
|---|---|
| Why something is built this way, requirements | 1 Goals |
| How pieces connect, what runs where | 2 Architecture, 3 Technologies |
| Home rows, TMDB, caching, images | 4 Data loading |
| What happens on Play / Download, settle window, error classes | 5 Click-to-stream |
| The BDIX scrapers, parity with the original, deliberate differences | 6 Providers |
| CORS, mixed content, gateway, SSRF rules, why direct mode often fails | 7 Connectivity |
| The player library, why ArtPlayer, how to swap | 8 Player choice |
| Codec findings, ranking, health monitor, external players | 9 Playback robustness |
| Subtitles, OpenSubtitles, appearance settings, shortcuts | 10 Subtitles |
| Colours, fonts, layout, motion, accessibility | 11 UI and design |
| Secrets, CSP, injection, SSRF | 12 Security |
| What is tested | 13 Verification (full detail: `VERIFICATION.md`) |
| Sizes, speed | 14 Performance |
| What is unknown or untested | 15 Limitations |
| Licensing, TMDB terms | 16 Licensing |
| Recipes (add a provider, change player) | 17 Extending |
| Accounts, invite codes, admin, lists, sync and its merge rules | 18 Accounts and sync |

## Important files

| Area | Files | Notes |
|---|---|---|
| Identity | `public/js/brand.js`, `public/icon.svg`, `scripts/rebrand.mjs` | name, tagline, theme colour, logo; `npm run rebrand` syncs `index.html` and `manifest.webmanifest` |
| Design | `public/css/app.css` | tokens in `:root` at the top; all layout and components; no other CSS |
| Entry and routing | `public/index.html`, `public/js/main.js`, `public/js/router.js` | hash routes: `#/`, `#/search?q=`, `#/list`, `#/movie/ID`, `#/tv/ID?s=N`, `#/watch/movie/ID`, `#/watch/tv/ID/S/E` |
| Views | `public/js/ui/home.js`, `details.js`, `watch.js`, `browse.js`, `settings.js`, `sources.js`, `shell.js`, `components.js` | each view receives its **own detached container** (`root`) and an abort `signal` |
| Data | `public/js/api.js`, `store.js`, `util.js` | `api.js` = our `/api/*` client with cache and stale-while-revalidate; `store.js` = everything in `localStorage` (prefix `rh:`): settings, `library` (history, lists, tombstones), progress |
| Accounts | `lib/accounts.js` (server), `public/js/account.js` (client + sync engine), `public/js/sync-merge.js`, `public/js/ui/account.js`, `public/js/ui/admin.js`, `dev/d1-sqlite.mjs` | D1 binding `DB`; no `DB` = accounts off. See IMPLEMENTATION section 18 |
| Providers | `public/js/providers/{df,cf,fh,fn,hx,mx,mx-api,aesgcm,common,index}.js`, `public/js/net.js` | df/cf/fh = BDIX servers (DhakaFlix, Circle FTP, FlixHub), fn/hx/mx = online sources (Fendrix, Hexion, Mavonyx); `mx.js` is a stub that imports `mx-api.js` (the signed MovieBox lookup) on first use; `aesgcm.js` = Fendrix decryption fallback without WebCrypto; `net.js` = direct / gateway / edge transport. Reference scrapers: `cloudstream-main/cloudstream/providers/` |
| Playback | `public/js/player.js`, `streams.js`, `subs.js` | `streams.js` ranks and predicts playability; `player.js` wraps ArtPlayer and monitors health; `subs.js` decodes and styles subtitles |
| Server | `functions/api/[[path]].js` (entry), `lib/api.js` (router), `lib/tmdb.js`, `lib/subs.js` | all logic is in `lib/` and shared with the dev server and tests |
| Gateway | `gateway/bdix-gateway.mjs` | optional proxy run on the user's network; zero dependencies |
| Cloudflare config | `public/_headers` (CSP), `public/_routes.json`, `wrangler.toml` | `_routes.json` limits Functions to `/api/*` |
| Vendor | `public/vendor/*` (committed), `scripts/build-vendor.mjs` | versioned file names; served `immutable`; rebuild with `npm run build:vendor` |
| Tests | `test/*.test.mjs`, `test/fixtures/*`, `e2e/*` | see `VERIFICATION.md` |
| Docs | `README.md`, `HANDOFF.md`, `CLAUDE.md`, `VERIFICATION.md`, `docs/IMPLEMENTATION.md`, `NOTICE.md` | `npm run check:docs` keeps them honest |

## What controls the website design

* **Colours, radii, spacing, breakpoints**: CSS variables at the top of `public/css/app.css` (`--ink --panel --raised --line --text --dim --lamp --mint ...`, `--pad`, `--card-w`, `--topbar-h`). Change tokens, not scattered values.
* **Type**: Bricolage Grotesque (variable) from `public/vendor/fonts/`, declared at the top of `app.css`. Single family.
* **Name, tagline, logo**: `public/js/brand.js` + `public/icon.svg`. The header logo, favicon and installed-app icon are all that one SVG. To rename: edit `brand.js`, run `npm run rebrand`, run `npm test` (a test fails if static files drift or a module hardcodes the name). Not renamed on purpose: the `rh:` storage prefix (renaming would erase users' saved data), the gateway's internal name, `package.json` name. `APP_NAME` (Function env) is the OpenSubtitles User-Agent and must match the consumer registered there.
* **Layout per screen size**: media queries at 560, 768, 820, 1280, 1800 px in `app.css`; poster width is `--card-w` (viewport-relative). Phones get the bottom tab bar (`#tabbar`), larger screens the top nav.
* **Look of the player**: ArtPlayer theme colour is set in `player.js` (`theme: '#ffb02e'`); extra rules at the end of `app.css` (`.art-*`).
* **Design rules kept so far** (see IMPLEMENTATION section 11): one action colour (amber), mint only for status, no all-caps eyebrow labels, no dot-joined meta strings, motion only in response to a tap, only the recommended source ticket gets the primary button.

## The video pipeline (fetch → rank → play → recover)

1. **Trigger**: only the watch route (`ui/watch.js`) and the sources sheet (`ui/sources.js`) call `lookupSources()`. **Never query providers while browsing** (a browser test asserts zero BDIX requests until a click).
2. **Lookup**: `providers/index.js: resolveStreams(meta, opts)` runs DhakaFlix (4 parallel POSTs), Circle FTP, FlixHub, Fendrix, Hexion, Mavonyx in parallel, each through `makeCtx` (counts network vs HTTP failures, and edge replies marked `x-upstream-blocked`). `settleMs: 1500` on the watch page: once one provider has streams, stragglers are aborted and marked `slow`. Duplicate URLs keep the entry with the known resolution. Result states per provider: `ok, empty, error, blocked, unreachable, timeout, slow, cancelled` (`blocked` = the site refused the edge proxy; chip "needs gateway").
3. **Transport** (`net.js`): providers/streams with `direct: true` (Fendrix, Mavonyx; their media and Hexion's) always go straight from the browser; otherwise gateway if a gateway URL is set; edge proxy (`/api/proxy`) for `edge: true` providers (Hexion only); otherwise direct. `net.mediaUrl()` returns what goes into `<video>` or a download link. `ctx.bytes()` exists for binary replies (Fendrix): never decode binary as text. `ctx.response()` returns the Response even for error statuses (Mavonyx needs 401/441 and the `x-user` header).
4. **Rank** (`streams.js`): `playability()` from file-name codec tokens and `browserCaps()`; `rank()` orders playable → risky → unlikely, then resolution, container (mp4 > mov > mkv), provider. The default source is the best one the browser can probably play.
5. **Play** (`player.js`): ArtPlayer is imported lazily from `/vendor/` (hls.js only for `.m3u8`). The controller exposes `switchTo, addSubtitle, selectSubtitle, focus, applySubStyle, destroy`.
6. **Health monitor** (armed when the player is created, NOT on ArtPlayer's `ready`, which is the first `canplay` and never comes for a dead source): after metadata `videoWidth === 0` → `video-unsupported`; after 2.5 s playing with no decoded audio → `audio-unsupported`; media error, fatal hls.js error (these never fire `<video>` `error`) or 25 s without metadata → `error`/`timeout`. `watch.js: onIssue` auto-switches to the next non-bad source for video problems; with none left, `player.fail()` stops the spinner and a banner gives the known reason plus external-player links; silent audio gets a banner.
7. **Resume**: progress saved every 5 s, on `video:pause`, on destroy and on `pagehide` (`store.saveProgress`); resume only if past 30 s and before 93 %.
8. **Subtitles**: `/api/subs` → `/api/sub` → `decodeBytes` → `srtToVtt` → blob URL → `art.subtitle.switch`. Appearance prefs in `settings.subStyle`.

Facts to keep in mind: browsers play MOV and MKV (H.264/AAC) fine regardless of `Content-Type`; HEVC video and AC-3/DD+/DTS audio fail **silently**; never gate on `canPlayType` for MOV/MKV.

## BDIX limitations (do not forget)

* BDIX servers (`172.16.50.12/.14`, `new.circleftp.net:5000`, `15.1.1.50:5000`) are reachable only from a BDIX network. **Cloudflare cannot reach them**, so there is, and must be, no server-side BDIX code in the Function. **FlixHub is a BDIX server too** (original manifest "FlixHub FTP: BDIX"; `flixhub.net` resolves to a Bangladeshi address): never put it on the edge list. The Hexion chain is public https without CORS, so the edge proxy may fetch it (exact-host allow-list `DEFAULT_EDGE_PROXY_HOSTS` / `EDGE_PROXY_HOSTS`), **but from Cloudflare's network those sites block it** (measured on the deployment, 19 Nov 2026: `4khdhub.one` 403 "error code: 1106", HubDrive/HubCloud 403 challenge): on `pages.dev` Hexion needs the gateway, and the app says so (`blocked`). Fendrix sends CORS headers and is called directly; keep it off the edge list.
* From an https page (`pages.dev` always is) browsers block http servers (mixed content), require CORS, and forbid setting `Referer`/`User-Agent`. Chrome/Edge 142+ prompt for permission for private **IP literals** only. Therefore **direct mode usually fails on pages.dev**, and the **gateway** (`gateway/bdix-gateway.mjs`, on the user's machine, ideally `http://127.0.0.1`, or with TLS) is the supported fix. The UI explains this (guidance notice, Settings → Test connection).
* Real servers were never reachable during development; response shapes come from the original parsers. Anything that changes provider behaviour must keep parity with `test/fixtures/golden.json` or be a documented deviation.
* The gateway forwards video through itself: keep it on the same BDIX network as the user's device; never recommend a public tunnel.

## Online sources (Fendrix, Hexion, Mavonyx): facts measured live in Nov 2026

* Fendrix: `enc-dec.app` session → `POST api.wing.st/g` returns AES-GCM bytes (read with `ctx.bytes`). Its HLS CDN (playlists, `init.mp4` and segments alike) returns 404 to **any request whose `Origin` is not `https://cinejoy.pk`**, and serves requests without one; a page always sends its own Origin, so: the master playlist cannot be read from a page (the master itself is offered), hls.js cannot play it, built-in HLS can (`needsNativeHls`, `caps.nativeHls`). Without built-in HLS and with a gateway, `net.mediaUrl(s, { player: true })` sends it through the gateway's `/s?hls=1`, which rewrites playlist URIs back through itself (`rewritePlaylist`). `api.shegu.st` answers 530 without CORS: one expected console error per lookup.
* Hexion: `4khdhub.one` → `greenmotors.club` wrapper → `hubdrive.blog`/`hubcloud.mov` → `gamerxyt.com` file page → `*.workers.dev` files. These domains rotate; the original scraper finds nothing on today's pages (deviation documented in IMPLEMENTATION section 6).
* Mavonyx (MovieBox): signed mobile API (`apig.inmoviebox.com` token, `api3.aoneroom.com`) plus web API (`h5-api.aoneroom.com`). **Region-gated**: 403 "Service not available in current region" from the US sandbox (the owner in Bangladesh says it works), so live stream lists were never seen here; do not put it on the edge list (Cloudflare's egress region is not the user's). CORS: `api3`/`h5-api` echo any Origin, allow every signed header, `expose-headers: *`; **`apig` sends only `allow-origin: *`, so its `x-user` token is unreadable in a page**: the port then takes the web API's anonymous token and, if the app search gives no usable reply, uses the web search (deviations, IMPLEMENTATION section 6). Settings → Test connection's Mavonyx row names the failing step. The signature covers method, Accept, Content-Type, body length/MD5, timestamp and sorted query, not UA/Referer/Cookie, so browsers dropping those is harmless. Mobile streams: DASH/HLS only (DASH `bad` until a DASH player exists); `signCookie` streams are flagged `signedCookie` (`warn`): a page cannot send another site's cookie and the gateway deliberately does not forward `Cookie`.
* All three have parity tests that run the original scraper files in a `vm` (`test/public-providers.test.mjs`, `test/mavonyx.test.mjs`). E2E never reaches the real internet: the harness answers or aborts the providers' hosts (`PUBLIC_SOURCE_HOSTS` in `e2e/lib.mjs`).

## Accounts and sync: rules

* Never remove an item from the library by deleting it alone: use the store methods, which write a **tombstone** (`removeHistory`, `removeFromList`, `deleteList`, `clearHistory`); otherwise sync brings it back from another device.
* `sync-merge.js` must stay commutative, associative and idempotent (property test in `test/sync-merge.test.mjs`).
* Device-only settings (gateway URL/token) must not enter `SYNCED_SETTINGS`.
* Account routes are the only non-GET API routes; each needs JSON, a same-origin `Origin`, and a test (including role and CSRF checks). Never return password hashes, session tokens or invite codes after creation.

## Rules for any change

1. Do not query BDIX outside a user click. Do not add server-side BDIX code.
2. No `innerHTML` with data; build DOM with `h()` (text goes through `textContent`).
3. Each view writes only to the `root` it was given and must stop on `signal.aborted`; all network helpers must let `AbortError` propagate.
4. Never put secrets in client code. Keys live in the Function environment; do not log or return them.
5. Any new outbound fetch in `lib/` or the gateway needs an allow-list and tests, including bypass attempts (IP literals, IPv6 forms, look-alike hosts).
6. Provider changes: keep the golden parity test green (compat mode) or document the deviation in IMPLEMENTATION section 6 and test it.
7. Vendor files are versioned and `immutable`; changing them means new file names (`npm run build:vendor`) and updating `versions.json`.
8. Keep `_headers` CSP strict: scripts from self only. Check the E2E run for CSP violations after UI changes.
9. Accessibility floor: named controls, `alt` on images, visible focus, 44 px targets, reduced-motion support.
10. GPL-3.0: provider modules derive from GPL code; keep `LICENSE` and `NOTICE.md`; TMDB attribution stays in the footer.
11. After changing code or docs: `npm test`, the relevant `npm run e2e -- <word>`, and `npm run check:docs`. Before finishing a feature, run the full E2E and look at screenshots in `e2e/screenshots/`.

## Definition of done

A change is done when: behaviour is demonstrated by a test that fails without it (and you saw it fail); `npm test`, `npm run e2e`, `npm run smoke:cf` and `npm run check:docs` pass; UI changes were viewed in screenshots at phone and desktop sizes; docs and counts were updated; limitations you could not verify are stated plainly.

## Sandbox lessons (details in VERIFICATION.md section 3)

Network reach varies by session: earlier ones reached only npm, PyPI, GitHub and Ubuntu mirrors; the Nov 2026 session also reached public sites (used for the live provider checks, never in tests). BDIX is never reachable; the shell is dash (no brace expansion, no `<(...)`: a syntax error silently skips the rest of the line, so confirm check output actually appeared); background processes do not survive between tool calls (use a Node orchestrator); never `pkill -f` a pattern present in your own command; kill orphaned `workerd` by name; `create_file` will not overwrite; the packaged Chromium has CORS disabled unless `e2e/lib.mjs` strips its flags (it does).

## Useful commands

```bash
npm ci && npm test                         # install and run 150 unit/integration tests
npm run dev                                # local site (needs TMDB_API_KEY in .dev.vars)
npm run e2e:media && npm run e2e           # browser suite (needs ffmpeg; FFMPEG=... if not on PATH)
npm run e2e -- subtitles                   # run only matching steps
npm run smoke:cf                           # real Cloudflare runtime locally
npm run build:vendor                       # rebuild player/font bundles
npm run rebrand                            # sync name/theme after editing brand.js
npm run check:docs                         # docs vs code
```

## Known gaps and good next steps

Online sources: Hexion on a deployment without a gateway (measured: its sites block Cloudflare; the only routes are the gateway or a browser extension); Fendrix in Firefox *without* a gateway (no Origin-free path exists in a page; with a gateway it works, untested in real Firefox); a Settings field or auto-discovery for rotating Hexion link domains; auto-loading Fendrix captions (the sheet lists them; none were present in the live replies seen); Mavonyx: a lazy DASH player for its `.mpd` streams, a live check from an allowed region, and its audio-track/resolution toggles (`mx-api.js` `settings`, original defaults: 2160p/1080p, Original + English + Hindi) in Settings.


Real-network validation on the owner's BDIX network; Firefox/Safari passes; a "gateway setup" page with a QR/copy-paste command; optional software decoding fallback (WebAssembly) for HEVC/DTS; episode list inside the watch page; Chromecast/AirPlay; per-title subtitle delay memory; migration to Video.js 10 if ArtPlayer stalls; a small cache for subtitle downloads to protect OpenSubtitles quota.
