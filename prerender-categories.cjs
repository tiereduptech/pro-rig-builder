// =============================================================================
//  prerender-categories.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Pre-renders /search?cat=X for each main category into
//  dist/search/cat-{name}.html. Each gets per-category title, description,
//  CollectionPage schema, and BreadcrumbList — all from PageMeta's existing
//  CATEGORY_META map.
//
//  Approach: template-based, no puppeteer. Uses an existing pre-rendered
//  product page as a template, swaps in category-specific metadata.
//  ~10 categories generated in <1 second.
// =============================================================================

const fs = require('fs');
const path = require('path');

const SITE = 'https://prorigbuilder.com';
const BRAND = 'Pro Rig Builder';
const SEARCH_DIR = path.join('dist', 'search');

// Categories to pre-render. Must match keys in PageMeta.jsx CATEGORY_META.
const CATEGORIES = [
  'CPU', 'GPU', 'Motherboard', 'RAM', 'Storage',
  'PSU', 'Case', 'CPUCooler', 'CaseFan', 'Monitor',
];

// Mirror of CATEGORY_META in src/PageMeta.jsx so this script doesn't need
// to import JSX. If you change PageMeta.jsx, update this too.
const CATEGORY_META = {
  CPU:         { title: `Compare CPUs — Intel & AMD Processors | ${BRAND}`, desc: 'Compare every modern Intel and AMD CPU with verified specs, benchmarks, and live prices. Filter by socket, core count, TDP, and integrated graphics.' },
  GPU:         { title: `Compare GPUs — NVIDIA & AMD Graphics Cards | ${BRAND}`, desc: 'Compare NVIDIA RTX and AMD Radeon graphics cards. Verified specs, benchmarks, FPS estimates, and live prices from Amazon and Best Buy.' },
  Motherboard: { title: `Compare Motherboards — Intel & AMD | ${BRAND}`, desc: 'Find the right motherboard. Filter by socket, chipset, form factor, RAM type, and M.2 slots. 480+ verified boards with live prices.' },
  RAM:         { title: `Compare RAM — DDR4 & DDR5 Memory Kits | ${BRAND}`, desc: 'Compare DDR4 and DDR5 memory kits by speed, capacity, latency, and price. 270+ verified kits with live deals.' },
  Storage:     { title: `Compare SSDs & Hard Drives | ${BRAND}`, desc: 'Compare NVMe SSDs, SATA SSDs, and HDDs by capacity, speed, and price. 560+ verified drives with live deals.' },
  PSU:         { title: `Compare Power Supplies — 80+ Rated PSUs | ${BRAND}`, desc: 'Compare 80+ certified power supplies by wattage, efficiency, modularity, and price. 180+ verified PSUs with live deals.' },
  Case:        { title: `Compare PC Cases — ATX, mATX, ITX | ${BRAND}`, desc: 'Compare PC cases by form factor, GPU clearance, fan support, and price. 340+ verified cases with live deals.' },
  CPUCooler:   { title: `Compare CPU Coolers — Air & AIO | ${BRAND}`, desc: 'Compare air coolers and AIO liquid coolers by socket support, height, fan size, and price. 300+ verified coolers.' },
  CaseFan:     { title: `Compare Case Fans — 120mm, 140mm & RGB | ${BRAND}`, desc: 'Compare case fans by size, airflow, noise, and price. 300+ verified fans with live deals.' },
  Monitor:     { title: `Compare Gaming & Productivity Monitors | ${BRAND}`, desc: 'Compare monitors by size, resolution, refresh rate, panel type, and price. 370+ verified monitors with live deals.' },
};

