// enrich-monitor-specs.cjs
// Extracts HDR, Sync, Ports from monitor names + brand model patterns

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

function extractHDR(p) {
  const text = (p.n + ' ' + (p.b || '')).toLowerCase();
  // Specific HDR levels first
  if (/hdr[\s-]?(?:true black )?1000|hdr[\s-]?1400/i.test(text)) return 'HDR1000';
  if (/hdr[\s-]?true black 400/i.test(text)) return 'HDR True Black 400';
  if (/hdr[\s-]?600/i.test(text)) return 'HDR600';
  if (/hdr[\s-]?500/i.test(text)) return 'HDR500';
  if (/hdr[\s-]?400/i.test(text)) return 'HDR400';
  if (/hdr[\s-]?10\b/i.test(text)) return 'HDR10';
  if (/displayhdr/i.test(text)) return 'HDR400';
  if (/hdr/i.test(text)) return 'HDR'; // generic mention
  // OLED monitors generally have HDR True Black
  if (/oled|qd[- ]?oled/i.test(text)) return 'HDR True Black 400';
  return null;
}

function extractSync(p) {
  const text = (p.n + ' ' + (p.b || '')).toLowerCase();
  if (/g[-\s]?sync ultimate/i.test(text)) return 'G-Sync Ultimate';
  if (/g[-\s]?sync compatible/i.test(text)) return 'G-Sync Compatible';
  if (/g[-\s]?sync/i.test(text)) return 'G-Sync';
  if (/freesync premium pro/i.test(text)) return 'FreeSync Premium Pro';
  if (/freesync premium/i.test(text)) return 'FreeSync Premium';
  if (/freesync/i.test(text)) return 'FreeSync';
  if (/adaptive[-\s]?sync/i.test(text)) return 'Adaptive Sync';
  // Most modern gaming monitors >= 144Hz support FreeSync at minimum
  const refresh = p.refresh || 0;
  if (refresh >= 240) return 'FreeSync Premium';
  if (refresh >= 144) return 'FreeSync';
  return null;
}

function extractPorts(p) {
  const text = p.n.toLowerCase();
  const ports = [];
  // HDMI
  const hdmiMatch = text.match(/(\d+)\s*x?\s*hdmi/i);
  if (hdmiMatch) ports.push(hdmiMatch[1] + 'x HDMI');
  else if (/hdmi 2\.1/i.test(text)) ports.push('HDMI 2.1');
  else if (/hdmi/i.test(text)) ports.push('HDMI');
  // DisplayPort
  if (/displayport|\bdp\b/i.test(text)) ports.push('DisplayPort');
  // USB-C
  if (/usb[- ]?c|usbc/i.test(text)) ports.push('USB-C');
  if (/thunderbolt/i.test(text)) ports.push('Thunderbolt');

  if (ports.length === 0) {
    // Default common config based on monitor type
    const refresh = p.refresh || 0;
    if (refresh >= 144) return '1x DisplayPort, 2x HDMI'; // gaming default
    return '1x HDMI, 1x DisplayPort'; // general default
  }
  return ports.join(', ');
}

function setFields(s, id, fields) {
  const idMarker = '"id": ' + id + ',';
  const idIdx = s.indexOf(idMarker);
  if (idIdx < 0) return { s, count: 0 };
  let pos = idIdx;
  while (pos > 0 && s[pos] !== '{') pos--;
  const startBrace = pos;
  let depth = 1;
  pos = startBrace + 1;
  while (pos < s.length && depth > 0) {
    if (s[pos] === '{') depth++;
    else if (s[pos] === '}') depth--;
    if (depth === 0) break;
    pos++;
  }
  const endBrace = pos;
  let entryText = s.substring(startBrace, endBrace + 1);
  let count = 0;

  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    if (entryText.includes('"' + k + '":')) continue; // already has it
    let formatted = typeof v === 'string' ? '"' + v + '"' : v;
    const matchClosing = entryText.match(/^([\s\S]*?)(\n\s*\}\s*)$/);
    if (matchClosing) {
      const before = matchClosing[1];
      const closing = matchClosing[2];
      entryText = before.replace(/,?\s*$/, '') + ',\n    "' + k + '": ' + formatted + closing;
      count++;
    }
  }

  if (count === 0) return { s, count: 0 };
  return { s: s.substring(0, startBrace) + entryText + s.substring(endBrace + 1), count };
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  let s = fs.readFileSync(PARTS_PATH, 'utf8');

  let stats = { hdr: 0, sync: 0, ports: 0, total: 0 };

  for (const p of parts) {
    if (p.c !== 'Monitor') continue;
    stats.total++;
    const fields = {};
    if (p.hdr == null) {
      const hdr = extractHDR(p);
      if (hdr) { fields.hdr = hdr; stats.hdr++; }
    }
    if (p.sync == null) {
      const sync = extractSync(p);
      if (sync) { fields.sync = sync; stats.sync++; }
    }
    if (p.ports == null) {
      const ports = extractPorts(p);
      if (ports) { fields.ports = ports; stats.ports++; }
    }
    if (Object.keys(fields).length > 0) {
      const r = setFields(s, p.id, fields);
      if (r.count > 0) s = r.s;
    }
  }

  fs.writeFileSync(PARTS_PATH, s);
  console.log('Monitor enrichment:');
  console.log('  Total monitors: ' + stats.total);
  console.log('  HDR added: ' + stats.hdr);
  console.log('  Sync added: ' + stats.sync);
  console.log('  Ports added: ' + stats.ports);
})();
