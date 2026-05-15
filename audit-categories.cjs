/**
 * audit-categories.cjs
 * 
 * Detects products that are in the WRONG category based on title content.
 * Reports them; can optionally move to correct category or quarantine.
 */

const fs = require('fs');
const APPLY = process.argv.includes('--apply');
const MOVE = process.argv.includes('--move'); // if true, move to detected cat; else quarantine

function detectCorrectCategory(title) {
  const t = (title || '').toLowerCase();
  // Most specific patterns first

  // RAM (DDR4/DDR5 kits)
  if (/\bddr[345]\b/i.test(t) && /\b(ram|memory|kit|dimm|sodimm|udimm)\b/i.test(t)) return 'RAM';
  if (/\b\d+gb\s*\(\d+\s*x\s*\d+gb\)/i.test(t)) return 'RAM';

  // Laptops (reject — quarantine)
  if (/\b(laptop|notebook|ideapad|latitude|ideacentre|inspiron|thinkpad|macbook|envy\s)/i.test(t)) return 'LAPTOP-EXCLUDE';
  if (/\bhp\s+\d+\.\d+["\s]?(hd|fhd)\s*display/i.test(t)) return 'LAPTOP-EXCLUDE'; // "HP 15.6 HD Display..."
  if (/\b(touchscreen|touch\s*screen)\s+(laptop|business)/i.test(t)) return 'LAPTOP-EXCLUDE';

  // Prebuilts
  if (/\b(gaming pc|prebuilt|pre[\-\s]?built|tower pc|mini pc|desktop computer)\b/i.test(t)) return 'PREBUILT-EXCLUDE';

  // GPU (have RTX/GTX/Radeon RX/Arc + graphics card)
  if (/\b(rtx|gtx)\s*\d{3,4}/i.test(t) && /\b(graphics|video|card|gpu)\b/i.test(t)) return 'GPU';
  if (/\bradeon\s+rx\s*\d{3,4}/i.test(t) && /\b(graphics|video|card|gpu)\b/i.test(t)) return 'GPU';
  if (/\barc\s+[ab]\d{3}\b/i.test(t)) return 'GPU';

  // CPU (real CPUs only - not RAM kits mentioning AMD/Intel)
  if (/\b(ryzen|threadripper|epyc)\s+[3579]?\s*\d{4,5}/i.test(t) && /\b(processor|cpu|core)\b/i.test(t)) return 'CPU';
  if (/\bcore\s*(ultra|i[3579])[\s\-]?\d{4,5}/i.test(t) && /\b(processor|cpu|desktop)\b/i.test(t)) return 'CPU';

  // Motherboard
  if (/\b(motherboard|mainboard|mobo)\b/i.test(t)) return 'Motherboard';
  if (/\b[XBHAZ]\d{3,4}E?\s+(mainboard|motherboard|mobo)/i.test(t)) return 'Motherboard';

  // Storage
  if (/\bnvme\s*ssd\b|\bssd\s*nvme\b|\bm\.?2\s*ssd\b/i.test(t)) return 'Storage';
  if (/\binternal\s+(ssd|hdd|hard\s*drive)/i.test(t)) return 'Storage';
  if (/\b(hard\s*disk|hard\s*drive|hdd)\b/i.test(t) && /\b(internal|7200|5400|rpm)/i.test(t)) return 'Storage';

  // PSU
  if (/\bpower\s+supply\b/i.test(t)) return 'PSU';
  if (/\bpsu\b.*\d{3,4}\s*w\b/i.test(t)) return 'PSU';

  // Case
  if (/\b(pc|computer)\s+case\b/i.test(t)) return 'Case';
  if (/\b(mid|full|mini)[\s\-]?tower\s+(case|chassis|pc)/i.test(t)) return 'Case';

  // CPU Cooler
  if (/\bcpu\s+(cooler|fan|cooling)\b/i.test(t)) return 'CPUCooler';
  if (/\baio\s+(cooler|liquid)/i.test(t)) return 'CPUCooler';
  if (/\b\d{3}\s*mm\s+(radiator|aio)\b/i.test(t)) return 'CPUCooler';

  // Case Fan
  if (/\b(case\s+fan|chassis\s+fan)\b/i.test(t) && /\d+\s*pack/i.test(t)) return 'CaseFan';
  if (/\b(120|140|200)\s*mm\s+fan\b/i.test(t) && /\b(pwm|argb|rgb|pack)/i.test(t)) return 'CaseFan';

  // Monitor
  if (/\b\d{2,3}["\s\-]?inch\b.*\b(monitor|display)/i.test(t)) return 'Monitor';
  if (/\b(monitor|display).*(\d{2,3}["\s\-]?inch)/i.test(t)) return 'Monitor';

  return null;
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...m.PARTS];

  const stats = {
    moved: {},
    excluded: 0,
    correct: 0,
    unknown: 0,
  };
  const samples = { moved: {}, excluded: [] };
  let totalChanges = 0;

  for (const p of parts) {
    if (p.needsReview) continue;
    const detected = detectCorrectCategory(p.n);

    if (!detected) { stats.unknown++; continue; }

    if (detected === 'LAPTOP-EXCLUDE' || detected === 'PREBUILT-EXCLUDE') {
      // Always quarantine these
      stats.excluded++;
      if (samples.excluded.length < 10) samples.excluded.push('[' + p.c + '][' + p.id + '] ' + p.n.slice(0, 85));
      if (APPLY) p.needsReview = true;
      totalChanges++;
      continue;
    }

    if (detected === p.c) { stats.correct++; continue; }

    // Wrong category!
    const key = p.c + '->' + detected;
    stats.moved[key] = (stats.moved[key] || 0) + 1;
    samples.moved[key] = samples.moved[key] || [];
    if (samples.moved[key].length < 5) samples.moved[key].push('[' + p.id + '] ' + p.n.slice(0, 85));

    if (APPLY) {
      if (MOVE) {
        p.c = detected;
      } else {
        p.needsReview = true; // quarantine, don't move
      }
    }
    totalChanges++;
  }

  console.log('Mode:', APPLY ? 'APPLY' : 'DRY RUN');
  console.log('Action:', MOVE ? 'MOVE to correct cat' : 'QUARANTINE wrong-cat products');
  console.log('\n--- AUDIT RESULTS ---');
  console.log('In correct cat:', stats.correct);
  console.log('Cat unknown (no rule fired):', stats.unknown);
  console.log('Wrong cat (will change):', Object.values(stats.moved).reduce((a,b)=>a+b,0));
  console.log('Laptops/prebuilts (quarantine):', stats.excluded);

  console.log('\nMoves needed:');
  Object.entries(stats.moved).sort((a,b)=>b[1]-a[1]).forEach(([k,n]) => {
    console.log('\n  ' + k + ': ' + n);
    samples.moved[k].forEach(s => console.log('    ' + s));
  });
  console.log('\nLaptops/prebuilts (first 10):');
  samples.excluded.forEach(s => console.log('  ' + s));

  if (APPLY) {
    const header = '// Auto-merged catalog. Edit with care.\n';
    const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
    fs.writeFileSync('src/data/parts.js', header + body, 'utf8');
    console.log('\nApplied: ' + totalChanges + ' products affected.');
  }
})();
