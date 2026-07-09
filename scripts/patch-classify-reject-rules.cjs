// One-shot patch: insert 7 cross-category reject rules into catalog-classify.cjs.
// Run with:  node scripts/patch-classify-reject-rules.cjs
// Verifies the anchor is unique before touching the file; refuses to double-apply.
// Newline-agnostic (the file is CRLF).
const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', 'catalog-classify.cjs');
let src = fs.readFileSync(FILE, 'utf8');
const NL = src.includes('\r\n') ? '\r\n' : '\n';

// Single-line, unique anchor: the drive-enclosure reject rule (last entry today).
const ANCHOR = `    [/\\b(?:m\\.?2|nvme|ssd|hdd|sata|usb)\\b[^,|]*\\benclosure\\b/, 'drive enclosure'],`;

const NEWLINES = [
  ``,
  `    // ── Hardened after the Jul-08 category-accuracy cleanup (dropped 83 cross-`,
  `    // category rows). Each pattern rejects a product TYPE that kept landing in the`,
  `    // wrong bucket via nightly ingests. Like the wiper-blade rule above, these run`,
  `    // BEFORE categorize/detectBrand, so the wrong-category source query never gets`,
  `    // to file them. Narrowed on purpose so they reject the STANDALONE accessory but`,
  `    // not a real fan/cooler/mic/headset that merely mentions the part as a feature`,
  `    // ("iCUE Link System Hub Kit", "Built-in Pop Filter", "Memory Foam Ear Pads").`,
  `    // Every pattern verified 0-false-positive against the full live catalog and`,
  `    // matches the exact rows the cleanup removed.`,
  `    [/\\bdistro[\\s-]?plate\\b/, 'distro plate (custom-loop accessory)'],`,
  `    [/\\b(?:control|system) hub\\s*[-–]\\s*(?:connect|digital|control|reduce|up to|rgb|argb|pwm|lighting)\\b/, 'RGB/fan control hub (accessory)'],`,
  `    [/\\bssd (?:hard drive )?adapter\\b|\\b22\\d0\\s+to\\s+2280\\b/, 'SSD form-factor adapter (accessory)'],`,
  `    [/\\be-?gpu\\b/, 'eGPU dock/enclosure (accessory)'],`,
  `    [/\\bwind\\s?screen\\b|\\bfurry\\b|\\bdead\\s?cat\\b|\\bpop (?:filter|guard) (?:for|compatible)\\b/, 'mic pop filter/windscreen (accessory)'],`,
  `    [/\\bear\\s?pads?(?:\\s+cushions?)?\\s+replacement\\b|\\breplacement\\s+(?:ear\\s?pads?|ear cushions?)\\b/, 'replacement earpads (accessory)'],`,
  `    [/\\bmic(?:rophone)? replacement\\b|\\breplacement (?:lapel |boom |detachable )?mic(?:rophone)?\\b|\\bcable replacement\\b/, 'replacement headset mic/cable (accessory)'],`,
];

if (src.includes("'distro plate (custom-loop accessory)'")) {
  console.error('ABORT: reject rules already present (distro-plate marker found). Nothing to do.');
  process.exit(1);
}
const count = src.split(ANCHOR).length - 1;
if (count !== 1) {
  console.error(`ABORT: anchor found ${count} times (expected exactly 1). Not patching.`);
  process.exit(1);
}

src = src.replace(ANCHOR, ANCHOR + NEWLINES.join(NL));
fs.writeFileSync(FILE, src);
console.log('OK: inserted 7 reject rules into', path.basename(FILE), `(newline: ${NL === '\r\n' ? 'CRLF' : 'LF'})`);
