/**
 * backfill-discovery-specs.cjs
 *
 * For each product added via Amazon discovery (source='amazon-discovery'),
 * fetches the FULL product detail page (with "Product Information" specs)
 * via DataForSEO Amazon ASIN endpoint, then extracts and writes specs
 * (watts, socket, cores, vram, capacity, etc.) into the product entry.
 *
 * USAGE:
 *   railway run node backfill-discovery-specs.cjs           # dry run
 *   railway run node backfill-discovery-specs.cjs --apply
 *
 * COST: ~$0.003 per product × 831 products = ~$2.50
 */

const fs = require('fs');
const { ramAttributes } = require('./catalog-classify.cjs');

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) { console.error('Missing creds'); process.exit(1); }
const AUTH = 'Basic ' + Buffer.from(LOGIN + ':' + PASSWORD).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

const APPLY = process.argv.includes('--apply');
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0') || null;

// Flatten Amazon "product_information" sections to a flat key→value map
function flattenProductInfo(productInformation) {
  const flat = {};
  if (!productInformation) return flat;
  for (const section of Array.isArray(productInformation) ? productInformation : []) {
    if (section.type === 'product_information_details_item' && section.body && typeof section.body === 'object') {
      for (const [k, v] of Object.entries(section.body)) flat[k.toLowerCase()] = String(v).trim();
    }
    if (Array.isArray(section.contents)) {
      for (const c of section.contents) {
        if (c.body && typeof c.body === 'object' && !Array.isArray(c.body)) {
          for (const [k, v] of Object.entries(c.body)) flat[k.toLowerCase()] = String(v).trim();
        }
      }
    }
  }
  return flat;
}

// Look up a value across multiple possible Amazon field names
function lookupField(flat, ...keys) {
  for (const k of keys) {
    const lk = k.toLowerCase();
    if (flat[lk]) return flat[lk];
    // also try partial matches
    for (const fk of Object.keys(flat)) {
      if (fk.includes(lk)) return flat[fk];
    }
  }
  return null;
}

function parseInt2(s) {
  if (s == null) return null;
  const m = String(s).match(/\d+/);
  return m ? parseInt(m[0]) : null;
}
function parseFloat2(s) {
  if (s == null) return null;
  const m = String(s).match(/\d+\.?\d*/);
  return m ? parseFloat(m[0]) : null;
}

