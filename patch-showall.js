#!/usr/bin/env node
/**
 * patch-showall.js — add showAll state to SearchPage component in App.jsx.
 * Uses indexOf for reliability (regex was failing on line endings).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const path = './src/App.jsx';
let src = readFileSync(path, 'utf8');

// Check if already patched
if (src.includes('setShowAll')) {
  console.log('Already patched — setShowAll already exists in file.');
  process.exit(0);
}

// Find the FIRST occurrence of the expanded state line.
// This belongs to SearchPage. The second one (line ~903) belongs to BuilderPicker — we don't need it there.
const searchStr = 'const [expanded,setExpanded]=useState(null);';
const idx = src.indexOf(searchStr);
if (idx === -1) {
  console.error('✗ Could not find expanded state line');
  process.exit(1);
}

// Insert the showAll state on the next line
const endOfLine = idx + searchStr.length;
const insertion = '\n  const [showAll,setShowAll]=useState({});';
src = src.slice(0, endOfLine) + insertion + src.slice(endOfLine);

writeFileSync(path, src);
console.log('✓ Added showAll state at index', idx + searchStr.length);
console.log('\nVerify with: findstr /N /I "showAll" src\\App.jsx');
