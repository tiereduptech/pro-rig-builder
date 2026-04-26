// =============================================================================
//  submit-for-indexing.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Two-track indexing acceleration:
//
//  Track 1 — Google (manual)
//    Outputs a prioritized list of 50 URLs to PRIORITY_URLS.txt. Submit each
//    one via Google Search Console → URL Inspection → "Request indexing".
//    GSC limits ~10 submissions per property per day, so this typically takes
//    5 days to clear the list. Speeds organic discovery from weeks to days.
//
//  Track 2 — Bing/Yandex (automated, IndexNow protocol)
//    Submits ALL sitemap URLs in a single HTTP request to IndexNow. No auth
//    required — verification is via a key file served from your domain.
//    Bing usually crawls submitted URLs within hours.
//
//  First run: generates an IndexNow key + key file (commits to public/), then
//  exits. Re-run after the key file is deployed to actually submit.
//
//  Usage:
//    node submit-for-indexing.cjs              # full run
//    node submit-for-indexing.cjs --gsc-only   # just write priority list
//    node submit-for-indexing.cjs --indexnow-only
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const ROOT = process.cwd();
const SITE = 'https://prorigbuilder.com';
const SITEMAP = path.join(ROOT, 'public', 'sitemap.xml');
const KEY_DIR = path.join(ROOT, 'public');
const PRIORITY_FILE = path.join(ROOT, 'PRIORITY_URLS.txt');
const KEY_RECORD = path.join(ROOT, '.indexnow-key');

const argv = process.argv.slice(2);
const GSC_ONLY = argv.includes('--gsc-only');
const INDEXNOW_ONLY = argv.includes('--indexnow-only');

// ─── Read sitemap and extract URLs ──────────────────────────────────────────
function readSitemapUrls() {
  if (!fs.existsSync(SITEMAP)) {
    console.error(`  ✗ ${SITEMAP} not found`);
    process.exit(1);
  }
  const xml = fs.readFileSync(SITEMAP, 'utf8');
  const urls = [];
  const re = /<loc>([^<]+)<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    urls.push(m[1].replace(/&amp;/g, '&'));
  }
  return urls;
}

// ─── Track 1: Top 50 priority URLs for GSC ──────────────────────────────────
function writePriorityList() {
  const urls = readSitemapUrls();

  // Tier 1: Homepage + the 16 static marketing pages.
  const TIER_1_PATHS = new Set([
    '/', '/search', '/builder', '/community', '/tools', '/upgrade', '/scanner',
    '/about', '/contact', '/privacy', '/terms', '/affiliate', '/compare',
    '/vs-pcpartpicker', '/pcpartpicker-alternative', '/best-pc-builder-tools',
  ]);

  // Tier 2: Category browse pages (/search?cat=X with no id).
  // Tier 3: Specific products (lowest priority for manual submission).

  const tier1 = [];
  const tier2 = [];
  for (const u of urls) {
    const p = u.replace(SITE, '');
    if (TIER_1_PATHS.has(p)) tier1.push(u);
    else if (p.startsWith('/search?cat=') && !p.includes('&id=')) tier2.push(u);
  }

  // Take top 33 categories to fill out 50-URL list (alphabetical for stability).
  tier2.sort();
  const top50 = [...tier1, ...tier2.slice(0, 50 - tier1.length)];

  const lines = [];
  lines.push('# Pro Rig Builder — Priority URLs for Google Search Console');
  lines.push('# Submit each via: GSC → URL Inspection → paste URL → Request Indexing');
  lines.push('# GSC limits ~10/day, so plan on 5 days to clear this list.');
  lines.push('#');
  lines.push(`# Generated: ${new Date().toISOString()}`);
  lines.push(`# Total: ${top50.length} URLs (${tier1.length} static pages + ${top50.length - tier1.length} category pages)`);
  lines.push('');
  lines.push('## Tier 1 — Static pages (do these FIRST)');
  for (const u of tier1) lines.push(u);
  lines.push('');
  lines.push('## Tier 2 — Category pages');
  for (const u of top50.slice(tier1.length)) lines.push(u);

  fs.writeFileSync(PRIORITY_FILE, lines.join('\n') + '\n', 'utf8');
  console.log(`  ✓ Wrote ${top50.length} URLs to ${PRIORITY_FILE}`);
  return top50;
}

