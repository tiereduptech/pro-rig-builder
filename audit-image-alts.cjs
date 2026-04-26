// =============================================================================
//  audit-image-alts.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Scans every <img> tag in JSX and reports:
//    - Line number + filename
//    - alt attribute (literal string OR JS expression)
//    - Surrounding context (so we can tell if it's a product, icon, hero, etc.)
//    - Quality score: good / generic / dynamic / missing
//
//  Use this BEFORE writing fixes — we want to know what we're dealing with.
// =============================================================================

const fs = require('fs');
const path = require('path');

const FILES = ['src/App.jsx', 'src/UpgradePage.jsx', 'src/PageMeta.jsx'];

const GENERIC_WORDS = new Set([
  '', 'image', 'img', 'icon', 'logo', 'photo', 'picture', 'thumbnail', 'thumb',
  'storage', 'gpu', 'cpu', 'ram', 'psu', 'case', 'motherboard', 'monitor',
]);

// Extract the value of a single attribute from an <img> tag.
function getAttr(tag, name) {
  // String form: alt="value" or alt='value'
  const strRe = new RegExp(`${name}=(["'])([^"']*)\\1`, 'i');
  const strMatch = tag.match(strRe);
  if (strMatch) return { kind: 'string', value: strMatch[2] };
  // JSX form: alt={expression}
  const jsxRe = new RegExp(`${name}=\\{([^}]+)\\}`, 'i');
  const jsxMatch = tag.match(jsxRe);
  if (jsxMatch) return { kind: 'jsx', value: jsxMatch[1].trim() };
  return null;
}

function classify(alt) {
  if (!alt) return { tag: 'MISSING', color: '\x1b[91m' };
  if (alt.kind === 'jsx') {
    // JSX expression — assume dynamic, decent unless it's a literal hardcode in there.
    if (/^["'][^"']*["']$/.test(alt.value)) {
      // Effectively a hardcoded string inside braces.
      const literal = alt.value.replace(/^["']|["']$/g, '');
      return classify({ kind: 'string', value: literal });
    }
    return { tag: 'DYNAMIC', color: '\x1b[94m', detail: alt.value };
  }
  const v = (alt.value || '').toLowerCase().trim();
  if (!v) return { tag: 'EMPTY', color: '\x1b[91m' };
  if (GENERIC_WORDS.has(v) || v.split(/\s+/).every((w) => GENERIC_WORDS.has(w))) {
    return { tag: 'GENERIC', color: '\x1b[93m' };
  }
  if (v.split(/\s+/).length >= 3) return { tag: 'GOOD', color: '\x1b[92m' };
  return { tag: 'SHORT', color: '\x1b[93m' };
}

const C = { reset: '\x1b[0m', dim: '\x1b[90m' };
const summary = { GOOD: 0, DYNAMIC: 0, SHORT: 0, GENERIC: 0, EMPTY: 0, MISSING: 0 };
const findings = [];

for (const file of FILES) {
  const full = path.join(file);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, 'utf8');
  const lines = text.split('\n');

  // Match <img ... /> across lines (non-greedy).
  const tagRe = /<img\b[^>]*?\/?>/gs;
  let m;
  while ((m = tagRe.exec(text)) !== null) {
    const tag = m[0];
    const start = text.lastIndexOf('\n', m.index) + 1;
    const lineNum = text.slice(0, m.index).split('\n').length;
    const alt = getAttr(tag, 'alt');
    const src = getAttr(tag, 'src');
    const cls = classify(alt);
    summary[cls.tag] = (summary[cls.tag] || 0) + 1;
    findings.push({
      file, lineNum, tag: tag.replace(/\s+/g, ' '), alt, src,
      classification: cls,
    });
  }
}

// Output
console.log('\n  Image Alt-Text Audit');
console.log('  ' + '─'.repeat(60));
const total = findings.length;
console.log(`  ${total} <img> tags scanned across ${FILES.length} files`);
console.log(`  Distribution:`);
const order = ['GOOD', 'DYNAMIC', 'SHORT', 'GENERIC', 'EMPTY', 'MISSING'];
for (const k of order) {
  if (!summary[k]) continue;
  const cls = classify(k === 'MISSING' ? null : { kind: 'string', value: k.toLowerCase() });
  // Use the canonical color for each tag.
  const colorMap = { GOOD: '\x1b[92m', DYNAMIC: '\x1b[94m', SHORT: '\x1b[93m', GENERIC: '\x1b[93m', EMPTY: '\x1b[91m', MISSING: '\x1b[91m' };
  console.log(`    ${colorMap[k]}● ${k.padEnd(8)}${C.reset} ${summary[k]}`);
}
console.log('  ' + '─'.repeat(60) + '\n');

for (const f of findings) {
  const c = f.classification;
  console.log(`  ${c.color}[${c.tag}]${C.reset} ${f.file}:${f.lineNum}`);
  if (f.alt) {
    if (f.alt.kind === 'string') console.log(`    ${C.dim}alt="${f.alt.value}"${C.reset}`);
    else console.log(`    ${C.dim}alt={${f.alt.value}}${C.reset}`);
  } else {
    console.log(`    ${C.dim}(no alt attribute)${C.reset}`);
  }
  if (f.src) {
    const srcDisplay = f.src.kind === 'jsx' ? `{${f.src.value}}` : `"${f.src.value}"`;
    const srcShort = srcDisplay.length > 60 ? srcDisplay.slice(0, 60) + '...' : srcDisplay;
    console.log(`    ${C.dim}src=${srcShort}${C.reset}`);
  }
  console.log('');
}

console.log('  Legend:');
console.log('    GOOD     — 3+ word descriptive alt');
console.log('    DYNAMIC  — JSX expression (alt comes from data, audit at data layer)');
console.log('    SHORT    — 1–2 word alt, may need more context');
console.log('    GENERIC  — Words like "image" / "icon" / category names alone');
console.log('    EMPTY    — alt="" (acceptable ONLY for purely decorative images)');
console.log('    MISSING  — no alt attribute (accessibility + SEO issue)\n');
