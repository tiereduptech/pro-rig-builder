// =============================================================================
//  scripts/url-slugs.cjs
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  SINGLE SOURCE OF TRUTH for product URL generation.
//  Used by: scripts/generate-sitemap.cjs, prerender.cjs, and (mirrored in)
//  src/PageMeta.jsx.
//
//  If you change anything here, also update src/PageMeta.jsx - they MUST match
//  or Google will see canonical/sitemap mismatch.
// =============================================================================

const CAT_SLUG = {
  'CPU': 'cpu',
  'GPU': 'gpu',
  'Motherboard': 'motherboard',
  'RAM': 'ram',
  'Storage': 'storage',
  'PSU': 'psu',
  'Case': 'case',
  'CPUCooler': 'cpu-cooler',
  'CaseFan': 'case-fan',
  'Monitor': 'monitor',
  'Keyboard': 'keyboard',
  'Mouse': 'mouse',
  'MousePad': 'mouse-pad',
  'Headset': 'headset',
  'Microphone': 'microphone',
  'Webcam': 'webcam',
  'SoundCard': 'sound-card',
  'WiFiCard': 'wifi-card',
  'EthernetCard': 'ethernet-card',
  'OpticalDrive': 'optical-drive',
  'ExternalOptical': 'external-optical-drive',
  'ExternalStorage': 'external-storage',
  'InternalDisplay': 'internal-display',
  'ThermalPaste': 'thermal-paste',
  'ExtensionCables': 'extension-cables',
  'UPS': 'ups',
  'OS': 'operating-system',
  'Antivirus': 'antivirus',
  'Chair': 'chair',
  'Desk': 'desk',
};

// Page size for /parts/<cat>/browse paginated inventory pages.
// Keep in sync with CategoryBrowsePage in src/App.jsx.
const BROWSE_PAGE_SIZE = 50;

function slugify(name) {
  const norm = String(name || '')
    .toLowerCase().replace(/\s+/g,' ').replace(/[^a-z0-9 ]/g,'').trim();
  return norm.replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'')
    .replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,80).replace(/-$/,'');
}

function productPath(product) {
  const catSlug = CAT_SLUG[product.c];
  if (!catSlug || !product.id || !product.n) return null;
  return `/parts/${catSlug}/${slugify(product.n)}-${product.id}`;
}

// Editorial category index page (Best X 2026). One per category.
// Returns null if catKey is not a known slug-mapped category.
function categoryIndexPath(catKey) {
  const slug = CAT_SLUG[catKey];
  return slug ? `/parts/${slug}` : null;
}

// Paginated "browse all" page. Page 1 lives at /parts/<slug>/browse;
// pages 2+ at /parts/<slug>/browse/page-N. This matches Google's preference
// for clean, distinct URLs per paginated view.
function categoryBrowsePath(catKey, pageNum = 1) {
  const slug = CAT_SLUG[catKey];
  if (!slug) return null;
  return pageNum === 1
    ? `/parts/${slug}/browse`
    : `/parts/${slug}/browse/page-${pageNum}`;
}

// Total pages needed to display `count` products at BROWSE_PAGE_SIZE per page.
// Always returns at least 1, even if count is 0, so the route exists.
function browsePageCount(count) {
  return Math.max(1, Math.ceil((count || 0) / BROWSE_PAGE_SIZE));
}

// A live, buyable deal = a retailer entry with both a price and a click-through URL.
function hasBuyableDeal(product) {
  const d = product && product.deals;
  if (!d || typeof d !== 'object') return false;
  return Object.keys(d).some((k) => {
    const o = d[k];
    return o && typeof o === 'object' && o.price != null && (o.url || o.linkurl);
  });
}

function isIndexable(product) {
  if (!product) return false;
  if (product.needsReview) return false;
  if (!product.id || !product.n || !product.c) return false;
  if (!CAT_SLUG[product.c]) return false;
  // Bundles ARE indexable — a "Ryzen + Motherboard" combo page ranks. `p.bundle`
  // means "not a discrete component, exclude from the builder picker" (enforced
  // separately in App.jsx via !p.bundle), NOT "hide from the index". But only when
  // there's something to buy: an indexable page with no live deal is a thin page.
  if (product.bundle && !hasBuyableDeal(product)) return false;
  return true;
}

async function loadParts() {
  const path = require('path');
  const partsPath = path.resolve(process.cwd(), 'src/data/parts.js');
  const url = 'file:///' + partsPath.replace(/\\/g, '/') + '?t=' + Date.now();
  const mod = await import(url);
  return mod.PARTS || mod.default || [];
}

module.exports = {
  CAT_SLUG,
  BROWSE_PAGE_SIZE,
  slugify,
  productPath,
  categoryIndexPath,
  categoryBrowsePath,
  browsePageCount,
  isIndexable,
  loadParts,
};
