const fs = require('fs');
let s = fs.readFileSync('src/App.jsx', 'utf8');
s = s.replace(/\r\n/g, '\n');

// ═══ Mobile component as a string array (avoids template literal $ traps) ═══
const LINES = [
'',
'/* === MOBILE BUILDER PART PICKER === */',
'function MobileBuilerPartPicker({cat,meta,cols,compatList,onAdd,onBack,isMulti}){',
'  const [q,setQ]=useState("");',
'  const [sort,setSort]=useState("price-asc");',
'  const [brands,setBrands]=useState([]);',
'  const [minR,setMinR]=useState(0);',
'  const [prMin,setPrMin]=useState(0);',
'  const [prMax,setPrMax]=useState(99999);',
'  const [expanded,setExpanded]=useState(null);',
'  const [filtersOpen,setFiltersOpen]=useState(false);',
'',
'  const allBr=[...new Set(compatList.map(p=>p.b))].sort();',
'  const prMx=Math.max(...compatList.map(p=>$(p)),100);',
'',
'  let list=compatList.filter(p=>{',
'    if(q&&!p.n.toLowerCase().includes(q.toLowerCase())&&!p.b.toLowerCase().includes(q.toLowerCase()))return false;',
'    if(brands.length&&!brands.includes(p.b))return false;',
'    if(minR&&p.r<minR)return false;',
'    if($(p)<prMin||$(p)>prMax)return false;',
'    return true;',
'  });',
'  if(sort==="price-asc")list.sort((a,b)=>$(a)-$(b));',
'  else if(sort==="price-desc")list.sort((a,b)=>$(b)-$(a));',
'  else if(sort==="rating-desc")list.sort((a,b)=>b.r-a.r);',
'  else if(sort==="bench-desc")list.sort((a,b)=>(b.bench||0)-(a.bench||0));',
'',
'  const ac=[brands.length,minR,prMax<99999,prMin>0].filter(Boolean).length;',
'  const clearFilters=()=>{setBrands([]);setMinR(0);setPrMin(0);setPrMax(99999);};',
'',
'  return <div className="fade" style={{padding:"12px 12px 80px",maxWidth:"100vw",overflow:"hidden"}}>',
'    {/* Header */}',
'    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>',
'      <button onClick={onBack} style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:8,padding:"8px 12px",cursor:"pointer",fontFamily:"var(--ff)",fontSize:11,fontWeight:600,color:"var(--txt)",flexShrink:0}}>\u2190 Back</button>',
'      <div style={{flex:1,minWidth:0}}>',
'        <div style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:800,color:"var(--txt)",display:"flex",alignItems:"center",gap:6,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>',
'          <span style={{fontSize:18}}>{meta.icon}</span> Choose {meta.singular||meta.label}',
'        </div>',
'        <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",marginTop:1}}>{list.length} of {compatList.length}</div>',
'      </div>',
'    </div>',
'',
'    {/* Search bar */}',
'    <div style={{position:"relative",marginBottom:10}}>',
'      <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:14,color:"var(--mute)"}}>\u{1F50D}</span>',
'      <input value={q} onChange={e=>setQ(e.target.value)} placeholder={"Search "+meta.label.toLowerCase()} style={{width:"100%",background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:8,padding:"10px 10px 10px 34px",fontSize:14,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none",boxSizing:"border-box"}}/>',
'      {q&&<button onClick={()=>setQ("")} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"var(--dim)",fontSize:14,cursor:"pointer"}}>\u2715</button>}',
'    </div>',
'',
'    {/* Filter + Sort bar */}',
'    <div style={{display:"flex",gap:8,marginBottom:14}}>',
'      <button onClick={()=>setFiltersOpen(true)} style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,background:ac>0?"var(--accent3)":"var(--bg3)",border:"1px solid "+(ac>0?"var(--accent)":"var(--bdr)"),borderRadius:8,padding:"10px",fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:ac>0?"var(--accent)":"var(--txt)",cursor:"pointer"}}>\u2699 Filters{ac>0?" ("+ac+")":""}</button>',
'      <select value={sort} onChange={e=>setSort(e.target.value)} style={{flex:1,background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:8,padding:"10px",fontSize:13,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none",cursor:"pointer"}}>',
'        <option value="price-asc">Price \u2191</option>',
'        <option value="price-desc">Price \u2193</option>',
'        <option value="rating-desc">Top Rated</option>',
'        <option value="bench-desc">Performance</option>',
'      </select>',
'    </div>',
'',
'    {/* Product cards */}',
'    {list.length===0&&<div style={{textAlign:"center",padding:"48px 16px",color:"var(--dim)",fontFamily:"var(--ff)",fontSize:14}}>No parts match your filters</div>}',
'    <div style={{display:"flex",flexDirection:"column",gap:10}}>',
'      {list.map(p=>{',
'        const isExp=expanded===p.id;',
'        return <div key={p.id} style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,overflow:"hidden",maxWidth:"100%"}}>',
'          {isExp&&<ProductSchema p={p}/>}',
'          <div onClick={()=>setExpanded(isExp?null:p.id)} style={{display:"flex",gap:12,padding:12,cursor:"pointer",minWidth:0}}>',
'            {p.img?<img loading="lazy" decoding="async" src={p.img} alt="" style={{width:64,height:64,objectFit:"contain",borderRadius:8,background:"#fff",flexShrink:0}}/>:<div style={{width:64,height:64,background:"var(--bg4)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0}}>{meta.icon}</div>}',
'            <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column",gap:4}}>',
'              <div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)",lineHeight:1.3,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{p.n}</div>',
'              <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>',
'                <span style={{fontSize:11,color:"var(--dim)",fontFamily:"var(--ff)"}}>{p.b}</span>',
'                {p.r&&<Stars r={p.r} s={10}/>}',
'                {p.cp&&<Tag color="var(--amber)">-DOLLAR{p.off}</Tag>}',
'                {p.bundle&&<Tag color="var(--amber)">BUNDLE</Tag>}',
'              </div>',
'              <div style={{display:"flex",alignItems:"baseline",gap:8,marginTop:2}}>',
'                <span style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:800,color:"var(--mint)"}}>DOLLAR{fmtPrice($(p))}</span>',
'                {p.msrp&&p.msrp>$(p)&&<span style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--mute)",textDecoration:"line-through"}}>DOLLAR{fmtPrice(p.msrp)}</span>}',
'              </div>',
'            </div>',
'          </div>',
'          <div style={{display:"flex",gap:8,padding:"0 12px 12px",alignItems:"center"}}>',
'            <button onClick={e=>{e.stopPropagation();setExpanded(isExp?null:p.id);}} style={{flex:1,background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:6,padding:"8px",fontFamily:"var(--ff)",fontSize:12,fontWeight:600,color:"var(--txt)",cursor:"pointer"}}>{isExp?"Hide specs":"View specs"}</button>',
'            <button onClick={e=>{e.stopPropagation();onAdd(p);}} style={{flex:1,background:"var(--mint)",border:"none",borderRadius:6,padding:"8px",fontFamily:"var(--ff)",fontSize:12,fontWeight:700,color:"var(--bg)",cursor:"pointer"}}>+ Add to Build</button>',
'          </div>',
'          {isExp&&<div style={{padding:"0 12px 14px",borderTop:"1px solid var(--bdr)"}}>',
'            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",fontWeight:700,letterSpacing:1,margin:"12px 0 8px"}}>SPECIFICATIONS</div>',
'            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 12px"}}>',
'              {Object.entries(p).filter(([k])=>!["id","n","c","b","pr","r","cp","off","deals","msrp","url","img","bench","condition","generation","chipset","uid","reviews","asin","discount","listPrice","percentageDiscount","fullTitle","description","enrichedAt","additionalImages","amazonCategories","applicableVouchers","boughtPastMonth","isAmazonChoice","isBestSeller","isAvailable","currency","discoveredVia","discoveredAt","sourceFile","imageUrl","amazonUrl","category","brand","name","title","specs","needsReview","bundle"].includes(k)&&p[k]!=null&&typeof p[k]!=="object").map(([k,v])=>',
'                <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:"1px solid var(--bdr)",gap:8,minWidth:0}}>',
'                  <span style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--dim)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{SL[k]||k}</span>',
'                  <span style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--txt)",fontWeight:600,textAlign:"right",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{fmt(k,v)}</span>',
'                </div>',
'              )}',
'            </div>',
'            {p.bench!=null&&<div style={{marginTop:10}}>',
'              <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",marginBottom:4}}>PERFORMANCE</div>',
'              <SBar v={p.bench}/>',
'            </div>}',
'          </div>}',
'        </div>;',
'      })}',
'    </div>',
'',
'    {/* Filter bottom sheet */}',
'    {filtersOpen&&<div onClick={()=>setFiltersOpen(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:1000,display:"flex",alignItems:"flex-end"}}>',
'      <div onClick={e=>e.stopPropagation()} style={{background:"var(--bg2)",width:"100%",maxHeight:"85vh",overflowY:"auto",borderTopLeftRadius:16,borderTopRightRadius:16,padding:"16px 16px 32px",boxSizing:"border-box"}}>',
'        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,position:"sticky",top:0,background:"var(--bg2)",paddingBottom:8,borderBottom:"1px solid var(--bdr)"}}>',
'          <span style={{fontFamily:"var(--ff)",fontSize:18,fontWeight:800,color:"var(--txt)"}}>Filters</span>',
'          <div style={{display:"flex",gap:10}}>',
'            {ac>0&&<button onClick={clearFilters} style={{background:"none",border:"none",color:"var(--rose)",fontFamily:"var(--ff)",fontSize:13,cursor:"pointer",padding:0}}>Clear</button>}',
'            <button onClick={()=>setFiltersOpen(false)} style={{background:"var(--accent)",border:"none",color:"#fff",fontFamily:"var(--ff)",fontSize:13,fontWeight:700,padding:"6px 16px",borderRadius:6,cursor:"pointer"}}>Done</button>',
'          </div>',
'        </div>',
'',
'        <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mint)",fontWeight:700,letterSpacing:1,marginBottom:6}}>PRICE RANGE</div>',
'        <div style={{display:"flex",gap:8,marginBottom:16}}>',
'          <input type="number" value={prMin||""} onChange={e=>setPrMin(+e.target.value||0)} placeholder="Min DOLLAR" style={{flex:1,background:"var(--bg4)",border:"1px solid var(--bdr)",borderRadius:6,padding:"8px 10px",fontSize:13,color:"var(--txt)",fontFamily:"var(--mono)",outline:"none",boxSizing:"border-box"}}/>',
'          <input type="number" value={prMax>=99999?"":prMax} onChange={e=>setPrMax(+e.target.value||99999)} placeholder="Max DOLLAR" style={{flex:1,background:"var(--bg4)",border:"1px solid var(--bdr)",borderRadius:6,padding:"8px 10px",fontSize:13,color:"var(--txt)",fontFamily:"var(--mono)",outline:"none",boxSizing:"border-box"}}/>',
'        </div>',
'',
'        {allBr.length>0&&<div style={{marginBottom:16}}>',
'          <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mint)",fontWeight:700,letterSpacing:1,marginBottom:8}}>BRAND</div>',
'          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>',
'            {allBr.map(b=>{',
'              const on=brands.includes(b);',
'              return <button key={b} onClick={()=>setBrands(p=>p.includes(b)?p.filter(x=>x!==b):[...p,b])} style={{background:on?"var(--accent3)":"var(--bg3)",border:"1px solid "+(on?"var(--accent)":"var(--bdr)"),borderRadius:18,padding:"6px 12px",fontFamily:"var(--ff)",fontSize:12,color:on?"var(--accent)":"var(--txt)",fontWeight:on?600:400,cursor:"pointer"}}>{b} <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--mute)",marginLeft:2}}>{compatList.filter(p=>p.b===b).length}</span></button>;',
'            })}',
'          </div>',
'        </div>}',
'',
'        <div style={{marginBottom:16}}>',
'          <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mint)",fontWeight:700,letterSpacing:1,marginBottom:8}}>MIN RATING</div>',
'          <div style={{display:"flex",gap:6}}>',
'            {[0,4,4.5].map(rv=>{',
'              const on=minR===rv;',
'              return <button key={rv} onClick={()=>setMinR(rv)} style={{flex:1,background:on?"var(--accent3)":"var(--bg3)",border:"1px solid "+(on?"var(--accent)":"var(--bdr)"),borderRadius:8,padding:"8px",fontFamily:"var(--ff)",fontSize:12,color:on?"var(--accent)":"var(--txt)",fontWeight:on?600:400,cursor:"pointer"}}>{rv?rv+"+ \u2605":"Any"}</button>;',
'            })}',
'          </div>',
'        </div>',
'',
'        <button onClick={()=>setFiltersOpen(false)} style={{width:"100%",background:"var(--accent)",border:"none",color:"#fff",fontFamily:"var(--ff)",fontSize:14,fontWeight:700,padding:"14px",borderRadius:8,cursor:"pointer"}}>Show {list.length} results</button>',
'      </div>',
'    </div>}',
'  </div>;',
'}',
'',
'/* === Router: desktop or mobile === */',
'function BuilerPartPickerRouter(props){',
'  const isMobile=useIsMobile();',
'  return isMobile?<MobileBuilerPartPicker {...props}/>:<BuilerPartPicker {...props}/>;',
'}',
'',
];