// ─── Find a template — any existing pre-rendered product page ───────────────
function findTemplate() {
  if (!fs.existsSync(SEARCH_DIR)) return null;
  const files = fs.readdirSync(SEARCH_DIR).filter((f) => /^id-\w+\.html$/.test(f));
  if (files.length === 0) return null;
  files.sort((a, b) => fs.statSync(path.join(SEARCH_DIR, a)).size - fs.statSync(path.join(SEARCH_DIR, b)).size);
  return path.join(SEARCH_DIR, files[0]);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ─── Inject category metadata into the template ────────────────────────────
function injectMeta(templateHtml, cat, meta) {
  let html = templateHtml;
  const url = `${SITE}/search?cat=${encodeURIComponent(cat)}`;
  const ogImage = `${SITE}/og-image.png`;

  // CollectionPage schema for category browse pages.
  const collectionLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: meta.title,
    description: meta.desc,
    url,
  };

  // BreadcrumbList: Home › Search › {Category}
  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
      { '@type': 'ListItem', position: 2, name: 'Search', item: SITE + '/search' },
      { '@type': 'ListItem', position: 3, name: cat },
    ],
  };

  // Replace <title>.
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>${escapeHtml(meta.title)}</title>`);

  // Replace helmet-injected meta/canonical/og/twitter.
  const replacements = [
    { re: /<meta\s+name="description"\s+content="[^"]*"\s*data-rh="true"\s*\/?>/gi, sub: `<meta name="description" content="${escapeAttr(meta.desc)}" data-rh="true">` },
    { re: /<link\s+rel="canonical"\s+href="[^"]*"\s*data-rh="true"\s*\/?>/gi, sub: `<link rel="canonical" href="${escapeAttr(url)}" data-rh="true">` },
    { re: /<meta\s+property="og:title"\s+content="[^"]*"\s*data-rh="true"\s*\/?>/gi, sub: `<meta property="og:title" content="${escapeAttr(meta.title)}" data-rh="true">` },
    { re: /<meta\s+property="og:description"\s+content="[^"]*"\s*data-rh="true"\s*\/?>/gi, sub: `<meta property="og:description" content="${escapeAttr(meta.desc)}" data-rh="true">` },
    { re: /<meta\s+property="og:url"\s+content="[^"]*"\s*data-rh="true"\s*\/?>/gi, sub: `<meta property="og:url" content="${escapeAttr(url)}" data-rh="true">` },
    { re: /<meta\s+property="og:image"\s+content="[^"]*"\s*data-rh="true"\s*\/?>/gi, sub: `<meta property="og:image" content="${escapeAttr(ogImage)}" data-rh="true">` },
    { re: /<meta\s+property="og:type"\s+content="[^"]*"\s*data-rh="true"\s*\/?>/gi, sub: `<meta property="og:type" content="website" data-rh="true">` },
    { re: /<meta\s+name="twitter:title"\s+content="[^"]*"\s*data-rh="true"\s*\/?>/gi, sub: `<meta name="twitter:title" content="${escapeAttr(meta.title)}" data-rh="true">` },
    { re: /<meta\s+name="twitter:description"\s+content="[^"]*"\s*data-rh="true"\s*\/?>/gi, sub: `<meta name="twitter:description" content="${escapeAttr(meta.desc)}" data-rh="true">` },
    { re: /<meta\s+name="twitter:image"\s+content="[^"]*"\s*data-rh="true"\s*\/?>/gi, sub: `<meta name="twitter:image" content="${escapeAttr(ogImage)}" data-rh="true">` },
  ];
  for (const r of replacements) html = html.replace(r.re, r.sub);

  // Template has 2 helmet-injected JSON-LD scripts (Product + Breadcrumb).
  // Replace with our 2 new ones (CollectionPage + Breadcrumb).
  // We do this by replacing the first (Product) with CollectionPage, and the
  // second (Breadcrumb) with our new Breadcrumb.
  const ldRegex = /<script\s+type="application\/ld\+json"\s+data-rh="true">[\s\S]*?<\/script>/gi;
  const ldMatches = html.match(ldRegex) || [];
  const newCollection = `<script type="application/ld+json" data-rh="true">${JSON.stringify(collectionLd)}</script>`;
  const newBreadcrumb = `<script type="application/ld+json" data-rh="true">${JSON.stringify(breadcrumbLd)}</script>`;
  if (ldMatches.length >= 2) {
    html = html.replace(ldMatches[0], newCollection);
    html = html.replace(ldMatches[1], newBreadcrumb);
  } else if (ldMatches.length === 1) {
    html = html.replace(ldMatches[0], newCollection + '\n' + newBreadcrumb);
  }

  return html;
}

// ─── Main ───────────────────────────────────────────────────────────────────
console.log('Pro Rig Builder — Category Page Pre-render');
console.log('==========================================');

const tmplPath = findTemplate();
if (!tmplPath) {
  console.error('  ✗ No template found in dist/search/. Run prerender-products.cjs first.');
  process.exit(1);
}
console.log(`  Using template: ${path.relative('.', tmplPath)}`);
const template = fs.readFileSync(tmplPath, 'utf8');

let success = 0;
for (const cat of CATEGORIES) {
  const meta = CATEGORY_META[cat];
  if (!meta) {
    console.log(`  ✗ ${cat}  (no metadata — skipped)`);
    continue;
  }
  const html = injectMeta(template, cat, meta);
  const out = path.join(SEARCH_DIR, `cat-${cat}.html`);
  fs.writeFileSync(out, html, 'utf8');
  console.log(`  ✓ cat-${cat.padEnd(12)} ${(html.length / 1024).toFixed(0)} kB`);
  success++;
}

console.log('');
console.log('==========================================');
console.log(`  ✓ Generated ${success} category HTML files`);
console.log('==========================================\n');
