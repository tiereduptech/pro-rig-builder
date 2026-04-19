/**
 * scrape-asus-motherboards.js — v4
 *
 * FIXES from v3:
 *   - Incremental save in Phase 2 (writes output after every product)
 *   - Defensive around name/mpn extraction (uses safeStr)
 *   - Can resume if crashed: existing entries in output file are skipped
 */

import {
  fetchHTML, parseHTML, makeProduct, writeOutput, politeDelay,
  dedupeProducts, cleanText, absoluteUrl, extractJsonLd, parseFlags, log, safeStr,
} from './scrape-common.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const BRAND = 'ASUS';
const CATEGORY = 'Motherboard';
const OUTPUT_PATH = './catalog-build/asus-motherboard.json';

const SERIES_PAGES = [
  { name: 'ROG',        url: 'https://rog.asus.com/us/motherboards-group/allmodels/' },
  { name: 'TUF Gaming', url: 'https://www.asus.com/us/motherboards-components/motherboards/all-series/filter?Series=TUF-Gaming' },
  { name: 'Prime',      url: 'https://www.asus.com/us/motherboards-components/motherboards/all-series/filter?Series=PRIME' },
  { name: 'ProArt',     url: 'https://www.asus.com/us/motherboards-components/motherboards/all-series/filter?Series=ProArt' },
];

const PRODUCT_URL_RE = /\/motherboards(?:-components\/motherboards)?\/[a-z0-9\-]+\/[a-z0-9\-]+\/?(?:\?|$)/i;
const REJECT_URL_RE = /\/(accessories|news|support|compatibility|download|archive|specs-spec|filter\?)/i;

function normalizeName(raw) {
  if (!raw) return '';
  let n = cleanText(raw);
  n = n.replace(/^(?:view|buy now|learn more|shop now|compare|details)\s+/i, '');
  n = n.replace(/\s+(?:view|buy now|learn more|shop now|compare|details)$/i, '');
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
  if (/data:image|placeholder|1x1|transparent|blank/i.test(raw)) return null;
  return absoluteUrl(baseUrl, raw);
}

async function scrapeSeriesPage(seriesUrl, seriesName, verbose = false) {
  log.info(`Fetching series: ${seriesName}`);
  const html = await fetchHTML(seriesUrl);
  if (!html) { log.err(`could not load ${seriesUrl}`); return []; }

  const $ = parseHTML(html);
  const products = new Map();

  const cardSelectors = [
    'article',
    'div[class*="ProductCard" i]',
    'div[class*="productCard" i]',
    'div[class*="product-card" i]',
    'div[class*="item-card" i]',
    'li[class*="product" i]',
    'a[href*="/motherboards/"]',
  ];

  let bestCards = $();
  let bestSelector = '';
  for (const sel of cardSelectors) {
    const $cards = $(sel);
    const productLinks = $cards.filter((_, el) => {
      const href = $(el).is('a') ? $(el).attr('href') : $(el).find('a[href*="/motherboards"]').first().attr('href');
      const abs = absoluteUrl(seriesUrl, href || '');
      return abs && PRODUCT_URL_RE.test(abs) && !REJECT_URL_RE.test(abs);
    });
    if (productLinks.length > bestCards.length) {
      bestCards = productLinks;
      bestSelector = sel;
    }
  }

  if (bestCards.length === 0) {
    log.warn(`  no product cards on ${seriesUrl} — DOM may have changed`);
    return [];
  }
  log.info(`  best selector: "${bestSelector}" → ${bestCards.length} candidates`);

  bestCards.each((_, el) => {
    const $el = $(el);
    const $link = $el.is('a') ? $el : $el.find('a[href*="/motherboards"]').first();
    const href = $link.attr('href');
    if (!href) return;
    const sourceUrl = absoluteUrl(seriesUrl, href);
    if (!sourceUrl || !PRODUCT_URL_RE.test(sourceUrl) || REJECT_URL_RE.test(sourceUrl)) return;

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
      const slugMatch = sourceUrl.match(/\/motherboards[^/]*\/[^/]+\/([^/?]+)/);
      if (slugMatch) name = slugMatch[1].replace(/-/g, ' ').toUpperCase();
    }

    const imageUrl = extractImageUrl($el, seriesUrl);
    const mpn = $el.attr('data-prodcode') ||
                $el.find('[data-prodcode]').first().attr('data-prodcode') ||
                null;

    if (!name || products.has(sourceUrl)) return;
    products.set(sourceUrl, { name, mpn, imageUrl, sourceUrl, series: seriesName });
  });

  const arr = [...products.values()];
  log.ok(`  ${seriesName}: ${arr.length} products found`);
  return arr;
}

