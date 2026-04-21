#!/usr/bin/env node
/**
 * patch-browse-page-v2.js
 *
 * Fixed version: handles the case where the inline JSX spans multiple lines.
 * Finds the opening `if(!cat) return <div className="fade"...` line, then
 * walks forward tracking <div>/</div> depth until the block closes.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = './src/App.jsx';
let src = readFileSync(file, 'utf8');
const lines = src.split('\n');

// Step 1: Find the opening line
const startIdx = lines.findIndex(l => l.includes('if(!cat) return <div className="fade"'));
if (startIdx === -1) {
  console.log('❌ No-cat return line not found. Maybe already patched.');
  process.exit(1);
}

// Step 2: Walk forward tracking div depth until it returns to zero
// Start depth at 0; when we encounter the first <div (the fade one) depth becomes 1.
let depth = 0;
let endIdx = -1;

for (let i = startIdx; i < lines.length; i++) {
  const line = lines[i];
  // Count <div occurrences (not </div>) and </div> occurrences
  // Use regex that excludes self-closing
  const opens = (line.match(/<div[\s>]/g) || []).length;
  const closes = (line.match(/<\/div>/g) || []).length;
  depth += opens - closes;
  if (depth === 0 && i > startIdx) {
    // This line closes the outermost div
    endIdx = i;
    break;
  }
  // Special case: everything on one line (opens === closes, depth returns to 0 same line)
  if (depth === 0 && opens > 0 && closes > 0 && i === startIdx) {
    endIdx = i;
    break;
  }
}

if (endIdx === -1) {
  console.log('❌ Could not find matching </div>');
  process.exit(1);
}

console.log(`No-cat block spans lines ${startIdx + 1} to ${endIdx + 1} (${endIdx - startIdx + 1} lines)`);

// Step 3: Replace those lines with the single-line component call
const newLine = '  if(!cat) return <CategoryBrowse sel={sel} th={th} CATS={CATS} CAT={CAT} P={P} CatThumb={CatThumb}/>;';
lines.splice(startIdx, endIdx - startIdx + 1, newLine);

// Step 4: Add import if missing
if (!src.includes("from './CategoryBrowse")) {
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import\s.+\sfrom\s.+;/.test(lines[i])) lastImportIdx = i;
  }
  const importLine = "import { CategoryBrowse } from './CategoryBrowse.jsx';";
  if (lastImportIdx >= 0) {
    lines.splice(lastImportIdx + 1, 0, importLine);
    console.log(`Added import after line ${lastImportIdx + 1}`);
  } else {
    lines.unshift(importLine);
    console.log('Added import at top of file');
  }
} else {
  console.log('Import already present, skipping');
}

writeFileSync(file, lines.join('\n'));
console.log('\n✓ Wrote App.jsx');
