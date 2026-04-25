// score-accessory-bench-v2.cjs
// Recalibrated: budget products land in 20-40 range, flagships in 80-100
// This makes value (bench/price) ratios fall into S/A/B/C/D bands properly

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

// Premium audiophile/pro brands - signal high quality
const PREMIUM_BRANDS = new Set([
  'Audio-Technica','Sennheiser','Beyerdynamic','Sony','Shure','Rode','RØDE',
  'Bose','Apple','Drop','Artisan','Wooting','Endgame Gear','Pulsar',
  'Keychron','Akko','Cherry','Ducky','Blue','Blue Microphones','Elgato'
]);

// Mainstream tier-1 brands
const TIER1_BRANDS = new Set([
  'Logitech','Razer','SteelSeries','Corsair','HyperX','ASUS','ROG',
  'Astro','Astro Gaming','Turtle Beach','Glorious','Microsoft',
  'JBL','Insta360','OBSBOT','BenQ','Logi'
]);

// Budget/no-name brands
const BUDGET_BRANDS = new Set([
  'Misc','Budget','Generic','TECKNET','REDRAGON','Redragon','AULA','FIFINE',
  'MAONO','Aothia','QIYI','Lenovo','Acer','acer','Dell','HP','Anker',
  'Hollyland','Samson'
]);

function brandTier(p) {
  if (PREMIUM_BRANDS.has(p.b)) return 'premium';
  if (TIER1_BRANDS.has(p.b)) return 'tier1';
  if (BUDGET_BRANDS.has(p.b)) return 'budget';
  return 'unknown';
}

function brandBonus(p) {
  const t = brandTier(p);
  if (t === 'premium') return 12;
  if (t === 'tier1') return 8;
  if (t === 'budget') return -10;
  return -5; // unknown
}

// =========================================================================
// MOUSE
// =========================================================================
function scoreMouse(p) {
  let score = 35; // base for any mouse

  // DPI (-10 to +20)
  const dpi = p.dpi || 0;
  if (dpi >= 30000) score += 20;
  else if (dpi >= 25000) score += 16;
  else if (dpi >= 16000) score += 10;
  else if (dpi >= 12000) score += 5;
  else if (dpi >= 8000) score += 0;
  else if (dpi >= 4000) score -= 5;
  else if (dpi > 0) score -= 10;

  // Sensor quality (-10 to +20)
  const sensor = (p.sensor || '').toLowerCase();
  if (/hero 2|focus pro 35k|focus x|focus 45k/i.test(sensor)) score += 20;
  else if (/hero|focus pro|focus|hyperspeed|truemove pro/i.test(sensor)) score += 12;
  else if (/bamf|truemove|pixart 33[6-8]9/i.test(sensor)) score += 8;
  else if (/optical/.test(sensor)) score -= 2;
  else if (/laser/.test(sensor)) score -= 8;

  // Weight (-10 to +15) - lighter is better for gaming
  const wt = p.weight || 0;
  if (wt > 0) {
    if (wt < 60) score += 15;
    else if (wt < 70) score += 12;
    else if (wt < 85) score += 6;
    else if (wt < 100) score += 0;
    else if (wt < 120) score -= 5;
    else score -= 10;
  }

  // Wireless (+10)
  if (p.mouseType === 'Wireless') score += 10;

  // Brand (-10 to +12)
  score += brandBonus(p);

  // Rating modifier (-5 to +8)
  if (p.r) score += Math.round((p.r - 4.0) * 8);

  return Math.max(15, Math.min(100, Math.round(score)));
}

// =========================================================================
// KEYBOARD
// =========================================================================
function scoreKeyboard(p) {
  let score = 35;

  // Switches (-15 to +25)
  const sw = (p.switches || '').toLowerCase();
  if (/hall effect|magnetic/i.test(sw)) score += 25;
  else if (/optical/i.test(sw)) score += 18;
  else if (/cherry|gateron|kailh/i.test(sw)) score += 18;
  else if (/(red|blue|brown|black|silver|yellow|speed|silent|clear)\b/i.test(sw)) score += 15; // mechanical with switch type
  else if (/mechanical/i.test(sw)) score += 10;
  else if (/scissor/i.test(sw)) score -= 5;
  else if (/membrane|mech-?dome/i.test(sw)) score -= 15;

  // Wireless (+10)
  if (p.wireless === true) score += 10;

  // RGB (+5)
  if (p.rgb === true) score += 5;

  // Hot-swap bonus (+8)
  if (/hot[-\s]?swap/i.test(p.n || '')) score += 8;

  // Layout - small bonus for popular gaming layouts
  if (['TKL','60%','65%','75%'].includes(p.layout)) score += 3;

  // Brand
  score += brandBonus(p);

  // Rating
  if (p.r) score += Math.round((p.r - 4.0) * 8);

  return Math.max(15, Math.min(100, Math.round(score)));
}

// =========================================================================
// HEADSET
// =========================================================================
function scoreHeadset(p) {
  let score = 30;

  // Driver size (-10 to +15)
  const dr = p.driver || 0;
  if (dr >= 53) score += 15;
  else if (dr >= 50) score += 12;
  else if (dr >= 45) score += 8;
  else if (dr >= 40) score += 4;
  else if (dr > 20) score -= 2;
  else if (dr > 0) score -= 10; // earbuds

  // Mic (+8 if has)
  if (p.mic === true) score += 8;

  // ANC (+15 - premium feature)
  if (p.anc === true) score += 15;

  // Wireless (+10)
  if (p.hsType === 'Wireless') score += 10;

  // Brand bonus - amplified for headphones (audio quality matters)
  const t = brandTier(p);
  if (t === 'premium') score += 18;
  else if (t === 'tier1') score += 10;
  else if (t === 'budget') score -= 12;
  else score -= 5;

  // Rating
  if (p.r) score += Math.round((p.r - 4.0) * 10);

  return Math.max(15, Math.min(100, Math.round(score)));
}

