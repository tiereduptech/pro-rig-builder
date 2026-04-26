const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

// The bug: attribute selectors contain JS-escape sequences \"  which are valid JS but invalid CSS
// e.g. [style*="padding:\"72px 32px"]   should be   [style*="padding:72px 32px"]   (just remove \")
// or                                                [style*="padding:\\"72px 32px\\""]  (proper escape, but messy)
// We'll just strip the \" sequences inside the attribute selector value

// Find all attribute selectors with \" in them and fix
const before = s.length;

// Pattern: [style*="...\"...]   ->   [style*="......]
// We strip just the \" sequence and adjacent quote pollution
s = s.replace(/\[style\*="([^\]]*?)\\"([^\]]*?)"\]/g, '[style*="$1$2"]');

const after = s.length;
console.log('Length change:', after - before);

// Now check that we no longer have the bad pattern
const remaining = s.match(/\[style\*="[^\]]*\\"[^\]]*"\]/g);
if (remaining) {
  console.log('Remaining bad selectors:', remaining.length);
  console.log('Examples:', remaining.slice(0, 3));
} else {
  console.log('All bad selectors fixed');
}

fs.writeFileSync(p, s);
