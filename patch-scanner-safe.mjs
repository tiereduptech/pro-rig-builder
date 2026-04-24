// patch-scanner-safe.mjs — non-invasive scanner integration
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";

if (!existsSync("./src/App.jsx.pre-scanner-safe.backup")) {
  copyFileSync("./src/App.jsx", "./src/App.jsx.pre-scanner-safe.backup");
}

let src = readFileSync("./src/App.jsx", "utf8");

// ═══════════════════════════════════════════════════════════════════
// PATCH 1: Add scanner banner AFTER hero, BEFORE "How It Works"
// ═══════════════════════════════════════════════════════════════════
// Anchor: the closing </div> of the hero + the existing keyframe style, then the HOW IT WORKS comment
// Current sequence:
//     </div>
//   <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>
// </div>
//
// {/* ── HOW IT WORKS — horizontal strip ── */}

const heroEndAnchor = '<style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>\n    </div>\n\n    {/* ── HOW IT WORKS — horizontal strip ── */}';

const newHeroEnd = '<style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}@keyframes scanLine{0%,100%{transform:translateX(-100%)}50%{transform:translateX(100%)}}`}</style>\n    </div>\n\n    {/* ── SCANNER BANNER — promote proprietary scanner app ── */}\n    <div style={{background:"var(--bg2)",borderBottom:"1px solid var(--bdr)",position:"relative",overflow:"hidden"}}>\n      <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:"linear-gradient(90deg,transparent 0%,var(--accent) 50%,transparent 100%)",animation:"scanLine 3s ease-in-out infinite"}}/>\n      <div style={{maxWidth:1200,margin:"0 auto",padding:"48px 32px",display:"grid",gridTemplateColumns:"auto 1fr auto",gap:32,alignItems:"center"}} className="hero-grid">\n        {/* Left: TowerLogo */}\n        <div style={{display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>\n          <div style={{padding:18,background:"var(--accent3)",borderRadius:16,border:"1px solid var(--accent)"}}>\n            <TowerLogo size={56}/>\n          </div>\n        </div>\n        {/* Middle: text + 3-step */}\n        <div>\n          <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"var(--amber)",color:"#1a1a20",padding:"4px 12px",borderRadius:12,fontFamily:"var(--mono)",fontSize:10,fontWeight:800,letterSpacing:1.5,marginBottom:10}}>\n            ✨ NEW · PROPRIETARY · NOT AVAILABLE ANYWHERE ELSE\n          </div>\n          <h2 style={{fontFamily:"var(--ff)",fontSize:26,fontWeight:800,color:"var(--txt)",letterSpacing:-0.5,lineHeight:1.15,marginBottom:8}}>\n            Introducing the <span style={{background:"linear-gradient(135deg, var(--accent), var(--amber))",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>Pro Rig Scanner</span>\n          </h2>\n          <p style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--dim)",lineHeight:1.6,marginBottom:16,maxWidth:600}}>\n            Free Windows app that detects your hardware and recommends upgrades in your budget. Download, scan, upgrade — three steps, thirty seconds.\n          </p>\n          <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>\n            {[\n              {n:"1",t:"Download",d:"Free, under 2 MB"},\n              {n:"2",t:"Scan",d:"10 seconds"},\n              {n:"3",t:"Upgrade",d:"Get recommendations"},\n            ].map(s=>(\n              <div key={s.n} style={{display:"flex",alignItems:"center",gap:10}}>\n                <div style={{width:26,height:26,borderRadius:"50%",background:"var(--accent3)",color:"var(--accent)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"var(--mono)",fontSize:12,fontWeight:800,flexShrink:0}}>{s.n}</div>\n                <div>\n                  <div style={{fontFamily:"var(--ff)",fontSize:12,fontWeight:700,color:"var(--txt)",lineHeight:1.1}}>{s.t}</div>\n                  <div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)",lineHeight:1.2}}>{s.d}</div>\n                </div>\n              </div>\n            ))}\n          </div>\n        </div>\n        {/* Right: CTA button */}\n        <div style={{flexShrink:0,display:"flex",flexDirection:"column",alignItems:"stretch",gap:6}}>\n          <button onClick={()=>go("scanner")} style={{padding:"14px 24px",borderRadius:12,fontSize:14,fontFamily:"var(--ff)",fontWeight:700,cursor:"pointer",background:"var(--accent)",color:"#fff",border:"none",boxShadow:"0 6px 22px rgba(255,107,53,.3)",transition:"transform .15s",whiteSpace:"nowrap"}}\n            onMouseEnter={e=>e.currentTarget.style.transform="translateY(-1px)"}\n            onMouseLeave={e=>e.currentTarget.style.transform="none"}>\n            Learn More →\n          </button>\n          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--mute)",textAlign:"center",letterSpacing:1}}>WINDOWS 10 / 11</div>\n        </div>\n      </div>\n    </div>\n\n    {/* ── HOW IT WORKS — horizontal strip ── */}';

