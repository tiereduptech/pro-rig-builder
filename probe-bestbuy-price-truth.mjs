#!/usr/bin/env node
/**
 * probe-bestbuy-price-truth.mjs — READ-ONLY. Writes nothing to the catalog.
 *
 * Answers one question: is `deals.bestbuy.price` the number a customer
 * actually pays?
 *
 * For a sample of catalog rows it prints three columns:
 *   1. stored      — deals.bestbuy.price as it sits in src/data/parts/<cat>.js
 *   2. salePrice   — Best Buy Developer API salePrice (the field our ingest writes)
 *   3. live        — the real selling price a customer sees
 *
 * Column 3 is the point. bestbuy-price.js records a live test from 2026-06-28:
 * for sku 6519477 the Developer API returned salePrice 399.99 (onSale:false)
 * and the Impact catalog returned CurrentPrice 399.99, while the real selling
 * price was 239.99 — a My Best Buy Plus/Total member price that no feed
 * publishes. If that reproduces at scale, the defect is the FIELD WE READ, not
 * the schedule we read it on, and adding a cron would refresh a wrong number
 * on time.
 *
 * Classification per row:
 *   FIELD-WRONG  salePrice != live      -> wrong field; a cron cannot fix this
 *   STALE-ONLY   salePrice == live,
 *                stored != live         -> field is right; build the refresh job
 *   NO-SALEPRICE no salePrice at all    -> dead sku; abstains from the above
 *   AGREE        stored == sale == live -> row is fine
 *
 * Usage:
 *   BESTBUY_API_KEY=... node probe-bestbuy-price-truth.mjs [--limit=20]
 *
 * Options:
 *   --limit=N        rows to probe (default 20)
 *   --category=gpu   restrict to one category
 *   --sample=under|over|random   which rows to pick (default: under)
 *                    under = Best Buy is the cheapest deal, so it wins our buy
 *                            box and a wrong number is what a customer clicks
 *   --live=auto|page|dataforseo|off   how to source column 3 (default auto)
 *   --no-sellers     skip the DataForSEO sellers step (faster, cheaper, finds less)
 *
 * NETWORK NOTE: www.bestbuy.com sits behind Akamai bot management, which
 * accepts the TCP connection and then stalls the TLS handshake for datacenter
 * IPs (verified 2026-08-17: TCP 443 OPEN, handshake dies after Server Hello,
 * curl 000). GitHub Actions runners are datacenter IPs too, so --live=page may
 * well be blocked there as well. --live=auto tries the page first and falls
 * back to DataForSEO Google Shopping.
 *
 * That fallback is NOT the same path amazon-price.js uses — an earlier version
 * of this comment claimed it was. amazon-price.js calls merchant/amazon/sellers,
 * a different endpoint with a different response shape, so it lent this code no
 * proven precedent. Google Shopping resolution lives in bestbuy-live-price.mjs
 * and is pinned by test/bestbuy-live-price.test.js against the documented
 * shapes; nothing here is validated by amazon-price.js working.
 */

import { readdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { liveBestBuyPrice, shoppingKeyword } from './bestbuy-live-price.mjs';
import { classify, tallyOf, VERDICTS } from './bestbuy-price-verdict.mjs';

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const LIMIT = Math.min(Number(argOf('limit', '20')) || 20, 200);
const CATEGORY = argOf('category', '') || null;
const SAMPLE = argOf('sample', 'under');
const LIVE_MODE = argOf('live', 'auto');
// sellers is task-based (post + poll), so it is the slower and costlier arm.
// --no-sellers restricts step 2 off for a fast, cheap first look.
const LIVE_USE_SELLERS = !process.argv.includes('--no-sellers');

const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) {
  console.error('ERROR: BESTBUY_API_KEY not set.');
  process.exit(1);
}
const DFS_LOGIN = process.env.DATAFORSEO_LOGIN;
const DFS_PW = process.env.DATAFORSEO_PASSWORD;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (v) => (typeof v === 'number' ? '$' + v.toFixed(2) : '—');
const signed = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2));

