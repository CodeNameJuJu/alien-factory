# Alien Factory

A Factorio-style pixel-art factory where the workers are real Devin agent
sessions (over `devin acp`). Small aliens scout a mock market, forge sprite
sheets as code (`assets/<sku>/gen.mjs` → PNG via a tiny pixel lib), QA them,
and ship the approved ones down a conveyor into the market portal.

Watch the floor, press **Start** to run a shift, click aliens / crates /
the Overlord's dais / the scout's radar dish for details, and send the
Overlord directives like "more slime variants". Everything it sells is on a
**mock market** — nothing is ever published anywhere real unless you
explicitly ship a listed asset through the gated **Gumroad channel**
(below — draft product by default, one click per asset).

## Research mode (default)

With `mode: "research"` the factory is a **read-only market radar**: it
politely scrapes itch.io game-asset browse feeds (sequential requests ≥1.5 s
apart, cached 50 min, full scans ≥30 min apart, `robots.txt` respected —
browse pages only, never `/search`), analyses themes/prices/movers into
`factory/reports/itch-latest.md`, and the scout turns that into trend
reports with opportunities (`?` → `[ trends ]` drawer, or click the radar
dish). Snapshots live in `factory/market/itch/snapshots/`. In research mode
the permission layer also rejects any tool call that would fetch a
non-itch.io URL.

`mode: "full"` runs the produce-and-sell pipeline; `marketSource: "itch"`
makes the scout read the itch report instead of the mock one. The packer
"lists" on the in-memory mock market; the only real storefront is the
Gumroad channel below.

## Selling for real: the Gumroad channel (off by default)

The ONE real exit off the mock market — entirely manual, per asset, and it
only ever runs on the Mac worker (never on the Railway relay).

**Setup (once):**

1. Create a Gumroad account and connect your bank
   (`gumroad.com` → settings → payout).
2. Gumroad settings → **Advanced → Apps → "Register application"** (the
   redirect URI can be anything, e.g. `http://localhost`), then
   **Generate access token** with the **`edit_products`** scope.
3. Put it in `~/.alien-factory/worker.env` on the Mac:
   `GUMROAD_ACCESS_TOKEN=...` (gitignored, never leaves the worker — the
   dashboard only sees `channels.gumroad.configured: true/false`).
4. Restart the worker (`npm run start:worker`). The `[ shop ]` drawer shows
   "✓ configured".

**Shipping an asset** — open a *listed* asset's drawer → **SHOP**:

- `[ dry run ]` builds the kit and shows the exact request plan (endpoints,
  params, file size) without touching the network.
- `[ ship as draft ]` uploads `assets/<sku>/kit/<sku>.zip` via Gumroad's
  multipart file API and creates a **draft** product (`published: false`)
  with the packer's title/price, an HTML description (contents + license +
  AI-disclosure line) and tags. `[ publish ]` enables it when you're happy;
  `autoPublish` skips the draft step.
- The gate (`minScore` ≥ inspector score, packs-only, `maxDraftsPerDay`,
  no re-shipping the same sku, listing-vs-contents consistency — e.g. a
  listing claiming "600 items" or "32x32" that doesn't match the files is
  refused) is checked both in the UI and server-side.
- The SHOP drawer's bulk card ships/publishes everything at once —
  `[ ship all eligible ]`, `[ ship + publish all ]`, `[ publish all drafts ]`.
  Every asset still passes the full gate and the daily cap (the run stops
  there with an event saying so).

