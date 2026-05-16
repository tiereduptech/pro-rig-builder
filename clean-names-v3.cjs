const fs = require('fs');
const path = 'src/App.jsx';
let c = fs.readFileSync(path, 'utf8');

// Step 1: Insert helper near top of file
const injectAfter = "import { PARTS as RAW_SEED_PARTS } from \"./data/parts.js\";";
if (!c.includes(injectAfter)) {
  console.log('FAIL: parts import not found');
  process.exit(1);
}

// Avoid duplicate insertion
if (c.includes('function cleanProductName')) {
  console.log('Helper already exists, will replace it');
  // Remove existing helper
  c = c.replace(/\/\* ━━━ DISPLAY-TIME NAME CLEANER[\s\S]*?return name \|\| p\.n;\s*\n\}\s*\n/, '');
}

const helper = `
// DISPLAY-TIME NAME CLEANER (GPU only for now)
// Strips marketing fluff, parentheticals, trademark symbols. Does NOT mutate catalog.
function cleanProductName(p){
  if(!p || !p.n) return '';
  if(p.c !== 'GPU') return p.n;
  let name = p.n;
  // Trademark symbols
  name = name.replace(/[\\u2122\\u00AE\\u00A9]/g, '');
  // Parenthetical clutter
  name = name.replace(/\\s*\\([^)]*\\)/g, '');
  // Condition markers
  name = name.replace(/\\b(Renewed|Open Box|Refurbished)\\b/gi, '');
  // Generic suffixes
  name = name.replace(/\\b(Graphics Card|Video Card|Desktop GPU|Gaming GPU|GPU)\\b/gi, '');
  // Marketing fluff
  const fluff = ['The SFF-Ready','SFF-Ready','Triple Fan','Dual Fan','Single Fan','with Heatsink','with Heat Sink','Axial-tech','Dual BIOS'];
  for(const f of fluff){
    const re = new RegExp('\\\\b' + f.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&') + '\\\\b','gi');
    name = name.replace(re, '');
  }
  // Memory/bus callouts
  name = name.replace(/\\b\\d+GB\\s+GDDR\\d[xX]?\\b/gi, '');
  name = name.replace(/\\b\\d+GB\\b/gi, '');
  name = name.replace(/\\bGDDR\\d[xX]?\\b/gi, '');
  name = name.replace(/\\b\\d+-bit\\b/gi, '');
  // PCIe callout
  name = name.replace(/\\bPCIe?\\s*\\d+(?:\\.\\d+)?(?:x\\d+)?\\b/gi, '');
  // Output ports
  name = name.replace(/\\b(HDMI|DP|DisplayPort)\\s*\\d+(?:\\.\\d+)?[ab]?\\b/gi, '');
  name = name.replace(/\\bHDMI\\/DP\\b/gi, '');
  // Slot callout
  name = name.replace(/\\b\\d+(?:\\.\\d+)?-Slot\\b/gi, '');
  // Trailing "Edition"
  name = name.replace(/\\bEdition\\b/gi, '');
  // Collapse whitespace
  name = name.replace(/\\s+/g, ' ').trim();
  // Strip trailing junk
  name = name.replace(/[\\s,\\-]+$/, '');
  name = name.replace(/^[\\s,\\-]+/, '');
  // Strip leading "Dual" / "Triple" before brand
  name = name.replace(/^(?:Dual|Triple)\\s+(?=ASUS|MSI|NVIDIA|AMD|Gigabyte|Sapphire|XFX|ZOTAC|PowerColor|EVGA|Galax|PNY|Inno3D)/i, '');
  // Append VRAM at end if available
  if (p.vram != null && !/\\d+GB/.test(name)) {
    name = name.trim() + ' ' + p.vram + 'GB';
  }
  return name.trim() || p.n;
}
`;

c = c.replace(injectAfter, injectAfter + helper);
console.log('✓ Injected cleanProductName helper');

// Step 2: Wire to displays — find {p.n} renders in product rows
const replacements = [
  // Browse row (search page)
  { from: 'overflow:"hidden",lineHeight:1.3}}>{p.n}</div>', to: 'overflow:"hidden",lineHeight:1.3}}>{cleanProductName(p)}</div>' },
  // Sticky sidebar
  { from: 'whiteSpace:"nowrap",marginTop:2}}>{p.n}</div>', to: 'whiteSpace:"nowrap",marginTop:2}}>{cleanProductName(p)}</div>' },
];

let total = 0;
for (const r of replacements) {
  let n = 0;
  while (c.includes(r.from)) { c = c.replace(r.from, r.to); n++; if (n > 10) break; }
  console.log(`✓ Replaced ${n}× pattern ${r.from.slice(-40)}`);
  total += n;
}
console.log(`Total replacements: ${total}`);

fs.writeFileSync(path, c, 'utf8');
console.log('\nDone.');
