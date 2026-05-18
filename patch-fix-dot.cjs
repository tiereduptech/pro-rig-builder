const fs = require('fs');
const path = 'src/App.jsx';
let src = fs.readFileSync(path, 'utf8');

const oldStr = '{avg.toFixed(1)} \\u00b7 {reviews.length} review';
const newStr = '{avg.toFixed(1)} {"\\u00b7"} {reviews.length} review';

const count = src.split(oldStr).length - 1;
if (count !== 1) {
  console.log('FAIL: expected exactly 1 match, found ' + count);
  process.exit(1);
}
src = src.replace(oldStr, newStr);
fs.writeFileSync(path, src, 'utf8');
console.log('✓ Fixed: literal "\\u00b7" -> {"\\u00b7"} (renders as ·) in reviews count line.');
