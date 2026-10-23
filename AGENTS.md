# AGENTS.md — Alien Factory

Context for AI agents working in this repo.

**This repo is public.** Never commit secrets, API keys, `.env` files,
internal/company material, or anything under `~/.alien-factory` — all
runtime configuration is via environment variables (`PORT`,
`NODE_ENV`, `ALIEN_FACTORY_PASSWORD`, `ALIEN_FACTORY_DATA_DIR`,
`ALIEN_FACTORY_DIR`, `ALIEN_FACTORY_NO_DEVIN`, `ALIEN_FACTORY_AUTOSCAN`).

## What this is

A Factorio-style, top-down pixel-art factory rendered in the browser. The
small aliens on the floor are real Devin CLI agent sessions (`devin acp`,
Agent Client Protocol — JSON-RPC 2.0, one message per line over stdio) that
produce 2D pixel-game assets: each asset is a code-generated PNG sprite
sheet — or a multi-sprite **pack** (4–48 items, each 1–8 frames at one
shared 16/32 size) — written by a "smith" agent, checked by the server,
QA'd by an "inspector" agent, approved or rejected by the big "Overlord"
on the dais, packaged by a "packer" and then sold on a MOCK market (pure
code, seeded — no real money, no real storefront).

The player is a factory manager: start/pause/stop the shift, send directives
to the Overlord, inspect assets, browse the gallery and watch the market.

## Layout

npm workspaces monorepo, strict TypeScript everywhere, no build step on the
server:

```
shared/protocol.ts    # client↔server WS message + state types (relative imports)
server/               # tsx (dev) / tsx watch (dev:watch), node:http + ws :4790
  src/acp.ts          # AcpClient: one `devin acp` child, lazy spawn + restart,
                      # pending-map JSON-RPC, authenticate, sessions, permissions
                      # ALIEN_FACTORY_NO_DEVIN=1 → refuses to spawn entirely
  src/factory.ts      # FactoryManager: agent roster, job dispatcher, the
                      # overlord turn loop, auto-approver, state.json persistence
  src/market.ts       # seeded mock market: tag demand random walk, competitor
                      # listings, sales sim, reports/market-latest.md
  src/itch.ts         # itch.io research (READ ONLY): polite feed fetcher,
                      # cell parser, snapshot analyser, reports/itch-latest.md
  src/channels/gumroad.ts # the ONLY real storefront: kit → multipart upload →
                      # draft product → optional publish → covers/thumbnail
                      # via signed public relay URLs (fetch injected)
  src/kit.ts          # zero-dep kit builder: zip writer (DEFLATE+CRC32),
                      # README/LICENSE.txt, cover.png 1280x720, thumbnail.png
                      # 600x600, gallery-1.png + animated preview.gif
  src/png.ts          # server PNG codec + pixel buffer + 5x7 bitmap font
  src/gif.ts          # GIF89a encoder (global palette, LZW, NETSCAPE loop)
  src/parse.ts        # pure helpers: section/fenced-json parsers, inspection
                      # parser, permission path guard, meta.json checks
  src/prompts.ts      # every agent prompt template (structured block at the end)
  src/seed.ts         # creates ~/.alien-factory/factory: lib/pix.mjs, STYLE.md,
                      # starter assets + the examples/potion-pack reference
                      # (gen.mjs run at seed time; pix.mjs re-written on diff)
  src/config.ts       # ~/.alien-factory/config.json + paths
  src/parse.test.ts   # node:test suite → npm test -w server
  src/main.ts         # http + ws, /files static serving, broadcast throttle
client/               # Vite + TS, zero runtime deps
  src/main.ts         # loop, mouse input, selection, DOM nameplates
  src/floor.ts        # layout, stations, belts, dais, portal, hit-testing
  src/aliens.ts       # alien sprites usage + cosmetic movement (waypoints)
  src/assets.ts       # /files sheet.png + meta.json cache, animated frames
  src/sprites.ts      # procedural sprites: aliens, overlord, bubbles, crates
  src/hud.ts          # top bar (status/store/views/system groups, contextual
                      # shift controls, live gumroad revenue) + ticker; phones
                      # get a [ ≡ ] group sheet + bottom view tab bar
  src/drawers.ts      # right-side drawer: overlord/alien/asset/market/gallery
  src/demo.ts         # ?demo — fake animated state, no server needed
  src/pix.ts          # pixel buffer painter (mulberry32, hashString, Sprite)
  src/md.ts           # tiny safe markdown renderer (transcript log)
  src/net.ts          # reconnecting WebSocket
~/.alien-factory/factory/   # the sandbox agents actually work in
  lib/pix.mjs         # zero-dep ESM pixel canvas + PNG emitter (seeded,
                      # re-written whenever the embedded lib changes).
                      # emit() = one sprite; emitPack() = a 4–48-item pack:
                      # items/<name>.png strips + sheet.png atlas (one row
                      # per item) + atlas.json + preview.png contact sheet
                      # + meta.json {kind:'pack', perItem, duplicateItems}
  STYLE.md            # house rules handed to every prompt
  archive/<sku>/      # archived assets (moved here + dropped from state,
                      # archived.json explains why; gumroad products are never archived)
  assets/<sku>/       # gen.mjs + sheet.png + preview.png + meta.json + listing.json
                      # + kit/ (<sku>.zip, README/LICENSE.txt, cover.png,
                      # thumbnail.png, gallery-1.png, preview.gif) once the
                      # Gumroad channel builds it
  examples/<name>/    # seeded references: slime, carrot, potion + potion-pack
                      # (the PARAMETRIC pack reference — palette + param loop)
  reports/            # market-latest.md, trends-<n>.md (written by the scout)
```

