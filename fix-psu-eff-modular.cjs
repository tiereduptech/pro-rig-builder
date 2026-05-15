/**
 * fix-psu-eff-modular.cjs
 * 
 * Re-extracts efficiency and modularity for ALL PSU products in catalog
 * using title patterns that handle trademark symbols.
 */

const fs = require('fs');
const APPLY = process.argv.includes('--apply');

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...m.PARTS];

  let effFixed = 0, modFixed = 0;
  const psus = parts.filter(p => p.c === 'PSU');
  console.log('Total PSUs:', psus.length);

  for (const p of psus) {
    // Strip trademark symbols first
    const title = (p.n || '').replace(/[™®©]/g, ' ');

    // Efficiency
    if (!p.eff) {
      let eff = null;
      if (/80\s*\+?\s*(plus\s*)?titanium/i.test(title)) eff = '80+ Titanium';
      else if (/80\s*\+?\s*(plus\s*)?platinum/i.test(title)) eff = '80+ Platinum';
      else if (/80\s*\+?\s*(plus\s*)?gold/i.test(title)) eff = '80+ Gold';
      else if (/80\s*\+?\s*(plus\s*)?silver/i.test(title)) eff = '80+ Silver';
      else if (/80\s*\+?\s*(plus\s*)?bronze/i.test(title)) eff = '80+ Bronze';
      else if (/80\s*\+?\s*(plus\s*)?white/i.test(title)) eff = '80+ White';
      if (eff) {
        if (APPLY) p.eff = eff;
        effFixed++;
      }
    }

    // Modularity
    if (!p.modular) {
      let mod = null;
      if (/fully\s*modular/i.test(title)) mod = 'Full';
      else if (/semi[\s\-]?modular/i.test(title)) mod = 'Semi';
      else if (/non[\s\-]?modular/i.test(title)) mod = 'None';
      else if (/modular/i.test(title) && !p.modular) mod = 'Full'; // assume "modular" alone = full
      if (mod) {
        if (APPLY) p.modular = mod;
        modFixed++;
      }
    }
  }

  console.log('Mode:', APPLY ? 'APPLY' : 'DRY RUN');
  console.log('Efficiency filled:', effFixed);
  console.log('Modularity filled:', modFixed);

  if (APPLY) {
    const header = '// Auto-merged catalog. Edit with care.\n';
    const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
    fs.writeFileSync('src/data/parts.js', header + body, 'utf8');
    console.log('\nApplied.');
  }
})();
