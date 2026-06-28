// Throwaway diagnostic: scan Storage products for capacity/price mismatches.
const mod = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
const parts = mod.PARTS;
const storage = parts.filter(p => p.c === 'Storage');

// Parse a capacity in GB from a free-text name.
function nameCapGB(n) {
  if (!n) return null;
  // Prefer the first capacity-looking token near the start.
  const m = n.match(/(\d+(?:\.\d+)?)\s*(TB|GB)\b/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return /tb/i.test(m[2]) ? v * 1000 : v;
}

function isHDD(p) {
  const s = (p.storageType || p.form || '') + ' ' + (p.n || '');
  return /hdd|hard drive|7200|5400|barracuda|ironwolf|wd red|wd blue \d+tb pc|surveillance|nas internal/i.test(s)
    && !/ssd|nvme/i.test((p.storageType || p.form || ''));
}

const rows = [];
for (const p of storage) {
  const dealPrice = p.deals?.amazon?.price ?? null;
  const price = dealPrice ?? p.pr ?? null;
  const capName = nameCapGB(p.n);
  const capField = p.cap ?? null;
  const tb = capField ? capField / 1000 : (capName ? capName / 1000 : null);
  const pricePerTB = (price && tb) ? price / tb : null;
  const hdd = isHDD(p);

  const flags = [];
  // 1. name vs cap field disagreement beyond marketing rounding (>10% = real bug,
  //    not 512↔500 / 1.92TB↔2000 decimal-vs-marketing convention).
  if (capName && capField && Math.abs(capName - capField) / capField > 0.10) {
    flags.push(`NAME/CAP_MISMATCH name=${capName}GB cap=${capField}GB (${Math.round(Math.abs(capName-capField)/capField*100)}% off)`);
  }
  // 2. implausibly LOW $/TB. SSD floor ~$15/TB, HDD floor ~$8/TB (2026).
  if (pricePerTB != null) {
    const floor = hdd ? 8 : 15;
    if (pricePerTB < floor) {
      flags.push(`LOW_$/TB $${pricePerTB.toFixed(2)}/TB (${hdd ? 'HDD' : 'SSD'} floor ~$${floor})`);
    }
    // implausibly HIGH $/TB for a consumer SSD/HDD (>$400/TB → wrong big/enterprise ASIN attached)
    if (!hdd && pricePerTB > 400) {
      flags.push(`HIGH_$/TB $${pricePerTB.toFixed(2)}/TB (consumer SSD ceiling ~$400)`);
    }
  }
  // 3. deal price wildly below list pr (possible wrong-ASIN attach)
  if (dealPrice != null && p.pr && dealPrice < p.pr * 0.4) {
    flags.push(`DEAL<<PR deal=$${dealPrice} pr=$${p.pr} (${Math.round((1-dealPrice/p.pr)*100)}% off)`);
  }
  // 4. deal price ABOVE list pr — a "deal" can never cost more than MSRP (wrong-ASIN attach)
  if (dealPrice != null && p.pr && dealPrice > p.pr * 1.05) {
    flags.push(`DEAL>PR deal=$${dealPrice} pr=$${p.pr} (deal is ${Math.round((dealPrice/p.pr-1)*100)}% OVER list)`);
  }

  if (flags.length) {
    rows.push({ id: p.id, b: p.b, cap: capField, dealPrice, pr: p.pr,
      asin: p.deals?.amazon?.url?.match(/dp\/([A-Z0-9]{10})/)?.[1] ?? p.asin ?? null,
      n: p.n.slice(0, 60), flags });
  }
}

// Severity buckets.
const tier1 = rows.filter(r => r.flags.some(f => f.startsWith('LOW_$/TB') || f.startsWith('HIGH_$/TB')));
const t1ids = new Set(tier1.map(r => r.id));
const tier2 = rows.filter(r => !t1ids.has(r.id) && r.flags.some(f => f.startsWith('NAME/CAP')));
const t2ids = new Set(tier2.map(r => r.id));
const tier3 = rows.filter(r => !t1ids.has(r.id) && !t2ids.has(r.id)); // deal>pr / deal<<pr but $/TB plausible

function dump(title, list) {
  console.log(`\n===== ${title} (${list.length}) =====`);
  list.sort((a,b) => (a.dealPrice ?? a.pr) - (b.dealPrice ?? b.pr));
  for (const r of list) {
    console.log(`id=${r.id} [${r.b}] cap=${r.cap}GB deal=$${r.dealPrice} pr=$${r.pr} asin=${r.asin}`);
    console.log(`   "${r.n}"`);
    r.flags.forEach(f => console.log(`   ⚠ ${f}`));
  }
}

console.log(`Storage products: ${storage.length}   Flagged: ${rows.length}`);
dump('TIER 1 — capacity/price physically impossible (wrong drive attached)', tier1);
dump('TIER 2 — cap field vs name disagree >10% (metadata error)', tier2);
console.log(`\n===== TIER 3 — deal price vs list anomaly, $/TB plausible (stale/suspect pricing) (${tier3.length}) =====`);
tier3.sort((a,b)=>(a.dealPrice??a.pr)-(b.dealPrice??b.pr));
tier3.forEach(r => console.log(`id=${r.id} [${r.b}] deal=$${r.dealPrice} pr=$${r.pr} | ${r.flags[0]} | ${r.n.slice(0,42)}`));
