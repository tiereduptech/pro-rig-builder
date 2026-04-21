#!/usr/bin/env node
/**
 * fetch-amazon-images-html.js
 *
 * DataForSEO's Amazon scraper returns "No Search Results" for ASINs that
 * ARE live on Amazon (confirmed via direct HTTP HEAD). Their scraper appears
 * geo-bound or bot-blocked.
 *
 * Switch approach: fetch the Amazon product page HTML directly and parse
 * the og:image meta tag. No API cost.
 *
 * Usage:
 *   node fetch-amazon-images-html.js --dry
 *   node fetch-amazon-images-html.js
 *   node fetch-amazon-images-html.js WiFiCard
 */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const targetCat = args.find(a => !a.startsWith('--'));
const TARGET_CATS = targetCat ? [targetCat] : ['OpticalDrive', 'WiFiCard', 'EthernetCard', 'SoundCard'];

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = [...mod.PARTS];

// ─── Check existing images ─────────────────────────────────────────────────
async function checkUrl(url) {
  if (!url) return false;
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.status >= 200 && r.status < 300;
  } catch {
    return false;
  }
}

// ─── Scrape Amazon product page for image ──────────────────────────────────
// Uses a realistic user-agent to avoid the simplest bot detection
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchAmazonImage(asin) {
  const url = `https://www.amazon.com/dp/${asin}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const html = await res.text();

    // Strategy 1: og:image meta tag (most reliable)
    const og = html.match(/<meta\s+(?:property|name)="og:image"\s+content="([^"]+)"/i)
            || html.match(/<meta\s+content="([^"]+)"\s+(?:property|name)="og:image"/i);
    if (og && og[1]) return { ok: true, url: og[1] };

    // Strategy 2: "landingImage" pattern used on most product pages
    const li = html.match(/"hiRes":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
    if (li && li[1]) return { ok: true, url: li[1].replace(/\\u[\d]{4}/g, '').replace(/\\\//g, '/') };

    // Strategy 3: data-old-hires on the main image
    const oh = html.match(/data-old-hires="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
    if (oh && oh[1]) return { ok: true, url: oh[1] };

    // Strategy 4: grab first /images/I/ URL
    const first = html.match(/https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9+-]+\._AC_[^"'\s]+\.(jpg|png|webp)/);
    if (first && first[0]) return { ok: true, url: first[0] };

    return { ok: false, reason: 'No image pattern matched' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ─── SCOPE ─────────────────────────────────────────────────────────────────
console.log('━━━ CHECKING IMAGE URLS ━━━');
const candidates = [];
for (const p of parts) {
  if (!TARGET_CATS.includes(p.c)) continue;
  if (!p.asin) continue;
  const ok = await checkUrl(p.img);
  if (!ok) candidates.push(p);
}
console.log(`  ${candidates.length} products need fresh images`);
for (const c of TARGET_CATS) {
  const all = parts.filter(p => p.c === c && p.asin);
  const needs = candidates.filter(p => p.c === c);
  console.log(`    ${c.padEnd(14)} ${needs.length}/${all.length}`);
}

if (DRY) {
  console.log('\n--dry; exiting');
  process.exit(0);
}
if (!candidates.length) {
  console.log('\nNothing to do.');
  process.exit(0);
}

// ─── FETCH ─────────────────────────────────────────────────────────────────
console.log(`\n━━━ SCRAPING ${candidates.length} AMAZON PAGES ━━━`);
console.log('  (2.5s delay between requests to avoid rate-limiting)\n');

const results = new Map();
const failures = [];
let done = 0;

for (const p of candidates) {
  done++;
  process.stdout.write(`  [${done}/${candidates.length}] ${p.asin} ${p.n.slice(0, 50).padEnd(52)} ... `);
  const r = await fetchAmazonImage(p.asin);
  if (r.ok) {
    results.set(p.asin, r.url);
    console.log('OK');
  } else {
    failures.push({ asin: p.asin, name: p.n, reason: r.reason });
    console.log(`FAIL (${r.reason})`);
  }

  // Save progress every 5 products
  if (done % 5 === 0) {
    for (const part of parts) {
      if (part.asin && results.has(part.asin)) part.img = results.get(part.asin);
    }
    const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
    writeFileSync('./src/data/parts.js', source);
  }

  // Delay between requests to avoid bot detection
  await new Promise(r => setTimeout(r, 2500));
}

// Final save
for (const p of parts) {
  if (p.asin && results.has(p.asin)) p.img = results.get(p.asin);
}
const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);

console.log(`\n━━━ RESULTS ━━━`);
console.log(`  Fetched: ${results.size}`);
console.log(`  Failed:  ${failures.length}`);
if (failures.length) {
  console.log(`\n  Failures:`);
  failures.forEach(f => console.log(`    ${f.asin} | ${f.name.slice(0, 60)} | ${f.reason}`));
}

// Final verification
console.log(`\n━━━ VERIFYING LIVE URLS ━━━`);
for (const c of TARGET_CATS) {
  const all = parts.filter(p => p.c === c);
  let live = 0;
  for (const p of all) {
    if (!p.img) continue;
    const ok = await checkUrl(p.img);
    if (ok) live++;
  }
  console.log(`  ${c.padEnd(14)} ${live}/${all.length} live`);
}

console.log('\nDone.');
