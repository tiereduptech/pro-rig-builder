/**
 * enrich-cooler-fields.cjs (v2)
 * 
 * Properly detects Air vs AIO FIRST, then fills appropriate fields.
 */

const fs = require('fs');
const APPLY = process.argv.includes('--apply');

function detectType(t) {
  // Strong AIO signals
  if (/\bAIO\b/i.test(t)) return 'AIO';
  if (/\bliquid\s*(cool|cpu)/i.test(t)) return 'AIO';
  if (/\bwater\s*cool/i.test(t)) return 'AIO';
  if (/\bradiator\b/i.test(t)) return 'AIO';
  if (/\b(120|140|240|280|360|420)\s*mm\s*(AIO|Radiator)/i.test(t)) return 'AIO';

  // Strong Air signals
  if (/\bair\s*cool/i.test(t)) return 'Air';
  if (/\btower\s*cool/i.test(t)) return 'Air';
  if (/\b(top|down|side)\s*flow/i.test(t)) return 'Air';
  if (/\bheat\s*pipe/i.test(t) && !/\bAIO\b|\bliquid\b/i.test(t)) return 'Air';
  if (/\bheatsink\b/i.test(t) && !/\bAIO\b/i.test(t)) return 'Air';
  if (/\b(low[\s\-]profile|axial[\s\-]?tech|fin|aluminum\s*fin)\b/i.test(t)) return 'Air';

  return null;
}

function extract(title) {
  const t = String(title || '');
  const out = {};

  // Type first
  const ct = detectType(t);
  if (ct) out.coolerType = ct;

  // Radiator ONLY for AIO - prefer 240/280/360/420 over 120/140 (fan size)
  if (ct === 'AIO') {
    const allMatches = [];
    const re = /\b(120|140|240|280|360|420)\s*(?:mm|AIO|Radiator|Liquid)?\b/gi;
    let mm;
    while ((mm = re.exec(t)) !== null) allMatches.push(parseInt(mm[1]));
    if (allMatches.length) {
      // Prefer larger radiator sizes (360, 280, 420, 240) over 120/140
      const bigPriority = [420, 360, 280, 240, 140, 120];
      for (const size of bigPriority) {
        if (allMatches.includes(size)) { out.radiator = size; break; }
      }
    }
  }

  // Fan count: explicit ONLY (don't infer from radiator size, too unreliable)
  if (/\btriple\s*fan/i.test(t)) out.fanCount = 3;
  else if (/\bdual\s*fan/i.test(t)) out.fanCount = 2;
  else if (/\bsingle\s*fan/i.test(t)) out.fanCount = 1;
  else {
    const m = t.match(/\b(\d+)[\s\-]*Pack\b/i);
    if (m) {
      const n = parseInt(m[1]);
      if (n >= 1 && n <= 6) out.fanCount = n;
    }
  }
  // For AIOs, infer from radiator if not detected
  if (!out.fanCount && ct === 'AIO' && out.radiator) {
    const fanMap = { 120: 1, 140: 1, 240: 2, 280: 2, 360: 3, 420: 3 };
    if (fanMap[out.radiator]) out.fanCount = fanMap[out.radiator];
  }

  // Airflow (CFM)
  let m = t.match(/(\d+(?:\.\d+)?)\s*CFM\b/i);
  if (m) out.airflow = parseFloat(m[1]);

  // Noise (dBA)
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:dBA|dB\(A\)|dB)\b/i);
  if (m) out.noise = parseFloat(m[1]);

  // TDP rating
  m = t.match(/(\d{2,3})\s*W\s*(?:TDP|cooling|capacity|max|rated)/i);
  if (m) out.tdp_rating = parseInt(m[1]);

  // Sockets
  const sockets = [];
  const socketPatterns = ['AM5', 'AM4', 'AM3', 'LGA1851', 'LGA1700', 'LGA1200', 'LGA1151', 'LGA2066', 'LGA2011', 'sTRX4', 'sTR5'];
  for (const sock of socketPatterns) {
    if (new RegExp('\\b' + sock + '\\b', 'i').test(t)) sockets.push(sock);
  }
  if (sockets.length) out.sockets = sockets;

  return out;
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...m.PARTS];

  const stats = { airflow: 0, radiator: 0, fanCount: 0, noise: 0, tdp_rating: 0, sockets: 0, coolerType: 0 };
  let totalFilled = 0;
  const samples = [];

  for (const p of parts) {
    if (p.c !== 'CPUCooler') continue;
    if (p.needsReview) continue;

    const fields = extract(p.n);
    let filledHere = 0;
    for (const [k, v] of Object.entries(fields)) {
      // Skip if already has a real value
      if (p[k] != null) {
        if (Array.isArray(p[k]) && p[k].length === 0) {
          // empty array, can fill
        } else continue;
      }
      if (APPLY) p[k] = v;
      stats[k]++;
      filledHere++;
    }
    if (filledHere > 0) {
      totalFilled++;
      if (samples.length < 12) samples.push({ id: p.id, fields, n: p.n.slice(0, 60) });
    }
  }

  console.log('Mode:', APPLY ? 'APPLY' : 'DRY RUN');
  console.log('Coolers updated:', totalFilled);
  console.log('Field fills:');
  Object.entries(stats).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log('  ' + k + ': ' + v));
  console.log('\nSample changes:');
  samples.forEach(s => console.log('  [' + s.id + '] ' + JSON.stringify(s.fields) + ' | ' + s.n));

  if (APPLY) {
    const header = '// Auto-merged catalog. Edit with care.\n';
    const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
    fs.writeFileSync('src/data/parts.js', header + body, 'utf8');
    console.log('\nApplied to ' + totalFilled + ' coolers.');
  }
})();
