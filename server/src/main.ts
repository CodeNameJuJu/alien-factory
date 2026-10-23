import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { FACTORY_DIR, loadConfig } from './config.js';
import { seedFactory } from './seed.js';
import { FactoryManager } from './factory.js';
import { loginPage, passwordMatches, RateLimiter, SESSION_COOKIE, sessionToken, sessionValid } from './auth.js';
import { bearerValid, MAX_LINK_MSG, PUBLIC_KIT_FILES, SKU_RE, verifyKitSig } from './link.js';
import { Relay } from './relay.js';
import { WorkerLink } from './worker-link.js';
import { DEVIN_DISABLED } from './acp.js';
import type { ClientMessage, ServerMessage } from '../../shared/protocol.js';

const PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 4790;
const HOST = PROD ? '0.0.0.0' : '127.0.0.1';
const PASSWORD = process.env.ALIEN_FACTORY_PASSWORD ?? '';
/// Built client (vite build) served in production / when present.
const CLIENT_DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../../client/dist');

/// Deployment roles (both optional, env-driven):
/// - relay: ALIEN_FACTORY_WORKER_KEY set → /worker ws accepts the Mac worker
/// - worker: ALIEN_FACTORY_RELAY_URL + key set → stream state/assets upstream
const WORKER_KEY = process.env.ALIEN_FACTORY_WORKER_KEY ?? '';
const RELAY_URL = process.env.ALIEN_FACTORY_RELAY_URL ?? '';
const IS_RELAY = !!WORKER_KEY && !RELAY_URL;
const IS_WORKER = !!RELAY_URL && !!WORKER_KEY;

if (PROD && !PASSWORD) {
  console.error('[alien-factory] NODE_ENV=production but ALIEN_FACTORY_PASSWORD is not set — refusing to start');
  process.exit(1);
}

const config = loadConfig();
seedFactory();
const factory = new FactoryManager(config);
const relay = IS_RELAY ? new Relay() : null;
const link = IS_WORKER ? new WorkerLink(RELAY_URL, WORKER_KEY, factory) : null;
// while the worker is linked (or was recently), the relay is the scanner
if (link) factory.relayAvailable = () => !link.fallbackDue();
// the gumroad channel pushes fresh kit files up before polling public urls
if (link) factory.assetSyncHook = () => void link.syncAssets();

// ---- websocket ------------------------------------------------------------

const clients = new Set<WebSocket>();
let lastBroadcast = 0;
let broadcastTimer: NodeJS.Timeout | null = null;

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMessage): void {
  const now = Date.now();
  if (msg.type === 'state' && now - lastBroadcast < 100) {
    if (!broadcastTimer) {
      broadcastTimer = setTimeout(() => {
        broadcastTimer = null;
        broadcast(stateMsg());
      }, 100 - (now - lastBroadcast));
    }
    return;
  }
  lastBroadcast = now;
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === c.OPEN) c.send(data);
}

const stateMsg = (): ServerMessage => {
  // relay with a known worker → merged "live factory" view for browsers
  if (relay) {
    const merged = relay.browserState(factory.statePayload().itch);
    if (merged) return merged;
  }
  return { type: 'state', ...factory.statePayload() };
};

factory.on('change', () => broadcast(stateMsg()));
relay?.on('change', () => broadcast(stateMsg()));
link?.on('change', () => broadcast(stateMsg()));

/// Push our freshest itch research to a newly-connected / after-scan worker.
function pushItchToWorker(): void {
  if (!relay?.connected) return;
  let md = '';
  try {
    md = readFileSync(join(FACTORY_DIR, 'reports', 'itch-latest.md'), 'utf8');
  } catch { /* none yet */ }
  if (factory.itch.lastScanAt) relay.pushItch(factory.itch.analysis, md, factory.itch.lastScanAt);
}

if (relay) {
  relay.onScanRequest = () => {
    void factory.scanThenScout(true).then(pushItchToWorker);
  };
  relay.on('worker-connect', pushItchToWorker);
}

async function handleMsg(ws: WebSocket, raw: string): Promise<void> {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  try {
    if (relay) {
      // browsers on the relay: scans are local, the rest goes to the worker
      if (msg.type === 'scanNow') {
        await factory.scanThenScout(true);
        pushItchToWorker();
      } else {
        const r = relay.browserCommand(msg);
        if (!r.ok) {
          send(ws, { type: 'error', message: r.error ?? 'failed' });
          return;
        }
      }
    } else if (link?.linked && msg.type === 'scanNow') {
      link.requestScan(); // the relay is the scanner when linked
    } else {
      await factory.handle(msg);
    }
    broadcast(stateMsg());
  } catch (err) {
    send(ws, { type: 'error', message: (err as Error).message });
  }
}

