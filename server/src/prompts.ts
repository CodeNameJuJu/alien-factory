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
        `demand ${c.demand}/10${c.variantOf ? ` variant of ${c.variantOf}` : ''} — ${c.why}` +
        (c.merch ? ` · MERCHANDISER: sell ${c.merch.sell}/10 at $${c.merch.priceUsd.toFixed(2)}, angle: ${c.merch.angle}, risks: ${c.merch.risks}` : ''),
    )
    .join('\n');
  const smiths = args.smithQueues.map((s) => `- ${s.id}: ${s.queue} job(s) in queue`).join('\n');
  const directives = args.pendingDirectives.map((d) => `- ${d}`).join('\n');
  return `You are the Overlord of an alien factory that produces code-generated digital products (today: 2D pixel-game sprite assets) and sells them. The scout has proposed new assets; you decide which get forged and which smith makes each. When a proposal carries a MERCHANDISER line, it has already passed the "will this sell" check: weigh its sell score, price and angle, and put the angle into the smith's brief.

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

// ---- Etsy sales team --------------------------------------------------------
//
// marketSource 'etsy': analyst (scout) → merchandiser assess → overlord →
// smith → inspector → merchandiser sell review → copywriter (packer) →
// approval queue / autonomous publish. Every structured block below is
// parsed by parse.ts — keep the headings and JSON keys in sync.

/// One line per producible format, e.g. "- pack: 4-48 themed 16/32px
/// pixel-art game sprites, PNG strips + atlas, zipped".
export function scoutPromptEtsy(args: { catalog: string; formats: string; nextReport: number }): string {
  return `You are the market analyst of a digital-products shop that sells on Etsy. Everything we sell is generated by code: no photos, no hand drawing, no AI image models. Read \`reports/etsy-latest.md\` in this directory. It is fresh research from Etsy's own search: for each keyword, the number of active listings, the price spread, favourites, the most common tags and the top listings with their URLs.

What we can produce today (propose NOTHING outside these formats):
${args.formats}

Our catalog (sku | tags | status | units | revenue):
${args.catalog || '(empty, nothing listed yet)'}

Think like a seller who has to pay rent from this shop:
- DEMAND: are buyers clearly paying for this kind of item? Many listings that hold their prices and collect favourites = proven demand. A tiny listing count usually means no buyers, not a gap.
- COMPETITION: can a brand-new shop with zero reviews get seen? Prefer specific long-tail angles that buyers actually type ("cozy farm crop icons 32px") over head terms ("pixel art").
- PRICE: what do comparable listings charge for comparable content? Find the value gap (more items, a tighter theme, a missing style, a better bundle) that justifies our price.
- FIT: only propose what the formats above can make WELL. If the top sellers win on hand-painted art or photography, skip that niche and say why.
- CATALOG: favour ideas that grow a coherent shop (series, volumes, matching sets) over one-off random items.

Write your analysis to \`reports/trends-${args.nextReport}.md\`, then END your reply with:

## Trend report
<markdown: what sells and at what prices, gaps we can fill with the formats above, niches to avoid and why>

## Demand
\`\`\`json
[{"title":"<working product name>","format":"<one of the formats above>","kind":"sprite|pack","items":<4-48 when pack>,"itemNames":["<optional>"],"tags":["<tag>"],"size":16,"frames":4,"keywords":["<exact phrase a buyer types into Etsy search>"],"priceUsd":<suggested price>,"why":"<who buys it, for what, and why ours over the top comps>","demand":<1-10>,"competition":<1-10, 10 = saturated>,"evidence":["<etsy listing url from the report>"]}]
\`\`\`
3-6 proposals. Every proposal needs at least one evidence URL from the report.`;
}

export function merchAssessPrompt(args: { candidates: Candidate[]; catalog: string; trendReport: string; minSell: number }): string {
  const list = args.candidates
    .map(
      (c) =>
        `- ${c.id} "${c.title}" [${c.tags.join(', ')}] ` +
        (c.kind === 'pack' ? `pack of ${c.items ?? '?'} ` : '') +
        `${c.size}px×${c.frames}f, analyst demand ${c.demand}/10 — ${c.why}`,
    )
    .join('\n');
  return `You are the merchandiser of a code-generated digital-products shop on Etsy: the shop's commercial conscience. Nothing gets made unless you believe a real Etsy buyer will pay for it. Production time and listing fees are real money.

## Analyst's trend report
${args.trendReport || '(none)'}

Full research data: \`reports/etsy-latest.md\`.

## Our catalog (sku | tags | status | units | revenue)
${args.catalog || '(empty)'}

## Proposals to assess
${list}

For EACH proposal, check it against the research data yourself (do not just trust the analyst):
1. Is there proof that comparable listings sell (favourites, many sellers at sustained prices)?
2. Who exactly is the buyer, and what are they trying to get done?
3. Name the top 3 comparable listings. What would make a buyer pick ours instead: more items, a tighter theme, a better price, a style gap? If you can't name a concrete angle, the answer is no.
4. Can our code-generated output honestly compete on looks in this niche?
5. Price: what should it sell for as a new shop with zero reviews? Usually at or slightly below comparable listings with similar content.

Be stingy: expect to say no to at least half. "go" needs sell ≥ ${args.minSell}, a concrete angle and evidence that comparable listings sell. End your reply with EXACTLY:

## Assessment
\`\`\`json
[{"id":"<candidate id>","verdict":"go|no","sell":<1-10>,"priceUsd":<number>,"angle":"<one line: why a buyer picks ours over the top comps>","risks":"<what could make it flop>"}]
\`\`\``;
}

