// drain-dfs-queue.cjs
// Fetches ALL ready ASIN tasks from DataForSEO queue
// Matches each by returned ASIN to our candidates list
// Updates _enrichments.json

const fs = require('fs');

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
const AUTH = 'Basic ' + Buffer.from(LOGIN + ':' + PASSWORD).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

const ENRICHMENTS_PATH = './catalog-build/_enrichments.json';
const CATEGORIES = ['Mouse', 'Keyboard', 'Headset', 'Microphone', 'Webcam', 'MousePad'];

const CRITICAL_SPECS = {
  Mouse: ['sensor', 'dpi', 'mouseType'],
  Keyboard: ['switches', 'layout'],
  Headset: ['hsType', 'driver', 'mic'],
  Microphone: ['micType', 'pattern'],
  Webcam: ['resolution', 'autofocus'],
  MousePad: ['surface', 'padSize'],
};

const AMAZON_FIELD_MAPS = {
  Mouse: { sensor: ['Movement Detection', 'Sensor', 'Sensor Type', 'Tracking Method'], dpi: ['Mouse Maximum Sensitivity', 'Maximum DPI', 'DPI'], pollingRate: ['Polling Rate', 'Maximum Polling Rate'], weight: ['Item Weight', 'Weight', 'Product Weight'], mouseType: ['Connectivity Technology', 'Connectivity', 'Connection Type', 'Power Source'] },
  Keyboard: { switches: ['Key Switch Type', 'Switch Type', 'Keyboard Description', 'Mechanical Switch'], layout: ['Style', 'Form Factor', 'Number of Keys', 'Keyboard Type', 'Item Shape'], wireless: ['Connectivity Technology', 'Connectivity', 'Connection Type'], rgb: ['Light Color', 'Backlit', 'Backlight', 'Lighting', 'LED Color', 'Embellishment Feature'] },
  Headset: { hsType: ['Connectivity Technology', 'Connectivity', 'Connection Type'], driver: ['Driver Size', 'Speaker Driver Size', 'Driver Diameter'], mic: ['Microphone', 'Microphone Form Factor', 'Microphone Type'], anc: ['Noise Control', 'Active Noise Cancellation', 'Noise Cancelling'] },
  Microphone: { micType: ['Connectivity Technology', 'Connectivity', 'Connector Type', 'Connection Type'], pattern: ['Polar Pattern', 'Pickup Pattern', 'Microphone Form Factor'], sampleRate: ['Sample Rate', 'Sampling Rate'] },
  Webcam: { resolution: ['Image Capture Speed', 'Maximum Image Resolution', 'Video Capture Resolution', 'Resolution'], fps: ['Maximum Frame Rate', 'Frame Rate'], autofocus: ['Special Feature', 'Image Capture Type', 'Autofocus'] },
  MousePad: { surface: ['Material', 'Surface Material', 'Specific Uses For Product'], padSize: ['Size', 'Item Dimensions L x W'] },
};

function flattenProductInfo(productInformation) {
  const flat = {};
  if (!productInformation) return flat;
  for (const section of Array.isArray(productInformation) ? productInformation : []) {
    if (section.type === 'product_information_details_item' && section.body && typeof section.body === 'object') {
      for (const [k, v] of Object.entries(section.body)) flat[k] = v;
    }
    if (Array.isArray(section.contents)) {
      for (const c of section.contents) {
        if (c.body && typeof c.body === 'object' && !Array.isArray(c.body)) {
          for (const [k, v] of Object.entries(c.body)) flat[k] = v;
        }
      }
    }
  }
  return flat;
}

