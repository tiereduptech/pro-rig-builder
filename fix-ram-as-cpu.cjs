/**
 * fix-ram-as-cpu.cjs
 * 
 * Finds RAM kits that are wrongly categorized as CPU.
 * Identifies them by DDR4/DDR5 + (kit | XxYGB pattern | no "processor"/"cpu" word).
 */

const fs = require('fs');
const APPLY = process.argv.includes('--apply');

function isRAM(title) {
  const t = (title || '').toLowerCase();
  // Must have DDR3/4/5
  if (!/\bddr[345]\b/i.test(t)) return false;
  // STRONG RAM signal: kit pattern "XGB (YxZGB)" = absolutely RAM
  if (/\b\d+\s*gb\s*\(\s*\d+\s*x\s*\d+\s*gb\s*\)/i.test(t)) return true;
  // STRONG RAM signal: contains "RAM" or "Memory Kit"
  if (/【\s*ddr\d/i.test(t)) return true;  // bracketed [DDR4 RAM] etc
  if (/\bdesktop\s+memory\b/i.test(t)) return true;
  if (/\bmemory\s+kit\b/i.test(t)) return true;
  if (/\bram\s+kit\b/i.test(t)) return true;
  // RAM brands strongly correlated
  if (/^(corsair\s+vengeance|g\.skill|kingston\s+fury|teamgroup|patriot|crucial\s+ballistix|gigastone\s+game)/i.test(t)) {
    if (/\b(kit|memory|dimm)\b/i.test(t)) return true;
  }
  // CPU keyword exit: if title has actual CPU words AND no kit pattern, it's a CPU
  if (/\b(processor|cpu|ryzen|core\s*i[3579]|core\s*ultra|threadripper)\b/i.test(t)) {
    return false;
  }
  // RAM keyword: yes
  if (/\b(dimm|sodimm|udimm)\b/i.test(t)) return true;
  return false;
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...m.PARTS];

  let fixed = 0;
  const changes = [];

  for (const p of parts) {
    if (p.needsReview) continue;
    if (p.c !== 'CPU') continue;
    if (isRAM(p.n)) {
      fixed++;
      if (changes.length < 20) changes.push('[' + p.id + '] ' + p.n.slice(0, 90));
      if (APPLY) {
        p.c = 'RAM';
        // Clear CPU-specific specs that don't apply
        delete p.cores;
        delete p.threads;
        delete p.socket;
        delete p.tdp;
        delete p.boostClock;
        delete p.igpu;
        delete p.vcache;
      }
    }
  }

  console.log('Mode:', APPLY ? 'APPLY' : 'DRY RUN');
  console.log('RAM products in CPU category:', fixed);
  console.log('\nWill move to RAM:');
  changes.forEach(c => console.log('  ' + c));

  if (APPLY) {
    const header = '// Auto-merged catalog. Edit with care.\n';
    const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
    fs.writeFileSync('src/data/parts.js', header + body, 'utf8');
    console.log('\nApplied: ' + fixed + ' products moved CPU -> RAM');
  }
})();
