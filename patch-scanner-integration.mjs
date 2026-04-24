// patch-scanner-integration.mjs
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";

if (!existsSync("./src/App.jsx.pre-scanner-integration.backup")) {
  copyFileSync("./src/App.jsx", "./src/App.jsx.pre-scanner-integration.backup");
}

let src = readFileSync("./src/App.jsx", "utf8");

// ═══════════════════════════════════════════════════════════════════
// PATCH 1: Wrap hero content in 2-column grid + add scanner callout card
// ═══════════════════════════════════════════════════════════════════
const heroOpenAnchor = '      <div style={{maxWidth:1200,margin:"0 auto",padding:"80px 32px 72px"}}>';
const heroInnerOld = '        <div style={{maxWidth:640}}>';

const heroOuterNew = '      <div style={{maxWidth:1200,margin:"0 auto",padding:"80px 32px 72px"}}>\n        <div className="hero-grid" style={{display:"grid",gridTemplateColumns:"1.1fr 1fr",gap:48,alignItems:"center"}}>';
const heroInnerNew = '          <div>';

if (src.includes(heroOpenAnchor) && src.includes(heroInnerOld) && !src.includes('Scan your hardware')) {
  src = src.replace(heroOpenAnchor, heroOuterNew);
  src = src.replace(heroInnerOld, heroInnerNew);

  // Add scanner card after the <div> that closes the CTA buttons (line 441 closing </div>)
  // Find the closing of first column and add the scanner card
  const closeFirstColumn = '          </div>\n        </div>\n      </div>\n      <style>{`@keyframes pulse';

  const scannerCard = '          </div>\n' +
'          {/* ── SCANNER CALLOUT CARD (right column) ── */}\n' +
'          <div style={{background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:20,padding:"28px 26px",backdropFilter:"blur(8px)",boxShadow:"var(--shadow)",position:"relative",overflow:"hidden"}}>\n' +
'            {/* scan-line animation overlay */}\n' +
'            <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:"linear-gradient(90deg,transparent 0%,var(--accent) 50%,transparent 100%)",animation:"scanLine 3s ease-in-out infinite"}}/>\n' +
'            {/* NEW badge */}\n' +
'            <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"var(--amber)",color:"#1a1a20",padding:"4px 12px",borderRadius:12,fontFamily:"var(--mono)",fontSize:10,fontWeight:800,letterSpacing:1.5,marginBottom:16}}>\n' +
'              ✨ NEW · PROPRIETARY\n' +
'            </div>\n' +
'            <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:18}}>\n' +
'              <TowerLogo size={56}/>\n' +
'              <div>\n' +
'                <div style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--txt)",lineHeight:1.1,marginBottom:4}}>Pro Rig Scanner</div>\n' +
'                <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",letterSpacing:1}}>Free Windows app</div>\n' +
'              </div>\n' +
'            </div>\n' +
'            <p style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--dim)",lineHeight:1.6,marginBottom:18}}>\n' +
'              Scan your hardware and get personalized upgrade recommendations in seconds. Not available anywhere else.\n' +
'            </p>\n' +
'            {/* 3-step mini explainer */}\n' +
'            <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:22}}>\n' +
'              {[\n' +
'                {n:"1",t:"Download",d:"Free Windows app, under 2 MB"},\n' +
'                {n:"2",t:"Scan",d:"Detects your CPU, GPU, RAM & storage"},\n' +
'                {n:"3",t:"Upgrade",d:"Get recommendations in your budget"},\n' +
'              ].map(s=>(\n' +
'                <div key={s.n} style={{display:"flex",alignItems:"center",gap:12}}>\n' +
'                  <div style={{width:24,height:24,borderRadius:"50%",background:"var(--accent3)",color:"var(--accent)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"var(--mono)",fontSize:11,fontWeight:800,flexShrink:0}}>{s.n}</div>\n' +
'                  <div>\n' +
'                    <div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:700,color:"var(--txt)",lineHeight:1.2}}>{s.t}</div>\n' +
'                    <div style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--dim)",lineHeight:1.3}}>{s.d}</div>\n' +
'                  </div>\n' +
'                </div>\n' +
'              ))}\n' +
'            </div>\n' +
'            <button onClick={()=>go("scanner")} style={{width:"100%",padding:"12px 20px",borderRadius:10,fontSize:14,fontFamily:"var(--ff)",fontWeight:700,cursor:"pointer",background:"var(--accent)",color:"#fff",border:"none",boxShadow:"0 4px 14px rgba(255,107,53,.35)",transition:"transform .15s"}}\n' +
'              onMouseEnter={e=>e.currentTarget.style.transform="translateY(-1px)"}\n' +
'              onMouseLeave={e=>e.currentTarget.style.transform="none"}>\n' +
'              Learn More →\n' +
'            </button>\n' +
'            <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--mute)",textAlign:"center",marginTop:10,letterSpacing:1}}>WINDOWS 10 / 11 · FREE · NO ACCOUNT</div>\n' +
'          </div>\n' +
'        </div>\n' +
'      </div>\n' +
'      <style>{`@keyframes pulse';

  src = src.replace(closeFirstColumn, scannerCard);
  console.log("✓ Wrapped hero in 2-column grid and added scanner callout card");
} else if (src.includes('Scan your hardware')) {
  console.log("⚠ Scanner callout already present in hero, skipping");
} else {
  console.log("✗ Hero anchor not found — checking what's there");
  const m = src.match(/<div style={{maxWidth:1200[^>]*>\s*<div style={{maxWidth:640/);
  if (m) console.log("  Found pattern nearby at char:", m.index);
}

// ═══════════════════════════════════════════════════════════════════
// PATCH 2: Add scan-line keyframe to existing animations
// ═══════════════════════════════════════════════════════════════════
const keyframeAnchor = '<style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`}</style>';
const keyframeNew = '<style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}@keyframes scanLine{0%,100%{transform:translateX(-100%)}50%{transform:translateX(100%)}}`}</style>';
if (src.includes(keyframeAnchor)) {
  src = src.replace(keyframeAnchor, keyframeNew);
  console.log("✓ Added scanLine keyframe animation");
} else {
  console.log("⚠ Keyframe anchor not found or already updated");
}

// ═══════════════════════════════════════════════════════════════════
// PATCH 3: Add Scanner button to top Nav (next to logo)
// ═══════════════════════════════════════════════════════════════════
// Find the Nav function - need to add a button inside it
// The Nav is referenced at: <button onClick={()=>setPage("home")}... <TowerLogo.../><div><div>Pro Rig</div><div>BUILDER</div></div></button>
// After that button closes, we want to add the Scanner pill button
const navLogoClose = '        <div><div style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:700,color:"var(--txt)",lineHeight:1.1}}>Pro Rig</div><div style={{fontFamily:"var(--ff)",fontSize:9,fontWeight:500,color:"var(--dim)",letterSpacing:1.5}}>BUILDER</div></div>\n      </button>';
const navWithScannerBtn = navLogoClose + '\n      <button onClick={()=>setPage("scanner")} style={{display:"inline-flex",alignItems:"center",gap:6,padding:"6px 12px",borderRadius:20,background:"var(--accent3)",border:"1px solid var(--accent)",color:"var(--accent)",fontFamily:"var(--ff)",fontSize:11,fontWeight:700,cursor:"pointer",marginRight:20,transition:"all .15s"}}\n        onMouseEnter={e=>{e.currentTarget.style.background="var(--accent)";e.currentTarget.style.color="#fff";}}\n        onMouseLeave={e=>{e.currentTarget.style.background="var(--accent3)";e.currentTarget.style.color="var(--accent)";}}>\n        <span style={{fontSize:13}}>📥</span> Scanner\n      </button>';

if (src.includes(navLogoClose) && !src.includes('setPage("scanner")')) {
  src = src.replace(navLogoClose, navWithScannerBtn);
  console.log("✓ Added Scanner button to Nav");
} else if (src.includes('setPage("scanner")')) {
  console.log("⚠ Scanner nav button already present");
} else {
  console.log("✗ Nav logo anchor not found");
}

// ═══════════════════════════════════════════════════════════════════
// PATCH 4: Add /scanner route to router
// ═══════════════════════════════════════════════════════════════════
const routerAnchor = '{page==="upgrade"&&<UpgradePage/>}';
const routerNew = '{page==="upgrade"&&<UpgradePage/>}{page==="scanner"&&<ScannerPage go={setPage}/>}';
if (src.includes(routerAnchor) && !src.includes('page==="scanner"')) {
  src = src.replace(routerAnchor, routerNew);
  console.log("✓ Added /scanner route to router");
} else if (src.includes('page==="scanner"')) {
  console.log("⚠ Scanner route already wired");
} else {
  console.log("✗ Router anchor not found");
}

// ═══════════════════════════════════════════════════════════════════
// PATCH 5: Insert ScannerPage component before HomePage
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
  '            Download our free Windows app, run a quick scan, and get personalized upgrade recommendations tailored to your budget. No other site offers this — it\'s built exclusively by Pro Rig Builder.',
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
  '      {/* ── WHY IT\'S DIFFERENT ── */}',
  '      <div style={{maxWidth:1000,margin:"0 auto",padding:"64px 32px"}}>',
  '        <div style={{textAlign:"center",marginBottom:48}}>',
  '          <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",fontWeight:600,letterSpacing:2,marginBottom:8}}>WHY SCANNER</div>',
  '          <h2 style={{fontFamily:"var(--ff)",fontSize:32,fontWeight:800,color:"var(--txt)",letterSpacing:-0.5}}>No other site does this.</h2>',
  '        </div>',
  '        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:24}} className="how-grid">',
  '          {[',
  '            {i:"🔍",t:"No guessing required",d:"You don\'t need to know your CPU or GPU model. The scanner reads it directly from your PC. Accurate every time."},',
  '            {i:"🎯",t:"Budget-aware recommendations",d:"Tell us your budget — we\'ll recommend the biggest performance upgrade for the money, including motherboard/RAM if your platform is outdated."},',
  '            {i:"⚡",t:"Instant & private",d:"Scan runs locally on your PC. We don\'t collect or store your hardware data. Everything stays on your machine."},',
  '            {i:"💎",t:"Built exclusively here",d:"You won\'t find this feature on PCPartPicker, Newegg, or any other builder site. Pro Rig Builder is the only one offering it."},',
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
  console.log("⚠ ScannerPage component already defined");
} else {
  console.log("✗ HomePage anchor not found for ScannerPage insert");
}

writeFileSync("./src/App.jsx", src);
console.log("\n═══ PATCH COMPLETE ═══");
console.log("Backup: ./src/App.jsx.pre-scanner-integration.backup");
console.log("\nNote: .exe download at /downloads/ProRigScanner.exe will 404 until you host the file.");
