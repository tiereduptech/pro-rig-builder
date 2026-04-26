// enrich-from-bb-details.cjs
// BB discovery JSON has _details object with structured spec data
// Match products in parts.js by BB URL/SKU and inject those specs

const fs = require('fs');
const path = require('path');

const BB_DIR = './catalog-build/bestbuy-discovery';
const ENRICHMENTS_PATH = './catalog-build/_enrichments.json';

const CATEGORIES = ['Mouse', 'Keyboard', 'Headset', 'Microphone', 'Webcam', 'MousePad'];

// Map of BB detail field names → our schema field names
// Each category gets its own mapping based on what's relevant
const FIELD_MAPS = {
  Mouse: {
    'Sensor Type': 'sensor',
    'Sensor': 'sensor',
    'Tracking Method': 'sensor',
    'DPI': 'dpi',
    'Maximum DPI': 'dpi',
    'Polling Rate': 'pollingRate',
    'Weight': 'weight',
    'Connectivity': 'mouseType',
    'Connection Type': 'mouseType',
    'Wireless Connectivity': 'mouseType',
  },
  Keyboard: {
    'Switch Type': 'switches',
    'Key Switch Type': 'switches',
    'Key Switches': 'switches',
    'Form Factor': 'layout',
    'Layout': 'layout',
    'Connectivity': 'wireless',
    'Wireless Connectivity': 'wireless',
    'Connection Type': 'wireless',
    'Backlit Keys': 'rgb',
    'Backlight': 'rgb',
    'RGB Lighting': 'rgb',
  },
  Headset: {
    'Connectivity': 'hsType',
    'Connection Type': 'hsType',
    'Wireless Connectivity': 'hsType',
    'Driver Size': 'driver',
    'Speaker Size': 'driver',
    'Microphone Type': 'mic',
    'Microphone': 'mic',
    'Active Noise Cancellation': 'anc',
    'Noise Cancellation': 'anc',
  },
  Microphone: {
    'Connection Type': 'micType',
    'Connectivity': 'micType',
    'Polar Pattern': 'pattern',
    'Pickup Pattern': 'pattern',
    'Microphone Type': 'pattern',
    'Sample Rate': 'sampleRate',
  },
  Webcam: {
    'Resolution': 'resolution',
    'Maximum Resolution': 'resolution',
    'Video Resolution': 'resolution',
    'Frame Rate': 'fps',
    'Maximum Frame Rate': 'fps',
    'Autofocus': 'autofocus',
    'Auto Focus': 'autofocus',
  },
  MousePad: {
    'Material': 'surface',
    'Surface Type': 'surface',
    'Pad Material': 'surface',
    'Size': 'padSize',
  },
};

function normalizeValue(field, raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;

  switch (field) {
    case 'sensor':
      return s.length > 30 ? s.substring(0, 30) : s;
    case 'dpi':
      const dpiM = s.match(/(\d{1,3}[,]?\d{0,3})/);
      return dpiM ? parseInt(dpiM[1].replace(/,/g, '')) : null;
    case 'pollingRate':
      const prM = s.match(/(\d+)/);
      return prM ? parseInt(prM[1]) : null;
    case 'weight':
      const wM = s.match(/([\d.]+)\s*(g|gram|grams|oz|ounce)/i);
      if (!wM) return null;
      const wVal = parseFloat(wM[1]);
      const wUnit = wM[2].toLowerCase();
      if (wUnit.startsWith('oz') || wUnit.startsWith('ounce')) return Math.round(wVal * 28.35);
      return Math.round(wVal);
    case 'mouseType':
    case 'hsType':
    case 'micType':
      const ls = s.toLowerCase();
      if (/wireless|bluetooth|2\.4/i.test(ls)) return 'Wireless';
      if (/usb-?c?\b/.test(ls)) return 'USB';
      if (/xlr/.test(ls)) return 'XLR';
      if (/wired|cable|3\.5mm/.test(ls)) return 'Wired';
      return null;
    case 'wireless':
    case 'rgb':
    case 'mic':
    case 'anc':
    case 'autofocus':
      const lower = s.toLowerCase();
      if (/yes|true|wireless|bluetooth/.test(lower)) return true;
      if (/no|false|wired|none/.test(lower)) return false;
      return null;
    case 'switches':
      if (/optical/i.test(s)) return 'Optical';
      if (/magnetic|hall/i.test(s)) return 'Hall Effect';
      if (/cherry/i.test(s)) {
        const m = s.match(/(red|blue|brown|black|silver|speed|silent|clear|yellow)/i);
        return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() : 'Mechanical';
      }
      if (/(red|blue|brown|black|silver|yellow|speed|silent|clear)\b/i.test(s)) {
        const m = s.match(/(red|blue|brown|black|silver|yellow|speed|silent|clear)/i);
        return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
      }
      if (/mechanical/i.test(s)) return 'Mechanical';
      if (/membrane/i.test(s)) return 'Membrane';
      return null;
    case 'layout':
      if (/full[\s-]?size|full|standard/i.test(s)) return 'Full-Size';
      if (/tkl|tenkeyless|87[\s-]?key/i.test(s)) return 'TKL';
      if (/75/i.test(s)) return '75%';
      if (/65/i.test(s)) return '65%';
      if (/60/i.test(s)) return '60%';
      if (/96/i.test(s)) return '96%';
      return null;
    case 'driver':
      const dM = s.match(/([\d.]+)\s*mm/i);
      return dM ? parseInt(dM[1]) : null;
    case 'pattern':
      if (/cardioid/i.test(s)) return 'Cardioid';
      if (/condenser/i.test(s)) return 'Condenser';
      if (/dynamic/i.test(s)) return 'Dynamic';
      if (/omnidirectional/i.test(s)) return 'Omnidirectional';
      if (/multi-?pattern|multipattern/i.test(s)) return 'Multi-Pattern';
      return null;
    case 'sampleRate':
      const srM = s.match(/(\d+)\s*k?Hz/i);
      return srM ? parseInt(srM[1]) : null;
    case 'resolution':
      if (/4k|2160/.test(s)) return '4K';
      if (/1440|qhd|2k/i.test(s)) return '1440p';
      if (/1080|fhd/i.test(s)) return '1080p';
      if (/720|hd/i.test(s)) return '720p';
      return null;
    case 'fps':
      const fM = s.match(/(\d+)/);
      return fM ? parseInt(fM[1]) : null;
    case 'surface':
      if (/cloth|fabric|textile/i.test(s)) return 'Cloth';
      if (/hard|aluminum|metal|glass|plastic/i.test(s)) return 'Hard';
      if (/hybrid/i.test(s)) return 'Hybrid';
      return null;
    case 'padSize':
      if (/3xl|extended|gigantic/i.test(s)) return 'XXL';
      if (/xxl/i.test(s)) return 'XXL';
      if (/xl|extra\s*large/i.test(s)) return 'XL';
      if (/large/i.test(s)) return 'Large';
      if (/medium/i.test(s)) return 'Medium';
      if (/small/i.test(s)) return 'Small';
      return null;
  }
  return s.length > 50 ? null : s;
}

