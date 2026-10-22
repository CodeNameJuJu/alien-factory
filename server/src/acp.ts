// A client for the Devin CLI's Agent Client Protocol server (`devin acp`):
// JSON-RPC 2.0, one message per line, over the child's stdin / stdout.
// Ported from alex/src-tauri/src/devin_acp.rs.
//
// One `devin acp` process serves the whole server. It is started on first
// use, initialised, and signed in through ACP's `authenticate`
// (`devin-browser`: Devin runs the browser sign-in itself and caches it).

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ACP_LOG_PATH, LOG_DIR, PROBE_DIR, DATA_DIR } from './config.js';
import type { ConfigOptionValue } from '../../shared/protocol.js';

const BUNDLED_DEVIN =
  '/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin';

/// ALIEN_FACTORY_NO_DEVIN=1 keeps the ACP client dead — no `devin acp`
/// spawn, no browser sign-in. The factory floor just shows "Devin offline".
export const DEVIN_DISABLED = !!process.env.ALIEN_FACTORY_NO_DEVIN;

const REQUEST_TIMEOUT = 60_000;
const PROMPT_TIMEOUT = 6 * 60 * 60_000; // a real ticket can take hours
const AUTH_TIMEOUT = 600_000;

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public kind?: string,
  ) {
    super(message);
  }
}

type Json = any;

