import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, DEFAULT_SETTINGS } from '../public/js/store.js';
import { browserCaps, playability, rank, externalLinks, m3uPlaylist, filenameFor, sourceLabel } from '../public/js/streams.js';
import { decodeBytes, srtToVtt, subtitleStyle, countCues, vttBlobUrl } from '../public/js/subs.js';
import { runtimeText, clock, progressKey, sanitizeFilename, clamp, debounce } from '../public/js/util.js';
import { makeStream } from '../public/js/providers/common.js';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };

test('store: settings defaults, deep merge, reset, corrupt data falls back', () => {
  const st = createStore(mem());
  assert.deepEqual(st.settings(), DEFAULT_SETTINGS);
  st.saveSettings({ gatewayUrl: 'http://127.0.0.1:8787', providers: { 'bdix-fh': false }, subStyle: { size: 130 } });
  const s = st.settings();
  assert.equal(s.gatewayUrl, 'http://127.0.0.1:8787'); assert.deepEqual(s.providers, { 'bdix-df': true, 'bdix-cf': true, 'bdix-fh': false, fendrix: true, hexion: true, mavonyx: true }, 'deep merge keeps the other defaults');
  assert.deepEqual(s.subStyle, { size: 130, color: '#ffffff', bg: 'shadow', bottom: 6 });
  const bad = mem(); bad.setItem('rh:settings', '{not json'); assert.deepEqual(createStore(bad).settings(), DEFAULT_SETTINGS);
  st.resetSettings(); assert.deepEqual(st.settings(), DEFAULT_SETTINGS);
});

test('store: survives unavailable storage (private mode / quota)', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  const st = createStore(broken);
  assert.doesNotThrow(() => st.saveSettings({ autoNext: false }));
  assert.deepEqual(st.settings(), DEFAULT_SETTINGS);
  assert.deepEqual(st.history(), []);
});

test('store: history is deduped per title, newest first, capped at 40', () => {
  const st = createStore(mem());
  st.pushHistory({ type: 'movie', id: 1, title: 'A' }); st.pushHistory({ type: 'tv', id: 1, title: 'T', season: 1, episode: 1 }); st.pushHistory({ type: 'movie', id: 1, title: 'A again' });
  assert.deepEqual(st.history().map((h) => `${h.type}:${h.id}:${h.title}`), ['movie:1:A again', 'tv:1:T']);
  for (let i = 0; i < 60; i++) st.pushHistory({ type: 'movie', id: 1000 + i, title: 'x' });
  assert.equal(st.history().length, 40); assert.equal(st.history()[0].id, 1059);
  st.removeHistory('movie', 1059); assert.equal(st.history()[0].id, 1058);
});

test('store: resume point rules + progress pruning', () => {
  const st = createStore(mem());
  st.saveProgress('movie:1', 20, 6000); assert.equal(st.resumePoint('movie:1'), 0, 'too early to resume');
  st.saveProgress('movie:1', 600, 6000); assert.equal(st.resumePoint('movie:1'), 600);
  st.saveProgress('movie:1', 5700, 6000); assert.equal(st.resumePoint('movie:1'), 0, 'finished (>93%)');
  assert.equal(st.resumePoint('nope'), 0);
  for (let i = 0; i < 320; i++) st.saveProgress('tv:9:1:' + i, 100 + i, 3000);
  assert.ok(st.progress('tv:9:1:319')); assert.equal(st.progress('tv:9:1:0'), null, 'oldest entries pruned');
  st.clearProgress('tv:9:1:319'); assert.equal(st.progress('tv:9:1:319'), null);
});

test('store: clear history / progress', () => {
  const st = createStore(mem());
  st.pushHistory({ type: 'movie', id: 1, title: 'A' }); st.saveProgress('movie:1', 100, 1000);
  st.clearHistory(); st.clearAllProgress();
  assert.deepEqual(st.history(), []); assert.equal(st.progress('movie:1'), null);
});

