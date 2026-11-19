// TMDB access layer. Runs inside Cloudflare Pages Functions (Workers runtime) and Node 20+.
// The API key lives only in the environment; it is never sent to the browser.

export const TMDB_BASE = 'https://api.themoviedb.org/3';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const clip = (s, n) => {
  s = (s || '').trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '\u2026' : s;
};
const round1 = (n) => (n ? Math.round(n * 10) / 10 : 0);

/** A v4 "API Read Access Token" is a JWT (3 dot-separated parts); a v3 key is 32 hex chars. */
export function isBearerToken(key) {
  return key.length > 40 && key.split('.').length === 3;
}

export function createTmdb(env = {}, fetchImpl = fetch) {
  const key = String(env.TMDB_API_KEY || '').trim();
  if (!key) throw new HttpError(501, 'tmdb_not_configured', 'TMDB_API_KEY is not set on the server.');
  const base = String(env.TMDB_API_BASE || TMDB_BASE).replace(/\/+$/, '');
  const bearer = isBearerToken(key);

  /** GET a TMDB path. `ttl` is the edge cache lifetime in seconds. Errors never include the URL (it may carry the key). */
  async function get(path, params = {}, ttl = 600) {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    url.searchParams.set('language', 'en-US');
    const headers = { accept: 'application/json' };
    if (bearer) headers.authorization = `Bearer ${key}`;
    else url.searchParams.set('api_key', key);
    let res;
    try {
      res = await fetchImpl(url.toString(), {
        headers,
        cf: { cacheTtl: ttl, cacheEverything: true }, // honoured by Cloudflare, ignored elsewhere
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new HttpError(504, 'tmdb_unreachable', 'Could not reach TMDB.');
    }
    if (res.status === 404) throw new HttpError(404, 'not_found', 'Not found on TMDB.');
    if (res.status === 401) throw new HttpError(502, 'tmdb_auth_failed', 'TMDB rejected the API key.');
    if (res.status === 429) throw new HttpError(503, 'tmdb_rate_limited', 'TMDB is rate limiting requests. Try again shortly.');
    if (!res.ok) throw new HttpError(502, 'tmdb_error', `TMDB returned ${res.status}.`);
    return res.json();
  }
  return { get };
}

// ---------- slimmers: keep only what the UI renders (smaller payloads, faster first paint) ----------

export function card(x, forcedType) {
  const type = forcedType || x.media_type;
  return {
    id: x.id,
    type,
    title: x.title || x.name || '',
    year: (x.release_date || x.first_air_date || '').slice(0, 4),
    poster: x.poster_path || null,
    backdrop: x.backdrop_path || null,
    rating: round1(x.vote_average),
    overview: clip(x.overview, 220),
  };
}

export function cards(list, forcedType) {
  return (list || [])
    .filter((x) => x && (forcedType || x.media_type === 'movie' || x.media_type === 'tv'))
    .map((x) => card(x, forcedType))
    .filter((c) => c.poster);
}

export async function getHome(tmdb) {
  const [trend, pm, pt, tm, tt] = await Promise.all([
    tmdb.get('/trending/all/day', {}, 900),
    tmdb.get('/movie/popular', {}, 900),
    tmdb.get('/tv/popular', {}, 900),
    tmdb.get('/movie/top_rated', {}, 3600),
    tmdb.get('/tv/top_rated', {}, 3600),
  ]);
  const trending = cards(trend.results);
  const hero = trending.find((c) => c.backdrop && c.overview) || null;
  return {
    hero,
    rows: [
      { id: 'trending', title: 'Trending today', items: trending },
      { id: 'popular-movies', title: 'Popular movies', items: cards(pm.results, 'movie') },
      { id: 'popular-tv', title: 'Popular series', items: cards(pt.results, 'tv') },
      { id: 'top-movies', title: 'Top rated movies', items: cards(tm.results, 'movie') },
      { id: 'top-tv', title: 'Top rated series', items: cards(tt.results, 'tv') },
    ],
  };
}

export async function getTitle(tmdb, type, id) {
  const d = await tmdb.get(`/${type}/${id}`, { append_to_response: 'credits,recommendations,videos,external_ids' }, 3600);
  const isTv = type === 'tv';
  const trailer = (d.videos?.results || [])
    .filter((v) => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'))
    .sort((a, b) => Number(b.official) - Number(a.official) || (a.type === 'Trailer' ? -1 : 1))[0];
  let seasons = [];
  if (isTv) {
    seasons = (d.seasons || [])
      .filter((s) => s.season_number > 0 && s.episode_count > 0)
      .map((s) => ({ n: s.season_number, name: s.name, episodes: s.episode_count, year: (s.air_date || '').slice(0, 4), poster: s.poster_path || null }));
  }
  return {
    id: d.id,
    type,
    title: d.title || d.name || '',
    originalTitle: d.original_title || d.original_name || '',
    tagline: d.tagline || '',
    overview: d.overview || '',
    year: (d.release_date || d.first_air_date || '').slice(0, 4),
    releaseDate: d.release_date || d.first_air_date || '',
    runtime: isTv ? (d.episode_run_time && d.episode_run_time[0]) || d.last_episode_to_air?.runtime || 0 : d.runtime || 0,
    rating: round1(d.vote_average),
    votes: d.vote_count || 0,
    status: d.status || '',
    genres: (d.genres || []).map((g) => g.name),
    poster: d.poster_path || null,
    backdrop: d.backdrop_path || null,
    imdbId: (isTv ? d.external_ids?.imdb_id : d.imdb_id) || null,
    seasons,
    cast: (d.credits?.cast || []).slice(0, 14).map((c) => ({ name: c.name, character: c.character || '', photo: c.profile_path || null })),
    recs: cards(d.recommendations?.results, type).slice(0, 18),
    trailer: trailer ? { key: trailer.key } : null,
  };
}

export async function getSeason(tmdb, tvId, n) {
  const s = await tmdb.get(`/tv/${tvId}/season/${n}`, {}, 3600);
  return {
    n: s.season_number,
    name: s.name || `Season ${s.season_number}`,
    overview: clip(s.overview, 300),
    episodes: (s.episodes || []).map((e) => ({
      n: e.episode_number,
      name: e.name || `Episode ${e.episode_number}`,
      overview: clip(e.overview, 260),
      still: e.still_path || null,
      runtime: e.runtime || 0,
      airDate: e.air_date || '',
      rating: round1(e.vote_average),
    })),
  };
}

export async function search(tmdb, q, page = 1) {
  const r = await tmdb.get('/search/multi', { query: q, include_adult: 'false', page }, 300);
  return { page: r.page || 1, total: r.total_pages || 1, items: cards(r.results) };
}

export async function getRecs(tmdb, type, id) {
  const r = await tmdb.get(`/${type}/${id}/recommendations`, {}, 3600);
  return { items: cards(r.results, type).slice(0, 18) };
}
