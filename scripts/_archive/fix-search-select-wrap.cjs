const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

let fixes = 0;

// Fix 1: Option label - allow wrapping
const old1 = '<span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{o.label}</span>';
const new1 = '<span style={{flex:1,whiteSpace:"normal",wordBreak:"break-word",lineHeight:1.3}}>{o.label}</span>';
if (s.includes(old1)) {
  s = s.replace(old1, new1);
  console.log('✓ Option label can now wrap');
  fixes++;
} else {
  console.log('WARN: option label anchor not found');
}

// Fix 2: Dropdown maxHeight 240 → 320
const old2 = 'maxHeight:240,overflowY:"auto"';
const new2 = 'maxHeight:320,overflowY:"auto"';
if (s.includes(old2)) {
  s = s.replace(old2, new2);
  console.log('✓ Dropdown maxHeight 240→320');
  fixes++;
}

// Fix 3: Revert sidebar to 300px (wrapping handles it now)
const old3 = 'grid-template-columns: 480px 1fr;';
const new3 = 'grid-template-columns: 300px 1fr;';
if (s.includes(old3)) {
  s = s.replace(old3, new3);
  console.log('✓ Sidebar back to 300px');
  fixes++;
}

fs.writeFileSync(p, s);
console.log('\nTotal fixes: ' + fixes);
