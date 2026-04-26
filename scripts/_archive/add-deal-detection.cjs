const fs = require('fs');

const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/\r\n/g, '\n');

// Strip prior version
if (s.includes('// === DEAL DETECTION ===')) {
  console.log('Stripping prior version');
  const start = s.indexOf('// === DEAL DETECTION ===');
  const end = s.indexOf('// === END DEAL DETECTION ===');
  if (start > 0 && end > start) {
    const endLine = s.indexOf('\n', end) + 1;
    s = s.substring(0, start) + s.substring(endLine);
  }
}

// PART A: Add deal-detection helpers right after the $ helper
const helperBlock = `// === DEAL DETECTION ===
// A product is "on deal" when bestPrice is meaningfully below MSRP.
// Threshold: at least $5 OR 3% off (whichever is bigger), to ignore micro-rounding.
const isDeal = p => {
  const cur = bestPrice(p);
  const ref = msrp(p);
  if (!ref || !cur || cur >= ref) return false;
  const savings = ref - cur;
  const pct = savings / ref;
  return savings >= 5 || pct >= 0.03;
};
// Savings amount (whole dollars), only meaningful if isDeal(p) is true
const dealSavings = p => {
  const cur = bestPrice(p);
  const ref = msrp(p);
  if (!ref || !cur || cur >= ref) return 0;
  return Math.round(ref - cur);
};
// === END DEAL DETECTION ===
`;

// Insert right after the $ helper line
const anchor = 'const $ = p => bestPrice(p);';
const idx = s.indexOf(anchor);
if (idx < 0) { console.log('$ helper not found'); process.exit(1); }
const insertAfter = s.indexOf('\n', idx) + 1;
// Also need to skip the msrp line which is on the next line
const msrpLine = 'const msrp = p => p.msrp || p.pr;';
const msrpIdx = s.indexOf(msrpLine);
const afterMsrp = s.indexOf('\n', msrpIdx) + 1;

s = s.substring(0, afterMsrp) + helperBlock + s.substring(afterMsrp);
console.log('✓ Inserted isDeal + dealSavings helpers');

// PART B: Replace ALL deal-flag display logic to use isDeal + dealSavings
// Pattern: {p.cp&&<Tag color="var(--amber)">-${p.off}</Tag>}
// New:    {isDeal(p)&&<Tag color="var(--amber)">-${dealSavings(p)}</Tag>}
const oldFlag = '{p.cp&&<Tag color="var(--amber)">-${p.off}</Tag>}';
const newFlag = '{isDeal(p)&&<Tag color="var(--amber)">-${dealSavings(p)}</Tag>}';
const cnt = s.split(oldFlag).length - 1;
if (cnt === 0) {
  console.log('WARN: deal flag pattern not found');
} else {
  while (s.includes(oldFlag)) s = s.replace(oldFlag, newFlag);
  console.log(`✓ Updated ${cnt} deal-flag display(s) to use isDeal/dealSavings`);
}

// Also update strikethrough MSRP rendering pattern: p.cp checks
// Pattern: (p.msrp&&p.msrp>$(p)||p.off>0)&&
const oldStrike = '(p.msrp&&p.msrp>$(p)||p.off>0)';
const newStrike = 'isDeal(p)';
const cntS = s.split(oldStrike).length - 1;
if (cntS > 0) {
  while (s.includes(oldStrike)) s = s.replace(oldStrike, newStrike);
  console.log(`✓ Updated ${cntS} strikethrough MSRP display(s)`);
}

fs.writeFileSync(p, s);
console.log('\nDONE');
