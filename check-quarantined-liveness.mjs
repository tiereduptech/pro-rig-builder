// Check if quarantined products' Amazon URLs still work
// If URL returns 200 (or redirect to valid product), unquarantine
// If URL is dead/redirected-to-out-of-stock page, keep quarantined

import fs from 'node:fs';

const PARTS_PATH = 'src/data/parts.js';

// Load catalog
const mod = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
const parts = mod.PARTS || mod.default;

// Find quarantined singles (NOT real bundles)
const BUNDLE_REGEX = /\swith\s|\scombo\b|\skit\b|\sbundle\b|gaming pc\b/i;
const quarantined = parts.filter(p =>
  (p.needsReview === true || p.bundle === true) &&
  !BUNDLE_REGEX.test(p.n || '')
);

console.log(`Found ${quarantined.length} quarantined singles to check\n`);

// Small pause between requests to be nice to Amazon
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Check URL liveness. Amazon returns different behaviors:
//   200 = product page exists and is live
//   404 = gone
//   302/301 redirect to same domain usually means URL changed but product exists
//   redirect to /errors/validateCaptcha = rate limited (retry)
async function checkUrl(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    // Direct success
    if (res.status >= 200 && res.status < 300) return { alive: true, status: res.status };

    // Redirect - check target
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || '';
      // Bad redirects
      if (/validateCaptcha|bot-detection|\/gp\/help\/customer\/display/i.test(loc)) {
        return { alive: null, status: res.status, reason: 'captcha/bot', location: loc };
      }
      // Redirect staying on amazon = product probably exists
      if (/amazon\.com/i.test(loc) || loc.startsWith('/')) {
        return { alive: true, status: res.status, reason: 'redirect ok', location: loc };
      }
      return { alive: false, status: res.status, reason: 'off-site redirect', location: loc };
    }

    if (res.status === 404) return { alive: false, status: 404, reason: 'not found' };
    if (res.status === 503 || res.status === 429) return { alive: null, status: res.status, reason: 'rate limited' };

    return { alive: false, status: res.status };
  } catch (err) {
    return { alive: null, status: 0, reason: 'fetch error: ' + err.message };
  }
}

// Check each quarantined product
const results = [];
let checked = 0;

for (const p of quarantined) {
  checked++;
  const url = p.deals?.amazon?.url;
  if (!url) {
    results.push({ p, result: { alive: false, reason: 'no URL' } });
    continue;
  }

  process.stdout.write(`[${checked}/${quarantined.length}] ${p.n.slice(0, 60).padEnd(60)} ... `);
  const result = await checkUrl(url);
  results.push({ p, result });

  const icon = result.alive === true ? '✓' : result.alive === false ? '✗' : '?';
  console.log(`${icon} status:${result.status} ${result.reason || ''}`);

  // Pause to avoid rate limits
  await sleep(800);
}

// Summary
const alive = results.filter(r => r.result.alive === true);
const dead = results.filter(r => r.result.alive === false);
const unknown = results.filter(r => r.result.alive === null);

console.log('\n============================');
console.log(`ALIVE (unquarantine): ${alive.length}`);
console.log(`DEAD (keep quarantined): ${dead.length}`);
console.log(`UNKNOWN (rate-limit/captcha): ${unknown.length}`);
console.log('============================\n');

if (unknown.length > 0) {
  console.log('Rate-limited products (skipped, try again later):');
  unknown.forEach(r => console.log('  - [' + r.p.c + '] ' + r.p.n.slice(0, 70)));
}

// Ask for confirmation before modifying parts.js
console.log('\nTo UNQUARANTINE the ' + alive.length + ' alive products, run:');
console.log('   node unquarantine-alive.mjs');

// Write the alive IDs to a file so the next script can read them
const aliveIds = alive.map(r => r.p.id);
fs.writeFileSync('alive-ids.json', JSON.stringify(aliveIds, null, 2));
console.log('\nWrote ' + aliveIds.length + ' IDs to alive-ids.json');
