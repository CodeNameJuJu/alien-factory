// DOM HUD: top bar (shift controls, revenue, models, Devin status), the
// phone crew list, and the event ticker.
import type { Net } from './net';
import { drawAssetFrame } from './assets';
import type { Agent, Asset, StateMessage } from '../../shared/protocol';

export interface HudHooks {
  onSelect: (sel: { type: 'overlord' | 'agent' | 'market' | 'gallery' | 'asset' | 'trends' | 'models' | 'shop'; id?: string }) => void;
}

/// ~12.3k / ~4.5M compact token counts
export function fmtTokens(n: number): string {
  if (n >= 1e6) return `~${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `~${(n / 1e3).toFixed(1)}k`;
  return `~${n}`;
}

export class Hud {
  private bar: HTMLDivElement;
  private ticker: HTMLDivElement;
  private crew: HTMLDivElement;
  private crewKey = '';
  private crewThumbs: { c: HTMLCanvasElement; asset: Asset }[] = [];
  private lastMode: 'research' | 'full' = 'research';
  private lastSource: 'itch' | 'mock' = 'itch';

  constructor(private net: Net, private hooks: HudHooks) {
    this.bar = document.createElement('div');
    this.bar.id = 'hud';
    this.bar.innerHTML = `
      <span id="hud-live" class="hud-pill" style="display:none">…</span>
      <span id="hud-shift" class="hud-pill">stopped</span>
      <span id="hud-research" class="hud-pill warn" style="display:none"></span>
      <button class="btn" id="hud-gofull" style="display:none">[ switch to full ]</button>
      <button class="btn hud-x" data-act="startShift">[ start ]</button>
      <button class="btn hud-x" data-act="pauseShift">[ pause ]</button>
      <button class="btn hud-x" data-act="stopShift">[ stop ]</button>
      <span class="hud-sep hud-x"></span>
      <span id="hud-rev" class="hud-pill">$0.00</span>
      <span id="hud-zar" class="hud-pill dim hud-x">R0.00 mock</span>
      <span id="hud-listed" class="hud-pill hud-x">0 listed</span>
      <span id="hud-proposals" class="hud-pill hud-x">0 proposals</span>
      <span id="hud-scan" class="hud-pill" style="display:none">scan —</span>
      <span id="hud-cap" class="hud-pill warn" style="display:none">token cap hit</span>
      <button class="btn hud-x" id="hud-tok" title="token usage (approx)">tokens ~0</button>
      <span id="hud-queue" class="hud-pill dim hud-x">queue 0</span>
      <span id="hud-turns" class="hud-pill dim hud-x">turns 0/h</span>
      <span class="hud-sep hud-x"></span>
      <button class="btn hud-x" id="hud-mode">[ mode: research ]</button>
      <button class="btn hud-x" id="hud-src">[ src: itch ]</button>
      <button class="btn hud-x" id="hud-trends">[ trends ]</button>
      <button class="btn hud-x" id="hud-scannow">[ scan now ]</button>
      <span class="hud-sep hud-x"></span>
      <span id="hud-devin" class="hud-pill hud-x">Devin …</span>
      <span id="hud-note" class="hud-pill dim hud-x" style="display:none">agents run on the local Mac</span>
      <button class="btn hud-x" id="hud-signin" style="display:none">[ sign in ]</button>
      <button class="btn hud-x" id="hud-models">[ models ]</button>
      <button class="btn hud-x" id="hud-shop">[ shop ]</button>
      <span class="hud-sep hud-x"></span>
      <button class="btn hud-x" id="hud-crt">[ crt: on ]</button>
      <button class="btn hud-x" id="hud-gallery">[ gallery ]</button>
      <button class="btn hud-x" id="hud-market">[ market ]</button>
      <button class="btn" id="hud-menu">[ ≡ ]</button>`;
    document.body.appendChild(this.bar);

    this.ticker = document.createElement('div');
    this.ticker.id = 'ticker';
    document.body.appendChild(this.ticker);

    // phone crew list — sits between the canvas and the ticker in the
    // narrow-screen column layout ("what are they busy with")
    this.crew = document.createElement('div');
    this.crew.id = 'crew';
    document.body.insertBefore(this.crew, this.ticker);
    this.crew.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.crew-gofull')) {
        this.net.send({ type: 'setMode', mode: 'full' });
        return;
      }
      const row = (e.target as HTMLElement).closest<HTMLElement>('.crew-row');
      if (!row?.dataset.agent) return;
      this.hooks.onSelect(row.dataset.agent === 'overlord' ? { type: 'overlord' } : { type: 'agent', id: row.dataset.agent });
    });

    this.bar.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).dataset?.act;
      if (act === 'startShift') this.net.send({ type: 'startShift' });
      else if (act === 'pauseShift') this.net.send({ type: 'pauseShift' });
      else if (act === 'stopShift') this.net.send({ type: 'stopShift' });
      else if ((e.target as HTMLElement).id === 'hud-signin') this.net.send({ type: 'signIn' });
      else if ((e.target as HTMLElement).id === 'hud-crt') this.toggleCrt();
      else if ((e.target as HTMLElement).id === 'hud-mode') this.net.send({ type: 'setMode', mode: this.lastMode === 'research' ? 'full' : 'research' });
      else if ((e.target as HTMLElement).id === 'hud-src') this.net.send({ type: 'setMarketSource', source: this.lastSource === 'itch' ? 'mock' : 'itch' });
      else if ((e.target as HTMLElement).id === 'hud-trends') this.hooks.onSelect({ type: 'trends' });
      else if ((e.target as HTMLElement).id === 'hud-scannow') this.net.send({ type: 'scanNow' });
      else if ((e.target as HTMLElement).id === 'hud-gallery') this.hooks.onSelect({ type: 'gallery' });
      else if ((e.target as HTMLElement).id === 'hud-market') this.hooks.onSelect({ type: 'market' });
      else if ((e.target as HTMLElement).id === 'hud-menu') this.bar.classList.toggle('menu-open');
      else if ((e.target as HTMLElement).id === 'hud-gofull') this.net.send({ type: 'setMode', mode: 'full' });
      else if ((e.target as HTMLElement).id === 'hud-models' || (e.target as HTMLElement).id === 'hud-tok') {
        this.hooks.onSelect({ type: 'models' });
      } else if ((e.target as HTMLElement).id === 'hud-shop') this.hooks.onSelect({ type: 'shop' });
    });

    if (localStorage.getItem('af-crt') === 'off') {
      document.body.classList.add('no-crt');
      (this.bar.querySelector('#hud-crt') as HTMLElement).textContent = '[ crt: off ]';
    }
  }

  private toggleCrt(): void {
    const off = document.body.classList.toggle('no-crt');
    localStorage.setItem('af-crt', off ? 'off' : 'on');
    (this.bar.querySelector('#hud-crt') as HTMLElement).textContent = off ? '[ crt: off ]' : '[ crt: on ]';
  }

  update(s: StateMessage): void {
    const pill = (id: string, text: string) => {
      const el = this.bar.querySelector(id)!;
      if (el.textContent !== text) el.textContent = text;
    };
    const shiftEl = this.bar.querySelector('#hud-shift') as HTMLElement;
    pill('#hud-shift', s.shift);
    shiftEl.className = `hud-pill shift-${s.shift}`;
    const research = s.config.mode === 'research';
    // research banner: running but idle → explain + offer the full pipeline
    const idle = !s.jobs.some((j) => j.status === 'queued' || j.status === 'active');
    const researchIdle = research && s.shift === 'running' && idle;
    const nextScan = Math.max((s.itch.lastScanAt ?? 0) + s.config.itchScanMinutes * 60_000, s.itch.backoffUntil ?? 0);
    const banner = researchIdle
      ? `research — scout only · next scan ${String(new Date(nextScan).getHours()).padStart(2, '0')}:${String(new Date(nextScan).getMinutes()).padStart(2, '0')}`
      : '';
    const rp = this.bar.querySelector('#hud-research') as HTMLElement;
    rp.style.display = researchIdle ? '' : 'none';
    if (rp.textContent !== banner) rp.textContent = banner;
    (this.bar.querySelector('#hud-gofull') as HTMLElement).style.display = researchIdle ? '' : 'none';
    this.lastMode = s.config.mode;
    this.lastSource = s.config.marketSource;
    (this.bar.querySelector('#hud-mode') as HTMLElement).textContent = `[ mode: ${s.config.mode} ]`;
    (this.bar.querySelector('#hud-src') as HTMLElement).textContent = `[ src: ${s.config.marketSource} ]`;
    // research mode: hide revenue/sales pills, show scan status instead
    for (const id of ['#hud-rev', '#hud-zar', '#hud-listed', '#hud-proposals', '#hud-turns']) {
      (this.bar.querySelector(id) as HTMLElement).style.display = research ? 'none' : '';
    }
    (this.bar.querySelector('#hud-scan') as HTMLElement).style.display = research ? '' : 'none';
    const rev = s.market.totals.revenueUsd;
    pill('#hud-rev', `$${rev.toFixed(2)}`);
    pill('#hud-zar', `R${(rev * s.config.usdToZar).toFixed(2)} mock`);
    pill('#hud-listed', `${s.assets.filter((a) => a.status === 'listed').length} listed`);
    pill('#hud-proposals', `${s.candidates.filter((c) => c.status === 'pending').length} proposals`);
    if (research) {
      const scanEl = this.bar.querySelector('#hud-scan') as HTMLElement;
      if (s.itch.scanning) {
        scanEl.textContent = 'scanning…';
        scanEl.className = 'hud-pill warn';
      } else if (s.itch.backoffUntil && s.itch.backoffUntil > Date.now()) {
        const d = new Date(s.itch.backoffUntil);
        scanEl.textContent = `backoff til ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        scanEl.className = 'hud-pill warn';
      } else if (s.itch.lastScanAt) {
        const d = new Date(s.itch.lastScanAt);
        scanEl.textContent = `scan ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}${s.itch.error ? ' ⚠' : ''}`;
        scanEl.className = `hud-pill${s.itch.error ? ' warn' : ''}`;
      } else {
        scanEl.textContent = 'no scan yet';
        scanEl.className = 'hud-pill dim';
      }
    }
    // [ scan now ] — manual floor is 5 min since the last scan
    const sn = this.bar.querySelector('#hud-scannow') as HTMLButtonElement;
    const left = s.itch.scanning
      ? Infinity
      : Math.max(0, (s.itch.lastScanAt ?? 0) + 5 * 60_000 - Date.now(), (s.itch.backoffUntil ?? 0) - Date.now());
    sn.disabled = left > 0;
    sn.textContent = left > 0 ? `[ scan in ${Math.ceil(left / 60_000)}m ]` : '[ scan now ]';
    pill('#hud-queue', `queue ${s.jobs.filter((j) => j.status === 'queued' || j.status === 'active').length}`);
    const hour = Date.now() - 3600_000;
    pill('#hud-turns', `turns ${s.events.filter((e) => e.at > hour && e.text.includes('Overlord ponders')).length}/h`);
    const dev = this.bar.querySelector('#hud-devin') as HTMLElement;
    const label = !s.acp.alive ? 'Devin offline' : s.acp.authenticated ? 'Devin ✓' : 'Devin (not signed in)';
    if (dev.textContent !== label) dev.textContent = label;
    dev.className = `hud-pill ${s.acp.authenticated ? 'ok' : 'warn'}`;
    // relay deployments: is the agent-running worker linked right now?
    const liveEl = this.bar.querySelector('#hud-live') as HTMLElement;
    if (s.worker) {
      liveEl.style.display = '';
      if (s.worker.connected) {
        liveEl.textContent = '● factory live';
        liveEl.className = 'hud-pill ok';
      } else {
        const t = s.worker.lastSeenAt ? new Date(s.worker.lastSeenAt) : null;
        const hhmm = t ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` : 'never';
        liveEl.textContent = `○ factory offline — last seen ${hhmm}`;
        liveEl.className = 'hud-pill warn';
      }
    } else {
      liveEl.style.display = 'none';
    }
    // deployments without devin acp / an offline worker: agent controls off
    (this.bar.querySelector('#hud-signin') as HTMLElement).style.display = s.devinEnabled && !s.acp.authenticated ? '' : 'none';
    const note = this.bar.querySelector('#hud-note') as HTMLElement;
    note.style.display = s.devinEnabled ? 'none' : '';
    note.textContent = s.worker && !s.worker.connected ? 'factory offline — start it on your Mac' : 'agents run on the local Mac';
    for (const sel of ['[data-act="startShift"]', '[data-act="pauseShift"]', '[data-act="stopShift"]', '#hud-mode']) {
      for (const el of this.bar.querySelectorAll<HTMLElement>(sel)) {
        if (el instanceof HTMLButtonElement || el instanceof HTMLSelectElement) el.disabled = !s.devinEnabled;
      }
    }

    // token meter (approx) + cap-hit banner
    let today = 0;
    for (const t of Object.values(s.usage?.byRole ?? {})) today += t.day.input + t.day.cachedRead + t.day.cachedWrite + t.day.output;
    pill('#hud-tok', `tokens ${fmtTokens(today)}`);
    (this.bar.querySelector('#hud-cap') as HTMLElement).style.display = s.tokenCapHit ? '' : 'none';

    // ticker: newest on top (fewer lines on small screens)
    this.ticker.innerHTML = '';
    for (const ev of s.events.slice(-(window.innerWidth < 760 ? 4 : 6))) {
      const d = document.createElement('div');
      d.className = 'tick';
      const time = new Date(ev.at);
      const hh = String(time.getHours()).padStart(2, '0');
      const mm = String(time.getMinutes()).padStart(2, '0');
      d.textContent = `${hh}:${mm} ${ev.text}`;
      if (ev.sku) {
        d.classList.add('tick-link');
        d.addEventListener('click', () => this.hooks.onSelect({ type: 'asset', id: ev.sku }));
      }
      this.ticker.prepend(d);
    }

    this.renderCrew(s);
  }

  /// "What are they busy with" — one row per agent, narrow screens only.
  private renderCrew(s: StateMessage): void {
    const pending = s.candidates.filter((c) => c.status === 'pending').length;
    const idle = !s.jobs.some((j) => j.status === 'queued' || j.status === 'active');
    const researchIdle = s.config.mode === 'research' && s.shift === 'running' && idle;
    const key = JSON.stringify([
      pending,
      researchIdle,
      s.agents.map((a) => [a.id, a.state, a.statusLine, a.currentJobId]),
      s.jobs.filter((j) => j.status === 'active').map((j) => [j.id, j.sku, j.createdAt]),
      Object.values(s.usage?.byRole ?? {}).map((t) => t.day.input + t.day.cachedRead + t.day.cachedWrite + t.day.output),
    ]);
    if (key === this.crewKey) return;
    this.crewKey = key;
    this.crew.innerHTML = '';
    this.crewThumbs = [];

    const dotColor = (a: Agent) =>
      a.state === 'working' ? '#ffb84a' : a.state === 'error' ? '#ff5f6e' : a.state === 'offline' ? '#606070' : '#5cf2c8';
    const elapsed = (at: number) => {
      const m = Math.floor((Date.now() - at) / 60_000);
      return m < 1 ? '<1m' : `${m}m`;
    };

    if (researchIdle) {
      const nextScan = Math.max((s.itch.lastScanAt ?? 0) + s.config.itchScanMinutes * 60_000, s.itch.backoffUntil ?? 0);
      const d = new Date(nextScan);
      const head = document.createElement('div');
      head.className = 'crew-head';
      head.innerHTML = `research — scout only · next scan ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} <button class="btn crew-gofull">[ switch to full ]</button>`;
      this.crew.appendChild(head);
    }

    const overlord = s.agents.find((a) => a.kind === 'overlord');
    const rest = s.agents.filter((a) => a.kind !== 'overlord');
    for (const a of [overlord, ...rest]) {
      if (!a) continue;
      const row = document.createElement('div');
      row.className = 'crew-row';
      row.dataset.agent = a.id;
      const job = a.currentJobId ? s.jobs.find((j) => j.id === a.currentJobId) : null;
      const asset = job?.sku ? s.assets.find((x) => x.sku === job.sku) : null;
      const role = a.kind === 'overlord' ? 'overlord' : a.kind;
      const ru = s.usage?.byRole?.[a.kind]?.day;
      const toks = ru ? ru.input + ru.cachedRead + ru.cachedWrite + ru.output : 0;
      const roleLabel = toks ? `${role} ${fmtTokens(toks)}` : role;
      const status = a.id === overlord?.id
        ? `${a.statusLine || 'watching'}${pending ? ` · ${pending} proposals` : ''}`
        : a.statusLine || a.state;
      row.innerHTML = `
        <span class="crew-dot" style="background:${dotColor(a)}"></span>
        <span class="crew-main"><b>${a.name}</b> <i>${roleLabel}</i><br><span class="crew-status">${status}</span></span>
        <span class="crew-side">${job ? elapsed(job.createdAt) : ''}</span>`;
      if (asset) {
        const c = document.createElement('canvas');
        c.width = 32;
        c.height = 32;
        c.className = 'crew-thumb';
        row.appendChild(c);
        this.crewThumbs.push({ c, asset });
      }
      this.crew.appendChild(row);
    }
  }

  /// Animate the crew thumbnails (called from the main loop).
  tick(t: number): void {
    if (!this.crewThumbs.length) return;
    for (const { c, asset } of this.crewThumbs) {
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, c.width, c.height);
      const scale = Math.max(1, Math.floor(32 / (asset.size || 16)));
      drawAssetFrame(ctx, asset, (32 - asset.size * scale) / 2, (32 - asset.size * scale) / 2, scale, t);
    }
  }
}
