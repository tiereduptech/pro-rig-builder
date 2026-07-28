// ingest-msi-impact-v2.cjs — Phase 1 MSI Impact integration (revised)
//
// CHANGES from v1:
//   - Fixed parts.js write logic to preserve `export const PARTS = [...]; export default PARTS;`
//   - Added safety check: UPC matches are rejected if normalized product names
//     diverge too much (catches data errors where two different SKUs share a UPC)
//   - Suspicious UPC matches are logged to catalog-build/msi-suspicious.json
//     for manual review instead of silently applying a wrong link.
//
// Usage:
//   railway run node ingest-msi-impact-v2.cjs           (dry run)
//   railway run node ingest-msi-impact-v2.cjs --write   (apply to parts.js)

const fs = require('fs');
const path = require('path');

const WRITE = process.argv.includes('--write');
const CATALOG_ID = 16410;
const CAMPAIGN_NAME = 'MSI';

const SID = process.env.IMPACT_ACCOUNT_SID;
const TOKEN = process.env.IMPACT_AUTH_TOKEN;
// Only enforce credentials when run directly as a CLI. When this file is
// require()'d for its pure safety-check helpers (normName / nameTokenOverlap /
// extractSuffix), it must not exit — those helpers do no network I/O.
if (require.main === module && (!SID || !TOKEN)) {
  console.error('✗ Missing IMPACT_ACCOUNT_SID / IMPACT_AUTH_TOKEN.');
  console.error('  Run via: railway run node ingest-msi-impact-v2.cjs');
  process.exit(1);
}
const BASE = `https://api.impact.com/Mediapartners/${SID}`;
const AUTH = 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');

