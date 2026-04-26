// generate-seo-files.cjs - FIXED: properly XML-encode ampersands in URLs
const fs = require('fs');

const SITE = 'https://prorigbuilder.com';
const TODAY = new Date().toISOString().split('T')[0];

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80);
}

// XML-escape special characters
function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

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

const SEO_LANDING_PAGES = [
  { path: '/vs-pcpartpicker', priority: '0.9', changefreq: 'weekly' },
  { path: '/pcpartpicker-alternative', priority: '0.9', changefreq: 'weekly' },
  { path: '/best-pc-builder-tools', priority: '0.9', changefreq: 'weekly' },
];

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

  let urls = [];
  for (const p of STATIC_PAGES) urls.push({ loc: SITE + p.path, lastmod: TODAY, changefreq: p.changefreq, priority: p.priority });
  for (const p of SEO_LANDING_PAGES) urls.push({ loc: SITE + p.path, lastmod: TODAY, changefreq: p.changefreq, priority: p.priority });
  for (const t of TOOL_PAGES) urls.push({ loc: SITE + t, lastmod: TODAY, changefreq: 'monthly', priority: '0.7' });
  for (const c of cats) {
    urls.push({
      loc: SITE + '/search?cat=' + encodeURIComponent(c),
      lastmod: TODAY, changefreq: 'daily', priority: '0.8'
    });
  }
  for (const p of parts) {
    if (!p.id || !p.c || !p.n) continue;
    const slug = slugify(p.n);
    if (!slug) continue;
    urls.push({
      loc: SITE + '/search?cat=' + encodeURIComponent(p.c) + '&id=' + p.id + '&slug=' + slug,
      lastmod: TODAY, changefreq: 'weekly', priority: '0.6'
    });
  }

  // Build XML with proper escaping
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(u =>
      '  <url>\n' +
      '    <loc>' + xmlEscape(u.loc) + '</loc>\n' +
      '    <lastmod>' + u.lastmod + '</lastmod>\n' +
      '    <changefreq>' + u.changefreq + '</changefreq>\n' +
      '    <priority>' + u.priority + '</priority>\n' +
      '  </url>'
    ).join('\n') + '\n</urlset>\n';

  fs.writeFileSync('public/sitemap.xml', xml);
  console.log('✓ Sitemap regenerated with proper XML escaping');
  console.log('  ' + urls.length + ' URLs (' + Math.round(xml.length/1024) + ' KB)');
})();
