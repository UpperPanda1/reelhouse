#!/usr/bin/env node
// Builds the gateway as one self-contained program (Node "single executable application"):
//   npm run build:gateway            -> dist/gateway/raftv-gateway(.exe) for THIS platform (Windows in CI)
//   npm run build:gateway -- --bundle-only   -> only dist/gateway/raftv-gateway.cjs (used by the tests)
// Steps: esbuild bundles gateway/exe-main.mjs + gateway/bdix-gateway.mjs (no dependencies) into one CommonJS file;
// node --experimental-sea-config turns it into a blob; postject injects the blob into a copy of this node binary.
// Tool versions are pinned; nothing else is added to the program.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist', 'gateway');
const ESBUILD = 'esbuild@0.28.2';
const POSTJECT = 'postject@1.0.0-alpha.6';
const win = process.platform === 'win32';
const npx = win ? 'npx.cmd' : 'npx';
// npx.cmd needs a shell on Windows; then arguments with spaces (e.g. C:\Users\Some Name\...) must be quoted.
// node itself runs without a shell, so a Node installed under "C:\Program Files" works too.
const run = (cmd, args) => execFileSync(cmd, win && cmd === npx ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args, { cwd: root, stdio: 'inherit', shell: win && cmd === npx });

fs.mkdirSync(out, { recursive: true });
const bundle = path.join(out, 'raftv-gateway.cjs');
// import.meta.url is defined as undefined (no quotes: survives cmd.exe) so the gateway's own "run when started directly" block stays off (exe-main starts it)
run(npx, ['--yes', ESBUILD, 'gateway/exe-main.mjs', '--bundle', '--platform=node', '--target=node22', '--format=cjs',
  '--minify-syntax', '--legal-comments=none', '--define:import.meta.url=undefined', `--outfile=${bundle}`, '--log-level=warning']);
console.log(`bundle: ${path.relative(root, bundle)} (${fs.statSync(bundle).size} bytes)`);
if (process.argv.includes('--bundle-only')) process.exit(0);

const blob = path.join(out, 'sea-prep.blob');
const seaConfig = path.join(out, 'sea-config.json');
// no snapshot, no code cache: smallest blob, starts in well under a second
fs.writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2));
run(process.execPath, ['--experimental-sea-config', seaConfig]);

const exe = path.join(out, win ? 'raftv-gateway.exe' : 'raftv-gateway');
fs.copyFileSync(process.execPath, exe);
if (win) {
  // the copied node.exe carries Microsoft's signature, which injection invalidates: remove it if signtool is present
  try { execFileSync('signtool', ['remove', '/s', exe], { stdio: 'ignore' }); } catch { /* not installed: postject warns, the exe still runs */ }
}
const args = ['--yes', POSTJECT, exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
run(npx, args);
fs.rmSync(blob); fs.rmSync(seaConfig);
console.log(`program: ${path.relative(root, exe)} (${(fs.statSync(exe).size / 1048576).toFixed(1)} MB)`);