// ── Load catalog rows that carry a Best Buy deal ──────────────────────────
const PARTS_DIR = path.join(process.cwd(), 'src', 'data', 'parts');
const rows = [];
for (const file of readdirSync(PARTS_DIR).filter((f) => f.endsWith('.js'))) {
  const cat = file.replace(/\.js$/, '');
  if (CATEGORY && cat !== CATEGORY) continue;
  const mod = await import('file://' + path.join(PARTS_DIR, file));
  for (const p of mod.default) {
    const bb = p?.deals?.bestbuy;
    if (!bb || typeof bb.price !== 'number') continue;
    const sku = (/prodsku=(\d+)/.exec(bb.url || '') || [])[1];
    if (!sku) continue;
    const peers = Object.entries(p.deals)
      .filter(([k]) => k !== 'bestbuy')
      .map(([k, v]) => ({ k, p: v.price }))
      .filter((x) => typeof x.p === 'number' && x.p > 0);
    rows.push({ cat, id: p.id, name: p.n, sku, stored: bb.price, peers });
  }
}

const withPeer = rows
  .filter((r) => r.peers.length)
  .map((r) => {
    const minPeer = Math.min(...r.peers.map((x) => x.p));
    return { ...r, minPeer, undercut: (minPeer - r.stored) / minPeer };
  });

let sample;
if (SAMPLE === 'over') {
  sample = withPeer.filter((r) => r.undercut < 0).sort((a, b) => a.undercut - b.undercut);
} else if (SAMPLE === 'random') {
  // deterministic spread by id so re-runs are comparable
  sample = [...rows].sort((a, b) => (a.id * 2654435761 % 1000) - (b.id * 2654435761 % 1000));
} else {
  sample = withPeer.filter((r) => r.undercut > 0).sort((a, b) => b.undercut - a.undercut);
}
sample = sample.slice(0, LIMIT);

console.log('='.repeat(116));
console.log('BEST BUY PRICE TRUTH PROBE — read-only, writes nothing to the catalog');
console.log(`sample=${SAMPLE} limit=${LIMIT} live=${LIVE_MODE}${CATEGORY ? ' category=' + CATEGORY : ''}`);
console.log(`catalog: ${rows.length} rows with a Best Buy deal and a parseable sku; probing ${sample.length}`);
console.log('='.repeat(116));

// ── Column 2: Developer API salePrice ─────────────────────────────────────
async function apiPrice(sku, attempt = 1) {
  const show = 'sku,name,salePrice,regularPrice,onSale,onlineAvailability,orderable,marketplace';
  const url = `https://api.bestbuy.com/v1/products/${sku}.json?apiKey=${KEY}&show=${show}&format=json`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (r.status === 403 && attempt < 5) { await sleep(attempt * 2500); return apiPrice(sku, attempt + 1); }
    if (r.status === 404) return { missing: true };
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json();
    return {
      salePrice: j.salePrice ?? null,
      regularPrice: j.regularPrice ?? null,
      onSale: j.onSale === true,
      name: j.name || '',
      orderable: j.orderable ?? null,
      marketplace: j.marketplace === true,
    };
  } catch (e) { return { error: e.name === 'TimeoutError' ? 'timeout' : e.message }; }
}

// ── Column 3: the real selling price ──────────────────────────────────────
async function livePagePrice(sku) {
  const url = `https://www.bestbuy.com/site/-/${sku}.p?skuId=${sku}`;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) return { error: `page HTTP ${r.status}` };
    const html = await r.text();
    if (/Are you a human|bot-?challenge|Access Denied|Pardon the Interruption/i.test(html)) return { error: 'bot-challenge' };
    // Structured data first — the rendered DOM price is the same number but
    // far more fragile to parse.
    const ld = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = ld.exec(html))) {
      try {
        const j = JSON.parse(m[1]);
        const offer = j?.offers?.price ?? (Array.isArray(j?.offers) ? j.offers[0]?.price : null);
        if (offer) return { live: Number(offer), via: 'json-ld' };
      } catch { /* keep scanning */ }
    }
    const cp = /"customerPrice"\s*:\s*([0-9.]+)/.exec(html);
    if (cp) return { live: Number(cp[1]), via: 'customerPrice' };
    return { error: 'no-price-in-page' };
  } catch (e) { return { error: e.name === 'TimeoutError' ? 'page timeout (likely Akamai)' : e.message }; }
}

