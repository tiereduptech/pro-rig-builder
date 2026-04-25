// score-accessory-bench.cjs
// Computes 0-100 bench score for each accessory product based on spec quality
// Saves bench field directly to parts.js

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

const TIER1_BRANDS = new Set([
  'Logitech','Razer','SteelSeries','Corsair','HyperX','ASUS','ROG',
  'Audio-Technica','Sennheiser','Beyerdynamic','Sony','Shure','Rode','RØDE',
  'Elgato','Insta360','OBSBOT','Glorious','Keychron','Wooting','Pulsar',
  'Endgame Gear','Apple','Microsoft','Lenovo','Dell','HP','Anker','JBL',
  'Bose','Astro','Astro Gaming','Turtle Beach','Blue','Blue Microphones',
  'FIFINE','MAONO','BenQ','Drop','Artisan','Akko','Cherry','Ducky'
]);

function scoreMouse(p) {
  let score = 0;

  // DPI (25 pts max)
  const dpi = p.dpi || 0;
  if (dpi >= 30000) score += 25;
  else if (dpi >= 25000) score += 22;
  else if (dpi >= 16000) score += 18;
  else if (dpi >= 12000) score += 15;
  else if (dpi >= 8000) score += 12;
  else if (dpi >= 4000) score += 8;
  else if (dpi > 0) score += 4;

  // Sensor (25 pts max)
  const sensor = (p.sensor || '').toLowerCase();
  if (/hero 2|focus pro 35k/i.test(sensor)) score += 25;
  else if (/hero|focus pro|focus|hyperspeed/i.test(sensor)) score += 20;
  else if (/bamf|truemove|pixart 3360|3370|3389/i.test(sensor)) score += 18;
  else if (/optical/.test(sensor)) score += 10;
  else if (/laser/.test(sensor)) score += 8;
  else if (sensor) score += 12;

  // Weight (20 pts max - lighter is better for gaming)
  const wt = p.weight || 0;
  if (wt > 0) {
    if (wt < 60) score += 20;
    else if (wt < 80) score += 18;
    else if (wt < 100) score += 14;
    else if (wt < 120) score += 8;
    else score += 4;
  }

  // Wireless (15 pts)
  if (p.mouseType === 'Wireless') score += 15;

  // Rating (15 pts)
  if (p.r) score += Math.min(15, p.r * 3);

  return Math.min(100, Math.round(score));
}

function scoreKeyboard(p) {
  let score = 0;

  // Switches (30 pts max)
  const sw = (p.switches || '').toLowerCase();
  if (/hall effect|magnetic/i.test(sw)) score += 30;
  else if (/optical/i.test(sw)) score += 25;
  else if (/red|blue|brown|black|silver|yellow|speed|silent|clear/i.test(sw)) score += 25; // mechanical
  else if (/mechanical/i.test(sw)) score += 22;
  else if (/scissor/i.test(sw)) score += 15;
  else if (/membrane/i.test(sw)) score += 8;

  // Wireless (20 pts)
  if (p.wireless === true) score += 20;

  // RGB (15 pts)
  if (p.rgb === true) score += 15;

  // Hot-swap bonus (5 pts) - inferred from name
  if (/hot[-\s]?swap/i.test(p.n || '')) score += 5;

  // Layout - small bonus for popular gaming layouts
  if (['TKL','60%','65%','75%'].includes(p.layout)) score += 5;

  // Rating (15 pts)
  if (p.r) score += Math.min(15, p.r * 3);

  // Tier-1 brand bonus
  if (TIER1_BRANDS.has(p.b)) score += 10;

  return Math.min(100, Math.round(score));
}

function scoreHeadset(p) {
  let score = 0;

  // Driver size (25 pts max)
  const dr = p.driver || 0;
  if (dr >= 53) score += 25;
  else if (dr >= 50) score += 22;
  else if (dr >= 45) score += 18;
  else if (dr >= 40) score += 15;
  else if (dr > 0) score += 10;

  // Mic (15 pts)
  if (p.mic === true) score += 15;
  // Audiophile headphones without mic still good - small consolation
  else if (p.mic === false) score += 5;

  // ANC (25 pts) - premium feature
  if (p.anc === true) score += 25;

  // Wireless (15 pts)
  if (p.hsType === 'Wireless') score += 15;

  // Rating (15 pts)
  if (p.r) score += Math.min(15, p.r * 3);

  // Tier-1 brand
  if (TIER1_BRANDS.has(p.b)) score += 10;

  return Math.min(100, Math.round(score));
}

