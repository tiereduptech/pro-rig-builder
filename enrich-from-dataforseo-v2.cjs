// enrich-from-dataforseo-v2.cjs
// Uses tasks_ready pattern - submits ALL tasks, polls for completion list, fetches in parallel
// Much faster than polling each task individually

const fs = require('fs');

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) { console.error('Missing creds'); process.exit(1); }
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
  Mouse: {
    sensor: ['Movement Detection', 'Sensor', 'Sensor Type', 'Tracking Method'],
    dpi: ['Mouse Maximum Sensitivity', 'Maximum DPI', 'DPI'],
    pollingRate: ['Polling Rate', 'Maximum Polling Rate'],
    weight: ['Item Weight', 'Weight', 'Product Weight'],
    mouseType: ['Connectivity Technology', 'Connectivity', 'Connection Type', 'Power Source'],
  },
  Keyboard: {
    switches: ['Key Switch Type', 'Switch Type', 'Keyboard Description', 'Mechanical Switch'],
    layout: ['Style', 'Form Factor', 'Number of Keys', 'Keyboard Type', 'Item Shape'],
    wireless: ['Connectivity Technology', 'Connectivity', 'Connection Type'],
    rgb: ['Light Color', 'Backlit', 'Backlight', 'Lighting', 'LED Color', 'Embellishment Feature'],
  },
  Headset: {
    hsType: ['Connectivity Technology', 'Connectivity', 'Connection Type'],
    driver: ['Driver Size', 'Speaker Driver Size', 'Driver Diameter'],
    mic: ['Microphone', 'Microphone Form Factor', 'Microphone Type'],
    anc: ['Noise Control', 'Active Noise Cancellation', 'Noise Cancelling'],
  },
  Microphone: {
    micType: ['Connectivity Technology', 'Connectivity', 'Connector Type', 'Connection Type'],
    pattern: ['Polar Pattern', 'Pickup Pattern', 'Microphone Form Factor'],
    sampleRate: ['Sample Rate', 'Sampling Rate'],
  },
  Webcam: {
    resolution: ['Image Capture Speed', 'Maximum Image Resolution', 'Video Capture Resolution', 'Resolution'],
    fps: ['Maximum Frame Rate', 'Frame Rate'],
    autofocus: ['Special Feature', 'Image Capture Type', 'Autofocus'],
  },
  MousePad: {
    surface: ['Material', 'Surface Material', 'Specific Uses For Product'],
    padSize: ['Size', 'Item Dimensions L x W'],
  },
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
    case 'sensor':
      if (s.length > 40) return null;
      const cleaned = s.replace(/\b(optical|laser)\b/gi, '').trim();
      return cleaned || s;
    case 'dpi':
      const dpiM = s.match(/(\d{1,3}[,]?\d{0,3})/);
      if (!dpiM) return null;
      const dpi = parseInt(dpiM[1].replace(/,/g, ''));
      return dpi > 100 && dpi < 100000 ? dpi : null;
    case 'pollingRate':
      const prM = s.match(/(\d+)/); return prM ? parseInt(prM[1]) : null;
    case 'weight':
      const wM = s.match(/([\d.]+)\s*(g|gram|grams|oz|ounce|lb|pound)/i);
      if (!wM) return null;
      const wVal = parseFloat(wM[1]);
      const wUnit = wM[2].toLowerCase();
      if (wUnit.startsWith('lb')) return Math.round(wVal * 453.6);
      if (wUnit.startsWith('oz')) return Math.round(wVal * 28.35);
      return Math.round(wVal);
    case 'mouseType': case 'hsType': case 'micType':
      if (/wireless|bluetooth|2\.4/i.test(lower)) return 'Wireless';
      if (/usb-?c?\b/i.test(lower) && !/cable/i.test(lower)) return 'USB';
      if (/xlr/i.test(lower)) return 'XLR';
      if (/wired|cable|3\.5mm|corded/i.test(lower)) return 'Wired';
      return null;
    case 'wireless':
      if (/wireless|bluetooth|2\.4/i.test(lower)) return true;
      if (/wired|corded/i.test(lower)) return false;
      return null;
    case 'rgb':
      if (/rgb|chroma|backlit|true|yes|led/i.test(lower)) return true;
      if (/^no$|^none$|false/i.test(lower)) return false;
      return null;
    case 'mic': case 'anc': case 'autofocus':
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
      if (/membrane|mech-?dome/i.test(s)) return 'Membrane';
      if (/mechanical/i.test(s)) return 'Mechanical';
      return null;
    case 'layout':
      if (/full[\s-]?size|standard|104|108/i.test(s)) return 'Full-Size';
      if (/tkl|tenkeyless|87[\s-]?key/i.test(s)) return 'TKL';
      if (/75/i.test(s)) return '75%';
      if (/65/i.test(s)) return '65%';
      if (/60/i.test(s)) return '60%';
      if (/96/i.test(s)) return '96%';
      return null;
    case 'driver':
      const dM = s.match(/([\d.]+)\s*mm/i); if (dM) return parseInt(dM[1]);
      const dn = s.match(/^([\d.]+)$/); return dn ? parseInt(dn[1]) : null;
    case 'pattern':
      if (/cardioid/i.test(s)) return 'Cardioid';
      if (/condenser/i.test(s)) return 'Condenser';
      if (/dynamic/i.test(s)) return 'Dynamic';
      if (/omnidirectional/i.test(s)) return 'Omnidirectional';
      if (/multi-?pattern/i.test(s)) return 'Multi-Pattern';
      return null;
    case 'sampleRate':
      const srM = s.match(/(\d+)\s*k?Hz/i); return srM ? parseInt(srM[1]) : null;
    case 'resolution':
      if (/4k|2160|3840/.test(s)) return '4K';
      if (/1440|qhd|2k\b/i.test(s)) return '1440p';
      if (/1080|fhd/i.test(s)) return '1080p';
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

  const enrichments = fs.existsSync(ENRICHMENTS_PATH) ? JSON.parse(fs.readFileSync(ENRICHMENTS_PATH, 'utf8')) : {};

  // Find candidates
  const candidates = [];
  const asinToCandidate = new Map();
  for (const p of parts) {
    if (!CATEGORIES.includes(p.c)) continue;
    if (!p.deals?.amazon?.url) continue;
    const asinM = p.deals.amazon.url.match(/\/dp\/([A-Z0-9]{10})/);
    if (!asinM) continue;
    const critical = CRITICAL_SPECS[p.c];
    const enrichmentForId = enrichments[p.id] || {};
    const missing = critical.filter(f => p[f] == null && enrichmentForId[f] == null);
    if (missing.length === 0) continue;
    const c = { id: p.id, asin: asinM[1], cat: p.c, missing };
    candidates.push(c);
    asinToCandidate.set(c.asin, c);
  }

  console.log('Candidates: ' + candidates.length);

  if (process.argv.includes('--dry-run')) {
    candidates.slice(0, 10).forEach(c => console.log('  ' + c.id + ' ' + c.asin + ' ' + c.cat + ' missing=' + c.missing.join(',')));
    return;
  }

  // Submit ALL tasks in batch (DataForSEO supports up to 100 per call)
  console.log('\nSubmitting tasks (' + candidates.length + ' total)...');
  const taskIdToAsin = new Map();
  const BATCH = 100;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH).map(c => ({
      asin: c.asin, location_code: 2840, language_code: 'en_US',
    }));
    try {
      const res = await fetch(BASE + '/merchant/amazon/asin/task_post', {
        method: 'POST',
        headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
      const data = await res.json();
      if (data.tasks) {
        for (const t of data.tasks) {
          if (t.id && t.data?.asin) taskIdToAsin.set(t.id, t.data.asin);
        }
      }
      console.log('  batch ' + (Math.floor(i / BATCH) + 1) + ': ' + (data.tasks?.length || 0) + ' submitted');
    } catch (e) {
      console.log('  batch fail:', e.message);
    }
  }
  console.log('Submitted ' + taskIdToAsin.size + ' tasks');

  if (taskIdToAsin.size === 0) { console.log('No tasks submitted'); return; }

  // Poll tasks_ready until all done OR 10 min timeout
  console.log('\nPolling tasks_ready...');
  const ready = new Set();
  const startTime = Date.now();
  const TIMEOUT = 10 * 60 * 1000; // 10 minutes
  while (ready.size < taskIdToAsin.size && Date.now() - startTime < TIMEOUT) {
    await new Promise(r => setTimeout(r, 8000));
    try {
      const res = await fetch(BASE + '/merchant/amazon/asin/tasks_ready', { headers: { 'Authorization': AUTH } });
      const data = await res.json();
      for (const t of (data?.tasks?.[0]?.result || [])) {
        if (t.id && taskIdToAsin.has(t.id)) ready.add(t.id);
      }
      console.log('  ready: ' + ready.size + '/' + taskIdToAsin.size + ' (' + Math.round((Date.now() - startTime) / 1000) + 's)');
    } catch (e) { console.log('  poll fail:', e.message); }
  }

  // Fetch results in parallel (5 at a time)
  console.log('\nFetching ' + ready.size + ' results...');
  let stats = { fetched: 0, fieldsAdded: 0, byCat: {} };
  for (const cat of CATEGORIES) stats.byCat[cat] = 0;

  const taskIds = [...ready];
  const CONCURRENCY = 5;
  for (let i = 0; i < taskIds.length; i += CONCURRENCY) {
    const chunk = taskIds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(async (taskId) => {
      try {
        const res = await fetch(BASE + '/merchant/amazon/asin/task_get/advanced/' + taskId, { headers: { 'Authorization': AUTH } });
        const data = await res.json();
        return { taskId, result: data?.tasks?.[0]?.result?.[0] };
      } catch (e) { return null; }
    }));

    for (const r of results) {
      if (!r?.result) continue;
      const asin = taskIdToAsin.get(r.taskId);
      const candidate = asinToCandidate.get(asin);
      if (!candidate) continue;
      stats.fetched++;
      const item = r.result.items?.[0];
      if (!item) continue;
      const flat = flattenProductInfo(item.product_information);
      const enrichmentForId = enrichments[candidate.id] || {};
      const fieldMap = AMAZON_FIELD_MAPS[candidate.cat];
      for (const ourField of candidate.missing) {
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
    console.log('  ' + Math.min(i + CONCURRENCY, taskIds.length) + '/' + taskIds.length + ' processed');
  }

  console.log('\n═══ RESULTS ═══');
  console.log('Fetched: ' + stats.fetched);
  for (const [c, n] of Object.entries(stats.byCat)) console.log('  ' + c.padEnd(14) + ' fields:' + n);
  console.log('Total new fields: ' + stats.fieldsAdded);

  fs.writeFileSync(ENRICHMENTS_PATH, JSON.stringify(enrichments, null, 2));
  console.log('\n✓ Saved. Run apply-enrichments.cjs to merge into parts.js');
})();