**What ships**: `kit/<sku>.zip` = `sheet.png` (+ `items/*.png` and
`atlas.json` for packs) + `preview.png` + `README.txt` (contents, sizes,
frames/fps, atlas usage) + `LICENSE.txt` (free for personal & commercial
use, modify freely, no attribution, may not resell the assets themselves;
includes "Made with procedural code written by AI agents and reviewed
before release."). The zip itself stays on the Mac.

**Product images** — the kit also draws `cover.png` (1280×720),
`thumbnail.png` (600×600), `gallery-1.png` (every item large with names)
and `preview.gif` (an animated grid, only when items animate). Gumroad's
covers/thumbnail API only accepts *publicly reachable* URLs, so the relay
exposes exactly one unauthenticated route —
`GET /public/kit/<sku>/<file>?exp&sig` — where `file` is one of those five
names and `sig` is an HMAC-SHA256 of the worker key over
`kit:<sku>:<file>:<exp>`, valid for at most 48 h. After a draft is created
(or via `[ add images ]` on an existing product) the worker signs URLs for
the synced kit files and posts them to `POST /v2/products/:id/covers`
(`preview.gif`, `cover.png`, `gallery-1.png` — first is the main cover) and
`/thumbnail`. Needs the worker linked to the Railway relay
(`ALIEN_FACTORY_RELAY_URL` + `ALIEN_FACTORY_WORKER_KEY`); without a relay
the step is skipped with a note and the draft stays a draft.

## Run

```bash
npm install
npm run dev
```

- Server: <http://localhost:4790> (`/api/state`, `/api/health`,
  `POST /api/reveal`, `/files/<asset files>`, WebSocket `/ws`)
- Client: Vite's dev server — <http://localhost:5173> or the next free port.
  It proxies `/api`, `/files` and `/ws` to 4790.
- <http://localhost:5173/?demo> — animated demo floor, no server or Devin
  sign-in needed.

`npm run dev` runs the server WITHOUT watch on purpose: every `devin acp`
spawn requires its own browser sign-in (ACP hosts must supply credentials —
local `devin auth login` / env keys are ignored by `devin acp`), so each
server restart costs a sign-in. `npm run dev:watch -w server` exists if you
want tsx watch, at a sign-in per restart. `ALIEN_FACTORY_NO_DEVIN=1` runs
the server with the ACP client fully disabled — no spawn, no sign-in — for
testing; the HUD just shows "Devin offline".

## How a shift works

`scout proposes candidates → Overlord approves/declines & assigns smiths →
smiths forge → inspector → output conveyor → packer ships into the portal →
mock market sells.`

The Overlord's turns are rate-limited (`maxOverlordTurnsPerHour`), approve
at most `maxApprovalsPerTurn` candidates each, and fire whenever proposals
are pending or the player sends a directive.

### Sprites and packs

An order is either a single **sprite** (16×16 or 32×32, 1–8 frames, ≤16
colours — `emit()` writes `sheet.png`/`preview.png`/`meta.json`) or a
**pack**: 4–48 small sprites in one asset (`kind: "pack"`, `items`, optional
`itemNames`), each item 1–8 frames at one shared size, ≤32 colours
pack-wide. `emitPack()` writes:

- `items/<name>.png` — one horizontal strip per item
- `sheet.png` — the atlas (one row per item, frames left→right)
- `atlas.json` — `{ size, fps, items: [{ name, x, y, w, h, frames }] }`
- `preview.png` — a contact sheet of every item's first frame
- `meta.json` — `kind: "pack"` + per-item stats (`perItem`, `emptyItems`,
  `duplicateItems`)

Orders bigger than 48 items are split into themed volumes (or declined) by
the Overlord. `examples/potion-pack/` is the seeded reference generator —
12 potions from one palette + a parametric loop; smiths are pointed at it.
On the floor, pack crates wear a `×N` badge and flip through their items;
the asset drawer shows the full item grid.

## Autonomy & safety

Tool-call permission requests are auto-approved **only** when every path the
tool reports resolves inside `~/.alien-factory/factory` — anything outside
is refused. Caveat: a shell command that carries no file locations can't be
path-checked and is allowed (see AGENTS.md).

## Config & data

`~/.alien-factory/config.json` — models, smith count, turn/order/batch
limits, `usdToZar` for the revenue display, `mode`, `marketSource`,
`itchScanMinutes`, `itchFeeds`. State lives in
`~/.alien-factory/state.json`; the factory sandbox (assets, reports, the
`pix.mjs` lib, `STYLE.md`) in `~/.alien-factory/factory`.

## Live architecture: Mac worker ⇄ Railway relay ⇄ your phone/laptop

Agents can only run on the Mac (`devin acp` needs Devin Desktop + a browser
sign-in), so the factory runs there in the background and **streams** to the
public deployment:

