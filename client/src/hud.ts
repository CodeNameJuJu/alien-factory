// DOM HUD: top bar (shift controls, revenue, models, Devin status) and the
// bottom-left event ticker.
import type { Net } from './net';
import type { StateMessage } from '../../shared/protocol';

export interface HudHooks {
  onSelect: (sel: { type: 'overlord' | 'market' | 'gallery' | 'asset' | 'trends'; id?: string }) => void;
}

export class Hud {
  private bar: HTMLDivElement;
  private ticker: HTMLDivElement;
  private modelOverlord: HTMLSelectElement;
  private modelWorker: HTMLSelectElement;
  private lastModelSig = '';
  private lastMode: 'research' | 'full' = 'research';
  private lastSource: 'itch' | 'mock' = 'itch';

  constructor(private net: Net, private hooks: HudHooks) {
    this.bar = document.createElement('div');
    this.bar.id = 'hud';
    this.bar.innerHTML = `
      <span id="hud-shift" class="hud-pill">stopped</span>
      <button class="btn" data-act="startShift">[ start ]</button>
      <button class="btn" data-act="pauseShift">[ pause ]</button>
      <button class="btn" data-act="stopShift">[ stop ]</button>
      <span class="hud-sep"></span>
      <span id="hud-rev" class="hud-pill">$0.00</span>
      <span id="hud-zar" class="hud-pill dim">R0.00 mock</span>
      <span id="hud-listed" class="hud-pill">0 listed</span>
      <span id="hud-proposals" class="hud-pill">0 proposals</span>
      <span id="hud-scan" class="hud-pill" style="display:none">scan —</span>
      <span id="hud-queue" class="hud-pill dim">queue 0</span>
      <span id="hud-turns" class="hud-pill dim">turns 0/h</span>
      <span class="hud-sep"></span>
      <button class="btn" id="hud-mode">[ mode: research ]</button>
      <button class="btn" id="hud-src">[ src: itch ]</button>
      <button class="btn" id="hud-trends">[ trends ]</button>
      <button class="btn" id="hud-scannow">[ scan now ]</button>
      <span class="hud-sep"></span>
      <span id="hud-devin" class="hud-pill">Devin …</span>
      <span id="hud-note" class="hud-pill dim" style="display:none">agents run on the local Mac</span>
      <button class="btn" id="hud-signin" style="display:none">[ sign in ]</button>
      <select id="hud-model-o" title="Overlord model"></select>
      <select id="hud-model-w" title="Worker model"></select>
      <span class="hud-sep"></span>
      <button class="btn" id="hud-crt">[ crt: on ]</button>
      <button class="btn" id="hud-gallery">[ gallery ]</button>
      <button class="btn" id="hud-market">[ market ]</button>`;
    document.body.appendChild(this.bar);

    this.ticker = document.createElement('div');
    this.ticker.id = 'ticker';
    document.body.appendChild(this.ticker);

    this.modelOverlord = this.bar.querySelector('#hud-model-o')!;
    this.modelWorker = this.bar.querySelector('#hud-model-w')!;

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
    });
    const modelChanged = () => {
      this.net.send({
        type: 'setModels',
        overlordModel: this.modelOverlord.value || undefined,
        workerModel: this.modelWorker.value || undefined,
      });
    };
    this.modelOverlord.addEventListener('change', modelChanged);
    this.modelWorker.addEventListener('change', modelChanged);

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
    const left = s.itch.scanning ? Infinity : Math.max(0, (s.itch.lastScanAt ?? 0) + 5 * 60_000 - Date.now());
    sn.disabled = left > 0;
    sn.textContent = left > 0 ? `[ scan in ${Math.ceil(left / 60_000)}m ]` : '[ scan now ]';
    pill('#hud-queue', `queue ${s.jobs.filter((j) => j.status === 'queued' || j.status === 'active').length}`);
    const hour = Date.now() - 3600_000;
    pill('#hud-turns', `turns ${s.events.filter((e) => e.at > hour && e.text.includes('Overlord ponders')).length}/h`);
    const dev = this.bar.querySelector('#hud-devin') as HTMLElement;
    const label = !s.acp.alive ? 'Devin offline' : s.acp.authenticated ? 'Devin ✓' : 'Devin (not signed in)';
    if (dev.textContent !== label) dev.textContent = label;
    dev.className = `hud-pill ${s.acp.authenticated ? 'ok' : 'warn'}`;
    // deployments without devin acp: all agent controls disabled
    (this.bar.querySelector('#hud-signin') as HTMLElement).style.display = s.devinEnabled && !s.acp.authenticated ? '' : 'none';
    (this.bar.querySelector('#hud-note') as HTMLElement).style.display = s.devinEnabled ? 'none' : '';
    for (const sel of ['[data-act="startShift"]', '[data-act="pauseShift"]', '[data-act="stopShift"]', '#hud-mode', '#hud-model-o', '#hud-model-w']) {
      for (const el of this.bar.querySelectorAll<HTMLElement>(sel)) {
        if (el instanceof HTMLButtonElement || el instanceof HTMLSelectElement) el.disabled = !s.devinEnabled;
      }
    }

    // model selects — rebuild only when the option set changes
    const sig = JSON.stringify(s.acp.modelGroups.map((g) => g.values.map((v) => v.id)));
    if (sig !== this.lastModelSig && s.acp.modelGroups.length) {
      this.lastModelSig = sig;
      for (const sel of [this.modelOverlord, this.modelWorker]) {
        sel.innerHTML = '';
        for (const g of s.acp.modelGroups) {
          const og = document.createElement('optgroup');
          og.label = g.name || 'models';
          for (const v of g.values) {
            const o = document.createElement('option');
            o.value = v.id;
            o.textContent = v.name;
            og.appendChild(o);
          }
          sel.appendChild(og);
        }
      }
    }
    this.modelOverlord.value = s.config.overlordModel;
    this.modelWorker.value = s.config.workerModel;

    // ticker: last 6 events, newest on top
    this.ticker.innerHTML = '';
    for (const ev of s.events.slice(-6)) {
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
  }
}
