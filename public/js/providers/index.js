// Runs the enabled providers in parallel, only when the user asks to play or download.
import * as df from './df.js';
import * as cf from './cf.js';
import * as fh from './fh.js';
import * as fn from './fn.js';
import * as hx from './hx.js';
import * as mx from './mx.js';

export const PROVIDERS = [df, cf, fh, fn, hx, mx];
export const providerById = (id) => PROVIDERS.find((p) => p.id === id);

/** Wraps the transport for one provider and counts what happened, so an empty result can be explained. */
export function makeCtx(net, provider, signal) {
  // One counted request. Failures become null, except AbortError/TimeoutError (the orchestrator reports those).
  // keepErrors: error responses reach `read` too (ctx.response; still counted).
  async function fetchOk(url, init, read, keepErrors = false) {
    ctx.attempts++;
    try {
      const res = await net.request(url, { ...init, signal, provider });
      if (!res.ok) {
        ctx.http++;
        // site refused Cloudflare (lib/api.js blockedByCloudflare)
        if (res.headers && res.headers.get('x-upstream-blocked')) ctx.blocked++;
        if (!keepErrors) return null;
      }
      return await read(res);
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw e;
      ctx.network++;
      return null;
    }
  }
  const ctx = {
    attempts: 0, network: 0, http: 0, blocked: 0,
    text: (url, init = {}) => fetchOk(url, init, (r) => r.text()),
    /** Raw response bytes (Uint8Array). Use for binary payloads: text() would replace invalid UTF-8 with U+FFFD. */
    bytes: (url, init = {}) => fetchOk(url, init, async (r) => new Uint8Array(await r.arrayBuffer())),
    response: (url, init = {}) => fetchOk(url, init, (r) => r, true),
    async json(url, init = {}) {
      const t = await ctx.text(url, init);
      if (t === null) return null;
      try { return JSON.parse(t); } catch { return null; }
    },
  };
  return ctx;
}

/** Why did a provider return nothing? */
export function classify(ctx, count) {
  if (count > 0) return 'ok';
  // nothing got through and the site refused the edge proxy: only the gateway can help
  if (ctx.blocked > 0 && ctx.network + ctx.http === ctx.attempts) return 'blocked';
  if (ctx.attempts > 0 && ctx.network === ctx.attempts) return 'unreachable'; // every request failed at the network level
  if (ctx.attempts > 0 && ctx.network + ctx.http === ctx.attempts) return 'error'; // servers answered with errors only
  return 'empty'; // servers answered fine, nothing matched
}

/**
 * @param meta {type:'movie'|'tv', tmdbId, title, year, season?, episode?}
 * @param opts.settleMs once any provider has streams, wait at most this long for the rest, then return what we have
 *        (a slow or dead server must not delay playback of a source that is already available). 0 = wait for everyone.
 * @returns {{streams: object[], status: Record<string, {state: string, count: number, ms: number}>, partial: boolean}}
 */
export async function resolveStreams(meta, { net, enabled = {}, signal, onProgress, compat = false, timeoutMs = 25000, settleMs = 0, DOMParser } = {}) {
  const status = {};
  const all = [];
  const active = PROVIDERS.filter((p) => enabled[p.id] !== false);
  const ctrls = new Map();
  let finalized = false;
  let settleTimer = null;
  let settleNow;
  const settled = new Promise((r) => { settleNow = r; });

  const tasks = active.map(async (p) => {
    const started = Date.now();
    const ctrl = new AbortController();
    ctrls.set(p.id, ctrl);
    const onAbort = () => ctrl.abort(signal.reason);
    if (signal) { if (signal.aborted) ctrl.abort(signal.reason); else signal.addEventListener('abort', onAbort, { once: true }); }
    const timer = setTimeout(() => ctrl.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs);
    const ctx = makeCtx(net, p, ctrl.signal);
    onProgress && onProgress(p.id, 'start');
    try {
      const streams = await p.search(meta, ctx, { compat, DOMParser });
      if (finalized) return;
      status[p.id] = { state: classify(ctx, streams.length), count: streams.length, ms: Date.now() - started };
      all.push(...streams);
      if (streams.length && settleMs > 0 && !settleTimer) settleTimer = setTimeout(settleNow, settleMs);
    } catch (e) {
      if (finalized) return;
      if (signal && signal.aborted) status[p.id] = { state: 'cancelled', count: 0, ms: Date.now() - started };
      else status[p.id] = { state: e && e.name === 'TimeoutError' ? 'timeout' : 'error', count: 0, ms: Date.now() - started };
    } finally {
      clearTimeout(timer);
      // the provider has answered: abort requests it left running (e.g. a slow fallback endpoint)
      if (!ctrl.signal.aborted) ctrl.abort(new DOMException('Provider finished', 'AbortError'));
      signal && signal.removeEventListener('abort', onAbort);
      if (!finalized) onProgress && onProgress(p.id, 'done', status[p.id]);
    }
  });

  await Promise.race([Promise.all(tasks), settled]);
  clearTimeout(settleTimer);
  finalized = true;
  let partial = false;
  for (const p of active) {
    if (!status[p.id]) { partial = true; status[p.id] = { state: 'slow', count: 0, ms: 0 }; ctrls.get(p.id).abort(); onProgress && onProgress(p.id, 'done', status[p.id]); }
  }
  // Same URL from several providers: keep the entry that knows the resolution (arrival order is random)
  const byUrl = new Map();
  for (const s of all) { const prev = byUrl.get(s.url); if (!prev || s.height > prev.height) byUrl.set(s.url, s); }
  return { streams: [...byUrl.values()], status, partial };
}
