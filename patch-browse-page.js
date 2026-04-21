#!/usr/bin/env node
/**
 * patch-browse-page.js
 *
 * Replaces the inline "no category selected" view in App.jsx with a call
 * to the new CategoryBrowse component.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = './src/App.jsx';
let src = readFileSync(file, 'utf8');
const lines = src.split('\n');

// Step 1: Find and replace the no-cat return line
const startIdx = lines.findIndex(l => l.includes('if(!cat) return <div className="fade"'));
if (startIdx === -1) {
  console.log('❌ No-cat return line not found. Maybe already patched.');
  process.exit(1);
}

const oldLine = lines[startIdx];
console.log(`Found no-cat block at line ${startIdx + 1}`);
console.log(`  Original length: ${oldLine.length} chars`);

lines[startIdx] = '  if(!cat) return <CategoryBrowse sel={sel} th={th} CATS={CATS} CAT={CAT} P={P} CatThumb={CatThumb}/>;';
console.log(`  New length:      ${lines[startIdx].length} chars`);

// Step 2: Add the import if not already present
if (!src.includes("from './CategoryBrowse")) {
  // Find the last `import ... from ...;` line
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
console.log('\nNext: copy src/CategoryBrowse.jsx into the project, then run `npm run dev` to verify.');
