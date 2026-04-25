// score-cooler-fan-bench.cjs

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

const PREMIUM_BRANDS = new Set(['Noctua','be quiet!','Phanteks','Arctic','Lian Li','Corsair','NZXT','Fractal Design','EKWB','Asetek']);
const TIER1_BRANDS = new Set(['Cooler Master','Thermalright','DeepCool','Scythe','Cryorig','Zalman','MSI','Gigabyte','ASUS','Antec']);
const BUDGET_BRANDS = new Set(['Misc','Budget','Generic','ID-COOLING','Silverstone','Vetroo','Thermaltake']);

function brandBonus(p) {
  if (PREMIUM_BRANDS.has(p.b)) return 12;
  if (TIER1_BRANDS.has(p.b)) return 6;
  if (BUDGET_BRANDS.has(p.b)) return -8;
  return -3;
}

function scoreCPUCooler(p) {
  let score = 30;

  // Cooler type (-15 to +25)
  const ct = (p.coolerType || '').toLowerCase();
  if (/aio|liquid|water/.test(ct) || /\bAIO\b/i.test(p.n || '')) {
    // AIO sizing
    const radSize = parseInt((p.radSize || '').toString()) ||
      ((p.n || '').match(/(\d{3})mm/)?.[1] ? parseInt(p.n.match(/(\d{3})mm/)[1]) : 0);
    if (radSize >= 420) score += 28;
    else if (radSize >= 360) score += 25;
    else if (radSize >= 280) score += 18;
    else if (radSize >= 240) score += 12;
    else if (radSize >= 120) score += 5;
    else score += 8;
  } else if (/dual[- ]?tower|tower/.test(ct) || /D15|D14|U12A|NH-D|Peerless/i.test(p.n || '')) {
    score += 18; // big air coolers
  } else if (/air|tower/.test(ct)) {
    score += 8;
  } else if (/low[- ]?profile|slim/.test(ct)) {
    score -= 5;
  }

  // TDP rating (-10 to +20)
  const tdp = p.tdp_rating || 0;
  if (tdp >= 350) score += 20;
  else if (tdp >= 280) score += 16;
  else if (tdp >= 220) score += 12;
  else if (tdp >= 180) score += 8;
  else if (tdp >= 140) score += 4;
  else if (tdp >= 100) score += 0;
  else if (tdp > 0) score -= 8;

  // Noise (-15 to +12)
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

function scoreCaseFan(p) {
  let score = 30;

  // Size (-5 to +10)
  const sz = p.size || 0;
  if (sz >= 200) score += 12;
  else if (sz >= 140) score += 8;
  else if (sz === 120) score += 4;
  else if (sz >= 92) score -= 2;
  else if (sz > 0) score -= 5;

  // CFM (airflow) (-5 to +20)
  const cfm = parseFloat(p.cfm) || 0;
  if (cfm >= 100) score += 20;
  else if (cfm >= 80) score += 15;
  else if (cfm >= 60) score += 10;
  else if (cfm >= 40) score += 5;
  else if (cfm > 0) score -= 5;

  // Noise (-10 to +12)
  const noise = parseFloat(p.noise) || 0;
  if (noise > 0) {
    if (noise <= 18) score += 12;
    else if (noise <= 22) score += 8;
    else if (noise <= 26) score += 4;
    else if (noise <= 30) score -= 0;
    else if (noise <= 35) score -= 5;
    else score -= 10;
  }

  // PWM (+5)
  if (p.pwm === true) score += 5;

  // RPM range bonus (high max = more performance flexibility)
  const rpm = parseInt(p.rpm) || 0;
  if (rpm >= 2500) score += 8;
  else if (rpm >= 2000) score += 5;
  else if (rpm >= 1500) score += 3;

  // RGB (+3)
  if (p.rgb === true) score += 3;

  // Pack value (+0 to +6) - 3-pack/6-pack offers more
  const pack = p.pack || 1;
  if (pack >= 6) score += 6;
  else if (pack >= 3) score += 4;
  else if (pack === 2) score += 2;

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

  const SCORERS = { CPUCooler: scoreCPUCooler, CaseFan: scoreCaseFan };
  const stats = {};
  for (const c of Object.keys(SCORERS)) stats[c] = { n: 0, sum: 0, min: 100, max: 0, distribution: {} };

  for (const p of parts) {
    if (!SCORERS[p.c]) continue;
    const bench = SCORERS[p.c](p);
    const r = setBench(s, p.id, bench);
    if (r.set) {
      s = r.s;
      const st = stats[p.c];
      st.n++;
      st.sum += bench;
      if (bench < st.min) st.min = bench;
      if (bench > st.max) st.max = bench;
      const bucket = Math.floor(bench / 10) * 10;
      st.distribution[bucket] = (st.distribution[bucket] || 0) + 1;
    }
  }

  fs.writeFileSync(PARTS_PATH, s);
  for (const c of Object.keys(SCORERS)) {
    const st = stats[c];
    console.log('\n' + c + ' n=' + st.n + ' avg=' + (st.sum / st.n).toFixed(1) + ' min=' + st.min + ' max=' + st.max);
    const buckets = Object.keys(st.distribution).map(Number).sort((a, b) => a - b);
    buckets.forEach(b => console.log('  ' + b + '-' + (b + 9) + ': ' + st.distribution[b]));
  }
})();
