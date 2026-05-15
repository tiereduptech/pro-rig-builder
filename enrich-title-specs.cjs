/**
 * enrich-title-specs.cjs
 *
 * Scans every product in catalog and fills missing specs using title patterns.
 * Handles trademark symbols, "Plus" keyword, various title formats.
 * Costs nothing — pure regex.
 *
 * USAGE:
 *   node enrich-title-specs.cjs           # dry run, show counts
 *   node enrich-title-specs.cjs --apply
 */

const fs = require('fs');
const APPLY = process.argv.includes('--apply');

// Strip trademark/special symbols + normalize whitespace
function clean(s) {
  return String(s || '').replace(/[™®©]/g, ' ').replace(/\s+/g, ' ').trim();
}

const enrichers = {
  PSU: (p, t) => {
    const out = {};
    if (!p.watts) {
      const m = t.match(/\b(\d{3,4})\s*W\b/i);
      if (m) out.watts = parseInt(m[1]);
    }
    if (!p.eff) {
      if (/80\s*\+?\s*(plus\s*)?titanium/i.test(t)) out.eff = '80+ Titanium';
      else if (/80\s*\+?\s*(plus\s*)?platinum/i.test(t)) out.eff = '80+ Platinum';
      else if (/80\s*\+?\s*(plus\s*)?gold/i.test(t)) out.eff = '80+ Gold';
      else if (/80\s*\+?\s*(plus\s*)?silver/i.test(t)) out.eff = '80+ Silver';
      else if (/80\s*\+?\s*(plus\s*)?bronze/i.test(t)) out.eff = '80+ Bronze';
      else if (/80\s*\+?\s*(plus\s*)?white/i.test(t)) out.eff = '80+ White';
    }
    if (!p.modular) {
      if (/fully\s*modular/i.test(t)) out.modular = 'Full';
      else if (/semi[\s\-]?modular/i.test(t)) out.modular = 'Semi';
      else if (/non[\s\-]?modular/i.test(t)) out.modular = 'None';
      else if (/\bmodular\b/i.test(t)) out.modular = 'Full';
    }
    if (!p.ff) {
      if (/\bsfx[\s\-]?l\b/i.test(t)) out.ff = 'SFX-L';
      else if (/\bsfx\b/i.test(t)) out.ff = 'SFX';
      else if (/\bflex\s*atx\b/i.test(t)) out.ff = 'Flex ATX';
      else if (/\batx\b/i.test(t)) out.ff = 'ATX';
    }
    if (!p.atx3 && /atx\s*3\.[01]/i.test(t)) out.atx3 = true;
    return out;
  },
  CPU: (p, t) => {
    const out = {};
    if (!p.cores) {
      const m = t.match(/(\d+)[\s\-]*cores?\b/i);
      if (m) out.cores = parseInt(m[1]);
    }
    if (!p.threads) {
      const m = t.match(/(\d+)[\s\-]*threads?\b/i);
      if (m) out.threads = parseInt(m[1]);
    }
    if (!p.socket) {
      const m = t.match(/\b(LGA\s?\d+|AM[45])\b/i);
      if (m) out.socket = m[1].replace(/\s/g, '').toUpperCase();
      else if (/Ryzen\s*\d\s*[789]\d{3}\b/i.test(t)) out.socket = 'AM5';
      else if (/Ryzen\s*\d\s*[1-5]\d{3}\b/i.test(t)) out.socket = 'AM4';
      else if (/Core\s*Ultra/i.test(t)) out.socket = 'LGA1851';
      else if (/Core\s*i\d[\s\-]*1[2-4]\d{3}/i.test(t)) out.socket = 'LGA1700';
      else if (/Core\s*i\d[\s\-]*1[01]\d{3}/i.test(t)) out.socket = 'LGA1200';
      else if (/Core\s*i\d[\s\-]*[89]\d{3}/i.test(t)) out.socket = 'LGA1151';
    }
    if (!p.tdp) {
      const m = t.match(/(\d{2,3})\s*W\s+TDP/i) || t.match(/TDP[\s:]*(\d{2,3})/i);
      if (m) out.tdp = parseInt(m[1]);
    }
    if (!p.boostClock) {
      const m = t.match(/up to\s*(\d+\.?\d*)\s*GHz/i) || t.match(/boost[:\s]*(\d+\.?\d*)\s*GHz/i);
      if (m) out.boostClock = parseFloat(m[1]);
    }
    if (p.vcache == null && /X3D\b/i.test(t)) out.vcache = true;
    if (p.igpu == null) {
      // Ryzen G suffix or non-F Intel = has iGPU
      if (/Ryzen\s*\d\s*\d+G\b/i.test(t)) out.igpu = true;
      else if (/Core\s*Ultra/i.test(t)) out.igpu = true;
      else if (/i\d[\s\-]*\d+(KF|F)\b/i.test(t)) out.igpu = false;
      else if (/i\d[\s\-]*\d+[K]?\b/i.test(t)) out.igpu = true;
    }
    return out;
  },
  GPU: (p, t) => {
    const out = {};
    if (!p.vram) {
      const m = t.match(/\b(\d+)\s*GB\s*(GDDR|VRAM|video|memory)/i);
      if (m) out.vram = parseInt(m[1]);
    }
    if (!p.memType) {
      const m = t.match(/GDDR(\d+X?)/i);
      if (m) out.memType = 'GDDR' + m[1].toUpperCase();
    }
    return out;
  },
  RAM: (p, t) => {
    const out = {};
    if (!p.cap) {
      const m = t.match(/\b(\d+)\s*GB\s*kit/i) || t.match(/\b(\d+)\s*GB\s*\(/i);
      if (m) out.cap = parseInt(m[1]);
    }
    if (!p.sticks) {
      const m = t.match(/\((\d+)\s*x\s*\d+\s*gb\)/i);
      if (m) out.sticks = parseInt(m[1]);
    }
    if (!p.speed) {
      const m = t.match(/\b(\d{4})\s*(MHz|MT\/s|MT)\b/i);
      if (m) out.speed = parseInt(m[1]);
    }
    if (!p.cl) {
      const m = t.match(/\bCL\s?(\d+)/i);
      if (m) out.cl = parseInt(m[1]);
    }
    if (!p.memType) {
      if (/ddr5/i.test(t)) out.memType = 'DDR5';
      else if (/ddr4/i.test(t)) out.memType = 'DDR4';
      else if (/ddr3/i.test(t)) out.memType = 'DDR3';
    }
    if (!p.formFactor) {
      if (/\bsodimm\b/i.test(t)) out.formFactor = 'SODIMM';
      else if (/\budimm\b/i.test(t)) out.formFactor = 'UDIMM';
      else out.formFactor = 'DIMM';
    }
    if (p.ecc == null && /\becc\b/i.test(t)) out.ecc = true;
    if (p.rgb == null && /\brgb\b/i.test(t)) out.rgb = true;
    return out;
  },
  Storage: (p, t) => {
    const out = {};
    if (!p.cap) {
      const m = t.match(/\b(\d+)\s*(TB|GB)\b/i);
      if (m) {
        const v = parseInt(m[1]);
        out.cap = m[2].toLowerCase() === 'tb' ? v * 1000 : v;
      }
    }
    if (!p.storageType) {
      if (/\bnvme\b/i.test(t)) out.storageType = 'NVMe';
      else if (/\bhdd\b|hard\s*(disk|drive)/i.test(t)) out.storageType = 'HDD';
      else if (/\bssd\b/i.test(t)) out.storageType = 'SSD';
    }
    if (!p.interface) {
      if (/\bnvme\b/i.test(t)) out.interface = 'NVMe';
      else if (/\bsata\b/i.test(t)) out.interface = 'SATA';
      else if (/\busb\b/i.test(t) && /external/i.test(t)) out.interface = 'USB';
    }
    if (!p.pcie) {
      const m = t.match(/PCIe\s*(?:gen)?\s*([3-5])/i);
      if (m) out.pcie = parseInt(m[1]);
    }
    return out;
  },
  Motherboard: (p, t) => {
    const out = {};
    if (!p.socket) {
      const m = t.match(/\b(LGA\s?\d+|AM[45])\b/i);
      if (m) out.socket = m[1].replace(/\s/g, '').toUpperCase();
    }
    if (!p.chipset) {
      const m = t.match(/\b([XBHAZ]\d{3,4}E?)\b/);
      if (m && !/AM[45]/i.test(m[1])) out.chipset = m[1].toUpperCase();
    }
    if (!p.ff) {
      if (/e[\s\-]?atx/i.test(t)) out.ff = 'E-ATX';
      else if (/\bmicro[\s\-]?atx\b|\bm[\-\s]?atx\b/i.test(t)) out.ff = 'mATX';
      else if (/mini[\s\-]?itx/i.test(t)) out.ff = 'mITX';
      else if (/\batx\b/i.test(t)) out.ff = 'ATX';
    }
    if (!p.memType) {
      if (/ddr5/i.test(t)) out.memType = 'DDR5';
      else if (/ddr4/i.test(t)) out.memType = 'DDR4';
    }
    if (!p.wifi) {
      if (/wi[\-\s]?fi\s*7|wifi7/i.test(t)) out.wifi = 'WiFi 7';
      else if (/wi[\-\s]?fi\s*6[eE]|wifi6e/i.test(t)) out.wifi = 'WiFi 6E';
      else if (/wi[\-\s]?fi\s*6|wifi6/i.test(t)) out.wifi = 'WiFi 6';
      else if (/wi[\-\s]?fi/i.test(t)) out.wifi = 'WiFi';
      else out.wifi = 'None';
    }
    return out;
  },
  Case: (p, t) => {
    const out = {};
    if (!p.ff) {
      if (/full[\s\-]?tower/i.test(t)) out.ff = 'Full Tower';
      else if (/mid[\s\-]?tower/i.test(t)) out.ff = 'Mid Tower';
      else if (/mini[\s\-]?tower|\bsff\b/i.test(t)) out.ff = 'Mini Tower';
      else if (/mini[\s\-]?itx/i.test(t)) out.ff = 'Mini-ITX';
    }
    if (!Array.isArray(p.mobo)) {
      const mobo = [];
      if (/e[\s\-]?atx/i.test(t)) mobo.push('E-ATX');
      if (/\batx\b/i.test(t) && !/eatx|e[\s\-]atx/i.test(t)) mobo.push('ATX');
      if (/\b(matx|micro[\s\-]?atx|m[\-\s]?atx)\b/i.test(t)) mobo.push('mATX');
      if (/\b(mini[\s\-]?itx|mitx|\bitx)\b/i.test(t)) mobo.push('mITX');
      if (mobo.length) out.mobo = mobo;
    }
    if (p.tg == null && /tempered\s*glass/i.test(t)) out.tg = true;
    if (p.usb_c == null && /usb[\s\-]?c|type[\s\-]?c/i.test(t)) out.usb_c = true;
    if (p.rgb == null && /\b(argb|rgb)\b/i.test(t)) out.rgb = true;
    return out;
  },
  CPUCooler: (p, t) => {
    const out = {};
    if (!p.coolerType) {
      if (/\baio\b|liquid\s*cool|all[\s\-]?in[\s\-]?one\s*(liquid|cooler)/i.test(t)) out.coolerType = 'AIO';
      else if (/air\s*cooler|tower\s*cooler|low[\s\-]?profile|heatsink/i.test(t)) out.coolerType = 'Air';
    }
    if (!p.radSize && out.coolerType === 'AIO') {
      const m = t.match(/(\d{3})\s*mm/i);
      if (m) out.radSize = parseInt(m[1]);
    }
    if (!p.fans) {
      const m = t.match(/(\d+)[\s\-]?fans?\b/i);
      if (m) out.fans = parseInt(m[1]);
    }
    return out;
  },
  CaseFan: (p, t) => {
    const out = {};
    if (!p.fanSize) {
      const m = t.match(/\b(120|140|200|92|80)\s*mm/i);
      if (m) out.fanSize = parseInt(m[1]);
    }
    if (!p.fans_inc) {
      const m = t.match(/(\d+)[\s\-]?pack/i);
      if (m) out.fans_inc = parseInt(m[1]);
    }
    if (p.pwm == null && /\bpwm\b/i.test(t)) out.pwm = true;
    if (p.rgb == null && /\b(argb|rgb)\b/i.test(t)) out.rgb = true;
    return out;
  },
  Monitor: (p, t) => {
    const out = {};
    if (!p.screenSize) {
      const m = t.match(/\b(\d{2,3})(?:[\s\-]?inch|")/i);
      if (m) out.screenSize = parseInt(m[1]);
    }
    if (!p.resolution) {
      if (/\b4k\b|3840[\s×x]2160|uhd/i.test(t)) out.resolution = '4K';
      else if (/\b1440p\b|qhd|2560[\s×x]1440/i.test(t)) out.resolution = '1440p';
      else if (/\b1080p\b|fhd|1920[\s×x]1080/i.test(t)) out.resolution = '1080p';
    }
    if (!p.refresh) {
      const m = t.match(/(\d{2,3})\s*Hz/i);
      if (m) out.refresh = parseInt(m[1]);
    }
    if (!p.panel) {
      if (/\boled\b/i.test(t)) out.panel = 'OLED';
      else if (/\bips\b/i.test(t)) out.panel = 'IPS';
      else if (/\bva\b/i.test(t)) out.panel = 'VA';
      else if (/\btn\b/i.test(t)) out.panel = 'TN';
    }
    if (p.curved == null && /\bcurved\b/i.test(t)) out.curved = true;
    return out;
  },
};

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...m.PARTS];

  const stats = {};
  const fieldCounts = {};
  let totalFilled = 0;

  for (const p of parts) {
    const enricher = enrichers[p.c];
    if (!enricher) continue;
    const title = clean(p.n);
    const newSpecs = enricher(p, title);
    const fields = Object.keys(newSpecs);
    if (!fields.length) continue;

    stats[p.c] = (stats[p.c] || 0) + 1;
    for (const f of fields) {
      fieldCounts[p.c + '.' + f] = (fieldCounts[p.c + '.' + f] || 0) + 1;
    }
    if (APPLY) Object.assign(p, newSpecs);
    totalFilled += fields.length;
  }

  console.log('Mode:', APPLY ? 'APPLY' : 'DRY RUN');
  console.log('Total products enriched:', Object.values(stats).reduce((a,b)=>a+b,0));
  console.log('Total spec fields filled:', totalFilled);
  console.log('\nBy category:');
  Object.entries(stats).sort((a,b) => b[1] - a[1]).forEach(([c,n]) => console.log('  ' + c + ': ' + n));
  console.log('\nTop field fills:');
  Object.entries(fieldCounts).sort((a,b) => b[1] - a[1]).slice(0, 25).forEach(([k,v]) => console.log('  ' + k + ': ' + v));

  if (APPLY) {
    const header = '// Auto-merged catalog. Edit with care.\n';
    const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
    fs.writeFileSync('src/data/parts.js', header + body, 'utf8');
    console.log('\nApplied.');
  }
})();
