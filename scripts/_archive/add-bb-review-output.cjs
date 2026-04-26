const fs = require('fs');
const p = 'bestbuy-discover-v2.js';
let s = fs.readFileSync(p, 'utf8');

const old = `    onSale: product.onSale === true,`;
const neu = `    onSale: product.onSale === true,
    rating: product.customerReviewAverage ? parseFloat(product.customerReviewAverage) : null,
    reviews: product.customerReviewCount || 0,`;

if (!s.includes(old)) { console.log('FATAL: anchor not found'); process.exit(1); }

// Make sure we don't double-insert
if (s.includes('rating: product.customerReviewAverage')) {
  console.log('Already patched');
  process.exit(0);
}

s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('✓ Added rating/reviews fields to transform output');