async function liveDataForSeoPrice(name, keywordSource) {
  // Parsing + the two-step products→sellers resolution live in
  // bestbuy-live-price.mjs so they can be tested without creds or network.
  // The first version of this function matched on `item.url`, a field the
  // products endpoint does not have, and never queried the sellers endpoint at
  // all — which is why the 2026-08-17 run returned 20/20 UNRESOLVED.
  const res = await liveBestBuyPrice(name, { login: DFS_LOGIN, pw: DFS_PW, useSellers: LIVE_USE_SELLERS });
  return { ...res, keyword: name, keywordSource };
}

async function livePrice(r, api) {
  if (LIVE_MODE === 'off') return { error: 'skipped' };
  if (LIVE_MODE === 'page') return livePagePrice(r.sku);
  const kw = shoppingKeyword(r.name, api?.name);
  if (LIVE_MODE === 'dataforseo') return liveDataForSeoPrice(kw.name, kw.source);
  const page = await livePagePrice(r.sku);
  if (page.live != null) return page;
  const dfs = await liveDataForSeoPrice(kw.name, kw.source);
  if (dfs.live != null) return { ...dfs, note: `page: ${page.error}` };
  return { ...dfs, error: `page: ${page.error}; dfs: ${dfs.error}` };
}

// ── Run ───────────────────────────────────────────────────────────────────
const out = [];
for (const [i, r] of sample.entries()) {
  const api = await apiPrice(r.sku);
  await sleep(650); // Developer API: stay under 5 req/sec
  const live = await livePrice(r, api);
  if (LIVE_MODE !== 'off') await sleep(900);
  out.push({ ...r, api, live });
  process.stderr.write(`  probed ${i + 1}/${sample.length}\r`);
}
process.stderr.write('\n');

// ── Classify ──────────────────────────────────────────────────────────────
for (const r of out) {
  const sale = r.api?.salePrice ?? null;
  const live = r.live?.live ?? null;
  r.sale = sale;
  r.liveP = live;
  r.d_stored_live = live != null ? live - r.stored : null;
  r.d_sale_live = live != null && sale != null ? live - sale : null;
  r.flags = [];
  if (r.api?.missing) r.flags.push('SKU-404');
  if (r.api?.error) r.flags.push('api:' + r.api.error);
  if (r.api?.marketplace) r.flags.push('3P');
  if (r.api?.orderable && /soldout|unavailable/i.test(String(r.api.orderable))) r.flags.push('sold-out');
  if (r.live?.error) r.flags.push(r.live.error);
  if (r.live?.keywordSource === 'catalog') r.flags.push('KW-FALLBACK');
  if (r.api?.name && !r.api.name.toLowerCase().includes(r.name.toLowerCase().slice(0, 14))) r.flags.push('NAME-DRIFT');

  r.verdict = classify({ stored: r.stored, sale, live });
}
const tally = tallyOf(out.map((r) => r.verdict));

// ── Console table ─────────────────────────────────────────────────────────
console.log('');
console.log(
  'cat/id'.padEnd(20) + 'sku'.padEnd(11) + 'stored'.padStart(10) + 'salePrice'.padStart(11) +
  'live'.padStart(11) + 'stored→live'.padStart(13) + 'sale→live'.padStart(11) + '  verdict'
);
console.log('-'.repeat(116));
for (const r of out) {
  console.log(
    `${r.cat}/${r.id}`.padEnd(20) + r.sku.padEnd(11) +
    money(r.stored).padStart(10) + money(r.sale).padStart(11) + money(r.liveP).padStart(11) +
    signed(r.d_stored_live).padStart(13) + signed(r.d_sale_live).padStart(11) + '  ' + r.verdict
  );
  if (r.flags.length) console.log(''.padEnd(20) + '  ↳ ' + r.flags.join(' | '));
  if (r.api?.name && r.flags.includes('NAME-DRIFT'))
    console.log(''.padEnd(20) + `  ↳ catalog "${r.name.slice(0, 44)}" vs BB "${r.api.name.slice(0, 44)}"`);
  if (r.verdict === 'UNRESOLVED' && r.live?.keyword)
    console.log(''.padEnd(20) + `  ↳ keyword (${r.live.keywordSource}): "${r.live.keyword.slice(0, 80)}"`);
}
console.log('-'.repeat(116));
console.log(VERDICTS.map((v) => `${v} : ${tally[v]}`).join('   '));

