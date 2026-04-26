const fs = require('fs');
const p = 'bestbuy-discover-v2.js';
let s = fs.readFileSync(p, 'utf8');

const old = `    'sku', 'name', 'manufacturer', 'modelNumber', 'upc',
    'salePrice', 'regularPrice', 'onSale',
    'onlineAvailability', 'inStoreAvailability',
    'image', 'url',
    'details', 'features',
    'color', 'weight', 'depth', 'height', 'width',
    'categoryPath',`;

const neu = `    'sku', 'name', 'manufacturer', 'modelNumber', 'upc',
    'salePrice', 'regularPrice', 'onSale',
    'onlineAvailability', 'inStoreAvailability',
    'image', 'url',
    'details', 'features',
    'color', 'weight', 'depth', 'height', 'width',
    'categoryPath',
    'customerReviewAverage', 'customerReviewCount',`;

if (!s.includes(old)) { console.log('FATAL: anchor not found'); process.exit(1); }

s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('✓ Added review fields to bestbuy-discover-v2.js');
