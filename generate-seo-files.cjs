// generate-seo-files.cjs
// Generates:
//   - public/sitemap.xml with all category + product URLs (path-based)
//   - public/robots.txt with sitemap reference
//   - Slugifies product names for URL-safe identifiers

const fs = require('fs');
const path = require('path');

const SITE = 'https://prorigbuilder.com';
const TODAY = new Date().toISOString().split('T')[0];

// Slugify: turn "AMD Ryzen 9 9800X3D" -> "amd-ryzen-9-9800x3d"
function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80);
}

// Static pages (top-level)
const STATIC_PAGES = [
  { path: '/', priority: '1.0', changefreq: 'daily' },
  { path: '/search', priority: '0.9', changefreq: 'daily' },
  { path: '/builder', priority: '0.9', changefreq: 'weekly' },
  { path: '/scanner', priority: '0.8', changefreq: 'weekly' },
  { path: '/compare', priority: '0.8', changefreq: 'weekly' },
  { path: '/tools', priority: '0.8', changefreq: 'weekly' },
  { path: '/community', priority: '0.7', changefreq: 'weekly' },
  { path: '/about', priority: '0.5', changefreq: 'monthly' },
  { path: '/contact', priority: '0.4', changefreq: 'monthly' },
  { path: '/privacy', priority: '0.3', changefreq: 'yearly' },
  { path: '/terms', priority: '0.3', changefreq: 'yearly' },
  { path: '/affiliate', priority: '0.3', changefreq: 'yearly' },
];

// SEO landing pages (high priority for keyword targeting)
const SEO_LANDING_PAGES = [
  { path: '/vs-pcpartpicker', priority: '0.9', changefreq: 'weekly' },
  { path: '/pcpartpicker-alternative', priority: '0.9', changefreq: 'weekly' },
  { path: '/best-pc-builder-tools', priority: '0.9', changefreq: 'weekly' },
];

// Tool slugs (sub-routes of /tools)
const TOOL_PAGES = [
  '/tools/fps-estimator',
  '/tools/bottleneck-calculator',
  '/tools/psu-calculator',
  '/tools/upgrade-recommender',
  '/tools/compare-parts',
];

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + Date.now());
  const allParts = m.PARTS || m.default;
  const parts = allParts.filter(p => !p.needsReview && !p.bundle);
  const cats = [...new Set(parts.map(p => p.c))].sort();

  console.log('Active products: ' + parts.length);
  console.log('Categories: ' + cats.length);

  // Build sitemap entries
  let urls = [];

  // 1. Static pages
  for (const p of STATIC_PAGES) {
    urls.push({ loc: SITE + p.path, lastmod: TODAY, changefreq: p.changefreq, priority: p.priority });
  }

  // 2. SEO landing pages
  for (const p of SEO_LANDING_PAGES) {
    urls.push({ loc: SITE + p.path, lastmod: TODAY, changefreq: p.changefreq, priority: p.priority });
  }

  // 3. Tool sub-pages
  for (const t of TOOL_PAGES) {
    urls.push({ loc: SITE + t, lastmod: TODAY, changefreq: 'monthly', priority: '0.7' });
  }

  // 4. Category pages: /search?cat=CPU → priority 0.8
  for (const c of cats) {
    urls.push({
      loc: SITE + '/search?cat=' + encodeURIComponent(c),
      lastmod: TODAY,
      changefreq: 'daily',
      priority: '0.8'
    });
  }

  // 5. Individual product pages (most products use /search?cat=X&id=Y or /search?p=slug)
  // The current SPA may not have dedicated product URLs yet, so we generate ?id=N URLs
  // that the search page can use to deep-link to a product
  for (const p of parts) {
    if (!p.id || !p.c || !p.n) continue;
    const slug = slugify(p.n);
    if (!slug) continue;
    urls.push({
      loc: SITE + '/search?cat=' + encodeURIComponent(p.c) + '&id=' + p.id + '&slug=' + slug,
      lastmod: TODAY,
      changefreq: 'weekly',
      priority: '0.6'
    });
  }

  console.log('\nSitemap URLs to write: ' + urls.length);

  // Build XML
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(u =>
      '  <url>\n' +
      '    <loc>' + u.loc + '</loc>\n' +
      '    <lastmod>' + u.lastmod + '</lastmod>\n' +
      '    <changefreq>' + u.changefreq + '</changefreq>\n' +
      '    <priority>' + u.priority + '</priority>\n' +
      '  </url>'
    ).join('\n') + '\n</urlset>\n';

  // Sitemaps over 50,000 URLs need to be split, and over 50MB need to be split.
  // Our ~3,900 URLs is well under that.
  fs.writeFileSync('public/sitemap.xml', xml);
  console.log('✓ Wrote public/sitemap.xml (' + Math.round(xml.length/1024) + ' KB)');

  // Write robots.txt
  const robots = `# robots.txt for prorigbuilder.com
User-agent: *
Allow: /

# Block admin/internal paths
Disallow: /api/
Disallow: /admin/
Disallow: /*.json$
Disallow: /*.cjs$

# Sitemap location
Sitemap: ${SITE}/sitemap.xml
`;
  fs.writeFileSync('public/robots.txt', robots);
  console.log('✓ Wrote public/robots.txt');

  // Write site.webmanifest
  const manifest = {
    name: 'Pro Rig Builder',
    short_name: 'Pro Rig',
    description: 'Compare PC components across Amazon, Best Buy, Newegg & more. Build, benchmark, and save on PC parts.',
    start_url: '/',
    display: 'standalone',
    background_color: '#1a1a1a',
    theme_color: '#FF6B35',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
    ]
  };
  fs.writeFileSync('public/site.webmanifest', JSON.stringify(manifest, null, 2));
  console.log('✓ Wrote public/site.webmanifest');

  console.log('\n═══ DONE ═══');
  console.log('Total URLs in sitemap: ' + urls.length);
  console.log('  Static pages: ' + STATIC_PAGES.length);
  console.log('  SEO landing pages: ' + SEO_LANDING_PAGES.length);
  console.log('  Tool sub-pages: ' + TOOL_PAGES.length);
  console.log('  Category pages: ' + cats.length);
  console.log('  Product pages: ' + parts.length);
})();
