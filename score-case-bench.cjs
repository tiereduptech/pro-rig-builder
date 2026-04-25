// score-case-bench.cjs

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

const PREMIUM_BRANDS = new Set(['Lian Li','Phanteks','Fractal Design','HYTE','Corsair','NZXT','be quiet!','SilverStone','Streacom']);
const TIER1_BRANDS = new Set(['Cooler Master','ASUS','MSI','Gigabyte','Antec','Thermaltake','Montech','InWin','EVGA']);
const BUDGET_BRANDS = new Set(['Misc','Budget','Generic','DeepCool','GAMDIAS','Apevia','Zalman','Sama','Aerocool']);

function brandBonus(p) {
  if (PREMIUM_BRANDS.has(p.b)) return 12;
  if (TIER1_BRANDS.has(p.b)) return 6;
  if (BUDGET_BRANDS.has(p.b)) return -8;
  return -2;
}

function scoreCase(p) {
  let score = 30;

  // Mobo support breadth (-5 to +12)
  const mobo = (Array.isArray(p.mobo) ? p.mobo.join(',') : (p.mobo || '')).toLowerCase();
  if (/eatx|e-atx/.test(mobo)) score += 12;
  else if (/atx/.test(mobo) && !/m.?atx/.test(mobo)) score += 8;
  else if (/m.?atx|microatx/.test(mobo)) score += 4;
  else if (/itx/.test(mobo)) score -= 2;

  // GPU clearance (-5 to +15)
  const gpu = p.maxGPU || 0;
  if (gpu >= 450) score += 15;
  else if (gpu >= 400) score += 12;
  else if (gpu >= 360) score += 8;
  else if (gpu >= 320) score += 4;
  else if (gpu >= 280) score += 0;
  else if (gpu > 0) score -= 5;

  // CPU cooler height (-5 to +10)
  const cooler = p.maxCooler || 0;
  if (cooler >= 180) score += 10;
  else if (cooler >= 165) score += 7;
  else if (cooler >= 150) score += 4;
  else if (cooler >= 100) score += 0;
  else if (cooler > 0) score -= 5;

  // Radiator support (+0 to +10)
  const rads = (p.rads || '').toString();
  if (/420/.test(rads)) score += 10;
  else if (/360/.test(rads)) score += 8;
  else if (/280/.test(rads)) score += 5;
  else if (/240/.test(rads)) score += 2;
  else if (/120/.test(rads)) score += 0;

  // Tempered glass (+3)
  if (p.tg === true) score += 3;

  // USB-C (+3)
  if (p.usb_c === true) score += 3;

  // RGB (+2 - some users hate it but generally premium feature)
  if (p.rgb === true) score += 2;

  // Fans included (+0 to +6)
  const fans = p.fans_inc || 0;
  if (fans >= 4) score += 6;
  else if (fans >= 3) score += 4;
  else if (fans >= 2) score += 2;
  else if (fans === 1) score += 0;
  else if (fans === 0) score -= 2;

  // Drive bays (storage flexibility)
  const d25 = p.drive25 || 0;
  const d35 = p.drive35 || 0;
  const totalBays = d25 + d35;
  if (totalBays >= 8) score += 5;
  else if (totalBays >= 5) score += 3;
  else if (totalBays >= 3) score += 1;

  // Brand
  score += brandBonus(p);

  // Rating
  if (p.r) score += Math.round((p.r - 4.0) * 8);

  return Math.max(15, Math.min(100, Math.round(score)));
}

function setBench(s, id, bench) {
  const idMarker = '"id": ' + id + ',';
  const idIdx = s.indexOf(idMarker);
  if (idIdx < 0) return { s, set: false };
  let pos = idIdx;
  while (pos > 0 && s[pos] !== '{') pos--;
  const startBrace = pos;
  let depth = 1;
  pos = startBrace + 1;
  while (pos < s.length && depth > 0) {
    if (s[pos] === '{') depth++;
    else if (s[pos] === '}') depth--;
    if (depth === 0) break;
    pos++;
  }
  const endBrace = pos;
  let entryText = s.substring(startBrace, endBrace + 1);
  const benchRegex = /"bench":\s*\d+/;
  if (benchRegex.test(entryText)) {
    entryText = entryText.replace(benchRegex, '"bench": ' + bench);
  } else {
    const matchClosing = entryText.match(/^([\s\S]*?)(\n\s*\}\s*)$/);
    if (!matchClosing) return { s, set: false };
    const before = matchClosing[1];
    const closing = matchClosing[2];
    entryText = before.replace(/,?\s*$/, '') + ',\n    "bench": ' + bench + closing;
  }
  return { s: s.substring(0, startBrace) + entryText + s.substring(endBrace + 1), set: true };
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  let s = fs.readFileSync(PARTS_PATH, 'utf8');

  let stats = { n: 0, sum: 0, min: 100, max: 0, distribution: {} };
  for (const p of parts) {
    if (p.c !== 'Case') continue;
    const bench = scoreCase(p);
    const r = setBench(s, p.id, bench);
    if (r.set) {
      s = r.s;
      stats.n++;
      stats.sum += bench;
      if (bench < stats.min) stats.min = bench;
      if (bench > stats.max) stats.max = bench;
      const bucket = Math.floor(bench / 10) * 10;
      stats.distribution[bucket] = (stats.distribution[bucket] || 0) + 1;
    }
  }

  fs.writeFileSync(PARTS_PATH, s);
  console.log('Cases scored: ' + stats.n + ' avg=' + (stats.sum / stats.n).toFixed(1) + ' min=' + stats.min + ' max=' + stats.max);
  Object.keys(stats.distribution).map(Number).sort((a, b) => a - b).forEach(b => {
    console.log('  ' + b + '-' + (b + 9) + ': ' + stats.distribution[b]);
  });
})();
