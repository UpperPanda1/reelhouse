# RafTV: implementation notes

How the site was built, which technologies it uses and why, what was measured, what was verified, and what was not. Companion to the [README](../README.md) (setup and deployment) and to the separate *EclipsiaBDIX scraping reference* (how the original CloudStream plugin finds and fetches links).

Contents: [1 Goals](#1-goals-and-constraints) · [2 Architecture](#2-architecture) · [3 Technologies](#3-technologies-and-why) · [4 Data loading](#4-loading-recommended-and-trending-titles-efficiently) · [5 Click-to-stream](#5-click-to-stream-flow) · [6 Providers](#6-the-bdix-providers-port) · [7 Connectivity](#7-connectivity-what-a-browser-can-and-cannot-do) · [8 Player choice](#8-choosing-the-player) · [9 Playback robustness](#9-playback-robustness-measured-in-a-real-browser) · [10 Subtitles](#10-subtitles) · [11 UI and design](#11-ui-and-design-system) · [12 Security](#12-security-model) · [13 Verification](#13-verification) · [14 Performance](#14-performance) · [15 Limits](#15-known-limitations-and-what-was-not-verified) · [16 Licensing](#16-licensing-and-terms) · [17 Extending](#17-extending)

---

## 1. Goals and constraints

| Requirement | How it is met |
|---|---|
| Host on Cloudflare Pages | Static `public/` folder + one Pages Function (`functions/api/[[path]].js`); no build step on Cloudflare (player and font are committed under `public/vendor/`) |
| Modern, streaming-service look; fast; little animation | Dark UI with hero, poster rails and a bottom tab bar on phones; no framework; motion only in response to a tap (sheet slide, press state); skeletons are static; `prefers-reduced-motion` respected |
| Phone, tablet, desktop | One responsive layout driven by CSS variables (`--card-w`, `--pad`) and three breakpoints (560, 768/820, 1280 px); verified at 390, 820 and 1440 px |
| Recommended and trending titles loaded efficiently from TMDB (free key) | One aggregated, trimmed, edge-cached `/api/home` request (section 4) |
| Details, seasons, episodes from TMDB | `/api/title/{type}/{id}` (one TMDB call with `append_to_response`) and `/api/season/{id}/{n}` on demand |
| Query BDIX like the extension, only on click; separate download button | Providers run only from the watch page and the sources sheet; asserted in the browser tests (zero BDIX requests until a click) |
| Efficient built-in player: MP4/MOV, subtitle size/appearance, OpenSubtitles | ArtPlayer, chosen from measurements (section 8); subtitle pipeline in section 10 |
| Document the build | This file |

*Interpretation note:* the request said "customize extension size, appearance, fetch extensions from opensubtitles". This was read as **subtitle** size/appearance and fetching **subtitles** from OpenSubtitles.

## 2. Architecture

```
 Browser (static files from Cloudflare Pages)                      Cloudflare Pages Function  /api/*
 ┌──────────────────────────────────────────────────┐             ┌──────────────────────────────────┐
 │ hash router ─► views (home, details, watch, ...) │  /api/...   │ lib/api.js  (router)             │
 │ store.js   (localStorage: settings, history,     │────────────►│  ├ lib/tmdb.js   TMDB (key stays  │──► api.themoviedb.org
 │             progress, lists, account sync)       │             │  │   server-side, edge-cached)    │
 │ providers/ (BDIX: DhakaFlix, Circle FTP, FlixHub;│             │  ├ lib/subs.js   OpenSubtitles /  │──► opensubtitles.com
 │   Fendrix ─► enc-dec.app, api.wing.st, CDN;      │             │  │   Stremio addon, SSRF-guarded  │──► opensubtitles-v3.strem.io
 │   Hexion via /api/proxy)                         │             │  │                                │
 │ net.js     direct | gateway | edge transport     │             │  │                                │
 │ player.js  ArtPlayer (lazy)                      │             │  └ /api/proxy    allow-listed     │──► 4khdhub.one chain (blocks Cloudflare)
 └───────┬──────────────────────┬───────────────────┘             │      public hosts only            │
         │ only after a click   │                                 └──────────────────────────────────┘
         ▼                      ▼
   BDIX servers directly   optional gateway (your network) ─► BDIX servers
   (needs CORS + permission)   Referer/UA, CORS, Range, downloads
```

Principles: (1) **secrets only in the Function**; (2) **BDIX traffic never touches Cloudflare**, because Cloudflare cannot reach private BDIX addresses; (3) **one code path** for the API (`lib/`), shared by the Function, the dev server and the tests; (4) **each view owns its DOM** (section 13, bug 1).

## 3. Technologies and why

| Layer | Choice | Reason |
|---|---|---|
| UI | Vanilla ES modules, `h()` element builder, hash router | No framework runtime (about 37 KB gz of app JS in total); all text goes through `textContent`, so TMDB or file-name strings cannot inject markup; hash routes need no SPA rewrite rules on any static host |
| Styling | One CSS file with design tokens (CSS variables) | 5 KB gz; no build step |
| Font | Bricolage Grotesque variable, latin subset, self-hosted (41 KB) | Distinctive heavy display weights for titles, readable at UI sizes; one family, `font-display: swap`, preloaded |
| API | Cloudflare Pages Function (Workers runtime) | Hides the TMDB key; edge cache; scoped to `/api/*` by `_routes.json` |
| Player | ArtPlayer 5.4.0 (MIT), hls.js 1.7.4 light (Apache-2.0, lazy) | Section 8 |
| Gateway | Node 22, `node:http`, zero dependencies | Easy to run anywhere on a BDIX network |
| Tests | `node:test`; Puppeteer + Chromium 153; wrangler/workerd | Real browser, real sockets, real runtime |
| Bundling | esbuild, only for `public/vendor/` | Output is committed and versioned (`artplayer-5.4.0.js`), so it can be cached as `immutable` |

## 4. Loading recommended and trending titles efficiently

TMDB is free for non-commercial use with an API key and attribution (the footer carries the required notice).

* **One request for the home page.** `/api/home` makes five parallel TMDB calls inside the Function (trending, popular movies, popular series, top-rated movies, top-rated series), drops everything the UI does not draw (items without posters, people, most fields), and returns one compact JSON document. The browser makes one round trip instead of five.
* **Three cache layers.** TMDB responses are cached at Cloudflare's edge (`cf.cacheTtl`, 15 minutes for trending/popular, 1 hour for top-rated and details); the Function's responses carry `s-maxage`/`stale-while-revalidate`; the browser keeps the home payload in `localStorage` and paints it instantly on the next visit while refreshing in the background.
* **Lazy and personalised.** "Because you watched ..." fetches `/api/recs` only when its row approaches the viewport (`IntersectionObserver`). Cast and recommendations on the details page arrive with the details (`append_to_response=credits,recommendations,videos,external_ids`), episodes load per season on demand.
* **Images.** Posters use `srcset` with TMDB's real sizes (`w185/w342/w500`), `loading="lazy"`, explicit width/height (no layout shift); the hero image is `fetchpriority="high"`. Episode stills use only `w185/w300` (a test caught an invalid `w780` request).
* **Free-plan friendly.** The Function only trims JSON (expected to be well under the free plan's 10 ms CPU per request, though this was not measured on Cloudflare); edge caching means most requests never reach TMDB; static assets are not metered.

## 5. Click-to-stream flow

```
details page ── Play ──► #/watch/movie/603
                         │  1. api.title()                     (TMDB, cached)
                         │  2. resolveStreams() in parallel:   DhakaFlix ×4 POST · Circle FTP · FlixHub · Fendrix · Hexion
                         │     settle window: once any provider has streams, wait ≤1.5 s for the rest
                         │  3. rank(): playable first → resolution → container → provider
                         │  4. createPlayer(best) ─► health monitor ─► fallback / banner
                         └  5. subtitles auto-load (OpenSubtitles) · progress saved every 5 s and on pause
details page ── Download ──► sources sheet: same lookup (waits for all providers), ticket list, no playback
```

* Nothing in steps 2-5 runs while browsing. The browser tests assert that the BDIX mock server has seen **zero requests** after loading home, search and details pages.
* **Settle window.** A dead server can take 15-25 s to time out. Without a window the player would wait for it even when another provider already has a working file. With it, slow providers are aborted and reported as "still searching"; the Sources sheet can still show them later.
* **Failure explanation.** The original extension swallowed every error. Here each provider's result is classified: *ok*, *empty* (servers answered, nothing matched), *error* (HTTP errors), *blocked* (an edge-proxied site refused Cloudflare itself: only the gateway helps), *unreachable* (every request failed at the network level), *timeout*, *slow*. The UI turns that into advice (not on BDIX? mixed content? set up the gateway).

## 6. The providers (port)

Six providers. Three BDIX servers (`df`, `cf`, `fh`) and three online sources (`fn` Fendrix, `hx` Hexion, `mx` Mavonyx, see the end of this section). Each exports a `group` (`'bdix'` or `'public'`), which the UI uses to explain failures.

`public/js/providers/{df,cf,fh}.js` are a browser port of the three scrapers in `eclipsia-bdix` (see the scraping reference for the original algorithms: endpoints, request bodies, filters, scoring).

**How faithfulness was proven.** `scripts/make-golden.mjs` runs the *original* scrapers (via a harness that reproduces the plugin's JS runtime contract) against 14 shared scenarios and records their output **and the exact network calls they make**; `test/providers.test.mjs` requires the port to produce identical streams (URL, quality, order) and an identical sorted list of requests for every scenario. Scenarios include: variant precedence, the unanchored `S01E020` quirk, punctuation stripping, host fallback, slug fallback, episode cards vs. link fallback, and all failure paths.

**Deliberate differences** (all documented in code and tested separately):

| Difference | Why |
|---|---|
| No per-provider TMDB call | The page already has the title and year |
| `.mov`, `.m4v`, `.webm` accepted (switch: "Original file types only") | The original silently dropped `.mov` files |
| Same URL from two providers becomes one entry, keeping the one that knows the resolution | Found by the end-to-end run: "first wins" lost the quality at random depending on which provider answered first |
| FlixHub uses `DOMParser` instead of a hand-written tag scanner | Browsers have a DOM; the parser is inert (scripts never run, nothing loads) |
| Richer release parsing (video/audio codec tokens) | Drives the playability prediction in section 9 |
| Browsers cannot send `User-Agent`/`Referer` | The gateway adds them (section 7) |
| Endpoints are overridable objects | Lets tests and advanced users repoint servers |

Provider endpoints: DhakaFlix `http://172.16.50.12` and `.14` (JSON `POST`), Circle FTP `http://new.circleftp.net:5000` with fallback `http://15.1.1.50:5000` (REST `GET`), FlixHub `https://flixhub.net` (HTML watch pages). **FlixHub is a BDIX server** (`group: 'bdix'`): the original manifest calls it "FlixHub FTP: BDIX" and `flixhub.net` resolves to a Bangladeshi address (103.123.169.192) that the public internet cannot reach. Until Nov 19, 2026 the port treated it as a public site and sent it through the Cloudflare edge proxy, which answered 504 after 10 s (measured on the deployment); it now goes straight from the browser or through the gateway like the other BDIX servers.

### Online sources: Fendrix and Hexion

`public/js/providers/fn.js` (Fendrix) and `hx.js` (Hexion) port the eclipsia `fendrix.js` and `hexion.js` scrapers (copies under `cloudstream-main/cloudstream/providers/`). Both use public HTTPS only; neither needs a BDIX network or the gateway.

**Measured against the live services (18-19 Nov 2026, from the build sandbox; Node fetch and Chromium 153):**

| | Fendrix (Cinejoy/Shegu) | Hexion (4kHdHub) |
|---|---|---|
| Lookup chain | `enc-dec.app/api/enc-cinejoy` (session) → `POST api.wing.st/g` (AES-256-GCM sealed JSON) → master playlist | `4khdhub.one` (WP API by IMDb id, else `/?s=`) → link wrapper (`greenmotors.club`, base64+ROT13) → `hubdrive.blog` / `hubcloud.mov` → file page `gamerxyt.com/hubcloud.php` |
| CORS | `Access-Control-Allow-Origin: *` on the session broker and `/g`, any Origin accepted, preflight allowed | none on any hop |
| Transport chosen | **direct from the browser** (`direct: true`), even when a gateway is set | **edge proxy** (`edge: true`), or the gateway when set. From Cloudflare's network the sites refuse the proxy (19 Nov 2026: `4khdhub.one` 403 "error code: 1106", `hubdrive.blog`/`hubcloud.mov` 403 bot challenge), so **on a deployment Hexion needs the gateway**; the proxy marks such replies (`x-upstream-blocked`) and the app shows "Hexion: needs gateway" |
| Fallback endpoint | `api.shegu.st` answers 530 without CORS (logged by the browser as a CORS error; harmless) | - |
| Media | HLS whose playlists and segments are named `.jpg` and served as `image/jpeg`; the CDN answers **404 to any request whose `Origin` is not its own site** (`https://cinejoy.pk`); requests without an Origin are served. A page cannot send either, so every page request (fetch, hls.js) is refused | `*.workers.dev` MKV/MP4 (`206`, `ACAO: *`, no Referer needed), sometimes signed R2 URLs; individual files are often quota-limited upstream (Google Drive "download quota exceeded") |
| Original scraper result today | works | **0 streams**: the file pages no longer link the hosts it accepts |

**Parity.** `test/public-providers.test.mjs` runs the original scraper files unchanged in a `vm` sandbox (their only host capability is `fetch`) against the same mock upstreams as the ports, shaped like the live pages, and requires identical streams (URL, quality, order) and identical requests apart from the TMDB call the port does not need. Movie and TV, HLS master with and without audio renditions, file qualities, WordPress-API and search paths.

**Deliberate differences** (tested):

| Difference | Why |
|---|---|
| Fendrix sends no `Origin`/`Referer`/`User-Agent` and no `Content-Type` on the POST | Browsers forbid the first three; the API accepts any Origin; a bare byte body keeps the POST a CORS simple request (no preflight) |
| Fendrix reads the reply with `ctx.bytes()` and decrypts with WebCrypto; the original's software AES-GCM (`providers/aesgcm.js`) is loaded only without WebCrypto (plain-http LAN use) | `text()` replaces invalid UTF-8 with U+FFFD and destroys the ciphertext (measured: 78 replacement characters in a 194-byte reply) |
| Fendrix: if the master playlist cannot be read, the master itself is offered (quality "Auto") | From a browser it never can (the CDN refuses requests with an Origin); the original would drop the stream. Built-in HLS reads it without an Origin and picks the variant itself |
| Fendrix: once the preferred endpoint (`api.wing.st`) answered, the fallback is not waited for | Same result; a hanging fallback must not hold back, or at the provider timeout discard, a result already in hand |
| Fendrix HLS streams carry `container: 'm3u8'` and `needsNativeHls` | URL extension is `.jpg`; ranking marks them unplayable where the browser has no built-in HLS (section 9) |
| Hexion also accepts `*.workers.dev` file links ("FSL") and reads the size from `<i id="size">` | The current file-page layout; `pixel.<hubcloud>` links are skipped (HTML interstitial, not a file) |
| Hexion keeps the file extension in the name | It is the only format hint for signed R2 URLs without an extension |
| Hexion drops the original's per-resolution/per-host limits and sort tags | The site ranks all sources itself |
| No TMDB call; `imdbId` comes from the title details (`metaFor` in `watch.js`, `metaOf` in `details.js`) | The page already has it |
| Streams of both are marked `direct`: `net.mediaUrl()` sends them through the gateway only in one case (Fendrix HLS, in-page player, no built-in HLS, gateway set) | Public hosts with CORS; HLS through `/s` would also break relative segment URLs |
| VC-1 video is recognised (`describe()`) and flagged unplayable | Several 4kHdHub REMUXes are VC-1, which no browser decodes |

### Online source: Mavonyx (MovieBox API)

`public/js/providers/mx-api.js` ports the eclipsia `mavonyx.js` scraper (copy under `cloudstream-main/cloudstream/providers/`). `providers/mx.js` is a 0.5 KB stub registered in `PROVIDERS` (id, name, group, Settings note); it imports the 29 KB lookup on the first Play/Download, so the home page does not carry it (E2E byte budget).

**Lookup chain (same requests as the original).** Token: signed `GET apig.inmoviebox.com/.../tab/ranking-list`, token read from the `x-user` response header. Then signed `api3.aoneroom.com` calls with `Authorization: Bearer`: `search/v2` (title, plus the original title when different), scored on title overlap, year, IMDb rating and movie/series type (best score >= 40); `subject-api/get` (dubs = audio tracks); per enabled track `play-info` (DASH/HLS; MP4 dropped) in parallel with the web API `h5-api.aoneroom.com/wefeed-h5api-bff/subject/play` (MP4), captions for the first candidate; duplicates by URL removed; stable sort by resolution. Signing: `x-client-token = ts,md5(reverse(ts))`; `x-tr-signature = ts|2|base64(HMAC-MD5(key, METHOD\nAccept\nContent-Type\nbodyLength\nts\nmd5(body)\npath?sortedQuery))`. WebCrypto has no MD5, so the original's MD5/HMAC is ported (tested against `node:crypto`). A 401/441 refreshes the token once and repeats the call. Defaults as the original's settings: 2160p, 1080p and unknown resolutions; tracks Original, English Dub, Hindi Dub; "Arabic Hardsub" never; captions on (`settings` object in `mx-api.js`).

**Measured (19 Nov 2026, from the sandbox):** `apig.inmoviebox.com` and `api3.aoneroom.com` answer **403 "Service not available in current region"** (CloudFront/Envoy) from the US: the mobile API is region-gated, so its stream replies could not be seen. The owner reports lookup and playback working in their browser (Bangladesh). `h5-api.aoneroom.com` answers from the US (token in `x-user`; web search works) but returns no streams there (`hasResource: false`, `maxResolution: 480`). CORS: preflights from `https://raftv.pages.dev` are answered with that Origin echoed, every requested header allowed (`x-tr-signature`, `x-client-token`, `x-client-info`, `authorization`, ...), `access-control-expose-headers: *` and `allow-credentials: true`. With `credentials: 'omit'` (what `net.js` sends) the `*` is a real wildcard, so the page can read `x-user` from those two hosts, **but not from `apig`** (see the correction below). Transport: **direct** (`direct: true`), never the gateway or the edge proxy: the region check is about the caller's IP, and Cloudflare's egress region is not the user's.

**Correction (19 Nov 2026, after the owner's first test showed "no match" everywhere):** `apig.inmoviebox.com` (CloudFront) answers with `access-control-allow-origin: *` but **no `access-control-expose-headers`**, so a page cannot read its `x-user` token; every app-API call then went out without a token and failed, and the provider reported "no match". Deviations since: (1) when the app token is unreadable, the same signed token request is sent to the app API host (`api3`, which exposes every header; unverified live), then an anonymous token is taken from the web API (`h5-api.../subject/play?subjectId=1`, which exposes `x-user`). The owner's Test connection showed "web API only: app API refused (401) (token via web API)": the app API rejects web tokens (their JWT says `atp: 3`, web), and once it has, the lookup stops calling it; (2) when the app API's search gives no usable reply, the web API's search (`POST h5-api.../wefeed-h5api-bff/subject/search`, measured working, same item fields) is scored the same way and its item stands in for the subject detail, so the web API's MP4 streams are found; (3) "no match" only when a search answered, otherwise `error`; (4) Settings → Test connection has a Mavonyx row (`diagnose()`) that names the failing step: region refusal, hidden token ("token via web API"), app API refusing that token ("web API only"), or reachable. Whether the app API accepts the web token is unknown (it refuses this region before checking). Owner's next result: "reachable (token via app host)", yet lookups said "no match"; Test connection therefore also runs a **lookup trace** (`trace()`: a real lookup for Inception with every stage written down: token source, search reply code and results, best match and score, audio tracks, per-track stream formats and resolutions, what the resolution filter kept) with a Copy button, and the row now requires JSON `code 0` (the APIs also report errors inside HTTP 200). The owner's trace for Inception: token via app host, search 17 results, match score 117, 6 audio tracks (2 enabled), app API `play-info` = one unsigned `MP4 1080,720,480` (Hindi: `MP4 480`), web API **0 streams**, so 0 kept: the original drops every app-API MP4 and expects MP4s from the web API, which in CloudStream gets a spoofed User-Agent/Referer a browser cannot send. **Deviation:** when a track would end up empty, the app API's MP4 is kept (resolution filter unchanged, so a 480p-only track stays empty, as in the original). The trace now also logs each web-API reply (HTTP status, code, `hasResource`, `limited`, `maxResolution`) and the MP4's host. Whether that MP4 plays in a browser without the Referer is not yet known.

**Next live result (owner):** the kept app MP4 was `macdn.aoneroom.com/other/2026/10/10/....mp4`, a 10-second announcement, not the film. The original's `isPlaceholderStream` only knows `/other/2026/09/`; the port now treats any dated `/other/` path (not rewritten from a sign cookie) as a placeholder. Real files come from the web API: measured from the sandbox, `h5-api.aoneroom.com/wefeed-h5api-bff/subject/play` returns them (`bcdnxw.hakunaymatata.com/...mp4?sign=...&t=...`, `codecName` h264/hevc; Inception 1080p H.264; Breaking Bad S1E1 360-1080p) **only when the Referer is the movie page on a MovieBox host** (`movie-box.co`, `themoviebox.xyz`, `h5-api...` with `/movies/<detailPath>`; the site root, our own domain, `/movies/x?id=` or the User-Agent alone give `hasResource: false`), and needs no token. Browsers cannot send such a Referer (and this site sends none), which is why the owner's browser got nothing. **Deviation:** the Function route `/api/mavonyx/play` (`lib/mavonyx.js`) asks the web API with the original's Referer and User-Agent; the client calls it only when its direct web calls found nothing, so the requests otherwise stay the original's. The web API's `codecName` now sets the stream's codec (HEVC ranked unlikely where unsupported). **Measured on the deployment right after:** `/api/mavonyx/play` answers 502 "MovieBox answered 429": MovieBox throttles Cloudflare's servers. **Deviation:** before the Function, the client sends the same web-API call through the user's gateway (`POST {gateway}/p`, `text/plain` envelope with Referer and User-Agent, both on the gateway's forwarding allow-list), which fetches over the user's own connection; live-checked with the real gateway against the real API: 1 stream with the Referer, 0 without. Order: the browser's own direct web calls (the original's), then the gateway if one is set, then the Function. The trace logs each and probes the first 2 bytes of the first stream (does the video server accept a browser?). Not verified: and whether the `hakunaymatata` CDN needs a Referer for the video (from the sandbox it answered 428/429 with and without one).

**Parity.** `test/mavonyx.test.mjs` runs the original file unchanged in a `vm` against the same mock as the port; the mock verifies every signature with `node:crypto` and refuses bad ones. Movie with dubs, CloudFront and Cloud CDN sign cookies, a placeholder stream, resolution filters and captions; a film found only by its original title (Parasite / 기생충); a TV episode; an expired token. Streams (URL, order, labels, quality, headers, captions) and the sorted list of requests (method, URL, body) must be identical.

**Deliberate differences** (tested):

| Difference | Why |
|---|---|
| No TMDB call; `originalTitle` and `rating` come from the title details (`lib/tmdb.js` now returns `originalTitle`; `metaFor`/`metaOf` pass both) | The page already has them. The rating is TMDB's rounded to 0.1 (the original uses the raw value; the score bands are 0.5 and 1.0 wide) |
| `User-Agent`, `Origin`, `Referer`, `Cookie` not sent on API calls | Browsers forbid them; the signature does not cover them |
| `AbortError`/`TimeoutError` propagate | So a cancelled lookup is reported as cancelled, not "no match" |
| No request at all for invalid input (no title, TV without episode) | The original still fetches a token first |
| Streams: container from the format (`mpd`/`m3u8`/`mp4`), the audio track in the source name ("Mavonyx (Hindi Audio)"), title-based file name, `signedCookie` flag, captions as `{url, lang, label}` | The original's labels carry invisible sort prefixes; the app ranks itself (section 9) |
| Stream headers kept (Origin, Referer, UA, Cookie, sign header) | For external tools only: a page cannot send them, and the gateway does not forward `Cookie` |

## 7. Connectivity: what a browser can and cannot do

A website cannot do what the Android plugin does. The constraints, and how each is handled:

| Constraint | Effect | Handling |
|---|---|---|
| Cloudflare cannot reach private BDIX IPs | A server-side proxy on Pages is useless for BDIX | Lookups run in the browser or in a gateway on your network |
| **CORS**: servers must send `Access-Control-Allow-Origin` | Without it the browser hides the response | Settings → *Test connection* distinguishes "reachable but blocked by CORS" (an opaque `no-cors` probe succeeds) from "unreachable"; gateway adds CORS |
| **Mixed content**: https page → http server | Blocked | Gateway on `http://127.0.0.1`, gateway with TLS, or an http custom domain. Per Chrome's Local Network Access documentation, Chrome 142+ asks permission for requests from public sites to private IP literals and relaxes mixed-content blocking for them; hostnames and public IPs (`new.circleftp.net`, `15.1.1.50`) do not qualify |
| `Referer`, `User-Agent` cannot be set | Servers that check them refuse | Gateway injects the extension's UA and a per-host Referer |
| `<video>` cannot send headers | Same | Gateway `/s` endpoint streams with them |
| Cross-origin downloads ignore `download=` | Browser may play instead of save | Gateway `?dl=1` sets `Content-Disposition: attachment` |
| A page request always carries `Origin` (cannot be removed) | The Fendrix HLS CDN answers 404 to it, so in-page players (hls.js) cannot play those streams | Built-in HLS (Safari, iOS, Chrome 142+) sends media requests without an Origin and plays them. Without built-in HLS (Firefox): with a gateway, the in-page player gets the gateway URL (`/s?hls=1`) and hls.js plays it; without one the stream is ranked unplayable (the reason names the gateway) and the external-player links remain |
| Public sites without CORS (the Hexion chain) | Browser cannot read them | Edge proxy `/api/proxy`: https GET only, exact host allow-list (`DEFAULT_EDGE_PROXY_HOSTS` in `lib/api.js`, override with `EDGE_PROXY_HOSTS`), text only, 2 MB cap |
| Region-gated APIs (Mavonyx/MovieBox, measured 19 Nov 2026: 403 "Service not available in current region" from the US) | Works or not depending on where the user is | Called straight from the browser (`direct`), so the user's own IP decides; never through the edge proxy. Elsewhere the chip says "server error" or "no match" |
| Sites that refuse Cloudflare (the Hexion chain, measured 19 Nov 2026) | The edge proxy gets a 403 block page (`error code: 1106`, "Just a moment...") | The proxy marks it (`x-upstream-blocked: cloudflare`, never cached); the provider state is `blocked`, shown as "needs gateway" with an explanation. The gateway fetches over the user's own connection (live: 8 Hexion streams in 3.4 s) |

**Packaged gateway** (`raftv-gateway.exe`): `gateway/exe-main.mjs` only picks settings and **writes nothing to disk** (owner's requirement; measured with `strace`, also while streaming): the token is derived each start as SHA-256 of the PC's machine id (Windows `MachineGuid` read with `reg query`, Linux `/etc/machine-id`) plus the user name, so it is stable without being stored (random for that run if no id exists); an optional `raftv-gateway.json` next to the program is read, never written; defaults `host 0.0.0.0`, port 8787, the RafTV origin; environment variables override and starts the unchanged gateway; `scripts/build-gateway-exe.mjs` bundles both with esbuild (22 KB, CommonJS) and injects them into a copy of `node` (Node single executable, no snapshot or code cache); GitHub Actions builds it on Windows, smoke-tests the `.exe` and releases it on a `gateway-v*` tag. Memory (Linux build, measured): ~60 MB idle, ~100 MB streaming at full loopback speed; a smaller V8 young generation (`--max-semi-space-size=1`) made no difference (the buffers are outside the JS heap), so nothing is tuned.

**Gateway design** (`gateway/bdix-gateway.mjs`, 307 lines, no dependencies): `POST /p` takes a JSON envelope for small lookups (sent as `text/plain` so the browser does not need a preflight); `GET /s` streams media and forwards `Range`; with `hls=1` it sniffs the body (CDNs serve playlists under any name and type) and, for an HLS playlist, rewrites every URI (lines and `URI="..."` attributes) to a relative `s?u=...` link carrying the same token and headers, so players need neither CORS nor an Origin-free request from the CDN; each rewritten URL is re-checked by the address policy; every request needs a token unless bound to loopback; a non-loopback bind without a token refuses to start. **SSRF protection** mirrors the extension's address policy: addresses are classified as *public*, *private* (only if allow-listed), or *never* (link-local, metadata, multicast, unspecified). DNS results are validated at connect time (defeats rebinding), IP literals are validated up front (Node skips `lookup` for literals), redirects are re-validated per hop, and IPv6 is parsed to bytes so IPv4-mapped, NAT64 and 6to4 forms cannot smuggle a private address.

## 8. Choosing the player

Requirements: efficient, MP4/MOV, subtitle styling, OpenSubtitles, "feature packaged", customisable.

Facts gathered (npm registry and package contents, November 2026):

| Candidate | Status | Size (measured) | Verdict |
|---|---|---|---|
| **ArtPlayer 5.4.0** | MIT, releases every few months (5.3.0 Sep 2025, 5.4.0 Mar 2026); single maintainer | **141 KB / 36 KB gz**, one file, no dependencies | **Chosen**: ships a settings panel (speed, aspect, subtitle offset, extensible), subtitle renderer with style API, PiP, fullscreen, gestures, mini progress bar, hotkeys, HLS hook |
| Video.js 10.3.0 | Current `latest`; v8 kept as `latest-8` | Player + default skin bundled with esbuild: **573 KB / 125 KB gz** (core 341 KB, skin 199 KB); can be trimmed by building a custom skin | Strong long-term choice, but heavier and subtitle styling would be custom work (captions use native `::cue`) |
| Plyr 3.8.5 | **Deprecated** on npm (security updates only); merged into Video.js 10 | - | Rejected |
| Vidstack 1.15.7 | **Deprecated** on npm (security fixes until 2028); merged into Video.js 10 | - | Rejected |
| Media Chrome | Active; building block merged into Video.js 10 | - | Not a packaged player |

**Decision:** ArtPlayer for size and built-in features. The risk (single maintainer) is contained: only `public/js/player.js` and `scripts/build-vendor.mjs` know about it; everything else talks to a small controller (`switchTo`, `addSubtitle`, `selectSubtitle`, `focus`, `destroy`). Video.js 10 is the migration target.

MOV/MP4 note: containers are handled by the **browser**, not the player library, so "excellent MP4/MOV support" is really a browser-codec question; see section 9.

## 9. Playback robustness (measured in a real browser)

Experiment: real files generated with ffmpeg, served with Range support under different `Content-Type`s, played in Chromium 153.

| File | Result |
|---|---|
| MP4, H.264 + AAC | plays |
| **MOV**, H.264 + AAC | plays with any `Content-Type`, including `application/octet-stream` and `video/quicktime`, even though `canPlayType('video/quicktime')` returns `""` |
| **MKV**, H.264 + AAC | plays with any `Content-Type` |
| MP4, **HEVC** | metadata loads, picture is **0×0, no error event** |
| MKV, H.264 + **AC-3** audio | video plays, **zero audio bytes decoded, no error** |
| HLS whose playlist/segments are named `.jpg` (Fendrix CDN shape), `<video src>` | Chromium 153 reports `canPlayType('application/vnd.apple.mpegurl') = "maybe"` and plays it natively; media requests carry **no `Origin` header** (a page `fetch()` always does) |

Consequences built into the app:

* **Never gate on `canPlayType`** for MOV/MKV.
* **Prediction before playing** (`streams.js`): file names are parsed for video codec and audio codecs; sources are ranked *playable → risky → unlikely* (HEVC when the browser cannot decode it, AVI, XviD, MKV on Safari/iOS, files whose only audio is DD+/AC-3/TrueHD/DTS), then by resolution, container friendliness (MP4 > MOV > MKV) and provider. The default pick is therefore the best file the browser can most likely play, not the biggest. A setting switches back to pure quality order.
* **Health monitor after starting** (`player.js`): `videoWidth === 0` after metadata → video unsupported; no decoded audio after 2.5 s of playback (`webkitAudioDecodedByteCount`, `mozHasAudio`) → audio unsupported; media error, a fatal hls.js error (hls.js network failures never fire `<video>` `error`) or 25 s without metadata → failure. The watchdog is armed when the player is created, not on ArtPlayer's `ready` (that is the first `canplay`, which a dead source never reaches: before Nov 19, 2026 this left an endless spinner). Video failures switch to the next playable source automatically (with a toast); when none is left the player stops spinning and says so (`fail()`), and the banner below gives the known reason (e.g. built-in HLS or the gateway) and the external-player and download links; silent audio shows a banner offering another source, an external player or a download.
* **External players**: Android intents (VLC, MX Player), iOS `vlc-x-callback` / Infuse, and an `.m3u` playlist for VLC, mpv or PotPlayer on desktop. The URL given is the gateway URL when a gateway is configured.
* **Built-in HLS rule**: streams flagged `needsNativeHls` (Fendrix) are ranked unplayable when `browserCaps().nativeHls` is false and no gateway is set, because their CDN refuses the Origin header that hls.js requests carry; the player already prefers built-in HLS when available. VC-1 video is ranked unplayable everywhere.
* **DASH and signed cookies (Mavonyx):** no DASH player is bundled, so `.mpd` streams are ranked unplayable ("try an external player"); a stream that came with a CDN sign cookie is ranked risky (`signedCookie`): a page cannot send another site's cookie. A DASH library (dash.js or Shaka, lazy like hls.js) would also need the cookie turned into signed-URL query parameters on every request; not done because the real CDN could not be observed.
* **Not supported:** software decoding of HEVC/DTS/AC-3 in the browser (would need WebAssembly ffmpeg; large and slow on phones). The fallbacks above are the practical answer.

## 10. Subtitles

* **Search** `/api/subs`: OpenSubtitles.com API v1 when `OPENSUBTITLES_API_KEY` is set (TMDB id, or parent id + season + episode; lowercase, alphabetically sorted query as the API expects; descriptive `User-Agent`), otherwise the keyless Stremio OpenSubtitles v3 addon by IMDb id. Languages are normalised (ISO 639-2 → 639-1).
* **Download** `/api/sub`: OpenSubtitles needs login + `POST /download` → temporary link; the Function does that. Only `https` links on `opensubtitles.org/.com` or `strem.io` (exact suffix match) are fetched; 2 MB cap; gzip handled.
* **Decoding** (`subs.js`): BOM, strict UTF-8, otherwise Windows-1252 (the usual legacy SRT encoding; verified with a `Café` file), then SRT → WebVTT (timestamps padded, ASS tags and `<font>` removed, `<b> <i> <u>` kept).
* **Auto-load** the first result in your preferred language; **Subtitles** button for other languages; **upload** a `.srt`/`.vtt` from the device.
* **Appearance**: size (50-250 %, scaled to the player width so phones and monitors both look right), height from the bottom, colour, background (none / shadow / box). Available in the player's settings panel and in the site settings with a live preview; stored per device. ArtPlayer's own offset slider adjusts timing.
* **Shortcuts**: Space, ←/→, ↑/↓ (ArtPlayer) plus M mute, C captions, F fullscreen. ArtPlayer keys its table by `KeyboardEvent.code` and only after a click inside the player; the app enables shortcuts on load and after any sheet closes.

## 11. UI and design system

* **Palette**: `ink #0c111b` page, `panel #121a29`, `raised #1b2538`, `line #2a364d`, text `#eef1f6` / `#9ba8c0`; one action colour, **lamp amber `#ffb02e`** (the projector bulb); mint `#47d7b5` only for "ready" status.
* **Type**: Bricolage Grotesque, heavy tight-tracked weights for titles, regular for UI. No all-caps eyebrow labels, no dot-joined meta strings (chips and spacing instead).
* **Memorable element**: the **source ticket**: a quality "stub" (`1080p / MP4`) with a dashed perforation, then file name, provider, codec/audio tags and a playability warning. Only the recommended ticket gets the amber button.
* **Layout**: hero that leaves the first poster row visible on every viewport; scroll-snap rails (arrows on hover-capable desktops); bottom tab bar below 768 px, top navigation above; episode rows with stills and per-episode Play/Download; sheets are bottom sheets on phones and side drawers on desktop (native `<dialog>`: focus trap, Esc, inert background).
* **Motion**: sheet slide (0.18 s) and press state only; no autoplay carousels, parallax or shimmer.
* **Identity**: the product name, tagline and theme colour are defined once in `public/js/brand.js`; the logo is the file `public/icon.svg` (header, favicon, app icon). `npm run rebrand` syncs `index.html` and the manifest, and `test/brand.test.mjs` fails on drift or on a hardcoded name (change the name and see the README).
* **Accessibility** (asserted in tests): every control has an accessible name, all images have `alt`, one `h1` per page, skip link is the first Tab stop, visible focus ring, 44 px touch targets, reduced-motion support.

## 12. Security model

* **Secrets** (TMDB key, OpenSubtitles key/login, `ADMIN_PASSWORD`) exist only in the Function's environment; tests assert they never appear in any response.
* **Accounts**: see section 18 (password hashing, sessions, CSRF, rate limits, invite codes, admin checks).
* **CSP** (`public/_headers`, applied by the dev server and verified under workerd): `default-src 'self'`, scripts from self only, images from self and `image.tmdb.org`, `object-src 'none'`, `frame-ancestors 'none'`. `connect-src` and `media-src` allow `http:`/`https:` because BDIX hosts and your gateway are user-specific; the browser's own mixed-content rules still apply. `'unsafe-inline'` is allowed for styles only (the player sets inline styles).
* **No HTML injection**: DOM is built with `textContent`; provider HTML is parsed with an inert `DOMParser`.
* **SSRF**: four independent guards (edge proxy host allow-list; subtitle host suffix allow-list; gateway address policy; `/api/mavonyx/play` with one fixed upstream host and strictly validated `subjectId`/`se`/`ep`/`detailPath`, https-only output), each with tests, including the bypasses found during development (section 13).
* **Gateway**: token required off-loopback, constant-time comparison, header allow-list (it forwards only `user-agent`, `referer`, `accept`, `accept-language`, `content-type`, `range`), CORS origin allow-list, filename sanitising for `Content-Disposition`.

## 13. Verification

| Suite | Count | What it proves |
|---|---|---|
| Unit / integration (`npm test`) | 166 | API router and TMDB slimming, key handling, error mapping, subtitle service and SSRF guards; gateway (auth, envelope, Range, CORS, downloads, address matrix); **providers vs. golden output of the original scrapers (14 scenarios, same requests)**; **Fendrix, Hexion and Mavonyx vs. the original scraper files executed in a `vm` (same streams, same requests; Mavonyx signatures checked with `node:crypto`), their deviations, AES-GCM (WebCrypto and software), cancel at every stage, the edge allow-list**; orchestration (failure classes, timeouts, cancel, settle window, dedupe); client logic (store, ranking, playability, subtitle conversion, router, API client) |
| Browser end-to-end (`npm run e2e`) | 38 browser end-to-end steps | Real Chromium 153 with a mock BDIX server on real sockets, real test videos, the real gateway. See list below |
| Cloudflare runtime (`npm run smoke:cf`) | 9 Cloudflare runtime checks | `wrangler pages dev` (workerd): bundling of the Function with `../../lib` imports, `_headers`, `_routes.json`, validation, SSRF guards, no key leakage |

E2E coverage: home/search/details/My List; layouts at 390/820/1440 px; **zero BDIX requests until a click**; download sheet (4 parallel POSTs, ranking, warnings, anchors, clipboard API and fallback, `.m3u`); playback of MP4, MOV and MKV with sound; resume, Continue watching, next episode; HEVC and AC-3 detection with fallback; subtitles (auto-load, Latin-1, size/height/colour/background, language search, upload, Off); gateway mode (UA injected, Range proxied, attachment download, token enforced); unreachable and CORS-blocked servers; settings effects; Android/iOS/desktop external-player links; route errors; missing-API-key setup notice; lazy loading and byte budget; accessibility; keyboard shortcuts; 8 cold-start navigation races; phone portrait/landscape and tablet layouts; **Fendrix** (sealed lookup answered in the browser, decrypted, played through built-in HLS from a local CDN that refuses requests with an Origin, never through the configured gateway); **Hexion** (4kHdHub chain through the edge proxy, size shown, file played from its host); **Mavonyx** (signed requests answered in the browser with the live CORS shape and every signature verified, preflights made and answered locally, `apig`'s token header hidden by the browser and the web token used instead, web MP4 played, Test connection row, DASH ticket "unlikely", and a control run with no readable token anywhere: "server error"); guidance when BDIX and online sources are down. The browser's requests to the online providers' hosts are answered by the harness or cut off, so no step reaches the real internet. The run fails on any browser console error or CSP violation (there are none; the Fendrix step names the one expected error, the fallback endpoint's CORS failure).

**Test environment honesty.** The packaged `@sparticuz/chromium` starts with `--disable-web-security`, `--allow-running-insecure-content` and site-isolation flags (it targets AWS Lambda). An early E2E run was green *with CORS switched off*, which made direct-mode results meaningless. The harness now strips those flags, and the whole suite was re-run and passes with real CORS enforcement.

**Mutation checks.** For three security/logic fixes the code was deliberately reverted to confirm the test fails (host-suffix regex, abort handling, duplicate-URL choice). For Mavonyx, 9 more (unsorted query, wrong HMAC pad, character instead of byte length, no token refresh, no DASH-first order, a `User-Agent` sent, swallowed abort in the track stage, no original-title search, mobile MP4 kept): each made a test fail (the swallowed abort first survived; the mid-lookup cancel test was added for it). For Fendrix and Hexion, 12 more (reading the reply as text, swallowed aborts in Fendrix and in Hexion's item stage, no gateway bypass, media sent through the gateway, no `workers.dev` deviation, no `m3u8` override, no built-in-HLS rule, Fendrix host on the edge list, unfiltered file qualities, waiting for the fallback endpoint): each made at least one test fail.

**Bugs found by testing, and fixed:**

1. *Navigation race*: leaving the home page mid-download made the API client resolve `null` (an aborted body read was swallowed and even cached); the home view then crashed and overwrote the new page. Found by cold-start stress (2 of 5 runs failed). Fixes: abort/parse errors propagate; every navigation gets its own detached view container; regression tests.
2. *Gateway SSRF, IP literals*: Node skips `lookup` for IP-literal hosts, so `http://169.254.169.254/` bypassed DNS-time checks. Literals are now validated up front.
3. *Gateway SSRF, IPv6*: the URL parser rewrites `[::ffff:127.0.0.1]` as `::ffff:7f00:1`, which a dotted-only pattern classified as public. IPv6 is now parsed to bytes (mapped, NAT64, 6to4 handled).
4. *Copy link on plain-http sites*: `navigator.clipboard` does not exist there, and the legacy fallback was inert inside a modal `<dialog>` (everything outside is inert) and unfocused (iOS needs focus). Fixed and tested on both paths.
5. *Resume positions lost on native pause* (media keys, headset): ArtPlayer's `pause` event fires only for `art.pause()`; now `video:pause` is used.
6. *Dead shortcuts*: hotkeys were registered as `'m'`, `'c'`, `'f'`, but ArtPlayer keys by `event.code` and enables them only after a click inside the player.
7. *"Box" subtitle background did nothing*: the CSS variable was set but no rule consumed it.
8. *Invalid TMDB image size* (`w780` for episode stills).
9. *Duplicate sources lost resolution* depending on provider response order.
10. *Audio labels*: the original `DDP5.1` pattern missed the common `DDP5.1` spelling (display only).
12. *Fendrix could never return a stream* (as first committed): the encrypted reply was read with `text()`, destroying the ciphertext; it also swallowed `AbortError`, so a cancelled lookup was reported as "no match".
13. *Fendrix returned nothing in any real browser*: its own read of the master playlist carries an Origin, which the CDN refuses. Invisible to Node-based live checks (Node sends no Origin); found by the E2E mock CDN that copies the live behaviour.
14. *A hanging fallback endpoint stalled Fendrix* until the provider timeout, and the abandoned request later raised an unhandled rejection. The orchestrator now also aborts each provider's leftover requests once it has answered.
15. *Hexion as first committed*: parsed without the injected `DOMParser` (crashed outside a browser), swallowed `AbortError`, and recognised none of today's file hosts.
16. *`imdbId` never reached the providers* (watch and details pages), so Hexion's IMDb lookup and Fendrix's `imdb=` parameter were skipped; the lookup cache made the details-page meta leak into the watch page.
17. *Test isolation*: the gateway E2E step let FlixHub (and then Hexion) lookups through the real gateway to the real internet (step time fell from 27 s to 2.5 s once pointed at the mock).
18. *Endless spinner when the first source never loads* (reported as "Fendrix: 1 found, never plays"): the watchdog was armed on ArtPlayer's `ready` (first `canplay`), and fatal hls.js errors went nowhere. Without built-in HLS, hls.js is refused by the Fendrix CDN and nothing reported it.
19. *FlixHub routed through the Cloudflare edge proxy* although it is a BDIX server (504 on the deployment).
20. *Hexion shown as "server error"* on the deployment: its sites block Cloudflare (now `blocked`, "needs gateway").
11. Smaller UX fixes: hero crowded out the first rail; three watch-page buttons wrapped; notices inside sheets had dim headings; Subtitle tooltip ran into its label; slow providers delayed playback (settle window).

## 14. Performance

Measured in the E2E run (desktop viewport, local server):

| Item | Size |
|---|---|
| App JavaScript (33 modules, unminified) | 229 KB raw, **71 KB gzipped**; the home page loads 170 KB of it (budget 170 KB, about 50 bytes left) (Settings, the account screens, Admin, `aesgcm.js` and `mx-api.js` load on first use) |
| CSS | 21 KB raw, 5 KB gzipped |
| Font | 41 KB (woff2) |
| ArtPlayer (loaded on the watch page only) | 141 KB raw, 36 KB gzipped |
| hls.js light (loaded only if an HLS source is chosen) | 369 KB raw, 117 KB gzipped |
| Home page | 68 requests including posters and the logo; `DOMContentLoaded` about 130-190 ms locally |
| Watch page: player mounted / video playing (mock sources) | about 0.2 s / 1.3 s after the click |

The tests assert that the player libraries are **not** requested on the home page and that hls.js is not requested for an MP4. Real-world figures depend on TMDB/CDN latency and on the BDIX servers.

## 15. Known limitations and what was not verified

* **Fendrix and Hexion were checked against the live services** (18-19 Nov 2026, from the sandbox): the ports return the same streams as the original scrapers where those still work, Hexion's deviation finds 7 movie / 4 episode files the original misses, and the Fendrix HLS played in Chromium 153. Not verified: the edge proxy *on Cloudflare* fetching the Hexion chain (sites may block Cloudflare IPs; only the same handler in Node was run), real Firefox (no built-in HLS: Fendrix needs the gateway there; tested in Chromium with built-in HLS hidden, hls.js through the real gateway), and how often the link-wrapper/HubCloud domains change (update `EDGE_PROXY_HOSTS` when Hexion shows "server error").
* **Mavonyx was never seen working live from here**: its mobile API refuses the sandbox's region (403), so real stream URLs, the DASH/HLS/MP4 mix, sign cookies, caption hosts and whether its MP4/HLS hosts need cookies are unknown; the owner reports it works in their browser. Response shapes come from the original parser (and the live web API for the parts that answer). DASH does not play in the built-in player yet.
* **From Cloudflare's edge Hexion is blocked** (measured on the deployment, 19 Nov 2026): on `pages.dev` Hexion works only with the gateway. Fendrix plays without a gateway only in browsers with built-in HLS (Chrome/Edge 142+, Safari, iOS); elsewhere the app now says so at once.
* **Not reachable from the build environment**: the BDIX servers (including FlixHub), TMDB and OpenSubtitles; the deployment was only read (public GETs). TMDB, Stremio and FlixHub are mocked with the documented response shapes; BDIX response shapes are inferred from the original parsers. Run *Test connection* and a real title on your network before relying on it.
* **Only Chromium was automated.** Firefox and Safari behaviour (mixed content, `webkitAudioDecodedByteCount` equivalents, MKV, hotkeys) is by design/reading, not by test. The audio-silence check relies on `webkitAudioDecodedByteCount` (Chromium/WebKit) and `mozHasAudio` (Firefox).
* **Real devices, https and Chrome's Local Network Access prompt flow** were not exercised; tests run over http on loopback. The mixed-content/permission statements come from Chrome's documentation and general browser rules.
* **Headless audio**: "audio is decoding" is measured by decoded byte counts, not by listening.
* Edge caching (`cf.cacheTtl`) and the free-plan quotas were not exercised on Cloudflare itself; the local runtime ignores the cache hint.
* HEVC/DTS/AC-3 cannot be decoded in the browser; the app detects and works around them but cannot fix them.
* The gateway is a plain proxy for your own network, not an authentication system; use a token and do not expose it to the internet.
* Provider selectors may need updating if the servers or FlixHub's markup change; the golden-output tests and `make-golden.mjs` make that a mechanical change.

## 16. Licensing and terms

* **The provider modules are derived from GPL-3.0 code** (`eclipsia-bdix` / the CloudStream extension repository). If you publish a site that serves them to visitors, GPL-3.0 applies to that code: keep the notices, and make the corresponding source available under GPL-3.0. The simplest consistent choice, taken here, is to license the whole project GPL-3.0 (`LICENSE`, `NOTICE.md`). The other dependencies (ArtPlayer MIT, hls.js Apache-2.0, Bricolage Grotesque OFL, dev tools MIT/Apache) are compatible. This is information, not legal advice.
* **TMDB**: free key for non-commercial use; the attribution notice must stay visible. Commercial use needs a TMDB agreement.
* **OpenSubtitles**: use an API key per their terms; downloads are quota-limited.
* **Content**: this project hosts no media. What the BDIX servers offer, and your right to access it, are your responsibility under local law and the servers' own terms.

## 17. Extending

* **Add a provider**: (a large one can be a small stub that `import()`s its lookup on first use, like `mx.js`; the home-page byte budget has little room) create `public/js/providers/<id>.js` exporting `id`, `name`, `group` (`'bdix'`/`'public'`), `search(meta, ctx, opts)` returning streams built with `makeStream()`, and either `edge: true` (public host without CORS, add it to `DEFAULT_EDGE_PROXY_HOSTS`) or `direct: true` (public host with CORS); register it in `providers/index.js`, `store.js` defaults and `streams.js` `PROVIDER_ORDER`; add tests (parity with the original where one exists). Use `ctx.json/ctx.text/ctx.bytes` (or `ctx.response` when status codes or headers matter), which classify failures for the UI, and let `AbortError` through (`unlessAbort()` from `common.js`).
* **Change the player**: implement the same controller in `player.js` (`switchTo`, `addSubtitle`, `selectSubtitle`, `focus`, `applySubStyle`, `destroy`) and update `scripts/build-vendor.mjs`.
* **Change server addresses**: edit the constants at the top of each provider, or repoint at runtime through the exported `endpoints`/`SERVERS` objects.
* **Update vendor files**: change versions in `package.json`, `npm install`, `npm run build:vendor`, commit `public/vendor/`.

## 18. Accounts and sync

Optional: without a D1 binding named `DB` every account route answers 503 `accounts_not_configured`, Settings shows no Account section, and the library stays on the device as before.

**What the user gets.** Named watch lists (My List plus their own; save sheet on the details page; Lists page with rename, delete, remove with Undo), removal of single history items (Continue watching and the History page, with Undo), and, signed in, the same history, lists, resume positions and playback settings on every device. Accounts are invite-only. Admins generate and disable invite codes, see users, reset a password (temporary password shown once) and remove users.

**Server** (`lib/accounts.js`, routed first by `lib/api.js`; the only non-GET routes):

| Route | What |
|---|---|
| `GET /api/auth/me`, `POST /api/auth/login`, `/signup`, `/logout`, `/password`, `/delete` | session state, sign-in, invite sign-up, sign-out, password change (signs out other sessions), delete own account (password required; not the last admin) |
| `GET/PUT /api/sync` | the user's library document with a version; `PUT` must name the version it was merged from (409 returns the current copy) |
| `GET /api/admin/users`, `DELETE /api/admin/users/:id`, `POST /api/admin/users/:id/reset` | admin only, role read from the database on every request; never self |
| `GET/POST /api/admin/invites`, `POST /api/admin/invites/:id/disable` | invite codes: uses (1 to 1000 or unlimited), expiry (1 to 365 days or never), note |

Tables (created on first use): `users`, `sessions`, `invites`, `user_state`, `attempts`.

| Concern | Design |
|---|---|
| Passwords | PBKDF2-SHA256, random 16-byte salt, iterations stored in the hash (`PBKDF2_ITERATIONS`, default 100 000 = the Workers maximum; raised counts upgrade hashes on sign-in). Unknown users still cost one hash. 10 to 128 characters, not containing the username |
| Sessions | 32 random bytes in `rh_session` (HttpOnly, SameSite=Strict, Path=/api, Secure on https, 30 days, extended at most hourly when used); only the SHA-256 is stored; password change/reset and user removal revoke sessions |
| CSRF | non-GET account requests need `Content-Type: application/json` and, when the browser sends one, a same-origin `Origin` |
| Brute force | sign-in: 10 failures per username and 30 per IP in 15 minutes; sign-up: 20 failed invite attempts per IP per hour |
| Invites | 12 characters without look-alikes (about 59 bits), stored hashed, shown once; created and counted in one D1 batch with the account (simultaneous sign-ups cannot both use a single-use code) |
| First admin | `ADMIN_USERNAME` / `ADMIN_PASSWORD` create the admin on its first sign-in while no admin exists; afterwards the database decides; the name is reserved for sign-up |
| Responses | `no-store`; never hashes, tokens or (after creation) invite codes |

**Sync** (`public/js/account.js`, rules in `public/js/sync-merge.js`). The library is one JSON document: history, lists with their items, resume positions, synced settings (never the gateway address or token), plus **tombstones** for removals. Every item and tombstone carries the time it changed; merging keeps the newest of the item and its tombstone (last-writer-wins per item), so a removal on one device is not undone by an older copy elsewhere, while watching a title again after removing it brings it back. A deleted list stays deleted unless it was changed after the deletion. The merge is commutative, associative and idempotent (property-tested), so devices converge in any order. Caps: 40 history items, 50 lists, 500 items per list, 300 resume positions, 500 tombstones per kind, 512 KB per document.

The client pulls on sign-in, when the page becomes visible, when the device comes back online and every 5 minutes; it pushes 1.5 s after a change (30 s when only resume positions changed), on conflict merges the server copy and retries. Applying the server copy is not treated as a local change (no loop). Signing in merges what was on the device into the account; signing out (after a confirmation) removes the account's data from the device so the next person on a shared phone sees nothing. The storage format changed from a `history` array and a single `list` array to `library`; old data is migrated on first read.

**Known limits.** Item times come from each device's clock: a device whose clock is far wrong can win or lose a conflict it should not. With more than 500 removals, the oldest tombstones are dropped, and a device that has been offline since then can bring those items back. A live D1 database on Cloudflare and the free plan's CPU limit for password hashing were not exercised (README *Accounts*). There is no e-mail: a forgotten password is reset by an admin.
