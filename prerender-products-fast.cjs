// =============================================================================
//  prerender-products-fast.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Template-based product HTML generator. Bypasses puppeteer entirely.
//
//  How it works:
//    1) Reads a known-good already-pre-rendered product HTML as a template.
//    2) For each missing product, swaps in:
//         - <title>
//         - <meta name="description">
//         - <link rel="canonical">
//         - All og:* and twitter:* tags
//         - The Product JSON-LD <script>
//    3) Writes the result to dist/search/id-{id}.html.
//
//  Why this is safe:
//    The non-meta parts of the HTML (DOM body, app shell, asset references)
//    are identical across all product pages — they only differ in <head>
//    metadata. Browsers will hydrate the SPA from JS regardless, and the
//    only thing crawlers/social previews care about is the metadata.
//
//  Trade-off vs puppeteer:
//    Body innerText is the same generic /search shell on all template-based
//    pages. Puppeteer-rendered ones have product-specific body. For SEO
//    purposes, the metadata is what matters — Google ranks based on title,
//    description, and schema. Body text comes from JS hydration anyway.
// =============================================================================

const fs = require('fs');
const path = require('path');

const SITE = 'https://prorigbuilder.com';
const BRAND = 'Pro Rig Builder';
const SEARCH_DIR = path.join('dist', 'search');

if (!fs.existsSync(SEARCH_DIR)) {
  console.error(`  ✗ ${SEARCH_DIR} not found. Run vite build + prerender first.`);
  process.exit(1);
}

// ─── Load parts.js ──────────────────────────────────────────────────────────
async function loadParts() {
  const partsPath = path.resolve('src/data/parts.js');
  const url = 'file://' + partsPath.replace(/\\/g, '/') + '?t=' + Date.now();
  const mod = await import(url);
  return mod.PARTS || mod.default || [];
}

// ─── Pick top performers per category (matches prerender-products.cjs) ──────
const TOP_N_PER_CAT = {
  GPU: 20, CPU: 20, Motherboard: 10, RAM: 10, Storage: 10,
  PSU: 10, Case: 10, CPUCooler: 10, Monitor: 10,
};

function selectProducts(parts) {
  const selected = [];
  for (const [cat, n] of Object.entries(TOP_N_PER_CAT)) {
    const inCat = parts
      .filter((p) => p.c === cat && !p.needsReview && !p.bundle)
      .sort((a, b) => {
        const bd = (b.bench || 0) - (a.bench || 0);
        if (bd !== 0) return bd;
        const rd = (b.r || 0) - (a.r || 0);
        if (rd !== 0) return rd;
        return ((b.id || b._id || 0) - (a.id || a._id || 0));
      })
      .slice(0, n);
    selected.push(...inCat);
  }
  return selected;
}

// ─── Build product metadata (mirrors PageMeta.jsx logic) ────────────────────
function buildProductMeta(p) {
  const name = p.n || p.name || 'PC Part';
  const cat = p.c || p.category || '';
  const brand = p.b || p.brand || '';
  const id = p.id || p._id;
  const slug = (p.slug || name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')).slice(0, 80);
  const price = p?.deals?.amazon?.price || p?.deals?.bestbuy?.price || p.pr;
  const inStock = p?.deals?.amazon?.inStock !== false;
  const offerUrl = p?.deals?.amazon?.url || p?.deals?.bestbuy?.url || `${SITE}/search?cat=${encodeURIComponent(cat)}&id=${id}`;
  const ogImage = p?.deals?.amazon?.image || p.img || `${SITE}/og-image.png`;

  // Title: "Brand Name | Cat | Specs, Price & Reviews | Pro Rig Builder"
  const titleParts = [];
  if (brand && !name.toLowerCase().includes(brand.toLowerCase())) titleParts.push(`${brand} ${name}`);
  else titleParts.push(name);
  if (cat) titleParts.push(cat);
  titleParts.push('Specs, Price & Reviews');
  titleParts.push(BRAND);
  const title = titleParts.join(' | ').slice(0, 70);

  let desc = brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : name;
  desc += ` — full specs, benchmarks`;
  if (price) desc += `, current price $${price}`;
  desc += `, and live availability from Amazon and Best Buy.`;
  desc = desc.slice(0, 160);

  const url = `${SITE}/search?cat=${encodeURIComponent(cat)}&id=${id}&slug=${slug}`;

  // JSON-LD Product schema.
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name,
    ...(brand ? { brand: { '@type': 'Brand', name: brand } } : {}),
    ...(cat ? { category: cat } : {}),
  };
  if (p.r && p.r > 0) {
    ld.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: String(p.r),
      reviewCount: String(p.rc || p.reviewCount || 1),
    };
  }
  if (price) {
    ld.offers = {
      '@type': 'Offer',
      price: String(price),
      priceCurrency: 'USD',
      availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      url: offerUrl,
    };
  }

  return { title, desc, url, ogImage, jsonLd: JSON.stringify(ld) };
}

