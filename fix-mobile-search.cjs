const fs = require('fs');
let s = fs.readFileSync('src/App.jsx', 'utf8');
s = s.replace(/\r\n/g, '\n');

// ============================================================
// PART A: Build the MobileSearchPage component
// ============================================================
const mobileComponent = `
// ═══ MOBILE SEARCH PAGE ═══
function MobileSearchPage({activeCat,th}){
  const [cat,setCat]=useState(activeCat||"");
  const [q,setQ]=useState("");
  const [brands,setBrands]=useState([]);
  const [marketplaces,setMarketplaces]=useState([]);
  const [maxPr,setMaxPr]=useState(5000);
  const [minPr,setMinPr]=useState(0);
  const [minR,setMinR]=useState(0);
  const [sort,setSort]=useState("price-asc");
  const [expanded,setExpanded]=useState(null);
  const [filtersOpen,setFiltersOpen]=useState(false);
  useEffect(()=>{if(activeCat)setCat(activeCat);},[activeCat]);

  const catP=cat?P.filter(p=>p.c===cat):P;
  const allBr=[...new Set(catP.map(p=>p.b))].sort();
  const allMarkets=[...new Set(catP.flatMap(p=>p.deals&&typeof p.deals==="object"?Object.keys(p.deals).filter(k=>p.deals[k]&&typeof p.deals[k]==="object"&&p.deals[k].price):[]))].sort();
  const prMx=Math.max(...catP.map(p=>$(p)),100);

  const list=useMemo(()=>{
    let r=catP;
    if(q)r=r.filter(p=>p.n.toLowerCase().includes(q.toLowerCase())||p.b.toLowerCase().includes(q.toLowerCase()));
    if(brands.length)r=r.filter(p=>brands.includes(p.b));
    if(marketplaces.length)r=r.filter(p=>p.deals&&typeof p.deals==="object"&&marketplaces.some(m=>p.deals[m]&&typeof p.deals[m]==="object"&&p.deals[m].price));
    r=r.filter(p=>$(p)<=maxPr&&$(p)>=minPr);
    if(minR)r=r.filter(p=>p.r>=minR);
    const [sk,sd]=sort.split("-");
    r=[...r].sort((a,b)=>{
      const va=sk==="price"?$(a):sk==="rating"?a.r:sk==="value"?(a.value!=null?a.value:(a.bench||0)/Math.max($(a)/100,1)):(a.bench||0);
      const vb=sk==="price"?$(b):sk==="rating"?b.r:sk==="value"?(b.value!=null?b.value:(b.bench||0)/Math.max($(b)/100,1)):(b.bench||0);
      return sd==="asc"?va-vb:vb-va;
    });
    return r;
  },[cat,q,brands,marketplaces,maxPr,minPr,minR,sort]);

  const ac=[brands.length,marketplaces.length,minR,maxPr<prMx,minPr>0].filter(Boolean).length;
  const clearFilters=()=>{setBrands([]);setMarketplaces([]);setMaxPr(5000);setMinPr(0);setMinR(0);};

  // Category picker screen
  if(!cat){
    return <div className="fade" style={{padding:"16px 14px",maxWidth:"100vw",overflow:"hidden"}}>
      <h1 style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--txt)",marginBottom:6}}>Browse Parts</h1>
      <p style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",marginBottom:18}}>Pick a category</p>
      <div style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:10}}>
        {CATS.map(c=>{
          const meta=CAT[c];
          const count=P.filter(p=>p.c===c).length;
          return <button key={c} onClick={()=>setCat(c)} style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:"14px 12px",cursor:"pointer",textAlign:"left",display:"flex",flexDirection:"column",gap:6,minWidth:0}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <CatThumb cat={c} thumbs={th.thumbs} setThumb={th.setThumb} removeThumb={th.removeThumb} size={32} rounded={6} editable={false}/>
              <span style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:700,color:"var(--txt)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1,minWidth:0}}>{meta.label}</span>
            </div>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",fontWeight:600}}>{count} products</div>
          </button>;
        })}
      </div>
    </div>;
  }

  // Product list screen
  return <div className="fade" style={{padding:"12px 12px 80px",maxWidth:"100vw",overflow:"hidden"}}>
    {/* Breadcrumb */}
    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10,flexWrap:"wrap"}}>
      <button onClick={()=>setCat("")} style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--dim)",background:"none",border:"none",cursor:"pointer",padding:0}}>← All</button>
      <span style={{color:"var(--mute)"}}>/</span>
      <span style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--accent)",fontWeight:700}}>{CAT[cat].label}</span>
      <span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",marginLeft:"auto"}}>{list.length}</span>
    </div>

    {/* Search bar */}
    <div style={{position:"relative",marginBottom:10}}>
      <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:14,color:"var(--mute)"}}>🔍</span>
      <input value={q} onChange={e=>setQ(e.target.value)} placeholder={"Search "+CAT[cat].label.toLowerCase()} style={{width:"100%",background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:8,padding:"10px 10px 10px 34px",fontSize:14,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none",boxSizing:"border-box"}}/>
      {q&&<button onClick={()=>setQ("")} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"var(--dim)",fontSize:14,cursor:"pointer"}}>✕</button>}
    </div>

    {/* Filter + Sort bar */}
    <div style={{display:"flex",gap:8,marginBottom:14}}>
      <button onClick={()=>setFiltersOpen(true)} style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,background:ac>0?"var(--accent3)":"var(--bg3)",border:"1px solid "+(ac>0?"var(--accent)":"var(--bdr)"),borderRadius:8,padding:"10px",fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:ac>0?"var(--accent)":"var(--txt)",cursor:"pointer"}}>
        <span>⚙</span> Filters{ac>0?" ("+ac+")":""}
      </button>
      <select value={sort} onChange={e=>setSort(e.target.value)} style={{flex:1,background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:8,padding:"10px",fontSize:13,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none",cursor:"pointer"}}>
        <option value="price-asc">Price ↑</option>
        <option value="price-desc">Price ↓</option>
        <option value="rating-desc">Top Rated</option>
        <option value="bench-desc">Performance</option>
        <option value="value-desc">Best Value</option>
      </select>
    </div>

    {/* Product cards */}
    {list.length===0&&<div style={{textAlign:"center",padding:"48px 16px",color:"var(--dim)",fontFamily:"var(--ff)",fontSize:14}}>No products match your filters</div>}
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {list.map(p=>{
        const isExp=expanded===p.id;
        const rr=retailers(p);
        return <div key={p.id} style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,overflow:"hidden",maxWidth:"100%"}}>
          {isExp&&<ProductSchema p={p}/>}
          <div onClick={()=>setExpanded(isExp?null:p.id)} style={{display:"flex",gap:12,padding:12,cursor:"pointer",minWidth:0}}>
            {p.img?<img loading="lazy" decoding="async" src={p.img} alt="" style={{width:72,height:72,objectFit:"contain",borderRadius:8,background:"#fff",flexShrink:0}}/>:<div style={{width:72,height:72,background:"var(--bg4)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,flexShrink:0}}>{ic(p)}</div>}
            <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column",gap:4}}>
              <div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)",lineHeight:1.3,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{p.n}</div>
              <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                <span style={{fontSize:11,color:"var(--dim)",fontFamily:"var(--ff)"}}>{p.b}</span>
                {p.r&&<Stars r={p.r} s={10}/>}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                {p.cp&&<Tag color="var(--amber)">-${p.off}</Tag>}
                {(p.used===true||p.condition==="used")&&<Tag color="#F59E0B">USED</Tag>}
                {p.condition==="refurbished"&&<Tag color="var(--sky)">REFURB</Tag>}
                {p.condition==="open-box"&&<Tag color="var(--violet)">OPEN BOX</Tag>}
                {p.bundle&&<Tag color="var(--amber)">BUNDLE</Tag>}
              </div>
              <div style={{display:"flex",alignItems:"baseline",gap:8,marginTop:2}}>
                <span style={{fontFamily:"var(--ff)",fontSize:18,fontWeight:800,color:"var(--mint)"}}>\${fmtPrice($(p))}</span>
                {p.msrp&&p.msrp>$(p)&&<span style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--mute)",textDecoration:"line-through"}}>\${fmtPrice(p.msrp)}</span>}
              </div>
            </div>
            <div style={{display:"flex",alignItems:"center",color:"var(--dim)",fontSize:18,transition:"transform .2s",transform:isExp?"rotate(90deg)":"none"}}>›</div>
          </div>

          {isExp&&<div style={{padding:"0 12px 14px",borderTop:"1px solid var(--bdr)"}}>
            {/* Retailers */}
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",fontWeight:700,letterSpacing:1,margin:"12px 0 8px"}}>BUY AT</div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {rr.length>0?rr.map((r,ri)=>
                <a key={r.name} href={r.url} target="_blank" rel="noopener noreferrer" style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:8,textDecoration:"none",background:ri===0?"var(--mint3)":"var(--bg3)",border:"1px solid "+(ri===0?"var(--mint)33":"var(--bdr)")}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
                      <span style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:700,color:"var(--txt)",textTransform:"capitalize"}}>{r.name}</span>
                      {ri===0&&rr.length>1&&<Tag color="var(--mint)">BEST</Tag>}
                    </div>
                    <div style={{fontFamily:"var(--ff)",fontSize:10,color:r.inStock?"var(--sky)":"var(--rose)"}}>{r.inStock?"✓ In Stock":"✗ Out of Stock"}</div>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                    <span style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:800,color:ri===0?"var(--mint)":"var(--txt)"}}>\${fmtPrice(r.price)}</span>
                    <div style={{background:ri===0?"var(--mint)":"var(--bg4)",borderRadius:6,padding:"6px 12px",fontFamily:"var(--ff)",fontSize:11,fontWeight:700,color:ri===0?"var(--bg)":"var(--txt)"}}>Buy</div>
                  </div>
                </a>
              ):<a href={p.deals?.amazon?.url||"#"} target="_blank" rel="noopener noreferrer" style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 12px",borderRadius:8,background:"var(--mint3)",border:"1px solid var(--mint)33",textDecoration:"none"}}>
                <div>
                  <span style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:700,color:"var(--txt)"}}>Amazon</span>
                  <div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--sky)"}}>✓ In Stock</div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:800,color:"var(--mint)"}}>\${fmtPrice($(p))}</span>
                  <div style={{background:"var(--mint)",borderRadius:6,padding:"6px 12px",fontFamily:"var(--ff)",fontSize:11,fontWeight:700,color:"var(--bg)"}}>Buy</div>
                </div>
              </a>}
            </div>

            {/* Key specs */}
            {CAT[cat]?.cols?.length>0&&<div style={{marginTop:14}}>
              <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",fontWeight:700,letterSpacing:1,marginBottom:8}}>KEY SPECS</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 12px"}}>
                {CAT[cat].cols.map(col=>{
                  const v=p[col];if(v==null)return null;
                  const fv=fmt(col,v,p);
                  return <div key={col} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:"1px solid var(--bdr)",gap:8,minWidth:0}}>
                    <span style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--dim)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{SL[col]||col}</span>
                    <span style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--txt)",fontWeight:600,textAlign:"right",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{col==="bench"?v+"%":fv}</span>
                  </div>;
                })}
              </div>
            </div>}
          </div>}
        </div>;
      })}
    </div>

    {/* Filter bottom sheet */}
    {filtersOpen&&<div onClick={()=>setFiltersOpen(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:1000,display:"flex",alignItems:"flex-end"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:"var(--bg2)",width:"100%",maxHeight:"85vh",overflowY:"auto",borderTopLeftRadius:16,borderTopRightRadius:16,padding:"16px 16px 32px",boxSizing:"border-box"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,position:"sticky",top:0,background:"var(--bg2)",paddingBottom:8,borderBottom:"1px solid var(--bdr)"}}>
          <span style={{fontFamily:"var(--ff)",fontSize:18,fontWeight:800,color:"var(--txt)"}}>Filters</span>
          <div style={{display:"flex",gap:10}}>
            {ac>0&&<button onClick={clearFilters} style={{background:"none",border:"none",color:"var(--rose)",fontFamily:"var(--ff)",fontSize:13,cursor:"pointer",padding:0}}>Clear</button>}
            <button onClick={()=>setFiltersOpen(false)} style={{background:"var(--accent)",border:"none",color:"#fff",fontFamily:"var(--ff)",fontSize:13,fontWeight:700,padding:"6px 16px",borderRadius:6,cursor:"pointer"}}>Done</button>
          </div>
        </div>

        <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mint)",fontWeight:700,letterSpacing:1,marginBottom:6}}>PRICE RANGE</div>
        <div style={{display:"flex",gap:8,marginBottom:8}}>
          <input type="number" value={minPr||""} onChange={e=>setMinPr(+e.target.value||0)} placeholder="Min $" style={{flex:1,background:"var(--bg4)",border:"1px solid var(--bdr)",borderRadius:6,padding:"8px 10px",fontSize:13,color:"var(--txt)",fontFamily:"var(--mono)",outline:"none",boxSizing:"border-box"}}/>
          <input type="number" value={maxPr>=5000?"":maxPr} onChange={e=>setMaxPr(+e.target.value||5000)} placeholder="Max $" style={{flex:1,background:"var(--bg4)",border:"1px solid var(--bdr)",borderRadius:6,padding:"8px 10px",fontSize:13,color:"var(--txt)",fontFamily:"var(--mono)",outline:"none",boxSizing:"border-box"}}/>
        </div>
        <input type="range" min={0} max={Math.ceil(prMx/50)*50} value={Math.min(maxPr,Math.ceil(prMx/50)*50)} onChange={e=>setMaxPr(+e.target.value)} style={{width:"100%",marginBottom:4}}/>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:16}}>
          <span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mute)"}}>\${minPr}</span>
          <span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mint)",fontWeight:600}}>to \${maxPr>=5000?"∞":"$"+maxPr}</span>
        </div>

        {allBr.length>0&&<div style={{marginBottom:16}}>
          <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mint)",fontWeight:700,letterSpacing:1,marginBottom:8}}>BRAND</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            {allBr.map(b=>{
              const on=brands.includes(b);
              return <button key={b} onClick={()=>setBrands(p=>p.includes(b)?p.filter(x=>x!==b):[...p,b])} style={{background:on?"var(--accent3)":"var(--bg3)",border:"1px solid "+(on?"var(--accent)":"var(--bdr)"),borderRadius:18,padding:"6px 12px",fontFamily:"var(--ff)",fontSize:12,color:on?"var(--accent)":"var(--txt)",fontWeight:on?600:400,cursor:"pointer"}}>{b} <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--mute)",marginLeft:2}}>{catP.filter(p=>p.b===b).length}</span></button>;
            })}
          </div>
        </div>}

        {allMarkets.length>0&&<div style={{marginBottom:16}}>
          <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mint)",fontWeight:700,letterSpacing:1,marginBottom:8}}>MARKETPLACE</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            {allMarkets.map(m=>{
              const cap=m.charAt(0).toUpperCase()+m.slice(1);
              const on=marketplaces.includes(m);
              return <button key={m} onClick={()=>setMarketplaces(p=>p.includes(m)?p.filter(x=>x!==m):[...p,m])} style={{background:on?"var(--accent3)":"var(--bg3)",border:"1px solid "+(on?"var(--accent)":"var(--bdr)"),borderRadius:18,padding:"6px 12px",fontFamily:"var(--ff)",fontSize:12,color:on?"var(--accent)":"var(--txt)",fontWeight:on?600:400,cursor:"pointer"}}>{cap}</button>;
            })}
          </div>
        </div>}

        <div style={{marginBottom:16}}>
          <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mint)",fontWeight:700,letterSpacing:1,marginBottom:8}}>MIN RATING</div>
          <div style={{display:"flex",gap:6}}>
            {[0,4,4.5].map(rv=>{
              const on=minR===rv;
              return <button key={rv} onClick={()=>setMinR(rv)} style={{flex:1,background:on?"var(--accent3)":"var(--bg3)",border:"1px solid "+(on?"var(--accent)":"var(--bdr)"),borderRadius:8,padding:"8px",fontFamily:"var(--ff)",fontSize:12,color:on?"var(--accent)":"var(--txt)",fontWeight:on?600:400,cursor:"pointer"}}>{rv?rv+"+ ★":"Any"}</button>;
            })}
          </div>
        </div>

        <button onClick={()=>setFiltersOpen(false)} style={{width:"100%",background:"var(--accent)",border:"none",color:"#fff",fontFamily:"var(--ff)",fontSize:14,fontWeight:700,padding:"14px",borderRadius:8,cursor:"pointer"}}>Show {list.length} results</button>
      </div>
    </div>}
  </div>;
}

// ═══ RESPONSIVE ROUTER ═══
function useIsMobile(){
  const [m,setM]=useState(()=>typeof window!=="undefined"&&window.matchMedia("(max-width: 900px)").matches);
  useEffect(()=>{
    if(typeof window==="undefined")return;
    const mq=window.matchMedia("(max-width: 900px)");
    const handler=e=>setM(e.matches);
    mq.addEventListener?mq.addEventListener("change",handler):mq.addListener(handler);
    return()=>mq.removeEventListener?mq.removeEventListener("change",handler):mq.removeListener(handler);
  },[]);
  return m;
}
function SearchPageRouter(props){
  const isMobile=useIsMobile();
  return isMobile?<MobileSearchPage {...props}/>:<SearchPage {...props}/>;
}

`;

// ============================================================
// PART B: Insert the new component before SearchPage
// ============================================================
const insertBefore = 'function SearchPage({activeCat,th}){';
const idx = s.indexOf(insertBefore);
if (idx < 0) { console.log('INSERT ANCHOR MISS'); process.exit(1); }
s = s.substring(0, idx) + mobileComponent + s.substring(idx);
console.log('PART B OK: MobileSearchPage component inserted');

// ============================================================
// PART C: Change the route to use SearchPageRouter
// ============================================================
const oldRoute = 'page==="search"&&<SearchPage activeCat={bc} th={th}/>';
const newRoute = 'page==="search"&&<SearchPageRouter activeCat={bc} th={th}/>';
if (!s.includes(oldRoute)) { console.log('ROUTE ANCHOR MISS'); process.exit(1); }
s = s.replace(oldRoute, newRoute);
console.log('PART C OK: route updated to use SearchPageRouter');

fs.writeFileSync('src/App.jsx', s);
console.log('DONE');
