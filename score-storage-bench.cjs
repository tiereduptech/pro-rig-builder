// score-storage-bench.cjs
// Storage bench score 0-100 based on seq_r, seq_w, interface, type
// Skips products that already have bench

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

function scoreStorage(p) {
  let score = 0;
  const r = p.seq_r || 0;  // MB/s
  const w = p.seq_w || 0;
  const cap = p.cap || 0;  // GB
  const type = (p.storageType || '').toLowerCase();
  const iface = (p.interface || '').toLowerCase();
  const name = (p.n || '').toLowerCase();

  // HDDs cap out around 30 (mechanical limits)
  if (/hdd|7200|5400|hard\s*drive/i.test(type) || /hdd|7200rpm|5400rpm/i.test(name)) {
    if (r >= 250) score = 30;
    else if (r >= 200) score = 25;
    else if (r >= 150) score = 20;
    else if (r >= 100) score = 15;
    else score = 10;
    // Bonus for capacity (HDDs differentiate by size)
    if (cap >= 16000) score += 5;
    else if (cap >= 10000) score += 3;
    return Math.min(40, score);
  }

  // SATA SSDs cap around 50 (interface bottleneck)
  if (/sata/i.test(iface) || /sata/i.test(type) || /sata/i.test(name)) {
    if (r >= 560) score = 50;
    else if (r >= 540) score = 45;
    else if (r >= 500) score = 40;
    else if (r >= 400) score = 32;
    else score = 25;
    return Math.min(55, score);
  }

  // NVMe: scoring based on Gen + speed
  // Gen5 NVMe (>10GB/s read)
  if (/gen5|pcie 5|pcie5/i.test(iface) || /gen5|pcie 5|pcie5/i.test(name) || r >= 12000) {
    if (r >= 14000) score = 100;
    else if (r >= 12000) score = 95;
    else if (r >= 10000) score = 88;
    else score = 80;
  }
  // Gen4 NVMe (~7000 MB/s)
  else if (/gen4|pcie 4|pcie4/i.test(iface) || /gen4|pcie 4|pcie4/i.test(name) || r >= 6000) {
    if (r >= 7400) score = 80;
    else if (r >= 7000) score = 75;
    else if (r >= 6500) score = 70;
    else if (r >= 5000) score = 65;
    else score = 55;
  }
  // Gen3 NVMe (~3500 MB/s)
  else if (/gen3|pcie 3|pcie3|nvme/i.test(iface) || /gen3|pcie 3|pcie3|nvme/i.test(name) || r >= 2000) {
    if (r >= 3500) score = 55;
    else if (r >= 3000) score = 48;
    else if (r >= 2500) score = 42;
    else score = 35;
  }
  // External / USB / unknown
  else if (/external|usb/i.test(name) || /external/i.test(type)) {
    if (r >= 1000) score = 45; // USB 3.2 Gen 2x2
    else if (r >= 500) score = 35; // USB 3.2 Gen 2
    else score = 25; // USB 3.0
  }
  // Fallback - assume basic SSD
  else {
    if (r >= 3000) score = 50;
    else if (r >= 1000) score = 40;
    else if (r >= 500) score = 30;
    else if (r > 0) score = 20;
    else score = 25; // unknown but SSD
  }

  // Write speed bonus for NVMe
  if (w > 0) {
    if (w >= 12000) score += 5;
    else if (w >= 6500) score += 3;
    else if (w >= 5000) score += 2;
  }

  // DRAM cache adds reliability/performance
  if (p.dram === true) score += 3;

  // TLC > QLC > MLC
  if (p.tlc === true || /tlc/i.test(p.nand || '')) score += 2;
  if (/qlc/i.test(p.nand || '')) score -= 3;
  if (/mlc|slc/i.test(p.nand || '')) score += 4;

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

  let stats = { total: 0, scored: 0, alreadyHad: 0, sum: 0, distribution: {} };
  for (const p of parts) {
    if (p.c !== 'Storage') continue;
    stats.total++;
    if (p.bench && p.bench > 0) { stats.alreadyHad++; continue; }

    const bench = scoreStorage(p);
    const r = setBench(s, p.id, bench);
    if (r.set) {
      s = r.s;
      stats.scored++;
      stats.sum += bench;
      const bucket = Math.floor(bench / 10) * 10;
      stats.distribution[bucket] = (stats.distribution[bucket] || 0) + 1;
    }
  }

  fs.writeFileSync(PARTS_PATH, s);
  console.log('Storage scoring:');
  console.log('  Total: ' + stats.total);
  console.log('  Already had bench: ' + stats.alreadyHad);
  console.log('  Newly scored: ' + stats.scored);
  if (stats.scored > 0) {
    console.log('  Avg new score: ' + (stats.sum / stats.scored).toFixed(1));
    const buckets = Object.keys(stats.distribution).map(Number).sort((a, b) => a - b);
    buckets.forEach(b => console.log('    ' + b + '-' + (b + 9) + ': ' + stats.distribution[b]));
  }
})();
