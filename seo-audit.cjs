// =============================================================================
//  seo-audit.cjs — v3 (data-aware bundle scoring)
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Smarter than v2: separates code chunks from data chunks when scoring bundle
//  size. A 2.6 MB parts-data.js (3,950 product records) is expected and fine;
//  what matters is the CODE bundle size that gates Time-To-Interactive.
//
//  Usage:
//    node seo-audit.cjs                  # text report
//    node seo-audit.cjs --json
//    node seo-audit.cjs --source-only    # ignore dist/ even if present
//
//  Exit codes: 0 pass, 1 warnings, 2 critical.
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const SOURCE_ONLY = argv.includes('--source-only');

const findings = { critical: [], warning: [], info: [], pass: [] };

function rel(p) { return path.relative(ROOT, p).replace(/\\/g, '/'); }
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function exists(p) { return fs.existsSync(p); }
function add(level, code, msg, detail) { findings[level].push({ code, msg, detail }); }

const HAS_DIST = !SOURCE_ONLY && exists(path.join(ROOT, 'dist', 'index.html'));

const STATIC_ROUTES = [
  '/', '/search', '/builder', '/community', '/tools', '/upgrade', '/scanner',
  '/about', '/contact', '/privacy', '/terms', '/affiliate', '/compare',
  '/vs-pcpartpicker', '/pcpartpicker-alternative', '/best-pc-builder-tools',
];

// Chunks matching these names contain product/reference DATA, not code. They
// can be large because the catalog has 3,950 products. They don't gate TTI
// the way an oversized code bundle does.
const DATA_CHUNK_PATTERNS = [/parts-data/i, /asin-data/i, /-data\b/i, /\bdata-/i];
const isDataChunk = (name) => DATA_CHUNK_PATTERNS.some((re) => re.test(name));

