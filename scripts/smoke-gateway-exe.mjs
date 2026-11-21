#!/usr/bin/env node
// Starts the BUILT gateway program (dist/gateway/raftv-gateway[.exe]) and checks what the site relies on:
// it prints the address and token, /health answers, requests without the token are refused, only the RafTV site
// may read replies, and it writes no file. Used in CI on Windows before a release is published.  node scripts/smoke-gateway-exe.mjs [path]
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mpvLink } from '../public/js/mpv.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = process.argv[2] || path.join(root, 'dist', 'gateway', process.platform === 'win32' ? 'raftv-gateway.exe' : 'raftv-gateway');
// run from a copy in a temp folder: the program writes its settings file next to itself
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rgw-smoke-'));
const copy = path.join(dir, path.basename(exe));
fs.copyFileSync(exe, copy);
const child = spawn(copy, [], { cwd: dir, env: { ...process.env, HOST: '127.0.0.1', PORT: '0' } });
let out = '';
const fail = (m) => { console.error('FAIL ' + m + '\n' + out); child.kill(); process.exit(1); };
const timer = setTimeout(() => fail('did not start within 15 s'), 15000);
child.stdout.on('data', async (d) => {
  out += d;
  const m = /Address\s+(http:\/\/[\d.]+:\d+)/.exec(out);
  const t = /Token\s+(\S+)/.exec(out);
  if (!(m && t && /Stop:/.test(out))) return;
  clearTimeout(timer);
  child.stdout.removeAllListeners('data');
  try {
    const h = await fetch(m[1] + '/health');
    if (h.status !== 200) return fail('/health ' + h.status);
    const body = JSON.stringify({ url: 'https://example.com/', method: 'GET', headers: {} });
    const noTok = await fetch(m[1] + '/p', { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
    if (noTok.status !== 401) return fail('no token -> ' + noTok.status);
    const pre = await fetch(m[1] + '/p', { method: 'OPTIONS', headers: { origin: 'https://raftv.pages.dev', 'access-control-request-method': 'POST' } });
    if (pre.headers.get('access-control-allow-origin') !== 'https://raftv.pages.dev') return fail('site origin not allowed');
    const evil = await fetch(m[1] + '/p', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    if (evil.headers.get('access-control-allow-origin')) return fail('foreign origin allowed');
    // it must not write anything: the folder holds only the program itself
    const files = fs.readdirSync(dir);
    if (files.length !== 1) return fail('files written next to the program: ' + files.join(', '));
    console.log(`OK ${path.basename(exe)}: started, health, token enforced, only the site allowed, nothing written to disk\n${out}`);
    child.kill();
    mpvChecks();
    process.exit(0);
  } catch (e) { fail(e.message); }
});
child.on('exit', (c) => fail('exited early with ' + c));

// "Play in mpv": --mpv-open reads a site link and would start mpv with the file's own address (dry run: prints the
// command instead); on Windows --mpv-register / --mpv-unregister add and remove the raftv-mpv:// registry keys (HKCU).
function mpvChecks() {
  const url = 'http://172.16.50.14/DHAKA-FLIX-14/a b.mkv';
  const r = spawnSync(copy, ['--mpv-open', mpvLink({ url, headers: {} }, { title: 'T', start: 42 })], { cwd: dir, env: { ...process.env, RAFTV_MPV_DRY_RUN: '1' }, encoding: 'utf8', timeout: 15000 });
  let got = null;
  try { got = JSON.parse(r.stdout); } catch { /* checked below */ }
  if (r.status !== 0 || !got || got.args.at(-1) !== new URL(url).href || got.args.at(-2) !== '--' || !got.args.includes('--start=42')) fail('--mpv-open: ' + r.status + ' ' + r.stdout + r.stderr);
  const bad = spawnSync(copy, ['--mpv-open', 'raftv-mpv://play?d=bad'], { cwd: dir, env: { ...process.env, RAFTV_MPV_DRY_RUN: '1' }, encoding: 'utf8', timeout: 15000 });
  if (bad.status === 0) fail('--mpv-open accepted a bad link');
  if (process.platform === 'win32') {
    const key = 'HKCU\\Software\\Classes\\raftv-mpv';
    const reg = spawnSync(copy, ['--mpv-register'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
    if (reg.status !== 0) fail('--mpv-register: ' + reg.stdout + reg.stderr);
    const cmd = execFileSync('reg', ['query', key + '\\shell\\open\\command', '/ve'], { encoding: 'utf8' });
    if (!cmd.includes(`"${copy}" --mpv-open "%1"`)) fail('registry command: ' + cmd);
    if (!execFileSync('reg', ['query', key, '/v', 'URL Protocol'], { encoding: 'utf8' }).includes('URL Protocol')) fail('URL Protocol value missing');
    const un = spawnSync(copy, ['--mpv-unregister'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
    if (un.status !== 0) fail('--mpv-unregister: ' + un.stdout + un.stderr);
    if (spawnSync('reg', ['query', key]).status === 0) fail('registry key still present after --mpv-unregister');
  }
  const files = fs.readdirSync(dir);
  if (files.length !== 1) fail('mpv modes wrote files: ' + files.join(', '));
  console.log(`OK mpv modes: link opened (dry run), bad link refused${process.platform === 'win32' ? ', raftv-mpv:// registered and removed' : ''}, nothing written to disk`);
}
