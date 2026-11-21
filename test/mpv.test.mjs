// "Play in mpv": the site builds a raftv-mpv:// link with the stream's own URL (never the gateway's), and the
// packaged gateway program, started by Windows for that link, opens mpv and exits. Nothing is written to disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mpvLink, MPV_SCHEME, MPV_DEFAULT_REFERERS } from '../public/js/mpv.js';
import { parseLink, mpvArgs, registryCommands, mpvCommand, runMpvCommand } from '../gateway/mpv-handler.mjs';
import { DEFAULT_REFERERS } from '../gateway/bdix-gateway.mjs';
import { createNet } from '../public/js/net.js';
import { createStore, DEFAULT_SETTINGS } from '../public/js/store.js';
import { SYNCED_SETTINGS } from '../public/js/sync-merge.js';
import { playability, rank } from '../public/js/streams.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(root, 'dist', 'gateway', 'raftv-gateway.cjs');
const cf = { url: 'http://new.circleftp.net:5000/Movies/Inception 2010/Inception.2010.1080p.mkv', headers: {}, container: 'mkv' };
const link = (d) => `${MPV_SCHEME}://play?d=${Buffer.from(JSON.stringify(d)).toString('base64url')}`;

test('mpv link: carries the stream URL itself, never the gateway, so the gateway can be closed after the search', () => {
  const net = createNet(() => ({ gatewayUrl: 'http://127.0.0.1:8787', gatewayToken: 'secret-token' }), async () => { throw new Error('no fetch'); });
  assert.match(net.mediaUrl(cf), /^http:\/\/127\.0\.0\.1:8787\/s\?/, 'the in-page player would use the gateway');
  const l = mpvLink(cf, { title: 'Inception', start: 125.7 });
  assert.ok(l.startsWith('raftv-mpv://play?d='));
  assert.ok(!l.includes('8787') && !l.includes('secret'), 'no gateway address or token in the link');
  const p = parseLink(l);
  assert.equal(p.url, new URL(cf.url).href, 'spaces percent-encoded for mpv\'s HTTP client');
  assert.equal(p.title, 'Inception');
  assert.equal(p.start, 125);
  assert.equal(p.headers.referer, 'http://new.circleftp.net/', 'the per-host Referer the gateway would have added');
});

test('mpv link: per-host Referers match the gateway; stream headers (UA, Referer, cookies) are kept', () => {
  assert.deepEqual(MPV_DEFAULT_REFERERS, DEFAULT_REFERERS);
  const mx = { url: 'https://bcdn1.hakunaymatata.com/a/b.mp4', headers: { 'User-Agent': 'UA/1', Referer: 'https://movie-box.co/', Cookie: 'CloudFront-Policy=a,b; x=1', 'X-MB-Token': 't' } };
  const p = parseLink(mpvLink(mx, { title: 'Movie, The "Film"' }));
  assert.deepEqual(p.headers, { 'user-agent': 'UA/1', referer: 'https://movie-box.co/', cookie: 'CloudFront-Policy=a,b; x=1', 'x-mb-token': 't' });
  assert.equal(p.title, 'Movie, The "Film"');
  assert.equal(p.start, 0);
  // Unicode survives the base64 round trip
  assert.equal(parseLink(mpvLink(cf, { title: 'চলচ্চিত্র' })).title, 'চলচ্চিত্র');
});

test('mpv link parser: refuses anything but a plain http(s) media URL and safe values', () => {
  const ok = { v: 1, u: 'https://a.example/v.mp4', t: 'x', h: {} };
  assert.equal(parseLink(link(ok)).url, 'https://a.example/v.mp4');
  assert.equal(parseLink(link(ok).replace('play?', 'play/?')).url, 'https://a.example/v.mp4', 'trailing slash some browsers add');
  const bad = [
    'mpv://play?d=' + Buffer.from(JSON.stringify(ok)).toString('base64url'),
    'raftv-mpv://play',
    'raftv-mpv://play?d=%%%',
    'raftv-mpv://play?d=' + Buffer.from('not json').toString('base64url'),
    link({ ...ok, u: 'file:///C:/Windows/win.ini' }),
    link({ ...ok, u: 'edl://a' }),
    link({ ...ok, u: 'javascript:alert(1)' }),
    link({ ...ok, u: 'https://user:pw@a.example/v.mp4' }),
    link({ ...ok, u: 'https://a.example/v.mp4\n--script=evil.lua' }),
    link({ ...ok, u: '--script=evil.lua' }),
    link({ ...ok, u: 'https://a.example/' + 'x'.repeat(9000) }),
    link({ ...ok, h: { referer: 'a\r\nX-Evil: 1' } }),
    link({ ...ok, h: { 'bad name': 'v' } }),
    link({ ...ok, h: { 'x:y': 'v' } }),
    'raftv-mpv://play?d=' + 'A'.repeat(40000),
  ];
  for (const b of bad) assert.throws(() => parseLink(b), /link/i, b.slice(0, 80));
  const p = parseLink(link({ ...ok, t: 'a\u0000b\nc\u202e'.padEnd(500, 'z'), s: -5, extra: '--script=x' }));
  assert.equal(p.title.length, 200);
  assert.ok(!/[\u0000-\u001f\u202e]/.test(p.title), 'control and bidi characters removed');
  assert.equal(p.start, 0, 'negative start ignored');
  assert.equal(parseLink(link({ ...ok, s: 'x' })).start, 0);
});

