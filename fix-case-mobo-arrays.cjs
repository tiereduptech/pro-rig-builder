const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';
let s = fs.readFileSync(PARTS_PATH, 'utf8');

// Convert "mobo": "ATX,mATX,ITX" → "mobo": ["ATX","mATX","ITX"]
const before = s.length;
let count = 0;

// Match `"mobo": "comma,separated,list"` (multi-value)
s = s.replace(/"mobo":\s*"([^"]+)"/g, (match, value) => {
  const arr = value.split(',').map(v => '"' + v.trim() + '"');
  count++;
  return '"mobo": [' + arr.join(',') + ']';
});

console.log('Converted ' + count + ' mobo strings to arrays');

// Also need to convert rads strings to arrays (rads:"360,280,240" → rads:[360,280,240])
let radsCount = 0;
s = s.replace(/"rads":\s*"([^"]+)"/g, (match, value) => {
  const arr = value.split(',').map(v => parseInt(v.trim())).filter(n => !isNaN(n));
  radsCount++;
  return '"rads": [' + arr.join(',') + ']';
});
console.log('Converted ' + radsCount + ' rads strings to numeric arrays');

fs.writeFileSync(PARTS_PATH, s);
console.log('✓ Fixed. App.jsx case rendering should work now.');
