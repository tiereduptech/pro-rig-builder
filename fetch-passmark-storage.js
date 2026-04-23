// Fetches PassMark Disk Mark scores from harddrivebenchmark.net
// Pulls from multiple sources to maximize coverage.

import { writeFileSync } from 'node:fs';

// URLs to try — paginated SSD chart + value chart + tier pages + mega page
const URLS = [
  'https://www.harddrivebenchmark.net/high_end_drives.html',
  'https://www.harddrivebenchmark.net/mid_range_drives.html',
  'https://www.harddrivebenchmark.net/low_end_drives.html',
  'https://www.harddrivebenchmark.net/ssd.html',
  'https://www.harddrivebenchmark.net/ssd.html?page=2',
  'https://www.harddrivebenchmark.net/ssd.html?page=3',
  'https://www.harddrivebenchmark.net/ssd.html?page=4',
  'https://www.harddrivebenchmark.net/hdd.html',
  'https://www.harddrivebenchmark.net/hdd.html?page=2',
  'https://www.harddrivebenchmark.net/hdd.html?page=3',
  'https://www.harddrivebenchmark.net/hdd.html?page=4',
  'https://www.harddrivebenchmark.net/common_drives.html',
  'https://www.harddrivebenchmark.net/hdd_value.html',
  'https://www.harddrivebenchmark.net/hdd-mega-page.html',
  'https://www.harddrivebenchmark.net/large_drives.html',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchUrl(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function parseChart(html) {
  const results = {};
  // Handle hdd/drive/ssd URL params — they all point to the same lookup page
  const linkRe = /<a[^>]+href="[^"]*(?:hdd|drive|ssd)\.php\?(?:hdd|drive|ssd)=([^&"]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
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
  let totalNew = 0;
  for (const url of URLS) {
    const label = url.replace('https://www.harddrivebenchmark.net/', '').slice(0, 40);
    process.stdout.write(`  ${label.padEnd(42)} ... `);
    try {
      const html = await fetchUrl(url);
      const tier = parseChart(html);
      const count = Object.keys(tier).length;
      let newCount = 0;
      for (const [k, v] of Object.entries(tier)) {
        if (!all[k]) { all[k] = v; newCount++; }
        else if (all[k] < v) all[k] = v;
      }
      totalNew += newCount;
      console.log(`${count} drives, +${newCount} new (total ${Object.keys(all).length})`);
    } catch (e) {
      console.log(`FAIL (${e.message})`);
    }
  }

  const total = Object.keys(all).length;
  writeFileSync('passmark-storage.json', JSON.stringify(all, null, 2));
  console.log(`\n✔ Wrote passmark-storage.json (${total} unique drives)`);

  // Look for key drives the catalog has
  console.log('\nCoverage check for common catalog drives:');
  const checks = [
    'Samsung 870 EVO', 'Crucial MX500', 'WD Blue SA510', 'WD Blue SN580',
    'Kingston NV2', 'Kingston NV3', 'Samsung 980 PRO', 'SK Hynix Platinum P41',
    'Seagate Barracuda', 'WD Red', 'Seagate IronWolf', 'Toshiba X300',
    'Crucial BX500', 'Kingston A400', 'Kingston KC3000', 'Samsung 990 Pro',
  ];
  for (const q of checks) {
    const tokens = q.toLowerCase().split(/\s+/);
    const matches = Object.keys(all).filter(k => {
      const kl = k.toLowerCase();
      return tokens.every(t => kl.includes(t));
    });
    const top = matches.sort((a, b) => all[b] - all[a])[0];
    console.log(`  ${q.padEnd(24)} → ${matches.length.toString().padStart(2)} matches ${top ? `(top: ${top} @ ${all[top].toLocaleString()})` : ''}`);
  }
})();
