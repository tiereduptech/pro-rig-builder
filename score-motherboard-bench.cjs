// score-motherboard-bench.cjs

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

// Chipset tiers (modern AMD + Intel)
const CHIPSET_SCORES = {
  // AMD AM5
  'X870E': 35, 'X870': 30, 'B850': 25, 'B840': 20, 'A820': 12,
  // AMD AM4
  'X670E': 32, 'X670': 28, 'B650E': 25, 'B650': 22, 'A620': 10,
  'X570': 25, 'B550': 18, 'A520': 10,
  'X470': 18, 'B450': 12, 'A320': 6,
  // Intel LGA1851
  'Z890': 35, 'B860': 25, 'H810': 12,
  // Intel LGA1700
  'Z790': 30, 'Z690': 28, 'B760': 22, 'B660': 20, 'H770': 18, 'H670': 16, 'H610': 10,
  // Intel LGA1200
  'Z590': 22, 'Z490': 20, 'B560': 14, 'B460': 12, 'H510': 8, 'H410': 6,
  // Server/HEDT
  'TRX50': 40, 'WRX90': 45, 'W790': 35,
};

const PREMIUM_BRANDS = new Set(['ASUS','ROG','MSI','Gigabyte','Aorus','ASRock','EVGA','Supermicro']);
const TIER1_BRANDS = new Set(['Biostar','NZXT','Colorful','Maxsun']);

function brandBonus(p) {
  if (PREMIUM_BRANDS.has(p.b)) return 8;
  if (TIER1_BRANDS.has(p.b)) return 3;
  return -2;
}

// Detect series tier within a chipset family (Hero, Master, Tomahawk, etc.)
function seriesBonus(p) {
  const n = (p.n || '').toLowerCase();
  // Top tier
  if (/extreme|godlike|hero|formula|apex|ace|master|taichi|aqua/i.test(n)) return 12;
  // High tier
  if (/strix|aorus|tomahawk|edge|carbon|elite/i.test(n)) return 6;
  // Mid tier
  if (/tuf|pro|gaming|plus/i.test(n)) return 2;
  // Budget tier
  if (/prime|mortar|terminator|lite/i.test(n)) return -2;
  return 0;
}

function scoreMotherboard(p) {
  let score = 25; // base

  // Chipset is the foundation (-5 to +45)
  const chipset = (p.chipset || '').toUpperCase();
  if (CHIPSET_SCORES[chipset] != null) {
    score += CHIPSET_SCORES[chipset];
  } else {
    // Try fuzzy match - e.g. "AMD X870" or "Intel Z890"
    let matched = false;
    for (const [c, val] of Object.entries(CHIPSET_SCORES)) {
      if (chipset.includes(c)) { score += val; matched = true; break; }
    }
    if (!matched) score += 5; // unknown chipset
  }

  // Form factor (-5 to +5)
  const ff = (p.ff || '').toUpperCase();
  if (ff === 'EATX' || ff === 'E-ATX') score += 4;
  else if (ff === 'ATX') score += 2;
  else if (ff === 'MATX' || ff === 'MICRO-ATX' || ff === 'M-ATX') score += 0;
  else if (ff === 'ITX' || ff === 'MINI-ITX') score -= 2;

  // Memory type (DDR5 > DDR4)
  const mt = (p.memType || '').toUpperCase();
  if (mt === 'DDR5') score += 6;
  else if (mt === 'DDR4') score += 0;
  else if (mt === 'DDR3') score -= 5;

  // Memory slots
  const ms = p.memSlots || 0;
  if (ms >= 8) score += 5;
  else if (ms === 4) score += 3;
  else if (ms === 2) score += 0;

  // Max memory capacity
  const mm = p.maxMem || 0;
  if (mm >= 256) score += 5;
  else if (mm >= 192) score += 3;
  else if (mm >= 128) score += 2;
  else if (mm >= 64) score += 0;

  // M.2 slots
  const m2 = p.m2Slots || 0;
  if (m2 >= 5) score += 8;
  else if (m2 === 4) score += 5;
  else if (m2 === 3) score += 3;
  else if (m2 === 2) score += 1;
  else if (m2 === 1) score -= 2;

  // SATA ports
  const sata = p.sata || 0;
  if (sata >= 8) score += 4;
  else if (sata >= 6) score += 2;
  else if (sata >= 4) score += 0;

  // PCIe generation
  const pcie = (p.pcie || '').toString().toLowerCase();
  if (/5\.?0|gen5/.test(pcie)) score += 6;
  else if (/4\.?0|gen4/.test(pcie)) score += 3;
  else if (/3\.?0|gen3/.test(pcie)) score += 0;

  // Wi-Fi
  const wifi = (p.wifi || '').toLowerCase();
  if (/7|be/.test(wifi)) score += 6;
  else if (/6e/.test(wifi)) score += 4;
  else if (/6/.test(wifi)) score += 3;
  else if (/5|ac/.test(wifi)) score += 1;
  else if (wifi === 'none' || !wifi) score -= 1;

  // USB-C
  if (p.usb_c === true) score += 2;

  // LAN speed
  const lan = (p.lan || '').toLowerCase();
  if (/10g/i.test(lan)) score += 5;
  else if (/5g|2\.5g|2500/i.test(lan)) score += 2;
  else if (/1g|1000/i.test(lan)) score += 0;

  // Series tier
  score += seriesBonus(p);

  // Brand
  score += brandBonus(p);

  // Rating
  if (p.r) score += Math.round((p.r - 4.0) * 6);

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
    if (p.c !== 'Motherboard') continue;
    const bench = scoreMotherboard(p);
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
  console.log('Motherboards scored: ' + stats.n);
  console.log('avg=' + (stats.sum / stats.n).toFixed(1) + ' min=' + stats.min + ' max=' + stats.max);
  Object.keys(stats.distribution).map(Number).sort((a, b) => a - b).forEach(b => {
    console.log('  ' + b + '-' + (b + 9) + ': ' + stats.distribution[b]);
  });
})();
