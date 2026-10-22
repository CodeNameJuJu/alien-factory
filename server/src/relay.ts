// Relay side of the worker ⇄ relay link (Railway deployment).
// One worker at a time; browsers get mergeRelayState() output.
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WebSocket } from 'ws';
import { DATA_DIR, FACTORY_DIR } from './config.js';
import { fileHash, FORWARDABLE, mergeRelayState, parseAssetMsg } from './link.js';
import { LINK_PROTOCOL } from '../../shared/protocol.js';
import type {
  ClientMessage, ItchAnalysis, RelayToWorker, StateMessage, WorkerStatePayload, WorkerToRelay,
} from '../../shared/protocol.js';

const WORKER_STATE_PATH = join(DATA_DIR, 'worker-state.json');
const version = '0.1.0';

export class Relay extends EventEmitter {
  private ws: WebSocket | null = null;
  private lastSeenAt: number | null = null;
  private workerState: WorkerStatePayload | null = null;
  /// sku → filename → sha1 — what the relay has on disk per asset
  private assetHashes: Record<string, Record<string, string>> = {};
  private persistTimer: NodeJS.Timeout | null = null;
  /// set by main.ts so a worker `scanRequest` runs a relay scan
  onScanRequest: () => void = () => {};

  constructor() {
    super();
    try {
      this.workerState = JSON.parse(readFileSync(WORKER_STATE_PATH, 'utf8')) as WorkerStatePayload;
      this.lastSeenAt = Date.now() - 1; // it WAS seen, before the restart
    } catch { /* no persisted worker state */ }
  }

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === this.ws.OPEN;
  }

  get status() {
    return { connected: this.connected, lastSeenAt: this.lastSeenAt };
  }

  /// Browser-facing state: merged worker view, or null → caller falls back
  /// to the local scanner-only state.
  browserState(relayItch: StateMessage['itch']): StateMessage | null {
    return mergeRelayState(this.workerState, relayItch, this.status);
  }

  /// Called by main.ts after the bearer check has passed.
  attach(ws: WebSocket): void {
    if (this.ws && this.ws.readyState !== this.ws.CLOSED) {
      this.ws.close(4000, 'replaced by new worker connection');
    }
    this.ws = ws;
    this.lastSeenAt = Date.now();
    this.send({ type: 'welcome', assetHashes: this.assetHashes });
    this.emit('change');
    this.emit('worker-connect');
    ws.on('message', (data, isBinary) => this.onMessage(data.toString(), isBinary));
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      this.lastSeenAt = Date.now();
      this.emit('change');
    });
    ws.on('error', () => ws.close());
  }

  private send(msg: RelayToWorker): void {
    const ws = this.ws;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private onMessage(text: string, isBinary: boolean): void {
    if (isBinary) return;
    let msg: WorkerToRelay;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      if (msg.protocol !== LINK_PROTOCOL) {
        this.ws?.close(4001, `protocol ${msg.protocol} unsupported (want ${LINK_PROTOCOL})`);
      }
      return;
    }
    if (msg.type === 'state') {
      this.lastSeenAt = Date.now();
      this.workerState = msg.state;
      this.persistSoon();
      this.emit('change');
      return;
    }
    if (msg.type === 'asset') {
      const parsed = parseAssetMsg(msg);
      if (parsed) this.writeAsset(parsed.sku, parsed.files);
      return;
    }
    if (msg.type === 'scanRequest') {
      this.onScanRequest();
    }
  }

  /// Atomically write pushed asset files into the relay's factory dir so
  /// /files/assets/<sku>/<name> serves them to browsers.
  private writeAsset(sku: string, files: Record<string, Buffer>): void {
    const dir = join(FACTORY_DIR, 'assets', sku);
    mkdirSync(dir, { recursive: true });
    const hashes = (this.assetHashes[sku] ??= {});
    for (const [name, bytes] of Object.entries(files)) {
      const tmp = join(dir, `.${name}.tmp`);
      writeFileSync(tmp, bytes);
      renameSync(tmp, join(dir, name));
      hashes[name] = fileHash(bytes);
    }
    this.emit('change');
  }

  /// Route a browser command: forward to the worker if it's allowed, handle
  /// locally if it's a scan, or explain why not.
  browserCommand(msg: ClientMessage): { ok: boolean; error?: string } {
    if (msg.type === 'scanNow') return { ok: false, error: 'scanNow is local' }; // caller handles
    if (msg.type === 'signIn') return { ok: false, error: 'sign-in must happen on the Mac' };
    if (!FORWARDABLE.has(msg.type)) return { ok: false, error: `command ${msg.type} not allowed remotely` };
    if (!this.connected) return { ok: false, error: "factory offline — your Mac isn't connected" };
    this.send({ type: 'command', msg });
    return { ok: true };
  }

  /// Push fresh itch research to the worker (after a scan and on connect).
  pushItch(analysis: ItchAnalysis | null, reportMarkdown: string, lastScanAt: number): void {
    if (this.connected) this.send({ type: 'itch', analysis, reportMarkdown, lastScanAt });
  }

  private persistSoon(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        mkdirSync(dirname(WORKER_STATE_PATH), { recursive: true });
        writeFileSync(WORKER_STATE_PATH, JSON.stringify(this.workerState));
      } catch { /* best effort */ }
    }, 2000);
  }
}
