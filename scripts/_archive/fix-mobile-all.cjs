const fs = require('fs');

const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/\r\n/g, '\n');

let fixes = 0;
const miss = [];

function patchLine(oldStr, newStr, desc) {
  // Must appear exactly once to be safe. If appears multiple times, we'll handle separately.
  const count = s.split(oldStr).length - 1;
  if (count === 0) {
    miss.push(desc + ' (anchor not found)');
    return false;
  }
  if (count > 1) {
    miss.push(desc + ' (anchor matches ' + count + ' places - ambiguous)');
    return false;
  }
  s = s.replace(oldStr, newStr);
  fixes++;
  console.log('✓ ' + desc);
  return true;
}

// =============================================================
// 1. BuilerPartPicker main 2-col layout (line ~2660): 200px 1fr
// =============================================================
patchLine(
  '<div style={{display:"grid",gridTemplateColumns:"200px 1fr",gap:20}}>',
  '<div className="builder-picker-layout" style={{gap:20,alignItems:"start"}}>',
  'BuilerPartPicker sidebar+content layout'
);

// =============================================================
// 2. BuilerPartPicker product row (line ~2878): 130px 1fr 180px 70px 40px
// This is inside a .map() so adding classNames requires matching the exact string
// =============================================================
// Find the full unique opening of this div
const row2878Anchor = 'gridTemplateColumns:"130px 1fr 180px 70px 40px"';
if (s.includes(row2878Anchor)) {
  // Add a className to the container. Find the start of the div containing it.
  // The pattern is something like: <div style={{display:"grid",gridTemplateColumns:"130px 1fr 180px 70px 40px",gap:0,padding:"10px 16px",...}}
  // We'll inject className="builder-picker-row" into the div tag.
  const before = '<div style={{display:"grid",gridTemplateColumns:"130px 1fr 180px 70px 40px"';
  const after = '<div className="builder-picker-row" style={{display:"grid",gridTemplateColumns:"130px 1fr 180px 70px 40px"';
  patchLine(before, after, 'BuilerPartPicker product row');
} else {
  miss.push('BuilerPartPicker row anchor not found');
}

// =============================================================
// 3. ToolsPage 300px 1fr layouts (3 places, line ~3120, 3354)
// =============================================================
// The 300px 1fr appears twice. We'll do them one at a time by finding each.
{
  const anchor = '<div style={{display:"grid",gridTemplateColumns:"300px 1fr",gap:20}}>';
  const cnt = s.split(anchor).length - 1;
  console.log('  (found ' + cnt + ' instances of 300px 1fr layout)');
  // Replace ALL instances with the same className (safe because same fix applies)
  let i = 0;
  while (s.includes(anchor)) {
    const idx = s.indexOf(anchor);
    s = s.substring(0, idx) + '<div className="tools-layout" style={{gap:20,alignItems:"start"}}>' + s.substring(idx + anchor.length);
    i++;
    if (i > 10) break; // safety
  }
  if (i > 0) { fixes++; console.log('✓ ToolsPage 300px layouts: ' + i + ' instances'); }
  else { miss.push('ToolsPage 300px anchor not found'); }
}

// =============================================================
// 4. ToolsPage 320px 1fr layout (line ~3227)
// =============================================================
patchLine(
  '<div style={{display:"grid",gridTemplateColumns:"320px 1fr",gap:20}}>',
  '<div className="tools-layout" style={{gap:20,alignItems:"start"}}>',
  'ToolsPage 320px layout'
);

// =============================================================
// 5. Add the mobile CSS rules
// =============================================================
const marker = '/* === MOBILE FIX 5: browse page mobile layout === */';
const markerIdx = s.indexOf(marker);
if (markerIdx < 0) {
  miss.push('CSS marker for MOBILE FIX 5 not found');
} else {
  // Check we haven't already added these rules
  if (s.includes('/* === MOBILE FIX 6:')) {
    console.log('  (CSS rules already present, skipping)');
  } else {
    const newCSS = `/* === MOBILE FIX 6: builder part picker mobile layout === */
.builder-picker-layout {
  display: grid;
  grid-template-columns: 200px 1fr;
}
@media (max-width: 900px) {
  .builder-picker-layout {
    grid-template-columns: 1fr !important;
    padding: 8px 12px !important;
    max-width: 100vw !important;
  }
  .builder-picker-layout > div:first-of-type {
    display: none !important;
  }
  .builder-picker-layout > div:last-of-type {
    min-width: 0;
    max-width: 100%;
    overflow-x: hidden;
  }
  .builder-picker-row {
    display: flex !important;
    flex-direction: column !important;
    align-items: stretch !important;
    padding: 12px !important;
    gap: 6px !important;
  }
  .builder-picker-row > * {
    width: 100% !important;
    text-align: left !important;
    min-width: 0;
  }
}

/* === MOBILE FIX 7: tools page mobile layout === */
.tools-layout {
  display: grid;
  grid-template-columns: 300px 1fr;
}
@media (max-width: 900px) {
  .tools-layout {
    grid-template-columns: 1fr !important;
    padding: 8px 12px !important;
    max-width: 100vw !important;
  }
  .tools-layout > * {
    min-width: 0;
    max-width: 100%;
  }
}

`;
    s = s.substring(0, markerIdx) + newCSS + s.substring(markerIdx);
    fixes++;
    console.log('✓ CSS rules for MOBILE FIX 6 + 7');
  }
}

if (miss.length > 0) {
  console.log('\nMISSED:');
  miss.forEach(m => console.log('  - ' + m));
}

fs.writeFileSync(p, s);
console.log('\nTotal fixes: ' + fixes);
