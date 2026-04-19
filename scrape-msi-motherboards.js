/**
 * scrape-msi-motherboards.js — v2 (pivot to us-store.msi.com)
 *
 * CHANGE from v1: msi.com product listings are JS-rendered (empty static HTML).
 * Pivoting to us-store.msi.com which is server-rendered as an e-commerce site.
 *
 * USAGE:
 *   node scrape-msi-motherboards.js --dry-run --verbose
 *   node scrape-msi-motherboards.js --limit 10
 *   node scrape-msi-motherboards.js
 */

import {
  fetchHTML, parseHTML, makeProduct, politeDelay,
  dedupeProducts, cleanText, absoluteUrl, extractJsonLd, parseFlags, log, safeStr,
} from './scrape-common.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

const BRAND = 'MSI';
const CATEGORY = 'Motherboard';
const OUTPUT_PATH = './catalog-build/msi-motherboard.json';

// us-store.msi.com chipset-based listing pages (covers all current MSI motherboards)
const CATALOG_PAGES = [
  'https://us-store.msi.com/Motherboards',
  'https://us-store.msi.com/Intel-Platform-Motherboard',
  'https://us-store.msi.com/AMD-Platform-Motherboard',
];

// Product URLs on us-store.msi.com don't have a /Motherboard/ prefix — they're
// typically /MODEL-NAME-WIFI or /PRO-B850M-A. We filter by excluding category pages.
const PRODUCT_URL_RE = /^https:\/\/us-store\.msi\.com\/[A-Za-z0-9][A-Za-z0-9\-_]+\/?$/i;

// Paths we want to skip — category/landing pages, not individual products
const REJECT_PATTERNS = [
  /\/(Motherboards|Graphics-Cards|Monitors|Laptops|Power-Supplies|Keyboards|Mice|Headsets|Cases|Coolers)$/i,
  /\/(Intel|AMD)-Platform/i,
  /\/(MEG|MPG|MAG|PRO|Modern)-Series?$/i,
  /\/(Cart|Account|Login|Register|Search|Support|News|Blog|Store-Locator|Shipping|Returns)/i,
  /\/(Z890|Z790|B860|H810|B760|H610|X870|X670|B850|B840|B650|B550|A620|A520)-Motherboard/i,
  /\?/,
];

function normalizeName(raw) {
  if (!raw) return '';
  let n = cleanText(raw);
  n = n.replace(/^MSI\s+/i, ''); // strip redundant "MSI" prefix
  n = n.replace(/^(?:view|buy now|learn more|shop now|compare|details)\s+/i, '');
  n = n.replace(/\s+(?:view|buy now|learn more|shop now|compare|details)$/i, '');
  n = n.replace(/\s*\|\s*MSI.*$/i, '');
  n = n.replace(/\s*-\s*MSI-US Official Store.*$/i, '');
  return n.trim();
}

function extractImageUrl($el, baseUrl) {
  const $img = $el.find('img').first();
  if (!$img.length) return null;
  const raw =
    $img.attr('data-src') ||
    $img.attr('data-lazy-src') ||
    $img.attr('data-original') ||
    $img.attr('src') ||
    ($img.attr('srcset') || '').split(',')[0]?.trim().split(/\s+/)[0] ||
    null;
  if (!raw) return null;
  if (/data:image|placeholder|1x1|transparent|blank|spacer/i.test(raw)) return null;
  return absoluteUrl(baseUrl, raw);
}

function isProductUrl(url) {
  if (!url) return false;
  if (!PRODUCT_URL_RE.test(url)) return false;
  for (const r of REJECT_PATTERNS) if (r.test(url)) return false;
  return true;
}

