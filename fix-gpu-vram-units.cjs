/**
 * fix-gpu-vram-units.cjs (v3)
 * 
 * Normalizes GPU vram to NUMBER in GB.
 * - Numeric vram >= 512 = MB, divide by 1024
 * - Numeric vram < 512 = already GB, leave alone
 * - String vram "8GB" / "16G" / "8" = parse and convert
 */

const fs = require('fs');
const APPLY = process.argv.includes('--apply');

function parseVram(val) {
  if (val == null) return null;
  if (typeof val === 'number') {
    if (val < 512) return val;       // already GB
    return Math.round(val / 1024);   // MB -> GB
  }
  if (typeof val === 'string') {
    const m = val.match(/(\d+)\s*(GB|G|MB|M)?/i);
    if (!m) return null;
    const num = parseInt(m[1]);
    const unit = (m[2] || '').toUpperCase();
    if (unit === 'MB' || unit === 'M') return Math.round(num / 1024);
    return num; // GB or no unit (assume GB if small)
  }
  return null;
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...m.PARTS];

  let fixed = 0;
  let skipped = 0;
  const changes = [];

  for (const p of parts) {
    if (p.c !== 'GPU') continue;
    if (p.vram == null) continue;

    const newVal = parseVram(p.vram);
    if (newVal == null) { skipped++; continue; }
    if (newVal === p.vram) continue; // already correct

    changes.push({ id: p.id, from: JSON.stringify(p.vram), to: newVal, n: p.n.slice(0, 60) });
    if (APPLY) p.vram = newVal;
    fixed++;
  }

  console.log('Mode:', APPLY ? 'APPLY' : 'DRY RUN');
  console.log('VRAM normalized:', fixed);
  console.log('Skipped (unparseable):', skipped);
  console.log('\nFirst 15 changes:');
  changes.slice(0, 15).forEach(c => console.log('  [' + c.id + '] ' + c.from + ' -> ' + c.to + 'GB | ' + c.n));

  if (APPLY) {
    const header = '// Auto-merged catalog. Edit with care.\n';
    const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
    fs.writeFileSync('src/data/parts.js', header + body, 'utf8');
    console.log('\nApplied: ' + fixed + ' VRAM values normalized to GB (number)');
  }
})();