// Extract specs based on category, using both Amazon product_information AND title patterns
function extractSpecs(product, flat) {
  const cat = product.c;
  const title = product.n || '';
  const t = title.toLowerCase();
  const specs = {};

  if (cat === 'PSU') {
    // Watts
    let w = lookupField(flat, 'wattage', 'output wattage', 'maximum power');
    if (w) specs.watts = parseInt2(w);
    if (!specs.watts) {
      const m = title.match(/\b(\d{3,4})\s*W\b/i);
      if (m) specs.watts = parseInt(m[1]);
    }
    // Efficiency
    if (/80\+?\s*titanium/i.test(title)) specs.eff = '80+ Titanium';
    else if (/80\+?\s*platinum/i.test(title)) specs.eff = '80+ Platinum';
    else if (/80\+?\s*gold/i.test(title)) specs.eff = '80+ Gold';
    else if (/80\+?\s*silver/i.test(title)) specs.eff = '80+ Silver';
    else if (/80\+?\s*bronze/i.test(title)) specs.eff = '80+ Bronze';
    else if (/80\+?\s*white/i.test(title)) specs.eff = '80+ White';
    // Modularity
    if (/fully modular/i.test(title)) specs.modular = 'Full';
    else if (/semi.?modular/i.test(title)) specs.modular = 'Semi';
    else if (/non.?modular/i.test(title)) specs.modular = 'None';
    // ATX 3.0/3.1
    if (/atx\s*3\.[01]/i.test(title)) specs.atx3 = true;
    // Form factor
    if (/\bsfx\b/i.test(title) && /\bsfx[\s\-]?l\b/i.test(title)) specs.ff = 'SFX-L';
    else if (/\bsfx\b/i.test(title)) specs.ff = 'SFX';
    else if (/\bflex\s*atx\b/i.test(title)) specs.ff = 'Flex ATX';
    else if (/\batx\b/i.test(title)) specs.ff = 'ATX';
  }

  if (cat === 'CPU') {
    // Cores
    let cores = lookupField(flat, 'number of cores', 'core count', 'cpu cores');
    if (cores) specs.cores = parseInt2(cores);
    if (!specs.cores) {
      const m = title.match(/(\d+)[\s-]*core/i);
      if (m) specs.cores = parseInt(m[1]);
    }
    // Threads
    let threads = lookupField(flat, 'number of threads', 'thread count');
    if (threads) specs.threads = parseInt2(threads);
    if (!specs.threads) {
      const m = title.match(/(\d+)[\s-]*thread/i);
      if (m) specs.threads = parseInt(m[1]);
    }
    // Socket
    let sock = lookupField(flat, 'cpu socket', 'socket', 'socket type');
    if (sock) {
      const m = sock.match(/(LGA\s?\d+|AM[45]|sTRX\d|sWRX\d|TR\d|FM\d)/i);
      if (m) specs.socket = m[1].replace(/\s/g, '').toUpperCase();
    }
    if (!specs.socket) {
      const m = title.match(/\b(LGA\s?\d+|AM[45])\b/i);
      if (m) specs.socket = m[1].replace(/\s/g, '').toUpperCase();
      // Heuristic: Ryzen 7000/8000/9000 → AM5, Ryzen 1000-5000 → AM4
      else if (/Ryzen\s*[789]\s*[7-9]\d{3}/i.test(title)) specs.socket = 'AM5';
      else if (/Ryzen\s*[3579]\s*[1-5]\d{3}/i.test(title)) specs.socket = 'AM4';
      else if (/Ryzen\s*Threadripper.*7\d{3}/i.test(title)) specs.socket = 'sTR5';
      // Intel: 12th-14th gen → LGA1700, Core Ultra → LGA1851, 10/11th → LGA1200
      else if (/Core\s*Ultra/i.test(title)) specs.socket = 'LGA1851';
      else if (/Core\s*i\d-1[2-4]\d{3}/i.test(title)) specs.socket = 'LGA1700';
      else if (/Core\s*i\d-1[01]\d{3}/i.test(title)) specs.socket = 'LGA1200';
      else if (/Core\s*i\d-[89]\d{3}/i.test(title)) specs.socket = 'LGA1151';
    }
    // TDP
    let tdp = lookupField(flat, 'wattage', 'tdp');
    if (tdp) specs.tdp = parseInt2(tdp);
    if (!specs.tdp) {
      const m = title.match(/(\d{2,3})\s*W\b/i);
      if (m) specs.tdp = parseInt(m[1]);
    }
    // Boost clock
    const boost = title.match(/up to\s*(\d+\.?\d*)\s*GHz/i);
    if (boost) specs.boostClock = parseFloat(boost[1]);
  }

  if (cat === 'GPU') {
    // VRAM (in GB, never MB)
    let vram = lookupField(flat, 'graphics ram size', 'graphics memory', 'vram');
    if (vram) {
      const v = parseInt2(vram);
      if (v) specs.vram = v > 100 ? Math.round(v / 1024) : v; // convert MB to GB if needed
    }
    if (!specs.vram) {
      const m = title.match(/(\d+)\s*GB\s*(GDDR|VRAM|video)/i);
      if (m) specs.vram = parseInt(m[1]);
    }
    // Memory type
    const mem = title.match(/GDDR(\d+X?)/i);
    if (mem) specs.memType = 'GDDR' + mem[1].toUpperCase();
  }

  if (cat === 'RAM') {
    // Capacity (total kit, not per-stick)
    let cap = lookupField(flat, 'computer memory size', 'memory size', 'ram size');
    if (cap) specs.cap = parseInt2(cap);
    if (!specs.cap) {
      const m = title.match(/(\d+)\s*GB\s*\(/i) || title.match(/(\d+)\s*GB\s*kit/i);
      if (m) specs.cap = parseInt(m[1]);
    }
    // Sticks count
    const sticks = title.match(/\((\d+)\s*x\s*\d+gb\)/i);
    if (sticks) specs.sticks = parseInt(sticks[1]);
    // Speed
    let speed = lookupField(flat, 'memory speed', 'ram memory technology', 'speed');
    if (speed) specs.speed = parseInt2(speed);
    if (!specs.speed) {
      const m = title.match(/(\d{4})\s*(MHz|MT)/i);
      if (m) specs.speed = parseInt(m[1]);
    }
    // CL
    const cl = title.match(/\bCL\s?(\d+)/i);
    if (cl) specs.cl = parseInt(cl[1]);
    // Type
    if (/ddr5/i.test(title)) specs.memType = 'DDR5';
    else if (/ddr4/i.test(title)) specs.memType = 'DDR4';
    else if (/ddr3/i.test(title)) specs.memType = 'DDR3';
    // Form factor
    if (/sodimm/i.test(title)) specs.formFactor = 'SODIMM';
    else if (/udimm/i.test(title)) specs.formFactor = 'UDIMM';
    else specs.formFactor = 'DIMM';
    // ECC — negation-aware detector (bare "ECC" inside "Non-ECC" must not count)
    if (ramAttributes(title).ecc) specs.ecc = true;
    // RGB
    if (/\brgb\b/i.test(title)) specs.rgb = true;
  }

  if (cat === 'Storage') {
    // Capacity (in GB; 1TB = 1000GB)
    const m = title.match(/(\d+)\s*(TB|GB)/i);
    if (m) {
      const size = parseInt(m[1]);
      specs.cap = m[2].toLowerCase() === 'tb' ? size * 1000 : size;
    }
    // Type
    if (/\bnvme\b/i.test(title)) { specs.storageType = 'NVMe'; specs.interface = 'NVMe'; }
    else if (/\bhdd\b|hard drive|hard disk/i.test(title)) { specs.storageType = 'HDD'; specs.interface = 'SATA'; }
    else if (/\bssd\b/i.test(title)) { specs.storageType = 'SSD'; specs.interface = 'SATA'; }
    // PCIe gen
    const pcie = title.match(/PCIe\s*(?:Gen)?\s*([3-5])/i);
    if (pcie) specs.pcie = parseInt(pcie[1]);
    // Form factor
    if (/m\.?2\s*2280/i.test(title)) specs.ff = 'M.2 2280';
    else if (/m\.?2\s*2230/i.test(title)) specs.ff = 'M.2 2230';
    else if (/2\.5["\s]?inch/i.test(title) || /2\.5"/i.test(title)) specs.ff = '2.5"';
    else if (/3\.5["\s]?inch/i.test(title) || /3\.5"/i.test(title)) specs.ff = '3.5"';
  }

  if (cat === 'Motherboard') {
    // Socket
    let sock = lookupField(flat, 'cpu socket', 'socket type');
    if (sock) {
      const m = sock.match(/(LGA\s?\d+|AM[45]|sTRX\d|TR\d)/i);
      if (m) specs.socket = m[1].replace(/\s/g, '').toUpperCase();
    }
    if (!specs.socket) {
      const m = title.match(/\b(LGA\s?\d+|AM[45])\b/i);
      if (m) specs.socket = m[1].replace(/\s/g, '').toUpperCase();
    }
    // Chipset
    const chipset = title.match(/\b([XBHAZ]\d{3,4}E?|TRX\d+|WRX\d+)\b/);
    if (chipset && !/AM[45]/i.test(chipset[1])) specs.chipset = chipset[1].toUpperCase();
    // Form factor
    if (/e[\s\-]?atx/i.test(title)) specs.ff = 'E-ATX';
    else if (/\bmicro[\s\-]?atx\b|\bm[\-\s]?atx\b/i.test(title)) specs.ff = 'mATX';
    else if (/mini[\s\-]?itx/i.test(title)) specs.ff = 'mITX';
    else if (/\batx\b/i.test(title)) specs.ff = 'ATX';
    // Memory type
    if (/ddr5/i.test(title)) specs.memType = 'DDR5';
    else if (/ddr4/i.test(title)) specs.memType = 'DDR4';
    // WiFi
    if (/wi[\-\s]?fi\s*7|wifi7/i.test(title)) specs.wifi = 'WiFi 7';
    else if (/wi[\-\s]?fi\s*6[eE]|wifi6e/i.test(title)) specs.wifi = 'WiFi 6E';
    else if (/wi[\-\s]?fi\s*6|wifi6/i.test(title)) specs.wifi = 'WiFi 6';
    else if (/wi[\-\s]?fi/i.test(title)) specs.wifi = 'WiFi';
    else specs.wifi = 'None';
  }

  if (cat === 'Case') {
    // Form factor support
    if (/e[\s\-]?atx/i.test(title) && /full[\s\-]?tower/i.test(title)) specs.ff = 'Full Tower';
    else if (/full[\s\-]?tower/i.test(title)) specs.ff = 'Full Tower';
    else if (/mid[\s\-]?tower/i.test(title)) specs.ff = 'Mid Tower';
    else if (/mini[\s\-]?tower/i.test(title) || /\bsff\b/i.test(title)) specs.ff = 'Mini Tower';
    else if (/mini[\s\-]?itx/i.test(title)) specs.ff = 'Mini-ITX';
    // Mobo support array
    const mobo = [];
    if (/e[\s\-]?atx/i.test(title)) mobo.push('E-ATX');
    if (/\batx\b/i.test(title)) mobo.push('ATX');
    if (/\b(matx|micro[\s\-]?atx|m[\-\s]?atx)\b/i.test(title)) mobo.push('mATX');
    if (/\b(mini[\s\-]?itx|mitx|itx)\b/i.test(title)) mobo.push('mITX');
    if (mobo.length) specs.mobo = mobo;
    // Tempered glass
    if (/tempered glass/i.test(title)) specs.tg = true;
    // USB-C
    if (/usb[\s\-]?c|type[\s\-]?c/i.test(title)) specs.usb_c = true;
    // GPU clearance
    const gpu = title.match(/(\d{3})\s*mm.*GPU|GPU.*?(\d{3})\s*mm/i);
    if (gpu) specs.maxGPU = parseInt(gpu[1] || gpu[2]);
  }

  if (cat === 'CPUCooler') {
    // Type
    if (/\baio\b|liquid cool|all.?in.?one/i.test(title)) specs.coolerType = 'AIO';
    else if (/air cooler|tower cooler|low.?profile/i.test(title)) specs.coolerType = 'Air';
    // Radiator size for AIO
    if (specs.coolerType === 'AIO') {
      const rad = title.match(/(\d{3})\s*mm\s*(radiator|aio)?/i);
      if (rad) specs.radSize = parseInt(rad[1]);
    }
    // TDP rating
    const tdp = title.match(/(\d+)\s*W\b/i);
    if (tdp) specs.tdp_rating = parseInt(tdp[1]);
  }

  if (cat === 'CaseFan') {
    // Size
    const size = title.match(/\b(120|140|200|92|80)\s*mm/i);
    if (size) specs.fanSize = parseInt(size[1]);
    // Multi-pack
    const pack = title.match(/(\d+)[\s\-]?pack/i);
    if (pack) specs.fans_inc = parseInt(pack[1]);
    // PWM
    if (/\bpwm\b/i.test(title)) specs.pwm = true;
    // RGB
    if (/argb|rgb/i.test(title)) specs.rgb = true;
  }

  if (cat === 'Monitor') {
    // Size
    const size = title.match(/(\d{2,3})[\s\-]?inch|"(\d{2})/i);
    if (size) specs.screenSize = parseInt(size[1] || size[2]);
    // Resolution
    if (/4k|3840[\s×x]2160|uhd/i.test(title)) specs.resolution = '4K';
    else if (/1440p|qhd|2560[\s×x]1440/i.test(title)) specs.resolution = '1440p';
    else if (/1080p|fhd|1920[\s×x]1080/i.test(title)) specs.resolution = '1080p';
    // Refresh
    const refresh = title.match(/(\d{2,3})\s*Hz/i);
    if (refresh) specs.refresh = parseInt(refresh[1]);
    // Panel
    if (/\boled\b/i.test(title)) specs.panel = 'OLED';
    else if (/\bips\b/i.test(title)) specs.panel = 'IPS';
    else if (/\bva\b/i.test(title)) specs.panel = 'VA';
    else if (/\btn\b/i.test(title)) specs.panel = 'TN';
    // Curved
    if (/curved/i.test(title)) specs.curved = true;
  }

  return specs;
}

async function postBatch(asins) {
  const body = asins.map(asin => ({
    asin,
    location_code: 2840,
    language_code: 'en_US',
    se_domain: 'amazon.com',
    priority: 1,
    tag: 'spec-' + asin,
  }));
  const res = await fetch(BASE + '/merchant/amazon/asin/task_post', {
    method: 'POST',
    headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.status_code !== 20000) throw new Error('post failed: ' + JSON.stringify(data));
  return data.tasks.map(t => t.id);
}

async function getResult(taskId) {
  const res = await fetch(BASE + '/merchant/amazon/asin/task_get/advanced/' + taskId, {
    headers: { 'Authorization': AUTH },
  });
  const data = await res.json();
  if (data.status_code !== 20000) return null;
  const task = data.tasks?.[0];
  if (!task || task.status_code !== 20000) return null;
  return task.result?.[0];
}

async function waitForTasks(taskIds, timeoutMs = 600000) {
  const start = Date.now();
  const results = new Map();
  const remaining = new Set(taskIds);
  while (remaining.size > 0 && (Date.now() - start) < timeoutMs) {
    for (const id of [...remaining]) {
      try {
        const result = await getResult(id);
        if (result) { results.set(id, result); remaining.delete(id); }
      } catch (e) {}
    }
    if (remaining.size > 0) {
      process.stdout.write('.');
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.log();
  return results;
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...m.PARTS];

  let targets = parts.filter(p => p.source === 'amazon-discovery');
  console.log('Mode:', APPLY ? 'APPLY' : 'DRY RUN');
  console.log('Discovery products:', targets.length);
  if (LIMIT) {
    targets = targets.slice(0, LIMIT);
    console.log('Limited to:', targets.length);
  }
  console.log('Estimated cost: $' + (targets.length * 0.003).toFixed(2));

  if (targets.length === 0) return;

  // Submit in batches of 50
  const BATCH = 50;
  const taskMap = new Map(); // taskId -> product

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const asins = batch.map(p => p.deals?.amazon?.asin).filter(Boolean);
    if (!asins.length) continue;
    process.stdout.write('Posting batch ' + (Math.floor(i/BATCH)+1) + ' (' + asins.length + ' tasks)... ');
    const ids = await postBatch(asins);
    ids.forEach((id, idx) => taskMap.set(id, batch[idx]));
    console.log('done');
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('Total tasks:', taskMap.size);
  console.log('Waiting 20s before polling...');
  await new Promise(r => setTimeout(r, 20000));

  process.stdout.write('Polling');
  const results = await waitForTasks([...taskMap.keys()]);
  console.log('Got results for:', results.size, '/', taskMap.size);

  // Process results, extract specs
  const stats = { withSpecs: 0, empty: 0, byCategory: {} };
  for (const [taskId, result] of results) {
    const product = taskMap.get(taskId);
    if (!product) continue;
    const item = result.items?.[0];
    if (!item) { stats.empty++; continue; }

    const flat = flattenProductInfo(item.product_information);
    const specs = extractSpecs(product, flat);
    const numSpecs = Object.keys(specs).length;

    if (numSpecs === 0) { stats.empty++; continue; }
    stats.withSpecs++;
    stats.byCategory[product.c] = (stats.byCategory[product.c] || 0) + 1;

    if (APPLY) {
      Object.assign(product, specs);
      // Image upgrade if Amazon has better one
      if (item.image_url && (!product.img || product.img === null)) product.img = item.image_url;
    }
  }

  console.log('\n--- BACKFILL RESULTS ---');
  console.log('Products with new specs:', stats.withSpecs);
  console.log('No specs extracted:', stats.empty);
  console.log('\nBy category:');
  Object.entries(stats.byCategory).sort((a,b) => b[1] - a[1]).forEach(([c, n]) => console.log('  ' + c + ': ' + n));

  if (APPLY) {
    const header = '// Auto-merged catalog. Edit with care.\n';
    const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
    fs.writeFileSync('src/data/parts.js', header + body, 'utf8');
    console.log('\nApplied: specs backfilled for ' + stats.withSpecs + ' products');
  }
})();
