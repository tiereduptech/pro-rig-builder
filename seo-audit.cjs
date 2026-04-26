// seo-audit.cjs - comprehensive SEO health check
const fs = require('fs');
const path = require('path');

console.log('═══ SEO AUDIT — Pro Rig Builder ═══\n');

// 1. CRITICAL FILES
console.log('## CRITICAL FILES');
const files = [
  { p: 'public/robots.txt', name: 'robots.txt', critical: true },
  { p: 'public/sitemap.xml', name: 'sitemap.xml', critical: true },
  { p: 'public/site.webmanifest', name: 'site.webmanifest' },
  { p: 'public/_headers', name: '_headers (caching)' },
  { p: 'public/_redirects', name: '_redirects' },
  { p: 'public/favicon.ico', name: 'favicon.ico' },
  { p: 'public/og-image.png', name: 'og-image.png' },
  { p: 'public/og-image.jpg', name: 'og-image.jpg' },
  { p: 'index.html', name: 'index.html' },
];
for (const f of files) {
  const exists = fs.existsSync(f.p);
  console.log('  ' + (exists ? '✓' : (f.critical ? '✗' : '○')) + ' ' + f.name + (exists ? ' (' + Math.round(fs.statSync(f.p).size/1024) + ' KB)' : ' MISSING'));
}

