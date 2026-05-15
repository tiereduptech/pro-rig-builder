/**
 * apply-cpu-benches.cjs
 * 
 * Applies PassMark CPU benches to parts.js. Uses the same matching logic
 * as normalize-cpu-benches.js but writes via JSON.stringify (more reliable
 * than line-based string editing).
 */

const fs = require('fs');
const APPLY = process.argv.includes('--apply');

function cleanUnicode(s) {
  return String(s || '')
    .replace(/[\u00AD\u200B-\u200F\uFEFF]/g, '')
    .replace(/[\u00A0]/g, ' ')
    .replace(/[â„¢Â®Â©]/g, '')
    .normalize('NFKC');
}

function isSkipped(name) {
  if (/\b(Xeon|EPYC|Threadripper|Workstation|Server)\b/i.test(name)) return true;
  if (/\bi[3579]-?\d{4,5}(HX?|HQ|HK|U|P|Y|G\d)\b/i.test(name)) return true;
  if (/\bRyzen\s+[3579]\s+\d{4,5}(HS|HX|\bU\b)\b/i.test(name)) return true;
  if (/\bCore\s*Ultra\s*[3579][-\s]*\d{3}(H|HX|U)\b/i.test(name)) return true;
  return false;
}

function extractModel(rawName) {
  const name = cleanUnicode(rawName);
  if (isSkipped(name)) return null;

  // Intel Core Ultra
  let u = name.match(/\bCore\s*Ultra\s*([3579])\b/i);
  if (u) {
    const after = name.slice(u.index + u[0].length, u.index + u[0].length + 80);
    const mm = after.match(/\b(\d{3})([A-Z]{1,2})?\b/);
    if (mm) return `Core Ultra ${u[1]} ${mm[1]}${mm[2] ? mm[2].toUpperCase() : ''}`;
  }

  // Intel Core i3/i5/i7/i9
  let im = name.match(/\b(?:Intel\s*)?(?:Core\s*)?(i[3579])[-\s]*(\d{4,5}[A-Z]{0,2})\b/i);
  if (im) return `${im[1].toLowerCase()}-${im[2].toUpperCase()}`;

  // Threadripper intentionally not handled (skipped via isSkipped above)

  // AMD Ryzen 3/5/7/9 â€” handle X3D and similar digit-containing suffixes
  let am = name.match(/\bRyzen\s*([3579])[-\s]*(\d{4}(?:X3D2?|X3D|XT|GT|G|F|X|E)?)/i);
  if (am) return `Ryzen ${am[1]} ${am[2].toUpperCase()}`;

  // Intel Pentium Gold
  let pg = name.match(/\bPentium\s*Gold\s*(G[-\s]?\d{4})/i);
  if (pg) return `Pentium Gold ${pg[1].replace(/[\s-]/g,'').toUpperCase()}`;

  // Intel Celeron
  let cl = name.match(/\bCeleron\s*(G\d{4})/i);
  if (cl) return `Celeron ${cl[1].toUpperCase()}`;

  return null;
}

(async () => {
  if (!fs.existsSync('passmark-cpus.json')) {
    console.error('passmark-cpus.json missing');
    process.exit(1);
  }
  const passmark = JSON.parse(fs.readFileSync('passmark-cpus.json', 'utf8'));

  // Build a lookup: model -> passmark score
  // passmark is {name: score, ...}
  const lookup = {};
  for (const [name, score] of Object.entries(passmark)) {
    const m = extractModel(name);
    if (!m) continue;
    if (!lookup[m] || score > lookup[m]) lookup[m] = score;
  }
  console.log('Passmark models extracted:', Object.keys(lookup).length);

  // Anchor: Ryzen 9 9950X3D = bench 100 (matches existing catalog scoring)
  let anchor = null;
  // Try preferred anchors in order
  const preferred = ['Ryzen 9 9950X3D', 'Ryzen 9 9950X', 'Core Ultra 9 285K'];
  for (const name of preferred) {
    if (lookup[name]) { anchor = [name, lookup[name]]; break; }
  }
  if (!anchor) {
    // Fall back to highest consumer CPU
    const consumerModels = Object.entries(lookup).filter(([m]) => 
      /^Ryzen\s*[579]\s*\d{4}[X3D]+/i.test(m) || /^i[579]-\d{5}K?/i.test(m) || /^Core Ultra/i.test(m)
    );
    consumerModels.sort((a,b) => b[1] - a[1]);
    anchor = consumerModels[0];
  }
  if (!anchor) { console.error('No anchor found'); process.exit(1); }
  console.log('Anchor:', anchor[0], '=', anchor[1], 'â†’ scaleFactor', (100 / anchor[1]).toFixed(6));
  const scaleFactor = 100 / anchor[1];

  // Load parts
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...m.PARTS];

  const stats = { matched: 0, unchanged: 0, unmatched: 0, updated: 0 };
  const updates = [];

  for (const p of parts) {
    if (p.c !== 'CPU') continue;
    if (p.needsReview) continue;

    const model = extractModel(p.n);
    if (!model) { stats.unmatched++; continue; }

    const score = lookup[model];
    if (!score) { stats.unmatched++; continue; }

    const newBench = Math.round(score * scaleFactor);
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
  updates.forEach(u => console.log(`  [${u.id}] ${u.old}â†’${u.new} | ${u.model.padEnd(20)} | ${u.name}`));

  if (APPLY) {
    const header = '// Auto-merged catalog. Edit with care.\n';
    const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
    fs.writeFileSync('src/data/parts.js', header + body, 'utf8');
    console.log(`\nApplied: ${stats.updated} CPU benches written.`);
  }
})();