function scoreMicrophone(p) {
  let score = 0;

  // Sample rate (25 pts) - or analog XLR pros
  const sr = p.sampleRate;
  if (sr === 0) score += 22; // XLR analog (typically pro mics)
  else if (sr >= 192) score += 25;
  else if (sr >= 96) score += 20;
  else if (sr >= 48) score += 15;
  else if (sr >= 44) score += 13;

  // Pattern (25 pts)
  const pat = (p.pattern || '').toLowerCase();
  if (/multi/.test(pat)) score += 25;
  else if (/cardioid/.test(pat) && /super/.test(pat)) score += 22;
  else if (/cardioid/.test(pat)) score += 20;
  else if (/dynamic/.test(pat)) score += 15;
  else if (/condenser/.test(pat)) score += 18;
  else if (/omnidirectional/.test(pat)) score += 12;

  // micType (15 pts)
  if (p.micType === 'XLR') score += 20; // pro standard
  else if (p.micType === 'USB') score += 15;
  else if (p.micType === 'Wireless') score += 18;

  // Rating (25 pts)
  if (p.r) score += Math.min(25, p.r * 5);

  // Tier-1 brand
  if (TIER1_BRANDS.has(p.b)) score += 5;

  return Math.min(100, Math.round(score));
}

function scoreWebcam(p) {
  let score = 0;

  // Resolution (40 pts) - most important spec
  const res = p.resolution;
  if (res === '4K') score += 40;
  else if (res === '1440p') score += 25;
  else if (res === '1080p') score += 15;
  else if (res === '720p') score += 5;

  // FPS (25 pts)
  const fps = p.fps || 0;
  if (fps >= 100) score += 25;
  else if (fps >= 60) score += 22;
  else if (fps >= 30) score += 15;
  else if (fps > 0) score += 5;

  // Autofocus (20 pts)
  if (p.autofocus === true) score += 20;

  // Rating (15 pts)
  if (p.r) score += Math.min(15, p.r * 3);

  // Tier-1 brand bonus
  if (TIER1_BRANDS.has(p.b)) score += 5;

  return Math.min(100, Math.round(score));
}

function scoreMousePad(p) {
  let score = 0;

  // Surface (25 pts)
  if (p.surface === 'Hard') score += 25;
  else if (p.surface === 'Hybrid') score += 22;
  else if (p.surface === 'Cloth') score += 20;
  else if (p.surface === 'Rubber') score += 15;

  // Size (30 pts)
  const sz = p.padSize;
  if (sz === 'XXL') score += 30;
  else if (sz === 'XL') score += 25;
  else if (sz === 'Large') score += 20;
  else if (sz === 'Medium') score += 12;
  else if (sz === 'Small') score += 6;

  // Tier-1 brand (20 pts)
  if (TIER1_BRANDS.has(p.b)) score += 20;
  else score += 10;

  // Rating (25 pts)
  if (p.r) score += Math.min(25, p.r * 5);

  return Math.min(100, Math.round(score));
}

const SCORERS = {
  Mouse: scoreMouse,
  Keyboard: scoreKeyboard,
  Headset: scoreHeadset,
  Microphone: scoreMicrophone,
  Webcam: scoreWebcam,
  MousePad: scoreMousePad,
};

function addBenchField(s, id, bench) {
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

  // Replace if exists, else add
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

  let total = { applied: 0, byCat: {}, scoreSum: {}, scoreMin: {}, scoreMax: {} };

  for (const cat of Object.keys(SCORERS)) {
    total.byCat[cat] = 0;
    total.scoreSum[cat] = 0;
    total.scoreMin[cat] = 100;
    total.scoreMax[cat] = 0;
  }

  for (const p of parts) {
    const scorer = SCORERS[p.c];
    if (!scorer) continue;

    const bench = scorer(p);
    const r = addBenchField(s, p.id, bench);
    if (r.set) {
      s = r.s;
      total.applied++;
      total.byCat[p.c]++;
      total.scoreSum[p.c] += bench;
      if (bench < total.scoreMin[p.c]) total.scoreMin[p.c] = bench;
      if (bench > total.scoreMax[p.c]) total.scoreMax[p.c] = bench;
    }
  }

  fs.writeFileSync(PARTS_PATH, s);

  console.log('═══ BENCH SCORES ═══');
  console.log('Total products scored: ' + total.applied);
  for (const cat of Object.keys(SCORERS)) {
    const n = total.byCat[cat];
    if (n === 0) continue;
    const avg = (total.scoreSum[cat] / n).toFixed(1);
    console.log(
      cat.padEnd(12) +
      ' n=' + n +
      ' avg=' + avg +
      ' min=' + total.scoreMin[cat] +
      ' max=' + total.scoreMax[cat]
    );
  }
})();
