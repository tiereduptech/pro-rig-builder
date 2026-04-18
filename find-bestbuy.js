// ═══════════════════════════════════════════
// Best Buy Product Finder
// ═══════════════════════════════════════════
// Searches BestBuy.com for each product in parts.js,
// extracts SKU, price, image, and product URL.
// Adds Best Buy as a second retailer alongside Amazon.
//
// USAGE: node find-bestbuy.js
//
// Run from the rigfinder directory

import { readFileSync, writeFileSync, existsSync } from 'fs';

const AFFILIATE_ID = ''; // Add your Impact Partner ID here when you get it
const DELAY_MS_MIN = 3000;
const DELAY_MS_MAX = 6000;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
function randomDelay() { return DELAY_MS_MIN + Math.floor(Math.random() * (DELAY_MS_MAX - DELAY_MS_MIN)); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ═══ LOAD CACHE ═══
const cachePath = './src/data/bestbuy-data.json';
let cache = {};
if (existsSync(cachePath)) {
  try {
    cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    console.log(`✓ Loaded ${Object.keys(cache).length} cached results\n`);
  } catch (e) {
    console.log('Starting fresh\n');
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

const uncached = productNames.filter(n => !cache[n]?.sku);
console.log(`Total products: ${productNames.length}`);
console.log(`Already found: ${productNames.length - uncached.length}`);
console.log(`Need to look up: ${uncached.length}`);
console.log(`Estimated time: ~${Math.round(uncached.length * 4.5 / 60)} minutes\n`);

// ═══ SEARCH BEST BUY ═══
async function searchBestBuy(productName, retries = 2) {
  // Best Buy search URL
  const query = encodeURIComponent(productName);
  const url = `https://www.bestbuy.com/site/searchpage.jsp?st=${query}&cp=1&sc=Global`;

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

      if (resp.status === 403 || resp.status === 429 || resp.status === 503) {
        if (attempt < retries) {
          const wait = 15000 + Math.floor(Math.random() * 10000);
          process.stdout.write(`⏳${Math.round(wait/1000)}s `);
          await sleep(wait);
          continue;
        }
        return null;
      }

      if (!resp.ok) return null;

      const html = await resp.text();

      // Check for bot detection
      if (html.includes('press & hold') || html.includes('verify you are a human') || html.length < 3000) {
        if (attempt < retries) {
          const wait = 20000 + Math.floor(Math.random() * 15000);
          process.stdout.write(`🤖${Math.round(wait/1000)}s `);
          await sleep(wait);
          continue;
        }
        return null;
      }

      // Extract SKU
      let sku = null;
      // Best Buy uses data-sku-id in search results
      const skuMatch = html.match(/data-sku-id="(\d{7})"/);
      if (skuMatch) sku = skuMatch[1];
      // Alternative: sku in URL
      if (!sku) {
        const skuMatch2 = html.match(/skuId=(\d{7})/);
        if (skuMatch2) sku = skuMatch2[1];
      }
      // Alternative: in product link
      if (!sku) {
        const skuMatch3 = html.match(/\/site\/[^/]+\/(\d{7})\.p/);
        if (skuMatch3) sku = skuMatch3[1];
      }

      // Extract price
      let price = null;
      // Best Buy puts price in aria-label or data attributes
      const priceMatch = html.match(/customer-price[^>]*>.*?\$([0-9,]+(?:\.\d{2})?)/s);
      if (priceMatch) price = parseFloat(priceMatch[1].replace(',', ''));
      if (!price) {
        const priceMatch2 = html.match(/priceView-hero-price[^>]*>.*?\$([0-9,]+(?:\.\d{2})?)/s);
        if (priceMatch2) price = parseFloat(priceMatch2[1].replace(',', ''));
      }
      if (!price) {
        const priceMatch3 = html.match(/\$(\d{1,5}(?:,\d{3})*(?:\.\d{2})?)/);
        if (priceMatch3) price = parseFloat(priceMatch3[1].replace(',', ''));
      }

      // Extract image
      let image = null;
      const imgMatch = html.match(/src="(https:\/\/pisces\.bbystatic\.com\/image2\/BestBuy_US\/images\/products\/[^"]+)"/);
      if (imgMatch) image = imgMatch[1];
      if (!image) {
        const imgMatch2 = html.match(/src="(https:\/\/pisces\.bbystatic\.com[^"]+\.(?:jpg|png|webp))"/);
        if (imgMatch2) image = imgMatch2[1];
      }

      // Extract product URL
      let productUrl = null;
      if (sku) {
        const urlMatch = html.match(/href="(\/site\/[^"]*?\/\d{7}\.p[^"]*)"/);
        if (urlMatch) {
          productUrl = `https://www.bestbuy.com${urlMatch[1]}`;
          // Add affiliate tracking if we have an ID
          if (AFFILIATE_ID) {
            productUrl += `${productUrl.includes('?') ? '&' : '?'}irclickid=${AFFILIATE_ID}`;
          }
        } else {
          productUrl = `https://www.bestbuy.com/site/searchpage.jsp?st=${query}`;
        }
      }

      if (!sku && !price && !image) return null;

      return { sku, price, image, url: productUrl };

    } catch (err) {
      if (attempt < retries) { await sleep(5000); continue; }
      return null;
    }
  }
}

