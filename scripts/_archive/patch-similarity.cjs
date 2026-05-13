const fs = require('fs');
let s = fs.readFileSync('fetch-newegg-via-rakuten.cjs', 'utf8');

// Find the function with regex (whitespace-tolerant)
const re = /function nameSimilarity\([\s\S]*?return inter \/ \(A\.size \+ B\.size - inter\);\s*\}/;
if (!re.test(s)) {
  if (s.includes('containment')) {
    console.log('Already patched');
  } else {
    console.log('✗ Function pattern not found');
    // Show whats around the function for debugging
    const idx = s.indexOf('nameSimilarity');
    if (idx >= 0) console.log(s.slice(idx, idx + 600));
  }
  process.exit(0);
}

const newFn = `function nameSimilarity(a, b) {
  const norm = (s) => new Set(
    String(s).toLowerCase().replace(/[^\\w\\s]/g, ' ').split(/\\s+/).filter((w) => w.length >= 2)
  );
  const A = norm(a), B = norm(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  if (inter < 3) return 0;
  const containment = inter / Math.min(A.size, B.size);
  const jaccard = inter / (A.size + B.size - inter);
  return Math.max(containment, jaccard);
}`;

s = s.replace(re, newFn);
fs.writeFileSync('fetch-newegg-via-rakuten.cjs', s);
console.log('✓ Patched');
