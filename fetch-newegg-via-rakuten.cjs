// =============================================================================
//  fetch-newegg-via-rakuten.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Matches active products in parts.js to Newegg's catalog via Rakuten
//  Product Search. Uses verified cat= filters + exact= phrase search to
//  bypass prebuilt-PC noise. GPUs are skipped (Rakuten Product Search does
//  not include them — those need the SFTP Product Catalog feed).
//
//  Matching strategy (STRICT — accuracy first):
//    1) Look up Rakuten cat= filter for product.c.
//    2) Search with exact= (product name keywords) + cat= filter + mid=44583.
//    3) For each result:
//         - Reject if name contains bundle markers (Custom/Workstation/PC/Combo).
//         - Reject if price > 2.5× our pr (likely a bundle).
//         - Score: UPC match (normalized) = 1.0; else Jaccard name similarity.
//    4) Accept best if UPC match OR name sim >= 0.5.
//    5) Store in deals.newegg = { sku, price, saleprice, linkurl, imageurl,
//                                  matchedAt, matchMethod, matchScore }.
//
//  Resumable: products with existing deals.newegg.sku are skipped on re-run.
//  Rate limited: REQ_PER_SECOND requests/sec.
//
//  Usage:
//    railway run node fetch-newegg-via-rakuten.cjs --dry-run
//      Full live scoring pass that writes NOTHING — no parts.js, no progress
//      file, no in-memory attach. Emits newegg-ingest-dry-run.json with every
//      accepted candidate and every variant rejection (both names), so the
//      shared matcher can be eyeballed on the ingest path before a live write.
//    railway run node fetch-newegg-via-rakuten.cjs --limit 50
//    railway run node fetch-newegg-via-rakuten.cjs
//    railway run node fetch-newegg-via-rakuten.cjs --force
//    railway run node fetch-newegg-via-rakuten.cjs --category CPU
// =============================================================================

const fs = require('fs');
const path = require('path');

// Newegg matching + capacity guard + first-party preference + sanity gate
// (shared ESM, dynamic-imported at startup). newegg-match.js owns the capacity
// gate internally, so this file no longer needs its own CAP handle.
let NEG = null;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const LIMIT = arg('limit', null) ? parseInt(arg('limit'), 10) : null;
const ONLY_CAT = arg('category', null);

const PARTS_PATH = './src/data/parts.js';
const PROGRESS_PATH = './catalog-build/_newegg-progress.json';
const DRY_REPORT = './newegg-ingest-dry-run.json';

const REQ_PER_SECOND = 2;
const SAVE_EVERY = 25;

const CID = process.env.RAKUTEN_CLIENT_ID;
const SECRET = process.env.RAKUTEN_CLIENT_SECRET;
const SID = process.env.RAKUTEN_SID;
const MID = process.env.RAKUTEN_NEWEGG_MID;
if (!CID || !SECRET || !SID || !MID) {
  console.error('  ✗ Missing Rakuten env vars'); process.exit(1);
}

// Verified Newegg category filters (from earlier discovery tests).
const CAT_FILTER = {
  CPU:         'Processors',
  Motherboard: 'Motherboards',
  RAM:         'Memory',
  Storage:     'Storage Devices',
  PSU:         'Power Supplies',
  Case:        'Desktop Computer & Server Cases',
  CPUCooler:   'Computer System Cooling Parts',
  CaseFan:     'Computer System Cooling Parts',
  Monitor:     'Monitors',
  // GPU intentionally omitted — awaiting SFTP feed.
};

