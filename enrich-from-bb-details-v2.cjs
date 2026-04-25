// enrich-from-bb-details-v2.cjs
// More aggressive BB field mapping - covers Keyboard, Headset, Microphone gaps

const fs = require('fs');
const path = require('path');

const BB_DIR = './catalog-build/bestbuy-discovery';
const ENRICHMENTS_PATH = './catalog-build/_enrichments.json';

const CATEGORIES = ['Mouse', 'Keyboard', 'Headset', 'Microphone', 'Webcam', 'MousePad'];

// Multiple BB fields can map to one of our fields - try them all
const FIELD_MAPS = {
  Mouse: {
    sensor: ['Sensor Type', 'Sensor', 'Tracking Method', 'Mouse Sensor'],
    dpi: ['DPI', 'Maximum DPI', 'Sensor Resolution'],
    pollingRate: ['Polling Rate', 'Maximum Polling Rate'],
    weight: ['Weight', 'Product Weight'],
    mouseType: ['Connectivity', 'Connection Type', 'Wireless Connectivity', 'Wireless'],
  },
  Keyboard: {
    switches: ['Key Switch Type', 'Switch Type', 'Key Switches', 'Keyboard Technology', 'Key Switch Behavior'],
    layout: ['Form Factor', 'Layout', 'Keyboard Layout'],
    wireless: ['Connectivity', 'Connection Type', 'Wireless Connectivity', 'Wireless'],
    rgb: ['Backlit Keys', 'Backlight', 'RGB Lighting', 'Lighting Type', 'Customizable Lighting'],
  },
  Headset: {
    hsType: ['Connectivity', 'Connection Type', 'Wireless Connectivity', 'Wireless'],
    driver: ['Driver Size', 'Speaker Size', 'Speaker Driver Size'],
    mic: ['Microphone Type', 'Microphone', 'Built-In Microphone'],
    anc: ['Active Noise Cancellation', 'Noise Cancellation', 'Noise Cancelling'],
  },
  Microphone: {
    micType: ['Connection Type', 'Connectivity', 'Connections'],
    pattern: ['Polar Pattern', 'Pickup Pattern', 'Microphone Type', 'Polar Patterns'],
    sampleRate: ['Sample Rate', 'Sampling Rate', 'Maximum Sample Rate'],
  },
  Webcam: {
    resolution: ['Resolution', 'Maximum Resolution', 'Video Resolution', 'Image Resolution'],
    fps: ['Frame Rate', 'Maximum Frame Rate', 'Maximum Recording Frame Rate'],
    autofocus: ['Autofocus', 'Auto Focus', 'Focus Type'],
  },
  MousePad: {
    surface: ['Material', 'Surface Type', 'Pad Material', 'Mousepad Material'],
    padSize: ['Size', 'Pad Size'],
  },
};

