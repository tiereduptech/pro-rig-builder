// ═══════════════════════════════════════════
// verify-asins.js — Two-Pass ASIN Verifier
// ═══════════════════════════════════════════
//
// Pass 1: Visit each /dp/ASIN page we already have
//   → Scrape product title, UPC(s), category, price from Item Details
//   → Compare Amazon title vs our product name
//   → Flag mismatches
//
// Pass 2: Re-search flagged products using name + category + UPC
//   → Update parts.js with corrected ASINs, prices, images, and UPCs
//
// USAGE:
//   node verify-asins.js              # run both passes
//   node verify-asins.js --pass1      # only verify (don't fix)
//   node verify-asins.js --pass2      # only fix (skip verify)
//   node verify-asins.js --fresh      # clear verify cache, start over
//
// Run from the rigfinder directory

import { readFileSync, writeFileSync, existsSync } from 'fs';

const TAG = 'tiereduptech-20';
const PASS1_ONLY = process.argv.includes('--pass1');
const PASS2_ONLY = process.argv.includes('--pass2');
const FRESH = process.argv.includes('--fresh');

const CAT_KEYWORDS = {
  CPU: ['processor', 'cpu', 'ryzen', 'core i', 'threadripper', 'epyc', 'xeon'],
  GPU: ['graphics', 'video card', 'geforce', 'radeon', 'rtx', 'rx ', 'arc '],
  Motherboard: ['motherboard', 'mainboard', 'mobo'],
  RAM: ['memory', 'ram', 'ddr4', 'ddr5', 'dimm'],
  Storage: ['ssd', 'hdd', 'hard drive', 'solid state', 'nvme', 'm.2'],
  PSU: ['power supply', 'psu', 'watt', ' atx '],
  Case: ['case', 'tower', 'chassis', 'enclosure', 'mid-tower', 'full tower'],
  CPUCooler: ['cooler', 'cooling', 'heatsink', 'aio', 'radiator'],
  CaseFan: ['fan', 'case fan'],
  Monitor: ['monitor', 'display', 'screen'],
  Keyboard: ['keyboard'],
  Mouse: ['mouse'],
  Headset: ['headset', 'headphone'],
  Webcam: ['webcam', 'camera'],
  Microphone: ['microphone', 'mic '],
  Chair: ['chair'],
  Desk: ['desk'],
};

const CAT_SEARCH = {
  CPU: 'desktop processor CPU', GPU: 'graphics card GPU', Motherboard: 'motherboard',
  RAM: 'desktop memory RAM kit', Storage: 'SSD internal drive', PSU: 'power supply PSU',
  Case: 'PC computer case', CPUCooler: 'CPU cooler heatsink', CaseFan: 'PC case fan',
  Monitor: 'computer monitor', Keyboard: 'keyboard', Mouse: 'mouse', Headset: 'headset',
  Webcam: 'webcam', Microphone: 'microphone', Chair: 'chair', Desk: 'desk',
};

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
function randomDelay() { return 3000 + Math.floor(Math.random() * 3000); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchPage(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': randomUA(), 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.5', 'Upgrade-Insecure-Requests': '1', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Cache-Control': 'max-age=0' },
        redirect: 'follow',
      });
      if (resp.status === 503 || resp.status === 429) {
        if (attempt < retries) { const w = 15000 + Math.floor(Math.random() * 10000); process.stdout.write(`\u23f3${Math.round(w/1000)}s `); await sleep(w); continue; }
        return null;
      }
      if (!resp.ok) return null;
      const html = await resp.text();
      if (html.includes('captcha') || html.includes('Type the characters') || html.length < 5000) {
        if (attempt < retries) { const w = 25000 + Math.floor(Math.random() * 15000); process.stdout.write(`\ud83e\udd16${Math.round(w/1000)}s `); await sleep(w); continue; }
        return null;
      }
      return html;
    } catch (err) { if (attempt < retries) { await sleep(5000); continue; } return null; }
  }
}

