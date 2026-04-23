#!/usr/bin/env node
/**
 * repair-broken-asins.js
 *
 * Fixes the ~95 products flagged with wrong ASINs by:
 *   1. Reading quarantined products (needsReview=true) OR the latest report's title_mismatch list
 *   2. For each, trying candidate ASINs from a known-canonical lookup table
 *   3. Verifying each candidate via DataForSEO direct ASIN lookup
 *   4. Applying the fix to parts.js only if verified title matches stored name
 *
 * USAGE:
 *   railway run node repair-broken-asins.js [--dry-run] [--limit N]
 *
 * COST:
 *   ~$0.0015 per candidate lookup × 1-3 candidates per product = ~$0.15-0.40 total
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { canonicalizeProductName, extractModelToken } from './normalize-product-name.js';

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) { console.error('Missing DataForSEO creds'); process.exit(1); }
const AUTH = 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : null;

// ═══ KNOWN CANONICAL ASINS ═══
// These are canonical Amazon ASINs for common broken products.
// Sourced from Amazon Associates / Amazon.com direct product pages.
// Key format matches canonicalizeProductName output: "BRAND|line|model"
const CANDIDATE_ASINS = {
  // AMD Ryzen — AM5 (Zen 4/5)
  "AMD|Ryzen 9|9950X3D": ["B0DVZSG8D5"],
  "AMD|Ryzen 9|9900X3D": ["B0DWGWN8GY"],
  "AMD|Ryzen 9|9950X":   ["B0D6NNRBGP"],
  "AMD|Ryzen 9|9900X":   ["B0D6NN87T8"],
  "AMD|Ryzen 7|9800X3D": ["B0DHLBDSP9"],
  "AMD|Ryzen 7|9700X":   ["B0D6NMDNNX"],
  "AMD|Ryzen 5|9600X":   ["B0D6NN6TM7"],
  "AMD|Ryzen 5|9600":    ["B0DHK9JKP4"],
  "AMD|Ryzen 7|8700G":   ["B0CT5WMF67"],
  "AMD|Ryzen 5|8600G":   ["B0CT5R31R6"],
  "AMD|Ryzen 5|8500G":   ["B0CT5Y6T4J"],
  "AMD|Ryzen 3|8300G":   ["B0CTFBNJ3S"],
  // AMD Ryzen — AM5 (Zen 4)
  "AMD|Ryzen 9|7950X3D": ["B0BTRH9MNS"],
  "AMD|Ryzen 9|7900X3D": ["B0BTRRNK7T"],
  "AMD|Ryzen 7|7800X3D": ["B0BTZB7F88"],
  "AMD|Ryzen 9|7950X":   ["B0BBHD5D8Y"],
  "AMD|Ryzen 9|7900X":   ["B0BBJ59WJ4"],
  "AMD|Ryzen 7|7700X":   ["B0BBHHT12P"],
  "AMD|Ryzen 7|7700":    ["B0BN8T5B9B"],
  "AMD|Ryzen 5|7600X":   ["B0BBJDS62M"],
  "AMD|Ryzen 5|7600":    ["B0BN8V1FKT"],
  // AMD Ryzen — AM4 (Zen 3)
  "AMD|Ryzen 9|5950X":   ["B0815Y8J9N"],
  "AMD|Ryzen 9|5900X":   ["B08164VTWH"],
  "AMD|Ryzen 9|5900":    ["B08V5H7GGW"],
  "AMD|Ryzen 7|5800X3D": ["B09VCJ2SHD"],
  "AMD|Ryzen 7|5800X":   ["B0815XFSWZ"],
  "AMD|Ryzen 7|5800":    ["B08V5GDR93"],
  "AMD|Ryzen 7|5700X3D": ["B0CS1W5YKR"],
  "AMD|Ryzen 7|5700X":   ["B09VCHQTBQ"],
  "AMD|Ryzen 7|5700":    ["B0CQ4HPJYV"],
  "AMD|Ryzen 7|5700G":   ["B091J3NYVF"],
  "AMD|Ryzen 5|5600X3D": ["B0CFMP7LYZ"],
  "AMD|Ryzen 5|5600X":   ["B08166SLDF"],
  "AMD|Ryzen 5|5600":    ["B09VCJ171S"],
  "AMD|Ryzen 5|5600G":   ["B094DYR5Q4"],
  "AMD|Ryzen 5|5500":    ["B09VCJ2J1F"],
  "AMD|Ryzen 3|5300G":   ["B099NPZC68"],
  // AMD Ryzen — AM4 (Zen 2, 3000 series)
  "AMD|Ryzen 9|3950X":   ["B081FZV45H"],
  "AMD|Ryzen 9|3900X":   ["B07SXMZLP9"],
  "AMD|Ryzen 9|3900":    ["B081L7PM4F"],
  "AMD|Ryzen 7|3800X":   ["B07SXMZLPJ"],
  "AMD|Ryzen 7|3800XT":  ["B089VX3VFS"],
  "AMD|Ryzen 7|3700X":   ["B07SXMZLPQ"],
  "AMD|Ryzen 5|3600X":   ["B07SXDLHY1"],
  "AMD|Ryzen 5|3600":    ["B07STGGQ18"],
  "AMD|Ryzen 5|3500X":   ["B082J4SCZT"],
  "AMD|Ryzen 3|3300X":   ["B0876YS2T4"],
  "AMD|Ryzen 3|3100":    ["B0876Y2TMZ"],
  // Intel Core — LGA1851 (15th gen "Core Ultra")
  "INTEL|Core Ultra 9|285K":  ["B0DFK9MC4P"],
  "INTEL|Core Ultra 7|265K":  ["B0DFK8CNDY"],
  "INTEL|Core Ultra 7|265KF": ["B0DFK5Z1G2"],
  "INTEL|Core Ultra 5|245K":  ["B0DFK9WFKQ"],
  "INTEL|Core Ultra 5|245KF": ["B0DFK8HHK4"],
  // Intel Core — LGA1700 (13/14th gen)
  "INTEL|Core i9|14900KS": ["B0CW2ZHY8F"],
  "INTEL|Core i9|14900K":  ["B0CGJDKLB8"],
  "INTEL|Core i9|14900KF": ["B0CGJ5VKWL"],
  "INTEL|Core i9|14900":   ["B0CRG1TLCQ"],
  "INTEL|Core i7|14700K":  ["B0CGJ42DVR"],
  "INTEL|Core i7|14700KF": ["B0CGJ61R25"],
  "INTEL|Core i7|14700":   ["B0CQ1P2TRN"],
  "INTEL|Core i5|14600K":  ["B0CGJ9BTYC"],
  "INTEL|Core i5|14600KF": ["B0CGJDJ3PL"],
  "INTEL|Core i5|14500":   ["B0CRBLPZVV"],
  "INTEL|Core i5|14400":   ["B0CRGPFK4L"],
  "INTEL|Core i9|13900K":  ["B0BCF57FL5"],
  "INTEL|Core i9|13900KF": ["B0BG67Z31N"],
  "INTEL|Core i9|13900":   ["B0BQNZCKLZ"],
  "INTEL|Core i7|13700K":  ["B0BCF56L89"],
  "INTEL|Core i7|13700KF": ["B0BG6G5GH5"],
  "INTEL|Core i7|13700":   ["B0BQNZZ1KR"],
  "INTEL|Core i5|13600K":  ["B0BCF57FY5"],
  "INTEL|Core i5|13600KF": ["B0BG6BVCN5"],
  "INTEL|Core i5|13500":   ["B0BQNYV8FW"],
  "INTEL|Core i5|13400":   ["B0BQNRZ3WD"],
  "INTEL|Core i3|13100":   ["B0BQNYZ83M"],
  "INTEL|Core i5|12600K":  ["B09FXNVDBZ"],
  "INTEL|Core i5|12400":   ["B09NPHH1VD"],
  "INTEL|Core i3|12100":   ["B09NPFWQLN"],
  // Intel Core — LGA1200 (10/11th gen)
  "INTEL|Core i9|11900K":  ["B08X6MBVJ5"],
  "INTEL|Core i7|11700K":  ["B08X6NJDMF"],
  "INTEL|Core i5|11600K":  ["B08X69JR3F"],
  "INTEL|Core i5|11400":   ["B091HTK3L4"],
  "INTEL|Core i9|10900K":  ["B087J3C4NL"],
  "INTEL|Core i7|10700K":  ["B087J2JKV6"],
  "INTEL|Core i5|10600K":  ["B087HSWQVG"],
  "INTEL|Core i5|10400":   ["B0876FGC4Y"],
  "INTEL|Core i3|10105":   ["B08X8MKWZR"],
  "INTEL|Core i3|10100":   ["B086MGZZB2"],
  // NVIDIA GeForce RTX
  "NVIDIA|RTX|5090":        ["B0DTJ21D9Z"],
  "NVIDIA|RTX|5080":        ["B0DTJ2QBRJ"],
  "NVIDIA|RTX|5070 TI":     ["B0DTJ5YCY7"],
  "NVIDIA|RTX|5070":        ["B0DTJ4GBFY"],
  "NVIDIA|RTX|5060 TI":     ["B0F4J7B8MY"],
  "NVIDIA|RTX|5060":        ["B0F4J7CPKN"],
  "NVIDIA|RTX|4090":        ["B0BG94PS2F"],
  "NVIDIA|RTX|4080 SUPER":  ["B0CSHLV29V"],
  "NVIDIA|RTX|4080":        ["B0BJFRT43X"],
  "NVIDIA|RTX|4070 TI SUPER": ["B0CTPT5SDJ"],
  "NVIDIA|RTX|4070 TI":     ["B0BTKKX9LC"],
  "NVIDIA|RTX|4070 SUPER":  ["B0CSHJ47JF"],
  "NVIDIA|RTX|4070":        ["B0BZHFXRCF"],
  "NVIDIA|RTX|4060 TI":     ["B0C6TXX3HC"],
  "NVIDIA|RTX|4060":        ["B0C67ZM5F5"],
  "NVIDIA|RTX|3090 TI":     ["B09VDHGVVH"],
  "NVIDIA|RTX|3090":        ["B08J5F3G18"],
  "NVIDIA|RTX|3080 TI":     ["B096KPDXK1"],
  "NVIDIA|RTX|3080":        ["B08HR3Y5GC"],
  "NVIDIA|RTX|3070 TI":     ["B095XG8QDT"],
  "NVIDIA|RTX|3070":        ["B08HR7SV3M"],
  "NVIDIA|RTX|3060 TI":     ["B08WPRMVWB"],
  "NVIDIA|RTX|3060":        ["B08WXBNZ9H"],
  "NVIDIA|RTX|3050":        ["B09R24RXVC"],
  "NVIDIA|RTX|2080 TI":     ["B07HHN6KBZ"],
  "NVIDIA|RTX|2080 SUPER":  ["B07VJ6HC7H"],
  "NVIDIA|RTX|2070 SUPER":  ["B07V8CT8BF"],
  "NVIDIA|RTX|2060 SUPER":  ["B07V5HJQVF"],
  // AMD Radeon RX
  "AMD|RX|9070 XT":    ["B0DTPBFCTJ"],
  "AMD|RX|9070":       ["B0DTPBXTF5"],
  "AMD|RX|7900 XTX":   ["B0BN5F1VSW"],
  "AMD|RX|7900 XT":    ["B0BN5F7DW6"],
  "AMD|RX|7900":       ["B0CR3MF1YN"],
  "AMD|RX|7800 XT":    ["B0CDDLZX19"],
  "AMD|RX|7700 XT":    ["B0CDDHK9BY"],
  "AMD|RX|7600 XT":    ["B0CPZNWMWR"],
  "AMD|RX|7600":       ["B0C3Q94PG9"],
  "AMD|RX|6950 XT":    ["B09YMHV13Q"],
  "AMD|RX|6900 XT":    ["B08WPFPTLC"],
  "AMD|RX|6800 XT":    ["B08L8L7TKZ"],
  "AMD|RX|6800":       ["B08L8KRT2B"],
  "AMD|RX|6750 XT":    ["B09YMD9DY5"],
  "AMD|RX|6700 XT":    ["B08WQLPCVN"],
  "AMD|RX|6650 XT":    ["B09YMF9GNS"],
};

// ═══ DataForSEO ASIN lookup ═══
async function fetchASINTitle(asin) {
  // Post task
  const postRes = await fetch(`${BASE}/merchant/amazon/asin/task_post`, {
    method: 'POST',
    headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ language_code: 'en_US', location_code: 2840, asin }]),
  });
  const postJson = await postRes.json();
  const taskId = postJson?.tasks?.[0]?.id;
  if (!taskId) return null;

  // Poll for completion (max 60s)
  await new Promise(r => setTimeout(r, 8000));
  for (let attempt = 0; attempt < 12; attempt++) {
    const getRes = await fetch(`${BASE}/merchant/amazon/asin/task_get/advanced/${taskId}`, {
      headers: { 'Authorization': AUTH },
    });
    const getJson = await getRes.json();
    const task = getJson?.tasks?.[0];
    if (task?.status_code === 20000 && task?.result) {
      const item = task.result[0]?.items?.[0];
      return item ? { title: item.title, price: item.price?.current, asin } : null;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  return null;
}

// Check if two titles refer to the same exact product (strict model-token match)
function titlesMatch(storedName, amazonTitle, category) {
  if (!storedName || !amazonTitle) return false;
  const model = extractModelToken(storedName, category);
  if (!model) return false;
  const tokens = amazonTitle.toUpperCase().split(/[\s,\-\/\(\)\[\]™®]+/).filter(Boolean);
  return tokens.includes(model.toUpperCase());
}

// ═══ Load data ═══
console.log('Loading parts.js...');
const partsText = readFileSync('./src/data/parts.js', 'utf8');
const parts = (await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now())).PARTS;

// Find broken products: either quarantined (needsReview=true) OR flagged in latest report
const quarantined = parts.filter(p => p.needsReview);
console.log(`Found ${quarantined.length} quarantined products`);

// Also scan the latest report for title_mismatch products (they may not all be quarantined yet)
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const reports = readdirSync('./verify-reports')
  .filter(f => f.startsWith('report-') && f.endsWith('.md'))
  .map(f => ({ path: join('./verify-reports', f), mtime: statSync(join('./verify-reports', f)).mtime }))
  .sort((a, b) => b.mtime - a.mtime);
const latestReport = reports[0] ? readFileSync(reports[0].path, 'utf8') : '';
const flaggedIds = new Set();
const mmSection = latestReport.split('## title_mismatch').slice(1).join('');
for (const m of mmSection.matchAll(/id=(\d+)/g)) flaggedIds.add(parseInt(m[1]));
console.log(`Latest report flagged ${flaggedIds.size} title_mismatch products`);

// Combine: quarantined + flagged
const targetIds = new Set(quarantined.map(p => p.id));
for (const id of flaggedIds) targetIds.add(id);
const targets = parts.filter(p => targetIds.has(p.id));
console.log(`Total broken products to fix: ${targets.length}`);

const limited = LIMIT ? targets.slice(0, LIMIT) : targets;
console.log(`Processing: ${limited.length}${LIMIT ? ` (limited from ${targets.length})` : ''}`);
console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'APPLY FIXES'}\n`);

// ═══ Process each product ═══
const results = { fixed: 0, skipped_no_candidate: 0, skipped_no_match: 0, fixed_ids: [], unresolved: [] };

for (let i = 0; i < limited.length; i++) {
  const p = limited[i];
  const key = canonicalizeProductName(p.n, p.c);
  const candidates = key ? CANDIDATE_ASINS[key] : null;

  process.stdout.write(`[${i + 1}/${limited.length}] ${p.n.slice(0, 50).padEnd(50)} `);

  if (!candidates) {
    console.log('(no candidate — skipped)');
    results.skipped_no_candidate++;
    results.unresolved.push({ id: p.id, name: p.n, reason: 'no candidate ASIN in lookup table' });
    continue;
  }

  let found = null;
  for (const candidateASIN of candidates) {
    const result = await fetchASINTitle(candidateASIN);
    if (!result) continue;
    if (titlesMatch(p.n, result.title, p.c)) {
      found = { asin: candidateASIN, title: result.title, price: result.price };
      break;
    }
  }

  if (!found) {
    console.log('(candidates rejected — no match)');
    results.skipped_no_match++;
    results.unresolved.push({ id: p.id, name: p.n, reason: 'candidate lookups did not match title' });
    continue;
  }

  console.log(`-> ${found.asin} ✓`);
  results.fixed++;
  results.fixed_ids.push({ id: p.id, name: p.n, oldAsin: p.deals?.amazon?.url?.match(/dp\/([A-Z0-9]+)/)?.[1], newAsin: found.asin, newPrice: found.price });

  if (!DRY_RUN) {
    // Apply the fix
    const idx = parts.findIndex(x => x.id === p.id);
    if (idx >= 0) {
      if (!parts[idx].deals) parts[idx].deals = {};
      if (!parts[idx].deals.amazon) parts[idx].deals.amazon = {};
      parts[idx].deals.amazon.url = `https://www.amazon.com/dp/${found.asin}?tag=tiereduptech-20`;
      if (found.price != null) parts[idx].deals.amazon.price = found.price;
      parts[idx].deals.amazon.inStock = true;
      // Remove quarantine flag since we fixed it
      delete parts[idx].needsReview;
      delete parts[idx].quarantinedAt;
    }
  }
}

// ═══ Write parts.js ═══
if (!DRY_RUN && results.fixed > 0) {
  const header = '// Auto-merged catalog. Edit with care.\n';
  const content = header + 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
  writeFileSync('./src/data/parts.js', content);
  console.log(`\nWrote parts.js with ${results.fixed} ASIN fixes`);
}

// ═══ Summary ═══
console.log('\n═══ SUMMARY ═══');
console.log(`Fixed: ${results.fixed}`);
console.log(`Skipped (no candidate in table): ${results.skipped_no_candidate}`);
console.log(`Skipped (candidate didn't match): ${results.skipped_no_match}`);
if (results.fixed_ids.length) {
  console.log('\nFixed products:');
  results.fixed_ids.slice(0, 20).forEach(f => console.log(`  id=${f.id} ${f.oldAsin} → ${f.newAsin} | ${f.name.slice(0, 50)}`));
  if (results.fixed_ids.length > 20) console.log(`  ... and ${results.fixed_ids.length - 20} more`);
}
if (results.unresolved.length && results.unresolved.length <= 30) {
  console.log('\nUnresolved products (remain quarantined):');
  results.unresolved.forEach(u => console.log(`  id=${u.id} | ${u.name.slice(0, 50)} — ${u.reason}`));
}
