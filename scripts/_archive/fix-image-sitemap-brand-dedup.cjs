// =============================================================================
//  fix-image-sitemap-brand-dedup.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Patches generate-image-sitemap.cjs to skip the brand prefix when the
//  product name already contains it. "AMD AMD Ryzen 9 9950X" → "AMD Ryzen 9
//  9950X". Mirrors the logic already in PageMeta.jsx.
// =============================================================================

const fs = require('fs');

const FILE = 'generate-image-sitemap.cjs';
let src = fs.readFileSync(FILE, 'utf8');

const old = `    const title = \`\${p.b || ''} \${p.n || ''}\`.trim() || p.n || 'PC Part';`;
const next = `    // Match PageMeta logic: only prefix brand when the name doesn't already include it.
    const name = p.n || 'PC Part';
    const brand = p.b || '';
    const title = brand && !name.toLowerCase().includes(brand.toLowerCase())
      ? \`\${brand} \${name}\`
      : name;`;

if (!src.includes(old)) {
  console.log('  – Title line not found (already patched or different code).');
  process.exit(0);
}

src = src.replace(old, next);
fs.writeFileSync(FILE, src, 'utf8');
console.log('  ✓ Patched title de-dup logic in generate-image-sitemap.cjs');
console.log('    Re-run: node generate-image-sitemap.cjs');
