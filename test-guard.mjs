import { parseCapacityGB, capacitiesMatch, capacityCompatible, isPricePlausibleForCapacity } from './normalize-product-name.js';
let fail = 0;
const eq = (a, b, m) => { const ok = a === b; if (!ok) fail++; console.log((ok ? 'PASS' : 'FAIL') + '  ' + m + '  => ' + a); };
// transfer-rate must NOT be read as capacity
eq(parseCapacityGB('SATA III 6Gb/s 2.5 Inch 2TB SSD'), 2000, 'skip 6Gb/s, get 2TB');
eq(parseCapacityGB('6 Gb/s internal'), null, 'gigabit-only -> null');
eq(parseCapacityGB('990 PRO Up to 7450 MB/s 2TB'), 2000, 'skip MB/s, get 2TB');
eq(parseCapacityGB('Read 14,800MB/s 8TB'), 8000, 'skip MB/s get 8TB');
// core capacity cases still hold
eq(parseCapacityGB('2TB 2.5 SSD SATA III'), 2000, '2TB name');
eq(parseCapacityGB('KingSpec 128GB SSD'), 128, '128GB');
eq(parseCapacityGB('16GB DDR5 RAM'), 16, 'RAM 16GB unaffected');
eq(capacitiesMatch(500, 512), true, '500~512');
eq(capacitiesMatch(1920, 2000), true, '1920~2000');
eq(capacitiesMatch(128, 2000), false, '128 vs 2000');
eq(capacityCompatible(null, 2000), true, 'null -> no block');
eq(isPricePlausibleForCapacity(13.99, 2000, { isHDD: false }), false, 'T7 2TB @ $13.99 impossible');
console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
