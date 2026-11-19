# Notices

## RafTV
Copyright (C) the RafTV authors. Licensed under the **GNU General Public License v3.0** (see `LICENSE`), because it contains code derived from a GPL-3.0 project (below).

## Derived code: CloudStream BDIX scrapers
`public/js/providers/df.js`, `cf.js`, `fh.js` (and the parsing in `common.js`) are a browser port of the three scrapers in **eclipsia-bdix** from the CloudStream extension repository at `https://gitea.com/eclipsia/cloudstream`, licensed GPL-3.0. The algorithms (search patterns, filters, scoring, extraction order) follow the originals; the code was rewritten for browsers and extended (see `docs/IMPLEMENTATION.md`, section 6). `test/fixtures/golden.json` contains outputs recorded from the original scrapers; it is data, not code.

## Derived code: Eclipsia online-source scrapers
`public/js/providers/fn.js` (Fendrix), `hx.js` (Hexion), `mx.js`/`mx-api.js` (Mavonyx) and `aesgcm.js` are a browser port of the `fendrix.js`, `hexion.js` and `mavonyx.js` scrapers of the **Eclipsia** CloudStream extension (same repository family, GPL-3.0; copies kept under `cloudstream-main/cloudstream/providers/`, and the tests run those copies unchanged for parity). Requests, filtering and decoding follow the originals; differences are listed in `docs/IMPLEMENTATION.md`, section 6.

If you distribute or host this site for others, GPL-3.0 requires that you keep these notices and make the corresponding source available under GPL-3.0.

## Third-party components
| Component | Version | License | Where |
|---|---|---|---|
| ArtPlayer | 5.4.0 | MIT | `public/vendor/artplayer-5.4.0.js` (bundled; see its `.LEGAL.txt`) |
| hls.js (light build) | 1.7.4 | Apache-2.0 | `public/vendor/hls-light-1.7.4.js` (bundled, loaded on demand) |
| Bricolage Grotesque (variable, latin subset) | 5.3.0 (Fontsource) | SIL Open Font License 1.1 | `public/vendor/fonts/` (license file included) |
| esbuild, linkedom, Puppeteer, @sparticuz/chromium, wrangler | see `package.json` | MIT / Apache-2.0 | development and testing only; not deployed |

## Data and services
* This product uses the TMDB API but is not endorsed or certified by TMDB. Metadata and images are provided by TMDB (free for non-commercial use with attribution).
* Subtitles come from OpenSubtitles (official API when configured) or the public Stremio "OpenSubtitles v3" addon. Follow their terms of use.
* RafTV hosts no media. Sources are provided by third-party servers you configure and connect to.