let cachedToken = null;
let tokenExpiresAt = 0;
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;
  const basic = 'Basic ' + Buffer.from(`${CID}:${SECRET}`).toString('base64');
  const res = await fetch('https://api.linksynergy.com/token', {
    method: 'POST',
    headers: { 'Authorization': basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', scope: SID }).toString(),
  });
  if (!res.ok) throw new Error(`Token HTTP ${res.status}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

function xmlField(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function parseItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    items.push({
      name: decodeEntities(xmlField(b, 'productname') || ''),
      sku: xmlField(b, 'sku') || '',
      upc: xmlField(b, 'upccode') || '',
      price: parseFloat(xmlField(b, 'price')) || null,
      saleprice: (() => { const v = parseFloat(xmlField(b, 'saleprice')); return v > 0 ? v : null; })(),
      linkurl: decodeEntities(xmlField(b, 'linkurl') || ''),
      imageurl: decodeEntities(xmlField(b, 'imageurl') || ''),
      secondary: decodeEntities(xmlField(b, 'secondary') || ''),
    });
  }
  return items;
}

// Scoring lives in newegg-match.js (NEG.scoreMatch / NEG.extractKeywords).
//
// This file used to carry a verbatim COPY of scoreMatch + nameSimilarity +
// extractKeywords. The copy is why the variant-collapse guard, added to
// newegg-match.js, protected the refresh path but not this one — ingest is
// where the wrong-product deals entered the catalog in the first place.
// Do not re-fork: one matcher, one place, both paths.

async function findNeweggMatch(product, token) {
  const catFilter = CAT_FILTER[product.c];
  if (!catFilter) return { ok: false, reason: 'no_cat_mapping' };
  const keywords = NEG.extractKeywords(product.n, product.b);

  // Try exact= first (more precise), then keyword= fallback.
  const queries = [
    { exact: keywords, cat: catFilter, mid: MID, max: '20' },
    { keyword: keywords, cat: catFilter, mid: MID, max: '20' },
  ];

  let items = [];
  for (const params of queries) {
    const url = `https://api.linksynergy.com/productsearch/1.0?${new URLSearchParams(params)}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) continue;
    const xml = await res.text();
    items = parseItems(xml);
    if (items.length > 0) break;
  }
  if (items.length === 0) {
    return { ok: false, reason: 'no_results', rawCount: 0, scores: [], variantRejects: [] };
  }

  // Capture WHY each candidate lost, not just that it did. The dry run reports
  // this verbatim; without it a variant rejection is indistinguishable from
  // "the feed had nothing", which is the ambiguity that hid the bad matches.
  const variantRejects = [];
  const scored = [];
  for (const it of items) {
    const notes = {};
    const match = NEG.scoreMatch(product, it, notes);
    if (match) scored.push({ item: it, match });
    else if (notes.reject) {
      variantRejects.push({ candidateName: it.name, sku: it.sku, reason: notes.reject });
    }
  }
  const detail = {
    rawCount: items.length,
    variantRejects,
    scores: scored.map((x) => ({
      candidateName: x.item.name, sku: x.item.sku,
      sellerClass: NEG.sellerClass(x.item.sku),
      method: x.match.method, score: Number(x.match.score.toFixed(3)),
    })),
  };

  if (scored.length === 0) {
    return { ok: false, reason: variantRejects.length ? 'variant_rejected' : 'no_match', ...detail };
  }
  // First-party (N82E) preference — never let a marketplace (9SI) listing win when a
  // Newegg-Official listing also matched. Price-independent (see newegg-match.js).
  const best = NEG.selectWithFirstPartyPreference(scored);
  const firstPartyAvailable = scored.some((x) => NEG.isFirstParty(x.item.sku));
  return {
    ok: true, item: best.item, method: best.match.method, score: best.match.score,
    firstPartyAvailable, ...detail,
  };
}

// parts.js is no longer a literal array. scripts/split-parts-by-cat.cjs now
// generates it as a BARREL of per-category chunk imports:
//
//   import _4 from './parts/cpu.js';  ...
//   export const PARTS = [..._4, ..._17, ...];
//
// The old loader regex-matched that bracket expression and eval'd it with
// `new Function`, where _4 and friends do not exist — so ingest died at
// startup with "ReferenceError: _4 is not defined" on every invocation, live
// or dry. Import the module and let ESM resolve the chunks, exactly as
// refresh-newegg-prices.cjs already does.
async function loadParts() {
  const url = 'file://' + path.resolve(PARTS_PATH).replace(/\\/g, '/') + '?t=' + Date.now();
  const mod = await import(url);
  const parts = mod.PARTS || mod.default;
  if (!Array.isArray(parts)) throw new Error(`PARTS is not an array in ${PARTS_PATH}`);
  return { parts };
}

// The WRITE path is worse than broken — it is destructive. It replaced the
// whole `export const PARTS = [...]` barrel with a JSON literal, which would
// have wiped the chunk composition and orphaned all 30 imports, leaving the
// frontend loading stale src/data/parts/<cat>.js files. Refuse loudly instead
// of corrupting the catalog; a live ingest must write per-category chunks.
function assertWritePathUsable() {
  const src = fs.readFileSync(PARTS_PATH, 'utf8');
  if (/export\s+const\s+PARTS\s*=\s*\[\s*\.\.\./.test(src)) {
    throw new Error(
      'LIVE INGEST BLOCKED: src/data/parts.js is an auto-generated barrel of\n' +
      '  per-category chunk imports (scripts/split-parts-by-cat.cjs), not a literal\n' +
      '  array. Overwriting it with a JSON literal would destroy the chunk structure\n' +
      '  and orphan every import. The write path must target src/data/parts/<cat>.js\n' +
      '  before this script may run live. --dry-run is unaffected and works.',
    );
  }
}

// Late backstop. assertWritePathUsable() fires first at startup; this exists so
// the call sites below cannot silently become a corrupting write if that guard
// is ever moved or removed.
function saveParts() {
  assertWritePathUsable();
  throw new Error('saveParts(): no write path implemented for the chunked catalog. Use --dry-run.');
}
function loadProgress() {
  if (!fs.existsSync(PROGRESS_PATH)) return { matched: 0, no_match: 0, errors: 0, processedIds: [] };
  return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
}
function saveProgress(p) {
  fs.mkdirSync(path.dirname(PROGRESS_PATH), { recursive: true });
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(p, null, 2));
}