test('mpv arguments: each value is one argument, the URL comes last after "--", resume and title are passed', () => {
  const args = mpvArgs(parseLink(mpvLink({ url: 'https://a.example/v.mp4', headers: { Referer: 'https://r.example/', 'User-Agent': 'UA', Cookie: 'a=1, b=2' } }, { title: 'T', start: 61 })));
  assert.deepEqual(args, [
    '--force-media-title=T', '--referrer=https://r.example/', '--user-agent=UA', '--http-header-fields-append=cookie: a=1, b=2',
    '--start=61', '--save-position-on-quit=no', '--', 'https://a.example/v.mp4',
  ]);
  const plain = mpvArgs(parseLink(link({ v: 1, u: 'http://172.16.50.14/a.mkv', t: '', h: {} })));
  assert.deepEqual(plain, ['--save-position-on-quit=no', '--', 'http://172.16.50.14/a.mkv']);
});

test('mpv registration: the Windows commands register raftv-mpv:// for this user only (HKCU), quoting paths with spaces', () => {
  const cmds = registryCommands({ exe: 'C:\\Users\\Some Name\\Downloads\\raftv-gateway.exe' });
  assert.deepEqual(cmds.register, [
    ['add', 'HKCU\\Software\\Classes\\raftv-mpv', '/ve', '/d', 'URL:RafTV mpv link', '/f'],
    ['add', 'HKCU\\Software\\Classes\\raftv-mpv', '/v', 'URL Protocol', '/d', '', '/f'],
    ['add', 'HKCU\\Software\\Classes\\raftv-mpv\\shell\\open\\command', '/ve', '/d', '"C:\\Users\\Some Name\\Downloads\\raftv-gateway.exe" --mpv-open "%1"', '/f'],
  ]);
  assert.deepEqual(cmds.unregister, [['delete', 'HKCU\\Software\\Classes\\raftv-mpv', '/f']]);
  // run from source (node + script) instead of the packaged program
  const src = registryCommands({ exe: 'C:\\node\\node.exe', script: 'C:\\r\\gateway\\exe-main.mjs' });
  assert.equal(src.register[2][4], '"C:\\node\\node.exe" "C:\\r\\gateway\\exe-main.mjs" --mpv-open "%1"');
});

test('mpv command line: only an exact flag selects a mode; the link is the next argument', () => {
  assert.equal(mpvCommand(['exe', 'exe']), null);
  assert.deepEqual(mpvCommand(['exe', 'exe', '--mpv-open', 'raftv-mpv://play?d=x']), { cmd: 'open', link: 'raftv-mpv://play?d=x' });
  assert.deepEqual(mpvCommand(['exe', 'exe', '--mpv-register']), { cmd: 'register' });
  assert.deepEqual(mpvCommand(['exe', 'exe', '--mpv-unregister']), { cmd: 'unregister' });
  assert.equal(mpvCommand(['exe', 'exe', '--mpv-openx', 'a']), null);
});

