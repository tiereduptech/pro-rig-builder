// patch-used-and-reconfigure.mjs — FIXED VERSION
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";

// ═══════════════════════════════════════════════════════════════════
// PATCH 1: App.jsx
// ═══════════════════════════════════════════════════════════════════
console.log("─── Patching App.jsx ───");
if (!existsSync("./src/App.jsx.pre-used-patch.backup")) {
  copyFileSync("./src/App.jsx", "./src/App.jsx.pre-used-patch.backup");
}
let app = readFileSync("./src/App.jsx", "utf8");

const tagLine = `{p.condition==="refurbished"&&<Tag color="var(--sky)">REFURBISHED</Tag>}`;
const newTagLine = `{(p.used===true||p.condition==="used")&&<Tag color="#F59E0B">USED</Tag>}{p.condition==="refurbished"&&<Tag color="var(--sky)">REFURBISHED</Tag>}`;

if (app.includes(tagLine) && !app.includes('>USED</Tag>')) {
  app = app.replace(tagLine, newTagLine);
  console.log("  ✓ Added USED Tag to product row");
} else if (app.includes('>USED</Tag>')) {
  console.log("  ⚠ Already present, skipping");
} else {
  console.log("  ✗ Anchor not found");
}

const detailImageAnchor = `{p.img&&<div style={{marginTop:14,background:"var(--bg4)",borderRadius:10,padding:16`;
const detailImageReplacement = `{(p.used===true||p.condition==="used")&&<div style={{marginTop:14,background:"linear-gradient(90deg,#F59E0B 0%,#D97706 100%)",color:"#1A1A20",padding:"10px 14px",borderRadius:8,fontFamily:"var(--ff)",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:10,border:"1px solid #D97706"}}><span style={{fontFamily:"var(--mono)",fontSize:11,fontWeight:900,letterSpacing:1.5,background:"#1A1A20",color:"#F59E0B",padding:"3px 8px",borderRadius:4}}>USED</span><span>Pre-owned item — check seller rating, condition notes, and return policy before purchasing.</span></div>}{p.img&&<div style={{marginTop:14,background:"var(--bg4)",borderRadius:10,padding:16`;

if (app.includes(detailImageAnchor) && !app.includes('Pre-owned item')) {
  app = app.replace(detailImageAnchor, detailImageReplacement);
  console.log("  ✓ Added USED banner to detail view");
} else if (app.includes('Pre-owned item')) {
  console.log("  ⚠ Detail banner already present, skipping");
} else {
  console.log("  ✗ Detail view anchor not found");
}

writeFileSync("./src/App.jsx", app);

// ═══════════════════════════════════════════════════════════════════
// PATCH 2: UpgradePage.jsx
// ═══════════════════════════════════════════════════════════════════
console.log("\n─── Patching UpgradePage.jsx ───");
if (!existsSync("./src/UpgradePage.jsx.pre-reconfigure-patch.backup")) {
  copyFileSync("./src/UpgradePage.jsx", "./src/UpgradePage.jsx.pre-reconfigure-patch.backup");
}
let up = readFileSync("./src/UpgradePage.jsx", "utf8");

// 2a. UpgradeRow — add USED pill
const upgradeRowAnchor = `          {improvement != null && improvement > 0 && <span style={{color:"var(--accent)", fontWeight:700}}>+{improvement}% faster</span>}`;
const upgradeRowReplacement = `          {improvement != null && improvement > 0 && <span style={{color:"var(--accent)", fontWeight:700}}>+{improvement}% faster</span>}
          {(part.used === true || part.condition === "used") && <span style={{color:"#F59E0B", fontWeight:700, background:"#F59E0B20", padding:"1px 6px", borderRadius:4, border:"1px solid #F59E0B40"}}>USED</span>}`;

if (up.includes(upgradeRowAnchor) && !up.includes('>USED</span>')) {
  up = up.replace(upgradeRowAnchor, upgradeRowReplacement);
  console.log("  ✓ UpgradeRow USED tag added");
} else if (up.includes('>USED</span>')) {
  console.log("  ⚠ UpgradeRow USED pill already present");
} else {
  console.log("  ✗ UpgradeRow anchor not found");
}

// 2b. SwapLine — add USED pill before price
const swapLineAnchor = '      <div style={{fontFamily:"var(--ff)", fontSize:14, fontWeight:700, color:"var(--accent)"}}>${bestPrice(part)}</div>';
const swapLineReplacement = '      {(part.used === true || part.condition === "used") && <span style={{fontFamily:"var(--mono)", fontSize:9, fontWeight:900, letterSpacing:1, color:"#1A1A20", background:"#F59E0B", padding:"2px 6px", borderRadius:4}}>USED</span>}\n      <div style={{fontFamily:"var(--ff)", fontSize:14, fontWeight:700, color:"var(--accent)"}}>${bestPrice(part)}</div>';

