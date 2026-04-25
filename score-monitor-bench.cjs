// score-monitor-bench.cjs
// Computes 0-100 bench (quality) score for monitors based on specs

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

function scoreMonitor(p) {
  let score = 30; // base

  // Resolution (-15 to +25) - core spec
  const res = (p.res || '').toLowerCase();
  if (/8k|7680/.test(res)) score += 30;
  else if (/4k|2160|3840|uhd/.test(res)) score += 25;
  else if (/1440|qhd|2k\b/.test(res)) score += 15;
  else if (/1080|fhd/.test(res)) score += 5;
  else if (/720|hd\b/.test(res)) score -= 10;
  else if (/ultrawide|3440/.test(res)) score += 22;

  // Refresh rate (-5 to +25)
  const refresh = p.refresh || 0;
  if (refresh >= 480) score += 28;
  else if (refresh >= 360) score += 25;
  else if (refresh >= 240) score += 22;
  else if (refresh >= 165) score += 16;
  else if (refresh >= 144) score += 12;
  else if (refresh >= 120) score += 8;
  else if (refresh >= 75) score += 2;
  else if (refresh >= 60) score -= 2;
  else if (refresh > 0) score -= 8;

  // Panel type (+0 to +15)
  const panel = (p.panel || '').toLowerCase();
  if (/oled|qd-?oled/i.test(panel)) score += 18;
  else if (/mini[\s-]?led/i.test(panel)) score += 12;
  else if (/ips/i.test(panel)) score += 8;
  else if (/va/i.test(panel)) score += 4;
  else if (/tn/i.test(panel)) score -= 3;

  // Response time (-5 to +10)
  const resp = parseFloat(p.response) || 0;
  if (resp > 0) {
    if (resp <= 0.03) score += 10; // OLED-tier
    else if (resp <= 1) score += 7;
    else if (resp <= 2) score += 4;
    else if (resp <= 4) score += 1;
    else if (resp <= 8) score -= 2;
    else score -= 5;
  }

  // HDR (+0 to +10)
  const hdr = (p.hdr || '').toString().toLowerCase();
  if (/hdr.?1[02]00|true black/i.test(hdr)) score += 10;
  else if (/hdr.?600/i.test(hdr)) score += 6;
  else if (/hdr.?400/i.test(hdr)) score += 3;
  else if (hdr === 'true' || hdr === 'yes') score += 4;

  // Adaptive Sync (+5)
  const sync = (p.sync || '').toLowerCase();
  if (/g[-\s]?sync.+ultimate|premium pro/i.test(sync)) score += 8;
  else if (/g[-\s]?sync|freesync premium/i.test(sync)) score += 5;
  else if (/freesync|adaptive/i.test(sync)) score += 3;

  // Curved (+2 for ultrawide premium feel)
  if (p.curved === true) score += 2;

  // Screen size sweet spot
  const sz = p.screenSize || 0;
  if (sz >= 32 && sz <= 49) score += 3;
  else if (sz >= 27 && sz < 32) score += 2;
  else if (sz < 24) score -= 3;

  // Rating influence
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
    if (p.c !== 'Monitor') continue;
    const bench = scoreMonitor(p);
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
  console.log('Monitors scored: ' + stats.n);
  console.log('avg=' + (stats.sum / stats.n).toFixed(1) + ' min=' + stats.min + ' max=' + stats.max);
  const buckets = Object.keys(stats.distribution).map(Number).sort((a, b) => a - b);
  buckets.forEach(b => console.log('  ' + b + '-' + (b + 9) + ': ' + stats.distribution[b]));
})();