function findDevin(): string | null {
  const candidates = [
    BUNDLED_DEVIN,
    join(homedir(), '.local/bin/devin'),
    '/opt/homebrew/bin/devin',
    '/usr/local/bin/devin',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export function configOption(options: Json, category: string): Json | undefined {
  if (!Array.isArray(options)) return undefined;
  return options.find((o) => o?.category === category);
}

export function configValues(option: Json): ConfigOptionValue[] {
  const out: ConfigOptionValue[] = [];
  const collect = (items: Json[]) => {
    for (const item of items) {
      if (Array.isArray(item?.options)) collect(item.options);
      else if (typeof item?.value === 'string') {
        out.push({ id: item.value, name: typeof item.name === 'string' ? item.name : item.value });
      }
    }
  };
  if (Array.isArray(option?.options)) collect(option.options);
  return out;
}

/// Grouped values of a select option: `[{group, options:[...]}]` becomes
/// `{name: group, values}`; ungrouped items land in a group named "".
export function configGroups(option: Json): { name: string; values: ConfigOptionValue[] }[] {
  const out: { name: string; values: ConfigOptionValue[] }[] = [];
  if (!Array.isArray(option?.options)) return out;
  for (const item of option.options) {
    if (Array.isArray(item?.options)) {
      out.push({ name: item.name ?? item.group ?? '', values: configValues({ options: item.options }) });
    } else if (typeof item?.value === 'string') {
      let g = out.find((g) => g.name === '');
      if (!g) out.push((g = { name: '', values: [] }));
      g.values.push({ id: item.value, name: typeof item.name === 'string' ? item.name : item.value });
    }
  }
  return out;
}

interface Pending {
  resolve: (v: Json) => void;
  reject: (e: RpcError) => void;
  timer: NodeJS.Timeout;
}

export interface AcpEvents {
  update: (sessionId: string, update: Json) => void;
  permission: (sessionId: string, requestId: Json, params: Json) => void;
  dead: () => void;
}

export class AcpClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private stderrLog: WriteStream | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private lineBuf = '';
  private starting: Promise<void> | null = null;
  alive = false;
  authenticated = false;
  models: ConfigOptionValue[] = [];
  modelGroups: { name: string; values: ConfigOptionValue[] }[] = [];
  defaultModel: string | null = null;
  modes: ConfigOptionValue[] = [];
  private authMethod = 'devin-browser';

  override on<E extends keyof AcpEvents>(ev: E, fn: AcpEvents[E]): this {
    return super.on(ev, fn);
  }

  private log(line: string): void {
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      this.stderrLog ??= createWriteStream(ACP_LOG_PATH, { flags: 'a' });
      this.stderrLog.write(`[client] ${line}\n`);
    } catch {
      /* ignore */
    }
  }

  async ensureStarted(): Promise<void> {
    if (this.alive) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<void> {
    if (DEVIN_DISABLED) throw new RpcError(-1, 'Devin disabled (ALIEN_FACTORY_NO_DEVIN)');
    const devin = findDevin();
    if (!devin) throw new RpcError(-1, 'devin CLI not found');
    mkdirSync(PROBE_DIR, { recursive: true });
    mkdirSync(LOG_DIR, { recursive: true });
    const errStream = createWriteStream(ACP_LOG_PATH, { flags: 'a' });
    this.stderrLog = errStream;
    this.log(`spawning ${devin} acp`);

    const child = spawn(devin, ['acp'], {
      cwd: DATA_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}` },
    });
    this.child = child;
    child.stderr!.pipe(errStream, { end: false });

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      this.lineBuf += chunk;
      let idx: number;
      while ((idx = this.lineBuf.indexOf('\n')) >= 0) {
        const line = this.lineBuf.slice(0, idx).trim();
        this.lineBuf = this.lineBuf.slice(idx + 1);
        if (line) this.dispatch(line);
      }
    });
    child.on('exit', (code, sig) => {
      this.log(`devin acp exited code=${code} sig=${sig}`);
      this.markDead();
    });
    child.on('error', (e) => {
      this.log(`devin acp error: ${e.message}`);
      this.markDead();
    });
    this.alive = true;

    // Deliberately no fs / terminal client capabilities: Devin uses its own
    // tools and asks us for permission through session/request_permission.
    const init = await this.request(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'alien-factory', title: 'Alien Factory', version: '0.1.0' },
      },
      REQUEST_TIMEOUT,
    );
    const methods = Array.isArray(init?.authMethods) ? init.authMethods : [];
    const ids = methods.map((m: Json) => m?.id).filter((s: unknown) => typeof s === 'string');
    if (ids.includes('devin-browser')) this.authMethod = 'devin-browser';
    else if (ids.length) this.authMethod = ids[0];
    this.log(`initialize ok, authMethods=${JSON.stringify(ids)}`);
  }

  private markDead(): void {
    if (!this.alive) return;
    this.alive = false;
    this.authenticated = false;
    this.child = null;
    const err = new RpcError(-1, 'Devin is not running');
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.emit('dead');
  }

  private send(obj: Json): void {
    try {
      this.child?.stdin?.write(JSON.stringify(obj) + '\n');
    } catch {
      /* dead */
    }
  }

  request(method: string, params: Json, timeout = REQUEST_TIMEOUT): Promise<Json> {
    if (!this.alive) return Promise.reject(new RpcError(-1, 'Devin is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(-2, `Devin did not answer ${method} in time`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: Json): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  respond(id: Json, result: Json): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  respondError(id: Json, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private dispatch(line: string): void {
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      this.log(`unparsed line: ${line.slice(0, 200)}`);
      return;
    }
    const id = msg.id;
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    const params = msg.params ?? null;

    if (id !== undefined && method === undefined) {
      // response
      const numId = typeof id === 'number' ? id : Number(id);
      const p = this.pending.get(numId);
      if (p) {
        this.pending.delete(numId);
        clearTimeout(p.timer);
        if (msg.error) {
          const e = msg.error;
          const kind = e?.data?.['cognition.ai/errorKind'];
          p.reject(new RpcError(typeof e.code === 'number' ? e.code : 0, e.message ?? 'unknown error', kind));
        } else {
          p.resolve(msg.result ?? null);
        }
      }
      return;
    }
    if (id !== undefined && method !== undefined) {
      // incoming request
      if (method === 'session/request_permission') {
        const sid = params?.sessionId;
        if (typeof sid === 'string') this.emit('permission', sid, id, params);
        else this.respondError(id, -32602, 'missing sessionId');
      } else {
        this.respondError(id, -32601, `${method} is not supported`);
      }
      return;
    }
    if (method === 'session/update') {
      const sid = params?.sessionId;
      const update = params?.update;
      if (typeof sid === 'string' && update) this.emit('update', sid, update);
    }
  }

  async authenticate(): Promise<void> {
    if (this.authenticated) return;
    await this.ensureStarted();
    await this.request('authenticate', { methodId: this.authMethod }, AUTH_TIMEOUT);
    this.authenticated = true;
    this.log('authenticated');
  }

  async newSession(cwd: string, extraDirs: string[] = []): Promise<{ sessionId: string; configOptions: Json }> {
    await this.ensureStarted();
    const result = await this.request(
      'session/new',
      { cwd, additionalDirectories: extraDirs, mcpServers: [] },
      REQUEST_TIMEOUT,
    );
    const sessionId = result?.sessionId;
    if (typeof sessionId !== 'string') throw new RpcError(0, 'session/new returned no session id');
    const configOptions = result?.configOptions ?? null;
    const model = configOption(configOptions, 'model');
    if (model) {
      this.models = configValues(model);
      this.modelGroups = configGroups(model);
      this.defaultModel = typeof model.currentValue === 'string' ? model.currentValue : null;
    }
    const mode = configOption(configOptions, 'mode');
    if (mode) this.modes = configValues(mode);
    return { sessionId, configOptions };
  }

  async loadSession(sessionId: string, cwd: string): Promise<Json> {
    await this.ensureStarted();
    return this.request(
      'session/load',
      { sessionId, cwd, mcpServers: [] },
      REQUEST_TIMEOUT,
    );
  }

  async setConfig(sessionId: string, configId: string, value: string): Promise<Json> {
    return this.request(
      'session/set_config_option',
      { sessionId, configId, value },
      REQUEST_TIMEOUT,
    );
  }

  async prompt(sessionId: string, text: string): Promise<Json> {
    return this.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text }] },
      PROMPT_TIMEOUT,
    );
  }

  cancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId });
  }

  answerPermission(requestId: Json, optionId: string | null): void {
    if (optionId) {
      this.respond(requestId, { outcome: { outcome: 'selected', optionId } });
    } else {
      this.respond(requestId, { outcome: { outcome: 'cancelled' } });
    }
  }

  /// Probe: create a throwaway session in the probe dir once and cache the
  /// model + mode option values it advertises.
  async listModels(): Promise<{ models: ConfigOptionValue[]; modes: ConfigOptionValue[]; configOptions: Json }> {
    if (this.models.length && this.modes.length) {
      return { models: this.models, modes: this.modes, configOptions: null };
    }
    const { configOptions } = await this.newSession(PROBE_DIR);
    this.log(`probe configOptions=${JSON.stringify(configOptions)}`);
    return { models: this.models, modes: this.modes, configOptions };
  }

}
