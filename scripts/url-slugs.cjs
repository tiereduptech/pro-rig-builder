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

function isIndexable(product) {
  if (!product) return false;
  if (product.needsReview) return false;
  if (product.bundle) return false;
  if (!product.id || !product.n || !product.c) return false;
  if (!CAT_SLUG[product.c]) return false;
  return true;
}

async function loadParts() {
  const path = require('path');
  const partsPath = path.resolve(process.cwd(), 'src/data/parts.js');
  const url = 'file:///' + partsPath.replace(/\\/g, '/') + '?t=' + Date.now();
  const mod = await import(url);
  return mod.PARTS || mod.default || [];
}

module.exports = { CAT_SLUG, slugify, productPath, isIndexable, loadParts };