## Modes

- **`mode: 'research'` (default)** — the scout researches the REAL itch.io
  game-assets market. Shift start (and every `itchScanMinutes` while running)
  → polite feed scan → `reports/itch-latest.md` → scout writes
  `reports/trends-<n>.md` + a `## Demand` block stored as `opportunities` on
  the trend report. No candidates, no production, the mock market is idle.
  The scout may fetch up to 5 itch.io listing pages; the permission layer
  rejects tool calls containing non-itch.io URLs in research mode.
- **`mode: 'full'`** — the produce-and-sell pipeline below; with
  `marketSource: 'itch'` the scout reads `reports/itch-latest.md` instead
  of the mock report. The packer "lists" on the in-memory mock market;
  real publishing exists ONLY through the gated **Gumroad channel**
  (`server/src/channels/gumroad.ts`): explicit click in the SHOP section
  (per asset, or the bulk ship/publish buttons — each asset still passes
  the full gate and the daily draft cap), draft product by default,
  `autoPublish` opt-in, strict
  ship gate (`shared/shop.ts`), daily draft cap, no duplicate shipment.
  SHOP also offers `[ clear ]` (drops a FAILED local record only — never
  deletes anything on Gumroad, and refuses records with a productId) and
  `[ refresh ]` (re-polls live draft/published status via GET /products).
  One GET /products also refreshes store-wide `GumroadStats`
  (`channels.gumroad.stats`) — auto-polled ~5 s after boot and every 15 min
  while a token is set. The HUD revenue pill shows these live totals
  (mock revenue is no longer on the HUD; `salesCount`/`revenueUsdCents`
  are null — never guessed — when the token lacks `view_sales`).
  No other marketplace/upload code may be added without an explicit
  future decision — and never to itch.io (research stays read-only).

itch.io politeness (itch.ts): feeds are `game-assets/{top-sellers|top-rated|
new-and-popular|newest}[/tag-x]` (validated), sequential requests ≥1.5 s
apart, 15 s timeout, honest UA, raw JSON cached 50 min under
`factory/market/itch/raw/`, snapshots kept 30 under `market/itch/snapshots/`.
Full scans ≥30 min apart; `[ scan now ]` ≥5 min. robots.txt is respected —
never touch `/search` (browse feeds only). The fetcher is `fetch` + regex;
no publishing code exists.

## The flow (full mode)

1. Shift start → market report written → scout job queued (re-scouts when
   the last trend report is >10 market ticks old AND no candidates pending).
2. Scout reads `reports/market-latest.md`, writes `reports/trends-<n>.md`,
   and ends with `## Demand` + a fenced json array of 3-6 proposals
   `{title, kind?, items?, itemNames?, tags, size, frames, why, demand,
   variantOf?}` — `kind:'pack'` + `items` 4–48 proposes a multi-sprite pack;
   these become `pending` **candidates** (`c1`, `c2`, …).