// 2. INDEX.HTML AUDIT
console.log('\n## index.html SEO TAGS');
if (fs.existsSync('index.html')) {
  const html = fs.readFileSync('index.html', 'utf8');
  const checks = [
    { name: '<title>', rx: /<title>([^<]+)<\/title>/, important: true },
    { name: 'meta description', rx: /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i, important: true },
    { name: 'meta keywords', rx: /<meta\s+name=["']keywords["']/i },
    { name: 'meta robots', rx: /<meta\s+name=["']robots["']/i },
    { name: 'canonical', rx: /<link\s+rel=["']canonical["']/i, important: true },
    { name: 'og:title', rx: /<meta\s+property=["']og:title["']/i },
    { name: 'og:description', rx: /<meta\s+property=["']og:description["']/i },
    { name: 'og:image', rx: /<meta\s+property=["']og:image["']/i },
    { name: 'og:url', rx: /<meta\s+property=["']og:url["']/i },
    { name: 'og:type', rx: /<meta\s+property=["']og:type["']/i },
    { name: 'twitter:card', rx: /<meta\s+name=["']twitter:card["']/i },
    { name: 'twitter:title', rx: /<meta\s+name=["']twitter:title["']/i },
    { name: 'twitter:image', rx: /<meta\s+name=["']twitter:image["']/i },
    { name: 'JSON-LD schema', rx: /application\/ld\+json/i, important: true },
    { name: 'lang attribute', rx: /<html[^>]+lang=/i },
    { name: 'viewport', rx: /<meta\s+name=["']viewport["']/i },
    { name: 'charset', rx: /<meta\s+charset=/i },
    { name: 'theme-color', rx: /<meta\s+name=["']theme-color["']/i },
    { name: 'apple-touch-icon', rx: /apple-touch-icon/i },
  ];
  for (const c of checks) {
    const match = html.match(c.rx);
    const status = match ? '✓' : (c.important ? '✗' : '○');
    let extra = '';
    if (match && match[1]) extra = ' = "' + match[1].substring(0, 60) + (match[1].length > 60 ? '..' : '') + '"';
    console.log('  ' + status + ' ' + c.name + extra);
  }

  // h1 check (only one h1 per page)
  const h1Count = (html.match(/<h1[\s>]/gi) || []).length;
  console.log('\n  h1 count in index.html: ' + h1Count + (h1Count !== 1 ? ' ⚠ (should be 1, but SPAs render via JS)' : ''));
}

// 3. INDEX.HTML SIZE / PRELOAD
console.log('\n## RENDERED CONTENT (SPA SSR check)');
if (fs.existsSync('index.html')) {
  const html = fs.readFileSync('index.html', 'utf8');
  // Check if there's any visible content in index.html
  const stripped = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '').trim();
  console.log('  Static text in index.html: ' + stripped.length + ' chars');
  if (stripped.length < 300) console.log('  ✗ CRITICAL: SPA — Google sees almost no content. Need SSR/prerender or fallback content in index.html');
  else console.log('  ✓ Has some pre-rendered content');
}

// 4. ROUTING
console.log('\n## ROUTING');
if (fs.existsSync('src/App.jsx')) {
  const app = fs.readFileSync('src/App.jsx', 'utf8');
  // Look for hash-based vs path-based routing
  const hasHash = /window\.location\.hash|#\//g.test(app);
  const hasReactRouter = /react-router/i.test(app);
  console.log('  Hash-based routing: ' + (hasHash ? 'YES' : 'no'));
  console.log('  react-router used: ' + (hasReactRouter ? 'YES' : 'no'));
  if (hasHash && !hasReactRouter) {
    console.log('  ⚠ Hash routes (#/page) are NOT indexed by Google. Need real path routes for SEO.');
  }
}

// 5. PARTS COUNT FOR SITEMAP
console.log('\n## INDEXABLE CONTENT');
(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + Date.now());
  const parts = (m.PARTS || m.default).filter(p => !p.needsReview);
  const cats = [...new Set(parts.map(p => p.c))];
  console.log('  Active products (post-quarantine): ' + parts.length);
  console.log('  Categories: ' + cats.length);
  console.log('  Potential URLs to index:');
  console.log('    - Homepage: 1');
  console.log('    - Category pages: ' + cats.length);
  console.log('    - Product pages: ' + parts.length);
  console.log('    - Total indexable: ' + (1 + cats.length + parts.length));

  // 6. SITEMAP CHECK
  console.log('\n## SITEMAP STATUS');
  if (fs.existsSync('public/sitemap.xml')) {
    const sm = fs.readFileSync('public/sitemap.xml', 'utf8');
    const urls = (sm.match(/<url>/g) || []).length;
    console.log('  Existing sitemap has: ' + urls + ' URLs');
    if (urls < parts.length) console.log('  ✗ Sitemap is incomplete (catalog has ' + parts.length + ')');
  } else {
    console.log('  ✗ NO SITEMAP — Google can\'t discover your products');
  }

  // 7. PERFORMANCE
  console.log('\n## PERFORMANCE INDICATORS');
  if (fs.existsSync('dist/assets')) {
    const files = fs.readdirSync('dist/assets');
    const jsFiles = files.filter(f => f.endsWith('.js'));
    let total = 0;
    for (const f of jsFiles) {
      const size = fs.statSync('dist/assets/' + f).size;
      total += size;
      if (size > 200_000) console.log('  ⚠ Large JS: ' + f + ' (' + Math.round(size/1024) + ' KB)');
    }
    console.log('  Total JS: ' + Math.round(total/1024) + ' KB');
    if (total > 1_000_000) console.log('  ✗ JS too large — Lighthouse will penalize');
  }

  // 8. CHECK IF ANY VITE PRERENDER PLUGIN EXISTS
  console.log('\n## SSR / PRERENDER STATUS');
  if (fs.existsSync('vite.config.js') || fs.existsSync('vite.config.ts')) {
    const vc = fs.existsSync('vite.config.js') ? fs.readFileSync('vite.config.js', 'utf8') : fs.readFileSync('vite.config.ts', 'utf8');
    const hasSSG = /vite-plugin-ssr|vite-plugin-prerender|vite-ssg|prerender/i.test(vc);
    console.log('  Prerender plugin: ' + (hasSSG ? '✓ FOUND' : '✗ MISSING (SPA only)'));
  }

  // 9. CHECK package.json
  if (fs.existsSync('package.json')) {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    console.log('  react-helmet/react-helmet-async: ' + (allDeps['react-helmet'] || allDeps['react-helmet-async'] ? '✓' : '✗'));
    console.log('  prerender package: ' + (allDeps['vite-plugin-prerender'] || allDeps['vite-ssg'] || allDeps['react-snap'] ? '✓' : '✗'));
  }

  // 10. SUMMARY
  console.log('\n═══ AUDIT SUMMARY ═══');
})();
