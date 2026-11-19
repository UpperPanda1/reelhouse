// Mavonyx (MovieBox) web-API stream list, fetched by the Function because a page cannot send the header it needs.
// Measured 19 Nov 2026: h5-api.aoneroom.com/wefeed-h5api-bff/subject/play returns real files (bcdn*.hakunaymatata.com)
// only when the Referer is the movie's page on a MovieBox host (`https://movie-box.co/movies/<detailPath>?id=...`);
// with a browser's own Referer (or none) it answers `hasResource: false` and no streams. The web API answers from
// outside the app API's regions, and needs no token. Fixed host and path; inputs validated; output trimmed.
import { HttpError } from './tmdb.js';

const PLAY = 'https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/play';
const SITE = 'https://movie-box.co';
// the original scraper's web User-Agent (mavonyx.js WEB_USER_AGENT)
const UA = 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36';
const bad = (msg) => new HttpError(400, 'bad_request', msg);

/** @param q URLSearchParams with subjectId, se, ep, detailPath. @returns {{streams: object[], hasResource: boolean}} */
export async function webPlay(q, f) {
  const subjectId = q.get('subjectId') || '';
  const se = q.get('se') || '';
  const ep = q.get('ep') || '';
  const detailPath = q.get('detailPath') || '';
  if (!/^\d{1,20}$/.test(subjectId) || !/^\d{1,4}$/.test(se) || !/^\d{1,4}$/.test(ep)) throw bad('subjectId, se and ep must be numbers');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(detailPath)) throw bad('invalid detailPath');
  const url = `${PLAY}?subjectId=${subjectId}&se=${se}&ep=${ep}&detailPath=${detailPath}&streamSignType=1&supportCodecs%5Bhevc%5D=1&supportCodecs%5Bh264%5D=1`;
  let res;
  try {
    res = await f(url, {
      headers: {
        accept: 'application/json', 'user-agent': UA,
        referer: `${SITE}/movies/${detailPath}?id=${subjectId}&type=/movie/detail&detailSe=&detailEp=&lang=en`,
        'x-client-info': JSON.stringify({ timezone: 'Asia/Calcutta' }), 'x-request-lang': 'en', 'x-vip-restrict': '0', 'x-no-high-risk-restrict': '0',
      },
      redirect: 'follow', signal: AbortSignal.timeout(10000),
    });
  } catch { throw new HttpError(504, 'upstream_unreachable', 'MovieBox did not respond.'); }
  if (!res.ok) throw new HttpError(502, 'upstream_error', `MovieBox answered ${res.status}.`);
  let json;
  try { json = await res.json(); } catch { throw new HttpError(502, 'upstream_error', 'MovieBox sent an unreadable reply.'); }
  const d = (json && json.data) || {};
  const streams = (Array.isArray(d.streams) ? d.streams : [])
    .filter((s) => s && typeof s.url === 'string' && /^https:\/\//i.test(s.url))
    .slice(0, 20)
    .map((s) => {
      const o = { id: s.id != null ? String(s.id) : undefined, url: s.url, format: s.format != null ? String(s.format) : undefined, resolutions: s.resolutions != null ? String(s.resolutions) : undefined, codecName: /^[a-z0-9]{2,10}$/i.test(String(s.codecName || '')) ? String(s.codecName).toLowerCase() : undefined };
      if (s.signCookie) { o.signCookie = String(s.signCookie); if (s.signHeaderKey) o.signHeaderKey = String(s.signHeaderKey); }
      return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
    });
  return { streams, hasResource: !!d.hasResource };
}