async function scrapeCatalogPage(url, verbose = false) {
  log.info(`Fetching catalog: ${url}`);
  const html = await fetchHTML(url);
  if (!html) { log.err(`could not load ${url}`); return []; }

  const $ = parseHTML(html);
  const products = new Map();

  // Try a broad set of e-commerce product card patterns
  const cardSelectors = [
    'div[class*="product-item" i]',
    'div[class*="product-card" i]',
    'div[class*="productCard" i]',
    'li[class*="product" i]',
    'article[class*="product" i]',
    'a[href*="us-store.msi.com/"]',
  ];

  let bestCards = $();
  let bestSelector = '';
  for (const sel of cardSelectors) {
    const $cards = $(sel);
    const filtered = $cards.filter((_, el) => {
      const href = $(el).is('a') ? $(el).attr('href') : $(el).find('a').first().attr('href');
      const abs = absoluteUrl(url, href || '');
      return isProductUrl(abs);
    });
    if (filtered.length > bestCards.length) {
      bestCards = filtered;
      bestSelector = sel;
    }
  }

  if (bestCards.length === 0) {
    log.warn(`  no product cards on ${url} — might have moved or require JS`);
    return [];
  }
  log.info(`  best selector: "${bestSelector}" → ${bestCards.length} candidates`);

  bestCards.each((_, el) => {
    const $el = $(el);
    const $link = $el.is('a') ? $el : $el.find('a').first();
    const href = $link.attr('href');
    if (!href) return;
    const sourceUrl = absoluteUrl(url, href);
    if (!isProductUrl(sourceUrl)) return;

    let name = normalizeName(
      $el.find('img[alt]').first().attr('alt') ||
      $el.find('[data-prodname]').attr('data-prodname') ||
      $el.find('h2, h3, h4').first().text() ||
      $link.attr('title') ||
      $link.attr('aria-label') ||
      $link.text() ||
      ''
    );
    if (!name) {
      const slugMatch = sourceUrl.match(/us-store\.msi\.com\/([^/?#]+)/);
      if (slugMatch) name = slugMatch[1].replace(/-/g, ' ');
    }

    const imageUrl = extractImageUrl($el, url);

    if (!name || products.has(sourceUrl)) return;
    products.set(sourceUrl, { name, mpn: null, imageUrl, sourceUrl });
  });

  const arr = [...products.values()];
  log.ok(`  ${arr.length} products from this page`);
  if (verbose) for (const p of arr) log.info(`    - "${p.name}"`);
  return arr;
}

async function enrichProduct(candidate) {
  const html = await fetchHTML(candidate.sourceUrl);
  if (!html) return candidate;

  const $ = parseHTML(html);

  // JSON-LD structured data
  const jsonLdBlocks = extractJsonLd(html);
  for (const data of jsonLdBlocks) {
    const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
    for (const it of items) {
      if (it['@type'] !== 'Product') continue;
      const n = safeStr(it.name);
      if (n) candidate.name = normalizeName(n);
      candidate.mpn = candidate.mpn || safeStr(it.mpn) || safeStr(it.sku) || safeStr(it.productID) || null;
      const img = Array.isArray(it.image) ? it.image[0] : it.image;
      if (img && !candidate.imageUrl) candidate.imageUrl = absoluteUrl(candidate.sourceUrl, safeStr(img));
      const gtin = safeStr(it.gtin) || safeStr(it.gtin13) || safeStr(it.gtin12);
      if (gtin) candidate.gtin = gtin;
    }
  }

  if (!candidate.imageUrl) {
    const ogImg = $('meta[property="og:image"]').attr('content');
    if (ogImg) candidate.imageUrl = absoluteUrl(candidate.sourceUrl, ogImg);
  }
  if (!candidate.name) {
    const ogTitle = $('meta[property="og:title"]').attr('content') || $('title').text();
    if (ogTitle) candidate.name = normalizeName(ogTitle.split('|')[0]);
  }

  // MSI sub-brand (MEG / MPG / MAG / PRO) from name
  const subBrandMatch = (candidate.name || '').match(/\b(MEG|MPG|MAG|PRO)\b/i);
  const subBrand = subBrandMatch ? subBrandMatch[1].toUpperCase() : null;

  const specs = {};
  if (subBrand) specs.series = subBrand;

  // Spec table extraction
  $('dl, table').each((_, el) => {
    const $el = $(el);
    $el.find('dt, th').each((__, label) => {
      const $label = $(label);
      const labelText = cleanText($label.text()).toLowerCase();
      const $value = $label.next('dd, td');
      if (!$value.length) return;
      const value = cleanText($value.text());
      if (/socket/.test(labelText) && !specs.socket) specs.socket = value;
      else if (/chipset/.test(labelText) && !specs.chipset) specs.chipset = value;
      else if (/form factor|form-factor/.test(labelText) && !specs.formFactor) specs.formFactor = value;
      else if (/memory support|memory standard|ram type|memory type/.test(labelText) && !specs.memType) specs.memType = value;
    });
  });

  const bodyText = $('body').text().slice(0, 8000).toLowerCase();
  if (!specs.socket) {
    const m = bodyText.match(/\b(am4|am5|str5|lga ?1700|lga ?1851|lga ?2066|lga ?4677)\b/i);
    if (m) specs.socket = m[1].toUpperCase().replace(/ /g, '');
  }
  if (!specs.chipset) {
    const m = bodyText.match(/\b(x870e|x870|b850e|b850|b840|a620|x670e|x670|b650e|b650|z890|z790|b860|b760|h810|h610)\b/i);
    if (m) specs.chipset = m[1].toUpperCase();
  }

  candidate.specs = specs;
  return candidate;
}

function loadExistingOutput() {
  if (!existsSync(OUTPUT_PATH)) return new Map();
  try {
    const arr = JSON.parse(readFileSync(OUTPUT_PATH, 'utf-8'));
    const map = new Map();
    for (const p of arr) if (p.sourceUrl) map.set(p.sourceUrl, p);
    return map;
  } catch { return new Map(); }
}

function saveProgress(products) {
  mkdirSync('./catalog-build', { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(products, null, 2));
}

async function main() {
  const flags = parseFlags();
  log.head('MSI Motherboard Scraper v2 (us-store.msi.com)');

  log.head('Phase 1: Catalog pages');
  let allCandidates = [];
  for (const url of CATALOG_PAGES) {
    const found = await scrapeCatalogPage(url, flags.verbose);
    allCandidates.push(...found);
    await politeDelay();
  }

  const candidates = dedupeProducts(allCandidates.map(c => ({ ...c, brand: BRAND })));
  log.ok(`${candidates.length} unique products\n`);

  let target = candidates;
  if (flags.limit) {
    target = target.slice(0, flags.limit);
    log.info(`Limit applied: ${target.length} products`);
  }

  if (flags.dryRun) {
    log.head('DRY RUN — Phase 1 results only');
    console.log(JSON.stringify(target, null, 2));
    return;
  }

  log.head('Phase 2: Product detail enrichment');
  const existing = loadExistingOutput();
  if (existing.size > 0) log.info(`Resuming: ${existing.size} already cached`);

  const enriched = [...existing.values()];

  for (let i = 0; i < target.length; i++) {
    const c = target[i];
    if (existing.has(c.sourceUrl)) {
      log.step(i + 1, target.length, `[cached] ${c.name}`);
      continue;
    }

    log.step(i + 1, target.length, c.name);

    try {
      const detail = await enrichProduct(c);
      enriched.push(makeProduct({
        brand: BRAND, category: CATEGORY,
        name: detail.name, mpn: detail.mpn, imageUrl: detail.imageUrl,
        specs: detail.specs, sourceUrl: detail.sourceUrl,
      }));
      saveProgress(enriched);
    } catch (e) {
      log.err(`enrichment failed: ${e.message}`);
      enriched.push(makeProduct({
        brand: BRAND, category: CATEGORY,
        name: c.name, mpn: c.mpn, imageUrl: c.imageUrl, sourceUrl: c.sourceUrl,
      }));
      saveProgress(enriched);
    }

    await politeDelay();
  }

  log.head('Output');
  log.ok(`Final file: ${OUTPUT_PATH}`);

  const withMpn  = enriched.filter(p => p.mpn).length;
  const withImg  = enriched.filter(p => p.imageUrl).length;
  const withSock = enriched.filter(p => p.specs?.socket).length;
  const withChip = enriched.filter(p => p.specs?.chipset).length;

  console.log(`\nSummary:`);
  console.log(`  Total products: ${enriched.length}`);
  console.log(`  With MPN:       ${withMpn} (${Math.round(withMpn/enriched.length*100)}%)`);
  console.log(`  With image:     ${withImg} (${Math.round(withImg/enriched.length*100)}%)`);
  console.log(`  With socket:    ${withSock} (${Math.round(withSock/enriched.length*100)}%)`);
  console.log(`  With chipset:   ${withChip} (${Math.round(withChip/enriched.length*100)}%)`);
  console.log();
}

main().catch(e => { console.error('\n✗ FATAL:', e); process.exit(1); });
