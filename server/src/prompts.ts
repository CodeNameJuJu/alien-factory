// Prompt templates for the factory crew. Each one ends with the exact
// structured block the server parses out of the reply.
import type { Asset, Candidate, OrderSpec } from '../../shared/protocol.js';

export function scoutPrompt(catalog: string): string {
  return `You are the market scout of a sprite-asset factory. Read \`reports/market-latest.md\` in this directory — it ranks asset tag demand, lists competitor products and our own sales.

Our catalog (sku | tags | units | revenue):
${catalog || '(empty — nothing listed yet)'}

Pick 3-6 market opportunities — ride trending tags, prefer variants of our best sellers (set variantOf to an existing sku) when the market favours them. MULTI-SPRITE PACKS are what sell on real marketplaces: set "kind":"pack" with "items":8-48 (a pack of 8-48 related sprites, each 1-8 frames, one size for the whole pack) and optionally "itemNames" — rather than proposing dozens of single sprites, propose a themed pack. Ideas bigger than 48 items must be split into themed volumes ("RPG Icons Vol.1", "Vol.2", …). Write your analysis to \`reports/trends-<TICK>.md\` (use the current tick number), then END your reply with a short summary plus the structured block:

## Demand
\`\`\`json
[{"title":"<asset name>","kind":"sprite|pack","items":<4-48 when pack>,"itemNames":["<optional item name>"],"tags":["<tag>"],"size":16,"frames":4,"why":"<why it will sell>","demand":<1-10>,"variantOf":"<existing sku or omit>"}]
\`\`\``;
}

/// Scout variant that reads the itch.io research report instead of the mock
/// market's. It may fetch up to 5 itch.io listing pages for a closer look
/// (the permission layer blocks every other host).
export function scoutPromptItch(catalog: string): string {
  return `You are the market scout of a sprite-asset factory. Read \`reports/itch-latest.md\` in this directory — it is fresh research scraped from itch.io's game-asset market: weighted theme scores, movers, price stats and the top-selling pixel-art listings.

Our catalog (sku | tags | units | revenue):
${catalog || '(empty — nothing listed yet)'}

You MAY open up to 5 itch.io listing pages (only https:// itch.io / *.itch.io URLs from that report) with your web tool to look closer at promising packs — do not fetch anything else. Write your analysis to \`reports/trends-<TICK>.md\` (use the current market tick), then END your reply with a summary plus the structured block:

## Trend report
<markdown: what's selling, what's rising, price bands, gaps/opportunities we could fill with 16x16/32x32 code-generated sprites, saturation risks>

## Demand
\`\`\`json
[{"title":"<asset name>","kind":"sprite|pack","items":<4-48 when pack>,"itemNames":["<optional item name>"],"tags":["<tag>"],"size":16,"frames":4,"why":"<why it will sell>","demand":<1-10>,"priceBand":"$X-Y","evidence":["<itch.io url>"],"variantOf":"<existing sku or omit>"}]
\`\`\`
3-6 opportunities. MULTI-SPRITE PACKS are what sell on itch — prefer "kind":"pack" with "items":8-48 (each item is its own small sprite, 1-8 frames, one size for the whole pack) and optional "itemNames". Ideas bigger than 48 items must be split into themed volumes.`;
}

