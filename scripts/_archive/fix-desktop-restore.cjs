const fs = require('fs');

const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

// Define replacements: find-string → replace-string
const patches = [
  {
    desc: 'browse-layout: restore inline display+grid',
    from: '<div className="browse-layout" style={{gap:16,alignItems:"start"}}>',
    to:   '<div className="browse-layout" style={{display:"grid",gridTemplateColumns:"200px 1fr",gap:16,alignItems:"start"}}>'
  },
  {
    desc: 'builder-picker-layout: restore inline display+grid',
    from: '<div className="builder-picker-layout" style={{gap:20,alignItems:"start"}}>',
    to:   '<div className="builder-picker-layout" style={{display:"grid",gridTemplateColumns:"200px 1fr",gap:20,alignItems:"start"}}>'
  },
  {
    desc: 'tools-layout (300px): restore inline display+grid',
    from: '<div className="tools-layout" style={{gap:20,alignItems:"start"}}>',
    to:   '<div className="tools-layout" style={{display:"grid",gridTemplateColumns:"300px 1fr",gap:20,alignItems:"start"}}>'
  }
];

let totalPatched = 0;
const misses = [];

for (const patch of patches) {
  const count = s.split(patch.from).length - 1;
  if (count === 0) {
    misses.push(patch.desc);
    continue;
  }
  console.log(`${patch.desc} - found ${count} instance(s)`);
  // Replace ALL instances
  while (s.includes(patch.from)) {
    s = s.replace(patch.from, patch.to);
    totalPatched++;
  }
}

if (misses.length > 0) {
  console.log('\nMISSES (may already be patched):');
  misses.forEach(m => console.log('  - ' + m));
}

fs.writeFileSync(p, s);
console.log(`\nTotal patched: ${totalPatched}`);
