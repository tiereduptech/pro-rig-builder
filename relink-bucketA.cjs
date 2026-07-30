#!/usr/bin/env node
/**
 * relink-bucketA.cjs — scoped path-A relink for a fixed id list (default the 32
 * bucket-A rows). Free feeds only: Newegg (Rakuten API), MSI (Impact 16410),
 * Best Buy first-party (Impact ItemSearch, SubCategory '1P').
 *
 * This is the SCOPED driver the general feed matchers can't be: they all filter
 * `!p.needsReview` and so skip every quarantined row. Here selection is by an
 * explicit id list (--only-ids) with a hard --expect-count guard, so the pass
 * can never silently widen.
 *
 * Every candidate must clear the SAME gates the ingest path uses:
 *   - Newegg:  NEG.scoreMatch(minSim=0.70) [condition markers + variant + line +
 *              brand + capacity + wattage + modularity] then NEG.neweggSanity.
 *   - MSI:     UPC->MPN->name tiered, nameTokenOverlap>=0.4 + model-suffix agree,
 *              + condition-title gate (isRenewedTitle == false).
 *   - BestBuy: first-party only (SubCategory==='1P'), in-stock, category
 *              whitelist, brand agree, GTIN match OR nameTokenOverlap>=0.6 +
 *              suffix agree, + condition-title gate.
 * Unresolved rows are LEFT UNTOUCHED (stay quarantined). No forced matches.
 *
 * On a resolved row (write mode): attach deals.<feed>, set p.pr to the live
 * price, DROP the stale deals.amazon (the bad link that quarantined it — also
 * removes the row from the tier-1 nightly's Amazon-ASIN scope), clear
 * needsReview/quarantinedAt, strip relink:* reviewFlags, stamp relinkedVia/At.
 * Persist via scripts/write-catalog.cjs (atomic promote + re-split + brakes).
 *
 * Usage:
 *   railway run node relink-bucketA.cjs                      # dry run, all feeds
 *   railway run node relink-bucketA.cjs --feeds newegg       # one feed
 *   railway run node relink-bucketA.cjs --write              # apply
 *   node relink-bucketA.cjs --only-ids bucketA-ids.json --expect-count 32
 */

const fs = require('fs');
const path = require('path');
const NG = require('./fetch-newegg-via-rakuten.cjs');           // findNeweggMatch/getToken/initNEG/CAT_FILTER
const MSI = require('./ingest-msi-impact-v2.cjs');              // normUPC/normMPN/normName/nameTokenOverlap/extractSuffix
const COND = require('./condition.cjs');                        // isRenewedTitle
const { writeCatalog } = require('./scripts/write-catalog.cjs');

const args = process.argv.slice(2);
const has = (k) => args.includes('--' + k);
const val = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const WRITE = has('write');
const ONLY_IDS_FILE = val('only-ids', 'bucketA-ids.json');
const EXPECT_COUNT = parseInt(val('expect-count', '32'), 10);
const FEEDS = new Set((val('feeds', 'newegg,msi,bestbuy')).split(',').map((s) => s.trim()).filter(Boolean));
const TODAY = new Date().toISOString().slice(0, 10);
const REPORT_PATH = 'relink-bucketA-report.json';

const SID = process.env.IMPACT_ACCOUNT_SID;
const TOKEN = process.env.IMPACT_AUTH_TOKEN;
const IMPACT_AUTH = SID && TOKEN ? 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64') : null;

let NEG = null;   // shared matcher (newegg-match.js) — set at startup, used by ALL feeds

