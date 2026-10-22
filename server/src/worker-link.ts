// Worker side of the worker ⇄ relay link (the Mac running the agents).
// Opens an OUTBOUND ws to the relay — nothing inbound is ever accepted.
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { FACTORY_DIR } from './config.js';
import { ASSET_FILES, fileHash } from './link.js';
import { LINK_PROTOCOL } from '../../shared/protocol.js';
import type { FactoryManager } from './factory.js';
import type {
  RelayToWorker, WorkerStatePayload, WorkerToRelay,
} from '../../shared/protocol.js';

const PING_MS = 25_000;
const STATE_MIN_MS = 500; // ≤2 state messages/s
const FALLBACK_SCAN_AFTER_MS = 2 * 60 * 60_000; // relay silent >2h → self-scan

export class WorkerLink extends EventEmitter {
  private ws: WebSocket | null = null;
  private backoff = 1000;
  private stopped = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private pendingState: WorkerStatePayload | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  private lastStateSent = 0;
  private sentHashes: Record<string, Record<string, string>> = {};
  private syncTimer: NodeJS.Timeout | null = null;
  /// last time we heard itch data (or anything) from the relay
  lastRelayAt = 0;

  constructor(
    private url: string,
    private key: string,
    private factory: FactoryManager,
  ) {
    super();
    factory.on('change', () => {
      this.queueState();
      this.queueAssetSync();
    });
  }

  get linked(): boolean {
    return !!this.ws && this.ws.readyState === this.ws.OPEN;
  }

  /// Relay has been silent this long → worker should scan itch.io itself.
  fallbackDue(now = Date.now()): boolean {
    return now - this.lastRelayAt > FALLBACK_SCAN_AFTER_MS;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    if (this.pingTimer) clearInterval(this.pingTimer);
  }

  private connect(): void {
    if (this.stopped) return;
    console.log(`[worker-link] connecting to ${this.url}`);
    const ws = new WebSocket(this.url, { headers: { Authorization: `Bearer ${this.key}` } });
    this.ws = ws;
    ws.on('open', () => {
      this.backoff = 1000;
      this.lastRelayAt = Date.now();
      this.send({ type: 'hello', protocol: LINK_PROTOCOL, version: '0.1.0' });
      this.pingTimer = setInterval(() => {
        if (ws.readyState === ws.OPEN) ws.ping();
      }, PING_MS);
      this.emit('change');
      console.log('[worker-link] linked to relay');
    });
    ws.on('message', (data) => this.onMessage(data.toString()));
    ws.on('pong', () => {
      this.lastRelayAt = Date.now();
    });
    ws.on('close', (code, reason) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.ws === ws) this.ws = null;
      this.emit('change');
      if (this.stopped) return;
      const delay = this.backoff + Math.random() * this.backoff * 0.3;
      this.backoff = Math.min(30_000, this.backoff * 2);
      console.log(`[worker-link] closed (${code} ${reason}); retry in ${(delay / 1000).toFixed(1)}s`);
      setTimeout(() => this.connect(), delay);
    });
    ws.on('error', () => ws.close());
  }

  private send(msg: WorkerToRelay): void {
    const ws = this.ws;
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  /// Browser on OUR OWN dashboard asked for something the relay should do.
  requestScan(): void {
    this.send({ type: 'scanRequest' });
  }

  private onMessage(text: string): void {
    let msg: RelayToWorker;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    this.lastRelayAt = Date.now();
    if (msg.type === 'welcome') {
      // relay tells us what it already has → we only push diffs
      this.sentHashes = msg.assetHashes;
      void this.syncAssets();
      this.queueState(true);
      return;
    }
    if (msg.type === 'command') {
      this.factory.event(`remote: ${msg.msg.type}`);
      void this.factory.handle(msg.msg).catch((err) => {
        this.factory.event(`remote command failed: ${(err as Error).message}`);
      });
      return;
    }
    if (msg.type === 'itch') {
      this.factory.applyRelayItch(msg.analysis, msg.reportMarkdown, msg.lastScanAt);
    }
  }

  /// Throttled/coalesced state push — at most one per STATE_MIN_MS.
  private queueState(immediate = false): void {
    const payload = this.statePayload();
    this.pendingState = payload;
    if (immediate) {
      this.flushState();
      return;
    }
    if (this.stateTimer) return;
    const wait = Math.max(0, STATE_MIN_MS - (Date.now() - this.lastStateSent));
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.flushState();
    }, wait);
  }

  private flushState(): void {
    if (!this.pendingState) return;
    const msg = this.pendingState;
    this.pendingState = null;
    this.lastStateSent = Date.now();
    if (this.linked) this.send({ type: 'state', state: msg });
  }

  private statePayload(): WorkerStatePayload {
    return this.factory.statePayload();
  }

  /// Debounced: hash each asset's syncable files, push the ones the relay
  /// doesn't have (welcome hashes) or that changed since.
  private queueAssetSync(): void {
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.syncAssets();
    }, 400);
  }

  async syncAssets(): Promise<void> {
    if (!this.linked) return;
    for (const asset of this.factory.assets) {
      const dir = join(FACTORY_DIR, 'assets', asset.sku);
      if (!existsSync(dir)) continue;
      const sent = (this.sentHashes[asset.sku] ??= {});
      const files: Record<string, string> = {};
      for (const name of ASSET_FILES) {
        const p = join(dir, name);
        if (!existsSync(p)) continue;
        const bytes = readFileSync(p);
        const hash = fileHash(bytes);
        if (sent[name] === hash) continue;
        files[name] = bytes.toString('base64');
        sent[name] = hash;
      }
      if (Object.keys(files).length) {
        this.send({ type: 'asset', sku: asset.sku, files });
      }
    }
  }
}