// ── Job summary ───────────────────────────────────────────────────────────
const SUMMARY = process.env.GITHUB_STEP_SUMMARY;
if (SUMMARY) {
  const L = [];
  L.push('## Best Buy price truth probe');
  L.push('');
  L.push(`Read-only. Nothing was written to the catalog.`);
  L.push('');
  L.push(`\`sample=${SAMPLE}\` \`limit=${LIMIT}\` \`live=${LIVE_MODE}\`${CATEGORY ? ' `category=' + CATEGORY + '`' : ''} — probed ${out.length} of ${rows.length} rows carrying a Best Buy deal.`);
  L.push('');
  L.push('| cat/id | sku | stored | API salePrice | live selling | stored→live | sale→live | verdict |');
  L.push('|---|---|--:|--:|--:|--:|--:|---|');
  for (const r of out) {
    L.push(`| ${r.cat}/${r.id} | \`${r.sku}\` | ${money(r.stored)} | ${money(r.sale)} | ${money(r.liveP)} | ${signed(r.d_stored_live)} | ${signed(r.d_sale_live)} | ${r.verdict === 'FIELD-WRONG' ? '**FIELD-WRONG**' : r.verdict} |`);
  }
  L.push('');
  L.push('### Verdict counts');
  L.push('');
  L.push('| classification | count | meaning |');
  L.push('|---|--:|---|');
  L.push(`| FIELD-WRONG | ${tally['FIELD-WRONG']} | \`salePrice\` != what a customer pays — wrong field; a cron cannot fix this |`);
  L.push(`| STALE-ONLY | ${tally['STALE-ONLY']} | \`salePrice\` is correct, stored value is old — build the refresh job |`);
  L.push(`| NO-SALEPRICE | ${tally['NO-SALEPRICE']} | the API published no \`salePrice\` for this sku — it cannot vote on the field question |`);
  L.push(`| AGREE | ${tally['AGREE']} | stored == salePrice == live |`);
  L.push(`| UNRESOLVED | ${tally['UNRESOLVED']} | no live price obtained (see notes) |`);
  L.push('');
  const notes = out.filter((r) => r.flags.length);
  if (notes.length) {
    L.push('### Row notes');
    L.push('');
    for (const r of notes) {
      L.push(`- **${r.cat}/${r.id}** \`${r.sku}\` — ${r.flags.join(' | ')}`);
      if (r.flags.includes('NAME-DRIFT')) L.push(`  - catalog: _${r.name.slice(0, 70)}_`);
      if (r.flags.includes('NAME-DRIFT')) L.push(`  - Best Buy: _${(r.api.name || '').slice(0, 70)}_`);
      if (r.verdict === 'UNRESOLVED' && r.live?.keyword) L.push(`  - keyword sent to Shopping (${r.live.keywordSource}): _${r.live.keyword.slice(0, 70)}_`);
    }
    L.push('');
  }
  L.push('### How to read this');
  L.push('');
  L.push('- **FIELD-WRONG dominant** → the defect is the field we read, same class as the Amazon 3P bug. Fix the field before touching any schedule.');
  L.push('- **STALE-ONLY dominant** → the field is right and the data is simply old. Build the refresh job.');
  L.push('- **Both present** → do not ship a cron until the field question is settled; a schedule would refresh a wrong number on time.');
  L.push('- **NO-SALEPRICE dominant** → the sample is mostly skus Best Buy no longer publishes. That is a catalog-liveness finding, and none of those rows says anything about the field; re-run on live skus before concluding anything.');
  L.push('');
  L.push('_Context: `bestbuy-price.js` records a live test from 2026-06-28 where the Developer API returned `salePrice` 399.99 (`onSale:false`) for sku 6519477 while the real selling price was 239.99 — a member price no feed publishes._');
  appendFileSync(SUMMARY, L.join('\n') + '\n');
  console.log('\nJob summary written.');
}
