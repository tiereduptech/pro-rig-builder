// Fetches PassMark CPU Mark scores from cpubenchmark.net
// Writes passmark-cpus.json: { "Intel Core i9-14900K": 62347, ... }

import { writeFileSync } from 'node:fs';

const TIERS = [
  'https://www.cpubenchmark.net/high_end_cpus.html',
  'https://www.cpubenchmark.net/mid_range_cpus.html',
  'https://www.cpubenchmark.net/midlow_range_cpus.html',
  'https://www.cpubenchmark.net/low_end_cpus.html',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchTier(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return await res.text();
}

function parseChart(html) {
  const results = {};
  const linkRe = /<a[^>]+href="[^"]*cpu\.php\?cpu=([^&"]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const name = decodeURIComponent(m[1].replace(/\+/g, ' ')).replace(/\s+/g, ' ').trim();
    const body = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    const pct = body.match(/%\)\s*([\d,]+)/);
    if (!pct) continue;
    const score = parseInt(pct[1].replace(/,/g, ''), 10);
    if (!Number.isFinite(score) || score <= 0) continue;
    if (!results[name] || results[name] < score) results[name] = score;
  }
  return results;
}

(async () => {
  const all = {};
  for (const url of TIERS) {
    process.stdout.write(`  ${url.split('/').pop()} ... `);
    try {
      const html = await fetchTier(url);
      const tier = parseChart(html);
      const count = Object.keys(tier).length;
      console.log(`${count} cpus (${html.length} bytes)`);
      Object.assign(all, tier);
    } catch (e) {
      console.log(`FAIL (${e.message})`);
    }
  }

  const total = Object.keys(all).length;
  writeFileSync('passmark-cpus.json', JSON.stringify(all, null, 2));
  console.log(`\n✔ Wrote passmark-cpus.json (${total} unique CPUs)`);

  console.log('\nTop 10 by score:');
  Object.entries(all)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([k, v]) => console.log(`  ${v.toLocaleString().padStart(7)}  ${k}`));

  console.log('\nSanity check:');
  ['Core i9-14900K', 'Core Ultra 9 285K', 'Ryzen 9 9950X3D', 'Ryzen 9 7950X3D', 'Ryzen 7 7800X3D', 'Core i5-13600K', 'Ryzen 5 7600X'].forEach(q => {
    const match = Object.keys(all).find(k => new RegExp(`\\b${q.replace(/ /g, '\\s*').replace(/-/g, '-?')}\\b`, 'i').test(k));
    console.log(`  ${q.padEnd(22)} → ${match ? `${match} (${all[match].toLocaleString()})` : 'NOT FOUND'}`);
  });
})();
