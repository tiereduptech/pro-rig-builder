// Fetches PassMark G3D Mark scores from videocardbenchmark.net
// Writes passmark-gpus.json: { "GeForce RTX 4090": 38062, ... }

import { writeFileSync } from 'node:fs';

const TIERS = [
  'https://www.videocardbenchmark.net/high_end_gpus.html',
  'https://www.videocardbenchmark.net/mid_range_gpus.html',
  'https://www.videocardbenchmark.net/midlow_range_gpus.html',
  'https://www.videocardbenchmark.net/low_end_gpus.html',
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchTier(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return await res.text();
}

// Each GPU entry is an anchor tag:
//   <a href="gpu.php?gpu=NAME&id=NNN"> ... NAME ... (XX%) ... SCORE ... PRICE </a>
// Pull NAME from the href param; score is the first number after "%)".
function parseChart(html) {
  const results = {};
  const linkRe = /<a[^>]+href="[^"]*gpu\.php\?gpu=([^&"]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
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
      console.log(`${count} cards (${html.length} bytes)`);
      if (count === 0) {
        const idx = html.indexOf('gpu.php');
        if (idx >= 0) console.log(`    DEBUG: ${html.slice(idx, idx + 300)}`);
        else console.log(`    DEBUG: no 'gpu.php' occurrence in body`);
      }
      Object.assign(all, tier);
    } catch (e) {
      console.log(`FAIL (${e.message})`);
    }
  }

  const total = Object.keys(all).length;
  writeFileSync('passmark-gpus.json', JSON.stringify(all, null, 2));
  console.log(`\n✔ Wrote passmark-gpus.json (${total} unique cards)`);

  console.log('\nAnchor candidates (RTX 4090):');
  Object.keys(all)
    .filter(k => /RTX\s*4090/i.test(k))
    .sort()
    .forEach(k => console.log(`  ${k} → ${all[k].toLocaleString()}`));

  console.log('\nSanity check:');
  ['RTX 5090', 'RTX 5080', 'RTX 5070 Ti', 'RTX 4070 Ti', 'RTX 3060', 'RX 7900 XTX', 'RX 6600', 'GTX 1660'].forEach(q => {
    const match = Object.keys(all).find(k => new RegExp(`\\b${q.replace(/ /g, '\\s*')}\\b`, 'i').test(k));
    console.log(`  ${q.padEnd(15)} → ${match ? `${match} (${all[match].toLocaleString()})` : 'NOT FOUND'}`);
  });
})();
