#!/usr/bin/env node
// Start the Alien Factory worker on this Mac.
// Loads ~/.alien-factory/worker.env (KEY=VALUE, never logged), builds the
// client if needed, then runs the server locally (127.0.0.1, no password —
// it only accepts connections from this machine).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_FILE = join(homedir(), '.alien-factory', 'worker.env');

// KEY=VALUE parser — values are never printed.
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !(key in process.env)) process.env[key] = val;
  }
  console.log(`[worker] env loaded from ${ENV_FILE}`);
} catch {
  console.log(`[worker] no ${ENV_FILE} — running unlinked (local dashboard only)`);
}

if (!existsSync(join(REPO, 'client/dist/index.html'))) {
  console.log('[worker] client/dist missing — building…');
  const r = spawnSync('npm', ['run', 'build', '-w', 'client'], { cwd: REPO, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// NOT NODE_ENV=production: binds 127.0.0.1, serves client/dist, no password.
const r = spawnSync('npx', ['tsx', 'server/src/main.ts'], {
  cwd: REPO,
  stdio: 'inherit',
  env: process.env,
});
process.exit(r.status ?? 0);
