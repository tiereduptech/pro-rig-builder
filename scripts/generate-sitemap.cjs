// =============================================================================
//  scripts/generate-sitemap.cjs
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  Generates public/sitemap.xml with SEO-clean product URLs (Option C format):
//      /parts/{categorySlug}/{nameSlug}-{id}
//
//  Why this matters:
//    - Old format /search?cat=X&id=Y&slug=Z = query-string duplicates.
//      Google indexed 4 of 3,870 URLs because they all looked like the same
//      search page with different params.
//    - New format = one clean URL per product, with keywords in the path.
//
//  Filters out:
//    - needsReview: true (quarantined products)
//    - bundle: true (CPU+mobo combos etc, excluded from builder)
//    - products missing id/name/category
//
//  Usage:
//    node scripts/generate-sitemap.cjs              # write public/sitemap.xml
//    node scripts/generate-sitemap.cjs --dry-run    # preview counts only
// =============================================================================

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const SITE = 'https://prorigbuilder.com';
const TODAY = new Date().toISOString().split('T')[0];
const OUT = path.join('public', 'sitemap.xml');

// --- URL category slugs ---------------------------------------------------
// Map internal `c` field to URL-friendly path segment.
// Keep these stable - they become permanent URLs.
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

// --- Slug function --------------------------------------------------------
// Mirrors productSlug() in src/App.jsx exactly. DO NOT diverge.
function slugify(name) {
  const norm = String(name || '')
    .toLowerCase().replace(/\s+/g,' ').replace(/[^a-z0-9 ]/g,'').trim();
  return norm.replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'')
    .replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,80).replace(/-$/,'');
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

// --- Static pages (highest priority) --------------------------------------
const STATIC_PAGES = [
  { path: '/',                          priority: '1.0', changefreq: 'daily'   },
  { path: '/search',                    priority: '0.9', changefreq: 'daily'   },
  { path: '/builder',                   priority: '0.9', changefreq: 'weekly'  },
  { path: '/scanner',                   priority: '0.8', changefreq: 'weekly'  },
  { path: '/upgrade',                   priority: '0.8', changefreq: 'weekly'  },
  { path: '/compare',                   priority: '0.8', changefreq: 'weekly'  },
  { path: '/community',                 priority: '0.7', changefreq: 'weekly'  },
  { path: '/tools',                     priority: '0.8', changefreq: 'weekly'  },
  { path: '/tools/fps-estimator',       priority: '0.7', changefreq: 'monthly' },
  { path: '/tools/bottleneck-calculator', priority: '0.7', changefreq: 'monthly' },
  { path: '/tools/will-it-run',         priority: '0.7', changefreq: 'monthly' },
  { path: '/tools/compare-builds',      priority: '0.7', changefreq: 'monthly' },
  { path: '/tools/build-wizard',        priority: '0.7', changefreq: 'monthly' },
  { path: '/tools/power-calculator',    priority: '0.7', changefreq: 'monthly' },
  { path: '/tools/compare-parts',       priority: '0.7', changefreq: 'monthly' },
  // SEO landing pages
  { path: '/vs-pcpartpicker',           priority: '0.9', changefreq: 'weekly'  },
  { path: '/pcpartpicker-alternative',  priority: '0.9', changefreq: 'weekly'  },
  { path: '/best-pc-builder-tools',     priority: '0.9', changefreq: 'weekly'  },
  // Legal / about
  { path: '/about',                     priority: '0.5', changefreq: 'monthly' },
  { path: '/contact',                   priority: '0.4', changefreq: 'monthly' },
  { path: '/privacy',                   priority: '0.3', changefreq: 'yearly'  },
  { path: '/terms',                     priority: '0.3', changefreq: 'yearly'  },
  { path: '/affiliate',                 priority: '0.3', changefreq: 'yearly'  },
];