3. The Overlord takes a turn when candidates are pending or a player
   directive arrives — rate-limited to `maxOverlordTurnsPerHour`. It ends
   with `## Decisions` + fenced json
   `[{id, approve, reason, smith, brief, kind?, items?, itemNames?}]`, one
   per pending candidate (it may re-scope sprite↔pack and item counts;
   orders >48 items must be split into volumes or declined).
   Approvals are capped at `maxApprovalsPerTurn` (extras → declined "over
   capacity"); a missing/invalid `smith` falls back to the smith with the
   shortest forge queue. Approving creates the **asset** (`queued`) and a
   forge job **pinned** to that smith.
4. The smith writes `assets/<sku>/gen.mjs`; the server re-runs it and
   checks meta.json (sprites: size, frames, ≤16 colours, opaqueRatio, no
   empty/identical frames; packs: `kind:'pack'`, ≥90% of ordered items and
   ≤48, per-item 1–8 frames + opaqueRatio, ≤32 colours pack-wide, no
   empty/duplicate items). One in-session retry, then `failed`.
5. Inspector looks at `preview.png`, ends with `## Inspection` /
   `Verdict: PASS|FAIL` / `Score:` / `Notes:`. PASS → `on_conveyor` + pack
   job. FAIL once → back to `queued` + a forge job pinned to the SAME
   smith; FAIL twice → `scrapped`.
6. Packer (FIFO off the conveyor) writes `listing.json` → `listed` on the
   mock market.

Asset statuses: `queued → forging → inspecting → on_conveyor → packing →
listed` (plus `scrapped`/`failed` — with `autoArchiveFailed` on, those are
moved to `archive/` as soon as the job ends; `[ archive ]` /
`[ archive unshippable ]` in the UI do the same by hand — local only,
never deletes anything on Gumroad). The output conveyor only ever carries
`on_conveyor`+`packing` items. `examples/` holds the starter
generators (style references, not catalog items — `potion-pack` is the
pack reference); `stateVersion: 2` wipes
pipeline data from the old design on load.

## Conventions

- **Pixel look**: internal canvas is 480x270, upscaled with
  `image-rendering: pixelated`. All art is procedural and seeded — no image
  assets except the generated `sheet.png`s from `/files/...`, no smoothing,
  no web fonts (`Courier New` only).
- **Mouse-only RTS**: no player character. Hover highlights + nameplates,
  click selects (pulsing brackets) and opens the drawer, Esc closes.
- **ACP mode rule**: agents must be able to write — never select the `ask`
  mode config option (use `accept-edits` if the session defaults to ask).
- **Auto-approver**: `session/request_permission` is answered automatically.
  Paths collected from `toolCall.locations[].path` and path-shaped rawInput
  fields must ALL resolve inside `FACTORY_DIR`, else the `reject*` option is
  picked (else cancelled). Limit: tool calls that carry no file locations —
  e.g. `run("rm -rf ...")` — are allowed since no path exists to check; the
  agent's session cwd is the factory and prompts keep work inside it, but
  the guard cannot see inside opaque shell commands. Documented risk.
- **Worker sessions are recycled** per role after `sessionJobLimit` jobs
  (scout 1, smith 1, inspector 4, packer 6) so the cheap models keep small
  contexts; the overlord keeps its session. On server restart all
  sessionIds are dropped and active jobs requeue.
- **Token meter**: every `usage_update` is appended to
  `logs/usage.jsonl` (rotated at 20 MB) and accumulated into `state.usage`
  byRole/byModel day/hour/total buckets — approximate (1 update = 1
  request). `config.prices` maps model ids to USD/1M rates for cost
  display; `config.dailyTokenCaps` pauses the shift when a day's total
  (cached included) is exceeded.
- Server imports use `.js` extensions (NodeNext); client imports are
  extensionless (bundler resolution). Both import shared types from
  `../shared/protocol` (`.js` on the server).

## Config

`~/.alien-factory/config.json`, created on first run and merged with
defaults:

```json
{
  "models": {
    "overlord": "claude-sonnet-5-5-medium",
    "scout": "claude-haiku-5-5-medium",
    "smith": "swe-2-medium-lightning",
    "inspector": "claude-haiku-5-5-low",
    "packer": "swe-1-6"
  },
  "smiths": 3,
  "maxOverlordTurnsPerHour": 6,
  "maxApprovalsPerTurn": 4,
  "sessionJobLimit": { "scout": 1, "smith": 1, "inspector": 4, "packer": 6 },
  "rescoutHours": 6,
  "usdToZar": 18.5,
  "prices": {},
  "dailyTokenCaps": null,
  "mode": "research",
  "marketSource": "itch",
  "gumroad": { "minScore": 7, "packsOnly": true, "maxDraftsPerDay": 3, "autoPublish": false },
  "autoArchiveFailed": true,
  "itchScanMinutes": 60,
  "itchFeeds": ["game-assets/top-sellers/tag-pixel-art:2", "..."]
}
```

Model ids are ACP `model` config values, set per role via `[ models ]` or
`setModels { role, model }`; if a configured id isn't offered, the session
default is used. `setCaps { overlord?, workers? }` adjusts daily caps.
Model ids come and go with Devin releases — when a configured id is not
offered, the agent falls back to the session default and gets a
`modelMismatch` flag (amber warning in the MODELS drawer and the agent's
drawer, plus a factory event); check `[ models ]` for warnings.

Model ids are ACP `model` config values; if a configured id isn't offered,
the session default is used. Data dir `~/.alien-factory/`: `state.json`,
`config.json`, `logs/acp.log`, `probe/`, `factory/`. `ALIEN_FACTORY_DIR`
env var overrides the factory dir (used by tests/seeding).
`ALIEN_FACTORY_DATA_DIR` overrides the whole data root (Railway: `/data`).

## Worker ⇄ relay deployment

Two roles by env (see README for the diagram/setup):

- **Relay** (`ALIEN_FACTORY_WORKER_KEY`, prod): `/worker` ws endpoint,
  bearer-auth, single worker slot, `maxPayload` 4 MB. Browser state =
  `mergeRelayState()` (link.ts): worker's factory + relay's itch +
  `worker:{connected,lastSeenAt}`; persisted to `worker-state.json`.
  Forwardable commands are allowlisted in `FORWARDABLE` (link.ts);
  `signIn` is never forwarded, `scanNow` runs on the relay.
- **Worker** (`ALIEN_FACTORY_RELAY_URL` + key): `worker-link.ts` — outbound
  ws only, backoff 1s→30s+jitter, ping/25s, state push ≤2/s, asset files
  (allowlist `ASSET_FILES`, ≤2 MB each) pushed on change/welcome-diff,
  `remote: <cmd>` events; self-scans itch only if the relay is silent >2h.
- **Public kit images**: `GET /public/kit/<sku>/<file>?exp&sig` is the ONLY
  unauthenticated route — `file` ∈ `PUBLIC_KIT_FILES` (the five kit images),
  `sig` = HMAC-SHA256(worker key, `kit:<sku>:<file>:<exp>`), ≤48 h. It
  exists so Gumroad's covers/thumbnail fetchers can pull images; the worker
  signs URLs and posts them (`channels/gumroad.ts` `attachGumroadImages`).
- `scripts/run-worker.mjs` loads `~/.alien-factory/worker.env` (never logs
  values); `new-worker-key.mjs`, `install-launchagent.sh [--load]`,
  `uninstall-launchagent.sh`, `worker-status.sh`.

## Verify

```bash
npm run typecheck        # tsc --noEmit in both workspaces
npm test -w server       # parse.test.ts (node:test via tsx)
npm run dev              # server :4790 + vite :5173
npm run build -w client  # vite build
# http://localhost:5173/?demo — animated floor without the server/Devin
```

Live ACP needs a signed-in Devin CLI (`devin acp` ships with Devin Desktop);
the server attempts `authenticate` on startup but it is non-fatal — the
factory shows "Devin offline" and http stays up. WARNING: each `devin acp`
spawn triggers a BROWSER sign-in when it has no credentials (the ACP host
supplies them; `devin auth login` / env keys don't count). That's why `dev`
is not a watch command — `dev:watch` costs a sign-in per restart. Use
`ALIEN_FACTORY_NO_DEVIN=1 npm run dev -w server` for checks that must not
spawn Devin at all. `POST /api/reveal {sku|dir}` opens a factory folder in
Finder (macOS only, paths are server-side only).
