// enrich-case-specs.cjs
// Populates case specs: mobo support, maxGPU, maxCooler, fans_inc, color, etc.

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

// Known case specs from product knowledge
// Format: { mobo, maxGPU (mm), maxCooler (mm), fans_inc, drive25, drive35, rads }
const KNOWN_SPECS = [
  // Lian Li
  { pattern: /lian li o11 dynamic evo xl/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 446, maxCooler: 167, fans_inc: 0, drive25: 6, drive35: 4, rads: '420,360,280,240' } },
  { pattern: /lian li o11 dynamic evo/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 422, maxCooler: 167, fans_inc: 0, drive25: 4, drive35: 2, rads: '360,280,240' } },
  { pattern: /lian li o11 dynamic mini/i, specs: { mobo: 'ATX,mATX,ITX', maxGPU: 395, maxCooler: 170, fans_inc: 0, drive25: 4, drive35: 2, rads: '280,240' } },
  { pattern: /lian li o11 dynamic xl/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 446, maxCooler: 167, fans_inc: 0, drive25: 6, drive35: 4, rads: '420,360,280' } },
  { pattern: /lian li o11 dynamic/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 420, maxCooler: 155, fans_inc: 0, drive25: 6, drive35: 2, rads: '360,280,240' } },
  { pattern: /lian li lancool 216/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 392, maxCooler: 180, fans_inc: 3, drive25: 4, drive35: 2, rads: '360,280,240' } },
  { pattern: /lian li lancool 215/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 384, maxCooler: 176, fans_inc: 2, drive25: 4, drive35: 2, rads: '360,280,240' } },
  { pattern: /lian li lancool 207/i, specs: { mobo: 'ATX,mATX,ITX', maxGPU: 392, maxCooler: 175, fans_inc: 3, drive25: 4, drive35: 2, rads: '360,280,240' } },
  { pattern: /lian li lancool iii/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 422, maxCooler: 187, fans_inc: 4, drive25: 4, drive35: 2, rads: '420,360,280' } },
  { pattern: /lian li lancool ii/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 384, maxCooler: 176, fans_inc: 2, drive25: 4, drive35: 2, rads: '360,280,240' } },
  { pattern: /lian li a3 m/i, specs: { mobo: 'mATX,ITX', maxGPU: 365, maxCooler: 158, fans_inc: 1, drive25: 1, drive35: 0, rads: '360,280,240' } },
  { pattern: /lian li dan a4/i, specs: { mobo: 'ITX', maxGPU: 322, maxCooler: 70, fans_inc: 0, drive25: 1, drive35: 0, rads: '120' } },
  { pattern: /lian li o11d mini|o11 mini/i, specs: { mobo: 'ATX,mATX,ITX', maxGPU: 395, maxCooler: 170, fans_inc: 0, drive25: 4, drive35: 2, rads: '280,240' } },

  // Corsair
  { pattern: /corsair (?:icue )?5000t rgb/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 400, maxCooler: 170, fans_inc: 3, drive25: 6, drive35: 2, rads: '360,280,240' } },
  { pattern: /corsair (?:icue )?5000d/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 420, maxCooler: 170, fans_inc: 2, drive25: 4, drive35: 2, rads: '360,280,240' } },
  { pattern: /corsair (?:icue )?6500x/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 400, maxCooler: 170, fans_inc: 0, drive25: 6, drive35: 2, rads: '360,280,240' } },
  { pattern: /corsair 4000d airflow/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 360, maxCooler: 170, fans_inc: 2, drive25: 2, drive35: 2, rads: '360,280,240' } },
  { pattern: /corsair 4000d/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 360, maxCooler: 170, fans_inc: 2, drive25: 2, drive35: 2, rads: '360,280,240' } },
  { pattern: /corsair 3500x/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 400, maxCooler: 170, fans_inc: 0, drive25: 2, drive35: 2, rads: '360,280,240' } },
  { pattern: /corsair 2500x/i, specs: { mobo: 'mATX,ITX', maxGPU: 400, maxCooler: 170, fans_inc: 0, drive25: 2, drive35: 0, rads: '360,280,240' } },
  { pattern: /corsair 7000d/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 450, maxCooler: 190, fans_inc: 3, drive25: 6, drive35: 2, rads: '420,360,280' } },
  { pattern: /corsair (?:icue )?9000d/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 450, maxCooler: 190, fans_inc: 5, drive25: 8, drive35: 4, rads: '420,360,280' } },
  { pattern: /corsair carbide/i, specs: { mobo: 'ATX,mATX,ITX', maxGPU: 370, maxCooler: 170, fans_inc: 2, drive25: 2, drive35: 2, rads: '280,240' } },

  // Fractal Design
  { pattern: /fractal (?:design )?north(?!\s*xl)/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 355, maxCooler: 170, fans_inc: 2, drive25: 2, drive35: 2, rads: '360,280,240' } },
  { pattern: /fractal (?:design )?north xl/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 413, maxCooler: 185, fans_inc: 4, drive25: 4, drive35: 4, rads: '420,360,280' } },
  { pattern: /fractal (?:design )?meshify 2 (?:compact|c)/i, specs: { mobo: 'ATX,mATX,ITX', maxGPU: 360, maxCooler: 169, fans_inc: 2, drive25: 2, drive35: 2, rads: '360,280,240' } },
  { pattern: /fractal (?:design )?meshify 2(?!\s*compact)/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 467, maxCooler: 185, fans_inc: 3, drive25: 4, drive35: 2, rads: '420,360,280' } },
  { pattern: /fractal (?:design )?meshify c/i, specs: { mobo: 'ATX,mATX,ITX', maxGPU: 315, maxCooler: 172, fans_inc: 2, drive25: 2, drive35: 2, rads: '280,240' } },
  { pattern: /fractal (?:design )?torrent (?:nano|mini)/i, specs: { mobo: 'ITX', maxGPU: 335, maxCooler: 165, fans_inc: 2, drive25: 2, drive35: 2, rads: '240' } },
  { pattern: /fractal (?:design )?torrent compact/i, specs: { mobo: 'ATX,mATX,ITX', maxGPU: 335, maxCooler: 158, fans_inc: 3, drive25: 2, drive35: 2, rads: '280,240' } },
  { pattern: /fractal (?:design )?torrent/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 461, maxCooler: 188, fans_inc: 5, drive25: 4, drive35: 2, rads: '420,360,280' } },
  { pattern: /fractal (?:design )?pop (?:air|silent|mini)/i, specs: { mobo: 'ATX,mATX,ITX', maxGPU: 365, maxCooler: 170, fans_inc: 2, drive25: 2, drive35: 2, rads: '360,280,240' } },
  { pattern: /fractal (?:design )?define 7 (?:compact|nano)/i, specs: { mobo: 'mATX,ITX', maxGPU: 360, maxCooler: 169, fans_inc: 2, drive25: 2, drive35: 4, rads: '280,240' } },
  { pattern: /fractal (?:design )?define 7/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 491, maxCooler: 185, fans_inc: 3, drive25: 4, drive35: 6, rads: '420,360,280' } },
  { pattern: /fractal (?:design )?ridge/i, specs: { mobo: 'ITX', maxGPU: 325, maxCooler: 70, fans_inc: 1, drive25: 2, drive35: 0, rads: '120' } },
  { pattern: /fractal (?:design )?terra/i, specs: { mobo: 'ITX', maxGPU: 322, maxCooler: 77, fans_inc: 0, drive25: 1, drive35: 0, rads: '120' } },
  { pattern: /fractal (?:design )?node 304/i, specs: { mobo: 'ITX', maxGPU: 312, maxCooler: 165, fans_inc: 2, drive25: 0, drive35: 6, rads: '120' } },

  // NZXT
  { pattern: /nzxt h9 (?:flow|elite)/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 435, maxCooler: 165, fans_inc: 4, drive25: 5, drive35: 2, rads: '360,280,240' } },
  { pattern: /nzxt h7 (?:flow|elite)/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 400, maxCooler: 165, fans_inc: 3, drive25: 4, drive35: 2, rads: '360,280,240' } },
  { pattern: /nzxt h6 flow/i, specs: { mobo: 'ATX,mATX,ITX', maxGPU: 365, maxCooler: 165, fans_inc: 3, drive25: 2, drive35: 2, rads: '360,280,240' } },
  { pattern: /nzxt h5 (?:flow|elite)/i, specs: { mobo: 'ATX,mATX,ITX', maxGPU: 365, maxCooler: 165, fans_inc: 2, drive25: 2, drive35: 2, rads: '280,240' } },
  { pattern: /nzxt h1/i, specs: { mobo: 'ITX', maxGPU: 305, maxCooler: 70, fans_inc: 1, drive25: 1, drive35: 1, rads: '140' } },

  // Phanteks
  { pattern: /phanteks evolv x2/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 420, maxCooler: 165, fans_inc: 0, drive25: 5, drive35: 2, rads: '420,360,280' } },
  { pattern: /phanteks evolv x/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 435, maxCooler: 190, fans_inc: 3, drive25: 4, drive35: 4, rads: '360,280,240' } },
  { pattern: /phanteks g500a/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 435, maxCooler: 175, fans_inc: 4, drive25: 4, drive35: 2, rads: '360,280,240' } },
  { pattern: /phanteks p400/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 420, maxCooler: 160, fans_inc: 2, drive25: 3, drive35: 2, rads: '360,280,240' } },
  { pattern: /phanteks p500a/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 435, maxCooler: 190, fans_inc: 3, drive25: 4, drive35: 4, rads: '420,360,280' } },
  { pattern: /phanteks p600s/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 435, maxCooler: 192, fans_inc: 3, drive25: 6, drive35: 4, rads: '420,360,280' } },
  { pattern: /phanteks (?:enthoo )?elite/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 503, maxCooler: 220, fans_inc: 0, drive25: 8, drive35: 8, rads: '420,360,280' } },
  { pattern: /phanteks shift/i, specs: { mobo: 'ITX', maxGPU: 335, maxCooler: 75, fans_inc: 1, drive25: 1, drive35: 0, rads: '140' } },
  { pattern: /phanteks (?:eclipse )?nv7/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 460, maxCooler: 185, fans_inc: 3, drive25: 6, drive35: 4, rads: '420,360,280' } },
  { pattern: /phanteks (?:eclipse )?nv5/i, specs: { mobo: 'ATX,mATX,ITX', maxGPU: 400, maxCooler: 185, fans_inc: 4, drive25: 4, drive35: 2, rads: '360,280,240' } },

  // Cooler Master
  { pattern: /cooler master masterbox td500 mesh/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 410, maxCooler: 165, fans_inc: 3, drive25: 2, drive35: 2, rads: '360,280,240' } },
  { pattern: /cooler master nr200/i, specs: { mobo: 'mATX,ITX', maxGPU: 330, maxCooler: 153, fans_inc: 2, drive25: 3, drive35: 2, rads: '280,240' } },
  { pattern: /cooler master haf 700/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 490, maxCooler: 200, fans_inc: 4, drive25: 4, drive35: 4, rads: '480,420,360' } },
  { pattern: /cooler master qube 500/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 380, maxCooler: 172, fans_inc: 1, drive25: 1, drive35: 2, rads: '360,280,240' } },

  // be quiet!
  { pattern: /be quiet!? pure base 500/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 369, maxCooler: 190, fans_inc: 2, drive25: 5, drive35: 3, rads: '360,280,240' } },
  { pattern: /be quiet!? silent base/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 423, maxCooler: 185, fans_inc: 3, drive25: 7, drive35: 7, rads: '360,280,240' } },
  { pattern: /be quiet!? dark base/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 470, maxCooler: 185, fans_inc: 3, drive25: 7, drive35: 7, rads: '420,360,280' } },
  { pattern: /be quiet!? shadow base/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 430, maxCooler: 180, fans_inc: 3, drive25: 4, drive35: 2, rads: '420,360,280' } },

  // HYTE
  { pattern: /hyte y70/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 423, maxCooler: 167, fans_inc: 0, drive25: 4, drive35: 2, rads: '360,280,240' } },
  { pattern: /hyte y60/i, specs: { mobo: 'ATX,mATX,ITX', maxGPU: 422, maxCooler: 160, fans_inc: 3, drive25: 2, drive35: 2, rads: '360,280,240' } },
  { pattern: /hyte y40/i, specs: { mobo: 'ATX,mATX,ITX', maxGPU: 422, maxCooler: 160, fans_inc: 0, drive25: 2, drive35: 0, rads: '280,240' } },
  { pattern: /hyte revolt/i, specs: { mobo: 'ITX', maxGPU: 335, maxCooler: 140, fans_inc: 1, drive25: 1, drive35: 0, rads: '240' } },

  // Montech
  { pattern: /montech sky two/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 410, maxCooler: 174, fans_inc: 4, drive25: 2, drive35: 2, rads: '360,280,240' } },
  { pattern: /montech king/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 400, maxCooler: 170, fans_inc: 4, drive25: 2, drive35: 2, rads: '360,280,240' } },
  { pattern: /montech air 100|montech air ng/i, specs: { mobo: 'mATX,ITX', maxGPU: 330, maxCooler: 158, fans_inc: 4, drive25: 1, drive35: 1, rads: '240' } },

  // ASUS ROG
  { pattern: /asus rog hyperion/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 460, maxCooler: 190, fans_inc: 4, drive25: 6, drive35: 4, rads: '420,360,280' } },
  { pattern: /asus rog strix helios/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 450, maxCooler: 190, fans_inc: 0, drive25: 6, drive35: 4, rads: '420,360,280' } },

  // MSI
  { pattern: /msi mpg gungnir/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 400, maxCooler: 170, fans_inc: 4, drive25: 2, drive35: 2, rads: '360,280,240' } },

  // Thermaltake
  { pattern: /thermaltake core p3/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 320, maxCooler: 180, fans_inc: 0, drive25: 2, drive35: 2, rads: '480,420,360' } },
  { pattern: /thermaltake ah t600/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 400, maxCooler: 200, fans_inc: 0, drive25: 2, drive35: 2, rads: '420,360,280' } },
  { pattern: /thermaltake view 51/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 410, maxCooler: 180, fans_inc: 1, drive25: 4, drive35: 4, rads: '360,280,240' } },
  { pattern: /thermaltake versa h17/i, specs: { mobo: 'mATX,ITX', maxGPU: 350, maxCooler: 155, fans_inc: 1, drive25: 2, drive35: 2, rads: '240' } },

  // SilverStone
  { pattern: /silverstone alta f1/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 410, maxCooler: 180, fans_inc: 1, drive25: 2, drive35: 4, rads: '360,280,240' } },
  { pattern: /silverstone fara r1/i, specs: { mobo: 'ATX,mATX,ITX', maxGPU: 322, maxCooler: 162, fans_inc: 1, drive25: 2, drive35: 2, rads: '240' } },

  // ASUS Prime AP201
  { pattern: /asus prime ap201/i, specs: { mobo: 'mATX,ITX', maxGPU: 338, maxCooler: 170, fans_inc: 0, drive25: 2, drive35: 0, rads: '360,280,240' } },

  // Antec
  { pattern: /antec p120/i, specs: { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 405, maxCooler: 175, fans_inc: 0, drive25: 4, drive35: 2, rads: '360,280,240' } },
  { pattern: /antec dark league/i, specs: { mobo: 'ATX,mATX,ITX', maxGPU: 380, maxCooler: 170, fans_inc: 4, drive25: 2, drive35: 2, rads: '360,280,240' } },
];

