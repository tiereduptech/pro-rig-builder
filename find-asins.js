// ═══════════════════════════════════════════
// ASIN & Image Finder v3 — Stealth Edition
// ═══════════════════════════════════════════
// - Rotates user agents to look like different browsers
// - Random 3-6 second delays between requests
// - Auto-retries on rate limit with longer backoff
// - Caches results so you can resume if interrupted
// - Grabs both ASIN (direct product link) and product image
//
// USAGE: node find-asins.js

import { readFileSync, writeFileSync, existsSync } from 'fs';

const TAG = 'tiereduptech-20';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
];

function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
function randomDelay() { return 3000 + Math.floor(Math.random() * 3000); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ═══ LOAD CACHE (resume support) ═══
const cachePath = './src/data/amazon-data.json';
let cache = {};
if (existsSync(cachePath)) {
  try {
    cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    console.log(`✓ Loaded ${Object.keys(cache).length} cached results from previous run\n`);
  } catch (e) {
    console.log('No valid cache found, starting fresh\n');
  }
}

// ═══ READ PRODUCTS ═══
const partsPath = './src/data/parts.js';
const partsContent = readFileSync(partsPath, 'utf-8');
const productNames = [];
const nameRegex = /n:"([^"]+)"/g;
let match;
while ((match = nameRegex.exec(partsContent)) !== null) {
  productNames.push(match[1]);
}

const uncachedCount = productNames.filter(n => !cache[n]?.asin).length;
console.log(`Total products: ${productNames.length}`);
console.log(`Already have ASIN: ${productNames.length - uncachedCount}`);
console.log(`Need to look up: ${uncachedCount}`);
console.log(`Estimated time: ~${Math.round(uncachedCount * 4.5 / 60)} minutes\n`);

// ═══ SEARCH AMAZON ═══
async function searchAmazon(productName, retries = 2) {
  const query = encodeURIComponent(productName);
  const url = `https://www.amazon.com/s?k=${query}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': randomUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0',
        },
        redirect: 'follow',
      });

      if (resp.status === 503 || resp.status === 429) {
        if (attempt < retries) {
          const wait = 15000 + Math.floor(Math.random() * 10000);
          process.stdout.write(`⏳${Math.round(wait/1000)}s `);
          await sleep(wait);
          continue;
        }
        return { asin: null, image: null };
      }

      if (!resp.ok) return { asin: null, image: null };

      const html = await resp.text();

      if (html.includes('captcha') || html.includes('Type the characters') || html.length < 5000) {
        if (attempt < retries) {
          const wait = 25000 + Math.floor(Math.random() * 15000);
          process.stdout.write(`🤖${Math.round(wait/1000)}s `);
          await sleep(wait);
          continue;
        }
        return { asin: null, image: null };
      }

      let asin = null;
      const m1 = html.match(/data-asin="(B[A-Z0-9]{9})"/);
      if (m1) asin = m1[1];
      if (!asin) { const m2 = html.match(/\/dp\/(B[A-Z0-9]{9})\//); if (m2) asin = m2[1]; }

      let image = null;
      const im1 = html.match(/class="s-image"[^>]*src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
      if (im1) image = im1[1];
      if (!image) { const im2 = html.match(/src="(https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9._+-]+\.(?:jpg|png))"/); if (im2) image = im2[1]; }
      if (image) image = image.replace(/\._[^.]+_\./, '._AC_SL300_.');

      return { asin, image };
    } catch (err) {
      if (attempt < retries) { await sleep(5000); continue; }
      return { asin: null, image: null };
    }
  }
}

// ═══ MAIN ═══
async function main() {
  let found = 0, images = 0, failed = 0;

  for (let i = 0; i < productNames.length; i++) {
    const name = productNames[i];

    // Skip cached
    if (cache[name]?.asin) {
      found++;
      if (cache[name].image) images++;
      continue;
    }

    const short = name.length > 42 ? name.substring(0, 42) + '...' : name;
    process.stdout.write(`[${i + 1}/${productNames.length}] ${short.padEnd(45)} `);

    const result = await searchAmazon(name);

    if (result.asin) {
      cache[name] = result;
      found++;
      if (result.image) images++;
      console.log(`✓ ${result.asin}${result.image ? ' 📷' : ''}`);
    } else {
      failed++;
      console.log('✗');
    }

    // Save cache every 20 products
    if (i % 20 === 0) writeFileSync(cachePath, JSON.stringify(cache, null, 2));

    // Human-like delay
    await sleep(randomDelay());
  }

  // Save final cache
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));

  console.log(`\n═══ Results ═══`);
  console.log(`ASINs:  ${found}/${productNames.length}`);
  console.log(`Images: ${images}/${productNames.length}`);
  console.log(`Failed: ${failed}`);

  // ═══ UPDATE PARTS.JS ═══
  let updatedLinks = 0, addedImages = 0;
  const lines = partsContent.split('\n');
  const newLines = [];
  let currentProduct = '';

  for (const line of lines) {
    let newLine = line;
    const nm = line.match(/n:"([^"]+)"/);
    if (nm) currentProduct = nm[1];

    const data = cache[currentProduct];
    if (data) {
      if (data.asin && line.includes('amazon.com/') && line.includes('tiereduptech-20')) {
        const um = line.match(/url:"[^"]+"/);
        if (um) {
          newLine = line.substring(0, um.index) + `url:"https://www.amazon.com/dp/${data.asin}?tag=${TAG}"` + line.substring(um.index + um[0].length);
          updatedLinks++;
        }
      }
      if (data.image && line.includes(`n:"${currentProduct}"`) && !line.includes('img:"')) {
        newLine = newLine.replace(`n:"${currentProduct}"`, `n:"${currentProduct}",img:"${data.image}"`);
        addedImages++;
      }
    }
    newLines.push(newLine);
  }

  writeFileSync(partsPath, newLines.join('\n'));
  console.log(`\n✅ ${updatedLinks} direct Amazon links`);
  console.log(`📷 ${addedImages} product images added`);
  console.log(`\nRun 'vercel --prod' to deploy.`);
}

main().catch(console.error);