if (up.includes(swapLineAnchor) && !up.match(/background:"#F59E0B"[^}]*}}>USED</)) {
  up = up.replace(swapLineAnchor, swapLineReplacement);
  console.log("  ✓ SwapLine USED tag added");
} else {
  console.log("  ⚠ SwapLine already patched or anchor not found");
}

// 2c. Replace inline budget banner with <BudgetBanner/> component call
const oldBudgetStart = '    <div style={{background:"var(--bg2)", borderRadius:12, border:"1px solid var(--bdr)", padding:"16px 20px", marginBottom:20}}>';
const oldBudgetSearchEnd = '        ))}\n      </div>\n    </div>';

const startIdx = up.indexOf(oldBudgetStart);
if (startIdx !== -1 && !up.includes("<BudgetBanner")) {
  // Find the matching </div></div> closure starting from this point
  const endIdx = up.indexOf(oldBudgetSearchEnd, startIdx);
  if (endIdx !== -1) {
    const oldBlock = up.substring(startIdx, endIdx + oldBudgetSearchEnd.length);
    const newBlock = "    <BudgetBanner budget={budget} estCost={estCost} over={over} split={split} specs={specs}/>";
    up = up.substring(0, startIdx) + newBlock + up.substring(endIdx + oldBudgetSearchEnd.length);
    console.log("  ✓ Budget banner replaced with BudgetBanner component");
  } else {
    console.log("  ✗ Could not find budget banner closure");
  }
} else if (up.includes("<BudgetBanner")) {
  console.log("  ⚠ BudgetBanner call already present");
} else {
  console.log("  ✗ Budget banner start anchor not found");
}