let mobileComponent = LINES.join('\n').split('DOLLAR').join('$');

// PART B: Insert the mobile component AFTER the BuilerPartPicker function definition
// (before "/* ═══ BUILDER ═══ */" comment)
const insertBefore = '/* ══';
// Actually safer — find where BuilerPartPicker ends and BuilderPage begins
const builderStart = s.indexOf('function BuilderPage({th}){');
if (builderStart < 0) {
  console.log('BuilderPage anchor not found');
  process.exit(1);
}
// Find comment line just before BuilderPage (the /* ═══ BUILDER ═══ */ line)
// We insert right before this comment
let insertIdx = s.lastIndexOf('\n', builderStart - 1); // end of line before function
// Walk back past any comment line
const before100 = s.substring(Math.max(0, builderStart - 200), builderStart);
console.log('Context before BuilderPage:\n---\n' + before100 + '\n---');

// Safer: find the closing '}' of BuilerPartPicker function. That's complex.
// Instead: just insert right before "function BuilderPage" — insertIdx already points there
insertIdx = builderStart;

// Check if mobile version already present
if (s.includes('function MobileBuilerPartPicker(')) {
  console.log('Already has MobileBuilerPartPicker - stripping old copy');
  const oldStart = s.indexOf('/* === MOBILE BUILDER PART PICKER === */');
  const oldEnd = s.indexOf('function BuilderPage({th}){');
  if (oldStart > 0 && oldEnd > oldStart) {
    s = s.substring(0, oldStart) + s.substring(oldEnd);
  }
}