function normalizeValue(field, raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s.toLowerCase() === 'not specified' || s === '-' || s === 'N/A') return null;
  const lower = s.toLowerCase();
  switch (field) {
    case 'sensor': if (s.length > 40) return null; return s.replace(/\b(optical|laser)\b/gi, '').trim() || s;
    case 'dpi': const dpiM = s.match(/(\d{1,3}[,]?\d{0,3})/); if (!dpiM) return null; const dpi = parseInt(dpiM[1].replace(/,/g, '')); return (dpi > 100 && dpi < 100000) ? dpi : null;
    case 'pollingRate': const prM = s.match(/(\d+)/); return prM ? parseInt(prM[1]) : null;
    case 'weight': const wM = s.match(/([\d.]+)\s*(g|gram|grams|oz|ounce|lb|pound)/i); if (!wM) return null; const wVal = parseFloat(wM[1]); const wUnit = wM[2].toLowerCase(); if (wUnit.startsWith('lb')) return Math.round(wVal * 453.6); if (wUnit.startsWith('oz')) return Math.round(wVal * 28.35); return Math.round(wVal);
    case 'mouseType': case 'hsType': case 'micType': if (/wireless|bluetooth|2\.4/i.test(lower)) return 'Wireless'; if (/usb-?c?\b/i.test(lower) && !/cable/i.test(lower)) return 'USB'; if (/xlr/i.test(lower)) return 'XLR'; if (/wired|cable|3\.5mm|corded/i.test(lower)) return 'Wired'; return null;
    case 'wireless': if (/wireless|bluetooth|2\.4/i.test(lower)) return true; if (/wired|corded/i.test(lower)) return false; return null;
    case 'rgb': if (/rgb|chroma|backlit|true|yes|led/i.test(lower)) return true; if (/^no$|^none$|false/i.test(lower)) return false; return null;
    case 'mic': case 'anc': case 'autofocus': if (/yes|true|active|built-?in|integrated|enabled/i.test(lower)) return true; if (/^no$|none|false|disabled/i.test(lower)) return false; return null;
    case 'switches':
      if (/optical/i.test(s)) return 'Optical';
      if (/magnetic|hall/i.test(s)) return 'Hall Effect';
      if (/cherry|gateron|kailh/i.test(s)) { const m = s.match(/(red|blue|brown|black|silver|speed|silent|clear|yellow)/i); return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() : 'Mechanical'; }
      if (/^(red|blue|brown|black|silver|yellow|speed|silent|clear)\b/i.test(s)) { const m = s.match(/(red|blue|brown|black|silver|yellow|speed|silent|clear)/i); return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase(); }
      if (/scissor/i.test(s)) return 'Scissor';
      if (/membrane|mech-?dome/i.test(s)) return 'Membrane';
      if (/mechanical/i.test(s)) return 'Mechanical';
      return null;
    case 'layout': if (/full[\s-]?size|standard|104|108/i.test(s)) return 'Full-Size'; if (/tkl|tenkeyless|87[\s-]?key/i.test(s)) return 'TKL'; if (/75/i.test(s)) return '75%'; if (/65/i.test(s)) return '65%'; if (/60/i.test(s)) return '60%'; if (/96/i.test(s)) return '96%'; return null;
    case 'driver': const dM = s.match(/([\d.]+)\s*mm/i); if (dM) return parseInt(dM[1]); const dn = s.match(/^([\d.]+)$/); return dn ? parseInt(dn[1]) : null;
    case 'pattern': if (/cardioid/i.test(s)) return 'Cardioid'; if (/condenser/i.test(s)) return 'Condenser'; if (/dynamic/i.test(s)) return 'Dynamic'; if (/omnidirectional/i.test(s)) return 'Omnidirectional'; if (/multi-?pattern/i.test(s)) return 'Multi-Pattern'; return null;
    case 'sampleRate': const srM = s.match(/(\d+)\s*k?Hz/i); return srM ? parseInt(srM[1]) : null;
    case 'resolution': if (/4k|2160|3840/.test(s)) return '4K'; if (/1440|qhd|2k\b/i.test(s)) return '1440p'; if (/1080|fhd/i.test(s)) return '1080p'; if (/720|hd\b/i.test(s)) return '720p'; return null;
    case 'fps': const fM = s.match(/(\d+)/); const fps = fM ? parseInt(fM[1]) : null; return (fps && fps > 0 && fps <= 240) ? fps : null;
    case 'surface': if (/cloth|fabric|textile/i.test(s)) return 'Cloth'; if (/hard|aluminum|metal|glass|plastic/i.test(s)) return 'Hard'; if (/hybrid/i.test(s)) return 'Hybrid'; return null;
    case 'padSize': if (/3xl|extended|gigantic/i.test(s)) return 'XXL'; if (/xxl/i.test(s)) return 'XXL'; if (/xl|extra\s*large/i.test(s)) return 'XL'; if (/large/i.test(s)) return 'Large'; if (/medium/i.test(s)) return 'Medium'; if (/small|compact/i.test(s)) return 'Small'; return null;
  }
  return s.length > 50 ? null : s;
}