// ---- auth ------------------------------------------------------------------

const loginLimiter = new RateLimiter(10, 60_000);

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

const authed = (req: IncomingMessage): boolean => !PASSWORD || sessionValid(req.headers.cookie, PASSWORD);

function setSessionCookie(res: ServerResponse): void {
  const flags = `HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}; Path=/${PROD ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessionToken(PASSWORD)}; ${flags}`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// ---- http -----------------------------------------------------------------

function json(res: ServerResponse, body: unknown, code = 200): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
};

const STATIC_MIME: Record<string, string> = {
  ...MIME,
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function sendFile(res: ServerResponse, target: string, mime: Record<string, string>): boolean {
  const ext = extname(target).toLowerCase();
  if (!mime[ext] || !existsSync(target) || !statSync(target).isFile()) return false;
  res.writeHead(200, { 'Content-Type': mime[ext], 'Cache-Control': 'no-cache' });
  createReadStream(target).pipe(res);
  return true;
}

/// /files/<relpath> serves generated assets out of FACTORY_DIR only.
function serveFile(res: ServerResponse, rel: string): void {
  const root = resolve(FACTORY_DIR);
  const target = resolve(root, '.' + sep + decodeURIComponent(rel));
  if ((target !== root && !target.startsWith(root + sep)) || !sendFile(res, target, MIME)) {
    if (!res.headersSent) {
      res.writeHead(404);
      res.end('not found');
    }
  }
}

/// Serves client/dist when it exists (production). SPA fallback → index.html.
function serveClient(res: ServerResponse, pathname: string): boolean {
  if (!existsSync(CLIENT_DIST)) return false;
  const root = resolve(CLIENT_DIST);
  const target = resolve(root, '.' + sep + decodeURIComponent(pathname));
  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(404);
    res.end('not found');
    return true;
  }
  if (sendFile(res, target, STATIC_MIME)) return true;
  return sendFile(res, join(root, 'index.html'), STATIC_MIME);
}

const REVEAL_DIRS = new Set(['assets', 'examples', 'reports', 'factory']);

