#!/usr/bin/env node
/**
 * test-url-resolution.js
 *
 * Picks 3 cases per brand from top 10 brands. For each, attempts to find
 * the canonical manufacturer product page URL using DuckDuckGo HTML search
 * (free, no rate limits, works for most product names).
 *
 * Output: a report showing which brands work and which don't.
 *
 * No data is modified — this is a read-only test.
 *
 * Usage: node test-url-resolution.js
 */

const TARGET_BRANDS = {
  'Corsair':       { domain: 'corsair.com',       siteFilter: 'corsair.com' },
  'NZXT':          { domain: 'nzxt.com',          siteFilter: 'nzxt.com' },
  'Lian Li':       { domain: 'lian-li.com',       siteFilter: 'lian-li.com' },
  'Fractal Design':{ domain: 'fractal-design.com',siteFilter: 'fractal-design.com' },
  'Phanteks':      { domain: 'phanteks.com',      siteFilter: 'phanteks.com' },
  'Thermaltake':   { domain: 'thermaltake.com',   siteFilter: 'thermaltake.com' },
  'Cooler Master': { domain: 'coolermaster.com',  siteFilter: 'coolermaster.com' },
  'be quiet!':     { domain: 'bequiet.com',       siteFilter: 'bequiet.com' },
  'Jonsbo':        { domain: 'jonsbo.com',        siteFilter: 'jonsbo.com' },
  'HYTE':          { domain: 'hyte.com',          siteFilter: 'hyte.com' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const cases = mod.PARTS.filter(p => p.c === 'Case');

// ─── Pick 3 cases per brand ──────────────────────────────────────────
console.log('━━━ SAMPLE SELECTION ━━━');
const samples = [];
for (const [brand, cfg] of Object.entries(TARGET_BRANDS)) {
  const brandCases = cases.filter(p => p.b === brand);
  const picks = brandCases.slice(0, 3);
  console.log(`  ${brand.padEnd(16)} ${brandCases.length} total, picking ${picks.length}`);
  for (const p of picks) samples.push({ ...p, _brand: brand, _domain: cfg.domain });
}
console.log(`\n  Total samples: ${samples.length}`);

// ─── DuckDuckGo HTML search ──────────────────────────────────────────
// We use html.duckduckgo.com (no JavaScript rendering, easy to parse)
async function ddgSearch(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `q=${encodeURIComponent(query)}`,
    });
    if (!res.ok) return { ok: false, err: `HTTP ${res.status}` };
    const html = await res.text();
    // Parse result URLs — DDG wraps them in a redirect that includes the real URL
    // Format: <a class="result__a" href="//duckduckgo.com/l/?uddg=ENCODED_REAL_URL&...
    // Or sometimes direct: <a class="result__a" href="https://...">
    const urls = [];
    const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"/g;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      let u = m[1];
      // Decode redirect wrapper
      const uddg = u.match(/uddg=([^&]+)/);
      if (uddg) {
        try { u = decodeURIComponent(uddg[1]); } catch {}
      }
      // Convert protocol-relative
      if (u.startsWith('//')) u = 'https:' + u;
      urls.push(u);
    }
    return { ok: true, urls };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

// Build a clean search query for a case
function buildQuery(brand, name) {
  // Strip marketing fluff to focus on the model
  const clean = name
    .replace(/\bATX\s*Mid-?Tower\b/gi, '')
    .replace(/\bMid-?Tower\b/gi, '')
    .replace(/\bFull-?Tower\b/gi, '')
    .replace(/\bCompact\b/gi, '')
    .replace(/\bGaming\b/gi, '')
    .replace(/\bComputer\b/gi, '')
    .replace(/\bChassis\b/gi, '')
    .replace(/\bPC\s*Case\b/gi, '')
    .replace(/\bCase\b/gi, '')
    .replace(/\(.*?\)/g, '')
    .replace(/[,–—-]\s*[\w\s]+$/g, '') // strip trailing color/SKU clauses
    .replace(/\s+/g, ' ')
    .trim();
  return `${brand} ${clean}`.slice(0, 80);
}

// Pick the URL most likely to be a product page (matches domain, has /p/ or /product/, etc.)
function pickProductUrl(urls, domain) {
  const candidates = urls.filter(u => u.includes(domain));
  if (!candidates.length) return null;
  // Prefer URLs that look like product pages
  const ranked = candidates
    .map(u => {
      let score = 0;
      if (/\/p\/|\/product\/|\/products\//i.test(u)) score += 100;
      if (/case|chassis|tower/i.test(u)) score += 30;
      if (/\/blog\/|\/news\/|\/explorer\/|\/community\/|\/forum/i.test(u)) score -= 50;
      if (/\.pdf$/.test(u)) score -= 100;
      // Prefer shorter URLs (more likely canonical)
      score -= u.length / 100;
      return { url: u, score };
    })
    .sort((a, b) => b.score - a.score);
  return ranked[0].url;
}

// ─── RUN ─────────────────────────────────────────────────────────────
console.log('\n━━━ TESTING URL RESOLUTION ━━━');
console.log('  (2s delay between requests to avoid rate-limiting)\n');

const results = [];
for (const sample of samples) {
  const query = buildQuery(sample._brand, sample.n);
  process.stdout.write(`  [${sample._brand.padEnd(16)}] ${sample.n.slice(0, 60).padEnd(62)}`);

  const r = await ddgSearch(query);
  if (!r.ok) {
    console.log(` ✗ ${r.err}`);
    results.push({ ...sample, _query: query, _url: null, _err: r.err });
    await new Promise(r => setTimeout(r, 2000));
    continue;
  }

  const url = pickProductUrl(r.urls, sample._domain);
  if (!url) {
    console.log(` ✗ no ${sample._domain} URL in ${r.urls.length} results`);
    results.push({ ...sample, _query: query, _url: null });
  } else {
    console.log(` ✓`);
    results.push({ ...sample, _query: query, _url: url });
  }
  await new Promise(r => setTimeout(r, 2000));
}

// ─── REPORT ──────────────────────────────────────────────────────────
console.log('\n━━━ RESULTS BY BRAND ━━━');
const byBrand = {};
for (const r of results) {
  if (!byBrand[r._brand]) byBrand[r._brand] = { found: 0, total: 0, samples: [] };
  byBrand[r._brand].total++;
  if (r._url) byBrand[r._brand].found++;
  byBrand[r._brand].samples.push(r);
}
for (const [brand, stats] of Object.entries(byBrand)) {
  const pct = Math.round(stats.found / stats.total * 100);
  console.log(`\n  ${brand} (${stats.found}/${stats.total}, ${pct}%)`);
  for (const s of stats.samples) {
    console.log(`    ${s._url ? '✓' : '✗'} ${s.n.slice(0, 65)}`);
    if (s._url) console.log(`       → ${s._url}`);
    else console.log(`       query: "${s._query}"`);
  }
}

const totalFound = results.filter(r => r._url).length;
console.log(`\n━━━ OVERALL ${totalFound}/${results.length} (${Math.round(totalFound / results.length * 100)}%) ━━━`);