export function overlordPrompt(args: {
  trendReport: string;
  catalog: string;
  candidates: Candidate[];
  smithQueues: { id: string; queue: number }[];
  pendingDirectives: string[];
  maxApprovals: number;
  /// titles already approved/in progress or listed — duplicates get declined
  inProgress: string[];
}): string {
  const pending = args.candidates
    .map(
      (c) =>
        `- ${c.id} "${c.title}" [${c.tags.join(', ')}] ` +
        (c.kind === 'pack' ? `PACK of ${c.items ?? '?'} items ` : '') +
        `${c.size}px×${c.frames}f ` +
        `demand ${c.demand}/10${c.variantOf ? ` variant of ${c.variantOf}` : ''} — ${c.why}`,
    )
    .join('\n');
  const smiths = args.smithQueues.map((s) => `- ${s.id}: ${s.queue} job(s) in queue`).join('\n');
  const directives = args.pendingDirectives.map((d) => `- ${d}`).join('\n');
  return `You are the Overlord of an alien factory that produces 2D pixel-game sprite assets and sells them on a mock market. The scout has proposed new assets; you decide which get forged and which smith makes each.

## Latest trend report
${args.trendReport || '(none yet)'}

## Catalog (sku | tags | status | units | revenue)
${args.catalog || '(empty)'}

## Pending proposals
${pending || '(none)'}

## Smiths and their queues
${smiths}

## Standing style rules (STYLE.md)
Two asset kinds: SPRITES (16x16 or 32x32, 1-8 frames, ≤16 colours) and PACKS (4-48 item sprites, each item 1-8 frames at one shared size, ≤32 colours pack-wide). Transparent bg, 1px dark outline, readable silhouette, deterministic seeded code. Each smith job produces EXACTLY ONE asset (one sprite or one pack): assets/<sku>/gen.mjs importing ../../lib/pix.mjs and calling emit() (sprites) or emitPack() (packs). See examples/ for working references (examples/potion-pack is the pack reference).

## Already in progress / listed — do NOT approve duplicates of these
${args.inProgress.length ? args.inProgress.map((t) => `- ${t}`).join('\n') : '(none)'}

## Directives from the player
${directives || '(none)'}

Decide on EVERY pending proposal (you may leave some for a later turn by omitting them, but prefer to decide all). DECLINE anything that duplicates an already-approved or in-progress/listed title, and decline duplicates within this same batch — do not approve and decline the same idea in one turn. Approve at most ${args.maxApprovals} — extras will be declined as over capacity. Balance work across smiths. You may re-scope an order: set/adjust "kind" ('sprite' or 'pack'), "items" (4-48 for packs) and "itemNames". An order for MORE than 48 items must be split into themed volumes (keep one, propose the rest later) or declined. End your reply with EXACTLY this block:

## Decisions
\`\`\`json
[{"id":"<candidate id>","approve":true,"reason":"<short reason>","smith":"<smith id>","brief":"<refined art direction for the smith>","kind":"<sprite|pack, optional>","items":<4-48, packs only>,"itemNames":["<optional>"]}]
\`\`\``;
}

export function forgePrompt(args: {
  sku: string;
  order: OrderSpec;
  variantSourcePath?: string;
  issues?: string[];
  inspectNotes?: string;
}): string {
  const retry = args.issues?.length
    ? `\nYour previous attempt failed automated checks — fix these:\n${args.issues.map((i) => `- ${i}`).join('\n')}\n`
    : '';
  const inspect = args.inspectNotes ? `\nThe inspector rejected the last version:\n${args.inspectNotes}\n` : '';
  const variant = args.variantSourcePath
    ? `\nThis is a variant of \`${args.order.variantOf}\` — read \`${args.variantSourcePath}\` and adapt it rather than starting from scratch.\n`
    : '';
  if (args.order.kind === 'pack') {
    const wanted = args.order.items ?? 0;
    const names = args.order.itemNames?.length
      ? `\n- item names to produce: ${args.order.itemNames.join(', ')}`
      : '';
    return `You are a smith in a sprite-asset factory. Forge this PACK order:

- sku: \`${args.sku}\` — title: ${args.order.title}
- tags: ${args.order.tags.join(', ')}
- PACK of ${wanted} items — each item a ${args.order.size}x${args.order.size} px sprite with 1-8 frames
- brief: ${args.order.brief}${names}
${variant}${retry}${inspect}
Read \`STYLE.md\` and the library \`lib/pix.mjs\`; \`examples/potion-pack/gen.mjs\` is THE reference pack generator — study it. The only way ${wanted} items stay manageable is a PARAMETRIC generator: one shared palette + a per-item parameter table (shape/colour/detail) + a loop that builds each item's frames. Never write ${wanted} unrelated one-off drawings.

1. Write \`assets/${args.sku}/gen.mjs\` (imports \`../../lib/pix.mjs\`, ends with \`emitPack(new URL('.', import.meta.url).pathname, { items: [{ name, frames }], fps })\`). Item names must be unique \`[a-z0-9-]\` slugs.
2. Run \`node assets/${args.sku}/gen.mjs\` and check \`assets/${args.sku}/meta.json\` — kind:"pack", ~${wanted} items, every item 1-8 frames + healthy opaqueRatio, no duplicates, ≤32 colours pack-wide.
3. Open \`assets/${args.sku}/preview.png\` (contact sheet of every item) and iterate until the pack looks cohesive but every item is distinct.

End your reply with \`## Done\` and one line describing the pack.`;
  }
  return `You are a smith in a sprite-asset factory. Forge this order:

- sku: \`${args.sku}\` — title: ${args.order.title}
- tags: ${args.order.tags.join(', ')}
- ${args.order.size}x${args.order.size} px per frame, ${args.order.frames} frame(s)
- brief: ${args.order.brief}
${variant}${retry}${inspect}
Read \`STYLE.md\` and the library \`lib/pix.mjs\`; \`examples/slime-green/gen.mjs\` is a good example. Then:

1. Write \`assets/${args.sku}/gen.mjs\` (imports \`../../lib/pix.mjs\`, ends with \`emit(new URL('.', import.meta.url).pathname, { frames, fps })\`).
2. Run \`node assets/${args.sku}/gen.mjs\` and check \`assets/${args.sku}/meta.json\` — frames ${args.order.frames}, size ${args.order.size}, ≤16 colours, no empty frames, frames not all identical.
3. Open \`assets/${args.sku}/preview.png\` if you can view images and iterate until it looks good.

End your reply with \`## Done\` and one line describing the sprite.`;
}