// ─── Find a template — any existing pre-rendered product page ───────────────
function findTemplate() {
  const files = fs.readdirSync(SEARCH_DIR).filter((f) => /^id-\w+\.html$/.test(f));
  if (files.length === 0) return null;
  // Pick the smallest one to keep the template lean.
  files.sort((a, b) => fs.statSync(path.join(SEARCH_DIR, a)).size - fs.statSync(path.join(SEARCH_DIR, b)).size);
  return path.join(SEARCH_DIR, files[0]);
}

// ─── Inject product metadata into the template ──────────────────────────────
function injectMeta(templateHtml, meta) {
  let html = templateHtml;

  // Replace <title>.
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(meta.title)}</title>`);

  // Replace any helmet-injected (data-rh="true") meta description and canonical
  // and og/twitter tags. We replace existing helmet tags with our values, so
  // the resulting HTML has exactly one of each (no duplicates).

  // Track which fields we've replaced to detect missing ones we'd need to insert.
  const replacements = [
    { re: /<meta\s+name="description"\s+content="[^"]*"\s*data-rh="true"\s*\/?>/gi,
      sub: `<meta name="description" content="${escapeAttr(meta.desc)}" data-rh="true">` },
    { re: /<link\s+rel="canonical"\s+href="[^"]*"\s*data-rh="true"\s*\/?>/gi,
      sub: `<link rel="canonical" href="${escapeAttr(meta.url)}" data-rh="true">` },
    { re: /<meta\s+property="og:title"\s+content="[^"]*"\s*data-rh="true"\s*\/?>/gi,
      sub: `<meta property="og:title" content="${escapeAttr(meta.title)}" data-rh="true">` },
    { re: /<meta\s+property="og:description"\s+content="[^"]*"\s*data-rh="true"\s*\/?>/gi,
      sub: `<meta property="og:description" content="${escapeAttr(meta.desc)}" data-rh="true">` },
    { re: /<meta\s+property="og:url"\s+content="[^"]*"\s*data-rh="true"\s*\/?>/gi,
      sub: `<meta property="og:url" content="${escapeAttr(meta.url)}" data-rh="true">` },
    { re: /<meta\s+property="og:image"\s+content="[^"]*"\s*data-rh="true"\s*\/?>/gi,
      sub: `<meta property="og:image" content="${escapeAttr(meta.ogImage)}" data-rh="true">` },
    { re: /<meta\s+property="og:type"\s+content="[^"]*"\s*data-rh="true"\s*\/?>/gi,
      sub: `<meta property="og:type" content="product" data-rh="true">` },
    { re: /<meta\s+name="twitter:title"\s+content="[^"]*"\s*data-rh="true"\s*\/?>/gi,
      sub: `<meta name="twitter:title" content="${escapeAttr(meta.title)}" data-rh="true">` },
    { re: /<meta\s+name="twitter:description"\s+content="[^"]*"\s*data-rh="true"\s*\/?>/gi,
      sub: `<meta name="twitter:description" content="${escapeAttr(meta.desc)}" data-rh="true">` },
    { re: /<meta\s+name="twitter:image"\s+content="[^"]*"\s*data-rh="true"\s*\/?>/gi,
      sub: `<meta name="twitter:image" content="${escapeAttr(meta.ogImage)}" data-rh="true">` },
  ];
  for (const r of replacements) html = html.replace(r.re, r.sub);

  // Replace the helmet-injected JSON-LD.
  html = html.replace(
    /<script\s+type="application\/ld\+json"\s+data-rh="true">[\s\S]*?<\/script>/i,
    `<script type="application/ld+json" data-rh="true">${meta.jsonLd}</script>`
  );

  return html;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  console.log('Pro Rig Builder — Template-based Product Pre-render');
  console.log('===================================================');

  const parts = await loadParts();
  console.log(`  Loaded ${parts.length} products`);

  const selected = selectProducts(parts).filter((p) => p.id || p._id);
  console.log(`  Selected ${selected.length} candidates`);

  const tmplPath = findTemplate();
  if (!tmplPath) {
    console.error('  ✗ No existing pre-rendered product found to use as template.');
    console.error('    Run prerender-products.cjs first to generate at least one.');
    process.exit(1);
  }
  console.log(`  Using template: ${path.relative('.', tmplPath)}`);
  const template = fs.readFileSync(tmplPath, 'utf8');

  // Filter to only what's missing (no --force here; only fills gaps).
  const missing = selected.filter((p) => {
    const id = p.id || p._id;
    return !fs.existsSync(path.join(SEARCH_DIR, `id-${id}.html`));
  });
  console.log(`  Missing: ${missing.length}\n`);

  let success = 0;
  for (const p of missing) {
    const id = p.id || p._id;
    const meta = buildProductMeta(p);
    const html = injectMeta(template, meta);
    const out = path.join(SEARCH_DIR, `id-${id}.html`);
    fs.writeFileSync(out, html, 'utf8');
    console.log(`  ✓ id-${id}  ${(p.c).padEnd(12)} ${(p.n || '').slice(0, 50)}`);
    success++;
  }

  const totalOnDisk = fs.readdirSync(SEARCH_DIR).filter((f) => /^id-\w+\.html$/.test(f)).length;
  console.log('\n===================================================');
  console.log(`  ✓ Generated ${success} HTML files via template`);
  console.log(`  Total pre-rendered on disk: ${totalOnDisk}`);
  console.log('===================================================\n');
})();