test('store: lists (add, remove, create, rename, delete) + change notifications', () => {
  const st = createStore(mem()); let n = 0; const off = st.onChange(() => n++);
  assert.deepEqual(st.lists().map((l) => [l.id, l.name, l.items.length]), [['default', 'My List', 0]], 'My List always exists');
  st.addToList('default', { type: 'movie', id: 5, title: 'X', year: '2020', poster: '/p', rating: 7 });
  assert.equal(st.inAnyList('movie', 5), true); assert.equal(st.inAnyList('tv', 5), false);
  const id = st.createList('  Weekend  ');
  assert.equal(st.lists()[1].name, 'Weekend', 'trimmed; listed after My List');
  st.addToList(id, { type: 'tv', id: 9, title: 'Show' });
  assert.deepEqual(st.listsWith('tv', 9), [id]);
  assert.throws(() => st.createList('weekend'), /already exists/, 'names are unique, case-insensitive');
  assert.throws(() => st.createList('   '), /name/);
  assert.throws(() => st.renameList(id, 'MY LIST'), /already exists/);
  st.renameList(id, 'Later');
  assert.equal(st.lists()[1].name, 'Later');
  assert.equal(st.removeFromList('default', 'movie', 5).title, 'X', 'returns the removed item (for Undo)');
  assert.equal(st.inAnyList('movie', 5), false);
  assert.throws(() => st.deleteList('default'), /cannot be deleted/);
  st.deleteList(id); assert.equal(st.lists().length, 1);
  assert.equal(n, 6); off(); st.addToList('default', { type: 'movie', id: 6, title: 'Y' }); assert.equal(n, 6);
});

test('store: history remove/undo/clear leave tombstones; old single "My List" is migrated', () => {
  const m = mem();
  m.setItem('rh:history', JSON.stringify([{ type: 'movie', id: 1, title: 'A', ts: 10 }, { type: 'tv', id: 2, title: 'B', season: 1, episode: 3, ts: 5 }]));
  m.setItem('rh:list', JSON.stringify([{ type: 'movie', id: 7, title: 'Newest' }, { type: 'movie', id: 8, title: 'Older' }]));
  let t = 1000;
  const st = createStore(m, { now: () => t });
  assert.deepEqual(st.history().map((h) => h.id), [1, 2], 'legacy history kept, newest first');
  assert.deepEqual(st.lists()[0].items.map((i) => i.title), ['Newest', 'Older'], 'legacy My List kept in order');
  const removed = st.removeHistory('movie', 1);
  assert.deepEqual(st.history().map((h) => h.id), [2]);
  assert.ok(st.exportDoc().historyDel['movie:1'] > 0, 'a tombstone records the removal');
  st.restoreHistory(removed);
  assert.deepEqual(st.history().map((h) => h.id), [1, 2], 'undo puts it back at the front');
  assert.equal(st.exportDoc().historyDel['movie:1'], undefined);
  st.pushHistory({ type: 'movie', id: 1, title: 'A' }); st.removeHistory('movie', 1); // same millisecond: remove still wins
  assert.equal(st.history().some((h) => h.id === 1), false);
  st.clearHistory(); assert.equal(st.history().length, 0);
  assert.ok(st.exportDoc().historyDel['tv:2'] > 0);
});

const caps = (o = {}) => ({ hevc: false, av1: false, vp9: true, ac3: false, eac3: false, mkv: true, platform: 'desktop', ...o });
const S = (name, o = {}) => ({ ...makeStream({ provider: 'bdix-df', providerName: 'DhakaFlix', url: 'http://h/' + name, quality: o.quality || '1080p' }), ...o });