```
┌─────────────┐  outbound wss (bearer)  ┌──────────────────┐  wss (cookie)
│  Mac worker │ ──────────────────────▶ │  Railway relay   │ ◀──────────────
│  agents run │  state + asset files    │  viewer + itch   │   phone/laptop
│  here       │ ◀────────────────────── │  scanner         │   browsers
└─────────────┘  commands, itch pushes  └──────────────────┘
```

- **Relay (Railway)**: password-gated dashboard, itch scanner, `/worker`
  endpoint (bearer-auth, one worker at a time). Browsers see the worker's
  live state merged with the relay's itch analysis; agent commands
  (start/pause/stop/directive/models/mode/cancel) are forwarded to the
  worker. If the worker is offline the last known state stays visible
  (persisted in `worker-state.json` on the volume).
- **Worker (Mac)**: the real factory — agents, asset forge, mock market.
  Outbound connection only; its own dashboard stays on `127.0.0.1`. Asset
  files (sheet/preview/meta/listing/gen.mjs) are pushed to the relay so
  `/files/...` works for remote browsers.

### Setup

1. Deploy to Railway (below) **and** set `ALIEN_FACTORY_WORKER_KEY` there.
2. On the Mac: `node scripts/new-worker-key.mjs --relay wss://<your-app>.up.railway.app/worker`
   — generates the key into `~/.alien-factory/worker.env` (never printed).
   Put the **same value** into Railway's `ALIEN_FACTORY_WORKER_KEY`.
3. Run it: `npm run start:worker` (or install the LaunchAgent:
   `scripts/install-launchagent.sh`, then `--load` to actually start;
   `scripts/worker-status.sh` / `scripts/uninstall-launchagent.sh`).

Caveats: agents only run while the Mac is awake (`caffeinate` blocks idle
sleep; a closed laptop lid on battery still sleeps). Each worker start costs
one Devin browser sign-in (usually instant — cached). KeepAlive restarts the
worker after crashes.

## Deploy to Railway (scanner + dashboard)

Railway runs the **itch.io market scanner and the CRT dashboard only** —
`devin acp` can't run there (it needs Devin Desktop + a browser sign-in), so
the image sets `ALIEN_FACTORY_NO_DEVIN=1` and every agent control is
disabled ("agents run on the local Mac"). Agents still run locally against
your own server.

1. Create a Railway project **from the GitHub repo** — `railway.json` builds
   the included `Dockerfile` (multi-stage, `node:22-alpine`, builds the
   client, serves it + the API + the WS from one Node process).
2. Add a **Volume mounted at `/data`** — that's `ALIEN_FACTORY_DATA_DIR`.
   Without it the itch scan history, snapshots and reports reset on every
   deploy.
3. Set **`ALIEN_FACTORY_PASSWORD`** — required in production (the process
   refuses to boot without it). It's the login password AND the session
   HMAC key, so rotating it logs everyone out.
4. Railway assigns `PORT` automatically; the Dockerfile exposes 8080.
   Healthcheck is `GET /api/health` (unauthenticated).
5. Optional: tune `itchScanMinutes` (default 60) via `config.json` on the
   volume — `ALIEN_FACTORY_AUTOSCAN=1` rescans on that cadence from boot.

### Environment variables

| var | default | meaning |
|---|---|---|
| `PORT` | `4790` | http/ws port (Railway sets it) |
| `NODE_ENV` | — | `production` → bind `0.0.0.0`, serve `client/dist`, `Secure` cookies, **password required** |
| `ALIEN_FACTORY_PASSWORD` | — | password-gate every route except `/api/health` + `/login` |
| `ALIEN_FACTORY_DATA_DIR` | `~/.alien-factory` | root for state/config/logs/factory (`/data` in the image) |
| `ALIEN_FACTORY_DIR` | `<data>/factory` | factory sandbox override |
| `ALIEN_FACTORY_NO_DEVIN` | — | `1` → never spawn `devin acp`; agent controls disabled |
| `ALIEN_FACTORY_AUTOSCAN` | — | `1` → itch scan at boot + every `itchScanMinutes` |
| `ALIEN_FACTORY_WORKER_KEY` | — | relay: bearer key for `/worker`; worker: sent upstream |
| `ALIEN_FACTORY_RELAY_URL` | — | worker: `wss://<host>/worker` to stream to (unset = standalone) |