/// POST /api/reveal { sku?: string, dir?: 'assets'|'examples'|'reports'|'factory' }
/// opens the folder in the OS file manager. Never accepts a raw path.
async function reveal(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (process.platform !== 'darwin') return json(res, { error: 'unsupported platform' }, 501);
  let body: { sku?: unknown; dir?: unknown };
  try {
    body = JSON.parse(await readBody(req) || '{}');
  } catch {
    return json(res, { error: 'bad json' }, 400);
  }
  let target: string;
  if (typeof body.sku === 'string' && body.sku) {
    if (!/^[a-z0-9-]+$/.test(body.sku)) return json(res, { error: 'bad sku' }, 400);
    target = join(FACTORY_DIR, 'assets', body.sku);
    if (!existsSync(target)) return json(res, { error: 'no such asset' }, 404);
  } else if (typeof body.dir === 'string' && REVEAL_DIRS.has(body.dir)) {
    target = body.dir === 'factory' ? FACTORY_DIR : join(FACTORY_DIR, body.dir);
    if (!existsSync(target)) return json(res, { error: 'no such dir' }, 404);
  } else {
    return json(res, { error: 'sku or dir required' }, 400);
  }
  execFile('open', [target], (err) => {
    if (err) json(res, { error: err.message }, 500);
    else json(res, { ok: true, path: target });
  });
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // SIGNED PUBLIC kit images — the ONE unauthenticated content route, for
  // Gumroad's covers/thumbnail fetchers (the dashboard /files stays gated).
  // GET /public/kit/<sku>/<file>?exp=<unix>&sig=<hmac-hex>
  if (path.startsWith('/public/kit/')) {
    const m = /^\/public\/kit\/([a-z0-9-]{1,60})\/([a-z0-9.-]{1,40})$/.exec(path);
    const file = m?.[2] ?? '';
    if (!m || !SKU_RE.test(m[1]) || !PUBLIC_KIT_FILES.has(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig') ?? '';
    if (!WORKER_KEY || !verifyKitSig(WORKER_KEY, m[1], file, exp, sig)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    const target = resolve(FACTORY_DIR, 'assets', m[1], 'kit', file);
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const mime = file.endsWith('.gif') ? 'image/gif' : 'image/png';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
    createReadStream(target).pipe(res);
    return;
  }

  // auth gate — everything except health + the login routes needs the cookie
  if (PASSWORD) {
    if (path === '/api/health') return json(res, { ok: true });
    if (path === '/login') {
      if (req.method === 'POST') {
        if (!loginLimiter.allow(clientIp(req))) return json(res, { error: 'slow down' }, 429);
        const params = new URLSearchParams(await readBody(req));
        const attempt = params.get('password') ?? '';
        if (!passwordMatches(attempt, PASSWORD)) {
          res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(loginPage('ACCESS DENIED'));
          return;
        }
        setSessionCookie(res);
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(loginPage());
      return;
    }
    if (path === '/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Max-Age=0; Path=/`);
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }
    if (!authed(req)) {
      if (path === '/' || (!path.startsWith('/api') && !path.startsWith('/files') && !extname(path))) {
        res.writeHead(302, { Location: '/login' });
        res.end();
      } else {
        res.writeHead(401);
        res.end('unauthorized');
      }
      return;
    }
  } else if (path === '/api/health') {
    return json(res, { ok: true });
  }

  if (path === '/api/state') return json(res, stateMsg());
  if (path === '/api/reveal' && req.method === 'POST') return reveal(req, res);
  if (path.startsWith('/files/')) return serveFile(res, path.slice('/files/'.length));
  if (serveClient(res, path)) return;
  res.writeHead(404);
  res.end('not found');
});

const wss = new WebSocketServer({ noServer: true });
const workerWss = new WebSocketServer({ noServer: true, maxPayload: MAX_LINK_MSG });

function deny(socket: import('node:stream').Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/worker') {
    // the worker link: bearer-auth only, never cookies
    if (!IS_RELAY) return deny(socket, '404 Not Found');
    if (!bearerValid(req.headers.authorization, WORKER_KEY)) return deny(socket, '401 Unauthorized');
    workerWss.handleUpgrade(req, socket, head, (ws) => relay!.attach(ws));
    return;
  }
  if (path !== '/ws' || !authed(req)) return deny(socket, '401 Unauthorized');
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    send(ws, stateMsg());
    ws.on('message', (data) => void handleMsg(ws, data.toString()));
    ws.on('close', () => clients.delete(ws));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[alien-factory] server on http://${HOST}:${PORT}`);
  console.log(`[alien-factory] factory dir: ${FACTORY_DIR}`);
  console.log(`[alien-factory] client dist: ${existsSync(CLIENT_DIST) ? CLIENT_DIST : '(not built — API only)'}`);
  console.log(`[alien-factory] auth: ${PASSWORD ? 'password gate on' : 'open (no ALIEN_FACTORY_PASSWORD)'}`);
  if (IS_RELAY) console.log('[alien-factory] role: relay — /worker accepts the Mac worker');
  if (IS_WORKER) console.log(`[alien-factory] role: worker — streaming to ${RELAY_URL}`);
});

// ---- startup ----------------------------------------------------------------

// Devin sign-in is best-effort and must never block http: the factory floor
// shows "Devin offline" until a sign-in succeeds. Each `devin acp` spawn
// needs a BROWSER sign-in (hosts supply credentials — local `devin auth
// login` / env keys are ignored), so ALIEN_FACTORY_NO_DEVIN=1 keeps it dead.
if (DEVIN_DISABLED) {
  console.log('[alien-factory] Devin disabled (ALIEN_FACTORY_NO_DEVIN)');
} else {
  (async () => {
    try {
      await factory.acp.authenticate();
      const probe = await factory.acp.listModels();
      console.log(`[alien-factory] Devin signed in; models=${probe.models.length}`);
    } catch (err) {
      console.log(`[alien-factory] Devin not authenticated: ${(err as Error).message}`);
    }
    broadcast(stateMsg());
  })();
}

// Worker link: outbound connection to the relay. While linked (or recently
// linked) the relay is the scanner — the worker only self-scans after the
// link has been silent for >2h.
if (link) {
  link.start();
  setInterval(() => {
    if (link.fallbackDue()) void factory.scanThenScout(false);
  }, 5 * 60_000);
}

// Headless scanner mode (Railway / standalone): rescan on the configured
// cadence regardless of shift state — no agents involved at all. Skipped on
// a linked worker (the relay does the scanning).
if (process.env.ALIEN_FACTORY_AUTOSCAN && !IS_WORKER) {
  console.log(`[alien-factory] autoscan every ${config.itchScanMinutes} min`);
  const scan = () => void factory.scanOnly().then(pushItchToWorker);
  scan();
  setInterval(scan, Math.max(5, config.itchScanMinutes) * 60_000);
}
