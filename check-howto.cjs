const fs = require('fs');
const s = fs.readFileSync('src/App.jsx', 'utf8');

const tools = ['fps', 'bn', 'willitrun', 'buildcmp', 'wizard', 'power', 'cmp'];
console.log('Checking each tool definition for howTo array:\n');

for (const t of tools) {
  // Match: toolId: { ... howTo: ... }
  const re = new RegExp('\\b' + t + ':\\s*\\{[\\s\\S]{0,2500}?howTo\\s*:', 'm');
  const has = re.test(s);
  console.log('  ' + t.padEnd(12) + (has ? '✓ HAS howTo' : '✗ MISSING'));
}
