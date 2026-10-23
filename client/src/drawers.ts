// Right-side, non-modal drawer: Overlord console, alien inspector, asset
// detail, market report and the gallery.
import type { Net } from './net';
import { renderMd } from './md';
import { atlasFor, drawAssetFrame, drawAtlasItem, fetchAtlas, fetchMeta, metaFor } from './assets';
import type { AtlasItem } from './assets';
import { fmtTokens } from './hud';
import type { Agent, AgentKind, Asset, ClientMessage, StateMessage, UsageCounts } from '../../shared/protocol';
import { canClearGumroad, shipEligibility, unshippableReasons } from '../../shared/shop';

/// statuses where an agent/pipeline still owns the asset — never archive
const IN_PIPELINE = new Set(['queued', 'forging', 'inspecting', 'on_conveyor', 'packing']);

/// Assets the bulk archive would take — mirrors factory.archiveUnshippable.
function unshippableAssets(s: StateMessage): Asset[] {
  return s.assets.filter((a) => {
    if (a.channels?.gumroad?.productId || IN_PIPELINE.has(a.status)) return false;
    if (a.status === 'failed' || a.status === 'scrapped') return true;
    return a.status === 'listed' && unshippableReasons(a, metaFor(a.sku) ?? undefined, s.config.gumroad).length > 0;
  });
}

export type Selection =
  | { type: 'overlord' }
  | { type: 'agent'; id: string }
  | { type: 'asset'; id: string }
  | { type: 'market' }
  | { type: 'trends' }
  | { type: 'gallery' }
  | { type: 'models' }
  | { type: 'shop' };