test('browserCaps: reads canPlayType and platform', () => {
  const v = { canPlayType: (t) => (/hvc1|hev1/.test(t) ? '' : /ac-3|ec-3/.test(t) ? '' : 'probably') };
  const c = browserCaps(v, 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/153 Safari/537.36');
  assert.deepEqual([c.hevc, c.ac3, c.eac3, c.vp9, c.mkv, c.platform], [false, false, false, true, true, 'desktop']);
  const ios = browserCaps(v, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1');
  assert.deepEqual([ios.mkv, ios.platform], [false, 'ios']);
  assert.equal(browserCaps(v, 'Mozilla/5.0 (Linux; Android 14) Chrome/153 Mobile Safari/537.36').platform, 'android');
  assert.equal(browserCaps(null, '').hevc, false);
});

test('playability: matches what real Chromium did with these files', () => {
  assert.equal(playability(S('Film.2020.1080p.WEB-DL.x264.AAC.mp4'), caps()).level, 'ok');
  assert.equal(playability(S('Film.2020.1080p.WEB-DL.x264.AAC.mov'), caps()).level, 'ok', 'MOV with H.264/AAC plays');
  assert.equal(playability(S('Film.2020.1080p.WEB-DL.x264.AAC.mkv'), caps()).level, 'ok', 'MKV with H.264/AAC plays');
  const hevc = playability(S('Film.2020.2160p.BluRay.x265.AAC.mkv'), caps());
  assert.equal(hevc.level, 'bad'); assert.match(hevc.reasons[0], /HEVC/);
  assert.equal(playability(S('Film.2020.2160p.BluRay.x265.AAC.mkv'), caps({ hevc: true })).level, 'ok');
  const ac3 = playability(S('Film.2020.1080p.WEB-DL.x264.DDP5.1.mkv'), caps());
  assert.equal(ac3.level, 'warn'); assert.match(ac3.reasons[0], /silent/);
  assert.equal(playability(S('Film.2020.1080p.WEB-DL.x264.DDP5.1.mkv'), caps({ eac3: true })).level, 'ok');
  assert.equal(playability(S('Film.2020.1080p.WEB-DL.x264.AAC.DDP5.1.mkv'), caps()).level, 'ok', 'a playable audio track is present');
  assert.equal(playability(S('Old.Film.DVDRip.avi'), caps()).level, 'bad');
  assert.equal(playability(S('Film.1080p.x264.AAC.mkv'), caps({ mkv: false })).level, 'bad', 'Safari/iOS cannot open MKV');
  assert.equal(playability(S('mystery.mp4'), caps()).level, 'ok', 'unknown codecs are not penalised');
});

test('rank: playable first, then resolution, then container, provider order', () => {
  const list = [
    S('A.2160p.x265.AAC.mkv', { quality: '2160p' }),
    S('B.1080p.x264.AAC.mkv', { quality: '1080p' }),
    S('C.1080p.x264.AAC.mp4', { quality: '1080p' }),
    S('D.720p.x264.DDP5.1.mkv', { quality: '720p' }),
    S('E.1080p.x264.AAC.mp4', { quality: '1080p', provider: 'bdix-cf' }),
  ];
  assert.deepEqual(rank(list, caps()).map((s) => s.filename[0]), ['C', 'E', 'B', 'D', 'A'], 'mp4>mkv at equal height; DF before CF; warn then bad last');
  assert.deepEqual(rank(list, caps(), { preferCompatible: false }).map((s) => s.filename[0]), ['A', 'C', 'E', 'B', 'D'], 'pure quality order when compatibility preference is off');
  assert.equal(rank(list, caps())[0].play.level, 'ok');
});

test('external links, m3u, filenames, labels', () => {
  const a = externalLinks('http://172.16.50.12/a/b%20c.mkv', 'Film (2020)', 'android');
  assert.equal(a.length, 2); assert.match(a[0].href, /^intent:\/\/172\.16\.50\.12\/a\/b%20c\.mkv#Intent;scheme=http;action=android\.intent\.action\.VIEW;type=video\/\*;package=org\.videolan\.vlc;S\.title=Film%20\(2020\);end$/);
  const i = externalLinks('http://x/a.mkv', 'T', 'ios'); assert.match(i[0].href, /^vlc-x-callback:\/\/x-callback-url\/stream\?url=http%3A%2F%2Fx%2Fa\.mkv$/);
  assert.deepEqual(externalLinks('http://x/a.mkv', 'T', 'desktop'), []);
  assert.equal(m3uPlaylist('http://x/a.mkv', 'Two\nLines'), '#EXTM3U\n#EXTINF:-1,Two Lines\nhttp://x/a.mkv\n');
  assert.equal(filenameFor(S('The.Matrix.1999.1080p.mkv'), 'The Matrix'), 'The.Matrix.1999.1080p.mkv');
  assert.equal(filenameFor({ filename: '', container: 'unknown' }, 'A/B: C'), 'A_B_ C.mp4');
  assert.equal(sourceLabel(S('x.mov', { quality: '720p' })), '720p MOV'); assert.equal(sourceLabel({ quality: 'Unknown', container: 'unknown' }), '');
});

test('subs: encoding detection', () => {
  assert.equal(decodeBytes(new TextEncoder().encode('caf\u00e9 \u4e2d')), 'caf\u00e9 \u4e2d');
  assert.equal(decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])), 'hi', 'UTF-8 BOM stripped');
  assert.equal(decodeBytes(new Uint8Array([0x63, 0x61, 0x66, 0xe9])), 'caf\u00e9', 'invalid UTF-8 -> windows-1252');
  assert.equal(decodeBytes(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])), 'hi', 'UTF-16LE');
});

