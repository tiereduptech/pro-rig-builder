// remove-internal-lcd-category.cjs
// InternalLCD is duplicate of InternalDisplay - removes all references

const fs = require('fs');
const PATH = 'src/App.jsx';
let s = fs.readFileSync(PATH, 'utf8');
let removed = 0;

// 1. Remove the category definition (line 48 area)
const def = `  InternalLCD:{icon:"📺",label:"Internal LCDs",singular:"Internal LCD",desc:"Case-mounted monitoring screens",cols:[]},\n`;
if (s.includes(def)) { s = s.replace(def, ''); removed++; console.log('✓ Removed CATALOGS definition'); }

// 2. Remove from EXPANSION_CATS array
s = s.replace(`,"InternalLCD"`, '');
console.log('✓ Removed from EXPANSION_CATS');

// 3. Remove the icon entry
s = s.replace(`  InternalLCD: null, // no product image available\n`, '');
console.log('✓ Removed from category icon mapping');

// 4. Remove the buyer guide entry around line 2482
// Find "InternalLCD: {" and remove the whole object
const guideStart = s.indexOf('InternalLCD: {');
if (guideStart > 0) {
  // Find the start of the line (look back for previous newline)
  let lineStart = guideStart;
  while (lineStart > 0 && s[lineStart - 1] !== '\n') lineStart--;

  // Find matching closing brace + comma
  let pos = guideStart + 'InternalLCD: {'.length;
  let depth = 1;
  while (pos < s.length && depth > 0) {
    if (s[pos] === '{') depth++;
    else if (s[pos] === '}') depth--;
    if (depth === 0) break;
    pos++;
  }
  pos++; // past the closing }
  // Eat trailing comma + whitespace + newline
  while (pos < s.length && (s[pos] === ',' || /\s/.test(s[pos]))) {
    if (s[pos] === '\n') { pos++; break; }
    pos++;
  }

  const before = s.substring(0, lineStart);
  const after = s.substring(pos);
  s = before + after;
  console.log('✓ Removed buyer guide entry');
}

fs.writeFileSync(PATH, s);
console.log('\nDone. Run npm run build');
