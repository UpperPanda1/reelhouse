// Single entry point for every /api/* route. Used by the Cloudflare Pages Function, the local dev server and the tests.
import { createTmdb, HttpError, getHome, getTitle, getSeason, search, getRecs } from './tmdb.js';
import { searchSubtitles, fetchSubtitle } from './subs.js';
import { handleAccounts } from './accounts.js';
import { webPlay } from './mavonyx.js';

const BASE_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };

export function json(data, status = 200, ttl = 0) {
  const headers = { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8' };
  headers['cache-control'] = ttl ? `public, max-age=60, s-maxage=${ttl}, stale-while-revalidate=86400` : 'no-store';
  return new Response(JSON.stringify(data), { status, headers });
}

const isType = (t) => t === 'movie' || t === 'tv';
const isId = (s) => /^\d{1,10}$/.test(s || '');
const bad = (msg) => new HttpError(400, 'bad_request', msg);

/**
 * Hosts the edge proxy may fetch: exact names only (comma list in EDGE_PROXY_HOSTS replaces this default).
 * Only plain https GETs, text only. The Hexion (4kHdHub) chain as measured in Nov 2026:
 * site -> link wrapper -> HubDrive/HubCloud -> file page. The wrapper/HubCloud domains change from time to time;
 * when Hexion starts reporting "server error", add the new names via EDGE_PROXY_HOSTS.
 * Fendrix is not here on purpose: its API sends CORS headers, so the browser calls it directly.
 * FlixHub is not here either: it is a BDIX server, which Cloudflare cannot reach.
 */
export const DEFAULT_EDGE_PROXY_HOSTS = '4khdhub.one,www.4khdhub.one,greenmotors.club,hubdrive.blog,hubcloud.mov,gamerxyt.com';
export function proxyHosts(env) {
  return String(env.EDGE_PROXY_HOSTS ?? DEFAULT_EDGE_PROXY_HOSTS).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Did the upstream refuse us because the request came from Cloudflare's network? Measured Nov 2026 from the deployed
 * site: 4khdhub.one answers Workers with 403 "error code: 1106", hubdrive/hubcloud with a 403 "Just a moment..."
 * challenge. No request from the edge can get past that; only the user's own connection (the gateway) can.
 */
export function blockedByCloudflare(res, text) {
  if (![403, 429, 503].includes(res.status)) return false;
  return /challenge/i.test(res.headers.get('cf-mitigated') || '') || /^error code: 1\d{3}\b/.test(text.trim()) || /<title>Just a moment\.\.\.<\/title>/i.test(text);
}

async function proxy(url, env, f) {
  let target;
  try { target = new URL(url.searchParams.get('u') || ''); } catch { throw bad('Missing or invalid "u" parameter.'); }
  if (target.protocol !== 'https:' || target.port || target.username || !proxyHosts(env).includes(target.hostname.toLowerCase())) {
    throw new HttpError(403, 'host_not_allowed', 'This host is not allowed through the edge proxy.');
  }
  let res;
  try {
    res = await f(target.toString(), {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36', accept: 'text/html,application/xhtml+xml,*/*;q=0.8', referer: target.origin + '/' },
      redirect: 'follow', signal: AbortSignal.timeout(10000),
    });
  } catch { throw new HttpError(504, 'upstream_unreachable', 'Upstream site did not respond.'); }
  const text = await res.text();
  if (text.length > 2_000_000) throw new HttpError(413, 'too_large', 'Upstream response too large.');
  const headers = { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=60' };
  if (blockedByCloudflare(res, text)) { headers['x-upstream-blocked'] = 'cloudflare'; headers['cache-control'] = 'no-store'; }
  return new Response(text, { status: res.status, headers });
}

export async function handleApi(request, env = {}, opts = {}) {
  const f = opts.fetch || fetch;
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const route = parts[0] || '';
  try {
    // accounts: /api/auth/*, /api/sync, /api/admin/* (the only routes that accept POST/PUT/DELETE)
    const acct = await handleAccounts(request, env, url, parts, opts);
    if (acct) return acct;
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method_not_allowed' }, 405);
    if (route === 'health') {
      return json({ ok: true, tmdb: !!String(env.TMDB_API_KEY || '').trim(), accounts: !!env.DB, subtitles: { opensubtitles: !!env.OPENSUBTITLES_API_KEY, stremio: true }, edgeProxyHosts: proxyHosts(env) });
    }
    if (route === 'proxy') return await proxy(url, env, f);
    // Mavonyx web streams: needs a Referer a page cannot send (lib/mavonyx.js); signed, expiring URLs: never cached
    if (route === 'mavonyx' && parts[1] === 'play' && parts.length === 2) return json(await webPlay(url.searchParams, f));
    if (route === 'subs') {
      const q = url.searchParams;
      const type = q.get('type');
      if (!isType(type)) throw bad('type must be movie or tv');
      if (q.get('tmdb') && !isId(q.get('tmdb'))) throw bad('invalid tmdb id');
      if (type === 'tv' && !(isId(q.get('season')) && isId(q.get('episode')))) throw bad('season and episode are required for tv');
      const r = await searchSubtitles({ type, tmdbId: q.get('tmdb'), imdbId: q.get('imdb'), season: q.get('season'), episode: q.get('episode'), lang: q.get('lang') }, env, f);
      return json(r, 200, 3600);
    }
    if (route === 'sub') {
      const bytes = await fetchSubtitle(url.searchParams.get('id') || '', env, f);
      return new Response(bytes, { headers: { ...BASE_HEADERS, 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=86400' } });
    }

    const tmdb = createTmdb(env, f);
    if (route === 'home') return json(await getHome(tmdb), 200, 900);
    if (route === 'title') {
      if (!isType(parts[1]) || !isId(parts[2])) throw bad('Use /api/title/{movie|tv}/{id}');
      return json(await getTitle(tmdb, parts[1], parts[2]), 200, 3600);
    }
    if (route === 'season') {
      if (!isId(parts[1]) || !isId(parts[2])) throw bad('Use /api/season/{tvId}/{n}');
      return json(await getSeason(tmdb, parts[1], parts[2]), 200, 3600);
    }
    if (route === 'search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q || q.length > 100) throw bad('q is required (max 100 characters)');
      const page = Math.min(Math.max(parseInt(url.searchParams.get('page') || '1', 10) || 1, 1), 20);
      return json(await search(tmdb, q, page), 200, 300);
    }
    if (route === 'recs') {
      if (!isType(parts[1]) || !isId(parts[2])) throw bad('Use /api/recs/{movie|tv}/{id}');
      return json(await getRecs(tmdb, parts[1], parts[2]), 200, 3600);
    }
    return json({ error: 'not_found' }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
    return json({ error: 'internal_error', message: 'Unexpected server error.' }, 500);
  }
}