// Authoritative candidate gate — the SAME variant/model-token/line/brand +
// price-multiplier gates the Newegg ingest uses, applied uniformly to MSI and
// Best Buy candidates too (one matcher, one place). Kills wrong-generation
// SKUs (RTX 3070 vs 5090, B760 vs B850, Cloud III vs Stinger 2) that a bare
// token-overlap lets through. Returns { ok, method, score } or null.
function gateCandidate(p, cand) {
  const notes = {};
  const item = { name: cand.name, sku: cand.sku || '', upc: cand.upc || '', price: cand.price, saleprice: cand.saleprice || null };
  const m = NEG.scoreMatch(p, item, notes, { minSim: NEG.MIN_ATTACH_SIM });
  if (!m) return { ok: false, reject: notes.reject || 'no_match' };
  const eff = (cand.saleprice && cand.saleprice > 0) ? cand.saleprice : cand.price;
  const sanity = NEG.neweggSanity(p, eff);
  if (!sanity.pass) return { ok: false, reject: `sanity:${sanity.cls}`, method: m.method, score: m.score };
  return { ok: true, method: m.method, score: Number(m.score.toFixed(3)) };
}

// ── Impact helpers (MSI catalog 16410 + Best Buy ItemSearch) ─────────────────
async function impactGet(pathStr, params = {}) {
  const url = new URL(`https://api.impact.com/Mediapartners/${SID}${pathStr}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: IMPACT_AUTH, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Impact ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
let _msiItems = null;
async function fetchMSIItems() {
  if (_msiItems) return _msiItems;
  const all = []; let page = 1;
  while (true) {
    const data = await impactGet(`/Catalogs/16410/Items`, { Page: page, PageSize: 500 });
    const items = data?.Items || [];
    all.push(...items);
    if (items.length < 500 || page > 20) break;
    page++;
  }
  _msiItems = all;
  return all;
}
async function bestbuySearch(keyword, page = 0) {
  const data = await impactGet(`/Catalogs/ItemSearch`, {
    Keyword: keyword, Query: "StockAvailability = 'InStock'", PageSize: '100', Page: String(page),
  });
  return data?.Items || [];
}

// Best Buy category whitelist (subset lifted from bestbuy-discover.js) — the row
// category must match, so a keyword search for "corsair" doesn't attach a mousepad.
const BB_WHITELIST = {
  Motherboard: [/Motherboards/i],
  GPU: [/Graphics Cards/i, /Video Graphics/i],
  Storage: [/Internal\s*(Solid State|SSDs?|Hard Drives?|M\.?2|NVMe)/i, /\bNVMe\b/i, /\bSSDs?\b/i, /Hard Drives/i],
  PSU: [/Power Supplies/i, /\bPSUs?\b/i],
  CPUCooler: [/CPU (Fans|Cooler)/i, /Water Cooling/i, /AIO/i, /Computer Cooling/i],
  Headset: [/Headsets?/i, /Gaming Headsets?/i, /Headphones?/i],
  Microphone: [/Microphones?/i],
  Mouse: [/\bMice\b/i, /Mouse/i, /Gaming Mice/i],
  Keyboard: [/Keyboards?/i, /Gaming Keyboards?/i],
  Webcam: [/Webcams?/i],
};
const bbCatOK = (c, cat) => (BB_WHITELIST[c] || []).some((re) => re.test(cat || ''));

// Build a search keyword from a catalog row: brand + the distinctive head of the
// name (drop parentheticals + condition/marketing noise), first ~6 tokens.
function keywordFor(p) {
  let s = (p.n || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(renewed|refurbished|refurb|recertified|open[\s-]?box|used|new)\b/gi, ' ')
    .replace(/[|,:–—-]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const toks = s.split(' ').filter(Boolean).slice(0, 6);
  return toks.join(' ');
}
const brandToks = (b) => MSI.normName(b || '').split(' ').filter((t) => t.length >= 2);
function brandAgrees(p, candName, candMfr) {
  const bts = brandToks(p.b);
  if (!bts.length) return true;
  const hay = MSI.normName((candName || '') + ' ' + (candMfr || ''));
  return bts.some((t) => hay.includes(t));
}

// ── Per-feed match attempts. Each returns a normalized candidate or null. ─────
async function tryNewegg(p, token) {
  if (!NG.CAT_FILTER[p.c]) return { skip: 'no_cat_mapping' };
  const r = await NG.findNeweggMatch(p, token);
  if (!r.ok) return { skip: r.reason };
  const eff = (r.item.saleprice && r.item.saleprice > 0) ? r.item.saleprice : r.item.price;
  const NEG = await NG.initNEG();
  const sanity = NEG.neweggSanity(p, eff);
  return {
    feed: 'newegg', ok: sanity.pass, price: eff, name: r.item.name, sku: r.item.sku,
    sellerClass: NEG.sellerClass(r.item.sku), method: r.method, score: Number(r.score.toFixed(3)),
    url: r.item.linkurl, image: r.item.imageurl,
    reject: sanity.pass ? null : `sanity:${sanity.cls}`,
    deal: { sku: r.item.sku, price: r.item.price, saleprice: r.item.saleprice, linkurl: r.item.linkurl, imageurl: r.item.imageurl, sellerClass: NEG.sellerClass(r.item.sku), matchedAt: TODAY, matchMethod: r.method, matchScore: Number(r.score.toFixed(2)) },
  };
}
async function tryMSI(p) {
  if ((p.b || '').toUpperCase() !== 'MSI') return { skip: 'not_msi_brand' };
  const items = await fetchMSIItems();
  let best = null;
  for (const it of items) {
    if (COND.isRenewedTitle(it.Name)) continue;                 // condition gate
    const price = parseFloat(it.CurrentPrice);
    const g = gateCandidate(p, { name: it.Name, upc: it.Gtin, price: isNaN(price) ? null : price });
    if (!g.ok) continue;                                        // variant/model/price gate
    if (!best || g.score > best.g.score) best = { it, g, price: isNaN(price) ? null : price };
  }
  if (!best) return { skip: 'no_msi_match' };
  return {
    feed: 'msi', ok: true, price: best.price, name: best.it.Name,
    sku: best.it.CatalogItemId, method: best.g.method, score: best.g.score,
    url: best.it.Url, image: best.it.ImageUrl,
    deal: { price: best.price, url: best.it.Url, inStock: String(best.it.StockAvailability).toLowerCase() === 'instock' },
  };
}
async function tryBestBuy(p) {
  if (!BB_WHITELIST[p.c]) return { skip: 'no_bb_category' };
  let items = [];
  try { items = await bestbuySearch(keywordFor(p)); } catch (e) { return { skip: 'bb_error:' + e.message.slice(0, 40) }; }
  let best = null;
  for (const raw of items) {
    if (!/best\s*buy/i.test(raw.CampaignName || '')) continue;    // Best Buy campaign only
    if (raw.SubCategory !== '1P') continue;                       // FIRST-PARTY only
    if (String(raw.StockAvailability).toLowerCase() !== 'instock') continue;
    if (!bbCatOK(p.c, raw.Category)) continue;                    // category whitelist
    if (COND.isRenewedTitle(raw.Name)) continue;                  // condition gate
    if (!brandAgrees(p, raw.Name, raw.Manufacturer)) continue;    // brand agree
    const price = raw.CurrentPrice ? parseFloat(raw.CurrentPrice) : null;
    const g = gateCandidate(p, { name: raw.Name, upc: raw.Gtin, price });   // variant/model/price gate
    if (!g.ok) continue;
    if (!best || g.score > best.g.score) best = { raw, g, price };
  }
  if (!best) return { skip: 'no_bb_1p_match' };
  return {
    feed: 'bestbuy', ok: true, price: best.price, name: best.raw.Name, sku: best.raw.CatalogItemId,
    method: best.g.method, score: best.g.score, url: best.raw.Url, image: best.raw.ImageUrl,
    deal: { price: best.price, url: best.raw.Url, inStock: true },
  };
}

(async () => {
  console.log(`\n  relink-bucketA — ${WRITE ? 'WRITE' : 'DRY RUN'}  feeds=[${[...FEEDS].join(',')}]  only-ids=${ONLY_IDS_FILE}  expect=${EXPECT_COUNT}\n`);
  const ids = JSON.parse(fs.readFileSync(ONLY_IDS_FILE, 'utf8'));
  if (!Array.isArray(ids)) throw new Error('only-ids file is not a JSON array');

  const partsMod = await import('file://' + path.resolve('src/data/parts.js').replace(/\\/g, '/') + '?t=' + Date.now());
  const parts = partsMod.PARTS || partsMod.default;
  const loadedCount = parts.length;
  const byId = new Map(parts.map((p) => [p.id, p]));
  const rows = ids.map((id) => byId.get(id)).filter(Boolean);
  if (rows.length !== EXPECT_COUNT) {
    throw new Error(`SCOPE GUARD: resolved ${rows.length} rows but --expect-count ${EXPECT_COUNT}. Aborting (no write).`);
  }
  console.log(`  Scope OK: ${rows.length} rows resolved from ${ids.length} ids.\n`);

  NEG = await NG.initNEG();   // shared matcher — used by every feed's gateCandidate
  let token = null;
  if (FEEDS.has('newegg')) { token = await NG.getToken(); console.log('  ✓ Rakuten token\n'); }

  const results = [];
  for (const p of rows) {
    const attempts = {};
    let chosen = null;
    // Priority: Newegg (first-party + price) -> MSI (manufacturer) -> Best Buy 1P.
    for (const feed of ['newegg', 'msi', 'bestbuy']) {
      if (!FEEDS.has(feed)) continue;
      if (chosen) { attempts[feed] = { skip: 'already_resolved' }; continue; }
      let r;
      try {
        r = feed === 'newegg' ? await tryNewegg(p, token) : feed === 'msi' ? await tryMSI(p) : await tryBestBuy(p);
      } catch (e) { r = { skip: 'error:' + (e.message || '').slice(0, 60) }; }
      attempts[feed] = r;
      if (r && r.ok) chosen = r;
    }
    results.push({ id: p.id, c: p.c, b: p.b, n: p.n, pr: p.pr, chosen, attempts });
    const tag = chosen ? `→ ${chosen.feed} $${chosen.price} [${chosen.method} ${chosen.score}] ${chosen.sellerClass || ''}` : `· unresolved`;
    console.log(`  ${String(p.id).padEnd(7)} [${p.c.slice(0, 5).padEnd(5)}] ${(p.n || '').slice(0, 42).padEnd(42)} ${tag}`);
  }

  const resolved = results.filter((r) => r.chosen);
  const byFeed = resolved.reduce((o, r) => ((o[r.chosen.feed] = (o[r.chosen.feed] || 0) + 1), o), {});
  console.log(`\n  ── Resolved ${resolved.length}/${rows.length}  ${JSON.stringify(byFeed)}  | unresolved ${rows.length - resolved.length} (stay quarantined)\n`);

  fs.writeFileSync(REPORT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), write: WRITE, feeds: [...FEEDS], expectCount: EXPECT_COUNT, resolvedCount: resolved.length, byFeed, results }, null, 2));
  console.log(`  Report: ${REPORT_PATH}`);

  if (!WRITE) { console.log('\n  DRY RUN — nothing written. Re-run with --write to apply.\n'); return; }
  if (!resolved.length) { console.log('\n  Nothing resolved — not writing.\n'); return; }

  for (const r of resolved) {
    const p = byId.get(r.id);
    const c = r.chosen;
    p.deals = p.deals || {};
    p.deals[c.feed] = c.deal;
    if (p.deals.amazon) delete p.deals.amazon;                   // drop the stale bad link (escapes tier-1 reflag)
    if (typeof c.price === 'number' && c.price > 0) p.pr = c.price;
    delete p.needsReview;
    delete p.quarantinedAt;
    if (Array.isArray(p.reviewFlags)) {
      p.reviewFlags = p.reviewFlags.filter((f) => !/^relink:/.test(f));
      if (!p.reviewFlags.length) delete p.reviewFlags;
    }
    p.relinkedVia = c.feed;
    p.relinkedAt = TODAY;
  }
  const res = await writeCatalog(parts, { loadedCount, reason: `bucket-A relink: ${resolved.length} rows (${JSON.stringify(byFeed)})` });
  console.log(`\n  WROTE ${resolved.length} relinks. ${JSON.stringify(res)}\n`);
})().catch((e) => { console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