// ─── Track 2: IndexNow submission to Bing/Yandex ────────────────────────────
function getOrCreateIndexNowKey() {
  if (fs.existsSync(KEY_RECORD)) {
    return fs.readFileSync(KEY_RECORD, 'utf8').trim();
  }
  // 32-char hex key per IndexNow spec.
  const key = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(KEY_RECORD, key, 'utf8');
  // Key file MUST be served at https://prorigbuilder.com/{key}.txt with the
  // key as its content. Vite copies public/* to dist/* during build.
  fs.writeFileSync(path.join(KEY_DIR, `${key}.txt`), key, 'utf8');
  console.log(`  ✓ Generated IndexNow key: ${key}`);
  console.log(`    Key file written to public/${key}.txt`);
  console.log(`    This must be deployed before IndexNow submission will work.`);
  return key;
}

async function submitToIndexNow(urls, key) {
  // Verify the key file is reachable on the live site.
  const keyUrl = `${SITE}/${key}.txt`;
  console.log(`  Verifying key file at ${keyUrl}...`);
  const verified = await new Promise((resolve) => {
    https.get(keyUrl, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(res.statusCode === 200 && body.trim() === key));
    }).on('error', () => resolve(false));
  });

  if (!verified) {
    console.error(`  ✗ Key file not yet accessible at ${keyUrl}`);
    console.error('    Commit + push, wait for Railway redeploy, then re-run.');
    return;
  }
  console.log('  ✓ Key file verified');

  // IndexNow accepts up to 10,000 URLs per request.
  const payload = JSON.stringify({
    host: SITE.replace(/^https?:\/\//, ''),
    key,
    keyLocation: keyUrl,
    urlList: urls,
  });

  const opts = {
    hostname: 'api.indexnow.org',
    port: 443,
    path: '/IndexNow',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        // 200 = accepted, 202 = accepted (async), 400+ = problem
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        console.log(`  ${ok ? '✓' : '✗'} IndexNow response: HTTP ${res.statusCode}`);
        if (body) console.log(`    ${body.slice(0, 300)}`);
        if (ok) console.log(`  ✓ Submitted ${urls.length} URLs to Bing/Yandex via IndexNow`);
        resolve(ok);
      });
    });
    req.on('error', (e) => {
      console.error(`  ✗ Request failed: ${e.message}`);
      resolve(false);
    });
    req.write(payload);
    req.end();
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  console.log('Pro Rig Builder — Indexing Submission');
  console.log('=====================================\n');

  if (!INDEXNOW_ONLY) {
    console.log('Track 1 — Google Search Console priority list');
    console.log('-'.repeat(50));
    writePriorityList();
    console.log('');
  }

  if (!GSC_ONLY) {
    console.log('Track 2 — IndexNow (Bing / Yandex / DuckDuckGo)');
    console.log('-'.repeat(50));
    const key = getOrCreateIndexNowKey();
    const urls = readSitemapUrls();
    console.log(`  Submitting ${urls.length} URLs from sitemap...`);
    await submitToIndexNow(urls, key);
    console.log('');
  }

  console.log('=====================================');
  console.log('Next steps:');
  if (!INDEXNOW_ONLY) {
    console.log(`  1. Open ${PRIORITY_FILE}`);
    console.log('  2. In GSC, paste each URL into the search bar at the top');
    console.log('  3. Click "Request Indexing" on each');
    console.log('  4. Aim for 10/day to avoid quota limits');
  }
  console.log('');
})();
