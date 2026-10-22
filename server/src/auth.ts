// Password gate for the deployed dashboard — pure helpers + the login page.
// Cookie = HMAC-SHA256(key = password, msg = "af-session-v1"), so rotating
// the password invalidates every session. No session store needed.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'af_session';
const SESSION_MSG = 'af-session-v1';

/// The value the cookie should carry for this password.
export function sessionToken(password: string): string {
  return createHmac('sha256', password).update(SESSION_MSG).digest('hex');
}

/// Constant-time cookie check.
export function sessionValid(cookieHeader: string | undefined, password: string): boolean {
  if (!cookieHeader) return false;
  const want = sessionToken(password);
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const got = part.slice(eq + 1).trim();
    if (got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want))) return true;
  }
  return false;
}

/// Constant-time password check (lengths differ → still compare safely).
export function passwordMatches(input: string, password: string): boolean {
  const a = Buffer.from(input);
  const b = Buffer.from(password);
  if (a.length !== b.length) {
    // burn a comparison anyway so length doesn't leak via timing
    timingSafeEqual(createHmac('sha256', a).digest(), createHmac('sha256', b).digest());
    return false;
  }
  return timingSafeEqual(a, b);
}

/// Fixed-window rate limiter for POST /login — max `limit` per `windowMs`
/// per key (client IP). `now` injectable for tests.
export class RateLimiter {
  private hits = new Map<string, { count: number; reset: number }>();

  constructor(
    private limit = 10,
    private windowMs = 60_000,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    let e = this.hits.get(key);
    if (!e || now > e.reset) {
      e = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, e);
    }
    e.count++;
    // occasional sweep so the map doesn't grow forever
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (now > v.reset) this.hits.delete(k);
    }
    return e.count <= this.limit;
  }
}

/// CRT-styled login page — same phosphor terminal look as the app.
export function loginPage(error = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Alien Factory — login</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at 50% 30%,#0c1622 0%,#05080e 70%,#02040a 100%);font-family:'Courier New',monospace;color:#5cf2c8;padding:16px}
.box{background:rgba(8,14,22,.92);border:1px solid #2e9c80;padding:34px 38px;position:relative;box-shadow:0 0 30px rgba(92,242,200,.12),inset 0 0 40px rgba(92,242,200,.03)}
.box::before{content:'';position:absolute;inset:0;background:repeating-linear-gradient(to bottom,rgba(0,0,0,.18) 0 1px,transparent 1px 3px);pointer-events:none}
h1{font-size:14px;letter-spacing:3px;text-shadow:0 0 6px #5cf2c8;margin:0 0 4px}
h1::before{content:'> '}
.sub{font-size:10px;color:#2e9c80;letter-spacing:2px;margin-bottom:18px}
input{font-family:inherit;font-size:16px;background:#0a0f16;color:#5cf2c8;border:1px solid rgba(92,242,200,.45);padding:10px 12px;width:min(240px,60vw);text-shadow:0 0 4px rgba(92,242,200,.4);caret-color:#5cf2c8;outline:none}
button{font-family:inherit;font-size:12px;letter-spacing:1px;text-transform:uppercase;background:transparent;color:#5cf2c8;border:1px solid rgba(92,242,200,.45);padding:10px 14px;min-height:44px;cursor:pointer;margin-left:8px;text-shadow:0 0 4px currentColor}
button:hover{background:#5cf2c8;color:#0a0f16;text-shadow:none;box-shadow:0 0 12px rgba(92,242,200,.55)}
.err{color:#ff5f6e;font-size:11px;margin-top:12px;text-shadow:0 0 4px currentColor}
@keyframes blink{50%{opacity:0}}.cur{animation:blink 1s steps(1) infinite}
</style></head><body>
<div class="box">
<h1>ALIEN-FACTORY // OVERSEER TERMINAL<span class="cur">_</span></h1>
<div class="sub">RESEARCH NODE · AUTHORIZED ACCESS ONLY</div>
<form method="POST" action="/login">
<input type="password" name="password" placeholder="access code" autofocus autocomplete="current-password">
<button type="submit">[ enter ]</button>
</form>
${error ? `<div class="err">${error}</div>` : ''}
</div></body></html>`;
}
