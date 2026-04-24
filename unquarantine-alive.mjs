// Read alive-ids.json and remove needsReview + bundle flags for those products
import fs from 'node:fs';

const aliveIds = JSON.parse(fs.readFileSync('alive-ids.json', 'utf8'));
console.log('Unquarantining ' + aliveIds.length + ' products...');

const PARTS_PATH = 'src/data/parts.js';
let s = fs.readFileSync(PARTS_PATH, 'utf8');

let patched = 0;
const missed = [];

for (const id of aliveIds) {
  // Find the product object. Format: "id": 12345,
  const marker = `"id": ${id},`;
  const idx = s.indexOf(marker);
  if (idx < 0) {
    missed.push(id);
    continue;
  }

  // Find the object bounds. Start at the '{' before this marker, walk to matching '}'.
  const objStart = s.lastIndexOf('{', idx);
  let depth = 0;
  let objEnd = -1;
  for (let i = objStart; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) { objEnd = i; break; }
    }
  }
  if (objEnd < 0) {
    missed.push(id);
    continue;
  }

  // Extract the object text, remove needsReview/bundle/quarantinedAt fields (only if present)
  const before = s.substring(0, objStart);
  let objText = s.substring(objStart, objEnd + 1);
  const after = s.substring(objEnd + 1);

  const originalLen = objText.length;

  // Remove `"needsReview": true,` with surrounding whitespace
  objText = objText.replace(/,?\s*"needsReview":\s*true\s*,?/g, (match) => {
    // Keep any leading or trailing comma context — replace with single comma if match has one on each side
    if (match.startsWith(',') && match.endsWith(',')) return ',';
    return '';
  });
  objText = objText.replace(/,?\s*"bundle":\s*true\s*,?/g, (match) => {
    if (match.startsWith(',') && match.endsWith(',')) return ',';
    return '';
  });
  objText = objText.replace(/,?\s*"quarantinedAt":\s*"[^"]*"\s*,?/g, (match) => {
    if (match.startsWith(',') && match.endsWith(',')) return ',';
    return '';
  });

  // Clean up any accidental double commas or comma-before-closing-brace
  objText = objText.replace(/,\s*,/g, ',');
  objText = objText.replace(/,\s*}/g, '\n  }');

  s = before + objText + after;
  patched++;
}

if (missed.length > 0) {
  console.log('MISSED IDs:', missed);
}

fs.writeFileSync(PARTS_PATH, s);
console.log('Patched: ' + patched);
console.log('\nNow run: npm run build');
