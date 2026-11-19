# Verification record

Everything that was done to test and verify RafTV, how, with which packages, what it found, and how to repeat or extend it. Read this before running, changing or adding tests. Design and architecture are in `docs/IMPLEMENTATION.md`; the quick start is in `HANDOFF.md`.

Contents: [1 Principles](#1-principles) · [2 Environment and packages](#2-environment-and-packages) · [3 Sandbox lessons](#3-sandbox-lessons-learned-so-the-next-session-does-not-repeat-them) · [4 Test layers](#4-test-layers) · [5 Unit and integration tests](#5-unit-and-integration-tests) · [6 Golden parity](#6-golden-parity-with-the-original-scrapers) · [7 Browser end-to-end](#7-browser-end-to-end-suite) · [8 Cloudflare runtime](#8-cloudflare-runtime-smoke-test) · [9 Experiments](#9-experiments-that-are-not-tests) · [10 Mutation checks](#10-mutation-checks) · [11 Stress runs](#11-stress-runs) · [12 Bug log](#12-bug-log) · [13 Results](#13-latest-results) · [14 Not verified](#14-not-verified-and-how-to-verify-it-yourself) · [15 Reproduce](#15-reproduce-from-scratch) · [16 Adding tests](#16-adding-or-changing-tests) · [17 Phase 1: scraping reference](#17-phase-1-verification-of-the-scraping-reference)

---

## 1. Principles

1. **Verify by execution, not by reading.** Behaviour claimed in the docs was run: real browser, real sockets, real video files, real Cloudflare runtime.
2. **Measure, do not assume.** Codec support, bundle sizes, player maintenance status and timings were measured or read from the package registry.
3. **Make the tests able to fail.** For the security and logic fixes the code was reverted on purpose to see the test go red (section 10).
4. **Independent implementations agree.** The browser providers were compared against the *original* extension scrapers on identical inputs, including the network calls they make (section 6).
5. **Test like a user's browser.** The Chromium build used ships flags that switch CORS off; they are stripped (section 7). An early green run was invalid for that reason.
6. **Stress the start-up path.** Races only showed up with fresh browsers and servers (section 11).
7. **Reproduce from a clean extract** of the deliverable, not from the working directory (section 15).
8. **Say what was not verified** (section 14).

## 2. Environment and packages

Build environment (the sandbox these were run in):

| Item | Version |
|---|---|
| OS | Ubuntu 24.04 (Linux 6.18, x86_64), running as root |
| Node.js / npm | 22.23.4 / 10.9.9 (`engines: node >=22`; `node --test` needs 22+ for glob arguments) |
| Python | 3.12.3 (only for fetching ffmpeg and for phase-1 tooling) |

npm dev dependencies (exact, from `package.json`/`package-lock.json`; nothing is installed at runtime on Cloudflare):

| Package | Version | Used for |
|---|---|---|
| `artplayer` | 5.4.0 | the player, bundled into `public/vendor/` |
| `hls.js` | 1.7.4 | HLS (light build), bundled, lazy |
| `esbuild` | 0.28.2 | `scripts/build-vendor.mjs` only |
| `@fontsource-variable/bricolage-grotesque` | 5.3.0 | source of the committed font file |
| `linkedom` | 0.18.15 | `DOMParser` for FlixHub parsing in Node tests |
| `puppeteer-core` | 25.17.0 | drives Chromium in the E2E suite |
| `@sparticuz/chromium` | 153.0.0 | a Chromium binary delivered through npm (HeadlessChrome/153.0.8010.0); the sandbox cannot download browsers from other hosts |
| `wrangler` | 4.160.0 | runs the real Cloudflare runtime locally (`workerd` 1.20261110.1) |

Tools outside npm:

| Tool | How obtained | Used for |
|---|---|---|
| ffmpeg 7.0.2 static (libx264, libx265, libvpx-vp9, aac, ac3, libopus) | `pip install imageio-ffmpeg --break-system-packages`, then `FFMPEG=$(python3 -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())")` | generating the test videos (`npm run e2e:media`) |
| Python `ipaddress`, `hashlib` | stdlib | phase-1 checks |

Built-in Node modules used by the project and tests: `node:test`, `node:assert/strict`, `node:http`, `node:https`, `node:dns`, `node:net`, `node:crypto`, `node:zlib`, `node:child_process`.

## 3. Sandbox lessons learned (so the next session does not repeat them)

| Symptom | Cause | Rule |
|---|---|---|
| Network works only for some hosts | Earlier sessions: allow-list of npm registry, PyPI, GitHub, Ubuntu archives (the egress proxy answered `403` for everything else). The Nov 2026 session reached public sites too (4kHdHub, enc-dec.app, api.wing.st), which made the live provider checks in section 18 possible; BDIX is never reachable | Use mocks for all tests either way (the E2E harness answers or aborts the online providers' hosts); use `curl --noproxy '*'` for localhost |
| A live check of a browser feature passed in Node but the feature failed in Chromium | Node's `fetch` sends no `Origin`; browsers always do on cross-origin requests (the Fendrix CDN refuses those) | Verify browser-facing network behaviour in the browser (or in a mock that copies the server's header rules) |
| `mkdir -p a/{b,c}` created a literal directory named `{b,c}` | `/bin/sh` is dash: no brace expansion | List paths explicitly or use Node/Python |
| A verification one-liner printed nothing after its first command and reported `Syntax error: "(" unexpected` | dash also lacks `<( ... )` process substitution, and the syntax error aborts the **entire line**, so later checks silently do not run | Use temp files, or run the script with `bash script.sh` / `bash -c '...'`. After any check, confirm its expected output lines actually appeared: no output is not a pass |
| A background server vanished between tool calls | Processes do not persist across calls | Start servers **inside the same call** or use a Node orchestrator script that spawns, waits, asserts and kills (see `e2e/cloudflare-smoke.mjs`) |
| `pkill -f name` killed my own shell | The pattern matched the command line of the call itself | Kill by PID or exact process name (`comm`) with a small script; never `pkill -f` on a string present in your own command |
| Orphan `wrangler`/`workerd` made later runs hit the *old* instance (wrong API key in responses) | Port 8799 still bound | Before a Cloudflare run, kill leftover `workerd` by name; the smoke test checks the key it sent upstream, which exposes this |
| Loopback IP aliases (`ip addr add 172.16.50.12/32 dev lo`) and `/etc/hosts` edits disappeared | Environment state is reset | Do not rely on network tricks; make endpoints overridable (`endpoints`, `SERVERS`) and point them at `127.0.0.1` mocks |
| `create_file` refuses to overwrite | Tool behaviour | `rm` first, or use shell redirection |
| Chromium behaved as if CORS were off | `@sparticuz/chromium` default args include `--disable-web-security`, `--allow-running-insecure-content`, `--disable-site-isolation-trials`, `--disable-features=...IsolateOrigins,site-per-process` | `e2e/lib.mjs` filters them out |
| `wrangler pages dev` prints "Unable to fetch the Request.cf object" | No internet | Harmless; run with `--log-level=warn` |
| `/_headers` returned 502 under wrangler | Dev server probes `/_headers/index.html` | Dev artifact; Pages does not serve those special files |

## 4. Test layers

| Layer | Command | Count | Runs in | Needs |
|---|---|---|---|---|
| Unit and integration | `npm test` | 70 | Node | nothing external |
| Browser end-to-end | `npm run e2e` (`npm run e2e -- <word>` runs matching steps) | 25 steps | headless Chromium 153 | `npm run e2e:media` once (ffmpeg) |
| Cloudflare runtime | `npm run smoke:cf` | 8 checks | wrangler → workerd | nothing external (mock TMDB is started by the script) |
| Docs vs code | `npm run check:docs` | about 40 checks | Node | runs `npm test` internally |

Typical durations: unit about 3 s; E2E 3-4 minutes; Cloudflare smoke about 20 s.

## 5. Unit and integration tests

`node --test --test-reporter=spec "test/*.test.mjs"`. Every file below is plain `node:test`.

| File | Covers | Method |
|---|---|---|
| `test/api.test.mjs` | `lib/` (API router, TMDB client, subtitle service) | A fake upstream `fetch` records every call. Checks: 5-row aggregation and slimmed payload; persons and posterless items dropped; exactly one upstream call per row; key sent as `api_key` (v3) or `Bearer` (v4) and **never in any response**; missing key → 501; `/health` without secrets; validation (400) and error mapping (404, 401→502, 429→503); OpenSubtitles query is lowercase + alphabetical, TV uses `parent_tmdb_id`; Stremio fallback maps 3-letter codes and filters hosts; subtitle download flow (login, download, gzip link); SSRF guards (non-https, suffix look-alikes, wrong hosts); edge proxy allow-list including `user@host`, ports, look-alike domains; `APP_NAME` sets the OpenSubtitles User-Agent |
| `test/gateway.test.mjs` | `gateway/bdix-gateway.mjs` | HLS mode (`/s?hls=1`) against a CDN that 404s any Origin: master/variant/`URI=` attributes rewritten with token and headers, relative and absolute URIs, segments byte-exact, Range passed through, no Origin upstream; rewritten child URLs re-checked by the address policy, token required, oversize playlist refused (also when it arrives in one chunk), no rewrite without `hls=1`. A real gateway and a real mock upstream on loopback. Token enforcement; refuses non-loopback without token; envelope forwarding with header allow-list (cookie and custom headers dropped), UA and per-host Referer injection; CORS origin echo and private-network preflight; Range → 206 with exact bytes; content-type fix by extension; `Content-Disposition` sanitising (CR/LF, quotes, non-ASCII); SSRF matrix (loopback, decimal and hex IPv4, `[::1]`, mapped IPv6 in both forms, NAT64, 10/8, 192.168/16, `localhost`, `file:`, `ftp:`, credentials, redirect into link-local); `classify()` table for IPv4 and IPv6 |
| `test/public-providers.test.mjs` | `providers/fn.js`, `hx.js`, `aesgcm.js`, edge allow-list | The **original** `fendrix.js`/`hexion.js` executed in a `vm` against the same mocks: identical streams and requests (movie/TV, HLS with/without audio renditions, file qualities, WP-API and search paths); deviations (unreadable master, `workers.dev` pages, VC-1); sealed reply survives as bytes, bad tag yields nothing; software AES-GCM equals WebCrypto; no forbidden headers, simple-request POST; gateway bypass and direct media; built-in-HLS ranking; cancel at the first request and mid-chain; hanging fallback endpoint; exact-host edge allow-list incl. look-alikes, ports, userinfo, IP literals |
| `test/mavonyx.test.mjs` | `providers/mx-api.js` (via `mx.js` in the orchestrator), `ctx.response`, DASH/cookie ranking | The **original** `mavonyx.js` executed in a `vm` against the same mock, which verifies every `x-tr-signature`/`x-client-token` with `node:crypto` and refuses bad ones: identical streams (URL, order, labels, quality, headers, captions) and identical requests (also with non-default audio-track, resolution and subtitle toggles) for a movie with dubs (CloudFront and Cloud CDN sign cookies, placeholder, resolution filters, captions), a film found by its original title, a TV episode, and an expired token (refresh and retry); region refusal (403) reports `error`; no forbidden headers; app stream shape; invalid input makes no request; gateway bypass; cancel at the first request and mid-lookup; MD5/HMAC/canonical string vs `node:crypto`; DASH `bad`, sign cookie `warn` |
| `test/sync-merge.test.mjs` | `sync-merge.js`, store sync | Merge: newest copy wins, removals (tombstones) are not undone by older copies, newer watches beat removals, lists (items, renames, deletion vs later edits, My List undeletable), caps; commutative/associative/idempotent on 300 random three-device cases (20 000 run once by hand); hostile input normalized (no gateway token, no prototype pollution); two stores meeting through export/import |
| `test/accounts.test.mjs` | `lib/accounts.js` via `lib/api.js` with D1 on SQLite | No DB = 503; admin bootstrap once from secrets; cookie flags and hashed session ids; CSRF (Origin, JSON only), size limits; invites (hashed, shown once, uses, unlimited, disabled, expired, simultaneous sign-ups: exactly one wins); sign-up rules incl. reserved admin name; no user enumeration; rate limits and their window; password change revokes other sessions; admin-only routes, reset password, remove user, not self; own-account delete, last admin protected; sync per user with optimistic concurrency, normalization, size limit; PBKDF2 format and hash upgrade; sliding 30-day sessions |
| `test/account-sync.test.mjs` | `public/js/account.js` against the real handler | Two simulated devices: sign-up brings device data into the account; lists/removals/settings both ways; a forced conflict (409) merged and retried; no sync loop after applying the account copy; offline error then recovery; sign-out clears the device; signed out elsewhere; accounts off |
| `test/providers.test.mjs` | `public/js/providers/*`, `net.js` | 14 **parity** tests against golden output (section 6); `.mov` deviation; release-name parsing; failure classification (unreachable / error / empty / ok); one provider timing out does not affect others; cancellation; settle window (early return, slow provider aborted); duplicate-URL choice in both arrival orders; transport (gateway envelope, edge proxy URL, direct options, `mediaUrl`, `diagnose` states) |
| `test/client-logic.test.mjs` | `store.js`, `streams.js`, `subs.js`, `util.js` | Settings merge and corrupt-data fallback; storage that throws; history dedupe and cap; resume rules (>30 s and <93 %); progress pruning; My List; clear functions; `browserCaps` from fake `canPlayType`; **playability matrix** (the codec findings in section 9); ranking order; external links (Android intent, iOS callback); `.m3u`; encoding detection (UTF-8, BOM, UTF-16, Windows-1252); SRT→VTT; subtitle style maths; formatting helpers |
| `test/router.test.mjs` | `router.js` | Valid routes; malformed or hostile paths (`/movie/../..`, huge ids, bad escapes) all become not-found; href builders round-trip |
| `test/api-client.test.mjs` | `api.js` | Regression tests for the navigation race (section 12, bug 1): abort during body read rejects with `AbortError`; unreadable 200 body is an error and is not cached; stale-while-revalidate for home |
| `test/brand.test.mjs` | `brand.js`, `scripts/rebrand.mjs` | Static files match `brand.js`; logo exists; **no module hardcodes the name**; rebrand escapes special characters and is idempotent |

## 6. Golden parity with the original scrapers

Goal: prove the browser port behaves like the CloudStream plugin, not merely "looks similar".

Method:

1. `scripts/extension-harness.cjs` loads the **real** `shim-common.js`, `contract-scraper.js` and a scraper from the extension repository into a Node `vm` context in the same order the Android host does (shims → delete `Host` → wrapped scraper → `__call("run", args)`), with a fake `Host` (`meta`, `settings`, `tmdbKey`, `fetch`, `decode`, `encodeUtf8`, `arrayBuffer`, `timer`, `clearTimer`, `done`) that records every request and answers from a callback.
2. `test/fixtures/scenarios.mjs` defines 14 shared scenarios (each: scraper, TMDB `meta`, a `handler` that answers BDIX requests). They deliberately include quirks: first-pattern-escaped-spaces then dotted variants, variant precedence, the unanchored `S01E020` match, punctuation stripping (`Spider-Man: No Way Home`), primary-host failure then fallback IP, slug then `slug-1`, episode cards vs. link fallback, no-match, no-player-marker, all-servers-fail.
3. `EXT_REPO=/path/to/cloudstream node scripts/make-golden.mjs` runs the originals and writes `test/fixtures/golden.json`: for each scenario the streams `{url, quality}` in order **and the sorted list of requests** (`METHOD url body`), excluding the TMDB call.
4. `test/providers.test.mjs` runs the port against the same handlers through a fake `fetch`, with `compat: true` (the original file-extension rules), and requires **identical streams and identical requests**.

The golden file is data recorded from the GPL-3.0 originals (see `NOTICE.md`). Regenerate it only if a provider is changed on purpose, and review the diff.

## 7. Browser end-to-end suite

`e2e/run.mjs` (+ `steps2.mjs`, `steps3.mjs`, helpers in `lib.mjs` and `helpers.mjs`).

### Harness design

* **Chromium** from `@sparticuz/chromium` through `puppeteer-core`, `headless: 'shell'`, flags: package defaults **minus** the security-relaxing ones, plus `--no-sandbox --autoplay-policy=no-user-gesture-required --mute-audio`. Verified with a probe: a cross-origin fetch to a server without CORS headers throws `TypeError` and resolves `opaque` under `no-cors`.
* **Dev server** (`dev/server.mjs`) serves `public/`, applies `public/_headers` (so the real CSP is active) and routes `/api/*` through `lib/api.js` with a mock upstream `fetch` (`dev/mock-upstream.mjs`: TMDB, Stremio subtitles, subtitle files with Latin-1 bytes, FlixHub). This exercises the same router the Cloudflare Function uses.
* **Mock BDIX server** (`createBdixMock` in `e2e/lib.mjs`) on a real socket: DhakaFlix `POST /DHAKA-FLIX-12|14/`, Circle FTP `/api/posts`, and media files with Range support. Flags: `cors` (send CORS headers or not) and `down` (destroy sockets). Every request is logged for assertions.
* **Providers are repointed** at the mock by mutating the exported module singletons (`SERVERS`, `cf.endpoints`) from the page, so the app runs unmodified.
* **Real media**: `npm run e2e:media` generates `test.mp4` (H.264/AAC), `test.mov`, `test.mkv`, `test_ac3.mkv` (AC-3 audio), `test_hevc.mp4`, `test.webm` (6 s) and `test_long.mp4` (150 s, for resume/next-episode).
* **Interception** is limited to `image.tmdb.org` (served as generated SVG posters) and YouTube (aborted). BDIX traffic is **not** intercepted: it goes over real sockets.
* **Failure capture**: any browser `console.error` or `pageerror` (except expected 404/5xx resource noise, and except pages flagged `__expectErrors` for deliberate failure injection) and any `securitypolicyviolation` fails the run.
* **Screenshots** are written to `e2e/screenshots/` (git-ignored) at 390, 820 and 1440 px and for key states; they are reviewed by eye, not compared pixel-wise.

### Steps (38)

| # | Step | Key assertions |
|---|---|---|
| 1 | home | hero and 5 rails in order; person results dropped; **zero requests to BDIX or the edge proxy**; no CSP violations |
| 2-4 | layout at 390 / 820 / 1440 px | tab bar only on phones, top nav and search only from 768 px; no horizontal overflow; first rail peeks above the fold; 2-3 whole posters on phones, 6+ on desktop; tappable poster width |
| 5 | search | live search from the top bar; titles match the query; empty state; phone has its own field and desktop hides it |
| 6 | movie details | TMDB data (runtime, year, genres, 14 cast, recommendations, trailer link `rel=noopener noreferrer`); **no BDIX traffic**; My List persists across reload and shows on the list page |
| 7 | series details | specials hidden, 7 then 13 episodes, season kept in the URL, episode without a still renders, per-episode Play and Download, no BDIX traffic |
| 8 | download sheet | queried only after the click; exactly 4 parallel DhakaFlix POSTs with the expected patterns and JSON content type; Circle search; FlixHub fetched by the browser from the BDIX mock (never through the edge proxy, it is a BDIX server); chips; ticket ranking (best playable first, HEVC last); warnings; `.mov` listed; anchor `href`, `download`, `target`, `rel`; Copy link via the Clipboard API **and** via the `execCommand` fallback; `.m3u` content; Escape closes |
| 9 | play | best **playable** source chosen (not the 2160p HEVC); 640 px wide video; decoded audio bytes > 0; no banner; history saved; no CSP violations |
| 10 | resume | position saved on native pause; Continue watching card shows 40 % bar and `S1 E2`; episode row progress; "Continue S1 E2"; position restored after reload |
| 11 | next episode | control present; ending the file auto-advances to episode 3 and plays |
| 12 | health: HEVC | picking the HEVC source shows the fallback toast and switches to a playing, non-HEVC source |
| 13 | health: AC-3 | no-sound banner appears; confirms 0 decoded audio bytes; "Try another source" switches to a source with audio |
| 14 | MOV and MKV | both play with video and audio although the server sends `application/octet-stream` |
| 15 | subtitles | auto-loaded; `Café` decoded from Latin-1; size doubles, height moves up, colour and box background apply and persist to settings; Bengali search and load; file upload; Off |
| 16 | gateway | settings UI saves URL+token; Test connection reports hosts; lookups arrive with the gateway's Chrome/151 User-Agent and no `Origin`; media streamed via `/s`; Range proxied; download is an attachment with the right file name (206 for a range request); wrong token → 401 |
| 17 | failure UX | servers down: chips and guidance text, "Connection settings" opens settings, watch page shows "No sources found"; CORS-less server diagnosed as `cors` |
| 18 | settings | compat mode hides `.mov`; provider off sends no requests; preference off puts the 2160p HEVC file first; language chips; live subtitle preview; reset |
| 19 | platforms | Android intents (VLC, MX), iOS callbacks (VLC, Infuse) and MKV flagged unplayable on Safari, desktop gets no app links but always an `.m3u` |
| 20 | routes | malformed → "Page not found"; unknown title → "Not found"; bad episode message; bad `?s=` falls back |
| 21 | setup | no TMDB key → setup notice, no hero |
| 22 | performance and a11y | player libraries not loaded on home, loaded on watch; hls.js not loaded for MP4; byte budgets; every control has a name; all images have `alt`; one `h1`; `lang`; skip link first; valid TMDB image sizes only |
| 23 | keyboard | M, C, Space work on arrival (no click first) and again after a sheet closes |
| 24 | race regression | 8 cold navigations home → watch; the player always mounts and no stale error appears |
| 25 | mobile | phone portrait keeps 16:9, 3 toolbar buttons; landscape fits the height; tablet and phone details have no overflow |
| 26 | Fendrix | gateway configured but unused; session + sealed reply answered in the browser, decrypted, POST without Content-Type; local CDN that 404s any request with an Origin: the lookup's own master read is refused, the master is offered and plays through built-in HLS with sound; a page `fetch` of it gets 404; ticket "Fendrix (Nebula)" |
| 27 | Fendrix without built-in HLS | `canPlayType` hides HLS like Firefox: without a gateway the ticket is "Unlikely to play here" with the gateway hint; with the real gateway it plays through hls.js (Media Source, sound decoded), playlists fetched via `/s?hls=1`, variant and segments reach the Origin-refusing CDN without an Origin, no banner |
| 28 | Fendrix without built-in HLS, no gateway (the reported bug) | watch page: hls.js is refused by the CDN, the player stops spinning and says so (`.rh-fail`), the banner gives the reason (built-in HLS or gateway) and the external-player `.m3u`, all within 12 s (measured < 1 s); phone width has no overflow |
| 29 | Hexion | 4kHdHub chain (search, wrapper, HubCloud, file page) through the edge proxy; one ticket "Hexion (FSL)" with size tag, interstitial link ignored; nothing downloaded during lookup; plays from the file host (HTTP cache off: edge replies are cacheable) |
| 30 | Hexion blocked at the edge | the mock site answers like the live one does to Cloudflare (403 "error code: 1106"): chip "Hexion: needs gateway", notice "This source needs the gateway here" with the gateway hint |
| 31 | Mavonyx | gateway configured but unused; the MovieBox hosts are answered in the browser with the live CORS shapes (`api3`/`h5-api`: Origin echoed, requested headers allowed, `expose-headers: *`; `apig`: only `allow-origin: *`, so Chromium hides its token header and the page takes the web API's token); CORS preflights made and answered locally; every signed request verified with `node:crypto` (Chromium sends Accept/Content-Type unchanged and its own User-Agent); token read from `x-user` and sent; web API MP4 plays with sound; Sources sheet: "Mavonyx: 2 found", MP4 recommended, 2160p DASH "Unlikely to play here" with the DASH and cookie reasons; no BDIX lookups; no CSP violations. Settings → Test connection: Mavonyx row "reachable (token via web API)". Control on a phone: no readable token anywhere, app and web search both refused, chip "Mavonyx: server error"; the message fits the stage |
| 32 | online + BDIX down | BDIX guidance shown, plus the hint that the online sources did not answer either |
| 33 | history | remove from Continue watching, Undo restores in place, removal saved; History page: remove, Clear (Cancel keeps, confirm empties; count is current) |
| 34 | lists | save sheet: switch per list, create list (duplicate name refused inline), saved state; Lists page: rename, remove with Undo, My List undeletable, delete with confirmation; list rails on home; phone without overflow |
| 35 | accounts | admin first sign-in from secrets; Admin page; invite generated (shown once) and listed; second profile signs up (wrong code and mismatched passwords explained), invite then shown used; no Admin link for users |
| 36 | sync | two profiles of one account: list and history arrive; a removal on one reaches the other and its open page redraws; sign-out confirms, clears the device, ends the session |
| 37 | passwords + admin | password change (wrong current refused) signs out the other profile; non-admin refused (page and API); admin reset gives a working temporary password and signs the user out; invite disabled; user removed (signed out); admin page on phone |
| 38 | accounts off | without a database the site works and Settings has no Account section |

## 8. Cloudflare runtime smoke test

`e2e/cloudflare-smoke.mjs` (`npm run smoke:cf`): starts a mock TMDB on port 8765, spawns `wrangler pages dev public --binding TMDB_API_KEY=... TMDB_API_BASE=http://127.0.0.1:8765/3` on port 8799, waits for readiness, asserts with `fetch`, then kills both.

Checks: static site served with the real `_headers` (CSP, `nosniff`, `no-referrer`); vendor files `immutable`; `/api/health` without secrets; `/api/home` through the Function with the key sent upstream (and the **expected** key, which detects an orphaned old instance) and never returned; title/season/search/recs; subtitle search degrades to an empty list when its upstream is unreachable; subtitle id and host validation; error statuses and method gating; edge proxy allow-list. This proves the Function bundles with its `../../lib` imports and runs on `workerd` (different globals from Node).

## 9. Experiments that are not tests

| Experiment | Method | Result |
|---|---|---|
| Codec and container support in a browser | ffmpeg-generated files served with Range under several `Content-Type`s; played with `video.play()`; read `videoWidth` and `webkitAudioDecodedByteCount` (Chromium 153) | MP4 H.264/AAC plays; MOV and MKV (H.264/AAC) play under every Content-Type even though `canPlayType('video/quicktime')` is `""`; HEVC → 0×0 picture, no error; AC-3 audio → 0 decoded bytes, no error |
| Player landscape | npm registry: `npm view <pkg> version time.modified deprecated dist-tags`; read package docs | Plyr and Vidstack deprecated; Video.js 10 is `latest` (v8 is `latest-8`); ArtPlayer 5.4.0 (releases Sep 2025, Nov 2025, Mar 2026) |
| Player size | esbuild bundles: Video.js 10 `video/player` + `video/skin`; ArtPlayer `dist/artplayer.js` | Video.js 10 default skin 573 KB / 125 KB gz (core 341 KB, skin 199 KB); ArtPlayer 134 KB / 35 KB gz (our bundle 141 KB / 36 KB gz); hls.js light 369 KB / 117 KB gz |
| Font choice | compared latin variable woff2 sizes | Bricolage Grotesque 41 KB, Sora 34, Outfit 32, Figtree 20, Schibsted 47, Instrument Sans 30 |
| Browser rules for private networks | web research (Chrome Local Network Access documentation, Chrome 142+) | Permission prompt for public→private requests; mixed content relaxed for private **IP literals** only |
| Cloudflare Pages limits | web research | Functions free plan: 100,000 requests/day, 10 ms CPU; static assets unmetered; Pages serves `index.html` for unknown routes only without a `404.html` (hash routing avoids depending on it) |
| TMDB / OpenSubtitles / Stremio contracts | web research of their documentation and client libraries | endpoint shapes, auth, query rules, image sizes (stills: w92/w185/w300/original) |
| IP classification | Python `ipaddress` for the BDIX addresses | `172.16.50.x` is private; **`15.1.1.50` is public-range** (not covered by the private-network switch) |
| TMDB key placeholder | read `SafeHttp` in the extension | scripts receive a placeholder; the real key is substituted only for `https://api.themoviedb.org:443` |
| CORS under test | `cors-probe` script (removed) | with the packaged flags a cross-origin fetch succeeded (`type=basic`); after stripping them it throws, as in a user's browser |

## 10. Mutation checks

Procedure: edit the code to re-introduce the bug, run `npm test`, confirm exactly the intended test fails, restore the file and confirm green.

| Mutation | Test that went red |
|---|---|
| Subtitle host allow-list regex without the `$` anchor | `sub download: OS flow ... and SSRF guards` |
| Swallow `AbortError` while reading a response body | `REGRESSION: aborting while the body downloads rejects with AbortError` |
| Duplicate-URL rule back to "first wins" | `duplicate URLs from different providers keep the entry that knows the resolution` |
| Fendrix reads the reply with `text()` (the first committed approach) | fendrix parity tests |
| Fendrix / Hexion item stage swallow `AbortError` | both cancel tests / `hexion: cancelling while file pages are still loading` |
| No `direct` bypass of the gateway; `direct` media sent through the gateway | `fendrix: goes straight from the browser even when a gateway is configured` |
| No `workers.dev` acceptance | `hexion deviation: current file pages ...` |
| No `m3u8` container override; file qualities unfiltered | fendrix parity tests |
| No built-in-HLS playability rule | `playability: Fendrix HLS needs built-in HLS ...` |
| Fendrix host added to the edge list | `edge proxy allow-list: ...` |
| Gateway route for Fendrix HLS removed / `hls=1` not added | `mediaUrl: Fendrix HLS goes through the gateway ...` |
| Gateway never rewrites (also run in the browser: E2E step 27 then cannot play) / `URI=` not rewritten / sniffed bytes not put back / no size limit | gateway HLS tests |
| Gateway ignored in ranking | `playability: Fendrix HLS ...` |
| Accounts (16 mutations: Origin check, JSON check, admin role, disabled/used/expired invites, session revocation on password change, bootstrap when an admin exists, reserved admin name, login rate limit, session expiry, sliding expiry, self-removal, cross-user sync read, optimistic concurrency, normalization, Secure cookie) | `test/accounts.test.mjs` (3 were first missed and got tests) |
| Sync engine (conflict not merged, sign-out keeps data, 401 ignored, apply guard removed) | `test/account-sync.test.mjs` (2 were first missed and got tests) |
| Mavonyx: query not sorted / HMAC inner pad 55 / body length in characters / no token refresh / no DASH-first order / `User-Agent` sent / no original-title search / mobile MP4 kept | `mavonyx parity ...` (and the helper, token, header and scenario tests) |
| Mavonyx: no `/api/mavonyx/play` fallback / the original's placeholder date check / Function without the Referer / `detailPath` unvalidated / `http:` stream URLs passed / `codecName` ignored | the edge-fallback, placeholder, `/api/mavonyx/play` and codec tests |
| Mavonyx: no app-MP4 fallback / fallback without the resolution filter | `a track whose only stream is the app API's MP4 keeps it ...` |
| Mavonyx trace and the JSON-code check | `mavonyx trace (Settings) ...`, `mavonyx diagnose: an HTTP 200 carrying an error code ...`; E2E step 31 reads the trace in Settings |
| Mavonyx: no app-host token step / no stop after the app API refused the web token | `app token hidden on apig but issued by the app API host` / `once the app API refuses the web token ...` |
| Mavonyx: no web-token fallback / no web-search fallback / no error when nothing answered / web item not used as the subject | the hidden-token, web-search, "no match only when answered" and diagnose tests |
| Mavonyx track stage swallows `AbortError` | `mavonyx: cancelling while the stream lists are loading ...` (first survived: the cancel test aborted at the token request; this test was added) |
| Wait for every endpoint (`Promise.all`) again | `fendrix: a hanging fallback endpoint does not hold back ...` |
| Player watchdog armed on ArtPlayer `ready` again / fatal hls.js errors not reported (each alone) | E2E step 28 (`fendrix without built-in HLS and no gateway ...`) |
| FlixHub marked `edge` again / `flixhub.net` back in the default edge list | `FlixHub is a BDIX server ...` / both edge allow-list tests |
| No `blocked` class in `classify()` / `blockedByCloudflare()` always false / its status guard removed | `failure classification: ... "blocked"` / `edge proxy: a Cloudflare block ...` (the status-guard mutant first survived; the `/ok-lookalike/` case was added for it) |

Also exercised the other way round: editing `brand.js` without running `npm run rebrand` makes `brand: index.html and the web manifest match ...` fail.

## 11. Stress runs

| Run | Result |
|---|---|
| Cold start: fresh Chromium and servers, navigate home → watch immediately, 5 times | **2 of 5 failed** ("Cannot read properties of null (reading 'hero')"; the watch page was overwritten) → bug 1 |
| Same, after the fix, 10 times | 10 of 10 passed (about 1.7-2.1 s to playing) |
| Warm: 5 consecutive watch loads | player mounted in 168-325 ms; video playing in 1.2-1.7 s |
| Step 24 in the suite | repeats the race 8 times on every full run |

## 12. Bug log

Found by testing (not by review), with how it was found and what keeps it fixed.

| # | Bug | Found by | Fix | Guard |
|---|---|---|---|---|
| 1 | Navigation race: aborted body read resolved `null` (and was cached); stale home view crashed and overwrote the watch page | cold-start stress | errors propagate; per-navigation view container | `api-client` tests, E2E step 24 |
| 2 | Gateway SSRF: IP-literal hosts skip Node's `lookup` guard | review while writing the gateway test matrix | validate literals up front | gateway SSRF test |
| 3 | Gateway SSRF: `[::ffff:127.0.0.1]` is normalised to `::ffff:7f00:1` and was classed public | test failure | IPv6 parsed to bytes (mapped, NAT64, 6to4) | gateway tests, `classify()` table |
| 4 | Copy link failed on plain-http sites; the fallback textarea was inert inside a modal `<dialog>` and unfocused | E2E | attach inside the open dialog, focus it | E2E step 8 (both paths) |
| 5 | Resume position not saved on native pause (media keys, headset) | E2E | listen to `video:pause` | E2E step 10 |
| 6 | Keyboard shortcuts dead: wrong key identifiers (`'m'` vs `'KeyM'`) and ArtPlayer enables them only after a click in the player | E2E | `KeyM/KeyC/KeyF`; focus on ready and after sheets | E2E step 23 |
| 7 | "Box" subtitle background did nothing | E2E (looked at the screenshot) | CSS rule consuming `--rh-sub-bg` | E2E step 15 |
| 8 | Invalid TMDB still size `w780` | review of TMDB sizes | `[185, 300]` | E2E step 22 (size allow-list) |
| 9 | Same file from two providers lost its resolution depending on response order | E2E ticket count | keep the entry with the best known resolution | providers test, both orders |
| 10 | `DDP5.1` not recognised in audio label | unit test | tolerant patterns | providers test |
| 11 | Slow or dead provider delayed playback | design review while writing the gateway step | settle window | providers test |
| 12 | E2E browser had CORS disabled | probe of `type=basic` for a cross-origin response | strip flags in the harness; rerun everything | harness comment, section 7 |
| 14 | Fendrix could never return streams: binary reply read as text (78 U+FFFD in 194 bytes); `AbortError` swallowed | live probe; cancel test | `ctx.bytes()`; `unlessAbort()` | parity + mutation tests |
| 15 | Fendrix returned nothing in real browsers: its master-playlist read carries an Origin, which the CDN refuses | E2E with a CDN copying the live header rule | offer the master; built-in HLS plays it | E2E step 26, unit deviation test |
| 16 | Hanging fallback endpoint stalled Fendrix to the timeout; the abandoned request caused an unhandled rejection | harness quirk (CDP cannot send 530) → unit test | prefer-first wait; mark slots handled; orchestrator aborts a provider's leftovers when it answers | unit test + mutation |
| 17 | Hexion: no `DOMParser` outside a browser, swallowed aborts, none of today's file hosts recognised | unit tests; live run (original finds 0) | port on injected `DOMParser`; `unlessAbort`; documented deviation | parity, deviation, cancel tests |
| 18 | `imdbId` missing from the lookup meta (watch and details pages) | review against the originals' inputs | pass `d.imdbId` | providers use it in tests; E2E step 29 (search path) |
| 19 | Off-BDIX with an online source answering "error": guidance said "No matching files" instead of explaining BDIX | tracing the failure-UX step | BDIX and online groups judged separately | E2E steps 17 and 28 |
| 21 | Gateway HLS: a playlist arriving in a single chunk skipped the size limit | gateway safety test | limit checked on the total | gateway test + mutation |
| 22 | Sync merge was not commutative: a tombstone with time 0 kept from one side, dropped from the other | property test (300 random cases) | absent-or-newer rule | property test |
| 23 | Clear-history confirmation counted the titles shown when the page was drawn (also "1 titles") | E2E step 32 | count at click time, singular | E2E step 32 |
| 24 | Home JS over budget (195 KB > 170 KB) after adding accounts | E2E step 22 | Settings and Admin load on first use (165 KB) | E2E step 22 |
| 25 | Sync merge dropped items and lists whose time was 0 although no tombstone existed (an empty My List, old data) | a new test written for another reason; convergence properties cannot see it | only an existing tombstone removes | regression test + mutation |
| 26 | A stored document with `__proto__` keys could set an object's prototype during merge | review | such keys are skipped | test |
| 27 | UI review by a separate checker (calibrated on a planted difference first): History page showed no empty state after removing the last title; Delete account submit was primary; Admin h1 to h3; admin load errors without retry; copy failure shown as success; Undo 36 px and timed; two wordings of Clear history; Settings Clear history without confirmation; identical "See all" names; focus lost after Undo | ui-consistency check (3 rounds) | all fixed; Undo toasts now persist until used/dismissed/replaced/navigation; keyboard removal focuses Undo, Undo focuses the restored title | E2E steps 32-33 |
| 28 | **Endless spinner** when the first source never loads (reported: "Fendrix: 1 found" but nothing plays). The health monitor (and its 25 s timeout) was armed on ArtPlayer's `ready`, which is the first `canplay`; and hls.js failures never fire `<video>` `error`. Without built-in HLS, hls.js asks the Fendrix CDN with an Origin, gets 404, and nothing reported it | user report; reproduced live in Chromium with built-in HLS hidden (45 s at `readyState 0`, no banner) | watchdog armed at creation; fatal hls.js errors reported; the player says it gave up; the banner names the reason | E2E step 28 + 2 mutations |
| 29 | **FlixHub treated as a public site** and sent through the Cloudflare edge proxy. The original manifest says "FlixHub FTP: BDIX"; `flixhub.net` resolves to a Bangladeshi address; the deployed proxy answered 504 after 10 s, and the Download sheet waited for it | user report (Test connection: FlixHub unreachable while DhakaFlix was reachable); live check of the deployed `/api/proxy` | `group: 'bdix'`, no edge, removed from `DEFAULT_EDGE_PROXY_HOSTS`; the e2e BDIX mock serves its pages | unit + E2E step 8 |
| 30 | **Hexion reported as "server error"** on the deployment: from Cloudflare's network `4khdhub.one` answers 403 "error code: 1106" and `hubdrive.blog`/`hubcloud.mov` a 403 bot challenge, so the edge proxy can never work for it | live check of the deployed `/api/proxy` (Nov 19, 2026) | the proxy marks Cloudflare blocks (`x-upstream-blocked`), new provider state `blocked` ("needs gateway") with an explanation | unit + E2E step 30 |
| 31 | App JS over budget (170.2 KB) after these fixes | E2E step 22 | shorter comments (the reasons are in IMPLEMENTATION) | E2E step 22 |
| 20 | E2E not hermetic once online providers existed: gateway step reached live FlixHub/Hexion; edge replies cached across steps | console error + step time (27 s → 2.5 s) | harness answers/aborts provider hosts; endpoints pointed at the mock; cache off in the Hexion steps (29, 30) | harness |
| 13 | UX polish: hero hid the first rail; toolbar wrapped; notice headings dim inside sheets; subtitle tooltip ran into its label | screenshot review | CSS and label changes | screenshots, E2E step 25 |

Test-side mistakes (not product bugs) were also found and corrected, e.g. a tautological assertion, a selector that matched the wrong button, ICU naming `bn` "Bangla", counting tickets after URL de-duplication, an orphaned `wrangler`. They are listed so the same traps are recognised quickly.

## 13. Latest results

| Suite | Result |
|---|---|
| `npm test` | 159 tests pass |
| `npm run e2e` | 38 steps pass; no browser console errors (steps 26-28 allow exactly the fallback endpoint's CORS error, and step 28 the CDN's refusal of hls.js, which is the case under test); no CSP violations |
| `npm run smoke:cf` | 9 checks pass |
| `npm run check:docs` | passes |
| Clean-room reproduction | extract the zip, `npm ci`, `npm test`, `npm run build:vendor` (bundles identical to the committed ones), `npm run e2e:media`, `npm run e2e`, `npm run smoke:cf` |

Measured on the home page (desktop, local server, printed by E2E step 22): 73 requests, app JS 170 KB as served to the browser (budget 170 KB: **about 50 bytes left**. Before Mavonyx 740 bytes were left; its stub, registration, ranking rules and meta fields cost about 0.7 KB after condensing some comments in `providers/index.js`, as in bug 31. The next home-page addition needs a structural saving, e.g. loading `providers/index.js` and `streams.js` on the first Play/Download; 229 KB across all 33 modules on disk, 71 KB gzipped; Settings, account screens, Admin and the Mavonyx lookup load on first use), CSS 24 KB, font 40 KB, `DOMContentLoaded` 130-190 ms. Player libraries are not requested on the home page.

## 14. Not verified (and how to verify it yourself)

| Not verified | Why | How to check |
|---|---|---|
| Fendrix and Hexion on a real deployment | checked live from the sandbox in Node and Chromium (section 18); from Cloudflare's edge Hexion is **blocked** (measured, section 18), so on `pages.dev` it needs the gateway; Fendrix playback in your own browser was not observed; not in real Firefox (simulated in Chromium by hiding built-in HLS; with a gateway it plays via hls.js) or on phones | Open a popular title on your deployed site; Settings → Test connection shows both rows |
| Mavonyx against the live API | its mobile API refuses the sandbox's region (403 "Service not available in current region"); the web API answers but has no streams for that region. Real stream lists, formats, sign cookies, caption hosts and whether MP4/HLS play without the cookie were never seen | On your phone/PC in Bangladesh: play a popular title with only Mavonyx on (Settings → Sources); open Sources to see which formats arrive; tell the next session what played and what did not (paste one stream URL with the signatures cut off) |
| Real BDIX servers (DhakaFlix, Circle FTP, FlixHub) | unreachable from the build sandbox; response shapes come from the original parsers | On your network: deploy or run `npm run dev`, open **Settings → Test connection**, then play a title you know exists |
| Real TMDB and OpenSubtitles | blocked from the sandbox; mocked with documented shapes | Set your keys; open Home; play something; check Subtitles |
| A real Cloudflare deployment, edge caching, quotas | the deployed site was only read (public GETs: `/api/health`, `/api/proxy`, section 18); nothing was deployed from here | Deploy; watch the Functions analytics |
| Firefox and Safari | only Chromium was automated | Manual pass: playback, MKV (Safari cannot), subtitles, hotkeys, copy link |
| https `pages.dev` + gateway on `http://127.0.0.1` / LAN, Chrome's permission prompt | tests ran over http on loopback | Follow the README gateway section from your deployed site |
| Real phones and touch gestures | emulated viewport only | Test on your phone: layout, player controls, external-player links |
| Audible sound | measured as decoded audio bytes | Listen once |
| Long sessions, memory | not exercised | Play a full episode |

**Fixed (pre-existing, found Nov 19, 2026):** on a phone the watch page's "No sources found" message overflowed its 16:9 stage and covered the title bar (`.stage .loading` was absolutely centred in the fixed-ratio box). Error messages now carry `.msg`, and a stage holding one grows to fit (`public/css/app.css`); E2E step 31 checks it at 390 px (it failed with 67 px of overflow before the fix).

## 15. Reproduce from scratch

```bash
unzip raftv.zip && cd raftv
npm ci                                              # Node 22+
npm test                                            # 70 tests
npm run build:vendor && git diff --stat public/vendor   # (or compare to the zip) bundles must be identical
pip install imageio-ffmpeg --break-system-packages  # or have ffmpeg on PATH
export FFMPEG=$(python3 -c "import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())")
npm run e2e:media                                   # writes e2e/media/
npm run e2e                                         # 25 steps, ~4 min
npm run smoke:cf                                    # 8 checks; kill leftover workerd afterwards if it fails
npm run check:docs
```

Regenerating golden output (only if a provider changed on purpose): obtain the extension repository (`cloudstream-main.zip`), then `EXT_REPO=/path/to/cloudstream node scripts/make-golden.mjs` and review `git diff test/fixtures/golden.json`.

## 16. Adding or changing tests

* **New provider or provider change** → add scenarios to `test/fixtures/scenarios.mjs`; if the original scraper also changed, regenerate the golden file; otherwise add dedicated tests for the deliberate deviation (like the `.mov` test).
* **New UI feature** → add an E2E step in `steps2.mjs`/`steps3.mjs` using the helpers; assert behaviour (DOM, `localStorage`, requests seen by the mock server), take a screenshot, and look at it.
* **Anything touching networks or addresses** → add a case to the gateway SSRF matrix or the API allow-list tests; try to break it first.
* **Any bug fix** → write the failing test first, see it fail, fix, see it pass; for logic fixes, do a mutation check.
* **Never** weaken Chromium security flags in the harness, and keep `page.__expectErrors` limited to deliberate failure-injection steps.
* After changing code or docs run `npm run check:docs`; update the counts in the docs when tests are added.

## 17. Phase 1: verification of the scraping reference

The earlier deliverable (`EclipsiaBDIX-Scraping-Reference.md`, a description of how the original CloudStream plugin finds and fetches links) was verified separately:

* **Integrity**: `tools/lock_sources.py --check` and a manual SHA-256 comparison of the 5 JS files against `sources.lock.json`; the repository's own `tools/lint_js.mjs` (acorn, ES5 rules) and `tools/validate_sources.py`.
* **Execution**: the real shims and scrapers were run in a Node `vm` with a fake `Host` (the harness later reused here); 7 scenarios (DhakaFlix movie/TV, Circle FTP with primary host down, FlixHub, invalid input) with assertions on requests and output.
* **Independent re-implementation**: a stdlib Python client of the three providers was run against a local mock server and compared with the real scrapers' output on identical data (6 of 6 identical, POST body byte-identical).
* **Document drift check**: 39 literals (limits, URLs, constants) checked present in both source and document.
* **Corrections made along the way**: `15.1.1.50` is not a private address; all four DhakaFlix POSTs are always sent; the scrapers' hardcoded TMDB key is dead code under the plugin's host.

## 18. Live checks of the online sources (Nov 18-19, 2026)

Done by hand from the sandbox, not part of any test (tests never reach the internet). TMDB answers were supplied locally (no third-party key was used); everything else was real.

| Check | Result |
|---|---|
| Original `fendrix.js`, Inception and Breaking Bad S01E01 | 1 stream each (1080p HLS variant); `api.shegu.st` 530, `api.wing.st` 200 |
| Port `fn.js` in Node, same titles, gateway configured | identical streams and the same 7 requests; gateway not used |
| `/g` with a foreign Origin, no headers, `text/plain` | 200, `ACAO: *`, preflight allowed; WebCrypto decrypts the reply; `text()` corrupts it |
| HLS CDN with Origin `https://*.pages.dev`, `http://localhost`, `https://example.com` / none / cinejoy | 404 / 200 / 200 |
| Chromium 153 `<video src=master.m3u8>` | `canPlayType` "maybe", 1280x720 metadata, no Origin on media requests |
| Original `hexion.js`, Inception | **0 streams** (file pages now link `*.workers.dev`) |
| Port `hx.js` through the real `/api/proxy` handler (Node) | Inception 7 streams (2160p/1080p, 6.6-66 GB), Breaking Bad S01E01 4 streams incl. one signed R2 URL |
| `*.workers.dev` file links, 1 KB range | one `206 video/x-matroska`, `ACAO: *`; six `403` "download quota exceeded" (upstream Google Drive quota) |
| `pixel.hubcloud.*` link | redirects to an HTML download interstitial, not a file (skipped) |

**Nov 19, 2026 (bug report: Fendrix found but never plays, Hexion and BDIX unreachable).** Public GETs only, against the owner's deployment and the live hosts:

| Check | Result |
|---|---|
| Fendrix CDN (master, variant playlist, `init.mp4`, segment), 100-byte range | no Origin 206; Origin `https://cinejoy.pk` 206; Origin `https://raftv.pages.dev` **404**: an Origin allow-list, not "any Origin" |
| Fendrix in Chromium 153 (`canPlayType` HLS "maybe"), real lookup, The Matrix | plays the master via built-in HLS (1920 px, 36 s played) |
| Same with built-in HLS hidden (Firefox-like, no gateway), before the fix | hls.js refused (404 shown as CORS), video at `readyState 0` after 45 s, **no banner**: the reported hang. After the fix: explained in about 1 s |
| Deployed `/api/proxy` → `4khdhub.one` (search, movie page, WP API) | **403 "error code: 1106"** (Cloudflare-to-site block) |
| Deployed `/api/proxy` → `hubdrive.blog`, `hubcloud.mov` | **403 "Just a moment..."** challenge; `gamerxyt.com` 200 |
| Deployed `/api/proxy` → `flixhub.net` | 504 after 10 s; `flixhub.net` resolves to 103.123.169.192 (Bangladesh), unreachable from the sandbox too |
| Hexion port through the **real gateway** (Node, sandbox connection), The Matrix | 8 streams in 3.4 s |
| Original bdix-df/cf/fh files vs. the plugin's assets in `eclipsia-bdix` | identical (the golden parity test runs these) |

**Nov 19, 2026 (Mavonyx / MovieBox).** From the sandbox (US egress, CloudFront POP IAD), before porting:

| Check | Result |
|---|---|
| Original `mavonyx.js` in Node, Inception | 0 streams: token request `apig.inmoviebox.com` 403, `search/v2` on `api3.aoneroom.com` 403 |
| Those hosts, plain GET | **403 `{"message":"Service not available in current region"}`** (CloudFront / Envoy): region gate, not a signature error |
| `h5-api.aoneroom.com` `/wefeed-h5api-bff/subject/play` | 200, `x-user` token header; `/subject/search` with that token finds Inception; `play` for it: `streams: []`, `hasResource: false`, `maxResolution: 480` |
| Preflight to `api3.aoneroom.com` and `h5-api.aoneroom.com`, Origin `https://raftv.pages.dev`, all signed headers requested | 200, that Origin echoed, every requested header allowed, `expose-headers: *`, `allow-credentials: true`, max-age 86400 |
| `mavonyx.js` vs the copy in the plugin's assets | identical |
| Preflight + GET to `apig.inmoviebox.com` with Origin `https://raftv.pages.dev` (checked after the owner saw "no match") | preflight: `allow-origin: *`, `allow-headers: *`, methods GET; response: `allow-origin: *` and **no `expose-headers`**: the `x-user` token is invisible to a page (the earlier check covered only `api3` and `h5-api`) |
| `h5-api.../subject/play` for Inception (anonymous token), Referer variants (after the owner's trace showed the placeholder video) | none / our domain / site root / `/movies/x?id=` / UA only: `hasResource: false`, 0 streams. `https://movie-box.co/movies/<detailPath>?id=...` (also `themoviebox.xyz`, `h5-api...`, and without `?id`): 1 stream `bcdnxw.hakunaymatata.com/tran-audio/...mp4?sign=...` 1080p `codecName: h264`, also without any token. Origin header irrelevant. Breaking Bad S1E1: 4 H.264 files 360-1080p |
| `hakunaymatata` file, 100-byte range from the sandbox | 429 without Referer, 428 with the movie Referer (`text/html`), `ACAO: *`: blocked for this IP either way; untested from Bangladesh |
| Web API search items (Breaking Bad, Pathaan) | same fields as the app API's (`subjectId`, `subjectType`, `title`, `releaseDate`, `imdbRatingValue`, `detailPath`, `dubs`); TV listed per season under one `subjectId` |

## 19. Accounts in the real Cloudflare runtime

`npm run smoke:cf` starts `wrangler pages dev` with a throw-away local D1 database (`--d1 DB --persist-to <temp dir>`) and checks, inside `workerd`: admin bootstrap with PBKDF2 at 100 000 iterations, invite creation, sign-up, a second sign-up with the same single-use code refused, sync write and read, a non-admin refused on admin routes, a cross-site Origin refused, `no-store` on account responses. Not verified: a real D1 database on Cloudflare and the free plan's CPU limit for hashing (see README *Accounts*).
