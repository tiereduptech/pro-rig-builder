const fs = require('fs');
const s = fs.readFileSync('src/App.jsx', 'utf8');

// Find the css template literal
const start = s.indexOf('const css=`');
const end = s.indexOf('`;\n', start + 12);
const cssText = s.substring(start + 'const css=`'.length, end);

console.log('CSS template length:', cssText.length, 'chars');
console.log('Contains .wizard-row {:', cssText.includes('.wizard-row {'));
console.log('Contains .wizard-row-img {:', cssText.includes('.wizard-row-img {'));
console.log('Contains .wizard-row-info {:', cssText.includes('.wizard-row-info {'));

// Extract the wizard CSS section
const wzStart = cssText.indexOf('/* === MOBILE FIX: wizard ===');
const wzEnd = cssText.indexOf('/* === END MOBILE FIX: wizard ===');
if (wzStart > 0 && wzEnd > wzStart) {
  console.log('\n=== WIZARD CSS BLOCK ===');
  console.log(cssText.substring(wzStart, wzEnd + 35));
} else {
  console.log('\nWIZARD CSS BLOCK NOT FOUND in template');
}

// Check for unclosed braces in the wizard section
if (wzStart > 0 && wzEnd > wzStart) {
  const block = cssText.substring(wzStart, wzEnd);
  const opens = (block.match(/\{/g) || []).length;
  const closes = (block.match(/\}/g) || []).length;
  console.log('\nBraces balance: ' + opens + ' open, ' + closes + ' close');
  if (opens !== closes) console.log('  ⚠️ UNBALANCED BRACES');
}

// Check for any problematic chars
const problematic = cssText.match(/[`$\\]/g);
if (problematic) {
  console.log('\nFound ' + problematic.length + ' potentially problematic chars (backtick/$/backslash)');
}
