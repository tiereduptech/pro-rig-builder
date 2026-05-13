// =============================================================================
//  test-rakuten-name-then-upc.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Tests the real matching strategy: search Newegg by extracted name keywords,
//  then validate the best match by comparing UPCs. If UPCs match → perfect
//  match. If no UPC match → fall back to name similarity scoring.
//
//  Usage:
//    railway run node test-rakuten-name-then-upc.cjs --id 30001
//    railway run node test-rakuten-name-then-upc.cjs --upc 197105470644
// =============================================================================

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const CID = process.env.RAKUTEN_CLIENT_ID;
const SECRET = process.env.RAKUTEN_CLIENT_SECRET;
const SID = process.env.RAKUTEN_SID;
const MID = process.env.RAKUTEN_NEWEGG_MID;

if (!CID || !SECRET || !SID || !MID) {
  console.error('  ✗ Missing Rakuten env vars'); process.exit(1);
}

async function getToken() {
  const basic = 'Basic ' + Buffer.from(`${CID}:${SECRET}`).toString('base64');
  const res = await fetch('https://api.linksynergy.com/token', {
    method: 'POST',
    headers: { 'Authorization': basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', scope: SID }).toString(),
  });
  return (await res.json()).access_token;
}

function xmlField(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}
function parseItems(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) items.push(m[1]);
  return items;
}

// Reduce a verbose product name to its most distinctive search-friendly form.
// e.g. "Dual NVIDIA GeForce RTX 3050 6GB OC Edition Gaming Graphics Card -
// PCIe 4.0, 6GB GDDR6 Memory, HDMI 2.1" → "ASUS Dual RTX 3050 6GB OC"
function extractSearchKeywords(name, brand) {
  // Remove vendor fluff and marketing phrases.
  let s = name
    .replace(/Gaming Graphics Card/gi, '')
    .replace(/Graphics Card/gi, '')
    .replace(/Video Card/gi, '')
    .replace(/PCIe \d+\.\d+/gi, '')
    .replace(/HDMI \d+\.\d+/gi, '')
    .replace(/DisplayPort \d+\.\d+/gi, '')
    .replace(/GDDR\d+/gi, '')
    .replace(/Memory/gi, '')
    .replace(/Edition/gi, '')
    .replace(/[-,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Cap at ~8 words (Rakuten works best with focused queries).
  const words = s.split(' ').filter(Boolean).slice(0, 8);
  let query = words.join(' ');

  // Prepend brand if not already in the truncated query.
  if (brand && !query.toLowerCase().includes(brand.toLowerCase())) {
    query = `${brand} ${query}`;
  }
  return query.slice(0, 100);
}

// Basic name similarity score 0-1 (token-based Jaccard).
function nameSimilarity(a, b) {
  const norm = (s) => new Set(
    s.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 2)
  );
  const A = norm(a), B = norm(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default || [];

  const id = arg('id', null);
  const upcArg = arg('upc', null);
  let product;
  if (id) product = parts.find((p) => String(p.id) === id);
  else if (upcArg) product = parts.find((p) => (p.upc || p.UPC) === upcArg);
  else product = parts.find((p) => (p.upc || p.UPC) && p.c === 'GPU');

  if (!product) { console.error('  ✗ Product not found'); process.exit(1); }

  const ourUpc = product.upc || product.UPC || null;
  const ourName = product.n;
  const ourBrand = product.b || '';

  console.log('\n  Rakuten Name+UPC Matching Test');
  console.log('  ═══════════════════════════════');
  console.log(`  Our product: ${ourName}`);
  console.log(`  Brand:       ${ourBrand}`);
  console.log(`  UPC:         ${ourUpc || '(none)'}`);

  const keywords = extractSearchKeywords(ourName, ourBrand);
  console.log(`  Search:      "${keywords}"\n`);

  const token = await getToken();
  const url = `https://api.linksynergy.com/productsearch/1.0?${new URLSearchParams({
    keyword: keywords,
    mid: MID,
    max: '20',
  })}`;
  console.log(`  GET ${url}`);

  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  const xml = await res.text();
  console.log(`    HTTP ${res.status}, ${xml.length} chars`);

  const total = parseInt(xmlField(xml, 'TotalMatches') || '0', 10);
  const items = parseItems(xml);
  console.log(`    Total matches: ${total}, returned ${items.length}\n`);

  if (items.length === 0) {
    console.log('  No matches found. Try different keywords.\n');
    return;
  }

  // Score every result by UPC match (perfect = 1.0) AND name similarity.
  const scored = items.map((item) => {
    const name = xmlField(item, 'productname') || '';
    const upc = xmlField(item, 'upccode') || '';
    const sku = xmlField(item, 'sku') || '';
    const price = xmlField(item, 'price') || '';
    const sale = xmlField(item, 'saleprice') || '';
    const link = xmlField(item, 'linkurl') || '';
    const upcMatch = ourUpc && upc && ourUpc === upc;
    const nameSim = nameSimilarity(ourName, name);
    return { name, upc, sku, price, sale, link, upcMatch, nameSim };
  });

  scored.sort((a, b) => {
    if (a.upcMatch !== b.upcMatch) return b.upcMatch - a.upcMatch;  // UPC match first
    return b.nameSim - a.nameSim;
  });

  console.log('  Top 5 candidates:');
  for (let i = 0; i < Math.min(5, scored.length); i++) {
    const r = scored[i];
    const tag = r.upcMatch ? '✓ UPC MATCH' : `name sim ${(r.nameSim * 100).toFixed(0)}%`;
    console.log(`\n  ${i + 1}. [${tag}] ${r.name.slice(0, 75)}`);
    console.log(`     SKU ${r.sku}  UPC ${r.upc}  Price $${r.price}  Sale $${r.sale}`);
    console.log(`     ${r.link.slice(0, 100)}...`);
  }
  console.log('');

  // Verdict
  const best = scored[0];
  if (best.upcMatch) {
    console.log(`  ✓ PERFECT MATCH (UPC): ${best.name.slice(0, 60)}`);
  } else if (best.nameSim >= 0.4) {
    console.log(`  ~ LIKELY MATCH (name sim ${(best.nameSim * 100).toFixed(0)}%): ${best.name.slice(0, 60)}`);
  } else {
    console.log(`  ✗ NO RELIABLE MATCH (best name sim ${(best.nameSim * 100).toFixed(0)}%)`);
  }
  console.log('');
})();
