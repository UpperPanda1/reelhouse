// Entry point of the packaged gateway (raftv-gateway.exe, see scripts/build-gateway-exe.mjs). It only chooses settings
// and starts the unchanged gateway (./bdix-gateway.mjs); every request is handled there.
// Defaults for a double-click on a home PC used from a phone: reachable on the local network, a random token (created
// once, kept in raftv-gateway.json next to the program), only the RafTV site allowed by CORS. Environment variables
// (HOST, PORT, GATEWAY_TOKEN, ALLOWED_ORIGINS, ALLOW_PRIVATE, TLS_KEY, TLS_CERT) override the file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
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

/** Reads (or creates, once) the config file and returns the env-style settings for loadConfig(). */
export function settings(dir, env = process.env) {
  const file = path.join(dir, CONFIG_NAME);
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { saved = {}; }
  let changed = false;
  if (!saved.token || typeof saved.token !== 'string' || saved.token.length < 12) { saved.token = crypto.randomBytes(12).toString('base64url'); changed = true; }
  if (!Array.isArray(saved.allowedOrigins) || !saved.allowedOrigins.length) { saved.allowedOrigins = [DEFAULT_SITE]; changed = true; }
  if (!saved.host) { saved.host = '0.0.0.0'; changed = true; }
  if (!saved.port) { saved.port = 8787; changed = true; }
  if (changed) { try { fs.writeFileSync(file, JSON.stringify(saved, null, 2) + '\n'); } catch { /* read-only folder: run with the values anyway */ } }
  return {
    file,
    env: {
      HOST: env.HOST || String(saved.host),
      PORT: env.PORT || String(saved.port),
      GATEWAY_TOKEN: env.GATEWAY_TOKEN || saved.token,
      ALLOWED_ORIGINS: env.ALLOWED_ORIGINS || saved.allowedOrigins.join(','),
      ALLOW_PRIVATE: env.ALLOW_PRIVATE || (Array.isArray(saved.allowPrivate) ? saved.allowPrivate.join(',') : ''),
      TLS_KEY: env.TLS_KEY || saved.tlsKey || '',
      TLS_CERT: env.TLS_CERT || saved.tlsCert || '',
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
  const { file, env } = settings(configDir());
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
    console.log(`Settings file:   ${file}`);
    console.log('Stop: close this window or press Ctrl+C.');
  });
  return server;
}

main();
