const fs = require('fs');

const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/\r\n/g, '\n');

// Check idempotent
if (s.includes('function resolveBrand(')) {
  console.log('Already patched - strip old and re-insert');
  const start = s.indexOf('/* === BRAND RESOLVER ===');
  const end = s.indexOf('/* === END BRAND RESOLVER ===');
  if (start > 0 && end > start) {
    const endLine = s.indexOf('\n', end) + 1;
    s = s.substring(0, start) + s.substring(endLine);
  }
}

// ============================================================
// PART A: Insert the brand resolver function
// ============================================================
const helper = `/* === BRAND RESOLVER === */
// For CPUs, derives real CPU brand (Intel/AMD) from product name
// even when seller brand (b field) is something like "Micro Center" or "INLAND"
function resolveBrand(p) {
  if (!p) return '';
  if (p.c !== 'CPU') return p.b || '';
  // If already Intel or AMD, use it
  if (p.b === 'Intel' || p.b === 'AMD') return p.b;
  // Parse name for CPU brand markers
  const n = (p.n || '').toLowerCase();
  if (/\\bintel\\b|\\bcore\\s*(ultra\\s*)?i[3579]|\\bxeon\\b|\\bpentium\\b|\\bceleron\\b/i.test(n)) return 'Intel';
  if (/\\bamd\\b|\\bryzen\\b|\\bthreadripper\\b|\\bepyc\\b|\\bathlon\\b/i.test(n)) return 'AMD';
  return p.b || '';
}
/* === END BRAND RESOLVER === */

`;

// Insert right before the first function that uses it
const insertBefore = '/* === CATEGORY GUIDES === */';
const idx = s.indexOf(insertBefore);
if (idx < 0) { console.log('CATEGORY_GUIDES anchor not found'); process.exit(1); }
s = s.substring(0, idx) + helper + s.substring(idx);
console.log('✓ Inserted resolveBrand helper');

// ============================================================
// PART B: SearchPage - update brand list AND filter predicate
// ============================================================

// In SearchPage (line ~2270), the brand list:
// const allBr=[...new Set(catP.map(p=>p.b))].sort();
// Replace with resolveBrand lookup
const oldAllBr = 'const allBr=[...new Set(catP.map(p=>p.b))].sort();';
const newAllBr = 'const allBr=[...new Set(catP.map(p=>resolveBrand(p)).filter(Boolean))].sort();';
const allBrCount = (s.split(oldAllBr).length - 1);
if (allBrCount > 0) {
  while (s.includes(oldAllBr)) {
    s = s.replace(oldAllBr, newAllBr);
  }
  console.log(`✓ Updated ${allBrCount} brand-list(s) to use resolveBrand`);
}

// Same for MobileSearchPage (same exact line), and also BuilerPartPicker / MobileBuilerPartPicker
const oldAllBr2 = 'const allBr=[...new Set(compatList.map(p=>p.b))].sort();';
const newAllBr2 = 'const allBr=[...new Set(compatList.map(p=>resolveBrand(p)).filter(Boolean))].sort();';
const allBr2Count = (s.split(oldAllBr2).length - 1);
if (allBr2Count > 0) {
  while (s.includes(oldAllBr2)) {
    s = s.replace(oldAllBr2, newAllBr2);
  }
  console.log(`✓ Updated ${allBr2Count} compatList brand-list(s) to use resolveBrand`);
}

// ============================================================
// PART C: Update filter predicates to use resolveBrand
// ============================================================

// SearchPage filter: if(brands.length)r=r.filter(p=>brands.includes(p.b));
const oldFilter1 = 'if(brands.length)r=r.filter(p=>brands.includes(p.b));';
const newFilter1 = 'if(brands.length)r=r.filter(p=>brands.includes(resolveBrand(p)));';
const f1Count = (s.split(oldFilter1).length - 1);
if (f1Count > 0) {
  while (s.includes(oldFilter1)) s = s.replace(oldFilter1, newFilter1);
  console.log(`✓ Updated ${f1Count} SearchPage brand filter(s)`);
}

// BuilerPartPicker filter: if(brands.length&&!brands.includes(p.b))return false;
const oldFilter2 = 'if(brands.length&&!brands.includes(p.b))return false;';
const newFilter2 = 'if(brands.length&&!brands.includes(resolveBrand(p)))return false;';
const f2Count = (s.split(oldFilter2).length - 1);
if (f2Count > 0) {
  while (s.includes(oldFilter2)) s = s.replace(oldFilter2, newFilter2);
  console.log(`✓ Updated ${f2Count} BuilerPartPicker brand filter(s)`);
}

// ============================================================
// PART D: Also fix the brand count displays (catP.filter(p=>p.b===b))
// ============================================================
// Multiple patterns exist. Replace them all.
const patterns = [
  { old: 'catP.filter(p=>p.b===b).length', new: 'catP.filter(p=>resolveBrand(p)===b).length' },
  { old: 'compatList.filter(p=>p.b===b).length', new: 'compatList.filter(p=>resolveBrand(p)===b).length' },
];
for (const pat of patterns) {
  const c = (s.split(pat.old).length - 1);
  if (c > 0) {
    while (s.includes(pat.old)) s = s.replace(pat.old, pat.new);
    console.log(`✓ Updated ${c} brand-count expression(s): ${pat.old.slice(0, 40)}...`);
  }
}

fs.writeFileSync(p, s);
console.log('\nDONE');