// 2d. Insert component definitions — using array.join to avoid nested template literal nightmare
const componentLines = [
  'function BudgetBanner({budget, estCost, over, split, specs}) {',
  '  const [expanded, setExpanded] = React.useState(false);',
  '  return (',
  '    <div style={{background:"var(--bg2)", borderRadius:12, border:"1px solid var(--bdr)", padding:"16px 20px", marginBottom:20}}>',
  '      <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12, flexWrap:"wrap", gap:12}}>',
  '        <div>',
  '          <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", fontWeight:600, letterSpacing:1.5}}>YOUR BUDGET</div>',
  '          <div style={{fontFamily:"var(--ff)", fontSize:26, fontWeight:800, color:"var(--accent)"}}>${budget.toLocaleString()}</div>',
  '        </div>',
  '        <div style={{display:"flex", alignItems:"center", gap:16}}>',
  '          <div style={{textAlign:"right"}}>',
  '            <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", fontWeight:600, letterSpacing:1.5}}>ESTIMATED TOTAL</div>',
  '            <div style={{fontFamily:"var(--ff)", fontSize:26, fontWeight:800, color: over ? "#FFB020" : "var(--txt)"}}>${estCost.toLocaleString()}</div>',
  '          </div>',
  '          <button onClick={() => setExpanded(!expanded)} style={{padding:"8px 14px", borderRadius:8, fontSize:12, fontFamily:"var(--ff)", fontWeight:600, cursor:"pointer", background:expanded?"var(--accent)":"transparent", color:expanded?"var(--bg)":"var(--accent)", border:"1.5px solid var(--accent)"}}>',
  '            {expanded ? "Cancel" : "\u2699 Adjust"}',
  '          </button>',
  '        </div>',
  '      </div>',
  '      <div style={{display:"flex", gap:6, flexWrap:"wrap"}}>',
  '        {Object.entries(split).map(([key, pct]) => (',
  '          <div key={key} style={{background:"var(--bg3)", padding:"4px 10px", borderRadius:6, fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)"}}>',
  '            <span style={{color:"var(--txt)", fontWeight:600}}>{key.toUpperCase()}</span> {Math.round(pct*100)}% \u00b7 ${Math.round(budget*pct).toLocaleString()}',
  '          </div>',
  '        ))}',
  '      </div>',
  '      {expanded && <ReconfigurePanel specs={specs} initialBudget={budget} onClose={() => setExpanded(false)}/>}',
  '    </div>',
  '  );',
  '}',
  '',
  'function ReconfigurePanel({specs, initialBudget, onClose}) {',
  '  const MIN_BUDGET = 300;',
  '  const MAX_BUDGET = 8000;',
  '  const budgetToSlider = (b) => Math.pow((b - MIN_BUDGET) / (MAX_BUDGET - MIN_BUDGET), 1/2.5);',
  '  const sliderToBudget = (s) => Math.round(MIN_BUDGET + Math.pow(s, 2.5) * (MAX_BUDGET - MIN_BUDGET));',
  '',
  '  const [budget, setBudget] = React.useState(initialBudget);',
  '  const [sliderVal, setSliderVal] = React.useState(budgetToSlider(initialBudget));',
  '  const [usedOk, setUsedOk] = React.useState(specs.used_ok === true || specs.used_ok === "true");',
  '  const [addStorage, setAddStorage] = React.useState(!!specs.add_storage_gb);',
  '  const [storageType, setStorageType] = React.useState(specs.add_storage_type || "SSD");',
  '  const [storageSize, setStorageSize] = React.useState(specs.add_storage_gb || 1000);',
  '',
  '  const SSD_SIZES = [500, 1000, 2000, 4000];',
  '  const HDD_SIZES = [1000, 2000, 4000, 8000];',
  '  const sizes = storageType === "SSD" ? SSD_SIZES : HDD_SIZES;',
  '  const sizeLabel = (gb) => gb >= 1000 ? (gb/1000) + "TB" : gb + "GB";',
  '',
  '  const handleSliderChange = (e) => {',
  '    const s = parseFloat(e.target.value);',
  '    setSliderVal(s);',
  '    setBudget(sliderToBudget(s));',
  '  };',
  '',
  '  const handleReconfigure = () => {',
  '    const newSpecs = { ...specs, budget };',
  '    newSpecs.used_ok = usedOk;',
  '    if (addStorage) {',
  '      newSpecs.add_storage_gb = storageSize;',
  '      newSpecs.add_storage_type = storageType;',
  '    } else {',
  '      delete newSpecs.add_storage_gb;',
  '      delete newSpecs.add_storage_type;',
  '    }',
  '    const encoded = btoa(JSON.stringify(newSpecs));',
  '    window.location.hash = "upgrade?specs=" + encodeURIComponent(encoded);',
  '    window.location.reload();',
  '  };',
  '',
  '  const labelStyle = {fontFamily:"var(--mono)", fontSize:10, color:"var(--dim)", fontWeight:600, letterSpacing:1.5, marginBottom:6, display:"block"};',
  '',
  '  return (',
  '    <div style={{marginTop:16, padding:"16px 18px", background:"var(--bg3)", borderRadius:10, border:"1px solid var(--bdr)"}}>',
  '      <div style={{marginBottom:18}}>',
  '        <label style={labelStyle}>BUDGET</label>',
  '        <div style={{fontFamily:"var(--ff)", fontSize:22, fontWeight:800, color:"var(--accent)", marginBottom:8}}>${budget.toLocaleString()}</div>',
  '        <input type="range" min={0} max={1} step={0.001} value={sliderVal} onChange={handleSliderChange} style={{width:"100%", accentColor:"var(--accent)"}}/>',
  '        <div style={{display:"flex", justifyContent:"space-between", fontFamily:"var(--mono)", fontSize:9, color:"var(--dim)", marginTop:4}}>',
  '          <span>$300</span><span>$1000</span><span>$3000</span><span>$8000</span>',
  '        </div>',
  '      </div>',
  '      <div style={{marginBottom:18, display:"flex", alignItems:"center", gap:12}}>',
  '        <label style={{...labelStyle, marginBottom:0, flex:1}}>INCLUDE USED PARTS</label>',
  '        <button onClick={() => setUsedOk(!usedOk)} style={{padding:"6px 14px", borderRadius:6, fontSize:11, fontFamily:"var(--ff)", fontWeight:600, cursor:"pointer", background:usedOk?"#F59E0B":"transparent", color:usedOk?"#1A1A20":"var(--dim)", border:usedOk?"1.5px solid #F59E0B":"1.5px solid var(--bdr)"}}>',
  '          {usedOk ? "ON" : "OFF"}',
  '        </button>',
  '      </div>',
  '      <div style={{marginBottom:18}}>',
  '        <div style={{display:"flex", alignItems:"center", gap:12, marginBottom:addStorage?12:0}}>',
  '          <label style={{...labelStyle, marginBottom:0, flex:1}}>ADD STORAGE</label>',
  '          <button onClick={() => setAddStorage(!addStorage)} style={{padding:"6px 14px", borderRadius:6, fontSize:11, fontFamily:"var(--ff)", fontWeight:600, cursor:"pointer", background:addStorage?"var(--accent)":"transparent", color:addStorage?"var(--bg)":"var(--dim)", border:addStorage?"1.5px solid var(--accent)":"1.5px solid var(--bdr)"}}>',
  '            {addStorage ? "ON" : "OFF"}',
  '          </button>',
  '        </div>',
  '        {addStorage && (',
  '          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10}}>',
  '            <div>',
  '              <label style={labelStyle}>TYPE</label>',
  '              <div style={{display:"flex", gap:6}}>',
  '                {["SSD", "HDD"].map(t => (',
  '                  <button key={t} onClick={() => { setStorageType(t); setStorageSize((t === "SSD" ? SSD_SIZES : HDD_SIZES)[1]); }} style={{flex:1, padding:"7px 10px", borderRadius:6, fontSize:11, fontFamily:"var(--ff)", fontWeight:600, cursor:"pointer", background:storageType===t?"var(--accent)":"transparent", color:storageType===t?"var(--bg)":"var(--dim)", border:storageType===t?"1.5px solid var(--accent)":"1.5px solid var(--bdr)"}}>',
  '                    {t}',
  '                  </button>',
  '                ))}',
  '              </div>',
  '            </div>',
  '            <div>',
  '              <label style={labelStyle}>SIZE</label>',
  '              <div style={{display:"flex", gap:4, flexWrap:"wrap"}}>',
  '                {sizes.map(sz => (',
  '                  <button key={sz} onClick={() => setStorageSize(sz)} style={{padding:"7px 10px", borderRadius:6, fontSize:11, fontFamily:"var(--ff)", fontWeight:600, cursor:"pointer", background:storageSize===sz?"var(--accent)":"transparent", color:storageSize===sz?"var(--bg)":"var(--dim)", border:storageSize===sz?"1.5px solid var(--accent)":"1.5px solid var(--bdr)"}}>',
  '                    {sizeLabel(sz)}',
  '                  </button>',
  '                ))}',
  '              </div>',
  '            </div>',
  '          </div>',
  '        )}',
  '      </div>',
  '      <div style={{display:"flex", gap:10, justifyContent:"flex-end"}}>',
  '        <button onClick={onClose} style={{padding:"10px 20px", borderRadius:8, fontSize:12, fontFamily:"var(--ff)", fontWeight:600, cursor:"pointer", background:"transparent", color:"var(--dim)", border:"1.5px solid var(--bdr)"}}>',
  '          Cancel',
  '        </button>',
  '        <button onClick={handleReconfigure} style={{padding:"10px 24px", borderRadius:8, fontSize:12, fontFamily:"var(--ff)", fontWeight:700, cursor:"pointer", background:"var(--accent)", color:"var(--bg)", border:"1.5px solid var(--accent)"}}>',
  '          Reconfigure \u2192',
  '        </button>',
  '      </div>',
  '    </div>',
  '  );',
  '}',
  '',
];
const componentsToInsert = componentLines.join("\n");

