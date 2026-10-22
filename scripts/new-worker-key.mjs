#!/usr/bin/env node
// Generate a worker link key into ~/.alien-factory/worker.env (mode 0600).
// Usage: node scripts/new-worker-key.mjs [--relay wss://your-app.up.railway.app/worker]
// The key itself is NEVER printed — set it in Railway's variables yourself.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), '.alien-factory');
const ENV_FILE = join(DIR, 'worker.env');

const key = randomBytes(32).toString('base64url');
let relay = null;
const i = process.argv.indexOf('--relay');
if (i >= 0) relay = process.argv[i + 1] ?? null;

const lines = existsSync(ENV_FILE)
  ? readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('ALIEN_FACTORY_'))
  : [];
lines.push(`ALIEN_FACTORY_WORKER_KEY=${key}`);
if (relay) lines.push(`ALIEN_FACTORY_RELAY_URL=${relay}`);

mkdirSync(DIR, { recursive: true });
writeFileSync(ENV_FILE, lines.join('\n') + '\n');
chmodSync(ENV_FILE, 0o600);
console.log('key written to ~/.alien-factory/worker.env');