/// POST /api/reveal — server-side `open` on the factory dir (no-op errors).
function reveal(body: { sku?: string; dir?: string }): void {
  void fetch('/api/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => undefined);
}

export class Drawers {
  private el: HTMLDivElement;
  private sel: Selection | null = null;
  private state: StateMessage | null = null;
  private animCanvases: { c: HTMLCanvasElement; asset: Asset; scale: number; item?: AtlasItem }[] = [];
  private galleryFilter = '';
  private overlordTab = 'proposals';
  private lastKey = '';
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  onClose: () => void = () => {};

  constructor(private net: Net) {
    this.el = document.createElement('div');
    this.el.id = 'drawer';
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.sel !== null;
  }

  get selection(): Selection | null {
    return this.sel;
  }

  open(sel: Selection): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.sel = sel;
    this.lastKey = '';
    this.el.style.display = 'flex';
    this.el.classList.remove('crt-out');
    this.el.classList.add('crt-in');
    this.render();
  }

  close(): void {
    this.sel = null;
    this.el.classList.remove('crt-in');
    this.el.classList.add('crt-out');
    this.closeTimer = setTimeout(() => {
      this.el.style.display = 'none';
      this.el.classList.remove('crt-out');
    }, 170);
    this.onClose();
  }

  setState(s: StateMessage): void {
    this.state = s;
    if (this.isOpen) {
      const key = this.renderKey();
      if (key !== this.lastKey) {
        this.lastKey = key;
        this.render();
      }
    }
  }

  /// Cheap signature of exactly what the open drawer displays — state
  /// broadcasts ~10x/s must not re-render (and wipe the textarea) on noise.
  private renderKey(): string {
    const s = this.state!;
    if (!this.sel) return '';
    switch (this.sel.type) {
      case 'overlord': {
        const o = s.agents.find((a) => a.kind === 'overlord');
        return JSON.stringify({
          tab: this.overlordTab,
          c: s.candidates,
          d: s.decisions.length,
          tl: o?.transcript.length,
          st: `${o?.state ?? ''}${o?.statusLine ?? ''}`,
        });
      }
      case 'agent': {
        const a = s.agents.find((x) => x.id === (this.sel as { id: string }).id);
        return a
          ? JSON.stringify([a.state, a.statusLine, a.currentJobId, a.transcript.length, a.jobsInSession, a.lastUsage])
          : 'gone';
      }
      case 'asset': {
        const a = s.assets.find((x) => x.sku === (this.sel as { id: string }).id);
        const c = a ? s.candidates.find((x) => x.id === a.candidateId) : undefined;
        return JSON.stringify([a, c]);
      }
      case 'market':
        return String(s.market.tick);
      case 'trends':
        return JSON.stringify([s.itch.lastScanAt, s.itch.scanning, s.itch.error, s.itch.analysis, s.trendReports.length]);
      case 'models':
        return JSON.stringify([
          s.config.models,
          s.config.dailyTokenCaps,
          s.usage,
          s.acp.modelGroups.length,
          s.acp.models.length,
          s.devinEnabled,
          s.agents.map((a) => a.modelMismatch?.want),
        ]);
      case 'shop':
        return JSON.stringify([
          s.config.gumroad,
          s.channels?.gumroad,
          s.assets.map((a) => a.channels?.gumroad),
        ]);
      case 'gallery':
        return this.galleryFilter + JSON.stringify(s.assets.map((a) => [a.sku, a.status]));
    }
  }

  /// called every frame — animates asset previews in the open drawer
  tick(t: number): void {
    for (const { c, asset, scale, item } of this.animCanvases) {
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, c.width, c.height);
      if (item) drawAtlasItem(ctx, asset.sku, item, 0, 0, scale, t);
      else drawAssetFrame(ctx, asset, 0, 0, scale, t);
    }
  }

  private render(): void {
    if (!this.sel || !this.state) return;
    this.lastKey = this.renderKey();
    // stash interactive bits the re-render would otherwise wipe
    const directive = this.el.querySelector<HTMLTextAreaElement>('#directive');
    const directiveVal = directive?.value ?? null;
    const directiveFocused = document.activeElement === directive;
    const log = this.el.querySelector('.log');
    const logAtBottom = log ? log.scrollHeight - log.scrollTop - log.clientHeight < 20 : false;

    this.animCanvases = [];
    this.el.innerHTML = '';
    const s = this.state;
    switch (this.sel.type) {
      case 'overlord':
        this.renderOverlord(s);
        break;
      case 'agent': {
        const a = s.agents.find((x) => x.id === (this.sel as { id: string }).id);
        if (a) this.renderAgent(a, s);
        break;
      }
      case 'asset': {
        const a = s.assets.find((x) => x.sku === (this.sel as { id: string }).id);
        if (a) this.renderAsset(a, s);
        break;
      }
      case 'market':
        this.renderMarket(s);
        break;
      case 'trends':
        this.renderTrends(s);
        break;
      case 'models':
        this.renderModels(s);
        break;
      case 'shop':
        this.renderShop(s);
        break;
      case 'gallery':
        this.renderGallery(s);
        break;
    }
    // restore
    const ta = this.el.querySelector<HTMLTextAreaElement>('#directive');
    if (ta && directiveVal !== null) {
      ta.value = directiveVal;
      if (directiveFocused) ta.focus();
    }
    const newLog = this.el.querySelector('.log');
    if (newLog && logAtBottom) newLog.scrollTop = newLog.scrollHeight;
  }

  private head(title: string, sub?: string, action?: { label: string; fn: () => void }): HTMLElement {
    const h = document.createElement('div');
    h.className = 'drawer-head';
    const t = document.createElement('span');
    t.textContent = title;
    h.appendChild(t);
    if (sub) {
      const s = document.createElement('span');
      s.className = 'drawer-sub';
      s.textContent = sub;
      h.appendChild(s);
    }
    if (action) {
      const ab = document.createElement('button');
      ab.className = 'btn';
      ab.textContent = action.label;
      ab.addEventListener('click', action.fn);
      h.appendChild(ab);
    }
    const x = document.createElement('button');
    x.className = 'btn dclose';
    x.textContent = '✕';
    x.addEventListener('click', () => this.close());
    h.appendChild(x);
    this.el.appendChild(h);
    return h;
  }

  private body(): HTMLDivElement {
    const b = document.createElement('div');
    b.className = 'drawer-body';
    this.el.appendChild(b);
    return b;
  }

  private kv(b: HTMLElement, k: string, v: string): void {
    const d = document.createElement('div');
    d.className = 'kv';
    const kEl = document.createElement('span');
    kEl.textContent = k;
    const vEl = document.createElement('span');
    vEl.textContent = v;
    d.append(kEl, vEl);
    b.appendChild(d);
  }

  private thumb(b: HTMLElement, asset: Asset, scale = 4): void {
    const c = document.createElement('canvas');
    c.className = 'athumb';
    const meta = metaFor(asset.sku);
    const w = meta?.w ?? asset.size;
    const h = meta?.h ?? asset.size;
    c.width = w * scale;
    c.height = h * scale;
    b.appendChild(c);
    this.animCanvases.push({ c, asset, scale });
  }

  // ---- overlord ---------------------------------------------------------------

  private renderOverlord(s: StateMessage): void {
    const o = s.agents.find((a) => a.kind === 'overlord');
    this.head('THE OVERLORD', `${o?.modelName ?? s.config.models.overlord} · ${o?.statusLine ?? ''}`);
    const b = this.body();
    const tabs = document.createElement('div');
    tabs.className = 'tabs';
    for (const t of ['proposals', 'log'] as const) {
      const btn = document.createElement('button');
      btn.className = 'btn tab' + (this.overlordTab === t ? ' on' : '');
      btn.textContent = t;
      btn.addEventListener('click', () => {
        this.overlordTab = t;
        this.render();
      });
      tabs.appendChild(btn);
    }
    b.appendChild(tabs);

    if (this.overlordTab === 'proposals') {
      const pending = s.candidates.filter((c) => c.status === 'pending');
      const decided = s.candidates.filter((c) => c.status !== 'pending');
      if (!s.candidates.length) {
        const p = document.createElement('p');
        p.className = 'note';
        p.textContent = 'No proposals yet — the scout reports after a market sweep.';
        b.appendChild(p);
      }
      for (const c of pending) {
        const row = document.createElement('div');
        row.className = 'acard';
        const info = document.createElement('div');
        info.innerHTML = `<b></b> <span class="dim"></span><div class="note"></div>`;
        info.querySelector('b')!.textContent = `${c.id} · ${c.title}`;
        (info.querySelector('.dim') as HTMLElement).textContent =
          ` ${c.tags.join(', ')} · ${c.size}px×${c.frames}f · demand ${c.demand}/10` +
          (c.kind === 'pack' ? ` · pack ×${c.items ?? '?'}` : '');
        (info.querySelector('.note') as HTMLElement).textContent =
          c.why + (c.variantOf ? ` · variant of ${c.variantOf}` : '');
        row.appendChild(info);
        b.appendChild(row);
      }
      if (decided.length) {
        const h = document.createElement('div');
        h.className = 'md-h';
        h.textContent = 'Decided';
        b.appendChild(h);
        for (const c of decided.slice(-15).reverse()) {
          const row = document.createElement('div');
          row.className = 'acard';
          const a = c.sku ? s.assets.find((x) => x.sku === c.sku) : undefined;
          if (a) this.thumb(row, a, 3);
          const info = document.createElement('div');
          info.innerHTML = `<span class="${c.status === 'approved' ? 'v-pass' : 'v-fail'} verdict">${c.status === 'approved' ? '✓' : '✗'}</span> <b></b><div class="note"></div>`;
          info.querySelector('b')!.textContent = `${c.id} · ${c.title}${c.kind === 'pack' ? ` ×${c.items ?? '?'}` : ''}`;
          (info.querySelector('.note') as HTMLElement).textContent =
            `${c.reason ?? ''}${c.smith ? ` · → ${c.smith}` : ''}${c.sku ? ` · ${c.sku}` : ''}`;
          row.appendChild(info);
          if (c.sku) {
            row.style.cursor = 'pointer';
            row.addEventListener('click', () => this.open({ type: 'asset', id: c.sku! }));
          }
          b.appendChild(row);
        }
      }
    } else {
      const log = document.createElement('div');
      log.className = 'md log';
      renderMd((o?.transcript ?? []).map((e) => e.text).join('\n\n---\n\n') || '(no transcript yet)', log);
      b.appendChild(log);
      requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
    }

    const cmd = document.createElement('div');
    cmd.className = 'cmd';
    const ta = document.createElement('textarea');
    ta.id = 'directive';
    ta.rows = 2;
    ta.placeholder = s.devinEnabled
      ? 'Command the overlord… (e.g. "more slime variants")'
      : 'agents run on the local Mac — this node only scans';
    ta.disabled = !s.devinEnabled;
    const cur = document.createElement('span');
    cur.className = 'cursor';
    cur.textContent = '█';
    const btn = document.createElement('button');
    btn.className = 'btn primary';
    btn.textContent = '[ send ]';
    btn.disabled = !s.devinEnabled;
    btn.addEventListener('click', () => {
      if (ta.value.trim()) this.net.send({ type: 'directive', text: ta.value.trim() });
      ta.value = '';
    });
    cmd.append(ta, cur, btn);
    b.appendChild(cmd);
  }

  // ---- alien ------------------------------------------------------------------

  private renderAgent(a: Agent, s: StateMessage): void {
    this.head(a.name, `${a.kind} · ${a.modelName}`);
    const b = this.body();
    this.kv(b, 'model', a.model);
    if (a.modelMismatch) {
      const w = document.createElement('div');
      w.className = 'note';
      w.style.color = 'var(--amber)';
      w.textContent = `⚠ ${a.modelMismatch.want} not offered by Devin — using ${a.modelMismatch.using}`;
      b.appendChild(w);
    }
    this.kv(b, 'state', a.state);
    this.kv(b, 'status', a.statusLine);
    this.kv(b, 'jobs in session', String(a.jobsInSession));
    const job = s.jobs.find((j) => j.id === a.currentJobId);
    if (job) {
      this.kv(b, 'current job', `${job.kind} ${job.sku ?? ''}${job.pinnedTo ? ' (pinned)' : ''}`);
      const asset = job.sku ? s.assets.find((x) => x.sku === job.sku) : undefined;
      if (asset) {
        if (asset.kind === 'pack') this.kv(b, 'pack', `×${asset.items ?? '?'} items`);
        this.thumb(b, asset, 5);
      }
    }
    const cancel = document.createElement('button');
    cancel.className = 'btn danger';
    cancel.textContent = 'Cancel turn';
    cancel.disabled = a.state !== 'working';
    cancel.addEventListener('click', () => this.net.send({ type: 'cancelAgent', agentId: a.id }));
    b.appendChild(cancel);

    if (a.lastUsage) {
      const det = document.createElement('details');
      const sum = document.createElement('summary');
      sum.textContent = 'last usage';
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(a.lastUsage, null, 2);
      det.append(sum, pre);
      b.appendChild(det);
    }

    const log = document.createElement('div');
    log.className = 'log';
    for (const e of a.transcript) {
      const d = document.createElement('div');
      d.className = `entry ${e.role}`;
      d.textContent = e.text;
      log.appendChild(d);
    }
    b.appendChild(log);
    requestAnimationFrame(() => {
      if (log.scrollHeight - log.scrollTop - log.clientHeight < 20 || !log.scrollTop) {
        log.scrollTop = log.scrollHeight;
      }
    });
  }

  // ---- asset ------------------------------------------------------------------

  private renderAsset(a: Asset, s: StateMessage): void {
    const isPack = a.kind === 'pack';
    const ah = this.head(a.sku, `${a.status}${isPack ? ` · pack ×${a.items ?? '?'}` : ''}`, { label: '[ show in finder ]', fn: () => reveal({ sku: a.sku }) });
    if (!IN_PIPELINE.has(a.status) && !a.channels?.gumroad?.productId) {
      const arch = document.createElement('button');
      arch.className = 'btn';
      arch.textContent = '[ archive ]';
      arch.title = 'move the asset folder to archive/ and drop it from state (never touches gumroad)';
      arch.addEventListener('click', () => {
        if (confirm(`archive ${a.sku}? the folder moves to archive/ and the asset leaves the factory`)) {
          this.net.send({ type: 'archiveAsset', sku: a.sku });
        }
      });
      ah.insertBefore(arch, ah.lastChild);
    }
    const b = this.body();
    const meta = metaFor(a.sku);
    const w = meta?.w ?? a.size;
    const big = document.createElement('canvas');
    big.width = w * 8;
    big.height = w * 8;
    big.className = 'abig';
    b.appendChild(big);
    this.animCanvases.push({ c: big, asset: a, scale: 8 });
    if (isPack) {
      // grid of every item, each animated from the atlas
      const atlas = atlasFor(a.sku);
      const cellScale = w <= 16 ? 3 : 2;
      const grid = document.createElement('div');
      grid.className = 'packgrid';
      if (atlas) {
        for (const it of atlas.items) {
          const cell = document.createElement('div');
          cell.className = 'packcell';
          cell.title = it.name;
          const c = document.createElement('canvas');
          c.width = it.w * cellScale;
          c.height = it.h * cellScale;
          cell.appendChild(c);
          const nm = document.createElement('div');
          nm.className = 'packname';
          nm.textContent = it.name;
          cell.appendChild(nm);
          grid.appendChild(cell);
          this.animCanvases.push({ c, asset: a, scale: cellScale, item: it });
        }
      } else {
        grid.className = 'note';
        grid.textContent = '(atlas loading…)';
      }
      b.appendChild(grid);
      const links = document.createElement('div');
      links.className = 'note';
      links.append(document.createTextNode('files: '));
      for (const f of ['sheet.png', 'atlas.json', 'preview.png']) {
        const l = document.createElement('a');
        l.href = `/files/assets/${a.sku}/${f}`;
        l.target = '_blank';
        l.rel = 'noopener';
        l.textContent = f;
        links.append(l, document.createTextNode(' '));
      }
      b.appendChild(links);
    } else {
      const sheet = document.createElement('img');
      sheet.src = `/files/assets/${a.sku}/sheet.png`;
      sheet.className = 'asheet';
      sheet.onerror = () => (sheet.style.display = 'none');
      b.appendChild(sheet);
    }

    this.kv(b, 'title', a.title);
    this.kv(b, 'tags', a.tags.join(', '));
    this.kv(b, 'kind', isPack ? `pack ×${a.items ?? '?'}` : 'sprite');
    this.kv(b, 'size', `${a.size}×${a.size} × ${a.frames}f${isPack ? ' / item' : ''}`);
    if (isPack && a.itemNames?.length) this.kv(b, 'items', a.itemNames.slice(0, 12).join(', ') + (a.itemNames.length > 12 ? '…' : ''));
    const cand = a.candidateId ? s.candidates.find((x) => x.id === a.candidateId) : undefined;
    if (cand) {
      this.kv(b, 'proposal', `${cand.id} · demand ${cand.demand}/10 — ${cand.why}`);
      if (cand.reason) this.kv(b, 'overlord', `${cand.status === 'approved' ? '✓' : '✗'} ${cand.reason}${cand.smith ? ` → ${cand.smith}` : ''}`);
    }
    if (a.smith) this.kv(b, 'smith', a.smith);
    if (a.variantOf) {
      const row = document.createElement('div');
      row.className = 'kv';
      const k = document.createElement('span');
      k.textContent = 'variant of';
      const v = document.createElement('a');
      v.textContent = a.variantOf;
      v.href = '#';
      v.addEventListener('click', (e) => {
        e.preventDefault();
        this.open({ type: 'asset', id: a.variantOf! });
      });
      row.append(k, v);
      b.appendChild(row);
    }
    if (a.checks) this.kv(b, 'checks', a.checks.passed ? 'passed' : `FAILED: ${a.checks.issues.join('; ')}`);
    if (a.inspection) this.kv(b, 'inspection', `${a.inspection.verdict} ${a.inspection.score}/10 — ${a.inspection.notes}`);
    if (a.listing) {
      this.kv(b, 'listing', `${a.listing.title} — $${a.listing.priceUsd.toFixed(2)}`);
      const d = document.createElement('div');
      d.className = 'note';
      d.textContent = a.listing.description;
      b.appendChild(d);
    }
    this.kv(b, 'sales', `${a.sales.views} views · ${a.sales.units} units · $${a.sales.revenueUsd.toFixed(2)} · R${(a.sales.revenueUsd * s.config.usdToZar).toFixed(2)}`);
    this.renderShopSection(b, a, s, meta);
    // fetch meta/atlas only when missing — otherwise the resolved microtask
    // would re-render this drawer forever (the freeze bug)
    if (!meta) {
      void fetchMeta(a.sku).then((m) => {
        if (m && this.sel?.type === 'asset' && this.sel.id === a.sku) this.render();
      });
    }
    if (isPack && !atlasFor(a.sku)) {
      void fetchAtlas(a.sku).then((at) => {
        if (at && this.sel?.type === 'asset' && this.sel.id === a.sku) this.render();
      });
    }
  }

  // ---- models & usage --------------------------------------------------------------

  private costLine(c: UsageCounts, priced: number | null, usdToZar: number): string {
    const toks = c.input + c.cachedRead + c.cachedWrite + c.output;
    const base = `${fmtTokens(toks)} tok · ${c.requests} req`;
    if (priced == null) return base;
    return `${base} · ≈$${priced.toFixed(4)} / R${(priced * usdToZar).toFixed(2)}`;
  }

  private pricedCost(c: UsageCounts, s: StateMessage, model: string): number | null {
    const p = s.config.prices?.[model];
    if (!p) return null;
    return (c.input * p.inPerM + c.cachedRead * p.cachedReadPerM + c.cachedWrite * p.cachedWritePerM + c.output * p.outPerM) / 1e6;
  }

  private renderModels(s: StateMessage): void {
    this.head('MODELS & USAGE', 'approx — see logs/usage.jsonl');
    const b = this.body();
    const roles: AgentKind[] = ['overlord', 'scout', 'smith', 'inspector', 'packer'];
    // what this Devin build actually offers — empty when Devin's offline,
    // so only flag misses when we have a real list
    const offered = new Set(s.acp.models.map((m) => m.id));
    const warn = (card: HTMLElement, text: string) => {
      const w = document.createElement('div');
      w.className = 'note';
      w.style.color = 'var(--amber)';
      w.textContent = `⚠ ${text}`;
      card.appendChild(w);
    };

    for (const role of roles) {
      const card = document.createElement('div');
      card.className = 'acard';
      const names = s.agents.filter((a) => a.kind === role).map((a) => a.name).join(', ');
      const title = document.createElement('div');
      title.innerHTML = `<b>${role}</b> <span class="dim"></span>`;
      (title.querySelector('.dim') as HTMLElement).textContent = names ? ` ${names}` : '';
      card.appendChild(title);
      const sel = document.createElement('select');
      sel.disabled = !s.devinEnabled;
      for (const g of s.acp.modelGroups) {
        const og = document.createElement('optgroup');
        og.label = g.name || 'models';
        for (const v of g.values) {
          const o = document.createElement('option');
          o.value = v.id;
          o.textContent = offered.size && !offered.has(v.id) ? `${v.name} ⚠` : v.name;
          og.appendChild(o);
        }
        sel.appendChild(og);
      }
      const cur = s.config.models[role];
      if (cur && ![...sel.options].some((o) => o.value === cur)) {
        const o = document.createElement('option');
        o.value = cur;
        o.textContent = cur;
        sel.appendChild(o);
      }
      sel.value = cur;
      sel.addEventListener('change', () => this.net.send({ type: 'setModels', role, model: sel.value }));
      card.appendChild(sel);
      if (cur && offered.size && !offered.has(cur)) warn(card, `${cur} not offered by this Devin`);
      for (const a of s.agents.filter((x) => x.kind === role && x.modelMismatch)) {
        warn(card, `${a.name} is using ${a.modelMismatch!.using}`);
      }

      const u = s.usage?.byRole?.[role];
      if (u) {
        const cost = (c: UsageCounts) => this.pricedCost(c, s, s.config.models[role]);
        const tbl = document.createElement('div');
        tbl.className = 'note';
        tbl.textContent =
          `today ${this.costLine(u.day, cost(u.day), s.config.usdToZar)}\n` +
          `hour  ${this.costLine(u.hour, cost(u.hour), s.config.usdToZar)}\n` +
          `total ${this.costLine(u.total, cost(u.total), s.config.usdToZar)}`;
        tbl.style.whiteSpace = 'pre-wrap';
        card.appendChild(tbl);
      }
      b.appendChild(card);
    }

    const mh = document.createElement('div');
    mh.className = 'md-h';
    mh.textContent = 'Per model';
    b.appendChild(mh);
    const models = Object.entries(s.usage?.byModel ?? {});
    if (!models.length) {
      const d = document.createElement('div');
      d.className = 'note';
      d.textContent = '(no usage recorded yet)';
      b.appendChild(d);
    }
    for (const [model, u] of models) {
      const d = document.createElement('div');
      d.className = 'note';
      d.textContent = `${model} — today ${this.costLine(u.day, this.pricedCost(u.day, s, model), s.config.usdToZar)}`;
      b.appendChild(d);
    }

    const ch = document.createElement('div');
    ch.className = 'md-h';
    ch.textContent = 'Daily token caps (total incl. cached)';
    b.appendChild(ch);
    const caps = s.config.dailyTokenCaps ?? {};
    const capRow = document.createElement('div');
    capRow.className = 'cmd';
    const mk = (label: string, key: 'overlord' | 'workers') => {
      const w = document.createElement('label');
      w.className = 'note';
      w.style.display = 'flex';
      w.style.gap = '6px';
      w.style.alignItems = 'center';
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = '0';
      inp.placeholder = 'off';
      inp.value = caps[key] != null ? String(caps[key]) : '';
      inp.id = `cap-${key}`;
      inp.style.width = '9em';
      w.append(label + ' ', inp);
      return w;
    };
    const capBtn = document.createElement('button');
    capBtn.className = 'btn primary';
    capBtn.textContent = '[ set caps ]';
    capBtn.disabled = !s.devinEnabled;
    capBtn.addEventListener('click', () => {
      const v = (id: string) => {
        const n = Number((this.el.querySelector(`#cap-${id}`) as HTMLInputElement)?.value);
        return n > 0 ? n : null;
      };
      this.net.send({ type: 'setCaps', caps: { overlord: v('overlord'), workers: v('workers') } });
    });
    capRow.append(mk('overlord', 'overlord'), mk('workers', 'workers'), capBtn);
    b.appendChild(capRow);
    if (s.tokenCapHit) {
      const d = document.createElement('div');
      d.className = 'note';
      d.textContent = '⚠ daily token cap hit — paused until midnight or raise the cap';
      b.appendChild(d);
    }
  }

  // ---- market -------------------------------------------------------------------

  private renderMarket(s: StateMessage): void {
    this.head('MOCK MARKET', `tick ${s.market.tick}`);
    const b = this.body();
    const h = document.createElement('div');
    h.className = 'md-h';
    h.textContent = 'Tag demand';
    b.appendChild(h);
    for (const t of s.market.tags) {
      const row = document.createElement('div');
      row.className = 'mtag';
      const arrow = t.trend > 0 ? '↑' : t.trend < 0 ? '↓' : '→';
      const color = t.trend > 0 ? '#60c060' : t.trend < 0 ? '#d06060' : '#909090';
      row.innerHTML = `<span class="mtag-name"></span><span class="mtag-bar"></span><span style="color:${color}">${arrow}</span>`;
      row.querySelector('.mtag-name')!.textContent = t.tag;
      const fill = Math.round(t.demand * 10);
      (row.querySelector('.mtag-bar') as HTMLElement).innerHTML =
        `${'█'.repeat(fill)}<span class="off">${'░'.repeat(10 - fill)}</span>`;
      b.appendChild(row);
    }
    const sc = document.createElement('canvas');
    sc.width = 300;
    sc.height = 40;
    sc.className = 'spark';
    const scx = sc.getContext('2d')!;
    scx.fillStyle = '#0a0f16';
    scx.fillRect(0, 0, 300, 40);
    const hist = s.market.revenueHistory.slice(-120);
    const max = Math.max(0.01, ...hist);
    scx.strokeStyle = '#5cf2c8';
    scx.beginPath();
    hist.forEach((v, i) => {
      const x = (i / Math.max(1, hist.length - 1)) * 298 + 1;
      const y = 38 - (v / max) * 34;
      if (i) scx.lineTo(x, y);
      else scx.moveTo(x, y);
    });
    scx.stroke();
    b.appendChild(sc);

    const h2 = document.createElement('div');
    h2.className = 'md-h';
    h2.textContent = 'Our top sellers';
    b.appendChild(h2);
    const ours = s.assets.filter((a) => a.status === 'listed').sort((x, y) => y.sales.revenueUsd - x.sales.revenueUsd).slice(0, 8);
    if (!ours.length) {
      const d = document.createElement('div');
      d.className = 'note';
      d.textContent = '(nothing listed yet)';
      b.appendChild(d);
    }
    for (const a of ours) {
      const d = document.createElement('div');
      d.className = 'note mlink';
      d.textContent = `${a.sku} — ${a.sales.units}u · $${a.sales.revenueUsd.toFixed(2)}`;
      d.addEventListener('click', () => this.open({ type: 'asset', id: a.sku }));
      b.appendChild(d);
    }
    const h3 = document.createElement('div');
    h3.className = 'md-h';
    h3.textContent = 'Competitors';
    b.appendChild(h3);
    for (const c of s.market.competitors.slice(0, 10)) {
      const d = document.createElement('div');
      d.className = 'note';
      d.textContent = `${c.title} — ${c.tag} — $${c.priceUsd.toFixed(2)} — ${c.sales} sales`;
      b.appendChild(d);
    }
  }

  // ---- trends (itch.io research) -------------------------------------------------

  private renderTrends(s: StateMessage): void {
    const a = s.itch.analysis;
    const last = s.itch.lastScanAt ? new Date(s.itch.lastScanAt) : null;
    const hh = last ? `${String(last.getHours()).padStart(2, '0')}:${String(last.getMinutes()).padStart(2, '0')}` : 'never';
    this.head('MARKET RADAR', s.itch.scanning ? 'scanning…' : `last scan ${hh}`);
    const b = this.body();

    // status line
    const st = document.createElement('div');
    st.className = 'note';
    st.textContent = s.itch.scanning
      ? 'scanning itch.io feeds… (polite: 1 req / 1.5s)'
      : s.itch.error
        ? `⚠ ${s.itch.error}`
        : a
          ? `${a.priceStats.count} items · median ${a.priceStats.median != null ? '$' + a.priceStats.median.toFixed(2) : '—'} · ${a.priceStats.pctFree}% free · ${a.priceStats.pctOnSale}% on sale`
          : 'no scan yet — press [ scan now ]';
    b.appendChild(st);

    if (!a) {
      this.reportsSection(b, s);
      return;
    }

    // themes table with block-char bars + delta arrows
    const h = document.createElement('div');
    h.className = 'md-h';
    h.textContent = 'Themes';
    b.appendChild(h);
    const maxScore = Math.max(1, ...a.themes.slice(0, 20).map((t) => t.score));
    for (const t of a.themes.slice(0, 20)) {
      const row = document.createElement('div');
      row.className = 'mtag';
      const fill = Math.round((t.score / maxScore) * 10);
      const arrow = t.delta == null ? ' ' : t.delta > 0.05 ? '▲' : t.delta < -0.05 ? '▼' : '→';
      const arrowColor = t.delta == null ? '' : t.delta > 0.05 ? 'var(--phos)' : t.delta < -0.05 ? 'var(--err)' : '';
      row.innerHTML = `<span class="mtag-name"></span><span class="mtag-bar"></span><span class="dim"></span><span style="${arrowColor ? `color:${arrowColor}` : ''}">${arrow}</span>`;
      row.querySelector('.mtag-name')!.textContent = t.key;
      (row.querySelector('.mtag-bar') as HTMLElement).innerHTML =
        `${'█'.repeat(fill)}<span class="off">${'░'.repeat(10 - fill)}</span>`;
      (row.querySelector('.dim') as HTMLElement).textContent =
        `${t.score}${t.medianPrice != null ? ` $${t.medianPrice.toFixed(2)}` : ''} ${t.pctFree}%f`;
      b.appendChild(row);
    }

    // movers
    if (a.movers.length) {
      const h2 = document.createElement('div');
      h2.className = 'md-h';
      h2.textContent = 'Movers';
      b.appendChild(h2);
      for (const m of a.movers.slice(0, 10)) {
        const d = document.createElement('div');
        d.className = 'note';
        const link = document.createElement('a');
        link.href = m.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = m.title;
        const kind = m.kind === 'new_top_seller' ? '★ new top-seller' : m.kind === 'climbed' ? '▲ climbing' : '✦ new & popular';
        d.append(`${kind} `, link, ` ${m.detail}`);
        b.appendChild(d);
      }
    }

    // top sellers / new & popular with thumbnails
    const items = (title: string, list: typeof a.topSellers) => {
      const hx = document.createElement('div');
      hx.className = 'md-h';
      hx.textContent = title;
      b.appendChild(hx);
      for (const it of list) {
        const row = document.createElement('div');
        row.className = 'acard';
        if (it.thumb) {
          const img = document.createElement('img');
          img.src = it.thumb;
          img.referrerPolicy = 'no-referrer';
          img.className = 'athumb';
          img.width = 63;
          img.height = 50;
          img.onerror = () => (img.style.display = 'none');
          row.appendChild(img);
        }
        const info = document.createElement('div');
        const link = document.createElement('a');
        link.href = it.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = `#${it.rank} ${it.title}`;
        const meta = document.createElement('div');
        meta.className = 'note';
        meta.textContent =
          `${it.author} · ${it.free ? 'free/PWYW' : `${it.currency ?? '$'}${it.price?.toFixed(2)}`}${it.salePct ? ` (−${it.salePct}%)` : ''}`;
        info.append(link, meta);
        row.appendChild(info);
        b.appendChild(row);
      }
    };
    items('Top sellers (pixel art)', a.topSellers);
    items('New & popular', a.newAndPopular);

    this.reportsSection(b, s);
  }

  /// Scout trend-report history — latest expanded, opportunities as cards.
  private reportsSection(b: HTMLElement, s: StateMessage): void {
    const h = document.createElement('div');
    h.className = 'md-h';
    h.textContent = 'Scout reports';
    b.appendChild(h);
    if (!s.trendReports.length) {
      const d = document.createElement('div');
      d.className = 'note';
      d.textContent = '(none yet)';
      b.appendChild(d);
      return;
    }
    for (const r of s.trendReports.slice(0, 5)) {
      const det = document.createElement('details');
      if (r === s.trendReports[0]) det.open = true;
      const sum = document.createElement('summary');
      sum.textContent = `#${r.n} — ${new Date(r.at).toLocaleString()}`;
      det.appendChild(sum);
      const md = document.createElement('div');
      md.className = 'md';
      renderMd(r.markdown || '(empty)', md);
      det.appendChild(md);
      for (const o of r.opportunities) {
        const row = document.createElement('div');
        row.className = 'acard';
        const info = document.createElement('div');
        info.innerHTML = `<b></b> <span class="dim"></span><div class="note"></div>`;
        info.querySelector('b')!.textContent = o.title;
        (info.querySelector('.dim') as HTMLElement).textContent =
          ` ${o.tags.join(', ')} · ${o.size}px×${o.frames}f · demand ${o.demand}/10${o.priceBand ? ` · ${o.priceBand}` : ''}` +
          (o.kind === 'pack' ? ` · pack ×${o.items ?? '?'}` : '');
        const note = info.querySelector('.note') as HTMLElement;
        note.textContent = o.why;
        for (const u of o.evidence ?? []) {
          const link = document.createElement('a');
          link.href = u;
          link.target = '_blank';
          link.rel = 'noopener';
          link.textContent = u.replace(/^https?:\/\//, '').slice(0, 60);
          link.style.display = 'block';
          link.style.fontSize = '10px';
          note.appendChild(link);
        }
        row.appendChild(info);
        det.appendChild(row);
      }
      b.appendChild(det);
    }
  }

  // ---- shop (gumroad) --------------------------------------------------------------

  /// products drafted/published/uploading today — mirrors the server gate
  private shippedToday(s: StateMessage): number {
    const today = new Date().toDateString();
    return s.assets.filter((a) => {
      const g = a.channels?.gumroad;
      return (
        g?.at && new Date(g.at).toDateString() === today && g.status !== 'error' && g.status !== 'none'
      );
    }).length;
  }

  /// SHOP section inside the asset drawer — vertical stack: header + status
  /// badge, eligibility, buttons, links (one per line), manual-cover note.
  private renderShopSection(b: HTMLElement, a: Asset, s: StateMessage, meta: ReturnType<typeof metaFor>): void {
    const g = a.channels?.gumroad;
    const configured = s.channels?.gumroad?.configured === true;
    const elig = shipEligibility(a, meta ?? undefined, s.config.gumroad, this.shippedToday(s));
    const card = document.createElement('div');
    card.className = 'acard v';

    const head = document.createElement('div');
    head.className = 'kv';
    const ht = document.createElement('b');
    ht.textContent = 'SHOP — gumroad';
    const badge = document.createElement('span');
    badge.textContent = g && g.status !== 'none' ? g.status : 'not shipped';
    head.append(ht, badge);
    card.appendChild(head);

    if (a.status === 'listed' || a.channels?.gumroad) {
      if (elig.ok) {
        const ok = document.createElement('div');
        ok.className = 'note';
        ok.textContent = '✓ eligible to ship';
        card.appendChild(ok);
      } else {
        for (const issue of elig.issues) {
          const i = document.createElement('div');
          i.className = 'note';
          i.style.color = 'var(--amber)';
          i.style.marginBottom = '2px';
          i.textContent = `✗ ${issue}`;
          card.appendChild(i);
        }
      }
      if (!configured) {
        const n = document.createElement('div');
        n.className = 'note';
        n.textContent = 'not configured — set GUMROAD_ACCESS_TOKEN in ~/.alien-factory/worker.env and restart the worker';
        card.appendChild(n);
      }
      const row = document.createElement('div');
      row.className = 'btnrow';
      const dry = document.createElement('button');
      dry.className = 'btn';
      dry.textContent = '[ dry run ]';
      dry.addEventListener('click', () => this.net.send({ type: 'shipGumroad', sku: a.sku, dryRun: true }));
      const ship = document.createElement('button');
      ship.className = 'btn';
      ship.textContent = s.config.gumroad.autoPublish ? '[ ship + publish ]' : '[ ship as draft ]';
      ship.disabled = !configured || !elig.ok || g?.status === 'building' || g?.status === 'uploading';
      ship.addEventListener('click', () => this.net.send({ type: 'shipGumroad', sku: a.sku }));
      row.append(dry, ship);
      if (g?.status === 'draft' && g.productId) {
        const pub = document.createElement('button');
        pub.className = 'btn go';
        pub.textContent = '[ publish ]';
        pub.disabled = !configured;
        pub.addEventListener('click', () => this.net.send({ type: 'publishGumroad', sku: a.sku }));
        row.appendChild(pub);
      }
      if (g?.productId) {
        const img = document.createElement('button');
        img.className = 'btn';
        img.textContent = '[ add images ]';
        img.disabled = !configured;
        img.title = 'attach kit cover/thumbnail/gallery/gif via signed relay urls';
        img.addEventListener('click', () => this.net.send({ type: 'attachGumroadImages', sku: a.sku }));
        row.appendChild(img);
      }
      if (canClearGumroad(a)) {
        const clr = document.createElement('button');
        clr.className = 'btn';
        clr.textContent = '[ clear ]';
        clr.title = 'drop this failed gumroad record (local only — never touches gumroad)';
        clr.addEventListener('click', () => this.net.send({ type: 'clearGumroad', sku: a.sku }));
        row.appendChild(clr);
      }
      card.appendChild(row);
      if (g?.images) {
        const im = document.createElement('div');
        im.className = 'note';
        im.textContent = `images: ${g.images.covers} cover(s)${g.images.thumbnail ? ' + thumbnail' : ''} · ${new Date(g.images.at).toLocaleString()}`;
        card.appendChild(im);
      }
      if (g?.imagesError) {
        const im = document.createElement('div');
        im.className = 'note';
        im.style.color = 'var(--amber)';
        im.textContent = `⚠ images: ${g.imagesError}`;
        card.appendChild(im);
      }
      if (g?.error && (g.status === 'error' || elig.ok)) {
        const e = document.createElement('div');
        e.className = 'note';
        e.style.color = 'var(--amber)';
        e.textContent = `⚠ ${g.error}`;
        card.appendChild(e);
      }
      if (g?.plan) {
        const det = document.createElement('details');
        const sum = document.createElement('summary');
        sum.textContent = 'last dry-run request plan';
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(g.plan, null, 2);
        det.append(sum, pre);
        card.appendChild(det);
      }
    } else {
      // not listed and never shipped — explain why there's no ship button
      const why = document.createElement('div');
      why.className = 'note';
      why.style.color = 'var(--amber)';
      const lastFail =
        IN_PIPELINE.has(a.status) && a.inspection?.verdict === 'FAIL'
          ? ` · last inspection ${a.inspection.score}/10 FAIL`
          : '';
      why.textContent =
        a.status === 'failed' || a.status === 'scrapped'
          ? `✗ ${a.status} — can't be shipped${lastFail}`
          : `✗ not ready — still ${a.status}; ships once it passes inspection and is packaged (listed)${lastFail}`;
      card.appendChild(why);
    }

    // links — one per line; kit art is synced to the relay, zip stays on the Mac
    if (g && g.status !== 'none') {
      const links = document.createElement('div');
      links.className = 'shopline';
      for (const [label, href] of [
        ['gumroad product', g.shortUrl],
        ['edit in gumroad', g.editUrl],
        ['kit/cover.png', `/files/assets/${a.sku}/kit/cover.png`],
        ['kit/thumbnail.png', `/files/assets/${a.sku}/kit/thumbnail.png`],
      ] as const) {
        if (!href) continue;
        const l = document.createElement('a');
        l.href = href;
        l.target = '_blank';
        l.rel = 'noopener';
        l.textContent = `→ ${label}`;
        links.appendChild(l);
      }
      if (links.childElementCount) card.appendChild(links);
    }
    b.appendChild(card);
  }

  private renderShop(s: StateMessage): void {
    this.head('SHOP — GUMROAD', 'gated · draft by default · runs on the mac worker');
    const b = this.body();
    const configured = s.channels?.gumroad?.configured === true;
    const st = document.createElement('div');
    st.className = 'note';
    st.textContent = configured
      ? '✓ configured — GUMROAD_ACCESS_TOKEN is set on the worker'
      : 'not configured — set GUMROAD_ACCESS_TOKEN in ~/.alien-factory/worker.env and restart the worker';
    if (!configured) st.style.color = 'var(--amber)';
    b.appendChild(st);

    // config editor → setGumroadConfig
    const card = document.createElement('div');
    card.className = 'acard';
    card.appendChild(Object.assign(document.createElement('div'), { innerHTML: '<b>gate</b>' }));
    const g = s.config.gumroad;
    const inputs: Record<string, HTMLInputElement> = {};
    const field = (label: string, key: string, type: 'number' | 'checkbox', val: number | boolean): void => {
      const row = document.createElement('div');
      row.className = 'kv';
      const k = document.createElement('span');
      k.textContent = label;
      const inp = document.createElement('input');
      inp.type = type;
      if (type === 'checkbox') inp.checked = val as boolean;
      else {
        inp.value = String(val);
        inp.min = '1';
        inp.max = key === 'minScore' ? '10' : '20';
        inp.style.width = '4em';
      }
      inputs[key] = inp;
      row.append(k, inp);
      card.appendChild(row);
    };
    field('min inspection score', 'minScore', 'number', g.minScore);
    field('packs only', 'packsOnly', 'checkbox', g.packsOnly);
    field('max drafts / day', 'maxDraftsPerDay', 'number', g.maxDraftsPerDay);
    field('auto-publish (skip draft)', 'autoPublish', 'checkbox', g.autoPublish);
    const save = document.createElement('button');
    save.className = 'btn';
    save.textContent = '[ save ]';
    save.addEventListener('click', () =>
      this.net.send({
        type: 'setGumroadConfig',
        config: {
          minScore: Number(inputs.minScore.value) || g.minScore,
          packsOnly: inputs.packsOnly.checked,
          maxDraftsPerDay: Number(inputs.maxDraftsPerDay.value) || g.maxDraftsPerDay,
          autoPublish: inputs.autoPublish.checked,
        },
      }),
    );
    card.appendChild(save);
    b.appendChild(card);

    const n = document.createElement('div');
    n.className = 'note';
    n.textContent = 'each ship builds a kit (zip, readme, license, cover, thumbnail, gallery, gif) on the worker, uploads it, creates a draft with a download page and attaches the images. nothing ships without clicking it here.';
    b.appendChild(n);

    // bulk actions — every asset still passes the full per-asset gate
    const bulkRunning = s.channels?.gumroad?.bulkRunning === true;
    const shippedToday = this.shippedToday(s);
    const eligible = s.assets.filter((a) =>
      shipEligibility(a, metaFor(a.sku) ?? undefined, s.config.gumroad, shippedToday).ok);
    const capNow = Math.max(0, s.config.gumroad.maxDraftsPerDay - shippedToday);
    const drafts = s.assets.filter(
      (a) => a.channels?.gumroad?.status === 'draft' && a.channels.gumroad.productId && !a.channels.gumroad.error,
    );
    const bulk = document.createElement('div');
    bulk.className = 'acard';
    bulk.appendChild(Object.assign(document.createElement('div'), { innerHTML: '<b>bulk</b>' }));
    const capNote =
      capNow < eligible.length
        ? `\n\ndaily cap allows ${capNow} today — raise 'max drafts / day' above to ship more`
        : '';
    const mkBtn = (
      label: string,
      count: number,
      msg: ClientMessage,
      extra = '',
    ): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = label;
      btn.disabled = !configured || count === 0 || bulkRunning;
      btn.addEventListener('click', () => {
        if (confirm(`${label}\n\n${extra}${capNote}`.trim())) this.net.send(msg);
      });
      return btn;
    };
    const brow = document.createElement('div');
    brow.className = 'btnrow';
    brow.append(
      mkBtn(
        `[ ship all eligible (${eligible.length}) ]`,
        eligible.length,
        { type: 'shipAllGumroad', publish: false },
        `skus: ${eligible.map((a) => a.sku).join(', ')}`,
      ),
      mkBtn(
        `[ ship + publish all (${eligible.length}) ]`,
        eligible.length,
        { type: 'shipAllGumroad', publish: true },
        `skus: ${eligible.map((a) => a.sku).join(', ')}\n\nthey go LIVE for sale immediately`,
      ),
      mkBtn(
        `[ publish all drafts (${drafts.length}) ]`,
        drafts.length,
        { type: 'publishAllGumroad' },
        `skus: ${drafts.map((a) => a.sku).join(', ')}`,
      ),
    );
    bulk.appendChild(brow);
    if (bulkRunning) {
      const run = document.createElement('div');
      run.className = 'note';
      run.textContent = 'bulk run in progress…';
      bulk.appendChild(run);
    }
    b.appendChild(bulk);

    const skuLink = (a: Asset): HTMLAnchorElement => {
      const k = document.createElement('a');
      k.textContent = a.sku;
      k.href = '#';
      k.addEventListener('click', (e) => {
        e.preventDefault();
        this.open({ type: 'asset', id: a.sku });
      });
      return k;
    };

    // products that exist on gumroad (draft or published)
    const live = s.assets.filter((a) => a.channels?.gumroad?.productId);
    const h = document.createElement('div');
    h.className = 'sec';
    h.textContent = `on gumroad (${live.length}) `;
    const refresh = document.createElement('button');
    refresh.className = 'btn';
    refresh.textContent = '[ refresh ]';
    refresh.disabled = !configured;
    refresh.title = 're-poll live draft/published status from gumroad';
    refresh.addEventListener('click', () => this.net.send({ type: 'refreshGumroad' }));
    h.appendChild(refresh);
    b.appendChild(h);
    if (!live.length) {
      const none = document.createElement('div');
      none.className = 'note';
      none.textContent = 'nothing yet — ship from a listed asset\'s drawer';
      b.appendChild(none);
    }
    for (const a of live) {
      const row = document.createElement('div');
      row.className = 'kv';
      const v = document.createElement('span');
      const gg = a.channels!.gumroad!;
      v.textContent = gg.status + (gg.shortUrl ? '' : gg.error ? ` — ${gg.error.slice(0, 60)}` : '');
      if (gg.shortUrl) {
        const l = document.createElement('a');
        l.href = gg.shortUrl;
        l.target = '_blank';
        l.rel = 'noopener';
        l.textContent = ' ↗';
        v.appendChild(l);
      }
      row.append(skuLink(a), v);
      b.appendChild(row);
    }

    // failed local records — clearable (local only)
    const failed = s.assets.filter((a) => canClearGumroad(a) && a.channels!.gumroad!.status !== 'none');
    if (failed.length) {
      const fh = document.createElement('div');
      fh.className = 'sec';
      fh.textContent = `failed (${failed.length})`;
      b.appendChild(fh);
      for (const a of failed) {
        const row = document.createElement('div');
        row.className = 'kv';
        const gg = a.channels!.gumroad!;
        const v = document.createElement('span');
        v.textContent = gg.status + (gg.error ? ` — ${gg.error.slice(0, 60)}` : '');
        const clr = document.createElement('button');
        clr.className = 'btn';
        clr.textContent = '[ clear ]';
        clr.addEventListener('click', () => this.net.send({ type: 'clearGumroad', sku: a.sku }));
        row.append(skuLink(a), v, clr);
        b.appendChild(row);
      }
    }
  }

  // ---- gallery --------------------------------------------------------------------

  private renderGallery(s: StateMessage): void {
    const gh = this.head('GALLERY', `${s.assets.length} assets`, { label: '[ open folder ]', fn: () => reveal({ dir: 'assets' }) });
    {
      const count = unshippableAssets(s).length;
      const arch = document.createElement('button');
      arch.className = 'btn';
      arch.textContent = '[ archive unshippable ]';
      arch.title = 'move every failed/scrapped/permanently-unshippable asset to archive/ (never touches gumroad)';
      arch.addEventListener('click', () => {
        if (confirm(`archive ${count} unshippable asset(s)? folders move to archive/ and the assets leave the factory`)) {
          this.net.send({ type: 'archiveUnshippable' });
        }
      });
      gh.insertBefore(arch, gh.lastChild);
    }
    const b = this.body();
    const sel = document.createElement('select');
    sel.className = 'gfilter';
    for (const f of ['', 'queued', 'forging', 'inspecting', 'on_conveyor', 'packing', 'listed', 'scrapped', 'failed']) {
      const o = document.createElement('option');
      o.value = f;
      o.textContent = f || 'all statuses';
      sel.appendChild(o);
    }
    sel.value = this.galleryFilter;
    sel.addEventListener('change', () => {
      this.galleryFilter = sel.value;
      this.render();
    });
    b.appendChild(sel);
    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const a of s.assets) {
      if (this.galleryFilter && a.status !== this.galleryFilter) continue;
      const cell = document.createElement('div');
      cell.className = 'gcell';
      this.thumb(cell, a, 4);
      const cap = document.createElement('div');
      cap.className = 'gcap';
      cap.textContent = a.kind === 'pack' ? `${a.sku} ×${a.items ?? '?'}` : a.sku;
      const st = document.createElement('div');
      st.className = `gstat st-${a.status}`;
      st.textContent = a.status;
      cell.append(cap, st);
      cell.addEventListener('click', () => this.open({ type: 'asset', id: a.sku }));
      grid.appendChild(cell);
    }
    b.appendChild(grid);
  }
}
