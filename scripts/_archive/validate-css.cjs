const fs = require('fs');
const s = fs.readFileSync('src/App.jsx', 'utf8');

const start = s.indexOf('const css=`') + 'const css=`'.length;
const end = s.indexOf('`;', start);
const cssText = s.substring(start, end);

console.log('Total CSS length:', cssText.length);

// Walk through and track brace balance
let depth = 0;
let lineNum = 1;
let lastOpenLine = 0;

const lines = cssText.split('\n');
let issueFound = false;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  for (const ch of line) {
    if (ch === '{') {
      depth++;
      lastOpenLine = i + 1;
    } else if (ch === '}') {
      depth--;
      if (depth < 0) {
        console.log(`Line ${i+1}: extra closing brace! "${line.trim()}"`);
        issueFound = true;
      }
    }
  }
}

console.log('Final depth:', depth, '(should be 0)');
if (depth !== 0) {
  console.log('Last open brace line in template:', lastOpenLine);
  console.log('Line at that position:', lines[lastOpenLine - 1]);
}

// Look for common CSS errors
console.log('\n=== Possible issues ===');
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // Missing semicolon before } 
  if (line.includes(':') && !line.trim().endsWith(';') && !line.trim().endsWith('{') && !line.trim().endsWith('}') && !line.trim().endsWith(',') && !line.trim().endsWith('*/') && !line.trim().endsWith('/*') && line.trim() && !line.trim().startsWith('//') && !line.trim().startsWith('@')) {
    // Skip lines that are part of selectors (no colon-value pattern)
    const trimmed = line.trim();
    if (/^[a-z\-]+\s*:\s*[^;{}]+$/i.test(trimmed)) {
      console.log(`Line ${i+1}: possible missing semicolon: "${trimmed}"`);
      issueFound = true;
    }
  }
}

if (!issueFound) console.log('  No obvious syntax issues found');