// ═══ CACHES ═══
const verifyCachePath = './src/data/verify-cache.json';
const amazonDataPath = './src/data/amazon-data.json';
let verifyCache = {};
let amazonData = {};
if (!FRESH && existsSync(verifyCachePath)) { try { verifyCache = JSON.parse(readFileSync(verifyCachePath, 'utf-8')); } catch(e) {} }
if (existsSync(amazonDataPath)) { try { amazonData = JSON.parse(readFileSync(amazonDataPath, 'utf-8')); } catch(e) {} }
if (FRESH) console.log('\ud83d\udd04 Fresh run\n');

// ═══ READ PRODUCTS ═══
const partsPath = './src/data/parts.js';
const partsContent = readFileSync(partsPath, 'utf-8');
const products = [];
const prodRegex = /\{id:(\d+),(?:img:"[^"]*",)?n:"([^"]+)".*?c:"([^"]+)".*?pr:(\d+)/g;
let m;
while ((m = prodRegex.exec(partsContent)) !== null) {
  const asinM = partsContent.substring(m.index, m.index + 500).match(/\/dp\/(B[A-Z0-9]{9})/);
  products.push({ id: parseInt(m[1]), name: m[2], cat: m[3], price: parseInt(m[4]), currentAsin: asinM ? asinM[1] : null });
}
console.log(`Loaded ${products.length} products\n`);

// ═══ TITLE MATCHING ═══
function checkTitleMatch(ourName, ourCat, amazonTitle) {
  if (!amazonTitle) return false;
  const ourLower = ourName.toLowerCase();
  const azLower = amazonTitle.toLowerCase();

  // Extract key words from our name (3+ chars, skip common words)
  const skip = ['the','and','for','with','edition','version','series','gen','new'];
  const ourWords = ourLower.replace(/[()]/g, '').split(/[\s\-\/]+/).filter(w => w.length >= 3 && !skip.includes(w));
  let matched = 0;
  for (const word of ourWords) { if (azLower.includes(word)) matched++; }
  const ratio = ourWords.length > 0 ? matched / ourWords.length : 0;

  // 50%+ word match = good
  if (ratio >= 0.5) return true;

  // Cross-category check: reject if Amazon title is clearly a different product type
  if (ourCat && CAT_KEYWORDS[ourCat]) {
    for (const [otherCat, otherWords] of Object.entries(CAT_KEYWORDS)) {
      if (otherCat === ourCat) continue;
      const azMatchesOther = otherWords.some(kw => azLower.includes(kw));
      const azMatchesOurs = (CAT_KEYWORDS[ourCat] || []).some(kw => azLower.includes(kw));
      if (azMatchesOther && !azMatchesOurs) return false;
    }
  }

  // Brand + 35% word match
  const brand = ourLower.split(/\s+/)[0];
  if (azLower.includes(brand) && ratio >= 0.35) return true;

  return false;
}

// ═══ PASS 1: VERIFY ═══
async function pass1() {
  console.log('=== PASS 1: Verify existing ASINs ===\n');
  const withAsin = products.filter(p => p.currentAsin);
  const needVerify = withAsin.filter(p => !verifyCache[p.name]?.verified);
  console.log(`With ASIN: ${withAsin.length}, Already verified: ${withAsin.length - needVerify.length}, Need verify: ${needVerify.length}`);
  console.log(`Est. time: ~${Math.round(needVerify.length * 5 / 60)} min\n`);

  let verified = 0, mismatched = 0, errors = 0;

  for (let i = 0; i < withAsin.length; i++) {
    const prod = withAsin[i];
    if (verifyCache[prod.name]?.verified) { if (verifyCache[prod.name].match) verified++; else mismatched++; continue; }

    const short = prod.name.length > 35 ? prod.name.substring(0, 35) + '...' : prod.name;
    process.stdout.write(`[${i+1}/${withAsin.length}] ${short.padEnd(38)} ${prod.currentAsin} `);

    const html = await fetchPage(`https://www.amazon.com/dp/${prod.currentAsin}`);
    if (!html) { errors++; console.log('x fetch fail'); await sleep(randomDelay()); continue; }

    // Title
    let amazonTitle = '';
    const tM = html.match(/id="productTitle"[^>]*>([^<]+)/);
    if (tM) amazonTitle = tM[1].trim();
    if (!amazonTitle) { const tM2 = html.match(/<title>([^<]+)/); if (tM2) amazonTitle = tM2[1].replace(/ : Amazon.*$/, '').trim(); }

    // UPCs — handle multiple UPCs separated by spaces
    const upcs = [];
    const upcM = html.match(/UPC[\s\S]*?<td[^>]*>\s*([^<]+)/i);
    if (upcM) { upcM[1].trim().split(/\s+/).forEach(u => { const c = u.replace(/[^0-9]/g, ''); if (c.length >= 12 && !upcs.includes(c)) upcs.push(c); }); }
    // JSON-LD or structured data UPC
    const upcM2 = html.match(/"gtin(?:12|13|14)?"\s*:\s*"(\d{12,14})"/g);
    if (upcM2) { upcM2.forEach(m => { const c = m.match(/(\d{12,14})/); if (c && !upcs.includes(c[1])) upcs.push(c[1]); }); }

    // Price (new condition)
    let amazonPrice = null;
    const pW = html.match(/class="a-price-whole">(\d[\d,]*)/);
    const pF = html.match(/class="a-price-fraction">(\d{2})/);
    if (pW) { amazonPrice = parseInt(pW[1].replace(',', '')); if (pF) amazonPrice += parseInt(pF[1]) / 100; }

    // Image
    let amazonImage = null;
    const iM = html.match(/"hiRes"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
    if (iM) amazonImage = iM[1];
    if (!amazonImage) { const iM2 = html.match(/id="landingImage"[^>]*src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/); if (iM2) amazonImage = iM2[1]; }
    if (amazonImage) amazonImage = amazonImage.replace(/\._[^.]+_\./, '._AC_SL300_.');

    // ASIN from page (verify it matches)
    let pageAsin = prod.currentAsin;
    const asinM = html.match(/"ASIN"\s*:\s*"(B[A-Z0-9]{9})"/);
    if (asinM) pageAsin = asinM[1];

    // Match check
    const titleOk = checkTitleMatch(prod.name, prod.cat, amazonTitle);
    let priceOk = true;
    if (amazonPrice && prod.price > 0) { const r = amazonPrice / prod.price; if (r < 0.2 || r > 5.0) priceOk = false; }
    const match = titleOk && priceOk;

    verifyCache[prod.name] = { verified: true, match, asin: pageAsin, amazonTitle, upcs, amazonPrice, amazonImage, priceOk, titleMatch: titleOk };

    if (match) {
      verified++;
      const uStr = upcs.length ? ` UPC:${upcs[0]}${upcs.length > 1 ? '+' + (upcs.length - 1) : ''}` : '';
      const pStr = amazonPrice ? ` $${amazonPrice}` : '';
      console.log(`OK${pStr}${uStr}`);
    } else {
      mismatched++;
      const reason = !titleOk ? 'WRONG PRODUCT' : 'PRICE MISMATCH';
      console.log(`x ${reason}`);
      console.log(`   Ours:   "${prod.name}" [${prod.cat}] $${prod.price}`);
      console.log(`   Amazon: "${amazonTitle.substring(0, 60)}" $${amazonPrice || '?'}`);
    }

    if (i % 10 === 0) writeFileSync(verifyCachePath, JSON.stringify(verifyCache, null, 2));
    await sleep(randomDelay());
  }

  writeFileSync(verifyCachePath, JSON.stringify(verifyCache, null, 2));
  console.log(`\nPass 1: ${verified} verified, ${mismatched} mismatched, ${errors} errors\n`);
  return Object.entries(verifyCache).filter(([k, v]) => v.verified && !v.match).map(([name]) => products.find(p => p.name === name)).filter(Boolean);
}

// ═══ PASS 2: RE-SEARCH ═══
async function pass2(mismatches) {
  console.log('=== PASS 2: Re-search mismatches ===\n');
  if (!mismatches.length) {
    mismatches = Object.entries(verifyCache).filter(([k, v]) => v.verified && !v.match).map(([name]) => products.find(p => p.name === name)).filter(Boolean);
  }
  if (!mismatches.length) { console.log('All ASINs verified! Nothing to fix.\n'); return; }
  console.log(`Re-searching ${mismatches.length} products...\n`);

  let fixed = 0, failed = 0;

  for (let i = 0; i < mismatches.length; i++) {
    const prod = mismatches[i];
    const short = prod.name.length > 35 ? prod.name.substring(0, 35) + '...' : prod.name;
    process.stdout.write(`[${i+1}/${mismatches.length}] ${short.padEnd(38)} `);

    // Strategy 1: Search by UPC if we have one from Pass 1
    const cachedUPCs = verifyCache[prod.name]?.upcs || [];
    let html = null;
    let searchType = 'name';

    if (cachedUPCs.length) {
      // Try UPC search first — most accurate
      html = await fetchPage(`https://www.amazon.com/s?k=${cachedUPCs[0]}&condition=new`);
      searchType = 'UPC';
    }

    if (!html || html.length < 5000) {
      // Fall back to name + category search
      const suffix = CAT_SEARCH[prod.cat] || '';
      const query = encodeURIComponent(prod.name + ' ' + suffix);
      html = await fetchPage(`https://www.amazon.com/s?k=${query}&condition=new`);
      searchType = 'name+cat';
    }

    if (!html) { failed++; console.log('x search failed'); await sleep(randomDelay()); continue; }

    const asins = [...new Set([...html.matchAll(/data-asin="(B[A-Z0-9]{9})"/g)].map(m => m[1]))];
    let best = null;

    for (const asin of asins.slice(0, 8)) {
      const idx = html.indexOf(`data-asin="${asin}"`);
      const before = html.substring(Math.max(0, idx - 500), idx);
      if (before.includes('Sponsored') || before.includes('sponsored')) continue;

      const chunk = html.substring(idx, idx + 3000);

      // Title
      let title = '';
      const tM = chunk.match(/class="a-text-normal"[^>]*>([^<]+)/) || chunk.match(/class="a-size-medium[^"]*"[^>]*>([^<]+)/) || chunk.match(/class="a-size-base-plus[^"]*"[^>]*>([^<]+)/);
      if (tM) title = tM[1].trim();

      if (!checkTitleMatch(prod.name, prod.cat, title)) continue;

      // Price
      let price = null;
      const pM = chunk.match(/class="a-price-whole">(\d[\d,]*)/);
      const fM = chunk.match(/class="a-price-fraction">(\d{2})/);
      if (pM) { price = parseInt(pM[1].replace(',', '')); if (fM) price += parseInt(fM[1]) / 100; }
      if (price && prod.price > 0) { const r = price / prod.price; if (r < 0.2 || r > 5.0) continue; }

      // Image
      let image = null;
      const imgM = chunk.match(/src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
      if (imgM) image = imgM[1].replace(/\._[^.]+_\./, '._AC_SL300_.');

      best = { asin, title, price, image };
      break;
    }

    if (best) {
      fixed++;
      verifyCache[prod.name] = { verified: true, match: true, asin: best.asin, amazonTitle: best.title, amazonPrice: best.price, amazonImage: best.image, upcs: cachedUPCs, fixed: true };
      amazonData[prod.name] = { asin: best.asin, image: best.image, price: best.price };
      console.log(`FIXED [${searchType}] ${best.asin} $${best.price || '?'}`);
      console.log(`   -> "${best.title.substring(0, 55)}"`);
    } else {
      failed++;
      verifyCache[prod.name] = { ...verifyCache[prod.name], needsManualFix: true };
      console.log(`x no match [${searchType}]`);
    }

    if (i % 10 === 0) { writeFileSync(verifyCachePath, JSON.stringify(verifyCache, null, 2)); writeFileSync(amazonDataPath, JSON.stringify(amazonData, null, 2)); }
    await sleep(randomDelay());
  }

  writeFileSync(verifyCachePath, JSON.stringify(verifyCache, null, 2));
  writeFileSync(amazonDataPath, JSON.stringify(amazonData, null, 2));
  console.log(`\nPass 2: ${fixed} fixed, ${failed} still bad\n`);

  if (failed > 0) {
    console.log('Products needing manual fix:');
    Object.entries(verifyCache).filter(([k, v]) => v.needsManualFix).forEach(([name, data]) => {
      console.log(`   ${name} -> "${(data.amazonTitle || '').substring(0, 50)}"`);
    });
  }
}

// ═══ UPDATE PARTS.JS ═══
function updatePartsFile() {
  console.log('\n=== Updating parts.js ===\n');
  let links = 0, prices = 0, imgs = 0, upcCount = 0;
  const lines = partsContent.split('\n');
  const newLines = [];
  let cur = '';

  for (const line of lines) {
    let nl = line;
    const nm = line.match(/n:"([^"]+)"/);
    if (nm) cur = nm[1];
    const data = verifyCache[cur];

    if (data?.match && data.asin) {
      // Fix ASIN link
      if (nl.includes('amazon.com/') && nl.includes('tiereduptech-20')) {
        const um = nl.match(/url:"[^"]+"/);
        if (um) { nl = nl.substring(0, um.index) + `url:"https://www.amazon.com/dp/${data.asin}?tag=${TAG}"` + nl.substring(um.index + um[0].length); links++; }
      }
      // Fix price
      if (data.amazonPrice && nl.includes('price:')) {
        const pm = nl.match(/price:(\d+)/);
        if (pm) { const op = parseInt(pm[1]); const np = Math.round(data.amazonPrice); if (np > 0 && np / op > 0.3 && np / op < 3.0) { nl = nl.replace(`price:${op}`, `price:${np}`); prices++; } }
      }
      // Fix image
      if (data.amazonImage && nl.includes(`n:"${cur}"`)) {
        if (nl.includes('img:"')) { nl = nl.replace(/img:"[^"]*"/, `img:"${data.amazonImage}"`); }
        else { nl = nl.replace(`n:"${cur}"`, `n:"${cur}",img:"${data.amazonImage}"`); }
        imgs++;
      }
      // Add UPC
      if (data.upcs?.length && nl.includes(`n:"${cur}"`) && !nl.includes('upc:')) {
        const upcVal = data.upcs.join(',');
        nl = nl.replace(`n:"${cur}"`, `n:"${cur}",upc:"${upcVal}"`);
        upcCount++;
      }
    }
    newLines.push(nl);
  }

  writeFileSync(partsPath, newLines.join('\n'));
  console.log(`Links: ${links} | Prices: ${prices} | Images: ${imgs} | UPCs: ${upcCount}`);
}

// ═══ REPORT ═══
function report() {
  const total = products.length;
  const verified = Object.values(verifyCache).filter(v => v.verified && v.match).length;
  const bad = Object.values(verifyCache).filter(v => v.verified && !v.match).length;
  const withUPC = Object.values(verifyCache).filter(v => v.upcs?.length > 0).length;
  const manual = Object.values(verifyCache).filter(v => v.needsManualFix).length;
  console.log('\n=== FINAL REPORT ===');
  console.log(`Total: ${total} | Verified: ${verified} | Bad: ${bad} | UPCs: ${withUPC} | Manual: ${manual}`);
  console.log(`\nRun 'npm run build && vercel --prod' to deploy.\n`);
}

// ═══ MAIN ═══
async function main() {
  let mm = [];
  if (!PASS2_ONLY) mm = await pass1();
  if (!PASS1_ONLY) { await pass2(mm); updatePartsFile(); }
  report();
}

main().catch(console.error);