const insertIdx2 = s.indexOf('function BuilderPage({th}){');
s = s.substring(0, insertIdx2) + mobileComponent + '\n' + s.substring(insertIdx2);
console.log('✓ MobileBuilerPartPicker inserted');

// PART C: Change the CALL site from <BuilerPartPicker ... /> to <BuilerPartPickerRouter ... />
// The call site uses JSX props spread over multiple lines potentially. Let's be specific.
const callOld = '<BuilerPartPicker';
const callNew = '<BuilerPartPickerRouter';
const callCount = s.split(callOld).length - 1;
// Note: "BuilerPartPicker" substring is also in "BuilerPartPickerRouter" — to avoid overcount,
// use a more specific match: "<BuilerPartPicker\n" or "<BuilerPartPicker " (space)
const callPatterns = ['<BuilerPartPicker\n', '<BuilerPartPicker ', '<BuilerPartPicker\t'];
let replaced = 0;
for (const pat of callPatterns) {
  const newPat = pat.replace('<BuilerPartPicker', '<BuilerPartPickerRouter');
  while (s.includes(pat)) {
    s = s.replace(pat, newPat);
    replaced++;
    if (replaced > 5) break;
  }
}
console.log('✓ Replaced ' + replaced + ' call sites of BuilerPartPicker with BuilerPartPickerRouter');

fs.writeFileSync('src/App.jsx', s);
console.log('DONE');
