// check-seo-state.cjs — confirms current state from SEO handoff
const fs = require('fs');
const s = fs.readFileSync('src/App.jsx', 'utf8');

const checks = [
  ['SearchPage with singleProductId param', s.includes('function SearchPage({activeCat,initialQuery,th,singleProductId})')],
  ['/parts/ route detection', s.includes('/parts/')],
  ['ProductSchema component exists', s.includes('function ProductSchema')],
  ['PageMeta receives product prop somewhere', /<PageMeta[^>]*product=/.test(s)],
  ['ProductPage still referenced', s.includes('ProductPage')],
];

console.log('Current state checks:\n');
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'OK' : 'X '}  ${name}`);
}

const sigCount = (s.match(/function SearchPage\(/g) || []).length;
console.log(`\nSearchPage function declarations: ${sigCount} (should be 1)`);

const mobileSigCount = (s.match(/function MobileSearchPage\(/g) || []).length;
console.log(`MobileSearchPage function declarations: ${mobileSigCount} (should be 1)`);

console.log('\nSEO-related files:');
const files = ['src/ProductPage.jsx', 'scripts/generate-sitemap.cjs', 'prerender.cjs', 'src/PageMeta.jsx'];
for (const f of files) {
  console.log(`  ${fs.existsSync(f) ? 'EXISTS' : 'MISSING'}  ${f}`);
}