(async () => {
  console.log('\n  Newegg Catalog Match via Rakuten Product Search');
  console.log('  ═══════════════════════════════════════════════');

  NEG = await import('file://' + process.cwd().replace(/\\/g, '/') + '/newegg-match.js');

  // Fail before spending a single API call if this run could not write anyway.
  if (!DRY_RUN) assertWritePathUsable();

  const { parts } = await loadParts();
  let active = parts.filter((p) => !p.needsReview && !p.bundle && p.n && CAT_FILTER[p.c]);
  if (ONLY_CAT) {
    if (!CAT_FILTER[ONLY_CAT]) {
      console.error(`  ✗ No cat mapping for "${ONLY_CAT}". Available: ${Object.keys(CAT_FILTER).join(', ')}`);
      process.exit(1);
    }
    active = active.filter((p) => p.c === ONLY_CAT);
  }

  console.log(`  Eligible (excluding GPUs): ${active.length}`);

  const progress = loadProgress();
  const processed = new Set(progress.processedIds);
  let candidates = active.filter((p) => {
    if (FORCE) return true;
    if (p?.deals?.newegg?.sku) return false;
    if (processed.has(p.id)) return false;
    return true;
  });

  if (LIMIT) candidates = candidates.slice(0, LIMIT);
  console.log(`  To process this run: ${candidates.length}`);
  if (FORCE) console.log('  (--force)');
  if (LIMIT) console.log(`  (--limit ${LIMIT})`);
  if (ONLY_CAT) console.log(`  (--category ${ONLY_CAT})`);
  console.log('');

  if (candidates.length === 0) { console.log('  Nothing to do.\n'); return; }

  // --dry-run used to return HERE, before getToken(), so it never scored a
  // single candidate and could not exercise the shared matcher at all — the
  // one path that most needed proving, since ingest is how bad matches enter
  // the catalog. It now runs the full live scoring pass and writes NOTHING:
  // no parts.js, no progress file, no in-memory mutation of p.deals/needsReview.
  if (DRY_RUN) {
    console.log('  --dry-run: scoring live responses, writing nothing.\n');
  }

  let matched = 0, noMatch = 0, errors = 0, flagged = 0;
  // Dry-run report accumulators.
  const dryStats = { scored: 0, accepted: 0, flagged: 0, variantRejected: 0, noMatch: 0, noResults: 0, errors: 0 };
  const dryAccepts = [];
  const dryRejects = [];
  const delay = 1000 / REQ_PER_SECOND;
  await getToken();
  console.log('  ✓ Token acquired\n');

  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    const tick = `[${(i + 1).toString().padStart(4)}/${candidates.length}]`;
    const cat = `[${p.c.slice(0, 4).padEnd(4)}]`;
    process.stdout.write(`  ${tick} ${cat} id ${String(p.id).padEnd(6)} ${p.n.slice(0, 45).padEnd(45)} `);

    try {
      const token = await getToken();
      const result = await findNeweggMatch(p, token);

      if (DRY_RUN) {
        dryStats.scored += result.scores ? result.scores.length : 0;
        dryStats.variantRejected += result.variantRejects ? result.variantRejects.length : 0;
        if (result.variantRejects && result.variantRejects.length) {
          dryRejects.push({
            id: p.id, cat: p.c, ourName: p.n,
            rejected: result.variantRejects,
            // Whether anything survived matters: a product with rejects AND an
            // accepted candidate is the guard working; rejects with nothing left
            // is the guard possibly over-reaching.
            survivors: result.scores ? result.scores.length : 0,
          });
        }
      }

      if (result.ok) {
        const sClass = NEG.sellerClass(result.item.sku);
        const effPrice = (result.item.saleprice && result.item.saleprice > 0)
          ? result.item.saleprice : result.item.price;
        const sanity = NEG.neweggSanity(p, effPrice);

        if (DRY_RUN) {
          if (sanity.pass) { dryStats.accepted++; } else { dryStats.flagged++; }
          dryAccepts.push({
            id: p.id, cat: p.c, ourName: p.n,
            candidateName: result.item.name, sku: result.item.sku, sellerClass: sClass,
            method: result.method, score: Number(result.score.toFixed(3)),
            price: effPrice, wouldAttach: sanity.pass, sanityClass: sanity.cls,
            firstPartyAvailable: result.firstPartyAvailable,
          });
          const tag = result.method === 'upc' ? '✓ UPC' : `~ ${(result.score * 100).toFixed(0)}%`;
          console.log(`${sanity.pass ? tag : '⚠ flag ' + sanity.cls}  $${effPrice} [${sClass}] (dry)`);
          if (i < candidates.length - 1) await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        if (!sanity.pass) {
          // Chosen price is a wild outlier vs the product's other retailers — do not
          // attach; flag for review (mirrors the Amazon attach gate). The first-party
          // selection still happened; only the WRITE is withheld.
          flagged++;
          p.needsReview = true;
          p.quarantinedAt = new Date().toISOString().slice(0, 10);
          console.log(`⚠ flag ${sanity.cls}${sanity.dispConflict ? ` ${sanity.spread.toFixed(2)}x` : ''} (${sClass})`);
        } else {
          p.deals = p.deals || {};
          p.deals.newegg = {
            sku: result.item.sku,
            price: result.item.price,
            saleprice: result.item.saleprice,
            linkurl: result.item.linkurl,
            imageurl: result.item.imageurl,
            sellerClass: sClass,
            matchedAt: new Date().toISOString().slice(0, 10),
            matchMethod: result.method,
            matchScore: Number(result.score.toFixed(2)),
          };
          matched++;
          const tag = result.method === 'upc' ? '✓ UPC' : `~ ${(result.score * 100).toFixed(0)}%`;
          const priceStr = result.item.saleprice ? `$${result.item.saleprice}` : `$${result.item.price}`;
          console.log(`${tag}  ${priceStr} [${sClass}]`);
        }
      } else {
        noMatch++;
        if (DRY_RUN) {
          if (result.reason === 'variant_rejected') { /* already counted above */ }
          else if (result.reason === 'no_results') dryStats.noResults++;
          else dryStats.noMatch++;
        } else {
          progress.processedIds.push(p.id);
        }
        console.log(`✗ ${result.reason}`);
      }
    } catch (e) {
      errors++;
      dryStats.errors++;
      console.log(`! ${e.message.slice(0, 50)}`);
    }

    if (!DRY_RUN && (i + 1) % SAVE_EVERY === 0) {
      saveProgress({ matched, no_match: noMatch, errors, processedIds: progress.processedIds });
      saveParts();
      console.log(`  ── checkpoint: ${matched} matched, ${noMatch} no-match, ${errors} errors ──`);
    }

    if (i < candidates.length - 1) await new Promise((r) => setTimeout(r, delay));
  }

  if (DRY_RUN) {
    const report = {
      timestamp: new Date().toISOString(),
      dryRun: true,
      wroteParts: false,
      wroteProgress: false,
      processed: candidates.length,
      ...dryStats,
      accepts: dryAccepts,
      variantRejections: dryRejects,
    };
    fs.writeFileSync(DRY_REPORT, JSON.stringify(report, null, 2));

    console.log('\n  ═══ DRY RUN — NOTHING WRITTEN ═══');
    console.log(`  Products probed:     ${candidates.length}`);
    console.log(`  Candidates scored:   ${dryStats.scored}  (passed every gate)`);
    console.log(`  Would attach:        ${dryStats.accepted}`);
    console.log(`  Would flag (sanity): ${dryStats.flagged}  (not attached)`);
    console.log(`  Variant-rejected:    ${dryStats.variantRejected}  (candidates, across ${dryRejects.length} products)`);
    console.log(`  No match:            ${dryStats.noMatch}`);
    console.log(`  No results:          ${dryStats.noResults}`);
    console.log(`  Errors:              ${dryStats.errors}`);
    console.log(`  Report:              ${DRY_REPORT}\n`);
    return;
  }

  saveProgress({ matched, no_match: noMatch, errors, processedIds: progress.processedIds });
  const backup = saveParts();

  console.log('\n  ═══ DONE ═══');
  console.log(`  Matched:    ${matched}`);
  console.log(`  Flagged:    ${flagged} (sanity-gate outliers, not attached)`);
  console.log(`  No match:   ${noMatch}`);
  console.log(`  Errors:     ${errors}`);
  console.log(`  Backup:     ${backup}\n`);
})();