async function api(pathStr, params = {}) {
  const url = new URL(BASE + pathStr);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: AUTH, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Impact API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Normalization ────────────────────────────────────────────────────
function normUPC(s) {
  if (!s) return '';
  return String(s).replace(/[^0-9]/g, '').replace(/^0+/, '');
}
function normMPN(s) {
  if (!s) return '';
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function normName(s) {
  if (!s) return '';
  return String(s)
    .toUpperCase()
    .replace(/MSI/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Token-based similarity for the UPC safety check.
// Returns 0..1 — fraction of Impact name tokens found in catalog name.
function nameTokenOverlap(impactName, catalogName) {
  const a = new Set(normName(impactName).split(' ').filter(t => t.length >= 2));
  const b = new Set(normName(catalogName).split(' ').filter(t => t.length >= 2));
  if (!a.size || !b.size) return 0;
  let hits = 0;
  for (const t of a) if (b.has(t)) hits++;
  return hits / a.size;
}

// Extra signal — extract distinctive model suffix letters (e.g. -A, -S, -P)
// from chassis/board names so PRO Z890-A and PRO Z890-S aren't treated equal.
function extractSuffix(name) {
  if (!name) return '';
  const m = String(name).toUpperCase().match(/[A-Z]\d{3,4}-([A-Z]+)\b/);
  return m ? m[1] : '';
}

// ─── Pull full Impact catalog (paginated) ─────────────────────────────
async function fetchAllMSIItems() {
  const all = [];
  let page = 1;
  const perPage = 500;
  while (true) {
    process.stdout.write(`  Fetching page ${page}... `);
    const data = await api(`/Catalogs/${CATALOG_ID}/Items`, {
      Page: page,
      PageSize: perPage,
    });
    const items = data?.Items || [];
    all.push(...items);
    console.log(`got ${items.length} (total ${all.length})`);
    if (items.length < perPage) break;
    page++;
    if (page > 20) { console.log('  [safety stop at 20 pages]'); break; }
  }
  return all;
}

// Exported for reuse by the same-domain wrong-ASIN detector so the safety-check
// logic (token overlap + distinctive model-suffix) lives in exactly one place.
module.exports = { normUPC, normMPN, normName, nameTokenOverlap, extractSuffix };

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log(`MSI Impact ingest v2 — ${WRITE ? 'WRITE MODE' : 'DRY RUN'}`);
  console.log(`Catalog ID: ${CATALOG_ID}  Campaign: ${CAMPAIGN_NAME}\n`);

  // 1. Load parts.js
  console.log('Loading src/data/parts.js...');
  const partsPath = 'src/data/parts.js';
  const partsModule = await import(
    'file://' + process.cwd().replace(/\\/g, '/') + '/' + partsPath + '?t=' + Date.now()
  );
  const parts = partsModule.default;
  console.log(`  ${parts.length} products in catalog\n`);

  // 2. Fetch all MSI items from Impact
  console.log('Fetching MSI catalog from Impact...');
  const msiItems = await fetchAllMSIItems();
  console.log(`  ${msiItems.length} total MSI items from Impact\n`);

  // 3. Build lookup indexes. UPC may collide (you have catalog duplicates),
  //    so store ARRAYS of candidates per key, not single products.
  const msiParts = parts.filter(p => (p.b || '').toUpperCase() === 'MSI');
  const byUPC = new Map();   // upc -> [parts]
  const byMPN = new Map();   // mpn -> [parts]
  const byName = new Map();  // name -> [parts]
  const pushTo = (map, key, p) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  };
  for (const p of msiParts) {
    pushTo(byUPC, normUPC(p.upc), p);
    pushTo(byMPN, normMPN(p.mpn), p);
    pushTo(byMPN, normMPN(p.model), p);
    pushTo(byName, normName(p.n), p);
  }
  console.log(`Indexes: ${byUPC.size} UPC keys, ${byMPN.size} MPN keys, ${byName.size} name keys\n`);

  // 4. Match — UPC first, with safety check
  const stats = { upc: 0, mpn: 0, name: 0, unmatched: 0, suspicious: 0 };
  const matches = [];
  const unmatched = [];
  const suspicious = [];

  // Pick the catalog candidate that best matches the Impact name from a list.
  // Returns { part, overlap } or null.
  function pickBest(candidates, impactName) {
    let best = null;
    for (const p of candidates) {
      const ov = nameTokenOverlap(impactName, p.n);
      if (!best || ov > best.overlap) best = { part: p, overlap: ov };
    }
    return best;
  }

  for (const it of msiItems) {
    const impactUPC = normUPC(it.Gtin);
    const impactMPN = normMPN(it.Mpn);
    const impactName = normName(it.Name);
    const impactSuffix = extractSuffix(it.Name);

    let chosen = null;
    let tier = null;

    // Tier 1: UPC — but require >=40% name token overlap AND matching suffix.
    if (impactUPC && byUPC.has(impactUPC)) {
      const best = pickBest(byUPC.get(impactUPC), it.Name);
      if (best) {
        const catSuffix = extractSuffix(best.part.n);
        const suffixOK = !impactSuffix || !catSuffix || impactSuffix === catSuffix;
        if (best.overlap >= 0.4 && suffixOK) {
          chosen = best.part;
          tier = 'upc';
        } else {
          // suspicious — log and skip
          suspicious.push({
            reason: !suffixOK ? 'suffix-mismatch' : 'low-name-overlap',
            overlap: Number(best.overlap.toFixed(2)),
            impact: { name: it.Name, gtin: it.Gtin, mpn: it.Mpn, url: it.Url },
            candidate: { id: best.part.id, name: best.part.n, upc: best.part.upc },
          });
          stats.suspicious++;
        }
      }
    }

    // Tier 2: MPN
    if (!chosen && impactMPN && byMPN.has(impactMPN)) {
      const best = pickBest(byMPN.get(impactMPN), it.Name);
      if (best && best.overlap >= 0.4) {
        chosen = best.part;
        tier = 'mpn';
      }
    }

    // Tier 3: normalized name — exact key match only
    if (!chosen && impactName && byName.has(impactName)) {
      const best = pickBest(byName.get(impactName), it.Name);
      if (best && best.overlap >= 0.6) {
        chosen = best.part;
        tier = 'name';
      }
    }

    if (chosen) {
      stats[tier]++;
      matches.push({ part: chosen, impact: it, tier });
    } else if (!suspicious.find(s => s.impact.gtin === it.Gtin && s.impact.name === it.Name)) {
      stats.unmatched++;
      unmatched.push({
        catalogItemId: it.CatalogItemId,
        name: it.Name,
        category: it.Category,
        mpn: it.Mpn,
        gtin: it.Gtin,
        price: it.CurrentPrice,
        stock: it.StockAvailability,
        url: it.Url,
        image: it.ImageUrl,
      });
    }
  }

  // 5. Report
  console.log('═══════════════════════════════════════════════════════');
  console.log('MATCH RESULTS');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Impact MSI items:    ${msiItems.length}`);
  console.log(`  Matched by UPC:      ${stats.upc}`);
  console.log(`  Matched by MPN:      ${stats.mpn}`);
  console.log(`  Matched by name:     ${stats.name}`);
  console.log(`  Total matched:       ${stats.upc + stats.mpn + stats.name}`);
  console.log(`  Suspicious (skip):   ${stats.suspicious}`);
  console.log(`  Unmatched (Phase 2): ${stats.unmatched}`);
  console.log('');
  console.log('Sample matches:');
  for (const m of matches.slice(0, 8)) {
    console.log(`  [${m.tier.toUpperCase()}] ${m.impact.Name}`);
    console.log(`         -> ${m.part.n} (id ${m.part.id})`);
  }
  if (suspicious.length) {
    console.log('');
    console.log(`Sample suspicious (skipped, logged for review):`);
    for (const s of suspicious.slice(0, 5)) {
      console.log(`  [${s.reason}] overlap=${s.overlap}`);
      console.log(`    Impact:    ${s.impact.name}`);
      console.log(`    Candidate: ${s.candidate.name}`);
    }
  }
  console.log('');

  // 6. Save reports
  const outDir = 'catalog-build';
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'msi-unmatched.json'), JSON.stringify(unmatched, null, 2));
  fs.writeFileSync(path.join(outDir, 'msi-suspicious.json'), JSON.stringify(suspicious, null, 2));
  console.log(`Reports written to ${outDir}/msi-unmatched.json and msi-suspicious.json`);

  // 7. DRY RUN — stop here
  if (!WRITE) {
    console.log('');
    console.log('=== DRY RUN — no changes written ===');
    console.log('Re-run with --write to apply changes to parts.js');
    return;
  }

  // 8. WRITE MODE — apply deals.msi
  console.log('\nApplying deals.msi to matched products...');
  for (const m of matches) {
    const p = m.part;
    const price = parseFloat(m.impact.CurrentPrice);
    if (!p.deals) p.deals = {};
    p.deals.msi = {
      price: isNaN(price) ? null : price,
      url: m.impact.Url,
      inStock: String(m.impact.StockAvailability).toLowerCase() === 'instock',
    };
  }

  // 9. Rewrite parts.js — preserve format:
  //      // Auto-merged catalog. Edit with care.
  //      export const PARTS = [...];
  //      export default PARTS;
  const raw = fs.readFileSync(partsPath, 'utf8').replace(/^\uFEFF/, '');

  // Find the leading comment line(s) before `export const PARTS`
  const headerMatch = raw.match(/^([\s\S]*?)export\s+const\s+PARTS\s*=\s*\[/);
  if (!headerMatch) {
    console.error('ERROR: Could not find `export const PARTS = [` in parts.js. Aborting write.');
    process.exit(1);
  }
  const header = headerMatch[1]; // everything before "export const PARTS = ["

  const serialized = JSON.stringify(parts, null, 2);
  const newContent = header + 'export const PARTS = ' + serialized + ';\nexport default PARTS;\n';

  // Backup before overwriting
  const backupPath = partsPath + '.bak-' + Date.now();
  fs.copyFileSync(partsPath, backupPath);
  console.log(`Backup: ${backupPath}`);

  fs.writeFileSync(partsPath, newContent, { encoding: 'utf8' });
  console.log(`Wrote ${parts.length} products to ${partsPath}`);
  console.log('');
  console.log(`Applied deals.msi to ${matches.length} products.`);
  console.log('Next step: run `npm run build` then commit.');
}

if (require.main === module) {
  main().catch(e => {
    console.error('FATAL:', e);
    process.exit(1);
  });
}
