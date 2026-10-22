// One-off itch scan for verification: `npx tsx src/scan-once.ts`.
// Same code path as the server's scanThenScout, minus the scout job.
import { analyseSnapshot, latestSnapshot, scanAllowed, scanFeeds, validateFeeds, writeItchReport } from './itch.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const feeds = validateFeeds(config.itchFeeds);
console.log('feeds:', feeds.map((f) => `${f.feed}x${f.pages}`).join(', '));

try {
  const t0 = Date.now();
  const { snapshot, requests } = await scanFeeds(feeds);
  const analysis = analyseSnapshot(snapshot, latestSnapshot(snapshot.at));
  const md = writeItchReport(analysis);
  console.log(`scan ok: ${requests} requests in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${analysis.priceStats.count} items`);
  console.log('top 8 themes:');
  for (const t of analysis.themes.slice(0, 8)) {
    console.log(`  ${t.key.padEnd(14)} score=${t.score} n=${t.count} top=${t.inTopSellers} med=${t.medianPrice ?? 'free'} free=${t.pctFree}% Δ=${t.delta ?? '—'}`);
  }
  console.log('--- itch-latest.md (first 15 lines) ---');
  console.log(md.split('\n').slice(0, 15).join('\n'));
} catch (e) {
  console.log('scan refused/failed:', (e as Error).message);
}

// immediate second scan must be refused WITHOUT any http requests
console.log('--- second scan attempt ---');
console.log('allowed?', scanAllowed(false));
try {
  await scanFeeds(feeds);
  console.log('BUG: second scan went through');
} catch (e) {
  console.log('refused as expected:', (e as Error).message);
}
