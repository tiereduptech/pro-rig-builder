/**
 * fix-bad-category-v2.cjs
 * 
 * Aggressive cleanup of accessories, replacement parts, car parts, and
 * other junk that matched into wrong PC component categories.
 */

const fs = require('fs');
const APPLY = process.argv.includes('--apply');

// PATTERNS PER CATEGORY: if title matches ANY, quarantine it
const REJECT = {
  PSU: [
    // Only reject if title STARTS with cable/cord/adapter terminology
    /^(power\s*cord|cable\s*for|replacement\s*cable|extension\s*cable|sleeved\s*cable|modular\s*power\s*cable|ac\s*power\s*cable)/i,
    /^(PCIe|SATA|EPS)\s*\d+\s*pin/i,
    /^GinTai\s/i,                    // third-party cable brand
    /^CableMod\b/i,
    /^\d+ft\s+(ac\s+|power\s+)/i,
    /^ROG Thor PSU Power Cord/i,
    // Or rejects only if no "Power Supply" in the title
    /\bcable\s*management\s*kit\b/i,
    /^\d+\s*Pin\s+(to|for)\b/i,
  ],
  CPUCooler: [
    /\bwiper\s*blade/i,               // CAR wiper blades matching "Corsair" model
    /\bLincoln\s+Corsair/i,           // car
    /\b(MX[A-Z]|MKC|MKX)\s+\d{2}-/i,  // car model patterns
    /\b(mounting|installation)\s*(kit|bracket|hardware|frame)\b/i,
    /\b(bracket|backplate)\s+(only|kit|for|frame)\b/i,
    /^(am[45]|lga\d+|intel\s+lga|amd\s+am)\s+(mounting|bracket|kit)/i,
    /\bcooler\s+(bracket|frame|holder|stand|mount)\b/i,
    /\bretention\s+(bracket|kit|module|frame)/i,
    /\breplacement\s+(fan|pump|cap|cover|screw|seal|gasket)/i,
    /\bcooler\s+(extension|riser)\b/i,
    /\bthermal\s+paste\b(?!.*cooler)/i,
  ],
  Storage: [
    /\b(usb\s+to\s+sata|sata\s+to\s+usb|sata\s+adapter|sata\s+to\s+m\.?2|m\.?2\s+to\s+sata)\b/i,
    /\b(hdd|ssd)\s+(enclosure|caddy|dock|adapter)\b/i,
    /\bdrive\s+(enclosure|dock|caddy|adapter|cable|bay)\b/i,
    /\b(sata|nvme)\s+adapter\b/i,
    /\b(docking\s+station|disk\s+enclosure)\b/i,
    /\bhdd\s+dock/i,
    /\b(extension\s+card|extension\s+cable|adapter\s+(fpc|cable))\b/i,
    /^For\s+(Steam\s+Deck|Legion\s+Go)/i,
    /\bsteam\s+deck.*adapter/i,
  ],
  GPU: [
    /\bcomputer\s+case\b/i,
    /\bpc\s+case\b/i,
    /\bgpu\s+(holder|bracket|stand|riser)\b/i,
    /\briser\s+cable\b/i,
    /\bvertical\s+gpu\s+mount/i,
    /\bgpu\s+(extension|sag|support\s+bracket)\b/i,
    /\bgraphics\s+card\s+(holder|bracket|stand|support)\b/i,
    /\b(GPU|graphics)\s+riser\b/i,
  ],
  Case: [
    /\b(replacement|spare)\s+(panel|side|glass|guide|feet|foot)\b/i,
    /\bpanel\s+guide(s)?\b/i,
    /\b(raised|case)\s+feet\b/i,
    /\bcase\s+(upgrade|accessory|modification)\b/i,
    /\bside\s+panel\s+(replacement|guide)/i,
    /\bcpu\s+(cooler|fan|cooling)\b/i,
    /\baio\s+(cooler|liquid)/i,
    /\bcase\s+stand\b/i,
    /\bdesktop\s+raised\s+feet/i,
    /\bguides?\s+panels?\s+into\s+place/i,
  ],
  CPU: [
    /\bcooler\s+(kit|bracket|mounting)\b/i,
    /\bcpu\s+(cooler|fan)\s+for\b/i,
    /\b(thermal\s+paste|tim)\b/i,
    /\bcpu\s+holder\b/i,
    /\bbracket\s+for\s+CPU/i,
  ],
  RAM: [
    /\bram\s+(heatsink|spreader|cooler)\b/i,
    /\bmemory\s+heatsink\b/i,
  ],
  Motherboard: [
    /\bmotherboard\s+(tray|stand|frame|test\s+bench)\b/i,
    /\bcpu\s+socket\s+protect/i,
    /\bsocket\s+(cover|protector)\b/i,
  ],
};

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...m.PARTS];

  const stats = {};
  const examples = {};
  let total = 0;

  for (const p of parts) {
    if (p.needsReview) continue;
    const patterns = REJECT[p.c];
    if (!patterns) continue;
    const title = p.n || '';
    for (const pat of patterns) {
      if (pat.test(title)) {
        stats[p.c] = (stats[p.c] || 0) + 1;
        total++;
        examples[p.c] = examples[p.c] || [];
        if (examples[p.c].length < 8) examples[p.c].push('[' + p.id + '] $' + p.pr + ' ' + title.slice(0, 90));
        if (APPLY) p.needsReview = true;
        break;
      }
    }
  }

  console.log('Mode:', APPLY ? 'APPLY' : 'DRY RUN');
  console.log('Total to quarantine:', total);
  console.log('\nBy category:');
  Object.entries(stats).sort((a,b) => b[1] - a[1]).forEach(([c,n]) => {
    console.log('\n[' + c + ']: ' + n);
    examples[c].forEach(e => console.log('  ' + e));
  });

  if (APPLY) {
    const header = '// Auto-merged catalog. Edit with care.\n';
    const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
    fs.writeFileSync('src/data/parts.js', header + body, 'utf8');
    console.log('\nApplied: ' + total + ' products quarantined.');
  }
})();