if (src.includes(heroEndAnchor) && !src.includes('Introducing the')) {
  src = src.replace(heroEndAnchor, newHeroEnd);
  console.log("✓ Added scanner banner below hero");
} else if (src.includes('Introducing the')) {
  console.log("⚠ Scanner banner already present");
} else {
  console.log("✗ Hero end anchor not found");
  console.log("  Searching for alternative:");
  const pulseMatch = src.match(/<style>{`@keyframes pulse[^`]+`}<\/style>/);
  if (pulseMatch) console.log("  pulse style found:", pulseMatch[0].slice(0, 80));
}

// ═══════════════════════════════════════════════════════════════════
// PATCH 2: Add /scanner route to router
// ═══════════════════════════════════════════════════════════════════
const routerAnchor = '{page==="upgrade"&&<UpgradePage/>}';
const routerNew = '{page==="upgrade"&&<UpgradePage/>}{page==="scanner"&&<ScannerPage go={setPage}/>}';
if (src.includes(routerAnchor) && !src.includes('page==="scanner"')) {
  src = src.replace(routerAnchor, routerNew);
  console.log("✓ Added /scanner route");
} else if (src.includes('page==="scanner"')) {
  console.log("⚠ Scanner route already wired");
} else {
  console.log("✗ Router anchor not found");
}

// ═══════════════════════════════════════════════════════════════════
// PATCH 3: Insert ScannerPage component before HomePage
// ═══════════════════════════════════════════════════════════════════
const scannerPageAnchor = 'function HomePage({go,browse,th}){';

const scannerPageComponent = [
  'function ScannerPage({go}) {',
  '  return (',
  '    <div className="fade">',
  '      {/* ── HERO ── */}',
  '      <div style={{background:"var(--heroGrad)",position:"relative",overflow:"hidden"}}>',
  '        <div style={{position:"absolute",top:"10%",right:"-5%",width:500,height:500,borderRadius:"50%",background:"radial-gradient(circle, rgba(255,107,53,0.08) 0%, transparent 60%)",pointerEvents:"none"}}/>',
  '        <div style={{maxWidth:1000,margin:"0 auto",padding:"72px 32px 56px",position:"relative"}}>',
  '          <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"var(--amber)",color:"#1a1a20",padding:"5px 14px",borderRadius:14,fontFamily:"var(--mono)",fontSize:11,fontWeight:800,letterSpacing:1.5,marginBottom:24}}>',
  '            ✨ NEW · PROPRIETARY SOLUTION',
  '          </div>',
  '          <h1 style={{fontFamily:"var(--ff)",fontSize:48,fontWeight:800,color:"var(--txt)",lineHeight:1.05,letterSpacing:-1.2,maxWidth:720}}>',
  '            Meet the <span style={{background:"linear-gradient(135deg, var(--accent), var(--amber))",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>Pro Rig Scanner</span>',
  '          </h1>',
  '          <p style={{fontFamily:"var(--ff)",fontSize:17,color:"var(--dim)",marginTop:18,lineHeight:1.7,maxWidth:640}}>',
  "            Download our free Windows app, run a quick scan, and get personalized upgrade recommendations tailored to your budget. No other site offers this — it\\'s built exclusively by Pro Rig Builder.",
  '          </p>',
  '          <div style={{display:"flex",gap:12,marginTop:32,flexWrap:"wrap"}}>',
  '            <a href="/downloads/ProRigScanner.exe" download style={{textDecoration:"none",padding:"14px 32px",borderRadius:14,fontSize:15,fontFamily:"var(--ff)",fontWeight:700,background:"var(--accent)",color:"#fff",border:"none",boxShadow:"0 6px 24px rgba(255,107,53,.3)",display:"inline-flex",alignItems:"center",gap:8,transition:"transform .15s"}}',
  '              onMouseEnter={e=>e.currentTarget.style.transform="translateY(-1px)"}',
  '              onMouseLeave={e=>e.currentTarget.style.transform="none"}>',
  '              📥 Download for Windows',
  '            </a>',
  '            <button onClick={()=>go("builder")} style={{padding:"14px 32px",borderRadius:14,fontSize:15,fontFamily:"var(--ff)",fontWeight:600,cursor:"pointer",background:"var(--bg3)",color:"var(--txt)",border:"1px solid var(--bdr)"}}>',
  '              Browse Parts Manually',
  '            </button>',
  '          </div>',
  '          <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",marginTop:14,letterSpacing:1}}>',
  '            WINDOWS 10 / 11 · UNDER 2 MB · NO ACCOUNT REQUIRED · 100% FREE',
  '          </div>',
  '        </div>',
  '      </div>',
  '',
  '      {/* ── HOW IT WORKS ── */}',
  '      <div style={{background:"var(--bg2)",borderBottom:"1px solid var(--bdr)"}}>',
  '        <div style={{maxWidth:1000,margin:"0 auto",padding:"64px 32px"}}>',
  '          <div style={{textAlign:"center",marginBottom:48}}>',
  '            <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",fontWeight:600,letterSpacing:2,marginBottom:8}}>HOW IT WORKS</div>',
  '            <h2 style={{fontFamily:"var(--ff)",fontSize:32,fontWeight:800,color:"var(--txt)",letterSpacing:-0.5}}>Three steps. Thirty seconds.</h2>',
  '          </div>',
  '          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:32}} className="how-grid">',
  '            {[',
  '              {n:"01",t:"Download & Run",d:"Get the free Pro Rig Scanner for Windows. Under 2 MB, no install, no account required. Just double-click to launch."},',
  '              {n:"02",t:"Scan Your Hardware",d:"The scanner detects your CPU, GPU, RAM, storage, and motherboard in about 10 seconds. Choose your budget and storage preferences."},',
  '              {n:"03",t:"Get Recommendations",d:"Open your personalized upgrade page on prorigbuilder.com with ranked options, pricing, and compatibility already validated."},',
  '            ].map(s=><div key={s.n} style={{background:"var(--bg3)",borderRadius:14,padding:"28px 24px",border:"1px solid var(--bdr)"}}>',
  '              <div style={{fontFamily:"var(--mono)",fontSize:36,fontWeight:800,color:"var(--accent)",opacity:.4,lineHeight:1,marginBottom:14}}>{s.n}</div>',
  '              <div style={{fontFamily:"var(--ff)",fontSize:17,fontWeight:700,color:"var(--txt)",marginBottom:10}}>{s.t}</div>',
  '              <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",lineHeight:1.65}}>{s.d}</div>',
  '            </div>)}',
  '          </div>',
  '        </div>',
  '      </div>',
  '',
  "      {/* ── WHY IT'S DIFFERENT ── */}",
  '      <div style={{maxWidth:1000,margin:"0 auto",padding:"64px 32px"}}>',
  '        <div style={{textAlign:"center",marginBottom:48}}>',
  '          <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",fontWeight:600,letterSpacing:2,marginBottom:8}}>WHY SCANNER</div>',
  '          <h2 style={{fontFamily:"var(--ff)",fontSize:32,fontWeight:800,color:"var(--txt)",letterSpacing:-0.5}}>No other site does this.</h2>',
  '        </div>',
  '        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:24}} className="how-grid">',
  '          {[',
  "            {i:\"🔍\",t:\"No guessing required\",d:\"You don\\'t need to know your CPU or GPU model. The scanner reads it directly from your PC. Accurate every time.\"},",
  "            {i:\"🎯\",t:\"Budget-aware recommendations\",d:\"Tell us your budget — we\\'ll recommend the biggest performance upgrade for the money, including motherboard/RAM if your platform is outdated.\"},",
  "            {i:\"⚡\",t:\"Instant & private\",d:\"Scan runs locally on your PC. We don\\'t collect or store your hardware data. Everything stays on your machine.\"},",
  "            {i:\"💎\",t:\"Built exclusively here\",d:\"You won\\'t find this feature on PCPartPicker, Newegg, or any other builder site. Pro Rig Builder is the only one offering it.\"},",
  '          ].map(f=><div key={f.t} style={{background:"var(--card)",borderRadius:14,padding:"24px 22px",border:"1px solid var(--bdr)",display:"flex",gap:16,alignItems:"flex-start"}}>',
  '            <div style={{fontSize:32,lineHeight:1}}>{f.i}</div>',
  '            <div>',
  '              <div style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:700,color:"var(--txt)",marginBottom:6}}>{f.t}</div>',
  '              <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",lineHeight:1.6}}>{f.d}</div>',
  '            </div>',
  '          </div>)}',
  '        </div>',
  '      </div>',
  '',
  '      {/* ── DOWNLOAD CTA ── */}',
  '      <div style={{background:"var(--bg2)",borderTop:"1px solid var(--bdr)"}}>',
  '        <div style={{maxWidth:720,margin:"0 auto",padding:"64px 32px",textAlign:"center"}}>',
  '          <h2 style={{fontFamily:"var(--ff)",fontSize:32,fontWeight:800,color:"var(--txt)",letterSpacing:-0.5,marginBottom:14}}>Ready to find your next upgrade?</h2>',
  '          <p style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--dim)",marginBottom:28,lineHeight:1.65}}>',
  '            Download the Pro Rig Scanner and get personalized recommendations in under a minute.',
  '          </p>',
  '          <a href="/downloads/ProRigScanner.exe" download style={{textDecoration:"none",padding:"16px 40px",borderRadius:14,fontSize:16,fontFamily:"var(--ff)",fontWeight:700,background:"var(--accent)",color:"#fff",border:"none",boxShadow:"0 6px 28px rgba(255,107,53,.35)",display:"inline-flex",alignItems:"center",gap:10,transition:"transform .15s"}}',
  '            onMouseEnter={e=>e.currentTarget.style.transform="translateY(-2px)"}',
  '            onMouseLeave={e=>e.currentTarget.style.transform="none"}>',
  '            📥 Download Pro Rig Scanner',
  '          </a>',
  '          <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",marginTop:16,letterSpacing:1}}>',
  '            Free · Windows 10/11 · No account · No tracking',
  '          </div>',
  '        </div>',
  '      </div>',
  '    </div>',
  '  );',
  '}',
  '',
  '',
].join("\n");

if (src.includes(scannerPageAnchor) && !src.includes("function ScannerPage(")) {
  src = src.replace(scannerPageAnchor, scannerPageComponent + scannerPageAnchor);
  console.log("✓ Inserted ScannerPage component");
} else if (src.includes("function ScannerPage(")) {
  console.log("⚠ ScannerPage already defined");
} else {
  console.log("✗ HomePage anchor not found");
}

writeFileSync("./src/App.jsx", src);

// ═══════════════════════════════════════════════════════════════════
// PATCH 4: Add Scanner nav button after the logo button (line 390)
// ═══════════════════════════════════════════════════════════════════
const lines = readFileSync("./src/App.jsx", "utf8").split("\n");
if (!lines.some(l => l.includes('setPage("scanner")') && l.includes("Scanner"))) {
  // Find "      </button>" that closes the logo button (it should be right after the Pro Rig BUILDER div)
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('BUILDER</div></div>') && lines[i+1] && lines[i+1].trim() === '</button>') {
      insertAt = i + 2; // insert AFTER the closing </button>
      break;
    }
  }
  if (insertAt >= 0) {
    const navBtn = [
      '      <button onClick={()=>setPage("scanner")} style={{display:"inline-flex",alignItems:"center",gap:6,padding:"6px 12px",borderRadius:20,background:"var(--accent3)",border:"1px solid var(--accent)",color:"var(--accent)",fontFamily:"var(--ff)",fontSize:11,fontWeight:700,cursor:"pointer",marginRight:20,transition:"all .15s"}}',
      '        onMouseEnter={e=>{e.currentTarget.style.background="var(--accent)";e.currentTarget.style.color="#fff";}}',
      '        onMouseLeave={e=>{e.currentTarget.style.background="var(--accent3)";e.currentTarget.style.color="var(--accent)";}}>',
      '        <span style={{fontSize:13}}>📥</span> Scanner',
      '      </button>',
    ];
    lines.splice(insertAt, 0, ...navBtn);
    writeFileSync("./src/App.jsx", lines.join("\n"));
    console.log("✓ Added Scanner nav button at line " + (insertAt + 1));
  } else {
    console.log("✗ Nav logo button closing not found");
  }
} else {
  console.log("⚠ Scanner nav button already present");
}

console.log("\n═══ PATCH COMPLETE ═══");
console.log("Backup: ./src/App.jsx.pre-scanner-safe.backup");
