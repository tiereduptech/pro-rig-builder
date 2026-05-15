/**
 * enrich-storage-fields.cjs
 * 
 * Extracts read/write speed (MB/s), formFactor (M.2 2280, 2.5in, 3.5in), 
 * pcieGen, and interface from Storage titles.
 */

const fs = require('fs');
const APPLY = process.argv.includes('--apply');

function extract(title) {
  const t = String(title || '');
  const out = {};

  // Read speed: "Read up to 7000MB/s" or "7000 MB/s read"
  let m = t.match(/(?:read\s*up\s*to|read\s*speed[s]?\s*up\s*to|read\s*:)\s*(\d{3,5})\s*MB\/s/i) ||
          t.match(/(\d{4,5})\s*MB\/s\s*(?:read|sequential\s*read)/i) ||
          t.match(/up\s*to\s*(\d{4,5})\s*MB\/s/i);
  if (m) out.read = parseInt(m[1]);

  // Write speed
  m = t.match(/(?:write\s*up\s*to|write\s*speed[s]?\s*up\s*to|write\s*:)\s*(\d{3,5})\s*MB\/s/i) ||
      t.match(/(\d{4,5})\s*MB\/s\s*(?:write|sequential\s*write)/i);
  if (m) out.write = parseInt(m[1]);

  // PCIe Gen
  m = t.match(/PCIe\s*Gen\s*(\d)|Gen\s*(\d)\s*[xX]\d/i);
  if (m) out.pcieGen = parseInt(m[1] || m[2]);
  else if (/PCIe\s*5\.0/i.test(t)) out.pcieGen = 5;
  else if (/PCIe\s*4\.0/i.test(t)) out.pcieGen = 4;
  else if (/PCIe\s*3\.0/i.test(t)) out.pcieGen = 3;

  // Form factor
  if (/M\.?2\s*2280/i.test(t)) out.formFactor = 'M.2 2280';
  else if (/M\.?2\s*2230/i.test(t)) out.formFactor = 'M.2 2230';
  else if (/M\.?2\s*2242/i.test(t)) out.formFactor = 'M.2 2242';
  else if (/M\.?2\s*22110/i.test(t)) out.formFactor = 'M.2 22110';
  else if (/\bM\.?2\b/i.test(t)) out.formFactor = 'M.2';
  else if (/2\.5["\s]?(in|inch)/i.test(t)) out.formFactor = '2.5"';
  else if (/3\.5["\s]?(in|inch)/i.test(t)) out.formFactor = '3.5"';

  // Interface
  if (/\bNVMe\b/i.test(t)) out.interface = 'NVMe';
  else if (/SATA\s*III|SATA\s*6\s*Gb/i.test(t)) out.interface = 'SATA III';
  else if (/\bSATA\b/i.test(t)) out.interface = 'SATA';
  else if (/\bUSB\b/i.test(t)) out.interface = 'USB';

  // RPM (for HDDs)
  m = t.match(/\b(5400|7200|10000|15000)\s*RPM\b/i);
  if (m) out.rpm = parseInt(m[1]);

  // DRAM cache mention
  if (/\bDRAM\s*cache\b/i.test(t)) out.dramCache = true;
  else if (/\bDRAM[\-\s]?less\b/i.test(t)) out.dramCache = false;

  return out;
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...m.PARTS];

  const stats = { read: 0, write: 0, formFactor: 0, pcieGen: 0, interface: 0, rpm: 0, dramCache: 0 };
  let totalFilled = 0;
  const samples = [];

  for (const p of parts) {
    if (p.c !== 'Storage') continue;
    if (p.needsReview) continue;

    const fields = extract(p.n);
    let filledHere = 0;
    for (const [k, v] of Object.entries(fields)) {
      if (p[k] != null && p[k] !== '' && (typeof p[k] !== 'object' || (Array.isArray(p[k]) && p[k].length > 0))) continue;
      if (APPLY) p[k] = v;
      stats[k]++;
      filledHere++;
    }
    if (filledHere > 0) {
      totalFilled++;
      if (samples.length < 12) samples.push({ id: p.id, fields, n: p.n.slice(0, 70) });
    }
  }

  console.log('Mode:', APPLY ? 'APPLY' : 'DRY RUN');
  console.log('Storage products updated:', totalFilled);
  console.log('Field fills:');
  Object.entries(stats).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log('  ' + k + ': ' + v));
  console.log('\nSamples:');
  samples.forEach(s => console.log('  [' + s.id + '] ' + JSON.stringify(s.fields) + ' | ' + s.n));

  if (APPLY) {
    const header = '// Auto-merged catalog. Edit with care.\n';
    const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
    fs.writeFileSync('src/data/parts.js', header + body, 'utf8');
    console.log('\nApplied to ' + totalFilled + ' storage products.');
  }
})();
