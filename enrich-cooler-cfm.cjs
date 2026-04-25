// enrich-cooler-cfm.cjs

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

// Known cooler airflow specs (CFM totals per cooler, including all included fans)
// These are manufacturer rated CFM values
const KNOWN_CFM = [
  // Noctua air coolers
  { pattern: /noctua nh[-\s]?d15(?!\s*g2)/i, cfm: 165 },     // NH-D15 (2x NF-A15 PWM ~82.5 each)
  { pattern: /noctua nh[-\s]?d15 g2/i, cfm: 175 },           // NH-D15 G2 (2x NF-A14x25r)
  { pattern: /noctua nh[-\s]?u12a/i, cfm: 102 },             // NH-U12A (2x NF-A12x25)
  { pattern: /noctua nh[-\s]?u12s/i, cfm: 60 },              // NH-U12S
  { pattern: /noctua nh[-\s]?u14s/i, cfm: 81 },              // NH-U14S
  { pattern: /noctua nh[-\s]?l9/i, cfm: 33 },                // NH-L9
  { pattern: /noctua nh[-\s]?l12/i, cfm: 80 },               // NH-L12

  // be quiet!
  { pattern: /dark rock pro 5/i, cfm: 110 },                  // 1x Silent Wings 4 + 135mm
  { pattern: /dark rock pro 4/i, cfm: 90 },
  { pattern: /dark rock 4/i, cfm: 65 },
  { pattern: /dark rock elite/i, cfm: 110 },
  { pattern: /pure rock 2/i, cfm: 51 },
  { pattern: /shadow rock/i, cfm: 67 },

  // DeepCool air
  { pattern: /deepcool ak620|ak[-\s]?620/i, cfm: 132 },        // AK620 dual tower
  { pattern: /deepcool ak500/i, cfm: 68 },
  { pattern: /deepcool ak400/i, cfm: 67 },
  { pattern: /assassin iv|assassin 4/i, cfm: 145 },          // DeepCool Assassin IV

  // Thermalright air
  { pattern: /peerless assassin 120 se/i, cfm: 132 },        // 2x TL-C12C
  { pattern: /peerless assassin 120/i, cfm: 132 },
  { pattern: /phantom spirit 120/i, cfm: 132 },
  { pattern: /burst assassin 120/i, cfm: 132 },
  { pattern: /frost commander/i, cfm: 110 },
  { pattern: /frozen prism/i, cfm: 95 },
  { pattern: /assassin x120/i, cfm: 75 },
  { pattern: /assassin x90/i, cfm: 60 },
  { pattern: /aqua elite|frozen warframe/i, cfm: 132 },
  { pattern: /thermalright FS140|FS[-\s]?140/i, cfm: 95 },

  // Cooler Master
  { pattern: /hyper 212 black/i, cfm: 56 },
  { pattern: /hyper 212/i, cfm: 56 },
  { pattern: /hyper 412/i, cfm: 56 },
  { pattern: /MA610|MA612/i, cfm: 110 },
  { pattern: /MA620|MA624/i, cfm: 110 },

  // Scythe
  { pattern: /fuma 3/i, cfm: 110 },
  { pattern: /fuma 2/i, cfm: 105 },
  { pattern: /mugen 6/i, cfm: 65 },

  // ID-COOLING
  { pattern: /SE[-\s]?226[-\s]?XT/i, cfm: 84 },
  { pattern: /SE[-\s]?224[-\s]?XT/i, cfm: 76 },
  { pattern: /SE[-\s]?207/i, cfm: 87 },

  // AIOs - 360mm
  { pattern: /h150i.+(elite|lcd|capellix)/i, cfm: 174 },     // 3x ML120 RGB Elite
  { pattern: /h170i/i, cfm: 220 },                            // 3x 140mm
  { pattern: /h150i/i, cfm: 174 },
  { pattern: /kraken (?:elite|z) 360/i, cfm: 213 },          // NZXT Kraken Elite 360
  { pattern: /kraken 360/i, cfm: 213 },
  { pattern: /liquid freezer.+360/i, cfm: 200 },
  { pattern: /galahad ii.+360/i, cfm: 165 },
  { pattern: /aorus.+360/i, cfm: 165 },
  { pattern: /msi.+360/i, cfm: 165 },
  { pattern: /360.?mm.+aio|aio.+360.?mm/i, cfm: 180 },       // generic 360 AIO

  // AIOs - 280mm
  { pattern: /h115i/i, cfm: 145 },
  { pattern: /kraken (?:elite|z) 280/i, cfm: 165 },
  { pattern: /kraken 280/i, cfm: 165 },
  { pattern: /liquid freezer.+280/i, cfm: 180 },
  { pattern: /280.?mm.+aio|aio.+280.?mm/i, cfm: 150 },

  // AIOs - 240mm
  { pattern: /h100i.+(elite|lcd|capellix)/i, cfm: 116 },
  { pattern: /h100i/i, cfm: 116 },
  { pattern: /kraken (?:elite|z) 240/i, cfm: 142 },
  { pattern: /kraken 240/i, cfm: 142 },
  { pattern: /liquid freezer.+240/i, cfm: 130 },
  { pattern: /240.?mm.+aio|aio.+240.?mm/i, cfm: 120 },

  // AIOs - 120mm
  { pattern: /kraken 120/i, cfm: 71 },
  { pattern: /h60|elite capellix.+120/i, cfm: 60 },
  { pattern: /120.?mm.+aio|aio.+120.?mm/i, cfm: 60 },

  // Low-profile / SFF
  { pattern: /low.profile|slim/i, cfm: 35 },
  { pattern: /noctua nh[-\s]?l/i, cfm: 35 },
];

