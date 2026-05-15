/**
 * fix-bad-category.cjs
 * 
 * Finds products in wrong categories or pure accessories that snuck in
 * via Amazon search. Quarantines them with needsReview:true (hides from frontend).
 *
 * USAGE:
 *   node fix-bad-category.cjs            # dry run, show what would be quarantined
 *   node fix-bad-category.cjs --apply
 */

const fs = require('fs');
const APPLY = process.argv.includes('--apply');

// Reject patterns by category - if the title matches any of these, the product is misclassified
const REJECT_PATTERNS = {
  // PSU: reject pure cables, cords, adapters, mounting kits
  PSU: [
    /^(pcie\s*\d|ac\s*power\s*cabl|power\s*cord|extension\s*cabl|gpu\s*cabl|cable\s*replacement|atx\s*cabl|adapter\s*cabl|power\s*cabl)/i,
    /\bcable\s*(only|replacement|extension)\b/i,
    /\b(replacement|extension)\s*cable\b/i,
    /^\d+ft\s+(ac\s+)?power\s+cord/i,
    /\bc13\s+(cord|cable)/i,
    /\bcable\s+kit\b/i,
    /\bmounting\s+(kit|bracket)\b/i,
    /^(pcie|sata)\s*cable\b/i,
    /\bpsu\s*test\w*/i, // PSU testers
  ],
  // CPUCooler: reject mounting kits, brackets, replacement parts
  CPUCooler: [
    /\b(mounting|installation)\s*(kit|bracket)\b/i,
    /\b(bracket|backplate)\s+(only|kit|for)\b/i,
    /^(am[45]|lga\d+)\s+(mounting|bracket|kit)/i,
    /\bcooler\s+bracket\b/i,
    /\bretention\s+(bracket|kit|module)/i,
    /\breplacement\s+(fan|pump|cap)/i,
    /\bcooler\s+(stand|holder|mount)\b/i,
  ],
  // Storage: reject adapters, enclosures, docks, cables
  Storage: [
    /\b(usb\s+to\s+sata|sata\s+to\s+usb|sata\s+adapter|sata\s+to\s+m\.?2|m\.?2\s+to\s+sata)\b/i,
    /\b(hdd|ssd)\s+(enclosure|caddy|dock|adapter|cable)\b/i,
    /\bdrive\s+(enclosure|dock|caddy)\b/i,
    /\b(sata|nvme)\s+adapter\b/i,
    /\b(docking\s+station|disk\s+enclosure)\b/i,
    /\bhdd\s+dock/i,
  ],
  // GPU: reject cases, accessories, brackets, cables
  GPU: [
    /^(jonsbo|lian li|fractal|nzxt|corsair|phanteks|cooler master|thermaltake|hyte|musetex|montech|antec|inwin|silverstone|deepcool)\s+.*\b(case|chassis|tower)\b/i,
    /\bcomputer\s+case\b/i,
    /\bpc\s+case\b/i,
    /\bgpu\s+(holder|bracket|stand|riser)\b/i,
    /\briser\s+cable\b/i,
    /\bvertical\s+gpu\s+mount/i,
    /\bgpu\s+(extension|sag)\b/i,
  ],
  // Case: reject coolers, fans, accessories
  Case: [
    /^(kingcool|noctua|deepcool|thermalright|cooler master|nzxt|corsair|arctic|be quiet|scythe|id-cooling)\s+.*\b(cooler|cooling|heatsink)\b/i,
    /\bcpu\s+(cooler|fan|cooling)\b/i,
    /\baio\s+cooler/i,
    /^(120|140|200)mm\s+fan/i, // standalone case fans starting with size
  ],
};

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...m.PARTS];

  const stats = {};
  const examples = {};
  let total = 0;

  for (const p of parts) {
    if (p.needsReview) continue; // already quarantined
    const patterns = REJECT_PATTERNS[p.c];
    if (!patterns) continue;
    const title = p.n || '';
    for (const pat of patterns) {
      if (pat.test(title)) {
        stats[p.c] = (stats[p.c] || 0) + 1;
        total++;
        examples[p.c] = examples[p.c] || [];
        if (examples[p.c].length < 5) examples[p.c].push('[' + p.id + '] $' + p.pr + ' ' + title.slice(0, 85));
        if (APPLY) p.needsReview = true;
        break;
      }
    }
  }

  console.log('Mode:', APPLY ? 'APPLY' : 'DRY RUN');
  console.log('Total products to quarantine:', total);
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
