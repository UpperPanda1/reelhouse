// "Play in mpv", the computer's side. The site links to raftv-mpv://play?d=<base64url JSON> (public/js/mpv.js); after
// a one-time `raftv-gateway.exe --mpv-register`, Windows starts `raftv-gateway.exe --mpv-open "<link>"` for such a link.
// This file checks the link, starts mpv with the stream's own URL and headers, and returns: the gateway itself is not
// started and does not need to be running (mpv fetches the video directly). Nothing is written to disk; --mpv-register
// writes only the three registry values that tell Windows about raftv-mpv:// (HKCU: this user; --mpv-unregister removes them).
//
// Any web page could open such a link, so it is treated as untrusted: only an http(s) URL without credentials, a short
// title and a few plain header values are accepted, every value becomes exactly one argument (no shell), and "--"
// ends mpv's options before the URL.
import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn, execFileSync } from 'node:child_process';

export const SCHEME = 'raftv-mpv';
const KEY = 'HKCU\\Software\\Classes\\' + SCHEME;
const MAX_LINK = 16384;
const HEADER_NAME = /^[a-z0-9-]{1,40}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const TITLE_STRIP = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

const bad = (why) => Object.assign(new Error(`Not a valid RafTV mpv link: ${why}`), { code: 'EBADLINK' });

/** @returns {{url: string, title: string, headers: Record<string,string>, start: number}} or throws (message mentions "link") */
export function parseLink(link) {
  const s = String(link || '');
  if (s.length > MAX_LINK) throw bad('too long');
  const m = /^raftv-mpv:\/\/play\/?\?(.*)$/is.exec(s);
  if (!m) throw bad('wrong form');
  const d = new URLSearchParams(m[1]).get('d') || '';
  if (!/^[A-Za-z0-9_-]+$/.test(d)) throw bad('no data');
  let o;
  try { o = JSON.parse(Buffer.from(d, 'base64url').toString('utf8')); } catch { throw bad('unreadable data'); }
  if (!o || typeof o !== 'object' || o.v !== 1) throw bad('unknown version');
  if (typeof o.u !== 'string' || o.u.length > 8192 || CONTROL.test(o.u)) throw bad('bad address');
  let u;
  try { u = new URL(o.u); } catch { throw bad('bad address'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad('only http(s) addresses');
  if (u.username || u.password) throw bad('credentials in the address');
  const headers = {};
  const h = o.h && typeof o.h === 'object' && !Array.isArray(o.h) ? o.h : {};
  const entries = Object.entries(h);
  if (entries.length > 8) throw bad('too many headers');
  for (const [k, v] of entries) {
    if (!HEADER_NAME.test(k)) throw bad('bad header name');
    if (typeof v !== 'string' || v.length > 4096 || CONTROL.test(v)) throw bad('bad header value');
    headers[k] = v;
  }
  const title = String(typeof o.t === 'string' ? o.t : '').replace(TITLE_STRIP, '').slice(0, 200);
  const start = Number.isInteger(o.s) && o.s > 0 && o.s < 1e6 ? o.s : 0;
  return { url: u.href, title, headers, start };
}

/** mpv's argument list: one value per argument, URL last after "--". mpv's own defaults already write nothing; the
 * explicit --save-position-on-quit=no keeps it so even if the user's mpv.conf turns it on. */
export function mpvArgs({ url, title, headers, start }) {
  const a = [];
  if (title) a.push(`--force-media-title=${title}`);
  if (headers.referer) a.push(`--referrer=${headers.referer}`);
  if (headers['user-agent']) a.push(`--user-agent=${headers['user-agent']}`);
  for (const [k, v] of Object.entries(headers)) if (k !== 'referer' && k !== 'user-agent') a.push(`--http-header-fields-append=${k}: ${v}`);
  if (start > 0) a.push(`--start=${start}`);
  a.push('--save-position-on-quit=no', '--', url);
  return a;
}

/** reg.exe argument lists. `script` is set when run from source (node + exe-main.mjs) instead of the packaged program. */
export function registryCommands({ exe, script }) {
  const command = `"${exe}"${script ? ` "${script}"` : ''} --mpv-open "%1"`;
  return {
    register: [
      ['add', KEY, '/ve', '/d', 'URL:RafTV mpv link', '/f'],
      ['add', KEY, '/v', 'URL Protocol', '/d', '', '/f'],
      ['add', KEY + '\\shell\\open\\command', '/ve', '/d', command, '/f'],
    ],
    unregister: [['delete', KEY, '/f']],
  };
}

/** Which mpv mode the command line asks for, or null (then the gateway starts as usual). */
export function mpvCommand(argv) {
  const i = argv.indexOf('--mpv-open');
  if (i >= 0) return { cmd: 'open', link: String(argv[i + 1] || '') };
  if (argv.includes('--mpv-register')) return { cmd: 'register' };
  if (argv.includes('--mpv-unregister')) return { cmd: 'unregister' };
  return null;
}

/** mpv's path: MPV_PATH, else "mpvPath" in the user's raftv-gateway.json (read only), else mpv on PATH. */
function mpvPath(dir, env, platform) {
  if (env.MPV_PATH) return env.MPV_PATH;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'raftv-gateway.json'), 'utf8'));
    if (s && typeof s.mpvPath === 'string' && s.mpvPath.trim()) return s.mpvPath.trim();
  } catch { /* no file */ }
  return platform === 'win32' ? 'mpv.exe' : 'mpv';
}

/** Runs one mpv mode. Returns the exit code; `onError` hears about a failed mpv start (reported asynchronously). */
export function runMpvCommand(c, { dir, env = process.env, spawn = nodeSpawn, execFile = execFileSync, log = console.log, platform = process.platform, exe, script, onError } = {}) {
  if (c.cmd === 'open') {
    let parsed;
    try { parsed = parseLink(c.link); } catch (e) { log(e.message); return 1; }
    const file = mpvPath(dir, env, platform);
    const args = mpvArgs(parsed);
    if (env.RAFTV_MPV_DRY_RUN === '1') { log(JSON.stringify({ file, args })); return 0; }
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', (e) => {
      const msg = e && e.code === 'ENOENT'
        ? `mpv was not found (${file}). Install mpv, or put its full path in raftv-gateway.json next to this program: {"mpvPath": "C:\\\\path\\\\to\\\\mpv.exe"}`
        : `Could not start mpv (${file}): ${e && e.message}`;
      log(msg);
      if (onError) onError(msg);
    });
    child.unref();
    return 0;
  }
  if (platform !== 'win32') {
    log('Registering raftv-mpv:// links is automatic only on Windows. On Linux/macOS, see README ("Play in mpv").');
    return 1;
  }
  const cmds = registryCommands({ exe, script })[c.cmd === 'register' ? 'register' : 'unregister'];
  try {
    for (const args of cmds) execFile('reg', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    if (c.cmd === 'unregister') { log('raftv-mpv:// links were not registered (nothing to remove).'); return 0; }
    log(`Could not register raftv-mpv:// links: ${e.message}`);
    return 1;
  }
  log(c.cmd === 'register'
    ? `raftv-mpv:// links now open mpv through this program:\n  ${exe}\nIf you move this program, run it with --mpv-register again. To undo: --mpv-unregister.`
    : 'raftv-mpv:// links removed.');
  return 0;
}
