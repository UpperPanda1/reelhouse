// Entry point of the packaged gateway (raftv-gateway.exe, see scripts/build-gateway-exe.mjs). It only chooses settings
// and starts the unchanged gateway (./bdix-gateway.mjs); every request is handled there.
// Defaults for a double-click on a home PC used from a phone: reachable on the local network, a token derived from this
// PC (same on every start, nothing stored), only the RafTV site allowed by CORS. It writes NOTHING to disk: an optional
// raftv-gateway.json next to the program is read if the user created one, never written. Environment variables
// (HOST, PORT, GATEWAY_TOKEN, ALLOWED_ORIGINS, ALLOW_PRIVATE, TLS_KEY, TLS_CERT) override the file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createGateway, loadConfig } from './bdix-gateway.mjs';

export const CONFIG_NAME = 'raftv-gateway.json';
export const DEFAULT_SITE = 'https://raftv.pages.dev';

/** Folder the config file lives in: next to the .exe when packaged, else the current folder. */
function configDir() {
  try {
    // node:sea exists in Node 20+; isSea() is true only inside the single executable
    const sea = process.getBuiltinModule ? process.getBuiltinModule('node:sea') : null;
    if (sea && sea.isSea()) return path.dirname(process.execPath);
  } catch { /* not packaged */ }
  return process.cwd();
}

/** A per-PC secret that Windows/Linux already keep (read only; not visible on the network). '' if none is found. */
function machineSecret() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /MachineGuid\s+REG_SZ\s+([0-9a-f-]{36})/i.exec(out);
      return m ? m[1] : '';
    }
    for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) { try { const v = fs.readFileSync(f, 'utf8').trim(); if (v) return v; } catch { /* next */ } }
  } catch { /* none */ }
  return '';
}

/** Same token on every start of this PC and user, without storing it; random (for this run only) if no secret exists. */
export function derivedToken() {
  const secret = machineSecret();
  if (!secret) return { token: crypto.randomBytes(12).toString('base64url'), stable: false };
  let user = '';
  try { user = os.userInfo().username; } catch { /* keep '' */ }
  return { token: crypto.createHash('sha256').update(`raftv-gateway|${secret}|${user}`).digest('base64url').slice(0, 16), stable: true };
}

/** Settings from the optional file (read only) and the environment, for loadConfig(). Nothing is written. */
export function settings(dir, env = process.env) {
  const file = path.join(dir, CONFIG_NAME);
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { saved = null; }
  const s = saved && typeof saved === 'object' ? saved : {};
  const fileToken = typeof s.token === 'string' && s.token.length >= 12 ? s.token : '';
  const derived = env.GATEWAY_TOKEN || fileToken ? null : derivedToken();
  const list = (v) => (Array.isArray(v) ? v.join(',') : '');
  return {
    file: saved ? file : null,
    stable: !derived || derived.stable,
    env: {
      HOST: env.HOST || String(s.host || '0.0.0.0'),
      PORT: env.PORT || String(s.port || 8787),
      GATEWAY_TOKEN: env.GATEWAY_TOKEN || fileToken || derived.token,
      ALLOWED_ORIGINS: env.ALLOWED_ORIGINS || list(s.allowedOrigins) || DEFAULT_SITE,
      ALLOW_PRIVATE: env.ALLOW_PRIVATE || list(s.allowPrivate),
      TLS_KEY: env.TLS_KEY || s.tlsKey || '',
      TLS_CERT: env.TLS_CERT || s.tlsCert || '',
      UPSTREAM_TIMEOUT_MS: env.UPSTREAM_TIMEOUT_MS || '',
    },
  };
}

const lanAddresses = () => Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);

function fail(message) {
  console.error(`\n${message}\n`);
  // a double-clicked console window would vanish at once: keep the message readable
  if (process.stdin.isTTY) { console.error('Press Enter to close.'); process.stdin.once('data', () => process.exit(1)); } else process.exit(1);
}

export function main() {
  const dir = configDir();
  const { file, stable, env } = settings(dir);
  const cfg = loadConfig(Object.fromEntries(Object.entries(env).filter(([, v]) => v)));
  let server;
  try { server = createGateway(cfg); } catch (e) { return fail(e.message); }
  server.on('error', (e) => fail(e.code === 'EADDRINUSE' ? `Port ${cfg.port} is already in use (is the gateway already running?).` : `Could not start: ${e.message}`));
  server.listen(cfg.port, cfg.host, () => {
    const port = server.address().port;
    const scheme = cfg.tls ? 'https' : 'http';
    const anyHost = cfg.host === '0.0.0.0' || cfg.host === '::';
    const where = anyHost ? lanAddresses() : [cfg.host];
    console.log('RafTV gateway is running. Keep this window open while you watch.\n');
    console.log('In RafTV: Settings > Connection, enter:');
    for (const ip of where) console.log(`  Address  ${scheme}://${ip}:${port}`);
    if (anyHost) console.log(`  (on this PC itself: ${scheme}://127.0.0.1:${port})`);
    console.log(`  Token    ${cfg.token || '(none)'}`);
    console.log(`\nAllowed site(s): ${cfg.origins.join(', ') || 'any'}`);
    if (!stable) console.log('Note: this token changes on every start (no PC id found); put a "token" in raftv-gateway.json to keep one.');
    console.log(file ? `Settings file:   ${file} (read only)` : `Settings file:   none; defaults in use (optional: ${path.join(dir, CONFIG_NAME)})`);
    console.log('Nothing is written to disk.');
    console.log('Stop: close this window or press Ctrl+C.');
  });
  return server;
}

main();