test('mpv handler: starts mpv detached and returns; mpvPath comes from the read-only settings file or MPV_PATH; nothing written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmpv-'));
  const calls = [];
  const spawn = (file, args, opts) => { calls.push({ file, args, opts }); return { unref() { calls.at(-1).unref = true; }, on() {} }; };
  const l = mpvLink(cf, { title: 'Inception' });
  const out = [];
  const log = (m) => out.push(m);
  assert.equal(runMpvCommand({ cmd: 'open', link: l }, { dir, env: {}, spawn, log, platform: 'win32' }), 0);
  assert.equal(calls[0].file, 'mpv.exe', 'Windows default: mpv.exe on PATH');
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.shell, undefined, 'no shell: arguments are never parsed by cmd.exe');
  assert.equal(calls[0].opts.stdio, 'ignore');
  assert.ok(calls[0].unref);
  assert.equal(calls[0].args.at(-1), new URL(cf.url).href);
  fs.writeFileSync(path.join(dir, 'raftv-gateway.json'), JSON.stringify({ mpvPath: 'D:\\Apps\\mpv\\mpv.exe' }));
  runMpvCommand({ cmd: 'open', link: l }, { dir, env: {}, spawn, log, platform: 'win32' });
  assert.equal(calls[1].file, 'D:\\Apps\\mpv\\mpv.exe');
  runMpvCommand({ cmd: 'open', link: l }, { dir, env: { MPV_PATH: '/usr/bin/mpv' }, spawn, log, platform: 'linux' });
  assert.equal(calls[2].file, '/usr/bin/mpv');
  assert.deepEqual(fs.readdirSync(dir), ['raftv-gateway.json'], 'only the file the user made');
  // a bad link starts nothing and reports why
  assert.equal(runMpvCommand({ cmd: 'open', link: 'raftv-mpv://play?d=bad' }, { dir, env: {}, spawn, log, platform: 'win32' }), 1);
  assert.equal(calls.length, 3);
  assert.match(out.join('\n'), /link/i);
  // dry run (environment only; a link cannot turn it on): prints the command, starts nothing
  out.length = 0;
  assert.equal(runMpvCommand({ cmd: 'open', link: l }, { dir, env: { RAFTV_MPV_DRY_RUN: '1' }, spawn, log, platform: 'win32' }), 0);
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(out.join('')), { file: 'D:\\Apps\\mpv\\mpv.exe', args: calls[0].args });
});

test('mpv handler: register/unregister only on Windows, through reg.exe without a shell', () => {
  const runs = [];
  const execFile = (file, args, opts) => { runs.push({ file, args, opts }); return ''; };
  const log = () => {};
  assert.equal(runMpvCommand({ cmd: 'register' }, { dir: os.tmpdir(), env: {}, execFile, log, platform: 'win32', exe: 'C:\\x\\raftv-gateway.exe' }), 0);
  assert.equal(runs.length, 3);
  assert.ok(runs.every((r) => r.file === 'reg' && !r.opts.shell));
  assert.equal(runMpvCommand({ cmd: 'unregister' }, { dir: os.tmpdir(), env: {}, execFile, log, platform: 'win32', exe: 'C:\\x\\raftv-gateway.exe' }), 0);
  assert.deepEqual(runs.at(-1).args, ['delete', 'HKCU\\Software\\Classes\\raftv-mpv', '/f']);
  assert.equal(runMpvCommand({ cmd: 'register' }, { dir: os.tmpdir(), env: {}, execFile, log, platform: 'linux', exe: '/x' }), 1);
  assert.equal(runs.length, 4);
});

test('"Play in" setting: built-in player by default, kept on this device only (not synced)', () => {
  assert.equal(DEFAULT_SETTINGS.playIn, 'browser');
  assert.ok(!SYNCED_SETTINGS.includes('playIn'));
  const s = createStore(null);
  s.saveSettings({ playIn: 'mpv' });
  assert.equal(s.settings().playIn, 'mpv');
});

test('ranking for mpv: files a browser cannot play (HEVC, DTS, AVI, DASH) are not marked "unlikely to play"', () => {
  const browser = { mkv: true, hevc: false, ac3: false, eac3: false, av1: false, nativeHls: false };
  const hevc = { url: 'http://x/a.mkv', container: 'mkv', height: 2160, info: { video: 'hevc', audio: ['dts'] } };
  const avi = { url: 'http://x/b.avi', container: 'avi', height: 480, info: {} };
  const dash = { url: 'https://x/c.mpd', container: 'mpd', height: 1080, info: {}, signedCookie: true };
  assert.equal(playability(hevc, browser).level, 'bad');
  for (const s of [hevc, avi, dash]) assert.deepEqual(playability(s, { ...browser, mpv: true }), { level: 'ok', reasons: [] });
  assert.equal(rank([avi, dash, hevc], { ...browser, mpv: true })[0].height, 2160, 'mpv: best resolution first');
});

test('packaged program: --mpv-open handles the link and exits without starting the gateway or writing files', () => {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build-gateway-exe.mjs'), '--bundle-only'], { cwd: root, stdio: 'ignore' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmpv-exe-'));
  const l = mpvLink(cf, { title: 'Inception', start: 90 });
  const r = spawnSync(process.execPath, [BUNDLE, '--mpv-open', l], { cwd: dir, env: { PATH: process.env.PATH, RAFTV_MPV_DRY_RUN: '1', MPV_PATH: 'mpv' }, encoding: 'utf8', timeout: 8000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/gateway is running/i.test(r.stdout), 'the gateway did not start');
  const got = JSON.parse(r.stdout);
  assert.equal(got.file, 'mpv');
  assert.deepEqual(got.args.slice(-2), ['--', new URL(cf.url).href]);
  assert.ok(got.args.includes('--start=90'));
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing written');
});
