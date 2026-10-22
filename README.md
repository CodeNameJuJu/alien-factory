# Alien Factory

A Factorio-style pixel-art factory where the workers are real Devin agent
sessions (over `devin acp`). Small aliens scout a mock market, forge sprite
sheets as code (`assets/<sku>/gen.mjs` → PNG via a tiny pixel lib), QA them,
and ship the approved ones down a conveyor into the market portal.

Watch the floor, press **Start** to run a shift, click aliens / crates /
the Overlord's dais / the scout's radar dish for details, and send the
Overlord directives like "more slime variants". Everything it sells is on a
**mock market** — nothing is ever published anywhere real.

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
makes the scout read the itch report instead of the mock one. There is no
publishing code — the packer "lists" on the in-memory mock market only.

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

## Autonomy & safety

Tool-call permission requests are auto-approved **only** when every path the
tool reports resolves inside `~/.alien-factory/factory` — anything outside
is refused. Caveat: a shell command that carries no file locations can't be
path-checked and is allowed (see AGENTS.md).

## Config & data

`~/.alien-factory/config.json` — models, smith count, turn/order/batch
limits, `usdToZar` for the mock revenue display, `mode`, `marketSource`,
`itchScanMinutes`, `itchFeeds`. State lives in
`~/.alien-factory/state.json`; the factory sandbox (assets, reports, the
`pix.mjs` lib, `STYLE.md`) in `~/.alien-factory/factory`.

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