export function merchReviewPrompt(args: { asset: Asset; angle?: string; priceUsd?: number; minScore: number }): string {
  const a = args.asset;
  const what = a.kind === 'pack' ? `pack of ${a.items ?? '?'} items at ${a.size}x${a.size}` : `${a.size}x${a.size} sprite, ${a.frames} frame(s)`;
  return `You are the merchandiser of a code-generated digital-products shop on Etsy. The inspector has passed \`${a.sku}\` ("${a.title}", ${what}) on technical quality. Your question is different: WILL THIS SELL?

- the angle you approved it on: ${args.angle ?? '(none recorded)'}
- the planned price: ${args.priceUsd !== undefined ? `$${args.priceUsd.toFixed(2)}` : '(none)'}
- the brief: ${a.orderBrief}

Open \`assets/${a.sku}/preview.png\` and read \`assets/${a.sku}/meta.json\`. Then open \`reports/etsy-latest.md\` and compare against the top listings for this niche. Picture an Etsy search results page: our thumbnail sits next to the top 3 comps.
- Would a buyer stop on ours? Does it look worth the price next to them?
- Does it deliver on the angle (the item count, theme and style that were promised)?
- Is anything embarrassing: muddy colours, near-duplicate items, unreadable details, a theme that doesn't hang together?

REWORK only when you can name a concrete change that would lift sales (e.g. "items 7-12 are recolours: give them distinct silhouettes"). DROP anything that would not sell even if fixed. LIST needs score ≥ ${args.minScore}. End your reply with EXACTLY:

## Sell review
Verdict: LIST or REWORK or DROP
Score: <1-10>
Price: <usd number>
Notes: <what will sell it / what must change, 1-3 lines>`;
}

export function copywriterPrompt(args: {
  asset: Asset;
  keywords: string[];
  angle?: string;
  priceUsd?: number;
  sections: string[];
  minPriceUsd: number;
  maxPriceUsd: number;
}): string {
  const a = args.asset;
  return `You are the copywriter of a code-generated digital-products shop on Etsy. Write the Etsy listing for \`${a.sku}\` ("${a.title}", tags: ${a.tags.join(', ')}). It is a DIGITAL DOWNLOAD: nothing is shipped.

- the selling angle: ${args.angle ?? '(none recorded)'}
- buyer search phrases from research: ${args.keywords.length ? args.keywords.join(' | ') : '(none, derive them from reports/etsy-latest.md)'}
- merchandiser's price: ${args.priceUsd !== undefined ? `$${args.priceUsd.toFixed(2)}` : '(none)'}
- existing shop sections: ${args.sections.length ? args.sections.join(', ') : '(none yet, propose one)'}

Read \`assets/${a.sku}/meta.json\` (the ONLY source of truth for counts, sizes, frames and file types) and look at \`assets/${a.sku}/preview.png\`. Study how the top listings in \`reports/etsy-latest.md\` word their titles and tags. Then write \`assets/${a.sku}/listing.json\`:

\`\`\`json
{"title":"...","description":"...","tags":["... exactly 13 ..."],"priceUsd":<number>,"taxonomy":"<Etsy category path, e.g. Craft Supplies & Tools > ...>","section":"<shop section name>"}
\`\`\`

TITLE (max 140 characters): put the main buyer search phrase first, then the concrete specifics (item count, pixel size, style, use). Plain readable words: no keyword stuffing, no word repeated more than twice, no more than 3 words in ALL CAPS, no emoji.
TAGS: exactly 13, each at most 20 characters, letters/numbers/spaces only. Use multi-word phrases buyers actually type. Cover different angles (what it is, who it's for, the style, the use case, the occasion). Don't spend tags repeating the category.
DESCRIPTION: the first 160 characters show in search, so say what it is and who it's for. Then these sections in plain text:
  WHAT YOU GET: bullet lines with the exact counts, sizes, frames and file formats from meta.json
  HOW TO USE: 2-3 lines (engines/tools it drops into)
  LICENSE: personal and commercial use in your own games and projects; no reselling or redistributing the files themselves
  INSTANT DOWNLOAD: no physical item will be shipped
Never claim anything meta.json doesn't support (no "animated" unless frames > 1, no item counts that don't match). Do NOT write an AI/tools disclosure: the shop appends its own.
PRICE: within ±15% of the merchandiser's price, and between $${args.minPriceUsd.toFixed(2)} and $${args.maxPriceUsd.toFixed(2)}.

End your reply with \`## Done\` and one line summary.`;
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
