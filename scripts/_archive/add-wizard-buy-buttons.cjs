const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/\r\n/g, '\n');

let fixes = 0;

// =====================================================================
// 1. CSS: add .wizard-row-buy + clickable hover style
// Insert into wizard CSS section
// =====================================================================
const oldCss = `.wizard-row-price {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 700;
  color: var(--mint);
  flex-shrink: 0;
  white-space: nowrap;
}`;

const newCss = `.wizard-row-price {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 700;
  color: var(--mint);
  flex-shrink: 0;
  white-space: nowrap;
}
.wizard-row {
  text-decoration: none;
  cursor: pointer;
  transition: border-color .15s, background .15s;
}
.wizard-row:hover {
  border-color: var(--accent) !important;
  background: var(--bg4) !important;
}
.wizard-row-buy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--accent);
  color: #fff;
  font-family: var(--ff);
  font-size: 11px;
  font-weight: 700;
  padding: 5px 10px;
  border-radius: 5px;
  flex-shrink: 0;
  white-space: nowrap;
  margin-left: 8px;
}
.wizard-row:hover .wizard-row-buy {
  background: var(--accent2);
}
.wizard-row-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
@media (max-width: 600px) {
  .wizard-row-buy {
    font-size: 10px;
    padding: 4px 8px;
  }
}`;

if (s.includes(oldCss)) {
  s = s.replace(oldCss, newCss);
  console.log('✓ Added Buy button + clickable row CSS');
  fixes++;
} else {
  console.log('FATAL: wizard-row-price CSS anchor missing');
  process.exit(1);
}

// =====================================================================
// 2. JSX: convert wizard rows from <div> to clickable <button>, add Buy badge
// =====================================================================
const oldJsx = `{Object.entries(wizResult).map(([cat,p])=><div key={cat} className="wizard-row">
            <div className="wizard-row-info">
              <div className="wizard-row-img">{p.img?<img loading="lazy" decoding="async" src={p.img} alt=""/>:CAT[cat]?.icon}</div>
              <div className="wizard-row-text"><div className="wizard-row-name">{p.n}</div><div className="wizard-row-cat">{CAT[cat]?.singular}</div></div>
            </div>
            <span className="wizard-row-price">\${fmtPrice($(p))}</span>
          </div>)}`;

const newJsx = `{Object.entries(wizResult).map(([cat,p])=>{const rr=retailers(p);const url=rr[0]?.url;return <a key={cat} href={url||'#'} target={url?"_blank":undefined} rel={url?"noopener noreferrer":undefined} onClick={url?undefined:e=>{e.preventDefault();browse(p.c);go("search");}} className="wizard-row" style={{color:"inherit"}}>
            <div className="wizard-row-info">
              <div className="wizard-row-img">{p.img?<img loading="lazy" decoding="async" src={p.img} alt=""/>:CAT[cat]?.icon}</div>
              <div className="wizard-row-text"><div className="wizard-row-name">{p.n}</div><div className="wizard-row-cat">{CAT[cat]?.singular}</div></div>
            </div>
            <div className="wizard-row-meta">
              <span className="wizard-row-price">\${fmtPrice($(p))}</span>
              {url&&<span className="wizard-row-buy">Buy →</span>}
            </div>
          </a>;})}`;

if (s.includes(oldJsx)) {
  s = s.replace(oldJsx, newJsx);
  console.log('✓ Wizard rows now clickable with Buy buttons');
  fixes++;
} else {
  console.log('FATAL: wizard JSX anchor missing');
  process.exit(1);
}

// =====================================================================
// 3. Need to make sure browse and go are accessible. They're props on ToolsPage.
// Check if browse and go are passed - they probably aren't yet.
// Quick check: top of ToolsPage receives only {th}.
// We need to either pass browse/go OR just remove the fallback.
// Since most products will have a URL, the fallback rarely fires. Make it safer.
// =====================================================================
// Simplify: if no URL, just don't link (regular div behavior)
const fallbackOld = `onClick={url?undefined:e=>{e.preventDefault();browse(p.c);go("search");}}`;
const fallbackNew = `onClick={url?undefined:e=>e.preventDefault()}`;

if (s.includes(fallbackOld)) {
  s = s.replace(fallbackOld, fallbackNew);
  console.log('✓ Simplified fallback (no browse/go dependency)');
}

fs.writeFileSync(p, s);
console.log('\nTotal fixes: ' + fixes);
