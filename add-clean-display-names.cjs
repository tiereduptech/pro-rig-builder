const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/\r\n/g, '\n');

// Strip prior version
if (s.includes('// === CLEAN DISPLAY NAME ===')) {
  console.log('Stripping prior version');
  const start = s.indexOf('// === CLEAN DISPLAY NAME ===');
  const end = s.indexOf('// === END CLEAN DISPLAY NAME ===');
  if (start > 0 && end > start) {
    const endLine = s.indexOf('\n', end) + 1;
    s = s.substring(0, start) + s.substring(endLine);
  }
}

const helper = `// === CLEAN DISPLAY NAME ===
// Returns "Brand Make Model [Variant]" for cleaner dropdown display
function cleanDisplayName(p) {
  if (!p || !p.n) return '';
  const name = p.n;
  const brand = p.b || '';
  const c = p.c;

  if (c === 'CPU') {
    let m = name.match(/(Intel)\\s+Core\\s+(Ultra\\s+\\d|i[3579])[\\s-]*(\\d{3,5}[A-Z]{0,3})/i);
    if (m) return \`Intel Core \${m[2].replace(/\\s+/g,' ')}-\${m[3].toUpperCase()}\`;
    m = name.match(/(AMD\\s+)?Ryzen\\s+(Threadripper(?:\\s+PRO)?|\\d)\\s+(\\d{4}[A-Z0-9]{0,4})/i);
    if (m) return \`AMD Ryzen \${m[2]} \${m[3].toUpperCase()}\`;
    return (brand + ' ' + name.replace(new RegExp('^' + brand + '\\\\s+', 'i'), '')).substring(0, 60).trim();
  }

  if (c === 'GPU') {
    let m = name.match(/(RTX|GTX)\\s*(\\d{3,4})\\s*(Ti\\s*Super|Super|Ti)?/i);
    if (m) {
      const series = m[1].toUpperCase();
      const num = m[2];
      const suffix = m[3] ? ' ' + m[3].replace(/super/i,'SUPER').replace(/^ti$/i,'Ti').replace(/^Ti\\s+SUPER$/i,'Ti SUPER') : '';
      const afterModel = name.split(new RegExp(\`\${series}\\\\s*\${num}\\\\s*\${m[3]||''}\\\\s*\`, 'i'))[1] || '';
      const aibMatch = afterModel.match(/^([A-Z][A-Za-z0-9\\s+]{0,30}?)(?=\\s+(?:DLSS|GDDR|\\d+GB|\\d+-?bit|\\d+\\s*Gbps|PCIE?|Gaming\\s+Graphics|Graphics\\s+Card|with|,|\\(|\\d+MHz)|$)/i);
      const aib = aibMatch ? ' ' + aibMatch[1].trim() : '';
      return \`\${brand} GeForce \${series} \${num}\${suffix}\${aib}\`.trim();
    }
    m = name.match(/(RX)\\s*(\\d{3,4})\\s*(XT|XTX|GRE)?/i);
    if (m) {
      const suffix = m[3] ? ' ' + m[3].toUpperCase() : '';
      const afterModel = name.split(new RegExp(\`RX\\\\s*\${m[2]}\\\\s*\${m[3]||''}\\\\s*\`, 'i'))[1] || '';
      const aibMatch = afterModel.match(/^([A-Z][A-Za-z0-9\\s+]{0,30}?)(?=\\s+(?:GDDR|\\d+GB|\\d+-?bit|\\d+\\s*Gbps|PCIE?|Gaming\\s+Graphics|Graphics\\s+Card|with|,|\\(|\\d+MHz)|$)/i);
      const aib = aibMatch ? ' ' + aibMatch[1].trim() : '';
      return \`\${brand} Radeon RX \${m[2]}\${suffix}\${aib}\`.trim();
    }
    m = name.match(/Arc\\s+(A\\d{3,4}|B\\d{3,4})/i);
    if (m) return \`\${brand} Arc \${m[1].toUpperCase()}\`.trim();
    return (brand + ' ' + name.replace(new RegExp('^' + brand + '\\\\s+', 'i'), '')).substring(0, 60).trim();
  }

  const cleaned = name.replace(/\\s*[,\\(].*$/, '').replace(/\\s+(DLSS|GDDR\\d+X?|PCIE?\\s*[\\d\\.]+|\\d+\\s*-?\\s*bit|\\d+\\s*Gbps?).*$/i, '').trim();
  if (cleaned.length > 60) return cleaned.substring(0, 57) + '...';
  return cleaned;
}
// === END CLEAN DISPLAY NAME ===
`;

const anchor = '// === END DEAL DETECTION ===';
const idx = s.indexOf(anchor);
if (idx < 0) { console.log('Anchor not found'); process.exit(1); }
const insertAfter = s.indexOf('\n', idx) + 1;
s = s.substring(0, insertAfter) + '\n' + helper + s.substring(insertAfter);
console.log('✓ Inserted cleanDisplayName helper');

let cnt = 0;
// Replace label:p.n with label:cleanDisplayName(p) in SearchSelect option mappings
// Need to be careful: only in mapping calls, not elsewhere
const patterns = [
  { from: 'map(p=>({value:p.n,label:p.n,detail:p.vram+"GB"}))', to: 'map(p=>({value:p.n,label:cleanDisplayName(p),detail:p.vram+"GB"}))' },
  { from: 'map(p=>({value:p.n,label:p.n,detail:p.cores+"C"}))', to: 'map(p=>({value:p.n,label:cleanDisplayName(p),detail:p.cores+"C"}))' },
  { from: 'map(g=>({value:g.n,label:g.n,detail:`${g.vram}GB · ${g.b}`}))', to: 'map(g=>({value:g.n,label:cleanDisplayName(g),detail:`${g.vram}GB · ${g.b}`}))' },
  { from: 'map(c=>({value:c.n,label:c.n,detail:`${c.cores}C · ${c.b}`}))', to: 'map(c=>({value:c.n,label:cleanDisplayName(c),detail:`${c.cores}C · ${c.b}`}))' },
];

for (const {from, to} of patterns) {
  let count = 0;
  while (s.includes(from)) {
    s = s.replace(from, to);
    count++;
    cnt++;
  }
  console.log(`  Pattern "${from.substring(0, 50)}..." replaced ${count}x`);
}

fs.writeFileSync(p, s);
console.log('\nTotal SearchSelect labels updated: ' + cnt);
