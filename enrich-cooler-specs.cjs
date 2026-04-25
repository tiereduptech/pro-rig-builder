// enrich-cooler-specs.cjs (fixed - no regex object keys)

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

const KNOWN_COOLER_SOCKETS = [
  { pattern: /noctua nh[-\s]?d15|noctua nh[-\s]?u12a|noctua nh[-\s]?u14s/i, sockets: ['LGA1700','LGA1851','AM5','AM4'] },
  { pattern: /h150i|h170i|h115i|h100i|kraken|liquid freezer|galahad|silent loop/i, sockets: ['LGA1700','LGA1851','AM5','AM4'] },
  { pattern: /dark rock|pure rock|shadow rock/i, sockets: ['LGA1700','LGA1851','AM5','AM4'] },
  { pattern: /frostflow|zoomflow|frozn|frozr/i, sockets: ['LGA1700','AM5','AM4'] },
  { pattern: /peerless assassin|phantom spirit|FUMA|fuma/i, sockets: ['LGA1700','LGA1851','AM5','AM4'] },
  { pattern: /hyper 212|hyper 412|MA610|MA620/i, sockets: ['LGA1700','AM5','AM4'] },
];

function extractRadSize(p) {
  if (p.radSize) return null;
  const text = p.n + ' ' + (p.b || '');
  const match = text.match(/(\b|[^a-zA-Z])(420|360|280|240|140|120)(?:\s*mm)?(?:\s*(?:radiator|aio|cooler|liquid))?/i);
  if (match) {
    const size = parseInt(match[2]);
    if ([420, 360, 280, 240, 140, 120].includes(size)) return String(size);
  }
  if (/h150i|h170i|liquid freezer 360/i.test(text)) return '360';
  if (/h115i|liquid freezer 280/i.test(text)) return '280';
  if (/h100i|kraken x53|liquid freezer 240/i.test(text)) return '240';
  if (/kraken x42/i.test(text)) return '140';
  return null;
}

function extractFanSize(p) {
  if (p.fanSize) return null;
  const text = p.n + ' ' + (p.b || '');
  const match = text.match(/(\b|[^a-zA-Z])(120|140|92|80)(?:\s*mm)?\s*fan/i);
  if (match) return parseInt(match[2]);
  const radSize = parseInt(p.radSize) || 0;
  if (radSize > 0) {
    if (radSize === 360 || radSize === 240 || radSize === 120) return 120;
    if (radSize === 420 || radSize === 280 || radSize === 140) return 140;
  }
  if (/D15|D14|U14S|peerless assassin|FUMA|noctua nh.+15/i.test(text)) return 140;
  if (/dark rock|H7|H5|212|peerless|fuma|U12/i.test(text)) return 120;
  return null;
}

function extractHeight(p) {
  if (p.height) return null;
  const text = p.n + ' ' + (p.b || '');
  const match = text.match(/(\d{2,3})\s*mm\s*(?:tall|height)/i);
  if (match) return parseInt(match[1]);
  const knownHeights = {
    'NH-D15': 165, 'NH-D14': 160, 'NH-U12A': 158, 'NH-U12S': 158, 'NH-U14S': 165,
    'NH-L9': 37, 'NH-L12': 70,
    'Dark Rock Pro': 162, 'Dark Rock 4': 159,
    'Hyper 212': 159, 'Hyper 412': 158,
    'Peerless Assassin': 157, 'Phantom Spirit': 154,
    'FUMA 2': 155, 'FUMA 3': 155,
  };
  for (const [model, h] of Object.entries(knownHeights)) {
    if (new RegExp(model.replace(/[-\s]/g, '[\\s-]?'), 'i').test(text)) return h;
  }
  const ct = (p.coolerType || '').toLowerCase();
  if (/aio|liquid|water/.test(ct) || p.radSize) return 52;
  if (/air|tower/i.test(ct)) return 155;
  if (/low.profile|slim/i.test(ct)) return 60;
  return null;
}

function extractSockets(p) {
  if (p.sockets) return null;
  const text = p.n + ' ' + (p.b || '');
  for (const { pattern, sockets } of KNOWN_COOLER_SOCKETS) {
    if (pattern.test(text)) return sockets.join(',');
  }
  if (/AM5|LGA1700|LGA1851/i.test(text)) return 'LGA1700,LGA1851,AM5,AM4';
  if (/AM4 only|am4 socket/i.test(text)) return 'AM4';
  if (/lga115\d|115\d|114\d/i.test(text)) return 'LGA1151,LGA1200';
  const ct = (p.coolerType || '').toLowerCase();
  if (/aio|liquid|water/.test(ct)) return 'LGA1700,LGA1851,AM5,AM4';
  return null;
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
    if (entryText.includes('"' + k + '":')) continue;
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

  let stats = { total: 0, sockets: 0, radSize: 0, fanSize: 0, height: 0 };

  for (const p of parts) {
    if (p.c !== 'CPUCooler') continue;
    stats.total++;
    const fields = {};
    const sk = extractSockets(p);
    if (sk) { fields.sockets = sk; stats.sockets++; }
    const rs = extractRadSize(p);
    if (rs) { fields.radSize = rs; stats.radSize++; }
    const fs2 = extractFanSize(p);
    if (fs2) { fields.fanSize = fs2; stats.fanSize++; }
    const ht = extractHeight(p);
    if (ht) { fields.height = ht; stats.height++; }

    if (Object.keys(fields).length > 0) {
      const r = setFields(s, p.id, fields);
      if (r.count > 0) s = r.s;
    }
  }

  fs.writeFileSync(PARTS_PATH, s);
  console.log('CPUCooler enrichment (n=' + stats.total + '):');
  console.log('  sockets added: ' + stats.sockets);
  console.log('  radSize added: ' + stats.radSize);
  console.log('  fanSize added: ' + stats.fanSize);
  console.log('  height added: ' + stats.height);
})();