function normalizeValue(field, raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s.toLowerCase() === 'not specified' || s === '-') return null;

  const lower = s.toLowerCase();

  switch (field) {
    case 'sensor':
      if (s.length > 40) return null; // probably a description not a sensor name
      // Strip generic adjectives
      const cleaned = s.replace(/\b(optical|laser)\b/gi, '').trim();
      return cleaned || s;
    case 'dpi':
      const dpiM = s.match(/(\d{1,3}[,]?\d{0,3})/);
      if (!dpiM) return null;
      const dpi = parseInt(dpiM[1].replace(/,/g, ''));
      return dpi > 100 && dpi < 100000 ? dpi : null;
    case 'pollingRate':
      const prM = s.match(/(\d+)/);
      return prM ? parseInt(prM[1]) : null;
    case 'weight':
      const wM = s.match(/([\d.]+)\s*(g|gram|grams|oz|ounce|lb|pound)/i);
      if (!wM) return null;
      const wVal = parseFloat(wM[1]);
      const wUnit = wM[2].toLowerCase();
      if (wUnit.startsWith('lb') || wUnit.startsWith('pound')) return Math.round(wVal * 453.6);
      if (wUnit.startsWith('oz') || wUnit.startsWith('ounce')) return Math.round(wVal * 28.35);
      return Math.round(wVal);
    case 'mouseType':
    case 'hsType':
    case 'micType':
      if (/wireless|bluetooth|2\.4/i.test(lower)) return 'Wireless';
      if (/usb-?c?\b/i.test(lower) && !/cable/i.test(lower)) return 'USB';
      if (/xlr/i.test(lower)) return 'XLR';
      if (/wired|cable|3\.5mm/i.test(lower)) return 'Wired';
      return null;
    case 'wireless':
      if (/wireless|bluetooth|2\.4/i.test(lower)) return true;
      if (/wired|cable\s*only/i.test(lower)) return false;
      return null;
    case 'rgb':
      if (/rgb|chroma|backlit|true|yes/i.test(lower)) return true;
      if (/^no$|^none$|false/i.test(lower)) return false;
      return null;
    case 'mic':
    case 'anc':
    case 'autofocus':
      if (/yes|true|active|built-?in|integrated|enabled/i.test(lower)) return true;
      if (/^no$|none|false|disabled/i.test(lower)) return false;
      return null;
    case 'switches':
      if (/optical/i.test(s)) return 'Optical';
      if (/magnetic|hall/i.test(s)) return 'Hall Effect';
      if (/cherry|gateron|kailh/i.test(s)) {
        const m = s.match(/(red|blue|brown|black|silver|speed|silent|clear|yellow)/i);
        return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() : 'Mechanical';
      }
      if (/^(red|blue|brown|black|silver|yellow|speed|silent|clear)\b/i.test(s)) {
        const m = s.match(/(red|blue|brown|black|silver|yellow|speed|silent|clear)/i);
        return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
      }
      if (/scissor/i.test(s)) return 'Scissor';
      if (/mech-?dome|membrane/i.test(s)) return 'Membrane';
      if (/mechanical/i.test(s)) return 'Mechanical';
      return null;
    case 'layout':
      if (/full[\s-]?size|standard|104|108/i.test(s)) return 'Full-Size';
      if (/tkl|tenkeyless|87[\s-]?key/i.test(s)) return 'TKL';
      if (/75/i.test(s)) return '75%';
      if (/65/i.test(s)) return '65%';
      if (/60/i.test(s)) return '60%';
      if (/96/i.test(s)) return '96%';
      if (/compact/i.test(s)) return 'Compact';
      return null;
    case 'driver':
      const dM = s.match(/([\d.]+)\s*mm/i);
      if (dM) return parseInt(dM[1]);
      const dn = s.match(/^([\d.]+)$/);
      return dn ? parseInt(dn[1]) : null;
    case 'pattern':
      if (/cardioid/i.test(s)) return 'Cardioid';
      if (/condenser/i.test(s)) return 'Condenser';
      if (/dynamic/i.test(s)) return 'Dynamic';
      if (/omnidirectional/i.test(s)) return 'Omnidirectional';
      if (/multi-?pattern/i.test(s)) return 'Multi-Pattern';
      if (/bidirectional|figure[- ]?8/i.test(s)) return 'Bidirectional';
      return null;
    case 'sampleRate':
      const srM = s.match(/(\d+)\s*k?Hz/i);
      return srM ? parseInt(srM[1]) : null;
    case 'resolution':
      if (/4k|2160|3840/.test(s)) return '4K';
      if (/1440|qhd|2k\b/i.test(s)) return '1440p';
      if (/1080|fhd|full\s*hd/i.test(s)) return '1080p';
      if (/720|hd\b/i.test(s)) return '720p';
      return null;
    case 'fps':
      const fM = s.match(/(\d+)/);
      const fps = fM ? parseInt(fM[1]) : null;
      return (fps && fps > 0 && fps <= 240) ? fps : null;
    case 'surface':
      if (/cloth|fabric|textile/i.test(s)) return 'Cloth';
      if (/hard|aluminum|metal|glass|plastic/i.test(s)) return 'Hard';
      if (/hybrid/i.test(s)) return 'Hybrid';
      if (/rubber|silicon/i.test(s)) return 'Rubber';
      return null;
    case 'padSize':
      if (/3xl|extended|gigantic/i.test(s)) return 'XXL';
      if (/xxl/i.test(s)) return 'XXL';
      if (/xl|extra\s*large/i.test(s)) return 'XL';
      if (/large/i.test(s)) return 'Large';
      if (/medium/i.test(s)) return 'Medium';
      if (/small|compact/i.test(s)) return 'Small';
      return null;
  }
  return s.length > 50 ? null : s;
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;

  const existingEnrichments = fs.existsSync(ENRICHMENTS_PATH)
    ? JSON.parse(fs.readFileSync(ENRICHMENTS_PATH, 'utf8'))
    : {};

  const bbUrlIndex = new Map();
  for (const p of parts) {
    if (!CATEGORIES.includes(p.c)) continue;
    if (!p.deals?.bestbuy?.url) continue;
    const skuM = p.deals.bestbuy.url.match(/prodsku=(\d+)/);
    if (skuM) bbUrlIndex.set(skuM[1], p);
  }
  console.log('Parts with BB URLs: ' + bbUrlIndex.size);

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

      const details = bb._details || {};
      const enrichmentForId = existingEnrichments[part.id] || {};

      for (const [ourField, bbFieldList] of Object.entries(fieldMap)) {
        if (enrichmentForId[ourField] != null) continue;
        if (part[ourField] != null) continue;

        for (const bbField of bbFieldList) {
          const rawVal = details[bbField];
          if (rawVal == null) continue;

          const normalized = normalizeValue(ourField, rawVal);
          if (normalized != null && normalized !== '') {
            enrichmentForId[ourField] = normalized;
            stats[cat].fields++;
            totalNewFields++;
            break;
          }
        }
      }

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

  console.log('\n═══ BB DETAILS ENRICHMENT V2 ═══');
  for (const [cat, st] of Object.entries(stats)) {
    console.log('  ' + cat.padEnd(14) + ' matched:' + st.matched + ' newFields:' + st.fields);
  }
  console.log('\nTotal new fields added: ' + totalNewFields);

  fs.writeFileSync(ENRICHMENTS_PATH, JSON.stringify(existingEnrichments, null, 2));
  console.log('\n✓ Updated. Run apply-enrichments.cjs to merge into parts.js');
})();