// ─── 1. HTML head tags ───────────────────────────────────────────────────────
function checkHeadTags() {
  const target = HAS_DIST ? path.join(ROOT, 'dist', 'index.html') : path.join(ROOT, 'index.html');
  const html = read(target);
  if (!html) { add('critical', 'INDEX_MISSING', `${rel(target)} not found`); return; }
  const label = HAS_DIST ? 'dist/index.html (deployed)' : 'index.html (source)';
  add('pass', 'INDEX_PRESENT', `${label} present`);

  const checks = [
    { code: 'TITLE',       re: /<title>[^<]{5,80}<\/title>/i,                                         msg: '<title> tag' },
    { code: 'DESC',        re: /<meta\s+name=["']description["'][^>]*content=["']([^"']*)["']/i,     msg: 'meta description', capture: true },
    { code: 'CANONICAL',   re: /<link\s+rel=["']canonical["']\s+href=["']https?:\/\//i,              msg: 'canonical link' },
    { code: 'VIEWPORT',    re: /<meta\s+name=["']viewport["']/i,                                     msg: 'viewport meta tag' },
    { code: 'CHARSET',     re: /<meta\s+charset=["']?utf-8/i,                                        msg: 'charset utf-8' },
    { code: 'LANG',        re: /<html[^>]+lang=["']en/i,                                             msg: 'html lang attribute' },
    { code: 'OG_TITLE',    re: /<meta\s+property=["']og:title["']/i,                                 msg: 'og:title' },
    { code: 'OG_DESC',     re: /<meta\s+property=["']og:description["']/i,                           msg: 'og:description' },
    { code: 'OG_URL',      re: /<meta\s+property=["']og:url["']/i,                                   msg: 'og:url' },
    { code: 'OG_IMAGE',    re: /<meta\s+property=["']og:image["']/i,                                 msg: 'og:image' },
    { code: 'OG_TYPE',     re: /<meta\s+property=["']og:type["']/i,                                  msg: 'og:type' },
    { code: 'TW_CARD',     re: /<meta\s+name=["']twitter:card["']/i,                                 msg: 'twitter:card' },
    { code: 'TW_TITLE',    re: /<meta\s+name=["']twitter:title["']/i,                                msg: 'twitter:title' },
    { code: 'JSON_LD',     re: /<script\s+type=["']application\/ld\+json["']/i,                      msg: 'JSON-LD schema' },
    { code: 'FAVICON',     re: /<link\s+rel=["'](?:shortcut\s+)?icon["']/i,                          msg: 'favicon link' },
    { code: 'MANIFEST',    re: /<link\s+rel=["']manifest["']/i,                                      msg: 'web manifest' },
    { code: 'THEME_COLOR', re: /<meta\s+name=["']theme-color["']/i,                                  msg: 'theme-color (PWA)' },
  ];
  for (const c of checks) {
    const m = html.match(c.re);
    if (m) {
      add('pass', c.code, c.msg);
      if (c.code === 'DESC' && c.capture && m[1]) {
        const len = m[1].length;
        if (len < 50) add('warning', 'DESC_SHORT', `Meta description is ${len} chars (recommend 120–160)`);
        else if (len > 160) add('warning', 'DESC_LONG', `Meta description is ${len} chars (will truncate at ~160 in SERPs)`);
      }
    } else {
      add('warning', `MISSING_${c.code}`, `${label} missing: ${c.msg}`);
    }
  }

  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    const t = titleMatch[1].trim();
    if (t.length > 60) add('info', 'TITLE_LONG', `Title is ${t.length} chars (recommended <60)`, t);
    if (t.length < 10) add('warning', 'TITLE_SHORT', `Title is ${t.length} chars`, t);
  }

  if (HAS_DIST) {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) {
      const body = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '').trim();
      if (body.length < 200) add('critical', 'DEPLOYED_BLANK_BODY', `dist/index.html body has only ${body.length} chars of static content. Pre-render output looks incomplete.`);
      else add('pass', 'BODY_CONTENT', `Deployed index.html has ${body.length} chars of static body content`);
    }
  }
}

// ─── 2. Pre-rendering detection ──────────────────────────────────────────────
function checkPrerendering() {
  const hasScript = exists(path.join(ROOT, 'prerender.cjs')) || exists(path.join(ROOT, 'prerender.js'));
  const pkg = read(path.join(ROOT, 'package.json'));
  const pj = pkg ? JSON.parse(pkg) : {};
  const all = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}) };
  const hasPuppeteer = !!all.puppeteer;
  const hasOtherTool = !!(all['vite-plugin-ssg'] || all['react-snap'] || all['vite-react-ssg']);

  let renderedCount = 0;
  const unrenderedRoutes = [];
  if (HAS_DIST) {
    for (const r of STATIC_ROUTES) {
      const p = r === '/' ? path.join(ROOT, 'dist', 'index.html')
                          : path.join(ROOT, 'dist', ...r.split('/').filter(Boolean), 'index.html');
      if (exists(p)) {
        const html = read(p) || '';
        const body = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || '')
          .replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '').trim();
        if (body.length > 200) renderedCount++;
        else unrenderedRoutes.push(r);
      } else {
        unrenderedRoutes.push(r);
      }
    }
  }

  if (renderedCount > 0) {
    add('pass', 'PRERENDER_ACTIVE', `${renderedCount} of ${STATIC_ROUTES.length} static routes are pre-rendered with real body content`);
    if (unrenderedRoutes.length > 0) add('info', 'PRERENDER_GAPS', `Routes not pre-rendered: ${unrenderedRoutes.join(', ')}`);
  } else if (hasScript || hasPuppeteer || hasOtherTool) {
    add('warning', 'PRERENDER_NOT_RUN', 'Pre-rendering tooling is installed but dist/ has no rendered route folders. Run `node prerender.cjs` after `npm run build`.');
  } else {
    add('critical', 'NO_PRERENDER', 'No pre-rendering setup. SPAs without pre-rendering get poor SEO.');
  }

  if (pj.scripts?.build) {
    if (/prerender/.test(pj.scripts.build)) {
      add('pass', 'BUILD_WIRES_PRERENDER', 'package.json build script runs prerender (Railway will pre-render on deploy)');
    } else if (hasScript) {
      add('warning', 'BUILD_NO_PRERENDER', 'package.json build script does not run prerender.cjs.');
    }
  }
}

// ─── 3. robots.txt ───────────────────────────────────────────────────────────
function checkRobots() {
  const candidates = ['public/robots.txt', 'robots.txt', 'dist/robots.txt'];
  let found = null;
  for (const c of candidates) if (exists(path.join(ROOT, c))) { found = path.join(ROOT, c); break; }
  if (!found) { add('critical', 'ROBOTS_MISSING', 'robots.txt not found'); return; }
  const txt = read(found);
  add('pass', 'ROBOTS_PRESENT', `robots.txt found at ${rel(found)}`);
  if (!/sitemap:\s*https?:\/\//i.test(txt)) add('warning', 'ROBOTS_NO_SITEMAP', 'robots.txt does not reference sitemap.xml URL');
  else add('pass', 'ROBOTS_SITEMAP', 'robots.txt references sitemap');
  if (/disallow:\s*\/\s*$/im.test(txt)) add('critical', 'ROBOTS_BLOCK_ALL', 'robots.txt contains "Disallow: /"');
  if (!/user-agent:\s*\*/i.test(txt)) add('warning', 'ROBOTS_NO_UA', 'robots.txt missing "User-agent: *"');
}

// ─── 4. sitemap.xml ──────────────────────────────────────────────────────────
function checkSitemap() {
  const candidates = ['public/sitemap.xml', 'sitemap.xml', 'dist/sitemap.xml'];
  let found = null;
  for (const c of candidates) if (exists(path.join(ROOT, c))) { found = path.join(ROOT, c); break; }
  if (!found) { add('critical', 'SITEMAP_MISSING', 'sitemap.xml not found'); return; }
  const xml = read(found);
  add('pass', 'SITEMAP_PRESENT', `sitemap.xml found at ${rel(found)}`);
  const urls = (xml.match(/<loc>/g) || []).length;
  if (urls === 0) add('critical', 'SITEMAP_EMPTY', 'sitemap.xml has no <loc> entries');
  else if (urls < 50) add('warning', 'SITEMAP_SMALL', `sitemap.xml only has ${urls} URLs`);
  else add('pass', 'SITEMAP_URLS', `sitemap.xml has ${urls} URLs`);
  const badAmps = (xml.match(/&(?!(?:amp|lt|gt|apos|quot|#\d+);)/g) || []).length;
  if (badAmps > 0) add('critical', 'SITEMAP_UNESCAPED', `sitemap.xml has ${badAmps} unescaped ampersands`);
  if (/<loc>[^<]*#/.test(xml)) add('critical', 'SITEMAP_HASH_URLS', 'sitemap.xml contains hash (#) URLs');
}

// ─── 5. Bundle (data-aware) ──────────────────────────────────────────────────
function checkBundle() {
  const distAssets = path.join(ROOT, 'dist', 'assets');
  if (!exists(distAssets)) { add('info', 'NO_DIST', 'dist/ not built'); return; }
  const files = fs.readdirSync(distAssets).filter((f) => f.endsWith('.js'));

  let total = 0, codeTotal = 0, dataTotal = 0;
  let largestCode = { name: '', size: 0 };
  let largestData = { name: '', size: 0 };

  for (const f of files) {
    const s = fs.statSync(path.join(distAssets, f)).size;
    total += s;
    if (isDataChunk(f)) {
      dataTotal += s;
      if (s > largestData.size) largestData = { name: f, size: s };
    } else {
      codeTotal += s;
      if (s > largestCode.size) largestCode = { name: f, size: s };
    }
  }

  const totalKB = Math.round(total / 1024);
  const codeKB = Math.round(codeTotal / 1024);
  const dataKB = Math.round(dataTotal / 1024);
  const largestCodeKB = Math.round(largestCode.size / 1024);
  const largestDataKB = Math.round(largestData.size / 1024);

  add('info', 'BUNDLE_TOTAL', `Total JS: ${totalKB} kB across ${files.length} chunks (code: ${codeKB} kB, data: ${dataKB} kB)`);
  if (largestData.size > 0) {
    add('info', 'DATA_CHUNK', `Largest data chunk: ${largestData.name} (${largestDataKB} kB) — expected to be large with ${pj_products()} product catalog`);
  }

  // Code-only thresholds (the actual TTI risk).
  if (largestCodeKB > 500) {
    const level = largestCodeKB > 1500 ? 'critical' : 'warning';
    add(level, 'CODE_BUNDLE_LARGE',
      `Largest CODE chunk is ${largestCodeKB} kB (${largestCode.name}). Code bundles >500 kB hurt Time-To-Interactive.`,
      'Use React.lazy() for route components or split heavy pages into separate files.');
  } else {
    add('pass', 'CODE_BUNDLE_OK', `Largest code chunk is ${largestCodeKB} kB (${largestCode.name}) — under 500 kB threshold`);
  }

  if (files.length < 5) add('warning', 'NO_CODE_SPLIT', 'Limited code splitting. Consider lazy()/Suspense for routes.');
  else add('pass', 'CODE_SPLIT', `${files.length} chunks — good code splitting`);
}

function pj_products() {
  // Best-effort estimate from parts.js source size, falling back to "large".
  const partsFile = ['src/data/parts.js', 'src/data/parts.json'].map((p) => path.join(ROOT, p)).find(exists);
  if (!partsFile) return 'large';
  const lines = (read(partsFile) || '').split('\n').length;
  return `~${Math.round(lines / 1).toLocaleString()}-line`;
}

// ─── 6. Public assets ────────────────────────────────────────────────────────
function checkPublicAssets() {
  const html = read(path.join(ROOT, 'index.html')) || '';
  const checks = [
    { name: 'og-image', pattern: /og:image["']\s+content=["']([^"']+)/, search: ['public', '.', 'dist'] },
    { name: 'manifest', pattern: /rel=["']manifest["']\s+href=["']([^"']+)/, search: ['public', '.', 'dist'] },
    { name: 'favicon',  pattern: /rel=["'](?:shortcut\s+)?icon["']\s+href=["']([^"']+)/, search: ['public', '.', 'dist'] },
  ];
  for (const c of checks) {
    const m = html.match(c.pattern);
    if (!m) continue;
    let href = m[1].replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '');
    let found = false;
    for (const dir of c.search) if (exists(path.join(ROOT, dir, href))) { found = true; break; }
    if (!found) add('warning', `MISSING_${c.name.toUpperCase()}`, `${c.name} referenced but not found: ${href}`);
    else add('pass', `ASSET_${c.name.toUpperCase()}`, `${c.name} file exists: ${href}`);
  }
}

// ─── 7. PageMeta ─────────────────────────────────────────────────────────────
function checkPageMeta() {
  const pageMeta = read(path.join(ROOT, 'src', 'PageMeta.jsx'));
  if (!pageMeta) { add('critical', 'NO_PAGEMETA', 'src/PageMeta.jsx not found'); return; }
  const app = read(path.join(ROOT, 'src', 'App.jsx')) || '';
  const pages = new Set();
  for (const m of app.matchAll(/page\s*===?\s*["']([a-zA-Z0-9_-]+)["']/g)) pages.add(m[1]);
  const metaPages = new Set();
  const pagesObj = pageMeta.match(/const\s+PAGES\s*=\s*\{([\s\S]*?)\n\};/);
  if (pagesObj) for (const m of pagesObj[1].matchAll(/["']?([a-zA-Z0-9_-]+)["']?\s*:\s*\{/g)) metaPages.add(m[1]);
  const missing = [...pages].filter((p) => !metaPages.has(p));
  if (missing.length) add('warning', 'PAGEMETA_GAPS', `App.jsx pages with no PageMeta entry: ${missing.join(', ')}`);
  else if (pages.size > 0) add('pass', 'PAGEMETA_COVER', `All ${pages.size} App.jsx pages have PageMeta entries`);
  if (!/<PageMeta\b/.test(app)) add('critical', 'PAGEMETA_NOT_USED', 'PageMeta imported but not rendered in App.jsx');
}

// ─── 8. Images ───────────────────────────────────────────────────────────────
function checkImages() {
  const files = ['src/App.jsx', 'src/UpgradePage.jsx', 'src/PageMeta.jsx'];
  let totalImg = 0, missingAlt = 0;
  for (const f of files) {
    const txt = read(path.join(ROOT, f));
    if (!txt) continue;
    const imgs = txt.match(/<img\b[^>]*?\/?>/g) || [];
    totalImg += imgs.length;
    for (const tag of imgs) if (!/\balt\s*=/.test(tag)) missingAlt++;
  }
  if (totalImg === 0) { add('info', 'NO_IMG_TAGS', 'No <img> tags found'); return; }
  add('info', 'IMG_COUNT', `Found ${totalImg} <img> tags in main source files`);
  if (missingAlt > 0) add('warning', 'IMG_NO_ALT', `${missingAlt} of ${totalImg} <img> tags missing alt`);
  else add('pass', 'IMG_ALT', `All ${totalImg} <img> tags have alt`);
}

// ─── 9. Headings ─────────────────────────────────────────────────────────────
function checkHeadings() {
  const files = ['src/App.jsx', 'src/UpgradePage.jsx'];
  let h1 = 0, h2 = 0, h3 = 0;
  for (const f of files) {
    const txt = read(path.join(ROOT, f));
    if (!txt) continue;
    h1 += (txt.match(/<h1\b/g) || []).length;
    h2 += (txt.match(/<h2\b/g) || []).length;
    h3 += (txt.match(/<h3\b/g) || []).length;
  }
  add('info', 'HEADING_COUNT', `Headings (across all pages): ${h1} h1, ${h2} h2, ${h3} h3`);
  if (h1 === 0) add('warning', 'NO_H1', 'No <h1> tags found');
}

// ─── 10. Internal links ──────────────────────────────────────────────────────
function checkLinks() {
  const app = read(path.join(ROOT, 'src', 'App.jsx')) || '';
  const hashLinks = (app.match(/href=["']#[a-z]/gi) || []).length;
  const pathLinks = (app.match(/href=["']\/[a-z]/gi) || []).length;
  if (hashLinks > 0) add('warning', 'HASH_LINKS', `${hashLinks} legacy href="#..." links`);
  if (pathLinks === 0 && hashLinks === 0) add('info', 'NO_HARDCODED_LINKS', 'Using onClick navigation. Consider <a href="/..."> for crawlability.');
  else if (pathLinks > 0) add('pass', 'PATH_LINKS', `${pathLinks} path-based href links present`);
}

// ─── 11. SPA fallback ────────────────────────────────────────────────────────
function checkSpaRouting() {
  const nixpacks = read(path.join(ROOT, 'nixpacks.toml')) || '';
  const railwayJson = read(path.join(ROOT, 'railway.json')) || '';
  const serverCjs = read(path.join(ROOT, 'server.cjs')) || '';
  if (serverCjs && /sendFile\(.*index\.html/.test(serverCjs)) {
    add('pass', 'SPA_SERVE', 'server.cjs handles SPA fallback (sends index.html for unmatched routes)');
    return;
  }
  if (/serve\s+-s\b/.test(nixpacks) || /serve\s+-s\b/.test(railwayJson)) {
    add('pass', 'SPA_SERVE', 'serve -s configured (SPA fallback to root index.html)');
    return;
  }
  add('warning', 'SPA_NO_FALLBACK', 'No SPA fallback config detected');
}

// ─── 12. Perf hints ──────────────────────────────────────────────────────────
function checkPerfHints() {
  const html = read(path.join(ROOT, 'index.html')) || '';
  if (!/rel=["']preconnect["']/.test(html)) add('info', 'NO_PRECONNECT', 'No <link rel="preconnect"> hints');
  if (/<link[^>]+href=["']https?:\/\/fonts\.googleapis/.test(html) && !/rel=["']preconnect["'][^>]+fonts\.googleapis/.test(html)) {
    add('warning', 'GOOGLE_FONTS_NO_PRECONNECT', 'Google Fonts loaded without preconnect — adds ~200ms to FCP');
  }
}

// ─── Output ──────────────────────────────────────────────────────────────────
function report() {
  if (JSON_OUT) { console.log(JSON.stringify(findings, null, 2)); return; }
  const C = { critical: '\x1b[91m', warning: '\x1b[93m', info: '\x1b[94m', pass: '\x1b[92m', reset: '\x1b[0m', dim: '\x1b[90m' };
  const counts = {
    critical: findings.critical.length, warning: findings.warning.length,
    info: findings.info.length, pass: findings.pass.length,
  };
  console.log('\n  Pro Rig Builder — SEO Audit (v3)');
  console.log(`  ${HAS_DIST ? '[deployment-aware: reading dist/]' : '[source-only mode]'}`);
  console.log('  ' + '─'.repeat(50));
  console.log(`  ${C.critical}● ${counts.critical} critical${C.reset}    ${C.warning}● ${counts.warning} warning${C.reset}    ${C.info}● ${counts.info} info${C.reset}    ${C.pass}● ${counts.pass} pass${C.reset}`);
  console.log('  ' + '─'.repeat(50) + '\n');

  for (const level of ['critical', 'warning', 'info']) {
    if (findings[level].length === 0) continue;
    console.log(`  ${C[level]}${level.toUpperCase()}${C.reset}`);
    for (const f of findings[level]) {
      console.log(`    ${C[level]}●${C.reset} [${f.code}] ${f.msg}`);
      if (f.detail) console.log(`        ${C.dim}${f.detail.split('\n').join('\n        ')}${C.reset}`);
    }
    console.log('');
  }

  console.log(`  ${C.pass}PASSED CHECKS${C.reset} (${counts.pass}):`);
  for (const f of findings.pass) console.log(`    ${C.pass}✓${C.reset} ${C.dim}${f.msg}${C.reset}`);
  console.log('');

  if (counts.critical > 0) process.exit(2);
  if (counts.warning > 0) process.exit(1);
  process.exit(0);
}

checkHeadTags();
checkPrerendering();
checkRobots();
checkSitemap();
checkBundle();
checkPublicAssets();
checkPageMeta();
checkImages();
checkHeadings();
checkLinks();
checkSpaRouting();
checkPerfHints();
report();