export function inspectPrompt(asset: Asset): string {
  if (asset.kind === 'pack') {
    const names = asset.itemNames?.length ? `\n- the order listed these items: ${asset.itemNames.join(', ')}` : '';
    return `You are the QA inspector of a sprite-asset factory. Judge this generated SPRITE PACK.

- sku: \`${asset.sku}\` — order: ${asset.title} (${asset.items ?? '?'} items at ${asset.size}x${asset.size}, tags: ${asset.tags.join(', ')})
- brief: ${asset.orderBrief}${names}
- automated check stats are in \`assets/${asset.sku}/meta.json\` (perItem has per-item stats; items/<name>.png has each strip)

Open \`assets/${asset.sku}/preview.png\` — the contact sheet showing every item — and look at \`assets/${asset.sku}/sheet.png\` (the full atlas) if you want a closer look. Judge against the brief:
- COHESION: does the pack share one style and palette?
- VARIETY: is every item clearly distinct (no recolour-only clones)?
- READABILITY: does each item read at 1x?
- MATCH: are the promised items actually there?
End your reply with:

## Inspection
Verdict: PASS or FAIL
Score: <1-10>
Notes: <what's good / what must be fixed, 1-3 lines>`;
  }
  return `You are the QA inspector of a sprite-asset factory. Judge this generated sprite sheet.

- sku: \`${asset.sku}\` — order: ${asset.title} (${asset.size}x${asset.size}, ${asset.frames} frame(s), tags: ${asset.tags.join(', ')})
- brief: ${asset.orderBrief}
- automated check stats are in \`assets/${asset.sku}/meta.json\`

Open \`assets/${asset.sku}/preview.png\` and look at it against the brief: does it read at small size? silhouette clear? animation makes sense? End your reply with:

## Inspection
Verdict: PASS or FAIL
Score: <1-10>
Notes: <what's good / what must be fixed, 1-3 lines>`;
}

export function packPrompt(asset: Asset): string {
  const isPack = asset.kind === 'pack';
  const n = asset.items ?? 1;
  const names = asset.itemNames?.length
    ? `\nItems (first ${Math.min(8, asset.itemNames.length)} of ${asset.itemNames.length}): ${asset.itemNames.slice(0, 8).join(', ')}${asset.itemNames.length > 8 ? '…' : ''}`
    : '';
  const guide = isPack
    ? n <= 16
      ? '$2.99–5.99 (8-16 item pack)'
      : '$4.99–14.99 (17-48 item pack)'
    : '$0.99–2.99 (single sprite)';
  return `You are the packer of a sprite-asset factory. Write the MOCK-marketplace listing for \`${asset.sku}\` ("${asset.title}", ${isPack ? `pack of ${n} items, ` : ''}tags: ${asset.tags.join(', ')}, inspection score ${asset.inspection?.score ?? '?'}/10) — this is a fictional in-game market, nothing is published anywhere real.${names}

Look at \`assets/${asset.sku}/preview.png\` and \`assets/${asset.sku}/meta.json\`, then write \`assets/${asset.sku}/listing.json\`:

\`\`\`json
{"title":"<selling title>","description":"<max 400 chars, what a game dev gets>","tags":["<3-6 marketplace tags>"],"priceUsd":<0.99-14.99>}
\`\`\`

Price guide: ${guide}. Packs with more items are worth more; clamp to $0.99–14.99.

End your reply with \`## Done\` and one line summary.`;
}
