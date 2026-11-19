// Everything the app remembers lives in localStorage on the user's device. When the user signs in, the library
// (history, lists, resume positions, synced settings) is also merged with their account by sync.js.
import { merge, normalize, emptyDoc, itemKey, DEFAULT_LIST, SYNCED_SETTINGS, LIMITS } from './sync-merge.js';

const PREFIX = 'rh:';

export const DEFAULT_SETTINGS = {
  gatewayUrl: '',
  gatewayToken: '',
  edge: true, // fetch FlixHub through the Pages edge proxy when no gateway is set
  providers: { 'bdix-df': true, 'bdix-cf': true, 'bdix-fh': true, fendrix: true, hexion: true, mavonyx: true },
  compat: false, // true = only the file types the original extension accepted (mkv/mp4/avi)
  subLangs: ['en'],
  autoSubs: true,
  subStyle: { size: 100, color: '#ffffff', bg: 'shadow', bottom: 6 },
  autoNext: true,
  preferCompatible: true, // pick the best source the browser can most likely play
};

const MAX_HISTORY = 40;
const MAX_PROGRESS = 300;

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
}

export function createStore(storage, { now = () => Date.now(), randomId = () => Math.random().toString(36).slice(2, 10) } = {}) {
  let st = storage;
  if (!st) { try { st = globalThis.localStorage; st.getItem('x'); } catch { st = memoryStorage(); } }
  const listeners = new Set();
  const read = (key, fallback) => { try { const v = st.getItem(PREFIX + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } };
  const write = (key, value) => { try { st.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* storage full or blocked: keep running */ } listeners.forEach((fn) => fn(key)); };
  const merge2 = (base, over) => {
    const out = { ...base };
    for (const [k, v] of Object.entries(over || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' ? { ...base[k], ...v } : v;
    return out;
  };
  // Times must increase even if two changes land in the same millisecond (a remove right after an add must win).
  let lastTs = 0;
  const stamp = () => { lastTs = Math.max(now(), lastTs + 1); return lastTs; };

  /** history, historyDel, lists, listsDel. Built once from the pre-lists format ('history' array + 'list' array). */
  function lib() {
    const l = read('library', null);
    if (l) return l;
    const doc = emptyDoc();
    const t0 = now();
    for (const e of read('history', [])) if (e && (e.type === 'movie' || e.type === 'tv')) doc.history[itemKey(e.type, e.id)] = { ...e, ts: e.ts || t0 };
    const items = {};
    read('list', []).forEach((x, i) => { items[itemKey(x.type, x.id)] = { ...x, ts: t0 - i }; }); // keep the old order
    doc.lists[DEFAULT_LIST] = { id: DEFAULT_LIST, name: 'My List', nameTs: 0, created: 0, ts: t0, items, itemsDel: {} };
    const out = { history: doc.history, historyDel: {}, lists: doc.lists, listsDel: {} };
    try { st.setItem(PREFIX + 'library', JSON.stringify(out)); } catch { /* keep in memory below */ }
    return out;
  }
  const saveLib = (l) => write('library', l);
  const ensureDefault = (l) => {
    if (!l.lists[DEFAULT_LIST]) l.lists[DEFAULT_LIST] = { id: DEFAULT_LIST, name: 'My List', nameTs: 0, created: 0, ts: 0, items: {}, itemsDel: {} };
    return l;
  };
  const brief = (item) => ({ type: item.type, id: Number(item.id), title: item.title, year: item.year || '', poster: item.poster || null, rating: item.rating || 0 });
  const sortedItems = (map) => Object.values(map).sort((a, b) => b.ts - a.ts);

  return {
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    // ---- settings ----
    settings: () => merge2(DEFAULT_SETTINGS, read('settings', {})),
    saveSettings(patch) {
      const next = merge2(this.settings(), patch);
      if (Object.keys(patch || {}).some((k) => SYNCED_SETTINGS.includes(k))) { try { st.setItem(PREFIX + 'settingsTs', JSON.stringify(stamp())); } catch { /* full */ } }
      write('settings', next);
      return next;
    },
    resetSettings() { try { st.setItem(PREFIX + 'settingsTs', JSON.stringify(stamp())); } catch { /* full */ } write('settings', {}); },
    // ---- watch progress ----
    progress: (key) => read('progress', {})[key] || null,
    saveProgress(key, pos, dur) {
      const all = read('progress', {});
      all[key] = { pos: Math.floor(pos), dur: Math.floor(dur), ts: stamp() };
      const keys = Object.keys(all);
      if (keys.length > MAX_PROGRESS) keys.sort((a, b) => all[a].ts - all[b].ts).slice(0, keys.length - MAX_PROGRESS).forEach((k) => delete all[k]);
      write('progress', all);
    },
    clearProgress(key) { const all = read('progress', {}); delete all[key]; write('progress', all); },
    clearAllProgress() { write('progress', {}); },
    /** resume only if meaningfully into the video and not near the end */
    resumePoint(key) {
      const p = this.progress(key);
      if (!p || !p.dur) return 0;
      return p.pos > 30 && p.pos < p.dur * 0.93 ? p.pos : 0;
    },
    // ---- history (continue watching) ----
    history: () => sortedItems(lib().history),
    pushHistory(entry) {
      const l = lib();
      const k = itemKey(entry.type, entry.id);
      l.history[k] = { ...entry, ts: stamp() };
      delete l.historyDel[k];
      const keys = Object.keys(l.history);
      if (keys.length > MAX_HISTORY) for (const old of keys.sort((a, b) => l.history[b].ts - l.history[a].ts).slice(MAX_HISTORY)) delete l.history[old];
      saveLib(l);
    },
    /** Removes one title; returns the removed entry so the caller can offer Undo. */
    removeHistory(type, id) {
      const l = lib();
      const k = itemKey(type, id);
      const removed = l.history[k] || null;
      delete l.history[k];
      l.historyDel[k] = stamp();
      saveLib(l);
      return removed;
    },
    /** Undo of removeHistory: the entry comes back with a fresh time so it beats the tombstone everywhere. */
    restoreHistory(entry) {
      const l = lib();
      const k = itemKey(entry.type, entry.id);
      l.history[k] = { ...entry, ts: stamp() };
      delete l.historyDel[k];
      saveLib(l);
    },
    clearHistory() {
      const l = lib();
      const t = stamp();
      for (const k of Object.keys(l.history)) l.historyDel[k] = t;
      l.history = {};
      saveLib(l);
    },
    // ---- lists ----
    /** All lists, "My List" first, then by creation. Items newest first. */
    lists() {
      const l = ensureDefault(lib());
      return Object.values(l.lists)
        .sort((a, b) => (a.id === DEFAULT_LIST ? -1 : b.id === DEFAULT_LIST ? 1 : a.created - b.created || (a.id < b.id ? -1 : 1)))
        .map((x) => ({ id: x.id, name: x.name, items: sortedItems(x.items) }));
    },
    listsWith(type, id) { const k = itemKey(type, id); return this.lists().filter((x) => x.items.some((i) => itemKey(i.type, i.id) === k)).map((x) => x.id); },
    inAnyList(type, id) { return this.listsWith(type, id).length > 0; },
    createList(name) {
      const clean = String(name || '').trim().slice(0, LIMITS.listName);
      if (!clean) throw new Error('Give the list a name.');
      const l = ensureDefault(lib());
      if (Object.keys(l.lists).length >= LIMITS.lists) throw new Error(`You can have up to ${LIMITS.lists} lists.`);
      if (Object.values(l.lists).some((x) => x.name.toLowerCase() === clean.toLowerCase())) throw new Error('A list with that name already exists.');
      const id = 'l' + randomId();
      const t = stamp();
      l.lists[id] = { id, name: clean, nameTs: t, created: t, ts: t, items: {}, itemsDel: {} };
      saveLib(l);
      return id;
    },
    renameList(id, name) {
      const clean = String(name || '').trim().slice(0, LIMITS.listName);
      if (!clean) throw new Error('Give the list a name.');
      const l = ensureDefault(lib());
      if (!l.lists[id]) throw new Error('That list no longer exists.');
      if (Object.values(l.lists).some((x) => x.id !== id && x.name.toLowerCase() === clean.toLowerCase())) throw new Error('A list with that name already exists.');
      const t = stamp();
      Object.assign(l.lists[id], { name: clean, nameTs: t, ts: t });
      saveLib(l);
    },
    deleteList(id) {
      if (id === DEFAULT_LIST) throw new Error('My List cannot be deleted.');
      const l = lib();
      if (!l.lists[id]) return;
      delete l.lists[id];
      l.listsDel[id] = stamp();
      saveLib(l);
    },
    addToList(listId, item) {
      const l = ensureDefault(lib());
      const list = l.lists[listId];
      if (!list) throw new Error('That list no longer exists.');
      const k = itemKey(item.type, item.id);
      const t = stamp();
      list.items[k] = { ...brief(item), ts: t };
      delete list.itemsDel[k];
      list.ts = t;
      saveLib(l);
    },
    removeFromList(listId, type, id) {
      const l = ensureDefault(lib());
      const list = l.lists[listId];
      if (!list) return null;
      const k = itemKey(type, id);
      const removed = list.items[k] || null;
      const t = stamp();
      delete list.items[k];
      list.itemsDel[k] = t;
      list.ts = t;
      saveLib(l);
      return removed;
    },
    // ---- sync ----
    /** The library as a sync document. */
    exportDoc() {
      const l = ensureDefault(lib());
      const s = this.settings();
      const value = {};
      for (const k of SYNCED_SETTINGS) value[k] = s[k];
      return normalize({ ...l, progress: read('progress', {}), settings: { ts: read('settingsTs', 0), value } });
    },
    /** Merge a document (e.g. from the account) into this device. Returns the merged document. */
    importDoc(doc) {
      const merged = merge(this.exportDoc(), doc);
      try { st.setItem(PREFIX + 'progress', JSON.stringify(merged.progress)); } catch { /* full */ }
      if (merged.settings.ts > read('settingsTs', 0)) {
        try { st.setItem(PREFIX + 'settings', JSON.stringify({ ...read('settings', {}), ...merged.settings.value })); st.setItem(PREFIX + 'settingsTs', JSON.stringify(merged.settings.ts)); } catch { /* full */ }
      }
      lastTs = Math.max(lastTs, merged.settings.ts);
      saveLib({ history: merged.history, historyDel: merged.historyDel, lists: merged.lists, listsDel: merged.listsDel });
      return merged;
    },
    /** Sign-out on a shared device: remove what belongs to the account (device settings such as the gateway stay). */
    clearAccountData() {
      for (const k of ['library', 'progress', 'settingsTs', 'history', 'list']) { try { st.removeItem(PREFIX + k); } catch { /* blocked */ } }
      const s = read('settings', {});
      const keep = {};
      for (const k of Object.keys(s)) if (!SYNCED_SETTINGS.includes(k)) keep[k] = s[k];
      write('settings', keep);
      write('library', null);
      try { st.removeItem(PREFIX + 'library'); } catch { /* blocked */ }
    },
  };
}

export const store = createStore();
