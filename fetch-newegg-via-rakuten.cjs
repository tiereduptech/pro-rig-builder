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
//    railway run node fetch-newegg-via-rakuten.cjs --limit 50
//    railway run node fetch-newegg-via-rakuten.cjs
//    railway run node fetch-newegg-via-rakuten.cjs --force
//    railway run node fetch-newegg-via-rakuten.cjs --category CPU
// =============================================================================

const fs = require('fs');
const path = require('path');

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

const MIN_NAME_SIM = 0.5;
const MAX_PRICE_MULTIPLIER = 2.5;
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

function normalizeUpc(upc) {
  return String(upc || '').replace(/^0+/, '').replace(/\D/g, '');
}
function nameSimilarity(a, b) {
  const norm = (s) => new Set(
    String(s).toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 2)
  );
  const A = norm(a), B = norm(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  if (inter < 3) return 0;
  const containment = inter / Math.min(A.size, B.size);
  const jaccard = inter / (A.size + B.size - inter);
  return Math.max(containment, jaccard);
}

function extractKeywords(name, brand) {
  let s = String(name || '')
    .replace(/Gaming Graphics Card|Graphics Card|Video Card/gi, '')
    .replace(/PCIe \d+\.\d+|HDMI \d+\.\d+|DisplayPort \d+\.\d+/gi, '')
    .replace(/GDDR\d+(\s*Memory)?|DDR\d+\s*Memory/gi, '')
    .replace(/Edition|Memory|Motherboard|Desktop Processor/gi, '')
    .replace(/[-,()|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = s.split(' ').filter(Boolean).slice(0, 8);
  let q = words.join(' ');
  if (brand && !q.toLowerCase().includes(brand.toLowerCase())) {
    q = `${brand} ${q}`;
  }
  return q.slice(0, 100);
}

function scoreMatch(ourProduct, neweggItem) {
  if (ourProduct.pr && neweggItem.price && neweggItem.price > ourProduct.pr * MAX_PRICE_MULTIPLIER) return null;
  if (/\b(Custom|Workstation|Desktop PC|Pre.?built|Gaming PC|Gaming Desktop|Bundle|Combo)\b/i.test(neweggItem.name)) return null;

  const ourUpcN = normalizeUpc(ourProduct.upc || ourProduct.UPC);
  const newUpcN = normalizeUpc(neweggItem.upc);
  if (ourUpcN && newUpcN && ourUpcN === newUpcN) return { method: 'upc', score: 1.0 };

  const sim = nameSimilarity(ourProduct.n, neweggItem.name);
  if (sim >= MIN_NAME_SIM) return { method: 'name', score: sim };
  return null;
}

async function findNeweggMatch(product, token) {
  const catFilter = CAT_FILTER[product.c];
  if (!catFilter) return { ok: false, reason: 'no_cat_mapping' };
  const keywords = extractKeywords(product.n, product.b);

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
  if (items.length === 0) return { ok: false, reason: 'no_results' };

  const scored = items.map((it) => ({ item: it, match: scoreMatch(product, it) })).filter((x) => x.match);
  if (scored.length === 0) return { ok: false, reason: 'no_match' };
  scored.sort((a, b) => {
    if (a.match.method !== b.match.method) return a.match.method === 'upc' ? -1 : 1;
    return b.match.score - a.match.score;
  });
  const best = scored[0];
  return { ok: true, item: best.item, method: best.match.method, score: best.match.score };
}

function loadParts() {
  const src = fs.readFileSync(PARTS_PATH, 'utf8');
  const m = src.match(/export\s+const\s+PARTS\s*=\s*(\[[\s\S]*\]);/);
  if (!m) throw new Error('PARTS array not found');
  const parts = new Function('return ' + m[1])();
  return { src, parts };
}
function saveParts(src, parts) {
  const backup = PARTS_PATH + '.bak.' + Date.now();
  fs.writeFileSync(backup, src, 'utf8');
  const newJson = JSON.stringify(parts, null, 2);
  const newSrc = src.replace(/export\s+const\s+PARTS\s*=\s*\[[\s\S]*\];/, `export const PARTS = ${newJson};`);
  fs.writeFileSync(PARTS_PATH, newSrc, 'utf8');
  return backup;
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

  const { src, parts } = loadParts();
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

  if (DRY_RUN) {
    console.log('  Sample (first 10):');
    for (const p of candidates.slice(0, 10)) {
      console.log(`    [${p.c.padEnd(11)}] ${p.n.slice(0, 55)}`);
      console.log(`      cat=${CAT_FILTER[p.c]}, search="${extractKeywords(p.n, p.b)}"`);
    }
    console.log('\n  --dry-run: not making API calls.\n');
    return;
  }

  let matched = 0, noMatch = 0, errors = 0;
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

      if (result.ok) {
        p.deals = p.deals || {};
        p.deals.newegg = {
          sku: result.item.sku,
          price: result.item.price,
          saleprice: result.item.saleprice,
          linkurl: result.item.linkurl,
          imageurl: result.item.imageurl,
          matchedAt: new Date().toISOString().slice(0, 10),
          matchMethod: result.method,
          matchScore: Number(result.score.toFixed(2)),
        };
        matched++;
        const tag = result.method === 'upc' ? '✓ UPC' : `~ ${(result.score * 100).toFixed(0)}%`;
        const priceStr = result.item.saleprice ? `$${result.item.saleprice}` : `$${result.item.price}`;
        console.log(`${tag}  ${priceStr}`);
      } else {
        noMatch++;
        progress.processedIds.push(p.id);
        console.log(`✗ ${result.reason}`);
      }
    } catch (e) {
      errors++;
      console.log(`! ${e.message.slice(0, 50)}`);
    }

    if ((i + 1) % SAVE_EVERY === 0) {
      saveProgress({ matched, no_match: noMatch, errors, processedIds: progress.processedIds });
      saveParts(src, parts);
      console.log(`  ── checkpoint: ${matched} matched, ${noMatch} no-match, ${errors} errors ──`);
    }

    if (i < candidates.length - 1) await new Promise((r) => setTimeout(r, delay));
  }

  saveProgress({ matched, no_match: noMatch, errors, processedIds: progress.processedIds });
  const backup = saveParts(src, parts);

  console.log('\n  ═══ DONE ═══');
  console.log(`  Matched:    ${matched}`);
  console.log(`  No match:   ${noMatch}`);
  console.log(`  Errors:     ${errors}`);
  console.log(`  Backup:     ${backup}\n`);
})();
