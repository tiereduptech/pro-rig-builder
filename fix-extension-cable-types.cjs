// fix-extension-cable-types.cjs
// Detects multi-cable kits in extension cable names and re-tags them appropriately

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

function isKit(name) {
  const n = name.toLowerCase();
  // Multi-cable detection: name mentions 2+ different cable types
  let typeCount = 0;
  if (/24[\s\-]?pin|24p\s|24p\+/i.test(n)) typeCount++;
  if (/8[\s\-]?pin\s*eps|eps\s*8|4\+4/i.test(n)) typeCount++;
  if (/8[\s\-]?pin\s*pci|6\+2|pcie?\s*8|pci-?e/i.test(n)) typeCount++;
  if (/cpu/i.test(n) && /pcie?|gpu/i.test(n)) typeCount++;
  // Explicit "kit" with multiple cable counts
  if (/kit/i.test(n) && typeCount >= 2) return true;
  // "1x24-PIN/2x8-PORT" pattern
  if (/1x\s*24.?pin.*\d+x\s*8/i.test(n)) return true;
  if (/24p.*8p.*8p|24p.*eps.*pci|atx.*eps.*pci/i.test(n)) return true;
  // "x-Pack" sleeved extensions
  if (/\d+[\s\-]?pack.*sleev/i.test(n)) return true;
  return false;
}

function detectCorrectType(name) {
  const n = name.toLowerCase();
  if (isKit(name)) return 'Full Kit';
  // 12VHPWR / 16-pin GPU
  if (/12vhpwr|16[\s\-]?pin.*gpu|gpu.*16[\s\-]?pin/i.test(n)) return '12VHPWR';
  // GPU 16-pin (Strimer style aesthetic only)
  if (/strimer.*gpu|gpu.*strimer/i.test(n)) return 'GPU 16-Pin';
  // EPS/CPU
  if (/^(?!.*atx).*eps|cpu\s*8.?pin|8.?pin\s*cpu/i.test(n) && !/24[\s\-]?pin|atx/i.test(n)) return 'EPS/CPU 8-pin';
  // 24-pin ATX
  if (/24[\s\-]?pin\s*(atx|motherboard)|^.*24p\s*atx/i.test(n)) return '24-pin ATX';
  // PCIe Power
  if (/8[\s\-]?pin\s*pcie?|pcie?\s*power|pcie?\s*extension/i.test(n)) return 'PCIe Power';
  // ARGB / LED strips
  if (/argb|rgb\s*led|led\s*strip/i.test(n)) return 'RGB Accessory';
  return null; // keep current
}

function setField(s, id, fieldName, newValue) {
  const idMarker = '"id": ' + id + ',';
  const idIdx = s.indexOf(idMarker);
  if (idIdx < 0) return { s, set: false };
  let pos = idIdx;
  while (pos > 0 && s[pos] !== '{') pos--;
  const startBrace = pos;
  let depth = 1;
  pos = startBrace + 1;
  while (pos < s.length && depth > 0) {
    if (s[pos] === '{') depth++;
    else if (s[pos] === '}') depth--;
    if (depth === 0) break;
    pos++;
  }
  const endBrace = pos;
  let entry = s.substring(startBrace, endBrace + 1);
  const formatted = '"' + newValue + '"';
  const fieldRegex = new RegExp('"' + fieldName + '":\\s*"[^"]*"');
  if (fieldRegex.test(entry)) {
    entry = entry.replace(fieldRegex, '"' + fieldName + '": ' + formatted);
  } else {
    // Insert
    const matchClosing = entry.match(/^([\s\S]*?)(\n\s*\}\s*)$/);
    if (!matchClosing) return { s, set: false };
    const before = matchClosing[1];
    const closing = matchClosing[2];
    entry = before.replace(/,?\s*$/, '') + ',\n    "' + fieldName + '": ' + formatted + closing;
  }
  return { s: s.substring(0, startBrace) + entry + s.substring(endBrace + 1), set: true };
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  let s = fs.readFileSync(PARTS_PATH, 'utf8');

  let changed = 0;
  let unchanged = 0;
  console.log('Re-evaluating cableType for extension cables:\n');

  for (const p of parts) {
    if (p.c !== 'ExtensionCables') continue;
    const detected = detectCorrectType(p.n);
    if (detected && detected !== p.cableType) {
      console.log('  ' + (p.cableType || 'undefined') + ' → ' + detected + ' | ' + p.n.substring(0, 65));
      const r = setField(s, p.id, 'cableType', detected);
      if (r.set) {
        s = r.s;
        changed++;
      }
    } else {
      unchanged++;
    }
  }

  fs.writeFileSync(PARTS_PATH, s);
  console.log('\n✓ Changed: ' + changed);
  console.log('  Unchanged: ' + unchanged);
})();