(async () => {
  // Build candidates by ASIN
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  const enrichments = fs.existsSync(ENRICHMENTS_PATH) ? JSON.parse(fs.readFileSync(ENRICHMENTS_PATH, 'utf8')) : {};

  const asinToCandidate = new Map();
  for (const p of parts) {
    if (!CATEGORIES.includes(p.c)) continue;
    if (!p.deals?.amazon?.url) continue;
    const asinM = p.deals.amazon.url.match(/\/dp\/([A-Z0-9]{10})/);
    if (!asinM) continue;
    asinToCandidate.set(asinM[1], { id: p.id, asin: asinM[1], cat: p.c });
  }
  console.log('Candidates by ASIN: ' + asinToCandidate.size);

  // Drain ALL ready tasks
  console.log('\nFetching ready tasks list...');
  const readyRes = await fetch(BASE + '/merchant/amazon/asin/tasks_ready', { headers: { 'Authorization': AUTH } });
  const readyData = await readyRes.json();
  const readyList = readyData?.tasks?.[0]?.result || [];
  console.log('Ready tasks: ' + readyList.length);

  if (readyList.length === 0) { console.log('No tasks ready'); return; }

  // Fetch each task's result, match by ASIN
  let stats = { fetched: 0, matched: 0, fieldsAdded: 0, byCat: {} };
  for (const cat of CATEGORIES) stats.byCat[cat] = 0;

  const CONCURRENCY = 5;
  for (let i = 0; i < readyList.length; i += CONCURRENCY) {
    const chunk = readyList.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(async (task) => {
      try {
        const res = await fetch('https://api.dataforseo.com' + task.endpoint_advanced, { headers: { 'Authorization': AUTH } });
        const data = await res.json();
        return data?.tasks?.[0]?.result?.[0];
      } catch (e) { return null; }
    }));

    for (const r of results) {
      if (!r) continue;
      stats.fetched++;
      const item = r.items?.[0];
      if (!item) continue;
      const asin = item.data_asin;
      if (!asin) continue;

      const candidate = asinToCandidate.get(asin);
      if (!candidate) continue; // Not one of our accessories

      stats.matched++;
      const flat = flattenProductInfo(item.product_information);
      const enrichmentForId = enrichments[candidate.id] || {};
      const fieldMap = AMAZON_FIELD_MAPS[candidate.cat];
      const part = parts.find(p => p.id === candidate.id);
      const critical = CRITICAL_SPECS[candidate.cat];

      for (const ourField of critical) {
        if (enrichmentForId[ourField] != null) continue;
        if (part && part[ourField] != null) continue;
        const bbFieldList = fieldMap[ourField] || [];
        for (const bbField of bbFieldList) {
          const rawVal = flat[bbField];
          if (rawVal == null) continue;
          const normalized = normalizeValue(ourField, rawVal);
          if (normalized != null && normalized !== '') {
            enrichmentForId[ourField] = normalized;
            stats.fieldsAdded++;
            stats.byCat[candidate.cat]++;
            break;
          }
        }
      }

      if (Object.keys(enrichmentForId).length > 0) enrichments[candidate.id] = enrichmentForId;
    }

    if ((i + CONCURRENCY) % 50 === 0 || i + CONCURRENCY >= readyList.length) {
      console.log('  ' + Math.min(i + CONCURRENCY, readyList.length) + '/' + readyList.length + ' (matched:' + stats.matched + ' fields:' + stats.fieldsAdded + ')');
    }
  }

  console.log('\n═══ DRAIN RESULTS ═══');
  console.log('Total tasks fetched: ' + stats.fetched);
  console.log('Matched accessories: ' + stats.matched);
  console.log('Fields added: ' + stats.fieldsAdded);
  for (const [c, n] of Object.entries(stats.byCat)) console.log('  ' + c.padEnd(14) + ' ' + n);

  fs.writeFileSync(ENRICHMENTS_PATH, JSON.stringify(enrichments, null, 2));
  console.log('\n✓ Run apply-enrichments.cjs to merge into parts.js');
})();