function estimateCFM(p) {
  if (p.cfm) return null;

  const text = p.n + ' ' + (p.b || '');

  // 1. Try known model match first
  for (const { pattern, cfm } of KNOWN_CFM) {
    if (pattern.test(text)) return cfm;
  }

  // 2. Estimate from rad size for unknown AIOs
  const radSize = parseInt(p.radSize) || 0;
  if (radSize > 0) {
    if (radSize >= 420) return 240;
    if (radSize >= 360) return 180;
    if (radSize >= 280) return 145;
    if (radSize >= 240) return 120;
    if (radSize >= 140) return 75;
    if (radSize >= 120) return 60;
  }

  // 3. Estimate from fan size + count for air coolers
  const fanSize = p.fanSize || 0;
  const fanCount = p.fans_inc || 1;
  if (fanSize > 0) {
    let perFanCFM = 0;
    if (fanSize >= 140) perFanCFM = 75;
    else if (fanSize === 120) perFanCFM = 65;
    else if (fanSize === 92) perFanCFM = 35;
    else if (fanSize === 80) perFanCFM = 25;
    if (perFanCFM > 0) return perFanCFM * fanCount;
  }

  // 4. Cooler type fallback
  const ct = (p.coolerType || '').toLowerCase();
  if (/aio|liquid|water/.test(ct)) return 120; // generic AIO
  if (/dual.tower|tower/.test(ct)) return 110; // dual tower air
  if (/air|tower/.test(ct)) return 65; // single tower
  if (/low.profile|slim/.test(ct)) return 35;

  return 60; // ultimate fallback
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

  let stats = { total: 0, added: 0, fromKnown: 0, fromEstimate: 0 };

  for (const p of parts) {
    if (p.c !== 'CPUCooler') continue;
    stats.total++;
    if (p.cfm) continue;

    const cfm = estimateCFM(p);
    if (cfm) {
      const r = setFields(s, p.id, { cfm });
      if (r.count > 0) {
        s = r.s;
        stats.added++;
      }
    }
  }

  fs.writeFileSync(PARTS_PATH, s);
  console.log('CPUCooler CFM enrichment:');
  console.log('  Total: ' + stats.total);
  console.log('  CFM added: ' + stats.added);
})();
