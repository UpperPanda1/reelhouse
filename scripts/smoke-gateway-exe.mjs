#!/usr/bin/env node
// Starts the BUILT gateway program (dist/gateway/raftv-gateway[.exe]) and checks what the site relies on:
// it prints the address and token, /health answers, requests without the token are refused, only the RafTV site
// may read replies, and it writes no file. Used in CI on Windows before a release is published.  node scripts/smoke-gateway-exe.mjs [path]
import { spawn } from 'node:child_process';
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
    process.exit(0);
  } catch (e) { fail(e.message); }
});
child.on('exit', (c) => fail('exited early with ' + c));