// Estimate specs from form factor when no exact match
function inferFromFormFactor(p) {
  const tower = (p.tower || '').toLowerCase();
  const ff = (p.ff || '').toLowerCase();

  // Full tower / E-ATX
  if (/full|big|super|XL/i.test(tower) || /eatx|e-atx|full/i.test(ff)) {
    return { mobo: 'E-ATX,ATX,mATX,ITX', maxGPU: 420, maxCooler: 180, drive25: 4, drive35: 4, rads: '360,280,240' };
  }
  // Mid tower / ATX
  if (/mid|atx/i.test(tower) || ff === 'atx') {
    return { mobo: 'ATX,mATX,ITX', maxGPU: 380, maxCooler: 170, drive25: 2, drive35: 2, rads: '360,280,240' };
  }
  // Mini tower / mATX
  if (/mini.tower|mini\.itx|matx|m-atx|microatx/i.test(tower) || /matx|micro/i.test(ff)) {
    return { mobo: 'mATX,ITX', maxGPU: 350, maxCooler: 165, drive25: 2, drive35: 2, rads: '280,240' };
  }
  // ITX / SFF
  if (/itx|sff|small/i.test(tower) || /itx/i.test(ff)) {
    return { mobo: 'ITX', maxGPU: 320, maxCooler: 80, drive25: 1, drive35: 0, rads: '120' };
  }
  // Default to ATX-class
  return { mobo: 'ATX,mATX,ITX', maxGPU: 380, maxCooler: 170, drive25: 2, drive35: 2, rads: '360,280,240' };
}

