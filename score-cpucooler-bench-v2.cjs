// score-cpucooler-bench-v2.cjs
// Recalibrated CPU cooler scoring with CFM as core performance metric

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

const PREMIUM_BRANDS = new Set(['Noctua','be quiet!','Phanteks','Arctic','Lian Li','EKWB','Asetek']);
const TIER1_BRANDS = new Set(['Corsair','NZXT','Cooler Master','Thermalright','DeepCool','Scythe','Cryorig','Zalman','MSI','Gigabyte','ASUS','Antec','Fractal Design']);
const BUDGET_BRANDS = new Set(['Misc','Budget','Generic','ID-COOLING','Silverstone','Vetroo','Thermaltake']);

function brandBonus(p) {
  if (PREMIUM_BRANDS.has(p.b)) return 12;
  if (TIER1_BRANDS.has(p.b)) return 6;
  if (BUDGET_BRANDS.has(p.b)) return -8;
  return -3;
}

function scoreCPUCooler(p) {
  let score = 25; // base lower; specs determine ranking

  const text = p.n + ' ' + (p.b || '');
  const ct = (p.coolerType || '').toLowerCase();
  const isAIO = /aio|liquid|water/.test(ct);
  const radSize = parseInt(p.radSize) || 0;

  // Cooler type baseline (-15 to +15)
  if (isAIO || radSize > 0) {
    if (radSize >= 420) score += 18;
    else if (radSize >= 360) score += 15;
    else if (radSize >= 280) score += 10;
    else if (radSize >= 240) score += 5;
    else if (radSize >= 140) score += 0;
    else if (radSize >= 120) score -= 3;
  } else if (/dual[- ]?tower/i.test(ct) || /D15|D14|peerless|phantom|FUMA|AK620|assassin iv/i.test(text)) {
    score += 12; // dual-tower air
  } else if (/air|tower/.test(ct)) {
    score += 0; // single-tower air
  } else if (/low.profile|slim/.test(ct)) {
    score -= 10;
  }

  // CFM (-10 to +25) - now the primary performance metric
  const cfm = parseFloat(p.cfm) || 0;
  if (cfm > 0) {
    if (cfm >= 200) score += 25;
    else if (cfm >= 160) score += 20;
    else if (cfm >= 120) score += 15;
    else if (cfm >= 90) score += 10;
    else if (cfm >= 70) score += 5;
    else if (cfm >= 50) score += 0;
    else if (cfm >= 35) score -= 5;
    else score -= 10;
  }

  // TDP rating (-10 to +15)
  const tdp = p.tdp_rating || 0;
  if (tdp >= 350) score += 15;
  else if (tdp >= 280) score += 12;
  else if (tdp >= 220) score += 9;
  else if (tdp >= 180) score += 6;
  else if (tdp >= 140) score += 2;
  else if (tdp >= 100) score += 0;
  else if (tdp > 0) score -= 8;

  // Noise (-15 to +12) - quieter is better
  const noise = parseFloat(p.noise) || 0;
  if (noise > 0) {
    if (noise <= 18) score += 12;
    else if (noise <= 22) score += 8;
    else if (noise <= 26) score += 4;
    else if (noise <= 30) score += 0;
    else if (noise <= 35) score -= 5;
    else score -= 12;
  }

  // Fans included (+0 to +6)
  const fc = p.fans_inc || 0;
  if (fc >= 3) score += 6;
  else if (fc === 2) score += 4;
  else if (fc === 1) score += 2;

  // RGB (+3)
  if (p.rgb === true) score += 3;

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
    if (p.c !== 'CPUCooler') continue;
    const bench = scoreCPUCooler(p);
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
  console.log('CPUCooler v2 scoring (n=' + stats.n + ') avg=' + (stats.sum / stats.n).toFixed(1) + ' min=' + stats.min + ' max=' + stats.max);
  const buckets = Object.keys(stats.distribution).map(Number).sort((a, b) => a - b);
  buckets.forEach(b => console.log('  ' + b + '-' + (b + 9) + ': ' + stats.distribution[b]));
})();
