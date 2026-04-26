// =============================================================================
//  audit-spec-coverage.cjs (v2 — correct field names)
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Reports per-field coverage for products. Field names verified against
//  actual parts.js schema (PSU.eff not .efficiency; Monitor.screenSize/res/
//  panel/refresh; etc.).
// =============================================================================

(async () => {
  const partsPath = require('path').resolve('src/data/parts.js');
  const url = 'file://' + partsPath.replace(/\\/g, '/') + '?t=' + Date.now();
  const mod = await import(url);
  const parts = mod.PARTS || mod.default || [];

  // Field names verified against actual parts.js sample objects.
  const CATEGORIES = {
    GPU:          ['bench', 'tdp', 'pcie', 'slots', 'baseClock', 'boostClock', 'vram', 'length', 'r', 'pr'],
    CPU:          ['bench', 'tdp', 'socket', 'cores', 'threads', 'baseClock', 'boostClock', 'memType', 'igpu', 'r', 'pr'],
    Motherboard:  ['socket', 'chipset', 'ff', 'memType', 'memSlots', 'm2Slots', 'sata', 'r', 'pr'],
    RAM:          ['ramType', 'cap', 'sticks', 'speed', 'cas', 'r', 'pr'],
    Storage:      ['cap', 'r', 'pr'],
    PSU:          ['watts', 'eff', 'modular', 'r', 'pr'],
    Case:         ['ff', 'r', 'pr'],
    CPUCooler:    ['height', 'fanSize', 'r', 'pr'],
    Monitor:      ['screenSize', 'res', 'refresh', 'panel', 'r', 'pr'],
  };

  const C = { reset: '\x1b[0m', dim: '\x1b[90m', good: '\x1b[92m', mid: '\x1b[93m', bad: '\x1b[91m' };
  function colorPct(have, total) {
    if (total === 0) return C.dim + '–' + C.reset;
    const p = (have / total) * 100;
    if (p >= 90) return C.good + Math.round(p) + '%' + C.reset;
    if (p >= 70) return C.mid + Math.round(p) + '%' + C.reset;
    return C.bad + Math.round(p) + '%' + C.reset;
  }

  console.log(`\n  Spec Coverage Audit — ${parts.length} total products\n`);

  for (const [cat, fields] of Object.entries(CATEGORIES)) {
    const inCat = parts.filter((p) => p.c === cat && !p.needsReview && !p.bundle);
    if (inCat.length === 0) continue;

    console.log(`  ${cat.padEnd(14)} ${C.dim}(${inCat.length} products)${C.reset}`);
    console.log('  ' + '─'.repeat(50));

    for (const field of fields) {
      const have = inCat.filter((p) => {
        const v = p[field];
        return v !== undefined && v !== null && v !== '' && v !== 0;
      }).length;
      const missing = inCat.length - have;
      const bar = colorPct(have, inCat.length);
      const indicator = missing > 0 ? `${C.dim}(${missing} missing)${C.reset}` : '';
      console.log(`    ${field.padEnd(14)} ${bar.padEnd(20)} ${indicator}`);
    }
    console.log('');
  }

  console.log('  Summary');
  console.log('  ' + '─'.repeat(50));
  let totalGaps = 0;
  for (const [cat, fields] of Object.entries(CATEGORIES)) {
    const inCat = parts.filter((p) => p.c === cat && !p.needsReview && !p.bundle);
    if (inCat.length === 0) continue;
    const gaps = fields.filter((f) => {
      const have = inCat.filter((p) => {
        const v = p[f];
        return v !== undefined && v !== null && v !== '' && v !== 0;
      }).length;
      return have / inCat.length < 0.9;
    });
    if (gaps.length > 0) {
      console.log(`    ${cat.padEnd(14)} ${C.mid}${gaps.length} field(s) below 90%${C.reset}: ${gaps.join(', ')}`);
      totalGaps += gaps.length;
    } else {
      console.log(`    ${cat.padEnd(14)} ${C.good}all fields ≥ 90%${C.reset}`);
    }
  }
  console.log('');
  if (totalGaps === 0) console.log(`  ${C.good}✓ All categories have full spec coverage${C.reset}\n`);
  else console.log(`  ${C.mid}${totalGaps} field gaps total across categories${C.reset}\n`);
})();