(async () => {
  // Load existing parts and existing enrichments
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;

  const existingEnrichments = fs.existsSync(ENRICHMENTS_PATH)
    ? JSON.parse(fs.readFileSync(ENRICHMENTS_PATH, 'utf8'))
    : {};

  // Build URL/SKU index of parts.js entries that have BB deals
  const bbUrlIndex = new Map();
  for (const p of parts) {
    if (!CATEGORIES.includes(p.c)) continue;
    if (!p.deals?.bestbuy?.url) continue;
    // Extract BB SKU from URL: prodsku=XXXXXXX
    const skuM = p.deals.bestbuy.url.match(/prodsku=(\d+)/);
    if (skuM) bbUrlIndex.set(skuM[1], p);
  }
  console.log('Parts with BB URLs: ' + bbUrlIndex.size);

  // Walk BB discovery files and pull spec data
  let stats = {};
  for (const cat of CATEGORIES) stats[cat] = { matched: 0, fields: 0 };

  let totalNewFields = 0;

  for (const cat of CATEGORIES) {
    const inputPath = path.join(BB_DIR, cat + '.json');
    if (!fs.existsSync(inputPath)) continue;

    const items = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const fieldMap = FIELD_MAPS[cat];

    for (const bb of items) {
      const sku = bb.bestBuySku || bb.catalogItemId;
      if (!sku) continue;
      const part = bbUrlIndex.get(String(sku));
      if (!part) continue;

      stats[cat].matched++;

      // Pull spec fields from _details
      const details = bb._details || {};
      const enrichmentForId = existingEnrichments[part.id] || {};

      for (const [bbField, ourField] of Object.entries(fieldMap)) {
        if (enrichmentForId[ourField] != null) continue; // already have it
        if (part[ourField] != null) continue; // already on the part

        const rawVal = details[bbField];
        if (rawVal == null) continue;

        const normalized = normalizeValue(ourField, rawVal);
        if (normalized != null && normalized !== '') {
          enrichmentForId[ourField] = normalized;
          stats[cat].fields++;
          totalNewFields++;
        }
      }

      // Also use BB scalars for weight
      if (cat === 'Mouse' && enrichmentForId.weight == null && part.weight == null) {
        const wRaw = bb._scalars?.weight;
        if (wRaw) {
          const wn = normalizeValue('weight', wRaw);
          if (wn != null) {
            enrichmentForId.weight = wn;
            stats[cat].fields++;
            totalNewFields++;
          }
        }
      }

      if (Object.keys(enrichmentForId).length > 0) {
        existingEnrichments[part.id] = enrichmentForId;
      }
    }
  }

  console.log('\n═══ BB DETAILS ENRICHMENT ═══');
  for (const [cat, st] of Object.entries(stats)) {
    console.log('  ' + cat.padEnd(14) + ' matched:' + st.matched + ' newFields:' + st.fields);
  }
  console.log('\nTotal new fields added: ' + totalNewFields);
  console.log('Total products enriched: ' + Object.keys(existingEnrichments).length);

  fs.writeFileSync(ENRICHMENTS_PATH, JSON.stringify(existingEnrichments, null, 2));
  console.log('\n✓ ' + ENRICHMENTS_PATH + ' updated. Run apply-enrichments.cjs to merge into parts.js');
})();