test('subs: SRT -> VTT conversion', () => {
  const srt = '\uFEFF1\r\n0:00:01,5 --> 00:00:03,000\r\n{\\an8}<font color="red">Hello</font> <i>there</i> <b>x</b><u>y</u><span>z</span>\r\n\r\n2\r\n00:01:00,250 --> 00:01:02,000\r\nBye\r\n';
  const vtt = srtToVtt(srt);
  assert.ok(vtt.startsWith('WEBVTT\n\n'));
  assert.ok(vtt.includes('00:00:01.500 --> 00:00:03.000'), 'short hours and ms are padded');
  assert.ok(vtt.includes('Hello <i>there</i> <b>x</b><u>y</u>z'), 'ASS tags/font/unknown tags stripped, b/i/u kept');
  assert.ok(vtt.includes('00:01:00.250 --> 00:01:02.000'));
  assert.equal(countCues(vtt), 2);
  assert.equal(srtToVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx\n', 'VTT passes through');
  assert.throws(() => vttBlobUrl('no cues here'), /no readable cues/);
});

test('subs: style maps prefs to CSS and scales with player width, clamped', () => {
  const p = { size: 100, color: '#fff', bg: 'box', bottom: 6 };
  assert.equal(subtitleStyle(p, 380).fontSize, '12px'); assert.equal(subtitleStyle(p, 1140).fontSize, '30px');
  assert.equal(subtitleStyle({ ...p, size: 200 }, 1140).fontSize, '60px'); assert.equal(subtitleStyle({ ...p, size: 200 }, 4000).fontSize, '72px');
  assert.match(subtitleStyle(p).background, /rgba/); assert.equal(subtitleStyle({ ...p, bg: 'none' }).textShadow, 'none'); assert.match(subtitleStyle({ ...p, bg: 'shadow' }).textShadow, /#000/);
  assert.equal(subtitleStyle({ ...p, bg: 'weird' }).background, 'transparent');
});

test('util: formatting helpers', async () => {
  assert.deepEqual([runtimeText(136), runtimeText(60), runtimeText(45), runtimeText(0)], ['2h 16m', '1h', '45m', '']);
  assert.deepEqual([clock(0), clock(75), clock(3725), clock(-1), clock(NaN)], ['0:00', '1:15', '1:02:05', '0:00', '0:00']);
  assert.deepEqual([progressKey('movie', 603), progressKey('tv', 1396, 1, 2)], ['movie:603', 'tv:1396:1:2']);
  assert.equal(sanitizeFilename('a/b:c*?"<>|\n d'), 'a_b_c_______ d');
  assert.equal(sanitizeFilename(''), 'video'); assert.equal(sanitizeFilename('x'.repeat(400)).length, 150);
  assert.ok(!/[\\/:*?"<>|]/.test(sanitizeFilename('a/b:c*?"<>|')));
  assert.equal(clamp(5, 0, 3), 3);
  let n = 0; const d = debounce(() => n++, 20); d(); d(); d(); await new Promise((r) => setTimeout(r, 60)); assert.equal(n, 1);
});