(async () => {
  // Load parts.js (ESM, dynamic import with cache-bust)
  const partsUrl = 'file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + Date.now();
  const mod = await import(partsUrl);
  const allParts = mod.PARTS || mod.default || [];
  if (!Array.isArray(allParts)) {
    console.error('  parts.js did not export an array');
    process.exit(1);
  }

  const indexable = allParts.filter(p =>
    p && p.id && p.n && p.c &&
    !p.needsReview && !p.bundle
  );

  // --- Build URL list -----------------------------------------------------
  const urls = [];

  // Static pages
  for (const sp of STATIC_PAGES) {
    urls.push({
      loc: SITE + sp.path,
      lastmod: TODAY,
      changefreq: sp.changefreq,
      priority: sp.priority,
      img: null,
    });
  }

  // Category landing pages: /parts/{categorySlug}
  const usedCats = [...new Set(indexable.map(p => p.c))].sort();
  for (const c of usedCats) {
    const cSlug = CAT_SLUG[c];
    if (!cSlug) {
      console.warn('  no URL slug for category: ' + c + ' (skipping its pages)');
      continue;
    }
    urls.push({
      loc: SITE + '/parts/' + cSlug,
      lastmod: TODAY,
      changefreq: 'daily',
      priority: '0.8',
      img: null,
    });
  }

  // Product pages: /parts/{categorySlug}/{nameSlug}-{id}
  let skippedNoCat = 0, skippedNoSlug = 0;
  for (const p of indexable) {
    const cSlug = CAT_SLUG[p.c];
    if (!cSlug) { skippedNoCat++; continue; }
    const nSlug = slugify(p.n);
    if (!nSlug) { skippedNoSlug++; continue; }
    urls.push({
      loc: SITE + '/parts/' + cSlug + '/' + nSlug + '-' + p.id,
      lastmod: TODAY,
      changefreq: 'weekly',
      priority: '0.6',
      img: p.img || null,
    });
  }

  // --- Emit XML -----------------------------------------------------------
  const useImageNS = urls.some(u => u.img);
  const ns = useImageNS
    ? 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"'
    : 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset ' + ns + '>\n';
  for (const u of urls) {
    xml += '  <url>\n';
    xml += '    <loc>' + xmlEscape(u.loc) + '</loc>\n';
    xml += '    <lastmod>' + u.lastmod + '</lastmod>\n';
    xml += '    <changefreq>' + u.changefreq + '</changefreq>\n';
    xml += '    <priority>' + u.priority + '</priority>\n';
    if (u.img) {
      xml += '    <image:image>\n';
      xml += '      <image:loc>' + xmlEscape(u.img) + '</image:loc>\n';
      xml += '    </image:image>\n';
    }
    xml += '  </url>\n';
  }
  xml += '</urlset>\n';

  // --- Report -------------------------------------------------------------
  console.log('  Sitemap stats:');
  console.log('    Static pages:    ' + STATIC_PAGES.length);
  console.log('    Category pages:  ' + usedCats.length);
  console.log('    Product pages:   ' + (urls.length - STATIC_PAGES.length - usedCats.length));
  console.log('    Total URLs:      ' + urls.length);
  console.log('    Skipped (no cat slug):  ' + skippedNoCat);
  console.log('    Skipped (no name slug): ' + skippedNoSlug);
  console.log('    Excluded (needsReview): ' + allParts.filter(p => p.needsReview).length);
  console.log('    Excluded (bundle):      ' + allParts.filter(p => p.bundle).length);

  if (DRY_RUN) {
    console.log('  (dry-run) sitemap NOT written');
    return;
  }

  fs.writeFileSync(OUT, xml, 'utf8');
  const sizeKB = (xml.length / 1024).toFixed(1);
  console.log('  Wrote ' + OUT + ' (' + sizeKB + ' KB)');
})().catch(err => {
  console.error('  Error generating sitemap:');
  console.error(err);
  process.exit(1);
});