const componentInsertAnchor = "function MissingSpecsView() {";
if (up.includes(componentInsertAnchor) && !up.includes("function BudgetBanner(")) {
  up = up.replace(componentInsertAnchor, componentsToInsert + "\n" + componentInsertAnchor);
  console.log("  ✓ Inserted BudgetBanner and ReconfigurePanel components");
} else if (up.includes("function BudgetBanner(")) {
  console.log("  ⚠ BudgetBanner already defined, skipping");
} else {
  console.log("  ✗ MissingSpecsView anchor not found");
}

// Ensure React default import (for React.useState)
const hasReactDefault = /^\s*import\s+React\s*(,|\s+from)/m.test(up);
if (!hasReactDefault) {
  const hookImport = up.match(/^import\s*\{([^}]+)\}\s*from\s*["']react["']/m);
  if (hookImport) {
    up = up.replace(
      /^import\s*\{([^}]+)\}\s*from\s*["']react["']/m,
      'import React, {$1} from "react"'
    );
    console.log("  ✓ Upgraded hook-only React import to include default React");
  } else {
    up = 'import React from "react";\n' + up;
    console.log("  ✓ Added React default import");
  }
}

writeFileSync("./src/UpgradePage.jsx", up);
console.log("\n═══ PATCH COMPLETE ═══");
console.log("Backups:");
console.log("  ./src/App.jsx.pre-used-patch.backup");
console.log("  ./src/UpgradePage.jsx.pre-reconfigure-patch.backup");