// =========================================================================
// MICROPHONE
// =========================================================================
function scoreMicrophone(p) {
  let score = 35;

  // Sample rate (+5 to +20) or XLR pro pass
  const sr = p.sampleRate;
  if (sr === 0) score += 15; // XLR analog (typically pro mics, brand will modify)
  else if (sr >= 192) score += 20;
  else if (sr >= 96) score += 14;
  else if (sr >= 48) score += 6;
  else if (sr >= 44) score += 4;

  // Pattern (+5 to +18)
  const pat = (p.pattern || '').toLowerCase();
  if (/multi/.test(pat)) score += 18;
  else if (/super/.test(pat)) score += 14;
  else if (/cardioid/.test(pat)) score += 10;
  else if (/dynamic/.test(pat)) score += 8;
  else if (/condenser/.test(pat)) score += 8;
  else if (/omnidirectional/.test(pat)) score += 5;

  // micType
  if (p.micType === 'XLR') score += 12; // pro standard
  else if (p.micType === 'Wireless') score += 10;
  else if (p.micType === 'USB') score += 6;

  // Brand - very important for mics
  const t = brandTier(p);
  if (t === 'premium') score += 18;
  else if (t === 'tier1') score += 10;
  else if (t === 'budget') score -= 8;
  else score -= 3;

  // Rating
  if (p.r) score += Math.round((p.r - 4.0) * 10);

  return Math.max(15, Math.min(100, Math.round(score)));
}

// =========================================================================
// WEBCAM
// =========================================================================
function scoreWebcam(p) {
  let score = 30;

  // Resolution (+5 to +30)
  const res = p.resolution;
  if (res === '4K') score += 30;
  else if (res === '1440p') score += 18;
  else if (res === '1080p') score += 8;
  else if (res === '720p') score -= 8;

  // FPS (-5 to +15)
  const fps = p.fps || 0;
  if (fps >= 100) score += 15;
  else if (fps >= 60) score += 12;
  else if (fps >= 30) score += 5;
  else if (fps > 0) score -= 5;

  // Autofocus (+10)
  if (p.autofocus === true) score += 10;
  else if (p.autofocus === false) score -= 5;

  // Brand
  score += brandBonus(p);

  // Rating
  if (p.r) score += Math.round((p.r - 4.0) * 8);

  return Math.max(15, Math.min(100, Math.round(score)));
}

// =========================================================================
// MOUSEPAD
// =========================================================================
function scoreMousePad(p) {
  let score = 35;

  // Surface (-5 to +12)
  if (p.surface === 'Hard') score += 10;
  else if (p.surface === 'Hybrid') score += 12;
  else if (p.surface === 'Cloth') score += 8;
  else if (p.surface === 'Rubber') score -= 5;

  // Size (-5 to +15)
  const sz = p.padSize;
  if (sz === 'XXL') score += 15;
  else if (sz === 'XL') score += 12;
  else if (sz === 'Large') score += 8;
  else if (sz === 'Medium') score += 2;
  else if (sz === 'Small') score -= 5;

  // RGB bonus (+5)
  if (/rgb|chroma|firefly/i.test(p.n || '')) score += 5;

  // Brand - matters for surface quality
  const t = brandTier(p);
  if (t === 'premium') score += 18;
  else if (t === 'tier1') score += 10;
  else if (t === 'budget') score -= 8;
  else score -= 5;

  // Rating
  if (p.r) score += Math.round((p.r - 4.0) * 10);

  return Math.max(15, Math.min(100, Math.round(score)));
}

const SCORERS = {
  Mouse: scoreMouse,
  Keyboard: scoreKeyboard,
  Headset: scoreHeadset,
  Microphone: scoreMicrophone,
  Webcam: scoreWebcam,
  MousePad: scoreMousePad,
};

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

  const stats = {};
  for (const cat of Object.keys(SCORERS)) {
    stats[cat] = { n: 0, sum: 0, min: 100, max: 0, distribution: {} };
  }

  for (const p of parts) {
    const scorer = SCORERS[p.c];
    if (!scorer) continue;
    const bench = scorer(p);
    const r = setBench(s, p.id, bench);
    if (r.set) {
      s = r.s;
      const st = stats[p.c];
      st.n++;
      st.sum += bench;
      if (bench < st.min) st.min = bench;
      if (bench > st.max) st.max = bench;
      // Bucket distribution
      const bucket = Math.floor(bench / 10) * 10;
      st.distribution[bucket] = (st.distribution[bucket] || 0) + 1;
    }
  }

  fs.writeFileSync(PARTS_PATH, s);

  console.log('═══ V2 BENCH SCORES ═══');
  for (const cat of Object.keys(SCORERS)) {
    const st = stats[cat];
    if (st.n === 0) continue;
    const avg = (st.sum / st.n).toFixed(1);
    console.log(
      cat.padEnd(12) +
      'n=' + st.n +
      ' avg=' + avg +
      ' min=' + st.min +
      ' max=' + st.max
    );
    // Show distribution
    const buckets = Object.keys(st.distribution).map(k => parseInt(k)).sort((a,b) => a - b);
    const distStr = buckets.map(b => b + '-' + (b+9) + ':' + st.distribution[b]).join(' | ');
    console.log('             ' + distStr);
  }
})();
