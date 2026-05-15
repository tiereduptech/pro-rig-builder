/**
 * apply-gpu-benches.cjs
 * 
 * Same idea as apply-cpu-benches.cjs but for GPUs.
 * Loads passmark-gpus.json, matches against catalog, writes via JSON.stringify.
 */

const fs = require('fs');
const APPLY = process.argv.includes('--apply');

function clean(s) {
  return String(s || '').replace(/[\u00AD\u200B-\u200F\uFEFF]/g, '').replace(/[\u00A0]/g, ' ').replace(/[™®©]/g, '').normalize('NFKC');
}

function isSkipped(name) {
  if (/\b(Quadro|Tesla|FirePro|Radeon\s*Pro\s*W|RTX\s*A\d{4}|NVIDIA\s*A\d+\b|Workstation|Server)\b/i.test(name)) return true;
  return false;
}

function extractModel(rawName) {
  const name = clean(rawName).toUpperCase();
  if (isSkipped(name)) return null;

  // NVIDIA RTX
  let m = name.match(/\bRTX\s*(\d{4})\s*(TI\s*SUPER|TI|SUPER)?/i);
  if (m) return `RTX ${m[1]}${m[2] ? ' ' + m[2].replace(/\s+/g, ' ').toUpperCase() : ''}`.trim();

  // NVIDIA GTX
  m = name.match(/\bGTX\s*(\d{3,4})\s*(TI\s*SUPER|TI|SUPER)?/i);
  if (m) return `GTX ${m[1]}${m[2] ? ' ' + m[2].toUpperCase() : ''}`.trim();

  // AMD RX
  m = name.match(/\bRX\s*(\d{4})\s*(XTX|XT|GRE)?/i);
  if (m) return `RX ${m[1]}${m[2] ? ' ' + m[2].toUpperCase() : ''}`.trim();

  // Intel Arc
  m = name.match(/\bARC\s*([AB]\d{3})/i);
  if (m) return `ARC ${m[1].toUpperCase()}`;

  return null;
}

(async () => {
  if (!fs.existsSync('passmark-gpus.json')) {
    console.error('passmark-gpus.json missing');
    process.exit(1);
  }
  const passmark = JSON.parse(fs.readFileSync('passmark-gpus.json', 'utf8'));

  const lookup = {};
  for (const [name, score] of Object.entries(passmark)) {
    if (/RTX\s*\d{4}\s+D\b/i.test(name)) continue;
    const m = extractModel(name);
    if (!m) continue;
    if (!lookup[m] || score > lookup[m]) lookup[m] = score;
  }
  console.log('Passmark models extracted:', Object.keys(lookup).length);

  // Anchor: RTX 4090 = 100 (matches existing scale)
  const anchor = lookup['RTX 5090'] || lookup['RTX 4090'];
  if (!anchor) { console.error('No RTX 4090 in passmark'); process.exit(1); }
  console.log('Anchor:', lookup['RTX 5090'] ? 'RTX 5090' : 'RTX 4090', '=', anchor, '→ scaleFactor', (100 / anchor).toFixed(6));
  const scaleFactor = 100 / anchor;

  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...m.PARTS];

  const stats = { matched: 0, unchanged: 0, unmatched: 0, updated: 0 };
  const updates = [];

  for (const p of parts) {
    if (p.c !== 'GPU') continue;
    if (p.needsReview) continue;

    const model = extractModel(p.n);
    if (!model) { stats.unmatched++; continue; }
    const score = lookup[model];
    if (!score) { stats.unmatched++; continue; }

    const newBench = Math.max(1, Math.round(score * scaleFactor));
    const oldBench = p.bench;
    stats.matched++;

    if (oldBench === newBench) { stats.unchanged++; continue; }
    if (updates.length < 30) updates.push({ id: p.id, model, old: oldBench || 0, new: newBench, name: p.n.slice(0, 60) });
    if (APPLY) p.bench = newBench;
    stats.updated++;
  }

  console.log('\nMode:', APPLY ? 'APPLY' : 'DRY RUN');
  console.log('Matched to passmark:', stats.matched);
  console.log('Will update bench:', stats.updated);
  console.log('Already correct:', stats.unchanged);
  console.log('No regex match:', stats.unmatched);

  console.log('\nTop 30 updates:');
  updates.forEach(u => console.log(`  [${u.id}] ${u.old}→${u.new} | ${u.model.padEnd(15)} | ${u.name}`));

  if (APPLY) {
    const header = '// Auto-merged catalog. Edit with care.\n';
    const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
    fs.writeFileSync('src/data/parts.js', header + body, 'utf8');
    console.log(`\nApplied: ${stats.updated} GPU benches written.`);
  }
})();