async function enrichProduct(candidate) {
  const html = await fetchHTML(candidate.sourceUrl);
  if (!html) return candidate;

  const $ = parseHTML(html);

  // JSON-LD (use safeStr defensively)
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

  const specs = {};
  $('dl, table').each((_, el) => {
    const $el = $(el);
    $el.find('dt, th').each((__, label) => {
      const $label = $(label);
      const labelText = cleanText($label.text()).toLowerCase();
      const $value = $label.next('dd, td');
      if (!$value.length) return;
      const value = cleanText($value.text());
      if (/socket/.test(labelText)) specs.socket = value;
      else if (/chipset/.test(labelText)) specs.chipset = value;
      else if (/form factor|form-factor/.test(labelText)) specs.formFactor = value;
      else if (/memory standard|ram type|memory type/.test(labelText)) specs.memType = value;
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
  } catch {
    return new Map();
  }
}

function saveProgress(products) {
  mkdirSync('./catalog-build', { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(products, null, 2));
}

async function main() {
  const flags = parseFlags();
  log.head('ASUS Motherboard Scraper v4');

  log.head('Phase 1: Series listings');
  let allCandidates = [];
  for (const series of SERIES_PAGES) {
    const found = await scrapeSeriesPage(series.url, series.name, flags.verbose);
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

  // Resume support: load existing output, skip already-enriched
  const existing = loadExistingOutput();
  if (existing.size > 0) {
    log.info(`Found ${existing.size} already-enriched products in output file — will skip those`);
  }

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
      const product = makeProduct({
        brand: BRAND,
        category: CATEGORY,
        name: detail.name,
        mpn: detail.mpn,
        imageUrl: detail.imageUrl,
        specs: { series: detail.series, ...detail.specs },
        sourceUrl: detail.sourceUrl,
      });
      enriched.push(product);
      saveProgress(enriched); // incremental save after each product
    } catch (e) {
      log.err(`enrichment failed for ${c.name}: ${e.message}`);
      // Still save the basic candidate so it's not lost
      enriched.push(makeProduct({
        brand: BRAND,
        category: CATEGORY,
        name: c.name,
        mpn: c.mpn,
        imageUrl: c.imageUrl,
        specs: { series: c.series },
        sourceUrl: c.sourceUrl,
      }));
      saveProgress(enriched);
    }

    await politeDelay();
  }

  log.head('Output');
  log.ok(`Final file: ${OUTPUT_PATH}`);

  const withMpn   = enriched.filter(p => p.mpn).length;
  const withImg   = enriched.filter(p => p.imageUrl).length;
  const withSock  = enriched.filter(p => p.specs?.socket).length;
  const withChip  = enriched.filter(p => p.specs?.chipset).length;

  console.log(`\nSummary:`);
  console.log(`  Total products: ${enriched.length}`);
  console.log(`  With MPN:       ${withMpn} (${Math.round(withMpn/enriched.length*100)}%)`);
  console.log(`  With image:     ${withImg} (${Math.round(withImg/enriched.length*100)}%)`);
  console.log(`  With socket:    ${withSock} (${Math.round(withSock/enriched.length*100)}%)`);
  console.log(`  With chipset:   ${withChip} (${Math.round(withChip/enriched.length*100)}%)`);
  console.log();
}

main().catch(e => { console.error('\n✗ FATAL:', e); process.exit(1); });