function extractColor(p) {
  if (p.color) return null;
  const text = p.n.toLowerCase();
  if (/black/i.test(text)) return 'Black';
  if (/white/i.test(text)) return 'White';
  if (/grey|gray/i.test(text)) return 'Gray';
  if (/silver/i.test(text)) return 'Silver';
  if (/wood|walnut/i.test(text)) return 'Wood';
  if (/pink/i.test(text)) return 'Pink';
  if (/blue/i.test(text)) return 'Blue';
  return 'Black'; // most cases default
}

function setFields(s, id, fields) {
  const idMarker = '"id": ' + id + ',';
  const idIdx = s.indexOf(idMarker);
  if (idIdx < 0) return { s, count: 0 };
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
  let count = 0;
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    if (entryText.includes('"' + k + '":')) continue;
    let formatted = typeof v === 'string' ? '"' + v + '"' : v;
    const matchClosing = entryText.match(/^([\s\S]*?)(\n\s*\}\s*)$/);
    if (matchClosing) {
      const before = matchClosing[1];
      const closing = matchClosing[2];
      entryText = before.replace(/,?\s*$/, '') + ',\n    "' + k + '": ' + formatted + closing;
      count++;
    }
  }
  if (count === 0) return { s, count: 0 };
  return { s: s.substring(0, startBrace) + entryText + s.substring(endBrace + 1), count };
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  let s = fs.readFileSync(PARTS_PATH, 'utf8');

  let stats = { total: 0, exactMatches: 0, fallback: 0, fieldsAdded: 0, color: 0 };

  for (const p of parts) {
    if (p.c !== 'Case') continue;
    stats.total++;

    const fields = {};

    // Try exact known match first
    let exact = null;
    for (const { pattern, specs } of KNOWN_SPECS) {
      if (pattern.test(p.n)) { exact = specs; break; }
    }

    if (exact) {
      stats.exactMatches++;
      Object.assign(fields, exact);
    } else {
      // Fallback to form-factor-based defaults
      stats.fallback++;
      const inferred = inferFromFormFactor(p);
      Object.assign(fields, inferred);
    }

    // Color
    const color = extractColor(p);
    if (color) { fields.color = color; stats.color++; }

    if (Object.keys(fields).length > 0) {
      const r = setFields(s, p.id, fields);
      if (r.count > 0) {
        s = r.s;
        stats.fieldsAdded += r.count;
      }
    }
  }

  fs.writeFileSync(PARTS_PATH, s);
  console.log('Case enrichment:');
  console.log('  Total cases: ' + stats.total);
  console.log('  Exact matches: ' + stats.exactMatches);
  console.log('  Fallback (form factor inferred): ' + stats.fallback);
  console.log('  Color filled: ' + stats.color);
  console.log('  Total fields added: ' + stats.fieldsAdded);
})();
