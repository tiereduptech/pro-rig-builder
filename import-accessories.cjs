// import-accessories.cjs
// Reads curated-{category}.json files
// Generates new parts.js entries in the catalog schema
// Skips ASINs that already exist
// Outputs candidate JSON to be appended to parts.js (you review first)

const fs = require('fs');
const path = require('path');

const INPUT_DIR = './catalog-build/amazon-discovery';
const PARTS_PATH = './src/data/parts.js';

// Map our curation category keys → parts.js category strings
const CATEGORY_MAP = {
  mouse: 'Mouse',
  keyboard: 'Keyboard',
  headset: 'Headset',
  microphone: 'Microphone',
  webcam: 'Webcam',
  mousepad: 'MousePad',
  extensioncables: 'ExtensionCables',
};

(async () => {
  // Load existing parts.js to get existing ASINs and find max id
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;

  console.log('Loaded ' + parts.length + ' existing parts');

  // Build set of existing ASINs to avoid duplicates
  const existingAsins = new Set();
  let maxId = 0;
  for (const p of parts) {
    if (p.deals && p.deals.amazon && p.deals.amazon.url) {
      const match = p.deals.amazon.url.match(/\/dp\/([A-Z0-9]{10})/);
      if (match) existingAsins.add(match[1]);
    }
    if (p.id && p.id > maxId) maxId = p.id;
  }
  console.log('Existing ASINs: ' + existingAsins.size);
  console.log('Max id: ' + maxId);

  let nextId = maxId + 1;
  const newEntries = [];
  const skipped = { duplicate: 0 };

  for (const [catKey, catName] of Object.entries(CATEGORY_MAP)) {
    const inputPath = path.join(INPUT_DIR, 'curated-' + catKey + '.json');
    if (!fs.existsSync(inputPath)) {
      console.log('SKIP ' + catKey + ': no curated file');
      continue;
    }

    const items = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    let added = 0;

    for (const item of items) {
      if (!item.asin) continue;
      if (existingAsins.has(item.asin)) {
        skipped.duplicate++;
        continue;
      }

      // Build catalog entry matching schema
      const entry = {
        id: nextId++,
        n: item.title.length > 200 ? item.title.substring(0, 197) + '...' : item.title,
        img: item.imageUrl || '',
        c: catName,
        b: item.brand || 'Misc',
        pr: Math.round(item.price || 0),
        msrp: Math.round(item.price || 0),
        r: item.rating || 4.0,
        deals: {
          amazon: {
            url: item.amazonUrl,
            price: item.price || 0,
            inStock: true,
          }
        },
      };

      newEntries.push(entry);
      existingAsins.add(item.asin);
      added++;
    }

    console.log(catName.padEnd(18) + ' added: ' + added);
  }

  console.log('\nTotal new entries: ' + newEntries.length);
  console.log('Skipped (duplicates): ' + skipped.duplicate);

  // Write candidates to a JSON file for review
  const outputPath = './catalog-build/amazon-discovery/_to-import.json';
  fs.writeFileSync(outputPath, JSON.stringify(newEntries, null, 2));
  console.log('\n✓ Wrote ' + newEntries.length + ' candidates to: ' + outputPath);
  console.log('  Review the file, then run merge-accessories.cjs to add them to parts.js');
})();