// ═══ MAIN ═══
async function main() {
  let found = 0, failed = 0;

  for (let i = 0; i < productNames.length; i++) {
    const name = productNames[i];

    // Skip cached
    if (cache[name]?.sku) {
      found++;
      continue;
    }

    const short = name.length > 42 ? name.substring(0, 42) + '...' : name;
    process.stdout.write(`[${i + 1}/${productNames.length}] ${short.padEnd(45)} `);

    const result = await searchBestBuy(name);

    if (result?.sku) {
      cache[name] = result;
      found++;
      const priceStr = result.price ? ` $${result.price}` : '';
      const imgStr = result.image ? ' 📷' : '';
      console.log(`✓ SKU:${result.sku}${priceStr}${imgStr}`);
    } else {
      // Mark as not found on Best Buy (many PC parts aren't sold there)
      cache[name] = { sku: null, notFound: true };
      failed++;
      console.log('✗ not on BB');
    }

    // Save cache periodically
    if (i % 20 === 0) writeFileSync(cachePath, JSON.stringify(cache, null, 2));

    await sleep(randomDelay());
  }

  writeFileSync(cachePath, JSON.stringify(cache, null, 2));

  const withPrice = Object.values(cache).filter(v => v.price).length;
  const withImage = Object.values(cache).filter(v => v.image).length;

  console.log(`\n═══ Results ═══`);
  console.log(`Found on Best Buy: ${found}/${productNames.length}`);
  console.log(`With price:        ${withPrice}`);
  console.log(`With image:        ${withImage}`);
  console.log(`Not on Best Buy:   ${failed}`);

  // ═══ UPDATE PARTS.JS ═══
  // Add Best Buy as a second retailer in the deals object
  let addedBB = 0;
  let addedImages = 0;

  const lines = partsContent.split('\n');
  const newLines = [];
  let currentProduct = '';

  for (const line of lines) {
    let newLine = line;
    const nm = line.match(/n:"([^"]+)"/);
    if (nm) currentProduct = nm[1];

    const data = cache[currentProduct];

    if (data?.sku && data.url) {
      // Add Best Buy to deals if not already there
      if (line.includes('deals:{') && !line.includes('bestbuy:')) {
        const bbPrice = data.price || 0;
        const bbEntry = `bestbuy:{price:${bbPrice},url:"${data.url}",inStock:true},`;
        // Insert after deals:{
        newLine = newLine.replace('deals:{', `deals:{${bbEntry}`);
        addedBB++;
      }

      // Add image if Best Buy has one and product doesn't have one yet
      if (data.image && line.includes(`n:"${currentProduct}"`) && !line.includes('img:"')) {
        newLine = newLine.replace(`n:"${currentProduct}"`, `n:"${currentProduct}",img:"${data.image}"`);
        addedImages++;
      }
    }

    newLines.push(newLine);
  }

  writeFileSync(partsPath, newLines.join('\n'));
  console.log(`\n✅ Added Best Buy links to ${addedBB} products`);
  console.log(`📷 Added ${addedImages} product images from Best Buy`);
  console.log(`\nRun 'vercel --prod' to deploy.`);
}

main().catch(console.error);
