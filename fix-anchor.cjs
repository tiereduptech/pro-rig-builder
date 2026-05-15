const fs = require('fs');
const p = 'apply-cpu-benches.cjs';
let c = fs.readFileSync(p, 'utf8');

const old = `  // Find the anchor: highest-scoring consumer CPU = bench 100
  const consumerModels = Object.entries(lookup).filter(([m]) => 
    /^Ryzen\\s*[579]\\s*\\d{4}[X3D]+/i.test(m) || /^i[579]-\\d{5}K?/i.test(m) || /^Core Ultra/i.test(m)
  );
  consumerModels.sort((a,b) => b[1] - a[1]);
  const anchor = consumerModels[0];
  if (!anchor) { console.error('No anchor found'); process.exit(1); }
  console.log('Anchor:', anchor[0], '=', anchor[1], '→ scaleFactor', (100 / anchor[1]).toFixed(6));
  const scaleFactor = 100 / anchor[1];`;

const renew = `  // Anchor: Ryzen 9 9950X3D = bench 100 (matches existing catalog scoring)
  let anchor = null;
  // Try preferred anchors in order
  const preferred = ['Ryzen 9 9950X3D', 'Ryzen 9 9950X', 'Core Ultra 9 285K'];
  for (const name of preferred) {
    if (lookup[name]) { anchor = [name, lookup[name]]; break; }
  }
  if (!anchor) {
    // Fall back to highest consumer CPU
    const consumerModels = Object.entries(lookup).filter(([m]) => 
      /^Ryzen\\s*[579]\\s*\\d{4}[X3D]+/i.test(m) || /^i[579]-\\d{5}K?/i.test(m) || /^Core Ultra/i.test(m)
    );
    consumerModels.sort((a,b) => b[1] - a[1]);
    anchor = consumerModels[0];
  }
  if (!anchor) { console.error('No anchor found'); process.exit(1); }
  console.log('Anchor:', anchor[0], '=', anchor[1], '→ scaleFactor', (100 / anchor[1]).toFixed(6));
  const scaleFactor = 100 / anchor[1];`;

if (!c.includes(old)) { console.log('NOT FOUND'); process.exit(1); }
c = c.replace(old, renew);
fs.writeFileSync(p, c);
console.log('Fixed anchor to Ryzen 9 9950X3D');
