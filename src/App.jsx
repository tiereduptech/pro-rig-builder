import React, { useState, useMemo, useEffect, useRef, useCallback } from "react"
import { Box, Cpu, Snowflake, CircuitBoard, MemoryStick, Square, HardDrive, Plug, Fan, Volume2, Globe, Wifi, Disc, Cable, Monitor, AppWindow, Keyboard, Mouse, Headphones, Camera, Mic, MousePointer, Armchair, Table, Beaker, ExternalLink, Shield, FileVideo, BatteryCharging, Gamepad2, Briefcase, Palette, Video, GraduationCap, Download, Share2, RefreshCw, Link as LinkIcon, CircleAlert, CircleCheck, ChevronRight, ShoppingCart } from 'lucide-react';
import { Helmet } from "react-helmet-async";;
import PageMeta from "./PageMeta.jsx";
import { PARTS as RAW_SEED_PARTS } from "./data/parts.js";

// DISPLAY-TIME NAME CLEANER (GPU only for now)
// Strips marketing fluff, parentheticals, trademark symbols.
// Does NOT mutate catalog. Use as {cleanProductName(p)} in JSX.
const _CLEAN_SUBSERIES = [
  'ROG Astral','ROG Strix','TUF Gaming','TUF','Prime','Dual','ProArt','Phoenix','Turbo',
  'Gaming Trio','Gaming X Trio','Gaming X Slim','SUPRIM Liquid X','SUPRIM X','SUPRIM',
  'Ventus 3X','Ventus 2X','Shadow 3X','Shadow 2X','Inspire 3X','Expert',
  'AORUS Master','AORUS Elite','AORUS Xtreme','AORUS','Eagle MAX','Eagle OC','Eagle',
  'Windforce','Gaming OC','Gaming X',
  'FTW3 Ultra','FTW3','XC3 Ultra','XC3','XC',
  'AMP Extreme AIRO','AMP Extreme','AMP Holo','AMP','Twin Edge OC','Twin Edge','Trinity OC','Trinity','Solid OC','Solid',
  'NITRO+','PULSE','Toxic',
  'Red Devil','Hellhound','Fighter','Reaper',
  'SWFT','Speedster',
  'Verto','XLR8',
  'TITAN OC','TITAN',
];
const _CLEAN_AIB_BRANDS = ['ASUS','MSI','GIGABYTE','Gigabyte','EVGA','PNY','PowerColor','Sapphire','Sparkle','XFX','ZOTAC','Yeston','ASRock','Inno3D','Galax'];

// ─── PRICE HISTORY ───────────────────────────────────────────────
// Slug must match split-price-history.js exactly: normalized name → slug.
function productSlug(p){
  const norm = String((p && p.n) || "")
    .toLowerCase().replace(/\s+/g," ").replace(/[^a-z0-9 ]/g,"").trim();
  return norm.replace(/\s+/g,"-").replace(/[^a-z0-9-]/g,"")
    .replace(/-+/g,"-").replace(/^-|-$/g,"").slice(0,80).replace(/-$/,"");
}

// Per-retailer 90-day price history chart. Fetches /price-history/<slug>.json
// on mount. Renders a compact inline SVG line for one retailer.
function PriceHistoryChart({ product, retailer }){
  const [state, setState] = useState({ status: "loading", points: null });
  useEffect(() => {
    let cancelled = false;
    const slug = productSlug(product);
    if (!slug) { setState({ status: "none", points: null }); return; }
    fetch("/price-history/" + slug + ".json")
      .then(r => r.ok ? r.json() : Promise.reject(new Error("no data")))
      .then(data => {
        if (cancelled) return;
        const pts = data && data[retailer];
        if (Array.isArray(pts) && pts.length) setState({ status: "ok", points: pts });
        else setState({ status: "none", points: null });
      })
      .catch(() => { if (!cancelled) setState({ status: "none", points: null }); });
    return () => { cancelled = true; };
  }, [product && product.id, retailer]);

  if (state.status === "loading") {
    return <div style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--mute)",padding:"10px 14px"}}>Loading price history\u2026</div>;
  }
  if (state.status === "none" || !state.points || state.points.length < 2) {
    return <div style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--mute)",padding:"10px 14px"}}>Not enough price history yet.</div>;
  }

  const pts = state.points;
  const prices = pts.map(x => x.p);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const cur = prices[prices.length - 1];
  const W = 320, H = 80, PAD = 6;
  const span = (hi - lo) || 1;
  const x = i => PAD + (i / (pts.length - 1)) * (W - 2 * PAD);
  const y = v => PAD + (1 - (v - lo) / span) * (H - 2 * PAD);
  const d = pts.map((pt, i) => (i === 0 ? "M" : "L") + x(i).toFixed(1) + "," + y(pt.p).toFixed(1)).join(" ");
  const first = pts[0].d, last = pts[pts.length - 1].d;

  return (
    <div style={{padding:"10px 14px 14px"}}>
      <div style={{display:"flex",justifyContent:"space-between",fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",marginBottom:6}}>
        <span>{"Low $" + lo}</span><span>{"Now $" + cur}</span><span>{"High $" + hi}</span>
      </div>
      <svg viewBox={"0 0 " + W + " " + H} style={{width:"100%",height:"auto",display:"block"}}>
        <path d={d} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(pts.length-1)} cy={y(cur)} r="3" fill="var(--accent)" />
      </svg>
      <div style={{display:"flex",justifyContent:"space-between",fontFamily:"var(--mono)",fontSize:9,color:"var(--mute)",marginTop:4}}>
        <span>{first}</span><span>{pts.length} days tracked</span><span>{last}</span>
      </div>
    </div>
  );
}

// ─── PRODUCT REVIEWS ─────────────────────────────────────────────
// Fetches /reviews/<slug>.json (per-product file from split-reviews.js)
// and renders up to 5 customer reviews. Renders nothing if none exist.
function ReviewStarRow({ rating }){
  const full = Math.round(rating || 0);
  return <span style={{color:"var(--accent)",fontSize:13,letterSpacing:1}}>
    {"\u2605".repeat(full)}<span style={{color:"var(--bdr2)"}}>{"\u2605".repeat(5-full)}</span>
  </span>;
}

// reviewSlug — finds a product's review file. Mirrors fetch-bestbuy-reviews.js
// reviewKey() + split-reviews.js slug(): ASIN-first, else name-based.
function reviewSlug(p){
  if(!p) return "";
  // model token — MUST match fetch-bestbuy-reviews.js modelToken()
  const N = String(p.n||"").toUpperCase();
  const pats = [
    /\bRTX\s?\d{4}\s?(?:TI|SUPER)?\b/,
    /\bGTX\s?\d{3,4}\s?(?:TI|SUPER)?\b/,
    /\bRX\s?\d{3,4}\s?(?:XT|GRE)?\b/,
    /\bRYZEN\s?\d\s?\d{3,4}[A-Z0-9]*\b/,
    /\bCORE\s?(?:ULTRA\s?\d\s?)?I?\d?-?\d{3,5}[A-Z]*\b/,
    /\bI[3579]-\d{4,5}[A-Z]*\b/,
    /\b\d{4,5}X3D\b/,
  ];
  let tok=null;
  for(const re of pats){ const m=N.match(re); if(m){ tok=m[0].replace(/\s+/g,""); break; } }
  const safe = s => String(s).toLowerCase().replace(/\s+/g,"-").replace(/[^a-z0-9-]/g,"")
    .replace(/-+/g,"-").replace(/^-|-$/g,"").slice(0,80).replace(/-$/,"");
  if(tok){
    const brand=String(p.b||"").toUpperCase().trim();
    return "tok-"+safe(brand+"|"+(p.c||"")+"|"+tok);
  }
  let asin = p.asin ? String(p.asin).toUpperCase() : null;
  if(!asin){
    const u = p.deals && p.deals.amazon && p.deals.amazon.url;
    const m = u && String(u).match(/\/dp\/([A-Z0-9]{10})/);
    if(m) asin = m[1].toUpperCase();
  }
  if(asin) return "asin-"+asin.toLowerCase().replace(/[^a-z0-9]/g,"");
  const n = String(p.n||"").toLowerCase().replace(/\s+/g," ").replace(/[^a-z0-9 ]/g,"").trim();
  return n ? safe(n) : "";
}

function ProductReviews({ product }){
  const [state, setState] = useState({ status: "loading", reviews: null });
  useEffect(() => {
    let cancelled = false;
    const slug = reviewSlug(product);
    if (!slug) { setState({ status: "none", reviews: null }); return; }
    fetch("/reviews/" + slug + ".json")
      .then(r => r.ok ? r.json() : Promise.reject(new Error("no reviews")))
      .then(data => {
        if (cancelled) return;
        const rv = data && data.reviews;
        if (Array.isArray(rv) && rv.length) setState({ status: "ok", reviews: rv });
        else setState({ status: "none", reviews: null });
      })
      .catch(() => { if (!cancelled) setState({ status: "none", reviews: null }); });
    return () => { cancelled = true; };
  }, [product && product.id]);

  // Render nothing while loading or when there are no reviews — keeps the
  // spec area clean for the ~95% of products without Best Buy reviews.
  if (state.status !== "ok" || !state.reviews) return null;

  const reviews = state.reviews;
  const avg = reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length;

  return (
    <div style={{marginTop:18}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
        <span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",fontWeight:700,letterSpacing:1,textTransform:"uppercase"}}>Customer Reviews</span>
        <ReviewStarRow rating={avg} />
        <span style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--dim)"}}>{avg.toFixed(1)} \u00b7 {reviews.length} review{reviews.length>1?"s":""}</span>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {reviews.map((r, i) => (
          <div key={i} style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:8,padding:"10px 14px"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
              <ReviewStarRow rating={r.rating} />
              <span style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:700,color:"var(--txt)"}}>{r.title}</span>
            </div>
            <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--mute)",lineHeight:1.5,whiteSpace:"pre-wrap"}}>{r.comment}</div>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",marginTop:6}}>
              {(r.author || "Anonymous")}{r.date ? " \u00b7 " + String(r.date).slice(0,10) : ""}{r.source ? " \u00b7 via " + r.source : ""}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function cleanProductName(p){
  if(!p || !p.n) return '';
  // ── CPU name cleaner ──────────────────────────────────────────
  if(p.c === 'CPU'){
    const cn = p.n.replace(/[\u2122\u00AE\u00A9]/g,' ');
    let c;
    // Intel Core Ultra (Arrow Lake)
    if(/\bCore\s*Ultra\b/i.test(cn) || /\bUltra\s*[3579]\b/i.test(cn)){
      const tier = cn.match(/\bUltra\s*([3579])\b/i);
      const mdl  = cn.match(/\b(\d{3})\s*(KF|KS|K|F)?\b(?!\d)/);
      if(tier && mdl) return 'Intel Core Ultra '+tier[1]+' '+mdl[1]+(mdl[2]?mdl[2].toUpperCase():'');
    }
    // Intel Core i3/i5/i7/i9
    if((c = cn.match(/\b(?:Core\s*)?i([3579])[- ]?(\d{4,5})([A-Z]{0,3})\b/i)))
      return 'Intel Core i'+c[1]+'-'+c[2]+(c[3]?c[3].toUpperCase():'');
    // AMD Ryzen Threadripper (before plain Ryzen)
    if(/\bThreadripper\b/i.test(cn)){
      const pro = /Threadripper[\s\u2122]*PRO/i.test(cn) ? ' PRO' : '';
      const tr = cn.match(/\b(\d{4,5})\s*(WX|X)?\b/);
      if(tr) return 'AMD Ryzen Threadripper'+pro+' '+tr[1]+(tr[2]?tr[2].toUpperCase():'');
    }
    // AMD Ryzen
    if((c = cn.match(/\bRyzen\s*([3579])\s*(\d{4})\s*(X3D|XT|GT|GE|G|X|F|E)?\b/i)))
      return 'AMD Ryzen '+c[1]+' '+c[2]+(c[3]?c[3].toUpperCase():'');
    // Intel Xeon W-series
    if((c = cn.match(/\bXeon\s*(W\d?-\d{3,4}[A-Z]{0,2})\b/i)))
      return 'Intel Xeon '+c[1].toUpperCase();
    // Intel Xeon E5/E3/E7 (Xeon word optional)
    if((c = cn.match(/\b(E[357])-(\d{4})\s*[vV](\d)\b/)))
      return 'Intel Xeon '+c[1].toUpperCase()+'-'+c[2]+' v'+c[3];
    if((c = cn.match(/\bXeon\b[^]*?\b(E[357])-(\d{4})\b/)))
      return 'Intel Xeon '+c[1].toUpperCase()+'-'+c[2];
    // Intel Xeon Scalable
    if((c = cn.match(/\bXeon\s*(Platinum|Gold|Silver|Bronze)\s*(\d{4}[A-Z]?)\b/i)))
      return 'Intel Xeon '+c[1][0].toUpperCase()+c[1].slice(1).toLowerCase()+' '+c[2].toUpperCase();
    // Intel Xeon X-series legacy
    if((c = cn.match(/\bXeon\s*(X\d{3,4})\b/i)))
      return 'Intel Xeon '+c[1].toUpperCase();
    // Intel Pentium
    if(/\bPentium\b/i.test(cn)){
      const gold = /Pentium\s*Gold/i.test(cn) ? ' Gold' : '';
      const gm = cn.match(/\bG-?(\d{3,4}[A-Z]?)\b/i);
      if(gm) return 'Intel Pentium'+gold+' G'+gm[1].toUpperCase();
      const em = cn.match(/\bE(\d{4})\b/);
      if(em) return 'Intel Pentium E'+em[1];
    }
    // Intel Celeron
    if(/\bCeleron\b/i.test(cn)){
      const gm = cn.match(/\bG-?(\d{3,4}[A-Z]?)\b/i);
      if(gm) return 'Intel Celeron G'+gm[1].toUpperCase();
    }
    // AMD Athlon
    if((c = cn.match(/\bAthlon\s*(II\s*)?(X\d\s*)?(\d{3,4}[A-Z]{0,2})\b/i)))
      return 'AMD Athlon '+(c[1]?'II ':'')+(c[2]?c[2].toUpperCase().replace(/\s+/g,'')+' ':'')+c[3].toUpperCase();
    // Couldn't parse — keep original
    return p.n;
  }
  if(p.c !== 'GPU') return p.n;
  const name = p.n.replace(/[™®©]/g,'');
  const brand = (p.b || '').replace(/[™®©]/g,'');
  let model = null, m;
  if((m = name.match(/\b(RTX|GTX)\s*(\d{3,4})\s*(Ti\s*Super|Super|Ti|XT|XTX|GRE)?\b/i))){
    const variant = m[3] ? ' ' + m[3].replace(/\s+/g,' ').replace(/ti/i,'Ti').replace(/super/i,'Super') : '';
    model = m[1].toUpperCase() + ' ' + m[2] + variant;
  } else if((m = name.match(/\bRX\s*(\d{3,4})\s*(XT|XTX|GRE)?\b/i))){
    const variant = m[2] ? ' ' + m[2].toUpperCase() : '';
    model = 'RX ' + m[1] + variant;
  } else if((m = name.match(/\bArc\s*([AB])(\d{3,4})\b/i))){
    model = 'Arc ' + m[1].toUpperCase() + m[2];
  } else if((m = name.match(/\bRTX\s*A(\d{3,4})\b/i))){
    model = 'RTX A' + m[1];
  } else if((m = name.match(/\bGT\s*(\d{3,4})\b/i))){
    model = 'GT ' + m[1];
  } else if((m = name.match(/\bR([579])\s*(\d{3,4})\b/i))){
    model = 'R' + m[1] + ' ' + m[2];
  }
  if(!model) return p.n;
  let chipMaker = null;
  if(/^RTX|^GTX|^GT /i.test(model)) chipMaker = 'NVIDIA';
  else if(/^RX|^R[579] /i.test(model)) chipMaker = 'AMD';
  else if(/^Arc/i.test(model)) chipMaker = 'Intel';
  const aibBrand = _CLEAN_AIB_BRANDS.includes(brand) ? brand : null;
  let subSeries = null;
  for(const sub of _CLEAN_SUBSERIES){
    const re = new RegExp('\\b' + sub.replace(/[.*+?^${}()|[\]\\]/g,'\\import { PARTS as RAW_SEED_PARTS } from "./data/parts.js";') + '\\b','i');
    if(re.test(name)){ subSeries = sub; break; }
  }
  const hasOC = /\bOC\b/i.test(name);
  const hasBTF = /\bBTF\b/i.test(name);
  const isWhite = /\bWhite\b/i.test(name);
  const isBlack = /\bBlack\b/i.test(name);
  const parts = [];
  if(aibBrand) parts.push(aibBrand);
  if(subSeries) parts.push(subSeries);
  if(chipMaker) parts.push(chipMaker);
  if(chipMaker === 'NVIDIA') parts.push('GeForce');
  else if(chipMaker === 'AMD') parts.push('Radeon');
  parts.push(model);
  if(hasOC && !(subSeries && /OC/.test(subSeries))) parts.push('OC');
  if(hasBTF) parts.push('BTF');
  if(isWhite) parts.push('White');
  else if(isBlack) parts.push('Black');
  if(p.vram != null) parts.push(p.vram + 'GB');
  return parts.join(' ').replace(/\s+/g,' ').trim() || p.n;
}

// Hide quarantined products from browse/builder/search
const SEED_PARTS = RAW_SEED_PARTS.filter(p => !p.needsReview);
const ACTIVE_SEED_PARTS = SEED_PARTS;
import { GAMES, GPU_SCORES, CPU_SCORES, RES_SCALE, QUALITY_SCALE, estimateFPS, estimateAllGames, matchGPU, matchCPU } from "./data/fps-engine.js";
import ReviewStars from "./components/ReviewStars";
import { CategoryBrowse } from './CategoryBrowse.jsx';
import UpgradePage from "./UpgradePage.jsx";

/* ═══ API CLIENT ═══ */
const API_BASE = "http://localhost:3001/api";

async function apiFetch(path, body) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn("API call failed, falling back to local:", e.message);
    return null; // Caller handles fallback
  }
}

/* ═══ DATA ═══ */
const CAT={
  // Core
  Case:{icon:"📦",label:"Cases",singular:"Case",desc:"Towers & SFF cases",cols:["ff","tower","tg","maxGPU","fans_inc"],filters:{ff:{label:"Type",type:"check"},mobo:{label:"Mobo Support",type:"check",extract:p=>Array.isArray(p.mobo)?p.mobo:(p.mobo?String(p.mobo).split(",").map(s=>s.trim()).filter(Boolean):[])},maxGPU:{label:"Max GPU Length",type:"range",unit:"mm"},maxCooler:{label:"Max Cooler Height",type:"range",unit:"mm"},rads:{label:"AIO/Radiator Support",type:"check",extract:p=>{const arr=Array.isArray(p.rads)?p.rads:[];if(!arr.length)return"None";const max=Math.max(...arr);return"Up to "+max+"mm"}},fans_inc:{label:"Included Fans",type:"check"},tg:{label:"Clear Side Panel",type:"bool"},usb_c:{label:"Front USB-C",type:"bool"}}},
  CPU:{icon:"🔴",label:"Processors",singular:"CPU",desc:"Desktop CPUs",cols:["cores","socket","tdp","bench"],filters:{socket:{label:"Socket",type:"check"},cores:{label:"Core Count",type:"check"},tdp:{label:"TDP",type:"range",unit:"W"},arch:{label:"Architecture",type:"check"},memType:{label:"Memory Type",type:"check"},igpu:{label:"Integrated Graphics",type:"bool"},vcache:{label:"3D V-Cache",type:"bool"},serverCPU:{label:"Server CPU",type:"bool"}}},
  CPUCooler:{icon:"❄️",label:"CPU Coolers",singular:"CPU Cooler",desc:"Air & AIO liquid coolers",cols:["coolerType","tdp_rating","cfm","noise"],filters:{coolerType:{label:"Type",type:"check"},tdp_rating:{label:"TDP Rating",type:"range",unit:"W"},cfm:{label:"Airflow (CFM)",type:"range"},noise:{label:"Noise Level",type:"range",unit:"dBA"},radSize:{label:"Radiator Size",type:"check"},fans:{label:"Fan Count",type:"check"}}},
  Motherboard:{icon:"🟡",label:"Motherboards",singular:"Motherboard",desc:"ATX, mATX & ITX boards",cols:["socket","ff","chipset","wifi"],filters:{socket:{label:"Socket",type:"check"},chipset:{label:"Chipset",type:"check"},ff:{label:"Form Factor",type:"check"},memType:{label:"Memory Type",type:"check"},memSlots:{label:"Memory Slots",type:"check"},m2Slots:{label:"M.2 Slots",type:"check"},wifi:{label:"WiFi",type:"check"},usb_c:{label:"USB-C",type:"bool"}}},
  RAM:{icon:"⚡",label:"Memory",singular:"RAM Kit",desc:"DDR5 & DDR4 kits",cols:["memType","cap","sticks","speed","cl"],filters:{memType:{label:"Type",type:"check"},formFactor:{label:"Form Factor",type:"check"},cap:{label:"Total Capacity",type:"check"},sticks:{label:"Kit (Sticks)",type:"check"},speed:{label:"Speed (MHz)",type:"check"},cl:{label:"CAS Latency",type:"check"},ecc:{label:"ECC",type:"bool"},rgb:{label:"RGB",type:"bool"}}},
  GPU:{icon:"💚",label:"Video Cards",singular:"Graphics Card",desc:"Gaming & workstation GPUs",cols:["tdp","length","bench"],filters:{vram:{label:"VRAM (GB)",type:"check"},memType:{label:"Memory Type",type:"check"},tdp:{label:"TDP",type:"range",unit:"W"},length:{label:"Card Length",type:"range",unit:"mm"},slots:{label:"Slot Width",type:"check"},pwr:{label:"Power Connector",type:"check"},segment:{label:"Use Case",type:"check"},arch:{label:"Architecture",type:"check"},pcie:{label:"PCIe Version",type:"check"}}},
  Storage:{icon:"💾",label:"Storage",singular:"Drive",desc:"NVMe SSDs, SATA SSDs & HDDs",cols:["storageType","cap","seq_r"],multi:true,maxQty:6,filters:{storageType:{label:"Type",type:"check"},interface:{label:"Interface",type:"check"},pcie:{label:"PCIe Gen",type:"check"},cap:{label:"Capacity",type:"check"},ff:{label:"Form Factor",type:"check"},dram:{label:"DRAM Cache",type:"bool"}}},
  PSU:{icon:"🔌",label:"Power Supplies",singular:"PSU",desc:"Modular & semi-modular",cols:["watts","eff","modular","color"],filters:{watts:{label:"Wattage",type:"check"},eff:{label:"Rating",type:"check"},modular:{label:"Modularity",type:"check"},ff:{label:"Form Factor",type:"check"},color:{label:"Color",type:"check"},rgb:{label:"RGB",type:"bool"},atx3:{label:"ATX 3.0",type:"bool"}}},
  // Cooling
  CaseFan:{icon:"🌀",label:"Case Fans",singular:"Case Fan",desc:"120mm & 140mm case fans",cols:["size","cfm","noise","color","rgb","rgbType","rgbConnector"],multi:true,maxQty:10,filters:{size:{label:"Size (mm)",type:"check"},color:{label:"Color",type:"check"},rgb:{label:"RGB",type:"bool"},rgbType:{label:"RGB Type",type:"check"},rgbConnector:{label:"RGB Connector",type:"check"},pack:{label:"Pack Size",type:"check"},connector:{label:"Fan Connector",type:"check"}}},
  // Expansion
  SoundCard:{icon:"🔊",label:"Sound Cards",singular:"Sound Card",desc:"PCIe sound cards",cols:["channels","snr","sampleRate","bitDepth","hasAmp"],filters:{channels:{label:"Channels",type:"check"},snr:{label:"SNR (dB)",type:"range",unit:"dB"},sampleRate:{label:"Sample Rate",type:"check"},bitDepth:{label:"Bit Depth",type:"check"},hasAmp:{label:"Headphone Amp",type:"bool"},impedance:{label:"Max Impedance",type:"range",unit:"Ω"},formFactor:{label:"Form Factor",type:"check"},digitalOut:{label:"Digital Output",type:"bool"}}},
  EthernetCard:{icon:"🌐",label:"Ethernet Adapters",singular:"Ethernet Card",desc:"2.5G/5G/10GbE PCIe network cards",cols:["lanSpeed","ports","chipset","pcieLane","profile"],filters:{lanSpeed:{label:"Speed",type:"check"},ports:{label:"Port Count",type:"check"},chipset:{label:"Chipset",type:"check"},pcieLane:{label:"PCIe Lane",type:"check"},profile:{label:"Profile",type:"check"},wol:{label:"Wake-on-LAN",type:"bool"},vlan:{label:"VLAN Support",type:"bool"},pxe:{label:"PXE Boot",type:"bool"}}},
  WiFiCard:{icon:"📶",label:"WiFi Adapters",singular:"WiFi Card",desc:"WiFi 6E/7 PCIe cards",cols:["wifiStandard","maxSpeed","bt","antennas","pcieLane"],filters:{wifiStandard:{label:"WiFi Standard",type:"check"},bt:{label:"Bluetooth",type:"check"},antennas:{label:"Antennas",type:"check"},pcieLane:{label:"PCIe Lane",type:"check"},band:{label:"Band",type:"check"},heatsink:{label:"Heatsink",type:"bool"}}},
  OpticalDrive:{icon:"💿",label:"Optical Drives",singular:"Optical Drive",desc:"Blu-ray & DVD drives",cols:["driveType","readSpeed","writeSpeed"],filters:{driveType:{label:"Type",type:"check"},interface:{label:"Interface",type:"check"}}},
  ExtensionCables:{icon:"🔗",label:"Extension Cables",singular:"Cable Kit",desc:"Sleeved PSU extensions",cols:["cableType","cableLength"],filters:{cableType:{label:"Type",type:"check"}},multi:true,maxQty:4},
  
  InternalDisplay:{icon:"🖥️",label:"Internal Displays",singular:"Display",desc:"LCD/IPS screens for inside your PC case",cols:["size","resolution","connection"],filters:{size:{label:"Screen Size",type:"check"},connection:{label:"Connection",type:"check"},panelType:{label:"Panel",type:"check"},ecosystem:{label:"Ecosystem",type:"check"},touch:{label:"Touchscreen",type:"bool"}}},
OS:{icon:"🪟",label:"Operating Systems",singular:"OS",desc:"Windows & Linux",cols:[]},
  // Peripherals
  Monitor:{icon:"🖥️",label:"Monitors",singular:"Monitor",desc:"Gaming & productivity",cols:["screenSize","res","refresh","panel"],multi:true,maxQty:4,filters:{screenSize:{label:"Screen Size",type:"check"},res:{label:"Resolution",type:"check"},refresh:{label:"Refresh Rate",type:"check"},panel:{label:"Panel Type",type:"check"},sync:{label:"Adaptive Sync",type:"check"},hdr:{label:"HDR",type:"check"},response:{label:"Response Time",type:"range",unit:"ms"}}},
  Keyboard:{icon:"⌨️",label:"Keyboards",singular:"Keyboard",desc:"Mechanical & membrane",cols:["switches","layout","wireless"],filters:{switches:{label:"Switch Type",type:"check"},layout:{label:"Layout",type:"check"},wireless:{label:"Wireless",type:"bool"},rgb:{label:"RGB",type:"bool"}}},
  Mouse:{icon:"🖱️",label:"Mice",singular:"Mouse",desc:"Gaming & productivity mice",cols:["sensor","dpi","weight"],filters:{mouseType:{label:"Connectivity",type:"check"},weight:{label:"Weight",type:"range",unit:"g"},dpi:{label:"Max DPI",type:"range"}}},
  Headset:{icon:"🎧",label:"Headsets",singular:"Headset",desc:"Gaming & audiophile",cols:["hsType","driver","mic"],filters:{hsType:{label:"Connectivity",type:"check"},mic:{label:"Microphone",type:"bool"},anc:{label:"ANC",type:"bool"}}},
  Webcam:{icon:"📷",label:"Webcams",singular:"Webcam",desc:"4K & 1080p cameras",cols:["resolution","fps","autofocus"],filters:{resolution:{label:"Resolution",type:"check"},autofocus:{label:"Autofocus",type:"bool"}}},
  Microphone:{icon:"🎙️",label:"Microphones",singular:"Microphone",desc:"USB & XLR mics",cols:["micType","pattern","sampleRate"],filters:{micType:{label:"Connection",type:"check"},pattern:{label:"Polar Pattern",type:"check"}}},
  MousePad:{icon:"🖼️",label:"Mouse Pads",singular:"Mouse Pad",desc:"Cloth & hard surface",cols:["surface","padSize"],filters:{surface:{label:"Surface",type:"check"},padSize:{label:"Size",type:"check"}}},
  Chair:{icon:"💺",label:"Chairs",singular:"Chair",desc:"Gaming & ergonomic chairs",cols:[]},
  Desk:{icon:"🗄️",label:"Desks",singular:"Desk",desc:"Standing & fixed desks",cols:[]},
  // Accessories
  ThermalPaste:{icon:"🧴",label:"Thermal Paste",singular:"Thermal Paste",desc:"CPU thermal compounds",cols:[]},
  ExternalStorage:{icon:"💽",label:"External Storage",singular:"External Drive",desc:"Portable SSDs & HDDs",cols:[],multi:true,maxQty:3},
  Antivirus:{icon:"🛡️",label:"Antivirus",singular:"Antivirus",desc:"Security software",cols:[]},
  ExternalOptical:{icon:"📀",label:"External Optical",singular:"External Optical Drive",desc:"USB DVD/Blu-ray drives",cols:[]},
  UPS:{icon:"🔋",label:"UPS Systems",singular:"UPS",desc:"Battery backup systems",cols:[]},
};
const CATS=Object.keys(CAT);
// Lucide icon component map for categories (replaces emoji icons)
const CAT_ICONS = {
  Case: Box, CPU: Cpu, CPUCooler: Snowflake, Motherboard: CircuitBoard, RAM: MemoryStick,
  GPU: Square, Storage: HardDrive, PSU: Plug,
  CaseFan: Fan, SoundCard: Volume2, EthernetCard: Globe, WiFiCard: Wifi, OpticalDrive: Disc,
  ExtensionCables: Cable, InternalDisplay: Monitor, OS: AppWindow,
  Monitor: Monitor, Keyboard: Keyboard, Mouse: Mouse, Headset: Headphones, Webcam: Camera,
  Microphone: Mic, MousePad: MousePointer, Chair: Armchair, Desk: Table,
  ThermalPaste: Beaker, ExternalStorage: ExternalLink, Antivirus: Shield, ExternalOptical: FileVideo, UPS: BatteryCharging,
};
// Render an icon for any category. Falls back to Box if unmapped.
const CatIcon = ({c, size=16, color="currentColor", style={}}) => {
  const Cmp = CAT_ICONS[c] || Box;
  return <Cmp size={size} color={color} style={{flexShrink:0, ...style}} strokeWidth={1.75}/>;
};
// Section group icons (for collapsible groupings in builder)
const SECTION_ICONS = {
  core: Cpu,
  cooling: Fan,
  expansion: CircuitBoard,
  cables: Cable,
  peripherals: Monitor,
  accessories: Shield,
};
const SectionIcon = ({name, size=17, color="currentColor", style={}}) => {
  const Cmp = SECTION_ICONS[name] || Box;
  return <Cmp size={size} color={color} style={{flexShrink:0, ...style}} strokeWidth={1.75}/>;
};


// Builder table sections
const CORE_CATS=["GPU","Case","CPU","Motherboard","Storage","RAM","CPUCooler","PSU"];
const COOLING_CATS=["CaseFan"];
const EXPANSION_CATS=["SoundCard","EthernetCard","WiFiCard","OpticalDrive"];
const CABLE_CATS=["ExtensionCables","OS"];
const PERIPH_CATS=["Monitor","Keyboard","Mouse","Headset","Webcam","Microphone","MousePad","Chair","Desk"];
const ACCESSORY_CATS=["ThermalPaste","ExternalStorage","Antivirus","ExternalOptical","UPS"];
const BUILD_CATS=[...CORE_CATS,...COOLING_CATS,...EXPANSION_CATS,...CABLE_CATS];
const ALL_BUILDER_CATS=[...BUILD_CATS,...PERIPH_CATS,...ACCESSORY_CATS];
const BUILDER_SECTIONS=[
  {id:"core",label:"Core Components",icon:"core",cats:CORE_CATS},
  {id:"cooling",label:"Cooling & Fans",icon:"cooling",cats:COOLING_CATS},
  {id:"expansion",label:"Expansion & Drives",icon:"expansion",cats:EXPANSION_CATS},
  {id:"cables",label:"Cables & OS",icon:"cables",cats:CABLE_CATS},
  {id:"peripherals",label:"Peripherals",icon:"peripherals",cats:PERIPH_CATS},
  {id:"accessories",label:"Accessories",icon:"accessories",cats:ACCESSORY_CATS},
];
const SL={cores:"Cores/Threads",socket:"Socket",tdp:"TDP",bench:"Score",vram:"VRAM",cap:"Capacity",speed:"Speed",ff:"Form Factor",wifi:"WiFi",storageType:"Type",watts:"Watts",eff:"Rating",modular:"Modular",panel:"Panel",res:"Resolution",refresh:"Refresh",screenSize:"Screen",switches:"Switches",layout:"Layout",wireless:"Wireless",baseClock:"Base Clock",boostClock:"Boost Clock",threads:"Threads",length:"Length",pwr:"Power",seq_r:"Read",seq_w:"Write",cl:"CAS Latency",ramType:"Type",chipset:"Chipset",coolerType:"Type",noise:"Noise",tdp_rating:"TDP Rating",fans_inc:"Fans Included",maxGPU:"Max GPU Length",maxCooler:"Max Cooler",cfm:"Airflow",size:"Size",sensor:"Sensor",dpi:"DPI",weight:"Weight",driver:"Driver",mic:"Mic",hsType:"Type",mouseType:"Type",segment:"Use Case",arch:"Architecture",pcie:"PCIe",tg:"Side Panel",usb_c:"USB-C",mobo:"Mobo Support",drive25:"2.5in Bays",drive35:"3.5in Bays",memType:"Memory",memSlots:"RAM Slots",maxMem:"Max RAM",m2Slots:"M.2 Slots",lan:"Ethernet",ecc:"ECC",rgb:"RGB",rgbType:"RGB Type",rgbConnector:"RGB Connector",color:"Color",igpu:"iGPU",igpuName:"iGPU Name",vcache:"V-Cache",serverCPU:"Server",pCores:"P-Cores",eCores:"E-Cores",l3:"L3 Cache",nm:"Process",bus:"Bus Width",slots:"Slot Width",interface:"Interface",dram:"DRAM Cache",tlc:"NAND Type",pack:"Pack",atx3:"ATX 3.0",radSize:"Radiator",rads:"AIO Support",height:"Height",fans:"Fans",fanSize:"Fan Size",response:"Response",sync:"Adaptive Sync",hdr:"HDR",curved:"Curved",hotswap:"Hot-Swap",pollingRate:"Polling Rate",shape:"Grip",anc:"ANC",surroundSound:"Surround",openBack:"Open Back",autofocus:"Autofocus",fov:"FOV",pattern:"Pattern",sampleRate:"Sample Rate",bitDepth:"Bit Depth",connection:"Connection",connector:"Fan Connector",channels:"Channels",snr:"SNR",hasAmp:"Headphone Amp",lanSpeed:"Speed",ports:"Ports",wifiStandard:"WiFi",bt:"Bluetooth",driveType:"Drive Type",readSpeed:"Read Speed",writeSpeed:"Write Speed",memSpeed:"Memory Speed*",audio:"Audio",sticks:"Sticks",voltage:"Voltage",cuda:"CUDA Cores",boost:"Boost Clock",tier:"Suggested Use",sp:"Stream Processors",xeCores:"Xe Cores",maxMemSpeed:"Max RAM Speed",sata:"SATA Ports",pciSlots:"PCIe Slots",impedance:"Max Impedance",formFactor:"Form Factor",digitalOut:"Digital Output",pcieLane:"PCIe Lane",profile:"Profile",wol:"Wake-on-LAN",vlan:"VLAN",pxe:"PXE Boot",maxSpeed:"Max Speed",antennas:"Antennas",band:"Band",heatsink:"Heatsink",dacChip:"DAC Chip",outputPower:"Output Power",upc:"UPC",mpn:"Model #",model:"Model",generation:"Generation",vramType:"VRAM Type",dimensions:"Dimensions",form:"Form",tower:"Tower",series:"Series",compatibility:"Compatibility",contrast:"Contrast",rpm:"RPM"};
const SF={cores:(v,p)=>p&&p.threads?v+"C/"+p.threads+"T":v+"C",sticks:(v,p)=>{if(!v)return v;const total=p&&(p.cap||p.capacity);if(total&&v>0){const per=Math.round(total/v);return v+"x"+per+"GB";}return v+"x";},tdp:v=>v+"W",vram:v=>typeof v==="number"?v+"GB":v,cap:v=>typeof v==="number"?(v>=1000?(Math.round(v/100)/10).toString().replace(/\.0$/,"")+"TB":v+"GB"):v,speed:v=>v+"MHz",watts:v=>v+"W",wifi:v=>v||"None",refresh:v=>v+"Hz",screenSize:v=>v+'"',bench:v=>v+"%",baseClock:v=>v+"GHz",boostClock:v=>v+"GHz",length:v=>v+"mm",seq_r:v=>v>=1000?(v/1000).toFixed(1)+"GB/s":v+"MB/s",seq_w:v=>v>=1000?(v/1000).toFixed(1)+"GB/s":v+"MB/s",noise:v=>{const n=typeof v==="number"?v:parseFloat(v);if(isNaN(n))return v;const ref=n<=15?"Near silent":n<=20?"Whisper quiet":n<=25?"Library quiet":n<=30?"Quiet room":n<=35?"Light hum":n<=40?"Noticeable":"Loud";return n+"dBA\n"+ref;},tdp_rating:(v,p)=>p&&p.tdp_rating_est?"~"+v+"W":v+"W",maxGPU:v=>v+"mm",maxCooler:v=>v+"mm",cfm:v=>typeof v==="number"?v.toFixed(1)+" CFM":v,dpi:v=>v>=1000?(v/1000)+"K":v,weight:v=>{if(v==null)return"—";if(typeof v==="number")return v+"g";const s=String(v);let m=s.match(/([\d.]+)\s*(kilogram|kg)/i);if(m)return(parseFloat(m[1])*2.20462).toFixed(1)+" lbs";m=s.match(/([\d.]+)\s*(gram|g)\b/i);if(m)return(parseFloat(m[1])/453.592).toFixed(2)+" lbs";m=s.match(/([\d.]+)\s*(pound|lb|lbs)/i);if(m)return parseFloat(m[1]).toFixed(1)+" lbs";m=s.match(/([\d.]+)\s*(ounce|oz)/i);if(m)return(parseFloat(m[1])/16).toFixed(2)+" lbs";return s;},cl:v=>"CL"+v,driver:v=>v+"mm",height:v=>v+"mm",voltage:v=>v+"V",boost:v=>v+"MHz",tier:v=>typeof v==="string"?v.charAt(0).toUpperCase()+v.slice(1):v,snr:v=>v+"dB",sampleRate:v=>v===0?"Analog":v+"kHz",lanSpeed:v=>v,tg:v=>v?"Yes":"No",usb_c:v=>v?"Yes":"No",ecc:v=>v?"Yes":"No",rgb:v=>v?"Yes":"No",igpu:v=>v?"Yes":"No",vcache:v=>v?"Yes":"No",serverCPU:v=>v?"Yes":"No",atx3:v=>v?"Yes":"No",dram:v=>v?"Yes":"No",wireless:v=>v?"Yes":"No",curved:v=>v?"Yes":"No",hotswap:v=>v?"Yes":"No",anc:v=>v?"Yes":"No",mic:v=>typeof v==="boolean"?(v?"Yes":"No"):v,hasAmp:v=>v?"Yes":"No",autofocus:v=>v?"Yes":"No",wol:v=>v?"Yes":"No",vlan:v=>v?"Yes":"No",pxe:v=>v?"Yes":"No",digitalOut:v=>v?"Yes":"No",heatsink:v=>v?"Yes":"No",pwm:v=>v?"Yes":"No",impedance:v=>v+"Ω",pcie:v=>String(v).startsWith("Gen")?v:"Gen"+v,fanSize:v=>typeof v==="number"?v+"mm":v,fans_inc:v=>v+(v===1?" fan":" fans"),socket:v=>typeof v==="string"?v.toUpperCase():v,chipset:v=>typeof v==="string"?v.toUpperCase():v,memType:v=>typeof v==="string"?v.toUpperCase():v,panel:v=>typeof v==="string"?v.toUpperCase():v,upc:v=>{if(!v)return"—";const list=String(v).split(",").map(x=>x.trim()).filter(Boolean);return list.length>1?list[0]+" (+"+(list.length-1)+")":list[0];},rads:v=>{if(!v)return"None";const sizes=String(v).split(",").map(s=>s.trim());const max=Math.max(...sizes.map(s=>parseInt(s)||0));return max>=360?"Up to 360mm":max>=280?"Up to 280mm":max>=240?"Up to 240mm":max>=120?"120mm only":"None";}};
const fmt=(k,v,p)=>v==null?"—":(SF[k]?SF[k](v,p):String(v));

// ── Map old category names and make all parts available ──
// Filter: Option A strict — hide products where all known retailers report inStock:false.
// Products with no `deals` object (legacy entries not yet processed by verify-asins.js)
// remain visible so the catalog doesn't shrink during the migration period.
// fp() below falls back to SEED_PARTS, so filtered products in existing community builds still render.
const isAvailable = p => {
  if (!p.deals || typeof p.deals !== "object") return true;
  const retailerKeys = Object.keys(p.deals).filter(k => p.deals[k] && typeof p.deals[k] === "object" && p.deals[k].price);
  if (!retailerKeys.length) return true;
  return retailerKeys.some(k => p.deals[k].inStock !== false);
};
const P = SEED_PARTS
  .map(p => p.c === "Cooler" ? {...p, c: "CPUCooler"} : p)
  .filter(isAvailable);

// ── Price helpers — handles new multi-retailer deals structure ──
const bestPrice = p => {
  if (!p.deals || typeof p.deals !== "object") return p.pr;
  const allRetailers = Object.keys(p.deals).filter(k => typeof p.deals[k] === "object" && p.deals[k].price);
  if (!allRetailers.length) return p.pr;
  // Prefer in-stock retailers; fall back to any retailer only if none are in stock
  const inStock = allRetailers.filter(k => p.deals[k].inStock !== false);
  const keys = inStock.length ? inStock : allRetailers;
  return Math.min(...keys.map(k => p.deals[k].price));
};
const $ = p => bestPrice(p);
const VALUE_DIVISORS={
  Mouse:15,Keyboard:15,Headset:15,Microphone:15,Webcam:15,MousePad:15,ExtensionCables:15,CaseFan:15,
  CPUCooler:18,
  Case:25,
  Motherboard:40
};
const valueRatio=p=>{
  const b=p.bench||0;
  const pr=$(p);
  if(!pr||!b)return 0;
  const div=VALUE_DIVISORS[p.c]||100;
  const divisor=Math.max(pr/div,1);
  return b/divisor;
};

const msrp = p => p.msrp || p.pr;
// === DEAL DETECTION ===
// A product is "on deal" when bestPrice is meaningfully below MSRP.
// Threshold: at least $5 OR 3% off (whichever is bigger), to ignore micro-rounding.
const isDeal = p => {
  const cur = bestPrice(p);
  const ref = msrp(p);
  if (!ref || !cur || cur >= ref) return false;
  const savings = ref - cur;
  const pct = savings / ref;
  return savings >= 5 || pct >= 0.03;
};
// Savings amount (whole dollars), only meaningful if isDeal(p) is true
const dealSavings = p => {
  const cur = bestPrice(p);
  const ref = msrp(p);
  if (!ref || !cur || cur >= ref) return 0;
  return Math.round(ref - cur);
};
// === END DEAL DETECTION ===

// === CLEAN DISPLAY NAME ===
// Returns "Brand Make Model [Variant]" for cleaner dropdown display
function cleanDisplayName(p) {
  if (!p || !p.n) return '';
  const name = p.n;
  const brand = p.b || '';
  const c = p.c;

  if (c === 'CPU') {
    let m = name.match(/(Intel)\s+Core\s+(Ultra\s+\d|i[3579])[\s-]*(\d{3,5}[A-Z]{0,3})/i);
    if (m) return `Intel Core ${m[2].replace(/\s+/g,' ')}-${m[3].toUpperCase()}`;
    m = name.match(/(AMD\s+)?Ryzen\s+(Threadripper(?:\s+PRO)?|\d)\s+(\d{4}[A-Z0-9]{0,4})/i);
    if (m) return `AMD Ryzen ${m[2]} ${m[3].toUpperCase()}`;
    return (brand + ' ' + name.replace(new RegExp('^' + brand + '\\s+', 'i'), '')).substring(0, 60).trim();
  }

  if (c === 'GPU') {
    let m = name.match(/(RTX|GTX)\s*(\d{3,4})\s*(Ti\s*Super|Super|Ti)?/i);
    if (m) {
      const series = m[1].toUpperCase();
      const num = m[2];
      const suffix = m[3] ? ' ' + m[3].replace(/super/i,'SUPER').replace(/^ti$/i,'Ti').replace(/^Ti\s+SUPER$/i,'Ti SUPER') : '';
      const afterModel = name.split(new RegExp(`${series}\\s*${num}\\s*${m[3]||''}\\s*`, 'i'))[1] || '';
      const aibMatch = afterModel.match(/^([A-Z][A-Za-z0-9\s+]{0,30}?)(?=\s+(?:DLSS|GDDR|\d+GB|\d+-?bit|\d+\s*Gbps|PCIE?|Gaming\s+Graphics|Graphics\s+Card|with|,|\(|\d+MHz)|$)/i);
      const aib = aibMatch ? ' ' + aibMatch[1].trim() : '';
      return `${brand} GeForce ${series} ${num}${suffix}${aib}`.trim();
    }
    m = name.match(/(RX)\s*(\d{3,4})\s*(XT|XTX|GRE)?/i);
    if (m) {
      const suffix = m[3] ? ' ' + m[3].toUpperCase() : '';
      const afterModel = name.split(new RegExp(`RX\\s*${m[2]}\\s*${m[3]||''}\\s*`, 'i'))[1] || '';
      const aibMatch = afterModel.match(/^([A-Z][A-Za-z0-9\s+]{0,30}?)(?=\s+(?:GDDR|\d+GB|\d+-?bit|\d+\s*Gbps|PCIE?|Gaming\s+Graphics|Graphics\s+Card|with|,|\(|\d+MHz)|$)/i);
      const aib = aibMatch ? ' ' + aibMatch[1].trim() : '';
      return `${brand} Radeon RX ${m[2]}${suffix}${aib}`.trim();
    }
    m = name.match(/Arc\s+(A\d{3,4}|B\d{3,4})/i);
    if (m) return `${brand} Arc ${m[1].toUpperCase()}`.trim();
    return (brand + ' ' + name.replace(new RegExp('^' + brand + '\\s+', 'i'), '')).substring(0, 60).trim();
  }

  const cleaned = name.replace(/\s*[,\(].*$/, '').replace(/\s+(DLSS|GDDR\d+X?|PCIE?\s*[\d\.]+|\d+\s*-?\s*bit|\d+\s*Gbps?).*$/i, '').trim();
  if (cleaned.length > 60) return cleaned.substring(0, 57) + '...';
  return cleaned;
}
// === END CLEAN DISPLAY NAME ===
const fmtPrice = n => { if (n == null) return '0'; const r = Math.round(n * 100) / 100; return r % 1 === 0 ? String(r) : r.toFixed(2); };
// Retailer key → user-facing display name
const RETAILER_DISPLAY_NAMES = {
  amazon: "Amazon",
  bestbuy: "Best Buy",
  newegg: "Newegg",
  newegg_openbox: "Newegg (Open Box)",
  newegg_refurb: "Newegg (Refurbished)",
  newegg_used: "Newegg (Used)",
};
const retailerDisplayName = key => RETAILER_DISPLAY_NAMES[key] || (key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " "));
// Marketplace grouping: maps individual retailer keys to UI groups
// All newegg_* variants share the "newegg" group so they appear as one filter
const RETAILER_GROUP_MAP = {
  amazon: "amazon",
  bestbuy: "bestbuy",
  newegg: "newegg",
  newegg_openbox: "newegg",
  newegg_refurb: "newegg",
  newegg_used: "newegg",
};
const marketplaceGroupOf = key => RETAILER_GROUP_MAP[key] || key;
// Return all raw retailer keys that belong to a given group
const expandMarketplaceGroup = group => Object.keys(RETAILER_GROUP_MAP).filter(k => RETAILER_GROUP_MAP[k] === group);
// Condition mapping: deal field name → product condition
// New = unsuffixed retailer keys (amazon, bestbuy, newegg)
// Suffixed variants map to their condition
const CONDITIONS = [
  { id: "new", label: "New" },
  { id: "openbox", label: "Open Box" },
  { id: "refurb", label: "Refurbished" },
  { id: "used", label: "Used" },
];
// Returns array of conditions a product offers (e.g. ["new","openbox"])
function productConditions(p) {
  if (!p.deals || typeof p.deals !== "object") return [];
  const conds = new Set();
  // Check product name first — if name says Renewed/Refurb/Used, that overrides default "new"
  const name = String(p.n || "");
  const nameIsUsed = /\b(used|pre[\-\s]?owned)\b/i.test(name);
  const nameIsRefurb = /\b(renewed|refurb(?:ished)?)\b/i.test(name);
  const nameIsOpenBox = /\bopen[\s\-]?box\b/i.test(name);
  for (const [key, info] of Object.entries(p.deals)) {
    if (!info || typeof info !== "object" || !(info.price || info.saleprice)) continue;
    // Explicit suffix mapping
    if (/_openbox$/i.test(key)) { conds.add("openbox"); continue; }
    if (/_refurb$/i.test(key)) { conds.add("refurb"); continue; }
    if (/_used$/i.test(key)) { conds.add("used"); continue; }
    // Unsuffixed key — fall back to product name to detect condition
    if (nameIsUsed) conds.add("used");
    else if (nameIsRefurb) conds.add("refurb");
    else if (nameIsOpenBox) conds.add("openbox");
    else conds.add("new");
  }
  return [...conds];
}

const retailers = p => {
  if (!p.deals || typeof p.deals !== "object") return [];
  return Object.entries(p.deals)
    .filter(([k,v]) => typeof v === "object" && v && (v.price || v.saleprice))
    .map(([name, info]) => {
      const url = info.url || info.linkurl;
      const rawPrice = info.saleprice && Number(info.saleprice) > 0 ? Number(info.saleprice) : Number(info.price);
      return { name, displayName: retailerDisplayName(name), price: rawPrice, url, inStock: info.inStock !== false };
    })
    .filter(r => r.url && r.price > 0)
    .sort((a,b) => a.price - b.price);
};

// ── Global list of retailers tracked anywhere in the dataset — for N/A display on missing retailers ──
const ALL_RETAILERS = [...new Set(SEED_PARTS.flatMap(p =>
  p.deals && typeof p.deals === "object"
    ? Object.keys(p.deals).filter(k => p.deals[k] && typeof p.deals[k] === "object" && (p.deals[k].price || p.deals[k].saleprice))
    : []
))].sort();

// ── Addon products (from seed peripherals + extra items for builder) ──
// Old addon system removed — all categories now live in SEED_PARTS with proper category tags

// ── Community builds (using new seed IDs) ──
const BUILDS=[
  {id:1,nm:"The Red Dragon",by:"PCMaster99",v:342,ids:[1001,2010,3002,4001,5001,6001,7003,8001],tags:["4K Gaming"],d:"Ryzen 9 + RTX 4090 ultimate AMD build"},
  {id:2,nm:"Budget Beast",by:"ValueHunter",v:891,ids:[1005,2024,3003,4005,5006,6008,7004,8004],tags:["Budget"],d:"Best gaming under $1000"},
  {id:3,nm:"Intel Fortress",by:"BlueTeam",v:567,ids:[1020,2011,3001,4030,5002,6002,7002,8010],tags:["1440p"],d:"i9 + 4080 SUPER high-refresh"},
  {id:4,nm:"Silent Station",by:"QuietPC",v:234,ids:[1004,2013,3005,4004,5003,6003,7001,8003],tags:["Silent"],d:"7800X3D + quiet air-cooled"},
];

const fp=id=>P.find(p=>p.id===id)||SEED_PARTS.find(p=>p.id===id);
const ic=p=>CAT[p.c]?.icon||"📦";
const uv=(cat,f,extract)=>{const items=P.filter(p=>p.c===cat&&p[f]!=null);let vals;if(extract){vals=[];for(const p of items){const v=extract(p);if(Array.isArray(v))vals.push(...v.filter(x=>x!=null&&x!==""));else if(v!=null&&v!=="")vals.push(v);}}else{vals=items.map(p=>String(p[f]));}return [...new Set(vals)].sort((a,b)=>String(a).localeCompare(String(b),undefined,{numeric:true}));};

/* ═══ RETAILER PRICE COMPARISON COMPONENT ═══ */
function PriceCompare({part}) {
  const rr = retailers(part);
  if (rr.length <= 1) return null;
  return (
    <div style={{marginTop:6,paddingTop:6,borderTop:"1px solid var(--bdr)"}}>
      <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",letterSpacing:1,marginBottom:4}}>COMPARE PRICES</div>
      {rr.map((r,i) => (
        <a key={r.name} href={r.url} target="_blank" rel="noopener noreferrer"
          style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"4px 6px",borderRadius:4,
            background:i===0?"var(--mint3)":"transparent",textDecoration:"none",marginBottom:2,
            border:i===0?"1px solid var(--mint)22":"1px solid transparent"}}>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <span style={{fontFamily:"var(--ff)",fontSize:10,fontWeight:600,color:"var(--txt)"}}>{r.displayName}</span>
            {i===0 && <Tag color="var(--mint)">BEST</Tag>}
            {!r.inStock && <Tag color="var(--rose)">OOS</Tag>}
          </div>
          <span style={{fontFamily:"var(--mono)",fontSize:13,fontWeight:700,color:i===0?"var(--mint)":"var(--txt)"}}>${fmtPrice(r.price)}</span>
        </a>
      ))}
    </div>
  );
}

/* ═══ STYLES ═══ */
const css=`
[data-theme="dark"]{--bg:#0f0e0b;--bg2:#13110d;--bg3:#17140f;--bg4:#1c1914;--bdr:#2a2620;--bdr2:#4a4338;--accent:#FF8A3D;--accent2:#FF8A3D40;--accent3:#FF8A3D14;--mint:#FF8A3D;--mint2:#FF8A3D40;--mint3:#FF8A3D14;--txt:#f0ece0;--dim:#8a8170;--mute:#7a7160;--amber:#FF8A3D;--rose:#e35d3d;--sky:#7a8aa6;--violet:#a399b8;--ff:'Inter',system-ui,sans-serif;--ff-display:'Fraunces',Georgia,serif;--mono:'Inter',system-ui,sans-serif;--navbg:#13110d;--heroGrad:none;--card:#13110d;--shadow:none;--shadowSm:none}
[data-theme="light"]{--bg:#faf7ef;--bg2:#f4efe2;--bg3:#ede8db;--bg4:#e3decc;--bdr:#d8d0bd;--bdr2:#b5ad99;--accent:#cc5a17;--accent2:#cc5a1740;--accent3:#cc5a1710;--mint:#cc5a17;--mint2:#cc5a1740;--mint3:#cc5a1710;--txt:#1a1814;--dim:#6a614f;--mute:#8a8170;--amber:#cc5a17;--rose:#c43d23;--sky:#5a6a86;--violet:#7c6b96;--ff:'Inter',system-ui,sans-serif;--ff-display:'Fraunces',Georgia,serif;--mono:'Inter',system-ui,sans-serif;--navbg:#f4efe2;--heroGrad:none;--card:#f4efe2;--shadow:none;--shadowSm:none}
*{box-sizing:border-box;margin:0} @media (max-width: 1000px) { .builder-grid { grid-template-columns: 1fr !important } } @media (max-width: 900px) { .picker-grid { grid-template-columns: 1fr !important } .picker-sidebar { display: none !important } }::selection{background:var(--accent3);color:var(--accent)} [data-theme="dark"] .logo-light-img{display:none!important;visibility:hidden} [data-theme="dark"] .logo-dark-img{display:block!important;visibility:visible} [data-theme="light"] .logo-dark-img{display:none!important;visibility:hidden} [data-theme="light"] .logo-light-img{display:block!important;visibility:visible}
.mega-in{animation:mIn .2s cubic-bezier(.16,1,.3,1)}@keyframes mIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
.fade{animation:fIn .35s cubic-bezier(.16,1,.3,1)}@keyframes fIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.card{background:var(--card,var(--bg2));border-radius:16px;border:1px solid var(--bdr);box-shadow:var(--shadowSm);transition:all .25s cubic-bezier(.16,1,.3,1)}.card:hover{box-shadow:var(--shadow);transform:translateY(-2px)}
input[type=range]{-webkit-appearance:none;background:transparent;cursor:pointer}input[type=range]::-webkit-slider-runnable-track{height:6px;border-radius:3px;background:#c8bfb2}input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--accent);margin-top:-5px;border:2px solid var(--bg2);box-shadow:0 1px 3px rgba(0,0,0,.15)}input[type=range]::-moz-range-track{height:6px;border-radius:3px;background:#c8bfb2;border:none}input[type=range]::-moz-range-thumb{width:18px;height:18px;border-radius:50%;background:var(--accent);border:2px solid var(--bg);box-shadow:0 2px 8px rgba(255,107,53,.4)}select{-webkit-appearance:none}
@media(max-width:768px){.hero-grid{grid-template-columns:1fr!important}.cat-grid{grid-template-columns:repeat(3,1fr)!important}.deals-grid{grid-template-columns:1fr!important}.how-grid{grid-template-columns:1fr!important}.search-layout{grid-template-columns:1fr!important}.footer-grid{grid-template-columns:1fr 1fr!important;gap:20px!important}.hero-stats{grid-template-columns:1fr 1fr!important}}
@media(max-width:480px){.cat-grid{grid-template-columns:repeat(2,1fr)!important}.footer-grid{grid-template-columns:1fr!important}}

/* === MOBILE RESPONSIVE === */
html, body { overflow-x: clip; max-width: 100vw; }
*, *::before, *::after { max-width: 100%; }

/* Images never force page wider */
img { max-width: 100%; height: auto; }

/* Tables with minWidth inline should only horizontally scroll within their own container */
table { max-width: 100%; }

/* === TABLET (<=900px) === */
@media (max-width: 900px) {
  /* Reduce max container padding */
  [data-mobile-pad] { padding: 48px 20px !important; }

  /* Hero 3-column grid -> 1 column */
  .hero-grid { grid-template-columns: 1fr !important; gap: 20px !important; text-align: center; }

  /* how-grid (features 1fr 1fr 1fr / 1fr 1fr) -> 1 column */
  .how-grid { grid-template-columns: 1fr !important; gap: 16px !important; }
  /* scanner page step/feature grids -> 1 column on mobile */
  .scanner-steps, .scanner-feats { grid-template-columns: 1fr !important; }
  .scanner-steps > div, .scanner-feats > div { border-right: none !important; border-bottom: 1px solid var(--bdr); }
  .scanner-steps > div:last-child, .scanner-feats > div:last-child { border-bottom: none; }
}

/* === MOBILE (<=640px) === */
@media (max-width: 640px) {
  /* Force any wide container (maxWidth 1000-1200) to have proper mobile padding */
  body { font-size: 14px; }

  /* Headlines shrink */
  h1 { font-size: clamp(28px, 8vw, 40px) !important; letter-spacing: -0.5px !important; line-height: 1.12 !important; }
  h2 { font-size: clamp(22px, 6vw, 30px) !important; }
  h3 { font-size: clamp(18px, 5vw, 22px) !important; }

  /* Footer 5-col grid -> 2-col */
  footer > div > div:first-child {
    grid-template-columns: 1fr 1fr !important;
    gap: 24px !important;
  }

  /* All multi-col grids collapse */
  [style*="grid-template-columns"][style*="1fr 1fr 1fr"] {
    grid-template-columns: 1fr !important;
    gap: 16px !important;
  }
  [style*="grid-template-columns"][style*="1fr 1fr"]:not(footer *) {
    grid-template-columns: 1fr !important;
  }

  /* Reduce excessive padding */
  [style*="padding: 72px 32px"], [style*="padding: 80px 32px"], [style*="padding: 64px 32px"], [style*="padding: 56px 32px"] {
    padding: 40px 18px !important;
  }
  [style*="padding: 48px 32px"] {
    padding: 32px 18px !important;
  }
  [style*="padding: 32px"] {
    padding: 18px !important;
  }

  /* Tables inside overflow-x containers scroll themselves; ensure container doesn't stretch */
  [style*="overflow-x"] { max-width: 100%; }

  /* Keep nav compact */
  nav button, nav a { padding: 6px 10px !important; font-size: 12px !important; }

  /* Nav container: allow wrapping to 2 rows if needed */
  nav > div { flex-wrap: wrap !important; gap: 6px !important; height: auto !important; padding: 10px 14px !important; }

  /* Touch targets: pad footer buttons */
  footer button { padding: 8px 0 !important; min-height: 32px; }

  /* Hero padding on narrow screens */
  [style*="padding:72px 32px"] { padding: 40px 18px !important; }

  /* Pills/cards in grids become stack-friendly */
  [style*="gridTemplateColumns"] { gap: 12px !important; }

  /* Large wizard/tool grids */
  [style*="gridTemplateColumns:2fr"], [style*="gridTemplateColumns:4fr"] {
    grid-template-columns: 1fr !important;
  }
}


/* === MOBILE FIX 2: specific grid patterns === */
@media (max-width: 900px) {
  /* 2-col layout with fixed sidebar (home page: 1fr 340px) */
  [style*="1fr 340px"] {
    grid-template-columns: 1fr !important;
  }
  /* category grid: repeat(3,1fr) stays 3-col on tablet */
}
@media (max-width: 640px) {
  /* Category grid: repeat(3,1fr) -> 2-col on mobile */
  [style*="repeat(3,1fr)"], [style*="repeat(3, 1fr)"] {
    grid-template-columns: repeat(2, 1fr) !important;
  }
  /* Sticky sidebar: unstick on mobile so it flows with content */
  [style*="position:sticky"][style*="top:80"] {
    position: static !important;
  }
}
@media (max-width: 400px) {
  /* Category grid: single column on very narrow */
  [style*="repeat(3,1fr)"], [style*="repeat(3, 1fr)"] {
    grid-template-columns: 1fr !important;
  }
}

/* === MOBILE FIX 3: home main grid === */
.home-main-grid {
  display: grid;
  grid-template-columns: 1fr 340px;
  padding: 56px 32px 48px;
}
@media (max-width: 900px) {
  .home-main-grid {
    display: block !important;
    padding: 24px 18px !important;
    max-width: 100vw !important;
    box-sizing: border-box !important;
  }
  .home-main-grid > div {
    width: 100% !important;
    max-width: 100% !important;
    margin-bottom: 24px !important;
    box-sizing: border-box !important;
    min-width: 0 !important;
  }
  .home-main-grid > div:last-child {
    position: static !important;
    top: auto !important;
  }
  .home-cat-grid {
    display: grid !important;
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    gap: 8px !important;
    width: 100% !important;
    max-width: 100% !important;
  }
  .home-cat-grid > button,
  .home-main-grid button {
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    box-sizing: border-box !important;
    overflow: hidden !important;
  }
  .home-main-grid img {
    max-width: 100% !important;
    height: auto !important;
  }
}
html, body, #root {
  overflow-x: clip !important;
  max-width: 100vw !important;
  box-sizing: border-box !important;
}

/* === MOBILE FIX 2 === */

/* === EXTRA SMALL (<=400px) === */
@media (max-width: 400px) {
  /* Footer 2-col -> 1-col */
  footer > div > div:first-child {
    grid-template-columns: 1fr !important;
  }

  /* Even smaller padding */
  [style*="padding: 40px 18px"] { padding: 28px 14px !important; }
}

/* === MOBILE FIX 8: direct sidebar hide === */
@media (max-width: 900px) {
  .builder-picker-sidebar {
    display: none !important;
  }
}

/* === MOBILE FIX 6: builder part picker mobile layout === */
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

/* === MOBILE FIX: wizard === */
.wizard-container {
  max-width: 600px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}
.wizard-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg3);
  margin-bottom: 4px;
  border: 1px solid var(--bdr);
  gap: 8px;
}
.wizard-row-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.wizard-row-img {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
  overflow: hidden;
}
.wizard-row-img img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.wizard-row-text {
  min-width: 0;
  flex: 1;
}
.wizard-row-name {
  font-family: var(--ff);
  font-size: 12px;
  font-weight: 600;
  color: var(--txt);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wizard-row-cat {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--dim);
}
.wizard-row-price {
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
}
@media (max-width: 600px) {
  .wizard-container {
    padding: 0 8px;
  }
  .wizard-container > div {
    padding: 14px !important;
  }
  .wizard-row {
    padding: 6px 8px;
    gap: 6px;
  }
  .wizard-row-img {
    width: 30px;
    height: 30px;
  }
  .wizard-row-name {
    font-size: 11px;
  }
  .wizard-row-cat {
    font-size: 8px;
  }
  .wizard-row-price {
    font-size: 12px;
  }
}
/* === END MOBILE FIX: wizard === */
/* === MOBILE FIX 5: browse page mobile layout === */
.browse-layout {
  display: grid;
  grid-template-columns: 200px 1fr;
}
@media (max-width: 900px) {
  .browse-layout {
    grid-template-columns: 1fr !important;
    padding: 8px 12px !important;
    max-width: 100vw !important;
  }
  .browse-layout > div:first-of-type {
    display: none !important;
  }
  .browse-layout > div:last-of-type {
    min-width: 0;
    max-width: 100%;
    overflow-x: hidden;
  }
  /* Product table rows and header - stack as vertical cards */
  [style*="60px 80px 70px"] {
    display: flex !important;
    flex-direction: column !important;
    align-items: stretch !important;
    padding: 12px !important;
    gap: 4px !important;
  }
  [style*="60px 80px 70px"] > * {
    width: 100% !important;
    text-align: left !important;
    min-width: 0;
  }
  /* Hide the spec column headers on mobile (the 4fr 1fr 1fr... bar) */
  [style*="border-bottom: 2px solid"][style*="60px 80px 70px"] {
    display: none !important;
  }
}

/* === MOBILE FIX 4: repeat(4,...) grids collapse to 2-col on mobile === */
@media (max-width: 640px) {
  [style*="repeat(4,1fr)"],
  [style*="repeat(4, 1fr)"] {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  }
  [style*="repeat(3,1fr)"],
  [style*="repeat(3, 1fr)"] {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  }
}
@media (max-width: 420px) {
  [style*="repeat(4,1fr)"],
  [style*="repeat(4, 1fr)"],
  [style*="repeat(3,1fr)"],
  [style*="repeat(3, 1fr)"] {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  }
}
`;

/* ═══ COMPONENTS ═══ */
function Stars({r,s=11}){return <span style={{fontSize:s,color:"var(--amber)"}}>{"★".repeat(Math.round(r))}<span style={{color:"var(--dim)",fontSize:s-1,marginLeft:2}}>{r}</span></span>}
function SBar({v,mx=100}){const c=v>=90?"var(--accent)":v>=70?"var(--sky)":"var(--dim)";return <div style={{display:"flex",alignItems:"center",gap:4}}><div style={{flex:1,height:3,background:"var(--bg4)",borderRadius:2,overflow:"hidden"}}><div style={{width:`${(v/mx)*100}%`,height:"100%",background:c,borderRadius:2}}/></div><span style={{fontFamily:"var(--mono)",fontSize:9,color:c,minWidth:24}}>{v}%</span></div>}
function Tag({children,color="var(--accent)"}){return <span style={{padding:"2px 8px",borderRadius:6,fontSize:9,fontFamily:"var(--mono)",fontWeight:600,background:color+"18",color,border:`1px solid ${color}30`}}>{children}</span>}
function Btn({children,primary,sm,color="var(--mint)",onClick,style={}}){return <button onClick={onClick} style={{padding:sm?"4px 10px":"9px 20px",borderRadius:7,fontSize:sm?10:12,fontFamily:"var(--ff)",fontWeight:600,cursor:"pointer",background:primary?color:"transparent",color:primary?"var(--bg)":color,border:`1.5px solid ${primary?color:color+"55"}`,transition:"all .12s",...style}}>{children}</button>}

/* ═══ FILTER COMPONENTS ═══ */
function FG({label,children,open:defaultOpen=false}){
  const [isOpen,setIsOpen]=useState(defaultOpen);
  return <div style={{marginBottom:6}}>
    <button onClick={()=>setIsOpen(!isOpen)} style={{display:"flex",width:"100%",justifyContent:"space-between",alignItems:"center",padding:"6px 0",background:"none",border:"none",cursor:"pointer",borderBottom:"1px solid var(--bdr)"}}>
      <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",letterSpacing:1,fontWeight:600}}>{label}</span>
      <span style={{fontSize:10,color:"var(--mute)"}}>{isOpen?"−":"+"}</span>
    </button>
    {isOpen&&<div style={{padding:"6px 0"}}>{children}</div>}
  </div>;
}
function Chk({label,checked,onChange,count}){
  return <label style={{display:"flex",alignItems:"center",gap:6,padding:"5px 0",cursor:"pointer",fontSize:14,fontFamily:"var(--ff)",color:checked?"var(--accent)":"var(--txt)"}}>
    <input type="checkbox" checked={checked} onChange={onChange} style={{accentColor:"var(--accent)",margin:0}}/>
    <span style={{flex:1}}>{label}</span>
    {count!=null&&<span style={{fontFamily:"var(--mono)",fontSize:12,color:"var(--dim)",fontWeight:600}}>{count}</span>}
  </label>;
}

/* === Active Filter Chips Bar === */
function FilterChips({chips}){
  if(!chips || chips.length===0) return null;
  return <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10,padding:"6px 0",borderBottom:"1px solid var(--bdr)"}}>
    <span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--dim)",alignSelf:"center",letterSpacing:0.5,marginRight:4}}>FILTERS:</span>
    {chips.map((c,i)=><button key={i} onClick={c.onRemove} style={{display:"inline-flex",alignItems:"center",gap:6,background:"var(--accent3)",border:"1px solid var(--accent)",borderRadius:14,padding:"4px 8px 4px 10px",fontFamily:"var(--ff)",fontSize:12,color:"var(--accent)",cursor:"pointer",fontWeight:600}}>
      <span>{c.label}</span>
      <span style={{fontSize:14,lineHeight:1,opacity:0.8}}>×</span>
    </button>)}
  </div>;
}

/* ═══ SEARCHABLE SELECT DROPDOWN ═══ */
function SearchSelect({value,onChange,options,placeholder="Search..."}){
  const [open,setOpen]=useState(false);
  const [query,setQuery]=useState("");
  const ref=useRef(null);
  const inputRef=useRef(null);
  useEffect(()=>{
    const handler=e=>{if(ref.current&&!ref.current.contains(e.target))setOpen(false);};
    document.addEventListener("mousedown",handler);
    return ()=>document.removeEventListener("mousedown",handler);
  },[]);
  const filtered=query?options.filter(o=>{const q=query.toLowerCase();const blob=(o.label+" "+(o.detail||"")).toLowerCase();const blobNoSpace=blob.replace(/\s+/g,"");const tokens=q.split(/[\s\-,\/\(\)]+/).filter(Boolean);if(tokens.every(t=>blob.includes(t)||blobNoSpace.includes(t)))return true;const qNoSpace=q.replace(/[\s\-,\/\(\)]+/g,"");return qNoSpace.length>=3&&blobNoSpace.includes(qNoSpace);}):options;
  const selectedLabel=options.find(o=>o.value===value)?.label||"";
  return <div ref={ref} style={{position:"relative",marginBottom:8}}>
    <div onClick={()=>{setOpen(!open);if(!open)setTimeout(()=>inputRef.current?.focus(),50);}}
      style={{display:"flex",alignItems:"center",gap:6,width:"100%",background:"var(--bg4)",border:`1px solid ${open?"var(--accent)44":"var(--bdr)"}`,borderRadius:8,padding:"8px 12px",cursor:"pointer",transition:"border .15s"}}>
      {open
        ?<input ref={inputRef} value={query} onChange={e=>{e.stopPropagation();setQuery(e.target.value);}}
          onClick={e=>e.stopPropagation()}
          placeholder={selectedLabel||placeholder}
          style={{flex:1,background:"none",border:"none",outline:"none",fontSize:13,color:"var(--txt)",fontFamily:"var(--ff)",width:"100%"}}/>
        :<span style={{flex:1,fontSize:13,fontFamily:"var(--ff)",color:value?"var(--txt)":"var(--mute)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{selectedLabel||placeholder}</span>
      }
      <span style={{fontSize:10,color:"var(--mute)",transition:"transform .2s",transform:open?"rotate(180deg)":"none",flexShrink:0}}>▾</span>
    </div>
    {open&&<div style={{position:"absolute",top:"calc(100% + 4px)",left:0,right:0,background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,boxShadow:"0 8px 32px rgba(0,0,0,.15)",zIndex:50,maxHeight:320,overflowY:"auto",padding:4}}>
      {filtered.length===0&&<div style={{padding:"12px 16px",fontFamily:"var(--ff)",fontSize:13,color:"var(--mute)",textAlign:"center"}}>No results found</div>}
      {filtered.map(o=><button key={o.value} onClick={e=>{e.stopPropagation();onChange(o.value);setOpen(false);setQuery("");}}
        style={{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"8px 12px",borderRadius:6,background:value===o.value?"var(--accent3)":"transparent",border:"none",cursor:"pointer",textAlign:"left",fontFamily:"var(--ff)",fontSize:13,color:value===o.value?"var(--accent)":"var(--txt)",transition:"background .1s"}}
        onMouseEnter={e=>{if(value!==o.value)e.currentTarget.style.background="var(--bg3)";}}
        onMouseLeave={e=>{if(value!==o.value)e.currentTarget.style.background="transparent";}}>
        <span style={{flex:1,whiteSpace:"normal",wordBreak:"break-word",lineHeight:1.3}}>{o.label}</span>
        {o.detail&&<span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",flexShrink:0}}>{o.detail}</span>}
        {value===o.value&&<span style={{fontSize:13,color:"var(--accent)",flexShrink:0}}>✓</span>}
      </button>)}
    </div>}
  </div>;
}

/* ═══ TOWER LOGO SVG ═══ */
/* ━━━ PRO RIG BUILDER LOGO (PNG, theme-aware) ━━━ */
function TowerLogo({size=36}){
  // Use CSS to swap logo based on current theme via media query / data-theme attribute
  // Aspect ratio of the logo PNG is ~3:1, so width is 3x height
  const height = size;
  const width = size * 3;
  // Dark logo (white text) for dark theme; light logo (dark text) for light theme
  // Theme is set on document root via [data-theme]. We pick based on a CSS variable trick:
  // both images are rendered but only one is visible at a time.
  return <span style={{display:"inline-flex",alignItems:"center",height,width,flexShrink:0,position:"relative"}}>
    <img src="/logo-light.png" alt="Pro Rig Builder" className="logo-light-img" style={{height,width:"auto",maxWidth:"100%",objectFit:"contain",display:"block"}}/>
    <img src="/logo-dark.png" alt="Pro Rig Builder" className="logo-dark-img" style={{height,width:"auto",maxWidth:"100%",objectFit:"contain",display:"block",position:"absolute",top:0,left:0}}/>
  </span>;
}

function useThumbs() {
  const [thumbs, setThumbs] = useState({});
  useEffect(() => {
    // Load from persistent storage
    (async () => {
      try {
        const result = await window.storage?.get("cat-thumbs");
        if (result?.value) setThumbs(JSON.parse(result.value));
      } catch (e) { /* no storage or no data yet */ }
    })();
  }, []);
  const save = async (newThumbs) => {
    setThumbs(newThumbs);
    try { await window.storage?.set("cat-thumbs", JSON.stringify(newThumbs)); } catch(e) {}
  };
  const setThumb = (cat, dataUrl) => { const nt = { ...thumbs, [cat]: dataUrl }; save(nt); };
  const removeThumb = (cat) => { const nt = { ...thumbs }; delete nt[cat]; save(nt); };
  return { thumbs, setThumb, removeThumb };
}

// ── Default category thumbnail images (royalty-free / CDN) ──
const CAT_IMGS = {
  Case: "https://m.media-amazon.com/images/I/91UOdM9izhL._AC_SY300_SX300_QL70_FMwebp_.jpg",
  CPU: "https://m.media-amazon.com/images/I/51Kws4ObreL._AC_SL500_.jpg",
  CPUCooler: "https://m.media-amazon.com/images/I/91t48GBv8TL._SL1500_.jpg",
  Motherboard: "https://m.media-amazon.com/images/I/710hyHWebnL._AC_SL500_.jpg",
  RAM: "https://m.media-amazon.com/images/I/61q1ch0o2+L._AC_SL500_.jpg",
  GPU: "https://m.media-amazon.com/images/I/71QZLPNFeNL._AC_SL500_.jpg",
  Storage: "https://m.media-amazon.com/images/I/81+9rUcRVTL._AC_SL500_.jpg",
  PSU: "https://m.media-amazon.com/images/I/71dj+5GQwEL._AC_SL500_.jpg",
  CaseFan: "https://m.media-amazon.com/images/I/81ZUUX5VZsL._AC_SL500_.jpg",
  SoundCard: "https://m.media-amazon.com/images/I/51jWT0jiR8L._AC_SL500_.jpg",
  EthernetCard: "https://m.media-amazon.com/images/I/41aWf5saT0L._SX342_SY445_QL70_FMwebp_.jpg",
  WiFiCard: "https://m.media-amazon.com/images/I/513FfctgOBL._AC_SL500_.jpg",
  OpticalDrive: "https://m.media-amazon.com/images/I/71vl45cvsQL._AC_SY300_SX300_QL70_FMwebp_.jpg",
  ExtensionCables: "https://m.media-amazon.com/images/I/71n8Z4L2DqL._AC_SL500_.jpg",
  OS: "https://m.media-amazon.com/images/I/61R6ivLSfrL._AC_SL500_.jpg",
  Monitor: "https://m.media-amazon.com/images/I/81Y9EV3ZpzL._AC_SL500_.jpg",
  Keyboard: "https://m.media-amazon.com/images/I/61Qmeh+O2yL._AC_SL500_.jpg",
  Mouse: "https://m.media-amazon.com/images/I/51A7UNY7YeL._AC_SL500_.jpg",
  Headset: "https://m.media-amazon.com/images/I/71z2y-w+hmL._AC_SL500_.jpg",
  Webcam: "https://m.media-amazon.com/images/I/61eXN9erjAL._AC_SL500_.jpg",
  Microphone: "https://m.media-amazon.com/images/I/61KjhEX33JL._AC_SL500_.jpg",
  MousePad: "https://m.media-amazon.com/images/I/816eLoKstjL._AC_SL500_.jpg",
  Chair: "https://m.media-amazon.com/images/I/71bqxAIlESL._AC_SL500_.jpg",
  Desk: "https://m.media-amazon.com/images/I/51wc75lHBcL._AC_SL500_.jpg",
  ThermalPaste: "https://m.media-amazon.com/images/I/61N0I1UIyJL._AC_SL500_.jpg",
  ExternalStorage: "https://m.media-amazon.com/images/I/61CKrZWOcrL._AC_SL500_.jpg",
  Antivirus: "https://m.media-amazon.com/images/I/61LKM7+acPL._AC_SL500_.jpg",
  ExternalOptical: "https://m.media-amazon.com/images/I/71V6w1Faw3L._AC_SL500_.jpg",
  UPS: "https://m.media-amazon.com/images/I/61DfLRc3HjL._AC_SL500_.jpg",
};

function CatThumb({ cat, thumbs, setThumb, removeThumb, size = 48, editable = true, rounded = 8 }) {
  const [hover, setHover] = useState(false);
  const [imgErr, setImgErr] = useState(false);
  const inputRef = useRef(null);
  const meta = CAT[cat];
  const src = thumbs[cat]; // user-uploaded override
  const defaultImg = CAT_IMGS[cat]; // built-in default
  const displaySrc = src || (!imgErr && defaultImg) || null;

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) return;
    if (file.size > 2 * 1024 * 1024) { alert("Image must be under 2MB"); return; }
    const reader = new FileReader();
    reader.onload = (ev) => { setThumb(cat, ev.target.result); };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  return (
    <div
      style={{ width: size, height: size, borderRadius: rounded, overflow: "hidden", position: "relative", flexShrink: 0, background: "#fff", border: "none", display: "flex", alignItems: "center", justifyContent: "center" }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
    >
      {displaySrc ? (
        <img loading="lazy" decoding="async" src={displaySrc} alt={meta?.label} onError={() => setImgErr(true)} style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
      ) : (
        <span style={{ fontSize: size * 0.45, lineHeight: 1 }}>{meta?.icon || "📦"}</span>
      )}

      {/* Upload overlay — only this triggers file picker */}
      {editable && hover && (
        <div onClick={e => { e.stopPropagation(); inputRef.current?.click(); }} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, cursor: "pointer" }}>
          <span style={{ fontSize: 12 }}>📷</span>
          <span style={{ fontSize: 7, color: "#fff", fontFamily: "var(--mono)", letterSpacing: 0.5, opacity: 0.9 }}>{src ? "CHANGE" : "UPLOAD"}</span>
        </div>
      )}

      {/* Remove button */}
      {editable && src && hover && (
        <button
          onClick={(e) => { e.stopPropagation(); removeThumb(cat); }}
          style={{ position: "absolute", top: 2, right: 2, width: 14, height: 14, borderRadius: "50%", background: "var(--rose)", border: "none", color: "#fff", fontSize: 8, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}
        >✕</button>
      )}

      <input ref={inputRef} type="file" accept="image/*" onChange={handleFile} style={{ display: "none" }} />
    </div>
  );
}

/* ═══ MEGA MENU ═══ */
function MegaMenu({onSelect,onClose,go,onSearch,th}){
  const G=[{t:"Components",cats:["CPU","GPU","RAM","Motherboard","Storage","PSU"]},{t:"Build",cats:["Case","CPUCooler","CaseFan"]},{t:"Peripherals",cats:["Monitor","Keyboard","Mouse","Headset"]},{t:"Expansion",cats:["SoundCard","WiFiCard","EthernetCard","ExtensionCables"]}];
  return <div className="mega-in" style={{position:"absolute",top:"100%",left:0,right:0,background:"var(--bg2)",borderBottom:"1px solid var(--bdr2)",zIndex:100,padding:"20px 0"}} onMouseLeave={onClose}>
    <div style={{maxWidth:1536,margin:"0 auto",display:"flex",gap:32,padding:"0 24px"}}>
      {G.map(g=><div key={g.t} style={{flex:1}}><div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--mint)",letterSpacing:2,marginBottom:10,fontWeight:600}}>{g.t.toUpperCase()}</div>{g.cats.map(c=>{const m=CAT[c];return <button key={c} onClick={()=>{onSelect(c);onClose();}} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 8px",borderRadius:6,background:"transparent",border:"none",cursor:"pointer",textAlign:"left",color:"var(--txt)",fontFamily:"var(--ff)",width:"100%"}}><CatThumb cat={c} thumbs={th.thumbs} setThumb={th.setThumb} removeThumb={th.removeThumb} size={32} rounded={6} editable={false}/><div style={{flex:1}}><div style={{fontSize:13,fontWeight:600}}>{m.label}</div><div style={{fontSize:9,color:"var(--dim)"}}>{m.desc}</div></div><span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--mute)"}}>{P.filter(p=>p.c===c).length}</span></button>})}</div>)}
      <div style={{width:260,background:"var(--bg3)",border:"1px solid var(--bdr)",padding:16}}><div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:10}}>Trending</div>{P.filter(p=>p.bench>=95&&!p.bundle&&!p.needsReview).slice(0,4).map(p=>(<button key={p.id} onClick={()=>{onSearch&&onSearch(cleanProductName(p),p.c);onClose&&onClose();}} style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,width:"100%",padding:"8px 0",borderBottom:"1px solid var(--bdr)",background:"none",border:"none",cursor:"pointer",textAlign:"left"}}><span style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1,minWidth:0}}>{cleanProductName(p)}</span><span style={{fontSize:11,color:"var(--accent)",fontFamily:"var(--mono)",fontWeight:600,whiteSpace:"nowrap"}}>{"$"+fmtPrice($(p))}</span></button>))}</div>
    </div>
  </div>;
}

/* ═══ NAV ═══ */
function Nav({page,setPage,onBrowse,onSearch,th,theme,toggleTheme}){
  const [mega,setMega]=useState(false);
  const canGoBack = page !== "home";
  return <nav style={{position:"sticky",top:0,zIndex:200,backdropFilter:"blur(20px)",background:"var(--navbg)"}}>
    <div style={{maxWidth:1600,margin:"0 auto",display:"flex",alignItems:"center",height:160,padding:"0 32px",gap:8}}>
      {canGoBack&&<button onClick={()=>window.history.back()} style={{background:"none",border:"none",cursor:"pointer",color:"var(--dim)",fontSize:22,padding:"4px 8px 4px 0"}} title="Go back">←</button>}
      {/* Logo */}
      <button onClick={()=>setPage("home")} style={{background:"none",border:"none",cursor:"pointer",display:"flex",alignItems:"center",gap:8,marginRight:24}}>
        <TowerLogo size={140}/>
      </button>
      <button onClick={()=>setPage("scanner")} style={{display:"inline-flex",alignItems:"center",gap:6,padding:"6px 12px",borderRadius:20,background:"var(--accent3)",border:"1px solid var(--accent)",color:"var(--accent)",fontFamily:"var(--ff)",fontSize:13,fontWeight:700,cursor:"pointer",marginRight:20,transition:"all .15s"}}
        onMouseEnter={e=>{e.currentTarget.style.background="var(--accent)";e.currentTarget.style.color="#fff";}}
        onMouseLeave={e=>{e.currentTarget.style.background="var(--accent3)";e.currentTarget.style.color="var(--accent)";}}>
        <Download size={14} strokeWidth={2}/> Scanner
      </button>
      {/* Nav links */}
      <div style={{display:"flex",gap:2,flex:1,position:"relative"}}>
        {[{id:"browse",label:"Browse Parts",act:()=>setMega(!mega),arrow:true},{id:"builder",label:"PC Builder"},{id:"community",label:"Builds"},{id:"tools",label:"Smart Tools"}].map(n=>
          <button key={n.id} onClick={n.act||(()=>{setPage(n.id);setMega(false);})} style={{padding:"8px 16px",borderRadius:10,fontSize:14,fontFamily:"var(--ff)",fontWeight:page===n.id?600:400,cursor:"pointer",background:page===n.id?"var(--accent3)":"transparent",color:page===n.id?"var(--accent)":"var(--dim)",border:"none",transition:"all .2s"}}>{n.label}{n.arrow?" ▾":""}</button>
        )}
        {mega&&<MegaMenu onSelect={c=>{onBrowse(c);setPage("search");}} onClose={()=>setMega(false)} go={p=>setPage(p)} onSearch={onSearch} th={th}/>}
      </div>
      {/* Theme toggle — pill shape */}
      <button onClick={toggleTheme} style={{background:"var(--bg4)",border:"none",borderRadius:20,padding:"6px 14px",cursor:"pointer",display:"flex",alignItems:"center",gap:6,fontSize:14,color:"var(--dim)",fontFamily:"var(--ff)",fontWeight:500,transition:"all .2s"}} title={theme==="dark"?"Switch to light mode":"Switch to dark mode"}>
        {theme==="dark"?"☀️":"🌙"}<span style={{fontSize:10,fontWeight:600}}>{theme==="dark"?"Light":"Dark"}</span>
      </button>
    </div>
  </nav>;
}

/* ═══ HOME ═══ */
function ScannerPage({go}) {
  return (
    <div className="fade">
      <SEO title="Pro Rig Scanner — Free PC Hardware Scanner for Windows" description="Download our free Windows app to scan your PC hardware and get personalized, budget-aware upgrade recommendations. 100% private, no account needed." />

      {/* === MASTHEAD STRIP === */}
      <div style={{borderBottom:"1px solid var(--bdr)",padding:"10px 32px",fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",letterSpacing:"0.04em",textTransform:"uppercase",display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
        <span>The Pro Rig Scanner</span>
        <span>Windows 10 / 11 &middot; Free &middot; No account</span>
      </div>

      {/* === HERO === */}
      <div style={{maxWidth:1600,margin:"0 auto",padding:"64px 32px 32px"}}>
        <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",letterSpacing:"0.04em",textTransform:"uppercase",marginBottom:18}}>Free Windows app</div>
        <h1 style={{fontFamily:"var(--ff-display)",fontWeight:600,fontSize:"clamp(40px, 6vw, 72px)",lineHeight:1.02,letterSpacing:"-0.02em",color:"var(--txt)",margin:"0 0 20px"}}>
          Know your PC.<br/>
          <em style={{fontStyle:"italic",color:"var(--accent)",fontWeight:500}}>Scan it in seconds.</em>
        </h1>
        <p style={{fontFamily:"var(--ff)",fontSize:18,lineHeight:1.5,color:"var(--dim)",maxWidth:640,margin:"0 0 32px"}}>
          Run a quick scan and get personalized, budget-aware upgrade recommendations tailored to your exact hardware. Free, no signup.
        </p>
        <div style={{display:"flex",gap:12,flexWrap:"wrap",alignItems:"center"}}>
          <a href="https://github.com/tiereduptech/pro-rig-builder/releases/latest/download/ProRigScanner.exe" download style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:600,padding:"13px 24px",background:"var(--accent)",color:"#fff",border:"1px solid var(--accent)",cursor:"pointer",textDecoration:"none",display:"inline-block"}}>Download for Windows</a>
          <button onClick={()=>go("search")} style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:500,padding:"13px 24px",background:"none",color:"var(--txt)",border:"1px solid var(--bdr)",cursor:"pointer"}}>Browse Parts Manually</button>
        </div>
        <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",marginTop:16,letterSpacing:"0.04em",textTransform:"uppercase"}}>
          Windows 10 / 11 &middot; 100% private &middot; No account &middot; No tracking &middot; Free
        </div>
      </div>

      {/* === §01 — HOW IT WORKS === */}
      <div style={{maxWidth:1600,margin:"24px auto 56px",padding:"0 32px",display:"grid",gridTemplateColumns:"80px 1fr",gap:24}} className="how-grid">
        <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",letterSpacing:"0.04em",textTransform:"uppercase"}}>§01</div>
        <div>
          <h2 style={{fontFamily:"var(--ff-display)",fontWeight:600,fontSize:"clamp(26px, 3vw, 36px)",letterSpacing:"-0.02em",color:"var(--txt)",margin:"0 0 28px"}}>Three steps to a smarter upgrade</h2>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:0,border:"1px solid var(--bdr)"}} className="scanner-steps">
            {[
              {n:"01",t:"Download & Run",d:"Get the free Pro Rig Scanner for Windows. Under 2 MB, no install, no account."},
              {n:"02",t:"Scan Your Hardware",d:"The scanner detects your CPU, GPU, RAM, storage, and motherboard in about ten seconds."},
              {n:"03",t:"Get Recommendations",d:"Open your personalized upgrade page with ranked options that fit your budget."},
            ].map((s,i)=>(
              <div key={s.n} style={{padding:"28px 24px",borderRight:i<2?"1px solid var(--bdr)":"none",background:"var(--bg2)"}}>
                <div style={{fontFamily:"var(--ff-display)",fontSize:40,fontWeight:600,color:"var(--accent)",lineHeight:1,marginBottom:14}}>{s.n}</div>
                <div style={{fontFamily:"var(--ff)",fontSize:17,fontWeight:600,color:"var(--txt)",marginBottom:8}}>{s.t}</div>
                <div style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--dim)",lineHeight:1.6}}>{s.d}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* === §02 — WHY IT'S DIFFERENT === */}
      <div style={{maxWidth:1600,margin:"0 auto 56px",padding:"0 32px",display:"grid",gridTemplateColumns:"80px 1fr",gap:24}} className="how-grid">
        <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",letterSpacing:"0.04em",textTransform:"uppercase"}}>§02</div>
        <div>
          <h2 style={{fontFamily:"var(--ff-display)",fontWeight:600,fontSize:"clamp(26px, 3vw, 36px)",letterSpacing:"-0.02em",color:"var(--txt)",margin:"0 0 28px"}}>No other parts site does this</h2>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:0,border:"1px solid var(--bdr)"}} className="scanner-feats">
            {[
              {n:"01",t:"No guessing required",d:"You don't need to know your CPU or GPU model. The scanner reads it directly from your hardware."},
              {n:"02",t:"Budget-aware recommendations",d:"Tell us your budget — we recommend the biggest performance gain your money can buy."},
              {n:"03",t:"100% private by design",d:"Scans run entirely on your PC. We never see, store, or transmit your hardware data."},
              {n:"04",t:"Built exclusively here",d:"You won't find this feature on PCPartPicker, Newegg, or any other parts site."},
            ].map((f,i)=>(
              <div key={f.t} style={{padding:"26px 24px",borderRight:i%2===0?"1px solid var(--bdr)":"none",borderTop:i>1?"1px solid var(--bdr)":"none",background:"var(--bg2)"}}>
                <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",letterSpacing:"0.08em",marginBottom:10}}>{f.n}</div>
                <div style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:600,color:"var(--txt)",marginBottom:6}}>{f.t}</div>
                <div style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--dim)",lineHeight:1.6}}>{f.d}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* === §03 — WHY WE BUILT IT === */}
      <div style={{maxWidth:1600,margin:"0 auto 56px",padding:"0 32px",display:"grid",gridTemplateColumns:"80px 1fr",gap:24}} className="how-grid">
        <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",letterSpacing:"0.04em",textTransform:"uppercase"}}>§03</div>
        <div>
          <h2 style={{fontFamily:"var(--ff-display)",fontWeight:600,fontSize:"clamp(26px, 3vw, 36px)",letterSpacing:"-0.02em",color:"var(--txt)",margin:"0 0 24px"}}>Why we built the Pro Rig Scanner</h2>
          <div style={{borderTop:"1px solid var(--bdr)",borderBottom:"1px solid var(--bdr)",padding:"28px 0",maxWidth:760}}>
            <p style={{fontFamily:"var(--ff)",fontSize:16,lineHeight:1.65,color:"var(--txt)",margin:"0 0 14px"}}>
              Most people upgrading a PC hit the same wall: they don't know what they already have. Finding your exact CPU, GPU, RAM speed, and motherboard means digging through Windows menus, decoding cryptic model numbers, and hoping you read them right. One wrong spec and the upgrade you buy doesn't fit, doesn't help, or isn't even an upgrade.
            </p>
            <p style={{fontFamily:"var(--ff)",fontSize:16,lineHeight:1.65,color:"var(--txt)",margin:"0 0 14px"}}>
              Most parts sites assume you already know all of this. The Pro Rig Scanner doesn't. It reads your hardware directly, so the recommendations you get are based on what's actually in your machine &mdash; not on what you guessed.
            </p>
            <p style={{fontFamily:"var(--ff)",fontSize:16,lineHeight:1.65,color:"var(--txt)",margin:0}}>
              It runs entirely on your PC. Nothing about your hardware is uploaded, stored, or tracked. That was a deliberate choice &mdash; a tool that inspects your computer should never become a tool that surveils it.
            </p>
          </div>
        </div>
      </div>

      {/* === SMARTSCREEN REASSURANCE === */}
      <div style={{maxWidth:1600,margin:"0 auto 56px",padding:"0 32px"}}>
        <div style={{border:"1px solid var(--bdr)",borderLeft:"3px solid var(--accent)",background:"var(--bg2)",padding:"24px 26px",maxWidth:940}}>
          <div style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:600,color:"var(--txt)",marginBottom:10}}>Seeing a Windows warning?</div>
          <p style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--dim)",lineHeight:1.7,margin:"0 0 10px"}}>
            Windows SmartScreen may show a warning because Pro Rig Scanner is newly released. The app is <strong style={{color:"var(--txt)"}}>code-signed by TieredUp Tech</strong> and completely safe.
          </p>
          <p style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--dim)",lineHeight:1.7,margin:0}}>
            <strong style={{color:"var(--txt)"}}>To run it:</strong> click <span style={{fontFamily:"var(--mono)",fontSize:13,color:"var(--txt)"}}>More info</span>, then <span style={{fontFamily:"var(--mono)",fontSize:13,color:"var(--txt)"}}>Run anyway</span>.
          </p>
        </div>
      </div>

      {/* === DOWNLOAD CTA === */}
      <div style={{maxWidth:1600,margin:"0 auto 64px",padding:"0 32px"}}>
        <div style={{borderTop:"2px solid var(--txt)",paddingTop:40}}>
          <h2 style={{fontFamily:"var(--ff-display)",fontWeight:600,fontSize:"clamp(28px, 4vw, 44px)",letterSpacing:"-0.02em",color:"var(--txt)",margin:"0 0 14px"}}>
            Ready to see your <em style={{fontStyle:"italic",color:"var(--accent)",fontWeight:500}}>upgrade path?</em>
          </h2>
          <p style={{fontFamily:"var(--ff)",fontSize:16,color:"var(--dim)",lineHeight:1.6,maxWidth:560,margin:"0 0 28px"}}>
            Download the Pro Rig Scanner and get personalized recommendations in under a minute.
          </p>
          <a href="https://github.com/tiereduptech/pro-rig-builder/releases/latest/download/ProRigScanner.exe" download style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:600,padding:"14px 28px",background:"var(--accent)",color:"#fff",border:"1px solid var(--accent)",cursor:"pointer",textDecoration:"none",display:"inline-block"}}>Download Pro Rig Scanner</a>
          <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",marginTop:16,letterSpacing:"0.04em",textTransform:"uppercase"}}>
            Free &middot; Windows 10/11 &middot; 100% private &middot; No account &middot; No tracking
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══ STATIC CONTENT PAGES (About, Contact, Privacy, Terms, Affiliate) ═══

function PageShell({title, subtitle, children}) {
  return (
    <div className="fade">
      <div style={{background:"var(--heroGrad)",borderBottom:"1px solid var(--bdr)"}}>
        <div style={{maxWidth:1180,margin:"0 auto",padding:"56px 32px 40px"}}>
          <h1 style={{fontFamily:"var(--ff)",fontSize:40,fontWeight:800,color:"var(--txt)",letterSpacing:-1,lineHeight:1.1,marginBottom:subtitle?12:0}}>{title}</h1>
          {subtitle && <p style={{fontFamily:"var(--ff)",fontSize:17,color:"var(--dim)",lineHeight:1.6,maxWidth:820}}>{subtitle}</p>}
        </div>
      </div>
      <div style={{maxWidth:1180,margin:"0 auto",padding:"48px 32px 64px"}}>
        {children}
      </div>
    </div>
  );
}

function SectionHeading({children}) {
  return <h2 style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:700,color:"var(--txt)",letterSpacing:-0.3,marginTop:36,marginBottom:14}}>{children}</h2>;
}
function SubHeading({children}) {
  return <h3 style={{fontFamily:"var(--ff)",fontSize:17,fontWeight:700,color:"var(--txt)",marginTop:22,marginBottom:8}}>{children}</h3>;
}
function Para({children}) {
  return <p style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--txt)",lineHeight:1.75,marginBottom:14}}>{children}</p>;
}
function Bullet({children}) {
  return <li style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--txt)",lineHeight:1.75,marginBottom:8}}>{children}</li>;
}

// ─── ABOUT PAGE ───────────────────────────────────────────────────
function AboutPage({go}) {
  return (
    <PageShell title="About Pro Rig Builder" subtitle="Built by PC enthusiasts who got tired of jumping between ten tabs to price a build.">
      <SEO title="About" description="Pro Rig Builder is a modern PC components platform built by TieredUp Tech, Inc. with unique tools including a hardware scanner, FPS estimator, bottleneck calculator, and more." canonical="https://prorigbuilder.com/#about" breadcrumb={[{name:"Home",url:"https://prorigbuilder.com/"},{name:"About",url:"https://prorigbuilder.com/#about"}]} faq={[{"q":"Who is Pro Rig Builder?","a":"Pro Rig Builder is a PC components comparison platform operated by TieredUp Tech, Inc., a Texas S-Corporation. We launched on April 15, 2026, with the goal of making PC building faster, smarter, and more transparent."},{"q":"What makes Pro Rig Builder different from PCPartPicker?","a":"Pro Rig Builder offers a free Windows hardware scanner app, an FPS estimator, a bottleneck calculator, a Will-It-Run game checker, USED product flags, budget-aware upgrade recommendations, an automated budget build wizard, and a light/dark mode. None of these features are available on PCPartPicker."},{"q":"Is Pro Rig Builder free to use?","a":"Yes. All features, including the Pro Rig Scanner Windows app, are completely free. We earn revenue through affiliate commissions when users click our links to retailers - at no additional cost to you."},{"q":"Does Pro Rig Builder show ads?","a":"No. Pro Rig Builder displays zero ads. Our only revenue source is affiliate commissions."},{"q":"Where is Pro Rig Builder based?","a":"Pro Rig Builder is based in Orange, Texas, United States. Our parent company TieredUp Tech, Inc. is a Texas S-Corporation."}]}/>
      <SectionHeading>Our Story</SectionHeading>
      <Para>
        Pro Rig Builder launched on April 15, 2026, with a simple goal: make PC building faster, smarter, and more transparent. We noticed that existing PC builder sites forced users to manually paste part numbers, guess at compatibility, and navigate stale pricing data scattered across a dozen retailer pages. We knew we could do better.
      </Para>
      <Para>
        So we built Pro Rig Builder from the ground up — with live multi-retailer pricing, an automated compatibility engine, benchmark-aware upgrade recommendations, and a proprietary hardware scanner app you won't find anywhere else. Every feature exists because a PC builder asked "why isn't there a tool that just does this for me?"
      </Para>

      <SectionHeading>What Makes Us Different</SectionHeading>
      <Para>
        We're the only PC builder platform that combines live retailer pricing, real compatibility validation, and a standalone hardware scanner in one place. Features unique to Pro Rig Builder include:
      </Para>
      <ul style={{paddingLeft:22,marginBottom:14}}>
        <Bullet><strong>Pro Rig Scanner</strong> — our free Windows app detects your hardware and generates upgrade recommendations tailored to your budget. No one else offers this.</Bullet>
        <Bullet><strong>USED product flags</strong> — we clearly mark pre-owned listings so you know what you're buying before you click.</Bullet>
        <Bullet><strong>Budget-aware upgrade recommendations</strong> — tell us your budget and we'll find the biggest performance uplift for your dollar.</Bullet>
        <Bullet><strong>Real-time multi-retailer pricing</strong> from Amazon, Best Buy, Newegg, and B&H (with more retailers coming).</Bullet>
        <Bullet><strong>Smarter search & filtering</strong> — faster, more intuitive, with filter options no competitor matches.</Bullet>
        <Bullet><strong>Compatibility engine & warnings</strong> — catches socket mismatches, clearance issues, PSU wattage problems, and RAM type conflicts automatically.</Bullet>
        <Bullet><strong>FPS estimator</strong> — see projected frames per second for your build before you buy.</Bullet>
        <Bullet><strong>Bottleneck calculator</strong> — know whether your CPU or GPU is holding you back.</Bullet>
        <Bullet><strong>"Will It Run"</strong> — check if your existing PC can handle specific games.</Bullet>
        <Bullet><strong>Build comparison</strong> — stack two builds side-by-side to see which wins on performance per dollar.</Bullet>
        <Bullet><strong>Budget-automated build wizard</strong> — tell us your price ceiling and we'll build a balanced rig for you.</Bullet>
        <Bullet><strong>Power calculator</strong> — we know exactly how much PSU wattage your rig needs.</Bullet>
        <Bullet><strong>Part comparison tool</strong> — compare benchmarks, specs, and pricing across multiple parts instantly.</Bullet>
        <Bullet><strong>Light & dark mode</strong> — seamless theme switching so you can build in whatever lighting suits you.</Bullet>
      </ul>

      <SectionHeading>The Company Behind It</SectionHeading>
      <Para>
        Pro Rig Builder is owned and operated by <strong>TieredUp Tech, Inc.</strong>, a Texas-incorporated S-Corp based in Orange, Texas. TieredUp Tech builds developer- and consumer-focused software products with a focus on transparency, speed, and genuine utility.
      </Para>

      <SectionHeading>Our Commitment</SectionHeading>
      <Para>
        We take data accuracy seriously. Our catalog of more than 3,000 PC components is verified continuously against retailer sources. Prices update regularly. Out-of-stock retailers are deprioritized automatically so you never see misleading pricing. If you spot a data issue, <span onClick={()=>go("contact")} style={{color:"var(--accent)",cursor:"pointer",textDecoration:"underline"}}>contact us</span> — we respond quickly.
      </Para>
      <Para>
        We never manipulate rankings for advertisers. Our recommendations are based on actual benchmark performance, price, and compatibility — not who paid us most.
      </Para>

      <div style={{marginTop:40,padding:"24px 28px",background:"var(--card)",borderRadius:12,border:"1px solid var(--bdr)"}}>
        <div style={{fontFamily:"var(--ff)",fontSize:17,fontWeight:700,color:"var(--txt)",marginBottom:10}}>Ready to build?</div>
        <Para>Try the PC builder, or download our scanner to get upgrade recommendations for your current rig.</Para>
        <div style={{display:"flex",gap:12,marginTop:14,flexWrap:"wrap"}}>
          <button onClick={()=>go("builder")} style={{padding:"11px 22px",borderRadius:10,fontSize:14,fontFamily:"var(--ff)",fontWeight:700,cursor:"pointer",background:"var(--accent)",color:"#fff",border:"none"}}>Start Building →</button>
          <button onClick={()=>go("scanner")} style={{padding:"11px 22px",borderRadius:10,fontSize:14,fontFamily:"var(--ff)",fontWeight:600,cursor:"pointer",background:"var(--bg3)",color:"var(--txt)",border:"1px solid var(--bdr)"}}>Try the Scanner</button>
        </div>
      </div>
    </PageShell>
  );
}

// ─── CONTACT PAGE ─────────────────────────────────────────────────
function ContactPage() {
  return (
    <PageShell title="Contact Us" subtitle="Questions, feedback, data corrections, partnership opportunities — we'd love to hear from you.">
      <SEO title="Contact Us" description="Contact Pro Rig Builder for support, data corrections, partnerships, or press inquiries. Email support@tiereduptech.com or write to us in Orange, Texas." canonical="https://prorigbuilder.com/#contact" breadcrumb={[{name:"Home",url:"https://prorigbuilder.com/"},{name:"Contact",url:"https://prorigbuilder.com/#contact"}]}/>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:24,marginBottom:32}} className="how-grid">
        <div style={{background:"var(--card)",borderRadius:12,padding:"24px 26px",border:"1px solid var(--bdr)"}}>
          <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",fontWeight:700,letterSpacing:1.5,marginBottom:10}}>EMAIL</div>
          <div style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:700,color:"var(--txt)",marginBottom:8}}>General Support</div>
          <a href="mailto:support@tiereduptech.com" style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--accent)",textDecoration:"none",fontWeight:600}}>support@tiereduptech.com</a>
          <p style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--dim)",lineHeight:1.6,marginTop:12,marginBottom:0}}>
            Use this email for all support questions, feature requests, data corrections, partnership inquiries, and anything else.
          </p>
        </div>
        <div style={{background:"var(--card)",borderRadius:12,padding:"24px 26px",border:"1px solid var(--bdr)"}}>
          <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",fontWeight:700,letterSpacing:1.5,marginBottom:10}}>MAILING ADDRESS</div>
          <div style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:700,color:"var(--txt)",marginBottom:8}}>TieredUp Tech, Inc.</div>
          <div style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--txt)",lineHeight:1.6}}>
            1812 N 16th St<br/>
            Orange, TX 77630<br/>
            United States
          </div>
        </div>
      </div>

      <SectionHeading>Response Time</SectionHeading>
      <Para>
        We aim to respond to all inquiries within <strong>24 business hours</strong>. Complex technical questions or data corrections may take longer if they require catalog updates.
      </Para>

      <SectionHeading>What to Include</SectionHeading>
      <Para>For faster resolution, please include:</Para>
      <ul style={{paddingLeft:22,marginBottom:14}}>
        <Bullet>A clear description of what you're trying to do or what issue you encountered</Bullet>
        <Bullet>The specific part, build, or page URL if applicable</Bullet>
        <Bullet>Your browser and OS if reporting a bug</Bullet>
        <Bullet>Screenshots when helpful</Bullet>
      </ul>

      <SectionHeading>Press & Partnerships</SectionHeading>
      <Para>
        For press inquiries, affiliate partnership requests, or business development, email <a href="mailto:support@tiereduptech.com" style={{color:"var(--accent)"}}>support@tiereduptech.com</a> and mention "Partnership" in the subject line.
      </Para>
    </PageShell>
  );
}

// ─── PRIVACY POLICY ──────────────────────────────────────────────
function PrivacyPage() {
  return (
    <PageShell title="Privacy Policy" subtitle="Last updated: April 23, 2026. We respect your privacy. Here's exactly what we collect, why, and how we protect it.">
      <SEO title="Privacy Policy" description="Pro Rig Builder's privacy policy. We use Google Analytics for anonymous traffic insights. Our scanner runs 100% locally with zero data collection." canonical="https://prorigbuilder.com/#privacy" breadcrumb={[{name:"Home",url:"https://prorigbuilder.com/"},{name:"Privacy Policy",url:"https://prorigbuilder.com/#privacy"}]}/>
      <SectionHeading>Overview</SectionHeading>
      <Para>
        Pro Rig Builder is operated by <strong>TieredUp Tech, Inc.</strong> ("we," "us," "our"). This Privacy Policy explains how we collect, use, and safeguard information when you visit <a href="https://prorigbuilder.com" style={{color:"var(--accent)"}}>prorigbuilder.com</a> or use our related services and applications.
      </Para>
      <Para>
        By using our services, you agree to the practices described in this Policy. If you do not agree, please do not use our services.
      </Para>

      <SectionHeading>Information We Collect</SectionHeading>
      <SubHeading>Automatically Collected (Website)</SubHeading>
      <Para>
        When you visit our website, we use <strong>Google Analytics 4 (GA4)</strong> to understand how visitors interact with our site. This includes:
      </Para>
      <ul style={{paddingLeft:22,marginBottom:14}}>
        <Bullet>IP address (anonymized by Google)</Bullet>
        <Bullet>Browser type, operating system, device type</Bullet>
        <Bullet>Pages visited, time on site, referrer URL</Bullet>
        <Bullet>Approximate geographic location (country/region, not precise)</Bullet>
        <Bullet>Interaction events (button clicks, scrolls, search queries)</Bullet>
      </ul>
      <Para>
        GA4 uses cookies and similar technologies. You can opt out by installing the <a href="https://tools.google.com/dlpage/gaoptout" target="_blank" rel="noopener" style={{color:"var(--accent)"}}>Google Analytics Opt-out Browser Add-on</a> or by using browser settings that block tracking.
      </Para>

      <SubHeading>Pro Rig Scanner (Desktop App)</SubHeading>
      <Para>
        Our Windows scanner application detects your PC hardware locally. <strong>We do not collect, store, or transmit your hardware data.</strong> All scanning and recommendation logic runs on your machine. When you click "Get Recommendations," only the resulting upgrade preferences are sent to your browser as a URL parameter — we do not log or retain this information.
      </Para>

      <SubHeading>Voluntarily Provided</SubHeading>
      <Para>
        If you email us at support@tiereduptech.com, we will receive your email address and the contents of your message. We use this information only to respond to you and retain it for reasonable record-keeping purposes.
      </Para>

      <SectionHeading>How We Use Information</SectionHeading>
      <ul style={{paddingLeft:22,marginBottom:14}}>
        <Bullet>To operate, maintain, and improve our website and services</Bullet>
        <Bullet>To analyze traffic patterns and feature usage for product improvements</Bullet>
        <Bullet>To respond to your inquiries and provide customer support</Bullet>
        <Bullet>To comply with legal obligations and protect our legal rights</Bullet>
        <Bullet>To detect and prevent fraud or abuse</Bullet>
      </ul>

      <SectionHeading>Affiliate Tracking</SectionHeading>
      <Para>
        When you click an affiliate link on our site (to Amazon, Best Buy, Newegg, B&H, Antonline, or another partner), the destination retailer may set cookies on your device to attribute the purchase to us. These cookies are set by the retailer, not by us, and are governed by each retailer's privacy policy.
      </Para>
      <Para>
        We never see your purchase details — we only receive aggregate commission data from the retailer.
      </Para>

      <SectionHeading>Cookies</SectionHeading>
      <Para>
        We use cookies for:
      </Para>
      <ul style={{paddingLeft:22,marginBottom:14}}>
        <Bullet><strong>Analytics</strong> — Google Analytics cookies to measure traffic and usage</Bullet>
        <Bullet><strong>Preferences</strong> — to remember your theme (light/dark mode) and interface settings</Bullet>
      </ul>
      <Para>
        You can disable cookies in your browser, but some features (like remembering your theme) may not work properly.
      </Para>

      <SectionHeading>Third-Party Services</SectionHeading>
      <Para>
        We link to and integrate with third-party services, including:
      </Para>
      <ul style={{paddingLeft:22,marginBottom:14}}>
        <Bullet><strong>Google Analytics</strong> (analytics) — <a href="https://policies.google.com/privacy" target="_blank" rel="noopener" style={{color:"var(--accent)"}}>privacy policy</a></Bullet>
        <Bullet><strong>Amazon Associates</strong> (affiliate links) — governed by Amazon's privacy policy</Bullet>
        <Bullet><strong>Best Buy, Newegg, B&H, Antonline</strong> (affiliate links) — each governed by the retailer's privacy policy</Bullet>
        <Bullet><strong>Railway</strong> (hosting) and <strong>Cloudflare</strong> (CDN) — infrastructure providers</Bullet>
      </ul>
      <Para>
        We are not responsible for the privacy practices of third parties.
      </Para>

      <SectionHeading>Data Retention</SectionHeading>
      <Para>
        Analytics data is retained by Google for up to 14 months by default. Support emails are retained for up to 2 years unless legally required longer. We do not maintain user accounts or long-term user profiles.
      </Para>

      <SectionHeading>Your Rights</SectionHeading>
      <Para>Depending on your jurisdiction, you may have the right to:</Para>
      <ul style={{paddingLeft:22,marginBottom:14}}>
        <Bullet>Access, correct, or delete your personal information we hold</Bullet>
        <Bullet>Object to or restrict processing of your information</Bullet>
        <Bullet>Withdraw consent to data collection (where applicable)</Bullet>
        <Bullet>Receive a copy of your data in a portable format</Bullet>
        <Bullet>Lodge a complaint with a supervisory authority</Bullet>
      </ul>
      <Para>
        To exercise these rights, email us at <a href="mailto:support@tiereduptech.com" style={{color:"var(--accent)"}}>support@tiereduptech.com</a>.
      </Para>

      <SectionHeading>Children's Privacy</SectionHeading>
      <Para>
        Our services are not intended for children under 13. We do not knowingly collect information from children under 13. If you believe we have collected such information, please contact us and we will delete it.
      </Para>

      <SectionHeading>Data Security</SectionHeading>
      <Para>
        We implement reasonable technical and organizational security measures to protect your information. However, no internet transmission or electronic storage is 100% secure, and we cannot guarantee absolute security.
      </Para>

      <SectionHeading>Changes to This Policy</SectionHeading>
      <Para>
        We may update this Privacy Policy periodically. When we do, we will revise the "Last updated" date at the top. Material changes will be communicated via a prominent notice on the site.
      </Para>

      <SectionHeading>Contact Us</SectionHeading>
      <Para>
        Privacy questions? Email <a href="mailto:support@tiereduptech.com" style={{color:"var(--accent)"}}>support@tiereduptech.com</a> or write to us at:
      </Para>
      <Para>
        TieredUp Tech, Inc.<br/>
        1812 N 16th St<br/>
        Orange, TX 77630<br/>
        United States
      </Para>
    </PageShell>
  );
}

// ─── TERMS OF USE ────────────────────────────────────────────────
function TermsPage() {
  return (
    <PageShell title="Terms of Use" subtitle="Last updated: April 23, 2026. Please read these terms carefully before using our services.">
      <SEO title="Terms of Use" description="Pro Rig Builder Terms of Use. Operated by TieredUp Tech, Inc., a Texas S-Corp. Read full terms governing use of our website and Pro Rig Scanner application." canonical="https://prorigbuilder.com/#terms" breadcrumb={[{name:"Home",url:"https://prorigbuilder.com/"},{name:"Terms",url:"https://prorigbuilder.com/#terms"}]}/>
      <SectionHeading>Acceptance of Terms</SectionHeading>
      <Para>
        By accessing or using <a href="https://prorigbuilder.com" style={{color:"var(--accent)"}}>prorigbuilder.com</a>, the Pro Rig Scanner application, or any related service ("Services"), you agree to be bound by these Terms of Use ("Terms"). If you do not agree, you may not use the Services.
      </Para>
      <Para>
        The Services are owned and operated by <strong>TieredUp Tech, Inc.</strong> ("Company," "we," "us," "our"), a Texas S-Corporation.
      </Para>

      <SectionHeading>Eligibility</SectionHeading>
      <Para>
        You must be at least 13 years old to use our Services. By using the Services, you represent that you meet this age requirement and that you have the legal capacity to enter into a binding agreement.
      </Para>

      <SectionHeading>Use of the Services</SectionHeading>
      <Para>
        Pro Rig Builder provides tools for comparing PC hardware prices, checking compatibility, generating builds, and related functionality. You may use the Services for personal, non-commercial purposes.
      </Para>
      <SubHeading>You agree NOT to:</SubHeading>
      <ul style={{paddingLeft:22,marginBottom:14}}>
        <Bullet>Scrape, crawl, or automate data collection from the Services without our written permission</Bullet>
        <Bullet>Reverse-engineer, decompile, or otherwise attempt to extract source code</Bullet>
        <Bullet>Use the Services to compete directly with Pro Rig Builder</Bullet>
        <Bullet>Attempt to gain unauthorized access to our systems, other users' data, or any connected networks</Bullet>
        <Bullet>Upload viruses, malware, or any malicious code</Bullet>
        <Bullet>Use the Services for any illegal purpose or in violation of any applicable laws</Bullet>
        <Bullet>Misrepresent your identity or affiliation</Bullet>
        <Bullet>Interfere with or disrupt the Services or servers</Bullet>
      </ul>

      <SectionHeading>Pricing & Availability Information</SectionHeading>
      <Para>
        Pro Rig Builder aggregates pricing and availability data from third-party retailers. We make reasonable efforts to keep this information accurate and up-to-date, but <strong>we cannot guarantee that prices, stock status, or product specifications displayed are current at all times</strong>. Always verify pricing and availability on the retailer's website before making a purchase.
      </Para>
      <Para>
        We are not responsible for errors, omissions, or outdated information. Reliance on our data is at your own risk.
      </Para>

      <SectionHeading>Compatibility & Build Recommendations</SectionHeading>
      <Para>
        Our compatibility engine, FPS estimator, bottleneck calculator, and other tools provide <strong>informed estimates and guidance</strong> based on manufacturer specifications and community data. These are not guarantees. Real-world performance varies based on many factors we cannot fully model.
      </Para>
      <Para>
        You are solely responsible for verifying compatibility and suitability before purchasing components or assembling a PC.
      </Para>

      <SectionHeading>Affiliate Disclosure</SectionHeading>
      <Para>
        Pro Rig Builder participates in affiliate programs with Amazon Associates, Best Buy, Newegg, B&H Photo, Antonline, and others. When you click an affiliate link and make a purchase, we may receive a commission at no additional cost to you. See our <a href="/affiliate" style={{color:"var(--accent)"}}>Affiliate Disclosure</a> for more details.
      </Para>

      <SectionHeading>Intellectual Property</SectionHeading>
      <Para>
        All content on Pro Rig Builder — including the website design, code, logo, Pro Rig Scanner application, written content, and compiled product data — is owned by TieredUp Tech, Inc. or its licensors and protected by copyright, trademark, and other intellectual property laws.
      </Para>
      <Para>
        You may not copy, modify, distribute, sell, or lease any part of the Services without our written permission. Product images, manufacturer logos, and specifications belong to their respective rights holders.
      </Para>

      <SectionHeading>Disclaimer of Warranties</SectionHeading>
      <Para>
        THE SERVICES ARE PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, OR ACCURACY.
      </Para>
      <Para>
        WE DO NOT WARRANT THAT THE SERVICES WILL BE UNINTERRUPTED, ERROR-FREE, OR COMPLETELY SECURE.
      </Para>

      <SectionHeading>Limitation of Liability</SectionHeading>
      <Para>
        TO THE MAXIMUM EXTENT PERMITTED BY LAW, TIEREDUP TECH, INC., ITS AFFILIATES, DIRECTORS, EMPLOYEES, AND AGENTS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING LOSS OF PROFITS, DATA, OR GOODWILL, ARISING FROM YOUR USE OF THE SERVICES.
      </Para>
      <Para>
        OUR AGGREGATE LIABILITY SHALL NOT EXCEED ONE HUNDRED U.S. DOLLARS ($100) OR THE AMOUNT YOU PAID US IN THE PAST TWELVE MONTHS, WHICHEVER IS GREATER.
      </Para>

      <SectionHeading>Indemnification</SectionHeading>
      <Para>
        You agree to defend, indemnify, and hold harmless TieredUp Tech, Inc. and its officers, directors, employees, and agents from any claims, damages, losses, or expenses (including reasonable attorneys' fees) arising from your use of the Services or violation of these Terms.
      </Para>

      <SectionHeading>Third-Party Links</SectionHeading>
      <Para>
        Our Services contain links to third-party websites and services (retailers, manufacturers, review sites). We are not responsible for the content, privacy practices, or availability of third-party sites. You access third-party sites at your own risk.
      </Para>

      <SectionHeading>Termination</SectionHeading>
      <Para>
        We may suspend or terminate your access to the Services at any time for any reason, including violation of these Terms, without prior notice or liability.
      </Para>

      <SectionHeading>Governing Law & Jurisdiction</SectionHeading>
      <Para>
        These Terms are governed by the laws of the <strong>State of Texas, United States</strong>, without regard to conflict-of-law principles. Any dispute arising from these Terms or the Services shall be resolved exclusively in the state or federal courts located in Orange County, Texas.
      </Para>

      <SectionHeading>Changes to Terms</SectionHeading>
      <Para>
        We may modify these Terms at any time. Updates will be posted on this page with a revised "Last updated" date. Your continued use of the Services after changes constitutes acceptance of the modified Terms.
      </Para>

      <SectionHeading>Severability</SectionHeading>
      <Para>
        If any provision of these Terms is found unenforceable, the remaining provisions shall continue in full force and effect.
      </Para>

      <SectionHeading>Contact</SectionHeading>
      <Para>
        Questions about these Terms? Contact us at <a href="mailto:support@tiereduptech.com" style={{color:"var(--accent)"}}>support@tiereduptech.com</a>.
      </Para>

      <div style={{marginTop:40,padding:"20px 24px",background:"var(--bg3)",borderRadius:10,border:"1px solid var(--bdr)"}}>
        <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",fontWeight:600,letterSpacing:1.5,marginBottom:6}}>DISCLAIMER</div>
        <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",lineHeight:1.6}}>
          These Terms of Use are provided for informational purposes and represent our standard operating agreement with users. They are not intended as and do not constitute legal advice. For specific legal questions, consult a licensed attorney.
        </div>
      </div>
    </PageShell>
  );
}

// ─── AFFILIATE DISCLOSURE ────────────────────────────────────────
function AffiliatePage() {
  return (
    <PageShell title="Affiliate Disclosure" subtitle="Transparency first: here's exactly how Pro Rig Builder earns revenue, and how our recommendations stay honest.">
      <SEO title="Affiliate Disclosure" description="Pro Rig Builder's FTC-compliant affiliate disclosure. We earn commissions through Amazon Associates, Best Buy, Newegg, B&H, and Antonline — at no cost to you." canonical="https://prorigbuilder.com/#affiliate" breadcrumb={[{name:"Home",url:"https://prorigbuilder.com/"},{name:"Affiliate Disclosure",url:"https://prorigbuilder.com/#affiliate"}]}/>
      <div style={{background:"var(--accent3)",border:"1px solid var(--accent)",borderRadius:12,padding:"20px 24px",marginBottom:28}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
          <span style={{fontSize:22}}>💡</span>
          <div style={{fontFamily:"var(--ff)",fontSize:17,fontWeight:700,color:"var(--txt)"}}>FTC-Compliant Summary</div>
        </div>
        <div style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--txt)",lineHeight:1.65}}>
          Pro Rig Builder earns commissions through affiliate links. When you click a "Buy" button and complete a purchase, we may earn a small commission <strong>at no additional cost to you</strong>. Our recommendations are not influenced by commission rates — we rank products purely on performance, price, and compatibility.
        </div>
      </div>

      <SectionHeading>What Are Affiliate Links?</SectionHeading>
      <Para>
        Affiliate links are special URLs that identify Pro Rig Builder as the source of a referral to a retailer. When you click one and make a qualifying purchase, the retailer pays Pro Rig Builder a small commission. The price you pay is identical to what you would pay if you navigated to the retailer directly — no markup, no hidden fees.
      </Para>

      <SectionHeading>Which Affiliate Programs We Participate In</SectionHeading>
      <Para>Pro Rig Builder participates in the following affiliate programs:</Para>
      <ul style={{paddingLeft:22,marginBottom:14}}>
        <Bullet><strong>Amazon Associates</strong> — "As an Amazon Associate, we earn from qualifying purchases." Associate tag: <code style={{background:"var(--bg3)",padding:"2px 6px",borderRadius:4,fontFamily:"var(--mono)",fontSize:13}}>tiereduptech-20</code></Bullet>
        <Bullet><strong>Best Buy Affiliate Program</strong> — commissions on qualifying purchases through Best Buy</Bullet>
        <Bullet><strong>Newegg Affiliate Network</strong> (in progress) — launching soon</Bullet>
        <Bullet><strong>B&H Photo Affiliate Program</strong> (in progress) — launching soon</Bullet>
        <Bullet><strong>Antonline Affiliate Program</strong> (in progress) — launching soon</Bullet>
      </ul>
      <Para>
        We may add or remove affiliate programs over time. This page will be updated to reflect current partnerships.
      </Para>

      <SectionHeading>How We Keep Recommendations Honest</SectionHeading>
      <Para>
        Our core value is trust. To protect that, we follow these principles:
      </Para>
      <ul style={{paddingLeft:22,marginBottom:14}}>
        <Bullet><strong>No pay-for-placement.</strong> We do not accept payments or compensation to rank one product above another. Rankings are based on objective benchmark scores, verified specifications, and live pricing data.</Bullet>
        <Bullet><strong>Best-price routing.</strong> If a retailer we don't have an affiliate link with has a cheaper price, we will tell you. We would rather lose a commission than mislead you.</Bullet>
        <Bullet><strong>In-stock priority.</strong> We prioritize in-stock retailers over out-of-stock ones with lower prices, so you're seeing real purchasable options.</Bullet>
        <Bullet><strong>No editorial bias.</strong> Our benchmark data, compatibility checks, FPS estimates, and bottleneck calculations are sourced from independent databases and publisher specifications, not affiliate partners.</Bullet>
        <Bullet><strong>Full disclosure.</strong> Every outbound retail link is an affiliate link. This disclosure applies site-wide.</Bullet>
      </ul>

      <SectionHeading>What the Commissions Cover</SectionHeading>
      <Para>
        Affiliate revenue is how we fund Pro Rig Builder. Commissions cover:
      </Para>
      <ul style={{paddingLeft:22,marginBottom:14}}>
        <Bullet>Server and infrastructure costs (hosting, CDN, database, API services)</Bullet>
        <Bullet>Catalog data acquisition and continuous verification</Bullet>
        <Bullet>Software development and maintenance</Bullet>
        <Bullet>Customer support operations</Bullet>
        <Bullet>Continued investment in new tools (FPS estimator, compatibility engine, scanner features)</Bullet>
      </ul>
      <Para>
        We do not sell your data, run ads, or charge users. Affiliate commissions are our sole revenue source.
      </Para>

      <SectionHeading>Your Choice</SectionHeading>
      <Para>
        You are never obligated to click affiliate links. You may navigate directly to any retailer's website to complete a purchase. Using our links costs you nothing extra but helps support the continued operation and improvement of Pro Rig Builder.
      </Para>

      <SectionHeading>FTC Compliance</SectionHeading>
      <Para>
        This disclosure is made in accordance with the <strong>Federal Trade Commission's 16 CFR Part 255: "Guides Concerning the Use of Endorsements and Testimonials in Advertising."</strong> Our relationships with affiliate partners are disclosed site-wide, and material connections are made clear to consumers.
      </Para>

      <SectionHeading>Questions</SectionHeading>
      <Para>
        Questions about our affiliate relationships or how we use commission revenue? Contact <a href="mailto:support@tiereduptech.com" style={{color:"var(--accent)"}}>support@tiereduptech.com</a>. We're happy to explain anything further.
      </Para>
    </PageShell>
  );
}

// ═══ COMPARISON PAGE ═══════════════════════════════════════════════
function ComparePage({go}) {
  // Feature data (factual, research-verified)
  const features = [
    {cat:"Core Tools", items:[
      {f:"PC Part Builder", pb:true, pcpp:true, newegg:true, logical:"Static tables only"},
      {f:"Live Multi-Retailer Pricing", pb:"Amazon + Best Buy + Newegg + B&H + Antonline", pcpp:"Yes", newegg:"Newegg only", logical:"Link-outs only"},
      {f:"Compatibility Engine", pb:"18+ checks", pcpp:"Yes", newegg:"Basic filtering", logical:false},
      {f:"Compatibility Warnings", pb:true, pcpp:true, newegg:true, logical:false},
      {f:"Community Builds Library", pb:"Curated", pcpp:"Large public library", newegg:"User showcases", logical:false},
    ]},
    {cat:"Proprietary Tools (Exclusive to Pro Rig Builder)", items:[
      {f:"Hardware Scanner App", pb:"✓ Free Windows app", pcpp:false, newegg:false, logical:false},
      {f:"Budget-Aware Upgrade Recs", pb:true, pcpp:false, newegg:false, logical:false},
      {f:"USED Product Flags", pb:true, pcpp:false, newegg:false, logical:false},
      {f:"FPS Estimator", pb:"Per-game estimates", pcpp:false, newegg:false, logical:false},
      {f:"Bottleneck Calculator", pb:true, pcpp:false, newegg:false, logical:false},
      {f:"Will It Run Checker", pb:true, pcpp:false, newegg:false, logical:false},
      {f:"Build-to-Build Comparison", pb:true, pcpp:false, newegg:"Side-by-side", logical:false},
      {f:"Part-to-Part Comparison", pb:true, pcpp:false, newegg:false, logical:false},
      {f:"Budget Build Wizard", pb:"Automated", pcpp:false, newegg:"AI-generated via ChatGPT", logical:"Static tiers"},
      {f:"Power (PSU) Calculator", pb:true, pcpp:false, newegg:"Separate tool", logical:false},
    ]},
    {cat:"User Experience", items:[
      {f:"Light & Dark Mode", pb:true, pcpp:false, newegg:false, logical:false},
      {f:"Advanced Search & Filters", pb:"Multi-criteria filtering", pcpp:"Basic filters", newegg:"Newegg search", logical:false},
      {f:"Mobile-Optimized", pb:true, pcpp:true, newegg:true, logical:true},
      {f:"In-Stock Priority Pricing", pb:"Shows in-stock prices first", pcpp:false, newegg:"Newegg stock only", logical:false},
      {f:"Real-Time Price Updates", pb:"Verified regularly", pcpp:"Yes", newegg:"Yes", logical:"Manual updates"},
    ]},
    {cat:"Business Model & Transparency", items:[
      {f:"Revenue Model", pb:"Affiliate commissions only", pcpp:"Ads + affiliate", newegg:"Retailer (direct sales)", logical:"Affiliate commissions"},
      {f:"Ads Shown to Users", pb:"Zero", pcpp:"Yes", newegg:"Product promotions", logical:"Minimal"},
      {f:"Retailer Bias", pb:"None — ranks by price/performance", pcpp:"None", newegg:"Newegg-favored", logical:"None"},
      {f:"Data Collection", pb:"Analytics only", pcpp:"Analytics + ads tracking", newegg:"Retailer tracking", logical:"Analytics only"},
    ]},
  ];

  const competitors = [
    {key:"pb", name:"Pro Rig Builder", badge:"YOU ARE HERE", color:"var(--accent)"},
    {key:"pcpp", name:"PCPartPicker", color:"var(--sky)"},
    {key:"newegg", name:"Newegg PC Builder", color:"var(--violet)"},
    {key:"logical", name:"Logical Increments", color:"var(--amber)"},
  ];

  const renderCell = (val, isPb) => {
    if (val === true) return <span style={{fontSize:22,color:isPb?"var(--accent)":"var(--mint)",fontWeight:700}}>✓</span>;
    if (val === false) return <span style={{fontSize:22,color:"var(--mute)",fontWeight:700}}>✗</span>;
    return <span style={{fontFamily:"var(--ff)",fontSize:13,color:isPb?"var(--accent)":"var(--txt)",fontWeight:isPb?700:500,lineHeight:1.3}}>{val}</span>;
  };

  return (
    <div className="fade">
      <SEO title="Why Pro Rig Builder vs PCPartPicker, Newegg & Logical Increments" description="Factual comparison of Pro Rig Builder vs PCPartPicker, Newegg PC Builder, and Logical Increments. Features, pricing, tools, and business model breakdown." canonical="https://prorigbuilder.com/#compare" breadcrumb={[{name:"Home",url:"https://prorigbuilder.com/"},{name:"Compare",url:"https://prorigbuilder.com/#compare"}]} faq={[{"q":"How does Pro Rig Builder compare to PCPartPicker?","a":"Pro Rig Builder matches PCPartPicker's core features and adds 8 exclusive features: hardware scanner, FPS estimator, bottleneck calculator, Will-It-Run checker, USED flags, budget-aware upgrade recommendations, budget build wizard, and light/dark mode. Pro Rig Builder also runs zero ads."},{"q":"How does Pro Rig Builder compare to Newegg PC Builder?","a":"Newegg PC Builder shows only Newegg inventory. Pro Rig Builder compares prices across five retailers (Amazon, Best Buy, Newegg, B&H, Antonline) and ranks parts neutrally with no retailer bias."},{"q":"How does Pro Rig Builder compare to Logical Increments?","a":"Logical Increments is a static tier-based build guide. Pro Rig Builder is an interactive platform with live pricing, compatibility validation, and modern tools that Logical Increments does not offer."},{"q":"Is Pro Rig Builder biased toward certain retailers?","a":"No. Pro Rig Builder ranks products by benchmark performance, price, and compatibility - never by affiliate commission rates."}]}/>
      {/* HERO */}
      <div style={{background:"var(--heroGrad)",borderBottom:"1px solid var(--bdr)",position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",top:"-10%",right:"-5%",width:500,height:500,borderRadius:"50%",background:"radial-gradient(circle, rgba(255,107,53,0.08) 0%, transparent 60%)",pointerEvents:"none"}}/>
        <div style={{maxWidth:1600,margin:"0 auto",padding:"72px 32px 48px",position:"relative"}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"var(--accent3)",border:"1px solid var(--accent)",color:"var(--accent)",padding:"5px 14px",borderRadius:14,fontFamily:"var(--mono)",fontSize:13,fontWeight:700,letterSpacing:1.5,marginBottom:24}}>
            WHY PRO RIG BUILDER
          </div>
          <h1 style={{fontFamily:"var(--ff)",fontSize:54,fontWeight:800,color:"var(--txt)",letterSpacing:-1.2,lineHeight:1.08,maxWidth:1000}}>
            How we compare to the <span style={{background:"linear-gradient(135deg, var(--accent), var(--amber))",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>other PC builder tools</span>
          </h1>
          <p style={{fontFamily:"var(--ff)",fontSize:17,color:"var(--dim)",marginTop:18,lineHeight:1.7,maxWidth:940}}>
            An honest, factual comparison with PCPartPicker, Newegg PC Builder, and Logical Increments — the three biggest PC builder platforms. We focus on facts, not hype. You decide.
          </p>
        </div>
      </div>

      {/* BIG COMPARISON TABLE */}
      <div style={{maxWidth:1600,margin:"0 auto",padding:"48px 32px 24px"}}>
        <h2 style={{fontFamily:"var(--ff)",fontSize:28,fontWeight:800,color:"var(--txt)",letterSpacing:-0.5,marginBottom:18}}>Feature-by-feature comparison</h2>
        <p style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--dim)",marginBottom:24,lineHeight:1.6}}>
          Green check = feature is available. Red X = feature is not available. Text = brief note on implementation. Last verified: April 2026.
        </p>

        <div style={{overflowX:"auto",border:"1px solid var(--bdr)",borderRadius:12,background:"var(--bg2)"}}>
          <table style={{width:"100%",borderCollapse:"collapse",minWidth:720}}>
            <thead>
              <tr style={{background:"var(--bg3)",borderBottom:"2px solid var(--bdr)"}}>
                <th style={{textAlign:"left",padding:"14px 16px",fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",fontWeight:700,letterSpacing:1.5,minWidth:180}}>FEATURE</th>
                {competitors.map(c => (
                  <th key={c.key} style={{textAlign:"center",padding:"14px 12px",minWidth:130}}>
                    <div style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:c.color,marginBottom:c.badge?4:0}}>{c.name}</div>
                    {c.badge && <div style={{display:"inline-block",background:c.color,color:"#fff",fontFamily:"var(--mono)",fontSize:9,fontWeight:800,padding:"2px 8px",borderRadius:4,letterSpacing:1}}>{c.badge}</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {features.map((section, si) => (
                <React.Fragment key={si}>
                  <tr>
                    <td colSpan={5} style={{padding:"14px 16px 8px",background:"var(--bg3)",borderTop:si===0?"none":"1px solid var(--bdr)",fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",fontWeight:700,letterSpacing:1.5}}>
                      {section.cat.toUpperCase()}
                    </td>
                  </tr>
                  {section.items.map((row, ri) => (
                    <tr key={ri} style={{borderTop:"1px solid var(--bdr)"}}>
                      <td style={{padding:"12px 16px",fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)"}}>{row.f}</td>
                      <td style={{padding:"12px",textAlign:"center",background:"var(--accent3)"}}>{renderCell(row.pb, true)}</td>
                      <td style={{padding:"12px",textAlign:"center"}}>{renderCell(row.pcpp)}</td>
                      <td style={{padding:"12px",textAlign:"center"}}>{renderCell(row.newegg)}</td>
                      <td style={{padding:"12px",textAlign:"center"}}>{renderCell(row.logical)}</td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* DEEP DIVES */}
      <div style={{background:"var(--bg2)",borderTop:"1px solid var(--bdr)",marginTop:48}}>
        <div style={{maxWidth:1600,margin:"0 auto",padding:"56px 32px"}}>
          <div style={{textAlign:"center",marginBottom:40}}>
            <div style={{fontFamily:"var(--mono)",fontSize:13,color:"var(--accent)",fontWeight:700,letterSpacing:2,marginBottom:8}}>DEEP DIVE</div>
            <h2 style={{fontFamily:"var(--ff)",fontSize:32,fontWeight:800,color:"var(--txt)",letterSpacing:-0.5}}>What actually sets us apart</h2>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:24}} className="how-grid">
            {[
              {
                i:"🔍",
                t:"The only platform with a hardware scanner",
                d:"Download our free Windows app and it detects your CPU, GPU, RAM, storage, and motherboard automatically. No typing part names. No guessing. No other PC builder tool offers this — not PCPartPicker, not Newegg, not Logical Increments."
              },
              {
                i:"💰",
                t:"Budget-aware upgrade recommendations",
                d:"Tell us your budget and we find the biggest performance uplift per dollar. Refresh-needed detection for outdated platforms (old sockets, wrong RAM type). Competitors show you parts but won't tell you which upgrade actually matters for your specific rig."
              },
              {
                i:"🎮",
                t:"FPS estimator + Will-It-Run checker",
                d:"See projected FPS for popular games on your build before you buy. Check if your existing PC can handle a specific game. Neither PCPartPicker nor Newegg offers game-specific performance prediction."
              },
              {
                i:"⚖️",
                t:"Bottleneck calculator",
                d:"Know exactly whether your CPU or GPU is the weak link. Get specific percentage severity. Our bottleneck engine goes deeper than generic \u0022balanced build\u0022 recommendations other tools offer."
              },
              {
                i:"🛍️",
                t:"Real multi-retailer pricing, in-stock first",
                d:"We compare live prices across Amazon, Best Buy, Newegg, B&H, and Antonline — and show you the in-stock retailer first, not just the cheapest (which is often out of stock). Newegg PC Builder shows only Newegg. Logical Increments doesn't track live prices at all."
              },
              {
                i:"♻️",
                t:"USED product flags",
                d:"Used and refurbished GPUs and CPUs are clearly marked in our catalog. Save money, know what you're buying. No competitor clearly flags pre-owned listings."
              },
              {
                i:"🎨",
                t:"Actually good UX",
                d:"Light & dark mode, mobile-optimized, advanced filters, fast search, and zero ads. PCPartPicker's interface hasn't significantly changed in years. Newegg is a retail funnel first, tool second."
              },
              {
                i:"🤝",
                t:"Honest business model",
                d:"Affiliate commissions only. No ads. No paid placement. No retailer bias. If a cheaper retailer exists without an affiliate deal, we'll still tell you. We would rather lose a commission than mislead you."
              },
            ].map(f => (
              <div key={f.t} style={{background:"var(--card)",borderRadius:14,padding:"26px 28px",border:"1px solid var(--bdr)"}}>
                <div style={{fontSize:28,lineHeight:1,marginBottom:14}}>{f.i}</div>
                <div style={{fontFamily:"var(--ff)",fontSize:17,fontWeight:700,color:"var(--txt)",marginBottom:10,lineHeight:1.25}}>{f.t}</div>
                <div style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--dim)",lineHeight:1.7}}>{f.d}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* HEAD-TO-HEAD SECTIONS */}
      <div style={{maxWidth:1536,margin:"0 auto",padding:"56px 32px"}}>
        <div style={{textAlign:"center",marginBottom:40}}>
          <div style={{fontFamily:"var(--mono)",fontSize:13,color:"var(--accent)",fontWeight:700,letterSpacing:2,marginBottom:8}}>HEAD TO HEAD</div>
          <h2 style={{fontFamily:"var(--ff)",fontSize:32,fontWeight:800,color:"var(--txt)",letterSpacing:-0.5}}>Direct comparisons</h2>
        </div>

        {/* vs PCPartPicker */}
        <div style={{background:"var(--bg2)",borderRadius:14,padding:"32px 34px",border:"1px solid var(--bdr)",marginBottom:24}}>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
            <div style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--txt)"}}>Pro Rig Builder vs. PCPartPicker</div>
          </div>
          <p style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--dim)",lineHeight:1.75,marginBottom:18}}>
            PCPartPicker is the best-known PC builder platform. It's solid: a large community build library, solid compatibility engine, real-time pricing across retailers. But it's also 15+ years old and shows it. Pro Rig Builder does everything PCPartPicker does — plus eight tools PCPartPicker doesn't have.
          </p>
          <div style={{background:"var(--bg3)",padding:"18px 22px",borderRadius:10}}>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",fontWeight:700,letterSpacing:1.5,marginBottom:10}}>WHAT WE HAVE THAT PCPARTPICKER DOESN'T</div>
            <ul style={{paddingLeft:20,margin:0}}>
              <li style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.8,marginBottom:4}}>Free Windows hardware scanner app</li>
              <li style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.8,marginBottom:4}}>FPS estimator and Will-It-Run checker for specific games</li>
              <li style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.8,marginBottom:4}}>Bottleneck calculator with percentage severity</li>
              <li style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.8,marginBottom:4}}>USED product flags</li>
              <li style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.8,marginBottom:4}}>Budget-aware automated upgrade recommendations</li>
              <li style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.8,marginBottom:4}}>Automated budget build wizard</li>
              <li style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.8,marginBottom:4}}>Light + dark mode</li>
              <li style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.8,marginBottom:0}}>Zero ads (PCPartPicker is ad-supported)</li>
            </ul>
          </div>
        </div>

        {/* vs Newegg */}
        <div style={{background:"var(--bg2)",borderRadius:14,padding:"32px 34px",border:"1px solid var(--bdr)",marginBottom:24}}>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
            <div style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--txt)"}}>Pro Rig Builder vs. Newegg PC Builder</div>
          </div>
          <p style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--dim)",lineHeight:1.75,marginBottom:18}}>
            Newegg's PC Builder is a shopping tool first, a builder tool second. It only shows Newegg inventory. Its AI "Build with AI" feature uses ChatGPT to generate recommendations, but pricing, stock, and inventory are Newegg-only — no comparison with Amazon, Best Buy, or anywhere else. The tool exists to drive purchases on Newegg.com.
          </p>
          <div style={{background:"var(--bg3)",padding:"18px 22px",borderRadius:10}}>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",fontWeight:700,letterSpacing:1.5,marginBottom:10}}>THE KEY DIFFERENCE</div>
            <div style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.7}}>
              Pro Rig Builder compares pricing across <strong>five retailers</strong>. We're neutral — we'll recommend the best deal regardless of which retailer offers it. Newegg PC Builder is a Newegg sales tool. If Amazon is $50 cheaper, Newegg won't tell you.
            </div>
          </div>
        </div>

        {/* vs Logical Increments */}
        <div style={{background:"var(--bg2)",borderRadius:14,padding:"32px 34px",border:"1px solid var(--bdr)"}}>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
            <div style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--txt)"}}>Pro Rig Builder vs. Logical Increments</div>
          </div>
          <p style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--dim)",lineHeight:1.75,marginBottom:18}}>
            Logical Increments is a static build guide — not an interactive builder. Its "Grid" recommends parts for budget tiers (Excellent, Outstanding, Exceptional, etc.), updated manually by the team. There's no compatibility engine, no real-time pricing, no personalized recommendations. Good for beginners who want a curated list; limited for anyone building a specific rig.
          </p>
          <div style={{background:"var(--bg3)",padding:"18px 22px",borderRadius:10}}>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",fontWeight:700,letterSpacing:1.5,marginBottom:10}}>THE KEY DIFFERENCE</div>
            <div style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.7}}>
              Logical Increments tells you what parts to buy. Pro Rig Builder lets you build, compare, validate, and benchmark — with your specific hardware, budget, and games. One is a cookbook. The other is a kitchen.
            </div>
          </div>
        </div>
      </div>

      {/* BOTTOM CTA */}
      <div style={{background:"var(--bg2)",borderTop:"1px solid var(--bdr)"}}>
        <div style={{maxWidth:1000,margin:"0 auto",padding:"56px 32px",textAlign:"center"}}>
          <h2 style={{fontFamily:"var(--ff)",fontSize:30,fontWeight:800,color:"var(--txt)",letterSpacing:-0.5,marginBottom:14}}>Try the difference yourself</h2>
          <p style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--dim)",lineHeight:1.65,marginBottom:26}}>
            Start a build, scan your existing rig, or browse parts with better filters than the competition. We're confident you'll see the difference within 30 seconds.
          </p>
          <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap"}}>
            <button onClick={()=>go("builder")} style={{padding:"14px 28px",borderRadius:12,fontSize:15,fontFamily:"var(--ff)",fontWeight:700,cursor:"pointer",background:"var(--accent)",color:"#fff",border:"none",boxShadow:"0 6px 20px rgba(255,107,53,.3)"}}>Start Building →</button>
            <button onClick={()=>go("scanner")} style={{padding:"14px 28px",borderRadius:12,fontSize:15,fontFamily:"var(--ff)",fontWeight:600,cursor:"pointer",background:"var(--bg3)",color:"var(--txt)",border:"1px solid var(--bdr)"}}>📥 Try the Scanner</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══ PRODUCT SCHEMA HELPER ═════════════════════════════════════════
// Emits Product JSON-LD via Helmet when a product is expanded (viewed in detail).
// Google crawler sees this structured data for rich snippets in search results.
function ProductSchema({p}) {
  if (!p) return null;

  const price = p.deals && typeof p.deals === "object"
    ? Math.min(...Object.values(p.deals).filter(d => d && typeof d === "object" && d.price).map(d => d.price), p.pr || 9999)
    : (p.pr || 0);

  const retailers = p.deals && typeof p.deals === "object"
    ? Object.entries(p.deals).filter(([_, d]) => d && typeof d === "object" && d.url)
    : [];

  const schema = {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": p.n,
    "brand": {"@type": "Brand", "name": p.b || "Unknown"},
    "category": p.c,
    ...(p.img ? {"image": p.img} : {}),
    ...(p.r ? {"aggregateRating": {"@type": "AggregateRating", "ratingValue": p.r, "reviewCount": 10, "bestRating": 5}} : {}),
    "offers": retailers.length > 0
      ? retailers.map(([retailer, d]) => ({
          "@type": "Offer",
          "url": d.url,
          "price": d.price,
          "priceCurrency": "USD",
          "availability": d.inStock !== false ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
          "seller": {"@type": "Organization", "name": retailer.charAt(0).toUpperCase() + retailer.slice(1)}
        }))
      : (price > 0 ? {"@type": "Offer", "price": price, "priceCurrency": "USD", "availability": "https://schema.org/InStock"} : undefined)
  };

  return (
    <Helmet>
      <script type="application/ld+json">{JSON.stringify(schema)}</script>
    </Helmet>
  );
}

// ═══ SEO COMPONENT ═════════════════════════════════════════════════
function SEO({title, description, canonical, breadcrumb, faq}) {
  const fullTitle = title ? title + " | Pro Rig Builder" : "Pro Rig Builder — Compare, Build & Save on PC Parts";
  const desc = description || "Compare PC components across Amazon, Best Buy, Newegg & more. Free Windows hardware scanner, compatibility engine, FPS estimator, and budget-aware upgrade recommendations.";
  const url = canonical || "https://prorigbuilder.com/";

  // BreadcrumbList schema (if breadcrumb items provided)
  const breadcrumbSchema = breadcrumb && breadcrumb.length > 0 ? {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": breadcrumb.map((item, idx) => ({
      "@type": "ListItem",
      "position": idx + 1,
      "name": item.name,
      "item": item.url
    }))
  } : null;

  const faqSchema = faq && faq.length > 0 ? {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": faq.map(q => ({
      "@type": "Question",
      "name": q.q,
      "acceptedAnswer": {
        "@type": "Answer",
        "text": q.a
      }
    }))
  } : null;

  return (
    <Helmet>
      <title>{fullTitle}</title>
      <meta name="description" content={desc}/>
      <link rel="canonical" href={url}/>
      <meta property="og:title" content={fullTitle}/>
      <meta property="og:description" content={desc}/>
      <meta property="og:url" content={url}/>
      <meta name="twitter:title" content={fullTitle}/>
      <meta name="twitter:description" content={desc}/>
      {breadcrumbSchema && (
        <script type="application/ld+json">
          {JSON.stringify(breadcrumbSchema)}
        </script>
      )}
      {faqSchema && (
        <script type="application/ld+json">
          {JSON.stringify(faqSchema)}
        </script>
      )}
    </Helmet>
  );
}

// ═══ SEO VARIANT PAGES (target PCPartPicker keywords) ═══════════════

// Reusable content block for consistency across variant pages
function VariantCTA({go}) {
  return (
    <div style={{background:"var(--bg2)",borderTop:"1px solid var(--bdr)",marginTop:48}}>
      <div style={{maxWidth:1000,margin:"0 auto",padding:"52px 32px",textAlign:"center"}}>
        <h2 style={{fontFamily:"var(--ff)",fontSize:28,fontWeight:800,color:"var(--txt)",letterSpacing:-0.5,marginBottom:12}}>Ready to build smarter?</h2>
        <p style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--dim)",lineHeight:1.7,marginBottom:24}}>
          Every tool free. Zero ads. Real multi-retailer pricing. Plus our exclusive hardware scanner.
        </p>
        <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap"}}>
          <button onClick={()=>go("builder")} style={{padding:"14px 28px",borderRadius:12,fontSize:15,fontFamily:"var(--ff)",fontWeight:700,cursor:"pointer",background:"var(--accent)",color:"#fff",border:"none",boxShadow:"0 6px 20px rgba(255,107,53,.3)"}}>Start Building →</button>
          <button onClick={()=>go("scanner")} style={{padding:"14px 28px",borderRadius:12,fontSize:15,fontFamily:"var(--ff)",fontWeight:600,cursor:"pointer",background:"var(--bg3)",color:"var(--txt)",border:"1px solid var(--bdr)"}}>📥 Try the Scanner</button>
          <button onClick={()=>go("compare")} style={{padding:"14px 28px",borderRadius:12,fontSize:15,fontFamily:"var(--ff)",fontWeight:600,cursor:"pointer",background:"transparent",color:"var(--txt)",border:"1px solid var(--bdr)"}}>Full Comparison</button>
        </div>
      </div>
    </div>
  );
}

// ─── /vs-pcpartpicker ────────────────────────────────────────────
function VsPcPartPickerPage({go}) {
  return (
    <div className="fade">
      <SEO title="Pro Rig Builder vs PCPartPicker: A 2026 Feature Comparison" description="How Pro Rig Builder compares to PCPartPicker in 2026. Features, tools, pricing engine, and business model breakdown. Objective, factual comparison." canonical="https://prorigbuilder.com/#vs-pcpartpicker" breadcrumb={[{name:"Home",url:"https://prorigbuilder.com/"},{name:"Compare",url:"https://prorigbuilder.com/#compare"},{name:"vs PCPartPicker",url:"https://prorigbuilder.com/#vs-pcpartpicker"}]} faq={[{"q":"Should I use Pro Rig Builder or PCPartPicker?","a":"Use Pro Rig Builder if you want modern tools (hardware scanner, FPS estimator, bottleneck calculator), an ad-free experience, or budget-aware upgrade recommendations. Use PCPartPicker if you primarily want access to a large community of user-submitted builds."},{"q":"Is Pro Rig Builder a PCPartPicker clone?","a":"No. Pro Rig Builder is a distinct platform with 8 exclusive features PCPartPicker does not offer. We built our compatibility engine, pricing system, and all tools from scratch."},{"q":"Can I use both Pro Rig Builder and PCPartPicker?","a":"Yes. Many users cross-reference between both platforms. They are complementary."},{"q":"Does Pro Rig Builder have more parts than PCPartPicker?","a":"Pro Rig Builder's catalog contains over 3,400 verified PC components as of April 2026, updated continuously. For current-generation hardware, both platforms have comprehensive coverage."}]}/>
      <div style={{background:"var(--heroGrad)",borderBottom:"1px solid var(--bdr)",position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",top:"-10%",right:"-5%",width:500,height:500,borderRadius:"50%",background:"radial-gradient(circle, rgba(255,107,53,0.08) 0%, transparent 60%)",pointerEvents:"none"}}/>
        <div style={{maxWidth:1180,margin:"0 auto",padding:"60px 32px 40px",position:"relative"}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"var(--accent3)",border:"1px solid var(--accent)",color:"var(--accent)",padding:"5px 14px",borderRadius:14,fontFamily:"var(--mono)",fontSize:13,fontWeight:700,letterSpacing:1.5,marginBottom:22}}>COMPARISON GUIDE</div>
          <h1 style={{fontFamily:"var(--ff)",fontSize:42,fontWeight:800,color:"var(--txt)",letterSpacing:-1.2,lineHeight:1.12,marginBottom:16}}>Pro Rig Builder vs PCPartPicker: A 2026 Feature Comparison</h1>
          <p style={{fontFamily:"var(--ff)",fontSize:17,color:"var(--dim)",lineHeight:1.65,maxWidth:940}}>
            PCPartPicker has been the go-to PC builder platform for over a decade. Pro Rig Builder is the modern alternative with features PCPartPicker doesn't offer. Here's how we compare, side-by-side, with no hype.
          </p>
        </div>
      </div>

      <div style={{maxWidth:1180,margin:"0 auto",padding:"48px 32px"}}>
        <SectionHeading>The short answer</SectionHeading>
        <Para>
          <strong>PCPartPicker</strong> is an established platform with a large community, solid compatibility engine, and real-time pricing across retailers. It's ad-supported and works well for basic PC building.
        </Para>
        <Para>
          <strong>Pro Rig Builder</strong> does everything PCPartPicker does, plus features they don't offer: a free hardware scanner app, FPS estimator, bottleneck calculator, budget-aware upgrade recommendations, and USED product flags. We're also ad-free.
        </Para>

        <SectionHeading>What PCPartPicker Has That We Also Have</SectionHeading>
        <ul style={{paddingLeft:22,marginBottom:20}}>
          <Bullet><strong>Compatibility engine</strong> — we match their coverage (socket, chipset, form factor, memory type, PSU wattage)</Bullet>
          <Bullet><strong>Real-time multi-retailer pricing</strong> — both tools compare prices across Amazon, Best Buy, Newegg, and other retailers</Bullet>
          <Bullet><strong>PC Builder tool</strong> — interactive builder with running totals</Bullet>
          <Bullet><strong>Part browsing and filtering</strong> — large catalog of CPUs, GPUs, motherboards, RAM, etc.</Bullet>
          <Bullet><strong>Build sharing and saving</strong> — both tools let you save your build for later reference</Bullet>
        </ul>

        <SectionHeading>What Pro Rig Builder Offers That PCPartPicker Does NOT</SectionHeading>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:24}} className="how-grid">
          {[
            {i:"🔍", t:"Hardware Scanner App", d:"Download our free Windows app. It detects your hardware automatically and generates upgrade recommendations. PCPartPicker has no equivalent."},
            {i:"🎮", t:"FPS Estimator", d:"See projected frames per second for popular games on your build before buying. PCPartPicker does not predict game-specific performance."},
            {i:"⚖️", t:"Bottleneck Calculator", d:"Know whether your CPU or GPU is holding back performance, with percentage severity. PCPartPicker has no bottleneck tool."},
            {i:"🕹️", t:"Will It Run Checker", d:"Check if your current PC can handle a specific game. PCPartPicker focuses on new builds, not gaming capability checks."},
            {i:"💰", t:"Budget-Aware Upgrade Recs", d:"Tell us your budget and we'll tell you the biggest performance uplift. PCPartPicker shows parts but does not rank by budget impact."},
            {i:"♻️", t:"USED Product Flags", d:"Pre-owned parts are clearly marked so you know what you're buying. PCPartPicker does not distinguish used listings."},
            {i:"🧙", t:"Auto Build Wizard", d:"Give us a budget, we generate a balanced, compatible build. PCPartPicker is manual-only."},
            {i:"🌗", t:"Light & Dark Mode", d:"Seamless theme switching. PCPartPicker has one theme."},
          ].map(f => (
            <div key={f.t} style={{background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:12,padding:"22px 24px"}}>
              <div style={{fontSize:26,marginBottom:10}}>{f.i}</div>
              <div style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:700,color:"var(--txt)",marginBottom:8}}>{f.t}</div>
              <div style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--dim)",lineHeight:1.65}}>{f.d}</div>
            </div>
          ))}
        </div>

        <SectionHeading>Business Model Differences</SectionHeading>
        <Para>
          <strong>PCPartPicker</strong> runs display advertising alongside affiliate commissions. You see banner ads, sidebar ads, and sponsored content. Their catalog listings can be influenced by advertisers.
        </Para>
        <Para>
          <strong>Pro Rig Builder</strong> runs zero ads. Our only revenue is affiliate commissions when users click our links to retailers. Rankings are based purely on benchmark scores, price, and compatibility — not advertiser payments. If a non-affiliate retailer has a cheaper price, we still tell you.
        </Para>

        <SectionHeading>Which should you choose?</SectionHeading>
        <ul style={{paddingLeft:22,marginBottom:24}}>
          <Bullet><strong>Choose PCPartPicker</strong> if you want access to a large community of user-submitted completed builds or need deep legacy hardware data from many years back.</Bullet>
          <Bullet><strong>Choose Pro Rig Builder</strong> if you want modern tools (scanner, FPS estimator, bottleneck calc, budget wizard), an ad-free experience, or budget-aware upgrade recommendations for an existing PC.</Bullet>
        </ul>
        <Para>
          Or use both. They're complementary. Many of our users cross-reference between sites.
        </Para>

        <div style={{marginTop:32,padding:"20px 24px",background:"var(--bg3)",borderRadius:10,border:"1px solid var(--bdr)"}}>
          <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",fontWeight:600,letterSpacing:1.5,marginBottom:6}}>NOTE</div>
          <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",lineHeight:1.6}}>
            This comparison is factual and based on features publicly available on both sites as of April 2026. Pro Rig Builder is not affiliated with PCPartPicker. For the full 24-feature comparison including Newegg and Logical Increments, see our <span onClick={()=>go("compare")} style={{color:"var(--accent)",cursor:"pointer",textDecoration:"underline"}}>full comparison page</span>.
          </div>
        </div>
      </div>
      <VariantCTA go={go}/>
    </div>
  );
}

// ─── /pcpartpicker-alternative ───────────────────────────────────
function PcpAlternativePage({go}) {
  return (
    <div className="fade">
      <SEO title="The Best PCPartPicker Alternative in 2026" description="Looking for a PCPartPicker alternative? Pro Rig Builder offers every feature plus hardware scanner, FPS estimator, bottleneck calculator, and budget-aware upgrade recommendations. Ad-free." canonical="https://prorigbuilder.com/#pcpartpicker-alternative" breadcrumb={[{name:"Home",url:"https://prorigbuilder.com/"},{name:"PCPartPicker Alternative",url:"https://prorigbuilder.com/#pcpartpicker-alternative"}]}/>
      <div style={{background:"var(--heroGrad)",borderBottom:"1px solid var(--bdr)",position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",top:"-10%",right:"-5%",width:500,height:500,borderRadius:"50%",background:"radial-gradient(circle, rgba(255,107,53,0.08) 0%, transparent 60%)",pointerEvents:"none"}}/>
        <div style={{maxWidth:1180,margin:"0 auto",padding:"60px 32px 40px",position:"relative"}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"var(--accent3)",border:"1px solid var(--accent)",color:"var(--accent)",padding:"5px 14px",borderRadius:14,fontFamily:"var(--mono)",fontSize:13,fontWeight:700,letterSpacing:1.5,marginBottom:22}}>ALTERNATIVE GUIDE</div>
          <h1 style={{fontFamily:"var(--ff)",fontSize:42,fontWeight:800,color:"var(--txt)",letterSpacing:-1.2,lineHeight:1.12,marginBottom:16}}>The Best PCPartPicker Alternative in 2026</h1>
          <p style={{fontFamily:"var(--ff)",fontSize:17,color:"var(--dim)",lineHeight:1.65,maxWidth:940}}>
            Looking for a PC builder platform with more tools, zero ads, and modern features? Pro Rig Builder is the alternative built for 2026 — with eight features you won't find on PCPartPicker.
          </p>
        </div>
      </div>

      <div style={{maxWidth:1180,margin:"0 auto",padding:"48px 32px"}}>
        <SectionHeading>Why look for a PCPartPicker alternative?</SectionHeading>
        <Para>
          PCPartPicker is the most recognized PC builder platform, but it has limitations. Users commonly cite these reasons for seeking alternatives:
        </Para>
        <ul style={{paddingLeft:22,marginBottom:20}}>
          <Bullet><strong>Heavy ad load</strong> — PCPartPicker displays banner ads, sidebar ads, and promoted content that clutter the building experience</Bullet>
          <Bullet><strong>No hardware detection</strong> — you have to manually enter every part you own to get upgrade recommendations</Bullet>
          <Bullet><strong>No performance prediction</strong> — no way to see FPS estimates, bottleneck analysis, or game compatibility before buying</Bullet>
          <Bullet><strong>No budget-aware recommendations</strong> — it shows parts but doesn't prioritize upgrades by performance-per-dollar impact</Bullet>
          <Bullet><strong>No USED listings tracking</strong> — used and refurbished parts look the same as new ones in listings</Bullet>
          <Bullet><strong>Dated interface</strong> — core UI hasn't seen major changes in years; no dark mode</Bullet>
        </ul>

        <SectionHeading>Pro Rig Builder: Everything PCPartPicker Offers + 8 More Tools</SectionHeading>
        <Para>
          Pro Rig Builder was built to solve each of the above limitations. We match PCPartPicker's core features (compatibility engine, real-time pricing, part browsing, build saving) and add exclusive tools:
        </Para>
        <div style={{background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:12,padding:"24px 28px",marginBottom:20}}>
          <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",fontWeight:700,letterSpacing:1.5,marginBottom:12}}>PRO RIG BUILDER EXCLUSIVE FEATURES</div>
          <ol style={{paddingLeft:22,margin:0}}>
            <li style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--txt)",lineHeight:1.75,marginBottom:10}}><strong>Pro Rig Scanner</strong> — free Windows app that detects your hardware automatically. Runs 100% locally with zero data collection.</li>
            <li style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--txt)",lineHeight:1.75,marginBottom:10}}><strong>FPS Estimator</strong> — see projected FPS for popular games on your proposed build.</li>
            <li style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--txt)",lineHeight:1.75,marginBottom:10}}><strong>Bottleneck Calculator</strong> — percentage severity of CPU/GPU bottleneck for informed upgrade decisions.</li>
            <li style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--txt)",lineHeight:1.75,marginBottom:10}}><strong>Will It Run</strong> — check if your current PC handles a specific game before you try it.</li>
            <li style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--txt)",lineHeight:1.75,marginBottom:10}}><strong>Budget Build Wizard</strong> — automated build generation based on your budget.</li>
            <li style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--txt)",lineHeight:1.75,marginBottom:10}}><strong>USED Product Flags</strong> — pre-owned listings clearly marked for transparent shopping.</li>
            <li style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--txt)",lineHeight:1.75,marginBottom:10}}><strong>Budget-Aware Upgrade Recs</strong> — tell us your budget, we show the biggest performance uplift.</li>
            <li style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--txt)",lineHeight:1.75,marginBottom:0}}><strong>Light + Dark Mode</strong> — modern UI with theme switching.</li>
          </ol>
        </div>

        <SectionHeading>Plus: Zero ads.</SectionHeading>
        <Para>
          Pro Rig Builder runs zero banner ads, zero sidebar ads, zero sponsored content. Our only revenue is affiliate commissions when you click a retailer link and make a purchase — at no additional cost to you. Rankings are based on benchmarks, price, and compatibility, never on payments from advertisers.
        </Para>

        <SectionHeading>Quick switch: your PCPartPicker build is portable</SectionHeading>
        <Para>
          If you have an existing PCPartPicker build list, our <span onClick={()=>go("builder")} style={{color:"var(--accent)",cursor:"pointer",textDecoration:"underline"}}>PC Builder</span> makes it easy to recreate with our features on top. Or, download our <span onClick={()=>go("scanner")} style={{color:"var(--accent)",cursor:"pointer",textDecoration:"underline"}}>hardware scanner</span> and let it detect your current rig, then see our upgrade suggestions.
        </Para>
      </div>
      <VariantCTA go={go}/>
    </div>
  );
}

// ─── /best-pc-builder-tools ──────────────────────────────────────
function BestPcBuilderToolsPage({go}) {
  return (
    <div className="fade">
      <SEO title="Best PC Builder Tools in 2026: Ranked & Reviewed" description="The best PC builder tools of 2026 ranked by features, pricing transparency, and modern UX. See how Pro Rig Builder, PCPartPicker, Newegg PC Builder, and Logical Increments stack up." canonical="https://prorigbuilder.com/#best-pc-builder-tools" breadcrumb={[{name:"Home",url:"https://prorigbuilder.com/"},{name:"Best PC Builder Tools",url:"https://prorigbuilder.com/#best-pc-builder-tools"}]}/>
      <div style={{background:"var(--heroGrad)",borderBottom:"1px solid var(--bdr)",position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",top:"-10%",right:"-5%",width:500,height:500,borderRadius:"50%",background:"radial-gradient(circle, rgba(255,107,53,0.08) 0%, transparent 60%)",pointerEvents:"none"}}/>
        <div style={{maxWidth:1180,margin:"0 auto",padding:"60px 32px 40px",position:"relative"}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"var(--accent3)",border:"1px solid var(--accent)",color:"var(--accent)",padding:"5px 14px",borderRadius:14,fontFamily:"var(--mono)",fontSize:13,fontWeight:700,letterSpacing:1.5,marginBottom:22}}>2026 LISTICLE</div>
          <h1 style={{fontFamily:"var(--ff)",fontSize:42,fontWeight:800,color:"var(--txt)",letterSpacing:-1.2,lineHeight:1.12,marginBottom:16}}>Best PC Builder Tools in 2026: Ranked & Reviewed</h1>
          <p style={{fontFamily:"var(--ff)",fontSize:17,color:"var(--dim)",lineHeight:1.65,maxWidth:940}}>
            We reviewed the four most popular PC builder tools of 2026. Here's how they stack up on features, pricing engines, UX, and business model transparency.
          </p>
        </div>
      </div>

      <div style={{maxWidth:1180,margin:"0 auto",padding:"48px 32px"}}>
        <Para>
          Whether you're building your first PC or upgrading an existing rig, the right tool saves you hours of research and prevents costly compatibility mistakes. We evaluated each of these platforms on four criteria: <strong>feature depth</strong>, <strong>pricing accuracy</strong>, <strong>user experience</strong>, and <strong>business model transparency</strong>.
        </Para>

        <SectionHeading>1. Pro Rig Builder — The Most Feature-Complete</SectionHeading>
        <div style={{background:"var(--card)",border:"1px solid var(--accent)",borderRadius:12,padding:"22px 26px",marginBottom:20}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
            <div style={{fontFamily:"var(--mono)",fontSize:13,color:"var(--accent)",fontWeight:700,letterSpacing:1.5}}>OUR PICK · BEST OVERALL</div>
          </div>
          <Para><strong>Features:</strong> PC Builder · Compatibility Engine · Real-Time Multi-Retailer Pricing · Hardware Scanner App (exclusive) · FPS Estimator (exclusive) · Bottleneck Calculator (exclusive) · Will It Run · USED Flags · Budget Build Wizard · Part Comparison · Power Calculator · Light/Dark Mode</Para>
          <Para><strong>Pricing engine:</strong> Compares across Amazon, Best Buy, Newegg, B&H, Antonline. In-stock prioritization.</Para>
          <Para><strong>Business model:</strong> Affiliate commissions only. <strong>Zero ads.</strong> No paid rankings.</Para>
          <Para><strong>Best for:</strong> Builders who want modern tools, an ad-free experience, and budget-aware upgrade recommendations.</Para>
        </div>

        <SectionHeading>2. PCPartPicker — The Established Community</SectionHeading>
        <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:"22px 26px",marginBottom:20}}>
          <Para><strong>Features:</strong> PC Builder · Compatibility Engine · Real-Time Multi-Retailer Pricing · Large Community Builds Library · Forums</Para>
          <Para><strong>Pricing engine:</strong> Compares across major retailers.</Para>
          <Para><strong>Business model:</strong> Ads + affiliate commissions.</Para>
          <Para><strong>Best for:</strong> Browsing user-submitted completed builds and participating in community forums.</Para>
          <Para><strong>Missing:</strong> Hardware scanner, FPS estimator, bottleneck calc, USED flags, budget-aware recommendations, dark mode.</Para>
        </div>

        <SectionHeading>3. Newegg PC Builder — The Retailer Tool</SectionHeading>
        <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:"22px 26px",marginBottom:20}}>
          <Para><strong>Features:</strong> PC Builder · Compatibility Filtering · AI Build Generation · Combo Bundle Discounts · Build Showcase</Para>
          <Para><strong>Pricing engine:</strong> Newegg inventory only. No comparison with other retailers.</Para>
          <Para><strong>Business model:</strong> Direct retailer — Newegg makes money when you buy through them. Rankings favor Newegg products.</Para>
          <Para><strong>Best for:</strong> Users already committed to shopping at Newegg who want their AI assistant to generate a parts list.</Para>
          <Para><strong>Missing:</strong> Multi-retailer pricing, hardware scanner, performance prediction, USED tracking.</Para>
        </div>

        <SectionHeading>4. Logical Increments — The Static Build Guide</SectionHeading>
        <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:"22px 26px",marginBottom:32}}>
          <Para><strong>Features:</strong> Tiered Build Recommendations (Excellent, Outstanding, Exceptional, etc.) · Manual Updates · Educational Guides</Para>
          <Para><strong>Pricing engine:</strong> None. Links out to Amazon/Newegg with the current page's historical price.</Para>
          <Para><strong>Business model:</strong> Affiliate commissions only.</Para>
          <Para><strong>Best for:</strong> First-time builders who want a curated "just tell me what to buy" tier list without interactive configuration.</Para>
          <Para><strong>Missing:</strong> Interactive builder, live pricing, compatibility engine, modern tools.</Para>
        </div>

        <SectionHeading>Summary Table</SectionHeading>
        <div style={{overflowX:"auto",border:"1px solid var(--bdr)",borderRadius:10,marginBottom:20}}>
          <table style={{width:"100%",borderCollapse:"collapse",minWidth:560}}>
            <thead>
              <tr style={{background:"var(--bg3)",borderBottom:"2px solid var(--bdr)"}}>
                <th style={{textAlign:"left",padding:"10px 14px",fontFamily:"var(--mono)",fontSize:10,fontWeight:700,letterSpacing:1.5,color:"var(--dim)"}}>TOOL</th>
                <th style={{textAlign:"center",padding:"10px 10px",fontFamily:"var(--mono)",fontSize:10,fontWeight:700,letterSpacing:1.5,color:"var(--dim)"}}>FEATURES</th>
                <th style={{textAlign:"center",padding:"10px 10px",fontFamily:"var(--mono)",fontSize:10,fontWeight:700,letterSpacing:1.5,color:"var(--dim)"}}>ADS</th>
                <th style={{textAlign:"center",padding:"10px 10px",fontFamily:"var(--mono)",fontSize:10,fontWeight:700,letterSpacing:1.5,color:"var(--dim)"}}>MULTI-RETAILER</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Pro Rig Builder","12+ tools","Zero","✓ 5 retailers"],
                ["PCPartPicker","5 core","Yes","✓ Many"],
                ["Newegg PC Builder","5 core + AI","Promos","✗ Newegg only"],
                ["Logical Increments","Static","Minimal","Link-outs"]
              ].map((row,i)=>(
                <tr key={i} style={{borderTop:"1px solid var(--bdr)",background:i===0?"var(--accent3)":"transparent"}}>
                  <td style={{padding:"12px 14px",fontFamily:"var(--ff)",fontSize:14,fontWeight:i===0?700:500,color:i===0?"var(--accent)":"var(--txt)"}}>{row[0]}</td>
                  <td style={{padding:"12px 10px",textAlign:"center",fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)"}}>{row[1]}</td>
                  <td style={{padding:"12px 10px",textAlign:"center",fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)"}}>{row[2]}</td>
                  <td style={{padding:"12px 10px",textAlign:"center",fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)"}}>{row[3]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <SectionHeading>Our verdict</SectionHeading>
        <Para>
          For most builders in 2026, <strong>Pro Rig Builder</strong> is the recommendation. It matches PCPartPicker on core building features and adds eight more tools you won't find anywhere else. It's ad-free and transparent about its business model. PCPartPicker remains a solid choice if you primarily want community-submitted builds. Newegg PC Builder is only recommended if you're already committed to shopping at Newegg. Logical Increments is a good starting point for absolute beginners who want a "just tell me what to buy" guide.
        </Para>
      </div>
      <VariantCTA go={go}/>
    </div>
  );
}

function HomePage({go,browse,th}){
  const totalParts=P.length;
  const totalDeals=P.filter(p=>isDeal(p)).length;
  const benchedCount=P.filter(p=>p.bench!=null).length;
  // Featured deals — top 3 by savings, deduped by category
  const featuredDeals=(()=>{const all=P.filter(p=>isDeal(p)).sort((a,b)=>dealSavings(b)-dealSavings(a));const seen=new Set();const out=[];for(const p of all){if(!seen.has(p.c)){seen.add(p.c);out.push(p);if(out.length>=3)break;}}return out;})();
  const updatedDate=new Date().toLocaleDateString('en-US',{weekday:'short',day:'numeric',month:'short',year:'numeric'});

  return <div className="fade">

    {/* === MAGAZINE MASTHEAD STRIP === */}
    <div style={{borderBottom:"1px solid var(--bdr)",padding:"10px 32px",fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:8,maxWidth:1600,margin:"0 auto"}}>
      <span>Updated {updatedDate}</span>
      <span>{totalParts.toLocaleString()} products tracked &middot; {totalDeals} deals live &middot; v3.2.1</span>
    </div>

    {/* === HERO === */}
    <div style={{maxWidth:1600,margin:"0 auto",padding:"64px 32px 32px"}}>
      <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",letterSpacing:"0.04em",textTransform:"uppercase",marginBottom:20}}>Issue No. 01 &mdash; May 2026</div>
      <h1 style={{fontFamily:"var(--ff-display)",fontWeight:600,fontSize:"clamp(40px, 6vw, 72px)",lineHeight:1.02,letterSpacing:"-0.025em",margin:"0 0 20px",color:"var(--txt)",maxWidth:920}}>
        Skip the shop visit.<br/>
        <em style={{fontStyle:"italic",color:"var(--accent)",fontWeight:500}}>Scan, budget, upgrade.</em>
      </h1>
      <p style={{fontFamily:"var(--ff)",fontSize:18,lineHeight:1.5,color:"var(--dim)",maxWidth:640,margin:"0 0 32px"}}>
        The upgrade consultation I run at my repair shop, in a tool anyone can use. Free, no signup.
      </p>
      <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
        <button onClick={()=>go("scanner")} style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:600,padding:"13px 24px",border:"none",cursor:"pointer",background:"var(--accent)",color:"var(--bg)"}}>Download Scanner &rarr;</button>
        <button onClick={()=>go("builder")} style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:500,padding:"13px 24px",cursor:"pointer",background:"transparent",color:"var(--txt)",border:"1px solid var(--bdr2)"}}>Start a PC Build</button>
        <button onClick={()=>go("search")} style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:500,padding:"13px 24px",cursor:"pointer",background:"transparent",color:"var(--txt)",border:"1px solid var(--bdr2)"}}>Browse the catalog</button>
      </div>
    </div>

    {/* === COBY INTRO === */}
    <div style={{maxWidth:1600,margin:"24px auto 56px",padding:"0 32px"}}>
      <div style={{borderTop:"1px solid var(--bdr)",borderBottom:"1px solid var(--bdr)",padding:"28px 0"}}>
          <p style={{fontFamily:"var(--ff)",fontSize:16,lineHeight:1.65,color:"var(--txt)",margin:"0 0 14px"}}>Hi, I'm Coby. I own a computer repair shop and a custom PC brand in Texas.</p>
          <p style={{fontFamily:"var(--ff)",fontSize:16,lineHeight:1.65,color:"var(--txt)",margin:"0 0 14px"}}>The #1 question we get from PC gamers is <em style={{color:"var(--accent)",fontStyle:"italic"}}>"what upgrades can I do?"</em></p>
          <p style={{fontFamily:"var(--ff)",fontSize:16,lineHeight:1.65,color:"var(--txt)",margin:"0 0 14px"}}>So we take the computer in, scan the hardware, check what fits, and build an upgrade path inside their budget.</p>
          <p style={{fontFamily:"var(--ff)",fontSize:16,lineHeight:1.65,color:"var(--txt)",margin:"0 0 14px"}}>I built this site to put that whole process in their hands.</p>
          <p style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",margin:0,fontStyle:"italic"}}>&mdash; Coby, Owner &middot; TieredUp Tech, Inc.</p>
      </div>
    </div>

    {/* === §01 === */}
    <div style={{maxWidth:1600,margin:"0 auto 32px",padding:"0 32px",display:"grid",gridTemplateColumns:"80px 1fr",gap:24}} className="section-grid">
      <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",letterSpacing:"0.04em",textTransform:"uppercase",borderTop:"2px solid var(--txt)",paddingTop:8}}>&sect; 01</div>
      <div>
        <h2 style={{fontFamily:"var(--ff-display)",fontWeight:600,fontSize:28,lineHeight:1.15,letterSpacing:"-0.015em",borderTop:"2px solid var(--txt)",paddingTop:8,margin:"0 0 12px",color:"var(--txt)"}}>Why I built this</h2>
        <p style={{fontFamily:"var(--ff)",fontSize:16,lineHeight:1.65,color:"var(--txt)",margin:"0 0 12px"}}>
          Most people don't want to become PC hardware experts. They just want to know what to do next. Buy a bigger GPU? Upgrade the CPU? Get more RAM? Or is the whole platform too old?
        </p>
        <p style={{fontFamily:"var(--ff)",fontSize:16,lineHeight:1.65,color:"var(--txt)",margin:0}}>Pro Rig Builder answers that. Tell it your specs (or scan them), give it a budget, get a real upgrade path with prices that are actually accurate today.</p>
      </div>
    </div>

    {/* === §02 === */}
    <div style={{maxWidth:1600,margin:"0 auto 32px",padding:"0 32px",display:"grid",gridTemplateColumns:"80px 1fr",gap:24}} className="section-grid">
      <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",letterSpacing:"0.04em",textTransform:"uppercase",borderTop:"2px solid var(--txt)",paddingTop:8}}>&sect; 02</div>
      <div>
        <h2 style={{fontFamily:"var(--ff-display)",fontWeight:600,fontSize:28,lineHeight:1.15,letterSpacing:"-0.015em",borderTop:"2px solid var(--txt)",paddingTop:8,margin:"0 0 12px",color:"var(--txt)"}}>How the scanner works</h2>
        <p style={{fontFamily:"var(--ff)",fontSize:16,lineHeight:1.65,color:"var(--txt)",margin:"0 0 12px"}}>
          The Pro Rig Scanner is a small Windows app. It reads your CPU, GPU, RAM, motherboard, and storage in about 8 seconds. The data comes here, the optimizer figures out the best upgrade path inside your budget &mdash; same logic we use at the shop.
        </p>
        <p style={{fontFamily:"var(--ff)",fontSize:16,lineHeight:1.65,color:"var(--txt)",margin:0}}>No accounts. No email signup. No ads.</p>
      </div>
    </div>

    {/* === §03 === */}
    <div style={{maxWidth:1600,margin:"0 auto 56px",padding:"0 32px",display:"grid",gridTemplateColumns:"80px 1fr",gap:24}} className="section-grid">
      <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",letterSpacing:"0.04em",textTransform:"uppercase",borderTop:"2px solid var(--txt)",paddingTop:8}}>&sect; 03</div>
      <div>
        <h2 style={{fontFamily:"var(--ff-display)",fontWeight:600,fontSize:28,lineHeight:1.15,letterSpacing:"-0.015em",borderTop:"2px solid var(--txt)",paddingTop:8,margin:"0 0 12px",color:"var(--txt)"}}>Where the data comes from</h2>
        <p style={{fontFamily:"var(--ff)",fontSize:16,lineHeight:1.65,color:"var(--txt)",margin:"0 0 12px"}}>
          Bench scores from PassMark. Prices verified daily from Amazon, Best Buy, and Newegg. Catalog updated daily. Compatibility checks actually work &mdash; RAM type, GPU length, PSU power, CPU bottleneck.
        </p>
        <p style={{fontFamily:"var(--ff)",fontSize:16,lineHeight:1.65,color:"var(--txt)",margin:0}}>If something's wrong, <a href="mailto:support@tiereduptech.com" style={{color:"var(--accent)",textDecoration:"underline",textUnderlineOffset:3}}>email me</a>.</p>
      </div>
    </div>

    {/* === THE TOOLS — 2x2 grid === */}
    <div style={{maxWidth:1600,margin:"0 auto 56px",padding:"0 32px"}}>
      <div style={{borderTop:"2px solid var(--txt)",paddingTop:18}}>
        <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",letterSpacing:"0.04em",textTransform:"uppercase",marginBottom:18}}>The tools</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",border:"1px solid var(--bdr)"}} className="tools-grid">
          <button onClick={()=>go("scanner")} style={{padding:"22px 24px",cursor:"pointer",textAlign:"left",border:"none",borderRight:"1px solid var(--bdr)",borderBottom:"1px solid var(--bdr)",background:"var(--bg3)"}}>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:6}}>For unknown rigs</div>
            <div style={{fontFamily:"var(--ff-display)",fontWeight:600,fontSize:20,color:"var(--txt)",marginBottom:6}}>Pro Rig Scanner</div>
            <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",lineHeight:1.5,marginBottom:12}}>8-second hardware read on your Windows PC. Free, code-signed, gets you a custom upgrade path.</div>
            <span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",textDecoration:"underline",textUnderlineOffset:3}}>Download &mdash; Win 10/11 &rarr;</span>
          </button>
          <button onClick={()=>go("upgrade")} style={{padding:"22px 24px",cursor:"pointer",textAlign:"left",border:"none",borderBottom:"1px solid var(--bdr)",background:"var(--bg3)"}}>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:6}}>For known specs</div>
            <div style={{fontFamily:"var(--ff-display)",fontWeight:600,fontSize:20,color:"var(--txt)",marginBottom:6}}>Upgrade Optimizer</div>
            <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",lineHeight:1.5,marginBottom:12}}>Already know your hardware? Type it in, set a budget, get a recommended path.</div>
            <span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",textDecoration:"underline",textUnderlineOffset:3}}>Open optimizer &rarr;</span>
          </button>
          <button onClick={()=>go("builder")} style={{padding:"22px 24px",cursor:"pointer",textAlign:"left",border:"none",borderRight:"1px solid var(--bdr)",background:"var(--bg2)"}}>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:6}}>Building from scratch</div>
            <div style={{fontFamily:"var(--ff-display)",fontWeight:600,fontSize:20,color:"var(--txt)",marginBottom:6}}>PC Builder</div>
            <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",lineHeight:1.5,marginBottom:12}}>Pick parts, see live compatibility warnings and total power draw. Compatibility checks that actually catch real problems.</div>
            <span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",textDecoration:"underline",textUnderlineOffset:3}}>Start a build &rarr;</span>
          </button>
          <button onClick={()=>go("search")} style={{padding:"22px 24px",cursor:"pointer",textAlign:"left",border:"none",background:"var(--bg2)"}}>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:6}}>Just browsing</div>
            <div style={{fontFamily:"var(--ff-display)",fontWeight:600,fontSize:20,color:"var(--txt)",marginBottom:6}}>Browse Catalog</div>
            <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",lineHeight:1.5,marginBottom:12}}>{totalParts.toLocaleString()} products with verified prices and PassMark benches. Sort, filter, compare.</div>
            <span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",textDecoration:"underline",textUnderlineOffset:3}}>Browse parts &rarr;</span>
          </button>
        </div>
      </div>
    </div>

    {/* === BY THE NUMBERS === */}
    <div style={{maxWidth:1600,margin:"0 auto 32px",padding:"0 32px"}}>
      <div style={{borderTop:"2px solid var(--txt)",paddingTop:18}}>
        <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",letterSpacing:"0.04em",textTransform:"uppercase",marginBottom:14}}>By the numbers</div>
        <div style={{fontFamily:"var(--ff)",color:"var(--txt)",lineHeight:1.6,fontSize:16,maxWidth:900}}>
          <p style={{margin:"0 0 8px"}}>As of <strong style={{fontWeight:600}}>{updatedDate}</strong> the catalog tracks <strong style={{fontWeight:600}}>{totalParts.toLocaleString()} products</strong> across {CATS.length} categories. <strong style={{fontWeight:600}}>{benchedCount.toLocaleString()}</strong> CPUs, GPUs, and storage drives have PassMark bench scores. We verify ASIN data daily through Amazon's catalog and refresh prices every 48 hours.</p>
          <p style={{margin:0}}>If a price looks wrong, <a href="mailto:support@tiereduptech.com" style={{color:"var(--accent)",textDecoration:"underline",textUnderlineOffset:3}}>tell me</a>. I read every email.</p>
        </div>
      </div>
    </div>

    {/* === THIS WEEK'S DEALS === */}
    {featuredDeals.length>0&&<div style={{maxWidth:1600,margin:"0 auto 56px",padding:"0 32px"}}>
      <div style={{borderTop:"2px solid var(--txt)",paddingTop:18}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:18}}>
          <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",letterSpacing:"0.04em",textTransform:"uppercase"}}>This week's deals</div>
          <button onClick={()=>go("search")} style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",background:"none",border:"none",cursor:"pointer",textDecoration:"underline",textUnderlineOffset:3}}>See all {totalDeals} deals &rarr;</button>
        </div>
        <div style={{border:"1px solid var(--bdr)"}}>
          {featuredDeals.map((p,i)=>{
            const savings=dealSavings(p);
            const price=$(p);
            return <button key={p.id} onClick={()=>go("product/"+p.id)} style={{display:"grid",gridTemplateColumns:"60px 1fr auto",gap:16,padding:"16px 20px",width:"100%",cursor:"pointer",textAlign:"left",border:"none",background:i%2===0?"var(--bg2)":"transparent",borderBottom:i<featuredDeals.length-1?"1px solid var(--bdr)":"none",alignItems:"center"}}>
              <div style={{width:60,height:60,background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden"}}>{p.img?<img src={p.img} alt={p.n} style={{maxWidth:"100%",maxHeight:"100%",objectFit:"contain"}}/>:<span style={{fontSize:22}}>{CAT[p.c]?.icon||'?'}</span>}</div>
              <div style={{minWidth:0}}>
                <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:4}}>{p.c} &middot; {resolveBrand(p)}</div>
                <div style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:500,color:"var(--txt)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.n}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontFamily:"var(--ff-display)",fontSize:22,fontWeight:600,color:"var(--accent)",letterSpacing:"-0.02em",lineHeight:1}}>{"$"+price.toLocaleString()}</div>
                <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",textDecoration:"line-through",marginTop:2}}>{"$"+p.msrp}</div>
                <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",marginTop:2,fontWeight:600}}>Save {"$"+savings.toLocaleString()}</div>
              </div>
            </button>;
          })}
        </div>
      </div>
    </div>}

    <style>{`
      @media (max-width: 720px) {
        .intro-grid { grid-template-columns: 1fr !important; gap: 24px !important; }
        .section-grid { grid-template-columns: 1fr !important; gap: 12px !important; }
        .tools-grid { grid-template-columns: 1fr !important; }
        .tools-grid > button { border-right: none !important; }
      }
    `}</style>

  </div>;
}

/* ═══ SEARCH PAGE ═══ */

/* === SMART SEARCH === */
// Build a search blob from a product: name, brand, and relevant spec fields
function buildSearchBlob(p) {
  const parts = [
    p.n || '',
    p.b || '',
    p.fullTitle || '',
    p.model || '',
    p.asin || '',
    p.mpn || '',
    // CPU specs
    p.socket || '', p.arch || '', p.memType || '',
    p.cores != null ? p.cores + 'core ' + p.cores + 'c' : '',
    p.threads != null ? p.threads + 'thread ' + p.threads + 't' : '',
    // GPU specs
    p.vram != null ? p.vram + 'gb' : '',
    // RAM specs
    p.cap != null ? p.cap + 'gb' : '',
    p.speed != null ? p.speed + 'mhz ' + p.speed : '',
    p.cl != null ? 'cl' + p.cl : '',
    p.sticks != null ? p.sticks + 'x ' + p.sticks + 'stick' : '',
    // Storage
    p.storageType || '', p.interface || '',
    p.ff || '',
    // Mobo
    p.chipset || '',
    // PSU
    p.watts != null ? p.watts + 'w ' + p.watts + 'watt' : '',
    p.eff || '',
    // Monitor
    p.res || '', p.refresh != null ? p.refresh + 'hz' : '',
    p.panel || '',
  ];
  return parts.join(' ').toLowerCase();
}

// Synonyms: query token -> alternate(s). Both directions.
const SEARCH_SYNONYMS = {
  'ram': 'memory',
  'memory': 'ram',
  'gpu': 'graphics card video',
  'graphics': 'gpu video',
  'video': 'gpu graphics',
  'cpu': 'processor',
  'processor': 'cpu',
  'mobo': 'motherboard',
  'motherboard': 'mobo',
  'psu': 'power supply',
  'ssd': 'solid state nvme',
  'hdd': 'hard drive',
  'mhz': 'mhz',
};

// Match a single token against the blob, with synonym fallback
function tokenMatches(token, blob) {
  // SHORT-TOKEN word-boundary fix: a 1-3 char token containing a letter
  // (e.g. "ti", "xt", "kf") must match a whole word or a digit-glued form
  // like "5070ti" — never a substring buried inside another word.
  const hasLetter = /[a-z]/i.test(token);
  const matchOne = (t) => {
    if (!t) return false;
    if (t.length <= 3 && /[a-z]/i.test(t)) {
      // whole-word match, allowing the token to be glued to digits
      const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp("(^|[^a-z0-9])\\d*" + esc + "\\d*([^a-z0-9]|$)", "i");
      return re.test(blob);
    }
    return blob.includes(t);
  };
  // Also normalize a digit+letter glued query token ("5070ti") so it can
  // match a spaced blob ("5070 ti"): split into the run pieces and require all.
  const glued = token.match(/^(\d+)([a-z].*)$/i);
  if (glued) {
    if (matchOne(token)) return true;
    if (blob.includes(glued[1]) && matchOne(glued[2])) return true;
  } else if (matchOne(token)) {
    return true;
  }
  const syn = SEARCH_SYNONYMS[token];
  if (syn) {
    for (const alt of syn.split(" ")) {
      if (matchOne(alt)) return true;
    }
  }
  return false;
}

// Main smart match: returns true if all tokens in query match the product
function smartMatch(p, query) {
  if (!query) return true;
  const blob = buildSearchBlob(p);
  // Split query on whitespace, dashes, commas, slashes, parens
  const tokens = query.toLowerCase().split(/[\s\-,\/\(\)]+/).filter(Boolean);
  if (tokens.length === 0) return true;
  // Every token must match somewhere
  return tokens.every(t => tokenMatches(t, blob));
}
/* === END SMART SEARCH === */

/* === BRAND RESOLVER === */
// For CPUs, derives real CPU brand (Intel/AMD) from product name
// even when seller brand (b field) is something like "Micro Center" or "INLAND"
function resolveBrand(p) {
  if (!p) return '';
  if (p.c !== 'CPU') return p.b || '';
  // If already Intel or AMD, use it
  if (p.b === 'Intel' || p.b === 'AMD') return p.b;
  // Parse name for CPU brand markers
  const n = (p.n || '').toLowerCase();
  if (/\bintel\b|\bcore\s*(ultra\s*)?i[3579]|\bxeon\b|\bpentium\b|\bceleron\b/i.test(n)) return 'Intel';
  if (/\bamd\b|\bryzen\b|\bthreadripper\b|\bepyc\b|\bathlon\b/i.test(n)) return 'AMD';
  return p.b || '';
}
/* === END BRAND RESOLVER === */

/* === CATEGORY GUIDES === */
const CATEGORY_GUIDES = {
  CPU: {
    title: "How to pick a processor",
    look: ["Socket must match your motherboard (AM5 for new AMD, LGA1851 for new Intel)", "Core count and clock speed for performance", "TDP (wattage) affects cooling needs"],
    tip: "Budget builds: under $200. Mainstream gaming: $250-$400. Enthusiast: $500+"
  },
  GPU: {
    title: "How to pick a graphics card",
    look: ["VRAM (8GB minimum for 1080p, 12GB+ for 1440p/4K)", "Card length must fit your case", "Power connector and PSU wattage requirements"],
    tip: "1080p gaming: $250-$400. 1440p gaming: $500-$800. 4K gaming: $900+"
  },
  Motherboard: {
    title: "How to pick a motherboard",
    look: ["Socket matches your CPU (AM5, LGA1851, etc.)", "Form factor fits your case (ATX, mATX, ITX)", "RAM type (DDR4 or DDR5) and slot count"],
    tip: "Budget: $100-$150. Mid-range: $180-$280. High-end: $300+ with WiFi, PCIe 5.0"
  },
  RAM: {
    title: "How to pick memory",
    look: ["Must match your motherboard type (DDR4 or DDR5)", "16GB minimum for gaming, 32GB for content creation", "Higher speed (MT/s) = better performance, especially for AMD"],
    tip: "Look for kits in 2 sticks (e.g. 2x8GB, 2x16GB) for dual-channel performance"
  },
  Storage: {
    title: "How to pick storage",
    look: ["NVMe SSD for OS and games (fastest)", "SATA SSD for budget storage", "HDD for mass storage (photos, videos) at low cost"],
    tip: "Minimum 1TB NVMe for gaming. Add a 2TB+ HDD for media if needed"
  },
  PSU: {
    title: "How to pick a power supply",
    look: ["Wattage exceeds total system draw by 20-30% headroom", "80+ Gold or higher for efficiency", "Modular cables reduce clutter in your case"],
    tip: "Mid-range builds: 650-750W. High-end with RTX 4080+: 850W-1000W+"
  },
  Case: {
    title: "How to pick a case",
    look: ["Matches your motherboard form factor", "GPU clearance length for your graphics card", "CPU cooler height clearance"],
    tip: "Airflow matters more than looks. Look for mesh front panels and 3+ included fans"
  },
  CPUCooler: {
    title: "How to pick a CPU cooler",
    look: ["TDP rating must exceed your CPU's TDP", "Socket compatibility (AM5, LGA1851, etc.)", "Fits within your case's cooler height limit"],
    tip: "Air coolers are reliable and quiet. AIO liquid coolers handle high-TDP CPUs best"
  },
  CaseFan: {
    title: "How to pick case fans",
    look: ["120mm most common, 140mm moves more air quieter", "Higher CFM = more airflow, higher dBA = more noise", "Static pressure fans for radiators, airflow fans for cases"],
    tip: "Two intake + one exhaust is a solid baseline for positive pressure"
  },
  SoundCard: {
    title: "How to pick a sound card",
    look: ["SNR (signal-to-noise ratio) higher is cleaner", "Sample rate and bit depth for audio fidelity", "Headphone amp if you use high-impedance headphones"],
    tip: "Most gamers don't need one — onboard audio is fine. Audiophiles benefit most"
  },
  EthernetCard: {
    title: "How to pick an Ethernet adapter",
    look: ["Speed (2.5GbE is mainstream, 10GbE for pro users)", "Chipset quality (Intel and Aquantia preferred)", "PCIe lane requirements match your motherboard"],
    tip: "Upgrade only if your ISP or network supports faster-than-1GbE speeds"
  },
  WiFiCard: {
    title: "How to pick a WiFi adapter",
    look: ["WiFi 6E or WiFi 7 for future-proof speeds", "Bluetooth version (5.3+ is current)", "Antenna count affects range and speed"],
    tip: "WiFi 6E handles most users. WiFi 7 only matters if your router supports it"
  },
  OpticalDrive: {
    title: "How to pick an optical drive",
    look: ["Blu-ray vs DVD based on media you use", "Internal SATA or external USB", "Read/write speeds for burning discs"],
    tip: "Most builds skip optical drives. Only needed for physical media or backups"
  },
  OS: {
    title: "How to pick an operating system",
    look: ["Windows 11 Home for most users", "Windows 11 Pro for BitLocker and Remote Desktop", "Linux is free but requires more setup"],
    tip: "OEM Windows licenses are cheaper than retail and work fine for home builds"
  },
  InternalDisplay: {
    title: "Internal case displays",
    look: ["Screen size fits your case panel or mount", "Connection type (USB, HDMI)", "Panel type and touchscreen support"],
    tip: "Pairs well with monitoring software for a personalized build aesthetic"
  },
  Monitor: {
    title: "How to pick a monitor",
    look: ["Resolution (1080p, 1440p, 4K) matches your GPU", "Refresh rate (120Hz+ for gaming)", "Panel type (IPS for color, VA for contrast, OLED for best image)"],
    tip: "Sweet spot 2026: 27-inch 1440p 165Hz IPS. Under $300 for great quality"
  },
  Keyboard: {
    title: "How to pick a keyboard",
    look: ["Switch type (linear for gaming, tactile for typing)", "Layout (full-size, TKL, 60%, 75%)", "Wired or wireless with battery life"],
    tip: "Try switches in person if possible. Hot-swappable boards let you change later"
  },
  Mouse: {
    title: "How to pick a mouse",
    look: ["Sensor DPI and accuracy for precision", "Weight (lighter for fast games, heavier for MMOs)", "Wired vs wireless (wireless is now tournament-grade)"],
    tip: "Shape matters most. Borrow a friend's before buying to test grip"
  },
  Headset: {
    title: "How to pick a headset",
    look: ["Wired for best latency, wireless for freedom", "Open-back for immersion, closed for isolation", "Mic quality if you game online"],
    tip: "Combo gaming headsets are convenient. Audiophile headphones + standalone mic sounds better"
  },
  Webcam: {
    title: "How to pick a webcam",
    look: ["Resolution (1080p minimum, 4K for streaming)", "Autofocus and low-light performance", "Field of view (wider for multiple people)"],
    tip: "Upgrade priority: lighting and mic > camera resolution for most video calls"
  }
};

function CategoryGuide({ cat }) {
  const g = CATEGORY_GUIDES[cat];
  if (!g) return null;
  return (
    <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:"14px 16px",marginBottom:16}}>
      <div style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:"var(--accent)",marginBottom:8,display:"flex",alignItems:"center",gap:6}}>
        <span style={{fontSize:15}}>💡</span> {g.title}
      </div>
      <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)",lineHeight:1.6,marginBottom:8}}>
        What to look for:
      </div>
      <ul style={{margin:0,paddingLeft:18,fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",lineHeight:1.7}}>
        {g.look.map((item, i) => <li key={i} style={{marginBottom:2}}>{item}</li>)}
      </ul>
      <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--mint)",marginTop:10,paddingTop:8,borderTop:"1px solid var(--bdr)",fontWeight:500}}>
        💰 {g.tip}
      </div>
    </div>
  );
}
/* === END CATEGORY GUIDES === */

// === MOBILE SEARCH PAGE ===
function MobileSearchPage({activeCat,initialQuery,th}){
  const [cat,setCat]=useState(activeCat||"");
  const [q,setQ]=useState(initialQuery||"");
  const [histOpen,setHistOpen]=useState(null);
  const [brands,setBrands]=useState([]);
  const [marketplaces,setMarketplaces]=useState([]);
  const [maxPr,setMaxPr]=useState(5000);
  const [minPr,setMinPr]=useState(0);
  const [minR,setMinR]=useState(0);
  const [sort,setSort]=useState("price-asc");
  const [expanded,setExpanded]=useState(null);
  const [filtersOpen,setFiltersOpen]=useState(false);
  useEffect(()=>{if(activeCat)setCat(activeCat);},[activeCat]);
  useEffect(()=>{if(initialQuery)setQ(initialQuery);},[initialQuery]);

  const catP=cat?P.filter(p=>p.c===cat):P;
  const allBr=[...new Set(catP.map(p=>resolveBrand(p)).filter(Boolean))].sort();
  const allMarkets=[...new Set(catP.flatMap(p=>p.deals&&typeof p.deals==="object"?Object.keys(p.deals).filter(k=>p.deals[k]&&typeof p.deals[k]==="object"&&p.deals[k].price).map(marketplaceGroupOf):[]))].sort();
  const prMx=Math.max(...catP.map(p=>$(p)),100);

  const list=useMemo(()=>{
    let r=catP;
    if(q)r=r.filter(p=>smartMatch(p,q));
    if(brands.length)r=r.filter(p=>brands.includes(resolveBrand(p)));
    if(marketplaces.length)r=r.filter(p=>p.deals&&typeof p.deals==="object"&&marketplaces.some(m=>expandMarketplaceGroup(m).some(rk=>p.deals[rk]&&typeof p.deals[rk]==="object"&&p.deals[rk].price)));
    r=r.filter(p=>$(p)<=maxPr&&$(p)>=minPr);
    if(minR)r=r.filter(p=>p.r>=minR);
    const [sk,sd]=sort.split("-");
    r=[...r].sort((a,b)=>{
      const va=sk==="price"?$(a):sk==="rating"?a.r:sk==="value"?(a.value!=null?a.value:valueRatio(a)):(a.bench||0);
      const vb=sk==="price"?$(b):sk==="rating"?b.r:sk==="value"?(b.value!=null?b.value:valueRatio(b)):(b.bench||0);
      return sd==="asc"?va-vb:vb-va;
    });
    return r;
  },[cat,q,brands,marketplaces,maxPr,minPr,minR,sort]);

  const ac=[brands.length,marketplaces.length,minR,maxPr<prMx,minPr>0].filter(Boolean).length;
  const clearFilters=()=>{setBrands([]);setMarketplaces([]);setMaxPr(5000);setMinPr(0);setMinR(0);};

  // Category picker
  if(!cat){
    return <div className="fade" style={{padding:"16px 14px",maxWidth:"100vw",overflow:"hidden"}}>
      <h1 style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--txt)",marginBottom:6}}>Browse Parts</h1>
      <p style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--dim)",marginBottom:18}}>Pick a category</p>
      <div style={{display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:10}}>
        {CATS.map(c=>{
          const meta=CAT[c];
          const count=P.filter(p=>p.c===c).length;
          return <button key={c} onClick={()=>setCat(c)} style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:"14px 12px",cursor:"pointer",textAlign:"left",display:"flex",flexDirection:"column",gap:6,minWidth:0}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <CatThumb cat={c} thumbs={th.thumbs} setThumb={th.setThumb} removeThumb={th.removeThumb} size={32} rounded={6} editable={false}/>
              <span style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:"var(--txt)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1,minWidth:0}}>{meta.label}</span>
            </div>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",fontWeight:600}}>{count} products</div>
          </button>;
        })}
      </div>
    </div>;
  }

  // Product list
  return <div className="fade" style={{padding:"12px 12px 80px",maxWidth:"100vw",overflow:"hidden"}}>
    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10,flexWrap:"wrap"}}>
      <button onClick={()=>setCat("")} style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",background:"none",border:"none",cursor:"pointer",padding:0}}>← All</button>
      <span style={{color:"var(--mute)"}}>/</span>
      <span style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--accent)",fontWeight:700}}>{CAT[cat].label}</span>
      <span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",marginLeft:"auto"}}>{list.length}</span>
    </div>

    <div style={{position:"relative",marginBottom:10}}>
      <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:15,color:"var(--mute)"}}>🔍</span>
      <input value={q} onChange={e=>setQ(e.target.value)} placeholder={"Search "+CAT[cat].label.toLowerCase()} style={{width:"100%",background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:8,padding:"10px 10px 10px 34px",fontSize:15,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none",boxSizing:"border-box"}}/>
      {q&&<button onClick={()=>setQ("")} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"var(--dim)",fontSize:15,cursor:"pointer"}}>✕</button>}
    </div>

    <div style={{display:"flex",gap:8,marginBottom:14}}>
      <button onClick={()=>setFiltersOpen(true)} style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,background:ac>0?"var(--accent3)":"var(--bg3)",border:"1px solid "+(ac>0?"var(--accent)":"var(--bdr)"),borderRadius:8,padding:"10px",fontFamily:"var(--ff)",fontSize:14,fontWeight:600,color:ac>0?"var(--accent)":"var(--txt)",cursor:"pointer"}}>
        ⚙ Filters{ac>0?" ("+ac+")":""}
      </button>
      <select value={sort} onChange={e=>setSort(e.target.value)} style={{flex:1,background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:8,padding:"10px",fontSize:14,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none",cursor:"pointer"}}>
        <option value="price-asc">Price ↑</option>
        <option value="price-desc">Price ↓</option>
        <option value="rating-desc">Top Rated</option>
        <option value="bench-desc">Performance</option>
        <option value="value-desc">Best Value</option>
      </select>
    </div>

    {list.length===0&&<div style={{textAlign:"center",padding:"48px 16px",color:"var(--dim)",fontFamily:"var(--ff)",fontSize:15}}>No products match your filters</div>}
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {list.map(p=>{
        const isExp=expanded===p.id;
        const rr=retailers(p);
        return <div key={p.id} style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,overflow:"hidden",maxWidth:"100%"}}>
          {isExp&&<ProductSchema p={p}/>}
          <div onClick={()=>setExpanded(isExp?null:p.id)} style={{display:"flex",gap:12,padding:12,cursor:"pointer",minWidth:0}}>
            {p.img?<img loading="lazy" decoding="async" src={p.img} alt={`${p.n}${p.c ? ' ' + p.c : ''}`} style={{width:72,height:72,objectFit:"contain",borderRadius:8,background:"#fff",flexShrink:0}}/>:<div style={{width:72,height:72,background:"var(--bg4)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,flexShrink:0}}>{ic(p)}</div>}
            <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column",gap:4}}>
              <div style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:600,color:"var(--txt)",lineHeight:1.3,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{p.n}</div>
              <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                <span style={{fontSize:13,color:"var(--dim)",fontFamily:"var(--ff)"}}>{p.b}</span>
                {p.r&&<Stars r={p.r} s={10}/>}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                {isDeal(p)&&<span style={{display:"inline-flex",alignItems:"center",gap:3,background:"linear-gradient(90deg,#FF6B35,#F5A623)",color:"#fff",fontSize:13,fontWeight:800,padding:"3px 10px",borderRadius:4,fontFamily:"var(--mono)",letterSpacing:0.5,textShadow:"0 1px 2px rgba(0,0,0,0.2)"}}>🔥 DEAL -${dealSavings(p)}</span>}
                {(p.used===true||p.condition==="used")&&<Tag color="#F59E0B">USED</Tag>}
                {p.condition==="refurbished"&&<Tag color="var(--sky)">REFURB</Tag>}
                {p.condition==="open-box"&&<Tag color="var(--violet)">OPEN BOX</Tag>}
                {p.bundle&&<Tag color="var(--amber)">BUNDLE</Tag>}
              </div>
              <div style={{display:"flex",alignItems:"baseline",gap:8,marginTop:2}}>
                <span style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--mint)"}}>${fmtPrice($(p))}</span>
                {p.msrp&&p.msrp>$(p)&&<span style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--mute)",textDecoration:"line-through"}}>${fmtPrice(p.msrp)}</span>}
              </div>
            </div>
            <div style={{display:"flex",alignItems:"center",color:"var(--dim)",fontSize:22,transition:"transform .2s",transform:isExp?"rotate(90deg)":"none"}}>›</div>
          </div>

          {isExp&&<div style={{padding:"0 12px 14px",borderTop:"1px solid var(--bdr)"}}>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",fontWeight:700,letterSpacing:1,margin:"12px 0 8px"}}>BUY AT</div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {rr.length>0?rr.map((r,ri)=>{const histKey=p.id+":"+r.name;const histOpenHere=histOpen===histKey;return <React.Fragment key={r.name}>
                <a key={r.name} href={r.url} target="_blank" rel="noopener noreferrer" style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:8,textDecoration:"none",background:ri===0?"var(--mint3)":"var(--bg3)",border:"1px solid "+(ri===0?"var(--mint)33":"var(--bdr)")}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
                      <span style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:"var(--txt)"}}>{r.displayName}</span>
                      {ri===0&&rr.length>1&&<Tag color="var(--mint)">BEST</Tag>}
                    </div>
                    <div style={{fontFamily:"var(--ff)",fontSize:10,color:r.inStock?"var(--sky)":"var(--rose)"}}>{r.inStock?"✓ In Stock":"✗ Out of Stock"}</div>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                    <span style={{fontFamily:"var(--ff)",fontSize:17,fontWeight:800,color:ri===0?"var(--mint)":"var(--txt)"}}>${fmtPrice(r.price)}</span>
                    <div style={{background:ri===0?"var(--mint)":"var(--bg4)",borderRadius:6,padding:"6px 12px",fontFamily:"var(--ff)",fontSize:13,fontWeight:700,color:ri===0?"var(--bg)":"var(--txt)"}}>Buy</div>
                  </div>
                </a>
                <button onClick={()=>setHistOpen(histOpenHere?null:histKey)} style={{display:"flex",alignItems:"center",gap:5,background:"none",border:"none",cursor:"pointer",fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",letterSpacing:"0.04em",textTransform:"uppercase",padding:"3px 12px"}}>{histOpenHere?"\u25b2 Hide price history":"\u25bc 90-day price history"}</button>
                {histOpenHere&&<div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:8,marginBottom:4}}><PriceHistoryChart product={p} retailer={r.name}/></div>}
                </React.Fragment>;})
              :<a href={p.deals?.amazon?.url||"#"} target="_blank" rel="noopener noreferrer" style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 12px",borderRadius:8,background:"var(--mint3)",border:"1px solid var(--mint)33",textDecoration:"none"}}>
                <div>
                  <span style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:"var(--txt)"}}>Amazon</span>
                  <div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--sky)"}}>✓ In Stock</div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontFamily:"var(--ff)",fontSize:17,fontWeight:800,color:"var(--mint)"}}>${fmtPrice($(p))}</span>
                  <div style={{background:"var(--mint)",borderRadius:6,padding:"6px 12px",fontFamily:"var(--ff)",fontSize:13,fontWeight:700,color:"var(--bg)"}}>Buy</div>
                </div>
              </a>}
            </div>

            {CAT[cat]?.cols?.length>0&&<div style={{marginTop:14}}>
              <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",fontWeight:700,letterSpacing:1,marginBottom:8}}>KEY SPECS</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 12px"}}>
                {CAT[cat].cols.map(col=>{
                  const v=p[col];if(v==null)return null;
                  const fv=fmt(col,v,p);
                  return <div key={col} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:"1px solid var(--bdr)",gap:8,minWidth:0}}>
                    <span style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{SL[col]||col}</span>
                    <span style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)",fontWeight:600,textAlign:"right",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{col==="bench"?v+"%":fv}</span>
                  </div>;
                })}
              </div>
            </div>}
          </div>}
        </div>;
      })}
    </div>

    {filtersOpen&&<div onClick={()=>setFiltersOpen(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:1000,display:"flex",alignItems:"flex-end"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:"var(--bg2)",width:"100%",maxHeight:"85vh",overflowY:"auto",borderTopLeftRadius:16,borderTopRightRadius:16,padding:"16px 16px 32px",boxSizing:"border-box"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,position:"sticky",top:0,background:"var(--bg2)",paddingBottom:8,borderBottom:"1px solid var(--bdr)"}}>
          <span style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--txt)"}}>Filters</span>
          <div style={{display:"flex",gap:10}}>
            {ac>0&&<button onClick={clearFilters} style={{background:"none",border:"none",color:"var(--rose)",fontFamily:"var(--ff)",fontSize:14,cursor:"pointer",padding:0}}>Clear</button>}
            <button onClick={()=>setFiltersOpen(false)} style={{background:"var(--accent)",border:"none",color:"#fff",fontFamily:"var(--ff)",fontSize:14,fontWeight:700,padding:"6px 16px",borderRadius:6,cursor:"pointer"}}>Done</button>
          </div>
        </div>

        <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mint)",fontWeight:700,letterSpacing:1,marginBottom:6}}>PRICE RANGE</div>
        <div style={{display:"flex",gap:8,marginBottom:8}}>
          <input type="number" value={minPr||""} onChange={e=>setMinPr(+e.target.value||0)} placeholder="Min $" style={{flex:1,background:"var(--bg4)",border:"1px solid var(--bdr)",borderRadius:6,padding:"8px 10px",fontSize:14,color:"var(--txt)",fontFamily:"var(--mono)",outline:"none",boxSizing:"border-box"}}/>
          <input type="number" value={maxPr>=5000?"":maxPr} onChange={e=>setMaxPr(+e.target.value||5000)} placeholder="Max $" style={{flex:1,background:"var(--bg4)",border:"1px solid var(--bdr)",borderRadius:6,padding:"8px 10px",fontSize:14,color:"var(--txt)",fontFamily:"var(--mono)",outline:"none",boxSizing:"border-box"}}/>
        </div>
        <input type="range" min={0} max={Math.ceil(prMx/50)*50} value={Math.min(maxPr,Math.ceil(prMx/50)*50)} onChange={e=>setMaxPr(+e.target.value)} style={{width:"100%",marginBottom:4}}/>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:16}}>
          <span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mute)"}}>${minPr}</span>
          <span style={{fontFamily:"var(--mono)",fontSize:13,color:"var(--mint)",fontWeight:600}}>to ${maxPr>=5000?"∞":"$"+maxPr}</span>
        </div>

        {allBr.length>0&&<div style={{marginBottom:16}}>
          <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mint)",fontWeight:700,letterSpacing:1,marginBottom:8}}>BRAND</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            {allBr.map(b=>{
              const on=brands.includes(b);
              return <button key={b} onClick={()=>setBrands(p=>p.includes(b)?p.filter(x=>x!==b):[...p,b])} style={{background:on?"var(--accent3)":"var(--bg3)",border:"1px solid "+(on?"var(--accent)":"var(--bdr)"),borderRadius:18,padding:"6px 12px",fontFamily:"var(--ff)",fontSize:13,color:on?"var(--accent)":"var(--txt)",fontWeight:on?600:400,cursor:"pointer"}}>{b} <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--mute)",marginLeft:2}}>{catP.filter(p=>resolveBrand(p)===b).length}</span></button>;
            })}
          </div>
        </div>}

        {allMarkets.length>0&&<div style={{marginBottom:16}}>
          <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mint)",fontWeight:700,letterSpacing:1,marginBottom:8}}>MARKETPLACE</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            {allMarkets.map(m=>{
              const cap=retailerDisplayName(m);
              const on=marketplaces.includes(m);
              return <button key={m} onClick={()=>setMarketplaces(p=>p.includes(m)?p.filter(x=>x!==m):[...p,m])} style={{background:on?"var(--accent3)":"var(--bg3)",border:"1px solid "+(on?"var(--accent)":"var(--bdr)"),borderRadius:18,padding:"6px 12px",fontFamily:"var(--ff)",fontSize:13,color:on?"var(--accent)":"var(--txt)",fontWeight:on?600:400,cursor:"pointer"}}>{cap}</button>;
            })}
          </div>
        </div>}

        <div style={{marginBottom:16}}>
          <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mint)",fontWeight:700,letterSpacing:1,marginBottom:8}}>MIN RATING</div>
          <div style={{display:"flex",gap:6}}>
            {[0,4,4.5].map(rv=>{
              const on=minR===rv;
              return <button key={rv} onClick={()=>setMinR(rv)} style={{flex:1,background:on?"var(--accent3)":"var(--bg3)",border:"1px solid "+(on?"var(--accent)":"var(--bdr)"),borderRadius:8,padding:"8px",fontFamily:"var(--ff)",fontSize:13,color:on?"var(--accent)":"var(--txt)",fontWeight:on?600:400,cursor:"pointer"}}>{rv?rv+"+ ★":"Any"}</button>;
            })}
          </div>
        </div>

        <button onClick={()=>setFiltersOpen(false)} style={{width:"100%",background:"var(--accent)",border:"none",color:"#fff",fontFamily:"var(--ff)",fontSize:15,fontWeight:700,padding:"14px",borderRadius:8,cursor:"pointer"}}>Show {list.length} results</button>
      </div>
    </div>}
  </div>;
}

// === RESPONSIVE ROUTER ===
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
function SearchPage({activeCat,initialQuery,th}){
  const [cat,setCat]=useState(activeCat||"");const [q,setQ]=useState(initialQuery||"");const [brands,setBrands]=useState([]);const [marketplaces,setMarketplaces]=useState([]);const [conditions,setConditions]=useState([]);const [histOpen,setHistOpen]=useState(null);
  const [viewMode,setViewMode]=useState(()=>{try{return localStorage.getItem("rigfinder_view_mode")||"row";}catch{return "row";}});
  const setViewModeP=v=>{setViewMode(v);try{localStorage.setItem("rigfinder_view_mode",v);}catch{}};const [maxPr,setMaxPr]=useState(5000);const [minPr,setMinPr]=useState(0);const [minR,setMinR]=useState(0);const [cpO,setCpO]=useState(false);const [sf,setSf]=useState({});const [sort,setSort]=useState("price-asc");
  const [expanded,setExpanded]=useState(null);
  const [showAll,setShowAll]=useState({});
  useEffect(()=>{if(activeCat)setCat(activeCat);},[activeCat]);
  useEffect(()=>{if(initialQuery)setQ(initialQuery);},[initialQuery]);
  const sel=c=>{setCat(c);setBrands([]);setMarketplaces([]);setConditions([]);setSf({});setQ("");setMaxPr(5000);setMinPr(0);setMinR(0);setCpO(false);};
  const catP=cat?P.filter(p=>p.c===cat):P;const allBr=[...new Set(catP.map(p=>resolveBrand(p)).filter(Boolean))].sort();const allMarkets=[...new Set(catP.flatMap(p=>p.deals&&typeof p.deals==="object"?Object.keys(p.deals).filter(k=>p.deals[k]&&typeof p.deals[k]==="object"&&p.deals[k].price).map(marketplaceGroupOf):[]))].sort();const cols=cat?(CAT[cat]?.cols||[]):[];const prMx=Math.max(...catP.map(p=>$(p)),100);
  const togSf=(col,val)=>setSf(pv=>{const c=pv[col]||[];return{...pv,[col]:c.includes(val)?c.filter(v=>v!==val):[...c,val]};});
  const list=useMemo(()=>{let r=catP;if(q)r=r.filter(p=>smartMatch(p,q));if(brands.length)r=r.filter(p=>brands.includes(resolveBrand(p)));if(marketplaces.length)r=r.filter(p=>p.deals&&typeof p.deals==="object"&&marketplaces.some(m=>expandMarketplaceGroup(m).some(rk=>p.deals[rk]&&typeof p.deals[rk]==="object"&&p.deals[rk].price)));if(conditions.length)r=r.filter(p=>{const pc=productConditions(p);return conditions.some(c=>pc.includes(c));});r=r.filter(p=>$(p)<=maxPr&&$(p)>=minPr);if(minR)r=r.filter(p=>p.r>=minR);if(cpO)r=r.filter(p=>p.cp);Object.entries(sf).forEach(([key,vals])=>{if(key.endsWith("_max")){const field=key.replace("_max","");r=r.filter(p=>p[field]==null||p[field]<=vals);}else if(Array.isArray(vals)&&vals.length){r=r.filter(p=>{const pv=String(p[key]!=null?!!p[key]?p[key]:"false":"false");const cfg=cat&&CAT[cat]?.filters?.[key];const ev=cfg?.extract?cfg.extract(p):null;const evMatch=Array.isArray(ev)?ev.some(x=>vals.includes(x)):(ev!=null&&vals.includes(ev));return vals.includes(pv)||vals.includes(String(p[key]))||evMatch;});}});const [sk,sd]=sort.split("-");r=[...r].sort((a,b)=>{const va=sk==="price"?$(a):sk==="rating"?a.r:sk==="value"?(a.value!=null?a.value:(a.bench||0)/Math.max($(a)/100,1)):(a.bench||0);const vb=sk==="price"?$(b):sk==="rating"?b.r:sk==="value"?(b.value!=null?b.value:(b.bench||0)/Math.max($(b)/100,1)):(b.bench||0);return sd==="asc"?va-vb:vb-va;});/* DEDUPE: one row per model; merge retailer deals across dupes; bundles kept */const mergeDeals=(da,db)=>{if(!da)return db;if(!db)return da;const out={...da};for(const rk of Object.keys(db)){const ex=out[rk],inc=db[rk];if(!ex||typeof ex!=="object"){out[rk]=inc;continue;}if(!inc||typeof inc!=="object")continue;if((inc.inStock?1:0)!==(ex.inStock?1:0)){out[rk]=inc.inStock?inc:ex;}else if(typeof inc.price==="number"&&(typeof ex.price!=="number"||inc.price<ex.price)){out[rk]=inc;}}return out;};const seenModel=new Map();const deduped=[];for(const p of r){if(p.bundle){deduped.push(p);continue;}const key=p.c+"|"+cleanProductName(p).toLowerCase();const prev=seenModel.get(key);if(prev===undefined){seenModel.set(key,deduped.length);deduped.push({...p});}else{const keep=deduped[prev];const base=$(p)<$(keep)?{...p}:{...keep};base.deals=mergeDeals(keep.deals,p.deals);deduped[prev]=base;}}r=deduped;return r;},[cat,q,brands,marketplaces,conditions,maxPr,minPr,minR,cpO,sf,sort]);
  const ac=[brands.length,marketplaces.length,conditions.length,cpO,minR,maxPr<prMx,minPr>0,...Object.values(sf).map(v=>v.length)].filter(Boolean).length;

  if(!cat) return <CategoryBrowse sel={sel} th={th} CATS={CATS} CAT={CAT} P={P} CatThumb={CatThumb}/>;

  return <div className="fade" style={{maxWidth:1600,margin:"0 auto",padding:"16px 20px"}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}><button onClick={()=>setCat("")} style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",background:"none",border:"none",cursor:"pointer"}}>All Parts</button><span style={{color:"var(--mute)"}}>/</span><CatThumb cat={cat} thumbs={th.thumbs} setThumb={th.setThumb} removeThumb={th.removeThumb} size={24} rounded={4} editable={false}/><select value={cat} onChange={e=>sel(e.target.value)} style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--accent)",fontWeight:600,background:"none",border:"none",cursor:"pointer",outline:"none",padding:"2px 4px",appearance:"auto"}}>{CATS.map(c=><option key={c} value={c}>{CAT[c].label}</option>)}</select><div style={{flex:1}}/><span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)"}}>{list.length} results</span></div>
    <CategoryGuide cat={cat}/>
    <div className="browse-layout" style={{display:"grid",gridTemplateColumns:"200px 1fr",gap:16,alignItems:"start"}}>
      {/* SIDEBAR */}
      <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:14,position:"sticky",top:64}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}><span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mint)",fontWeight:600,letterSpacing:1}}>FILTERS</span>{ac>0&&<button onClick={()=>{setBrands([]);setMarketplaces([]);setConditions([]);setMaxPr(5000);setMinPr(0);setMinR(0);setCpO(false);setSf({});}} style={{fontSize:9,color:"var(--rose)",background:"none",border:"none",cursor:"pointer",fontFamily:"var(--ff)"}}>Clear ({ac})</button>}</div>
        <FG label="PRICE RANGE">
          <div style={{display:"flex",gap:6,marginBottom:6}}>
            <input type="number" value={minPr||""} onChange={e=>setMinPr(+e.target.value||0)} placeholder="Min $" style={{width:"50%",background:"var(--bg4)",border:"1px solid var(--bdr)",borderRadius:4,padding:"6px 8px",fontSize:13,color:"var(--txt)",fontFamily:"var(--mono)",outline:"none"}}/>
            <input type="number" value={maxPr>=5000?"":maxPr} onChange={e=>setMaxPr(+e.target.value||5000)} placeholder="Max $" style={{width:"50%",background:"var(--bg4)",border:"1px solid var(--bdr)",borderRadius:4,padding:"6px 8px",fontSize:13,color:"var(--txt)",fontFamily:"var(--mono)",outline:"none"}}/>
          </div>
          <input type="range" min={0} max={Math.ceil(prMx/50)*50} value={Math.min(maxPr,Math.ceil(prMx/50)*50)} onChange={e=>setMaxPr(+e.target.value)} style={{width:"100%"}}/>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:2}}><span style={{fontFamily:"var(--mono)",fontSize:12,color:"var(--dim)",fontWeight:600}}>${minPr}</span><span style={{fontFamily:"var(--mono)",fontSize:13,color:"var(--mint)",fontWeight:700}}>to ${maxPr>=5000?"∞":"$"+maxPr}</span></div>
        </FG>
        <FG label="BRAND">{allBr.map(b=><Chk key={b} label={b} checked={brands.includes(b)} onChange={()=>setBrands(p=>p.includes(b)?p.filter(x=>x!==b):[...p,b])} count={catP.filter(p=>resolveBrand(p)===b).length}/>)}</FG>
        {allMarkets.length>0&&<FG label="MARKETPLACE" open={true}>{allMarkets.map(m=>{const cap=retailerDisplayName(m);const cnt=catP.filter(p=>p.deals&&typeof p.deals==="object"&&expandMarketplaceGroup(m).some(rk=>p.deals[rk]&&typeof p.deals[rk]==="object"&&p.deals[rk].price)).length;return <Chk key={m} label={cap} checked={marketplaces.includes(m)} onChange={()=>setMarketplaces(p=>p.includes(m)?p.filter(x=>x!==m):[...p,m])} count={cnt}/>;})}</FG>}
        <FG label="RATING">{[4.5,4,0].map(rv=><Chk key={rv} label={rv?`${rv}+ ★`:"All"} checked={minR===rv} onChange={()=>setMinR(minR===rv?0:rv)}/>)}</FG>
        {/* Category-specific filters */}
        {cat && CAT[cat]?.filters && Object.entries(CAT[cat].filters).map(([field,cfg])=>{
          if(cfg.type==="bool"){
            const trueCount=catP.filter(p=>!!p[field]).length;
            const falseCount=catP.filter(p=>!p[field]).length;
            if(trueCount===0)return null;
            return <FG key={field} label={cfg.label.toUpperCase()}>
              <Chk label="Yes" checked={(sf[field]||[]).includes("true")} onChange={()=>togSf(field,"true")} count={trueCount}/>
              <Chk label="No" checked={(sf[field]||[]).includes("false")} onChange={()=>togSf(field,"false")} count={falseCount}/>
            </FG>;
          }
          if(cfg.type==="range"){
            const vals=catP.map(p=>p[field]).filter(v=>v!=null&&!isNaN(v));
            if(!vals.length)return null;
            const mn=Math.min(...vals),mx=Math.max(...vals);
            if(mn===mx)return null;
            return <FG key={field} label={cfg.label.toUpperCase()}>
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <span style={{fontFamily:"var(--mono)",fontSize:12,color:"var(--dim)",fontWeight:600,flexShrink:0,whiteSpace:"nowrap"}}>{mn}{cfg.unit||""}</span>
                <input type="range" min={mn} max={mx} value={sf[field+"_max"]||mx} onChange={e=>{const v=+e.target.value;setSf(prev=>({...prev,[field+"_max"]:v}));}} style={{flex:1,minWidth:0}}/>
                <span style={{fontFamily:"var(--mono)",fontSize:13,color:"var(--mint)",fontWeight:700,flexShrink:0,whiteSpace:"nowrap"}}>{sf[field+"_max"]||mx}{cfg.unit||""}</span>
              </div>
            </FG>;
          }
          // Default: checkbox filter
          const opts=uv(cat,field,cfg.extract);
          if(!opts.length)return null;
          const matchVal=cfg.extract?(p,v)=>{const ev=cfg.extract(p);return Array.isArray(ev)?ev.includes(v):ev===v;}:(p,v)=>String(p[field])===v;
          const lbl=cfg.extract?(v)=>String(v):(v)=>fmt(field,isNaN(v)?v:+v);
          return <FG key={field} label={cfg.label.toUpperCase()}>
            {(showAll[field]?opts:opts.slice(0,20)).map(v=><Chk key={v} label={lbl(v)} checked={(sf[field]||[]).includes(v)} onChange={()=>togSf(field,v)} count={catP.filter(p=>matchVal(p,v)).length}/>)}
            {opts.length>20&&<button onClick={()=>setShowAll(s=>({...s,[field]:!s[field]}))} style={{background:'none',border:'none',padding:'4px 0',cursor:'pointer',fontFamily:'var(--mono)',fontSize:9,color:'var(--sky)',textAlign:'left',width:'100%'}}>{showAll[field]?'- show less':'+ '+(opts.length-20)+' more'}</button>}
          </FG>;
        })}
      </div>
      {/* TABLE */}
      <div>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
          <div style={{flex:1,position:"relative"}}>
            <span style={{position:"absolute",left:8,top:"50%",transform:"translateY(-50%)",fontSize:13,color:"var(--mute)"}}>🔍</span>
            <input value={q} onChange={e=>setQ(e.target.value)} placeholder={`Search ${cat?CAT[cat].label.toLowerCase():"all parts"}...`}
              style={{width:"100%",background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:6,padding:"7px 8px 7px 28px",fontSize:13,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none"}}/>
            {q&&<button onClick={()=>setQ("")} style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"var(--dim)",fontSize:13,cursor:"pointer"}}>✕</button>}
          </div>
          <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)"}}>SORT</span>
          <select value={sort} onChange={e=>setSort(e.target.value)} style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:5,padding:"7px 8px",fontSize:10,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none",cursor:"pointer"}}><option value="price-asc">Price ↑</option><option value="price-desc">Price ↓</option><option value="rating-desc">Top Rated</option><option value="bench-desc">Performance</option><option value="value-desc">Best Value</option></select><span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",marginLeft:8}}>VIEW</span><div style={{display:"flex",gap:0,background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:5,overflow:"hidden"}}><button onClick={()=>setViewModeP("row")} title="Row view" style={{background:viewMode==="row"?"var(--accent3)":"transparent",border:"none",color:viewMode==="row"?"var(--accent)":"var(--dim)",padding:"6px 10px",cursor:"pointer",fontSize:14,fontFamily:"var(--ff)",fontWeight:600}}>☰</button><button onClick={()=>setViewModeP("grid")} title="Grid view" style={{background:viewMode==="grid"?"var(--accent3)":"transparent",border:"none",color:viewMode==="grid"?"var(--accent)":"var(--dim)",padding:"6px 10px",cursor:"pointer",fontSize:14,fontFamily:"var(--ff)",fontWeight:600}}>▦</button></div>
        </div>
        {/* Condition filter pills */}
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:8,marginBottom:6}}>
          {CONDITIONS.map(cnd=>{
            const cnt=catP.filter(p=>productConditions(p).includes(cnd.id)).length;
            if(cnt===0&&cnd.id!=="new") return null;
            const on=conditions.includes(cnd.id);
            return <button key={cnd.id} onClick={()=>setConditions(p=>p.includes(cnd.id)?p.filter(x=>x!==cnd.id):[...p,cnd.id])} style={{background:on?"var(--accent3)":"var(--bg3)",border:"1px solid "+(on?"var(--accent)":"var(--bdr)"),borderRadius:14,padding:"4px 10px",fontFamily:"var(--ff)",fontSize:11,color:on?"var(--accent)":"var(--txt)",fontWeight:on?600:400,cursor:"pointer"}}>{cnd.label} <span style={{color:on?"var(--accent)":"var(--dim)",fontSize:10,marginLeft:2}}>{cnt}</span></button>;
          })}
        </div>
        {/* Active filter chips */}
        <FilterChips chips={[
          ...(q ? [{label:'Search: ' + q, onRemove:()=>setQ('')}] : []),
          ...(minPr > 0 || maxPr < prMx ? [{label:`Price: $${minPr}-$${maxPr}`, onRemove:()=>{setMinPr(0);setMaxPr(5000);}}] : []),
          ...brands.map(b=>({label:'Brand: ' + b, onRemove:()=>setBrands(prev=>prev.filter(x=>x!==b))})),
          ...marketplaces.map(m=>({label:'Marketplace: ' + retailerDisplayName(m), onRemove:()=>setMarketplaces(prev=>prev.filter(x=>x!==m))})),
          ...conditions.map(cnd=>({label:'Condition: ' + (CONDITIONS.find(x=>x.id===cnd)?.label||cnd), onRemove:()=>setConditions(prev=>prev.filter(x=>x!==cnd))})),
          ...(minR > 0 ? [{label:`Rating: ${minR}+`, onRemove:()=>setMinR(0)}] : []),
          ...(cpO ? [{label:'Customer Picks Only', onRemove:()=>setCpO(false)}] : []),
          ...Object.entries(sf).flatMap(([key,vals])=>{
            if(key.endsWith('_max')) return [{label:`${key.replace('_max','')}: max ${vals}`, onRemove:()=>setSf(prev=>{const n={...prev};delete n[key];return n;})}];
            if(Array.isArray(vals)) return vals.map(v=>({label:`${(CAT[cat]?.filters?.[key]?.label)||key}: ${v}`, onRemove:()=>setSf(prev=>({...prev,[key]:prev[key].filter(x=>x!==v)}))}));
            return [];
          })
        ]}/>
        {/* Header */}
        <div style={{display:"grid",gridTemplateColumns:`4fr ${cols.map(()=>"1fr").join(" ")} 60px 80px 70px`,gap:8,padding:"10px 12px",borderBottom:"2px solid var(--bdr2)",background:"var(--bg3)",borderRadius:"8px 8px 0 0"}}>
          <span style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)",fontWeight:600,letterSpacing:0.5,textTransform:"uppercase"}}>Product</span>
          {cols.map(col=><span key={col} style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)",fontWeight:600,letterSpacing:0.5,textAlign:"center",textTransform:"uppercase"}}>{(SL[col]||col)}</span>)}
          <span style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)",fontWeight:600,textAlign:"center",textTransform:"uppercase"}}>Value</span>
          <span style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)",fontWeight:600,textAlign:"right",textTransform:"uppercase"}}>Price</span><span/>
        </div>
        {/* Rows or Grid */}
        {viewMode==="grid" ? (
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(240px, 1fr))",gap:14,marginTop:14}}>
            {list.map(p=>{
              const rr=retailers(p);
              return <div key={p.id} onClick={()=>setExpanded(p.id)} style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:12,cursor:"pointer",transition:"transform .15s, border-color .15s",display:"flex",flexDirection:"column",gap:8}} onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--accent)";e.currentTarget.style.transform="translateY(-2px)";}} onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--bdr)";e.currentTarget.style.transform="translateY(0)";}}>
                {p.img ? <img loading="lazy" decoding="async" src={p.img} alt={p.n} style={{width:"100%",aspectRatio:"1 / 1",objectFit:"contain",background:"var(--bg4)",borderRadius:6}}/> : <div style={{width:"100%",aspectRatio:"1 / 1",background:"var(--bg4)",borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",fontSize:48}}>{ic(p)}</div>}
                <div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)",lineHeight:1.3,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden",minHeight:34}}>{p.n}</div>
                <div style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>
                  <span style={{fontSize:11,color:"var(--dim)",fontFamily:"var(--ff)"}}>{p.b}</span>
                  {p.r && <Stars r={p.r} s={9}/>}
                </div>
                <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                  {isDeal(p)&&<span style={{background:"linear-gradient(90deg,#FF6B35,#F5A623)",color:"#fff",fontSize:9,fontWeight:800,padding:"2px 6px",borderRadius:3,fontFamily:"var(--mono)"}}>🔥 -${dealSavings(p)}</span>}
                  {(p.used===true||p.condition==="used")&&<Tag color="#F59E0B">USED</Tag>}
                  {p.condition==="refurbished"&&<Tag color="var(--sky)">REFURB</Tag>}
                  {p.condition==="open-box"&&<Tag color="var(--violet)">OPEN BOX</Tag>}
                </div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginTop:"auto",paddingTop:6}}>
                  <div>
                    {isDeal(p)&&<div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--mute)",textDecoration:"line-through"}}>${fmtPrice(p.msrp||p.pr)}</div>}
                    <div style={{fontFamily:"var(--ff)",fontSize:18,fontWeight:800,color:"var(--mint)"}}>${fmtPrice($(p))}</div>
                  </div>
                  {rr.length>0&&<button onClick={e=>{e.stopPropagation();window.open(rr[0].url,"_blank","noopener,noreferrer");}} style={{background:"var(--accent)",color:"#fff",border:"none",borderRadius:6,padding:"6px 12px",fontFamily:"var(--ff)",fontSize:12,fontWeight:700,cursor:"pointer"}}>Buy →</button>}
                </div>
              </div>;
            })}
          </div>
        ) : (<>
        {list.map((p,i)=>{
          const isExp=expanded===p.id;
          const rr=retailers(p);
          return <div key={p.id}>
            {isExp && <ProductSchema p={p}/>}
            <div onClick={()=>setExpanded(isExp?null:p.id)} style={{display:"grid",gridTemplateColumns:`4fr ${cols.map(()=>"1fr").join(" ")} 60px 80px 70px`,gap:8,padding:"10px 12px",alignItems:"center",borderBottom:isExp?"none":"1px solid var(--bdr)",background:isExp?"var(--bg3)":i%2?"var(--bg2)":"transparent",cursor:"pointer",borderRadius:isExp?"8px 8px 0 0":0,transition:"background .2s"}}>
              <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}><ChevronRight size={16} strokeWidth={2} style={{flexShrink:0,color:"var(--dim)",transition:"transform .2s",transform:isExp?"rotate(90deg)":"rotate(0deg)"}}/>{p.img?<img loading="lazy" decoding="async" src={p.img} alt={`${p.n}${p.c ? ' ' + p.c : ''}`} style={{width:100,height:100,objectFit:"contain",borderRadius:6,background:"var(--bg4)"}}/>:<span style={{fontSize:56,width:100,textAlign:"center"}}>{ic(p)}</span>}<div style={{minWidth:0}}><div style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:600,color:"var(--txt)",display:"-webkit-box",WebkitLineClamp:3,WebkitBoxOrient:"vertical",overflow:"hidden",lineHeight:1.3}}>{cleanProductName(p)}</div><div style={{display:"flex",alignItems:"center",gap:4,marginTop:2,flexWrap:"wrap"}}><span style={{fontSize:13,color:"var(--dim)",fontFamily:"var(--ff)"}}>{p.b}</span><Stars r={p.r} s={10}/>{isDeal(p)&&<span style={{display:"inline-flex",alignItems:"center",gap:3,background:"linear-gradient(90deg,#FF6B35,#F5A623)",color:"#fff",fontSize:10,fontWeight:800,padding:"2px 8px",borderRadius:4,fontFamily:"var(--mono)",letterSpacing:0.5,textShadow:"0 1px 2px rgba(0,0,0,0.2)",whiteSpace:"nowrap",flexShrink:0}}>🔥 DEAL -${dealSavings(p)}</span>}{(p.used===true||p.condition==="used")&&<Tag color="#F59E0B">USED</Tag>}{p.condition==="refurbished"&&<Tag color="var(--sky)">REFURBISHED</Tag>}{p.condition==="open-box"&&<Tag color="var(--violet)">OPEN BOX</Tag>}{p.bundle&&<Tag color="var(--amber)">BUNDLE</Tag>}</div></div></div>
              {cols.map(col=>{const v=p[col];const fmtVal=fmt(col,v,p);return <div key={col} style={{textAlign:"center"}}>{col==="bench"&&v!=null?<SBar v={v}/>:typeof fmtVal==="string"&&fmtVal.includes("\n")?<div><div style={{fontFamily:"var(--ff)",fontSize:13,color:v!=null?"var(--txt)":"var(--mute)",fontWeight:500}}>{fmtVal.split("\n")[0]}</div><div style={{fontFamily:"var(--ff)",fontSize:9,color:"var(--dim)"}}>{fmtVal.split("\n")[1]}</div></div>:<span style={{fontFamily:"var(--ff)",fontSize:13,color:v!=null?"var(--txt)":"var(--mute)",fontWeight:500}}>{fmtVal}</span>}</div>})}
              {(()=>{if(p.bench==null)return <div style={{textAlign:"center"}}><span style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--mute)"}}>—</span></div>;const ratio=Math.round(valueRatio(p)*10)/10;const grade=ratio>=28?"S":ratio>=20?"A":ratio>=14?"B":ratio>=8?"C":"D";const gc=ratio>=28?"var(--mint)":ratio>=20?"var(--sky)":ratio>=14?"var(--amber)":ratio>=8?"var(--dim)":"var(--rose)";return <div style={{textAlign:"center"}}><span style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:800,color:gc}}>{grade}</span></div>;})()}
              <div style={{textAlign:"right"}}>{isDeal(p)&&<div style={{fontFamily:"var(--ff)",fontSize:9,color:"var(--mute)",textDecoration:"line-through"}}>${fmtPrice(p.msrp||p.pr)}</div>}<div style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:700,color:"var(--mint)"}}>${fmtPrice($(p))}</div>{rr.length>1&&<div style={{fontFamily:"var(--ff)",fontSize:9,color:"var(--dim)"}}>{rr.length} stores</div>}</div>
              <div style={{display:"flex",justifyContent:"flex-end"}} onClick={e=>{e.stopPropagation();setExpanded(isExp?null:p.id);}}>
                <button style={{background:isExp?"var(--bg4)":"var(--mint)",border:isExp?"1px solid var(--mint)":"none",borderRadius:6,padding:"6px 14px",cursor:"pointer",fontFamily:"var(--ff)",fontSize:10,fontWeight:700,color:isExp?"var(--mint)":"var(--bg)",transition:"all .15s"}}>{isExp?"Close":"Buy →"}</button>
              </div>
            </div>
            {/* Expanded: pricing, availability & deals */}
            {isExp&&<div style={{background:"var(--bg3)",borderRadius:"0 0 10px 10px",padding:"22px 24px",marginBottom:6,border:"1px solid var(--bdr)",borderTop:"none"}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1.4fr",gap:28}}>
                {/* Left: specs */}
                <div>
                  <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--accent)",letterSpacing:1,marginBottom:10,fontWeight:700,textTransform:"uppercase"}}>Specifications</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 20px"}}>
                    {Object.entries(p).filter(([k])=>!["id","n","c","b","pr","r","cp","off","deals","msrp","url","img","bench","condition","generation","chipset"].includes(k)&&p[k]!=null&&typeof p[k]!=="object").map(([k,v])=>
                      <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:"1px solid var(--bdr)"}}>
                        <span style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)"}}>{SL[k]||k}</span>
                        <span style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)",fontWeight:600}}>{fmt(k,v)}</span>
                      </div>)}
                  </div>
                  {p.c==="Motherboard"&&p.memSpeed&&<div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)",marginTop:8,padding:"6px 8px",background:"var(--bg2)",borderRadius:6,lineHeight:1.5}}>* Memory Speed is the max supported by this motherboard. Actual speed also depends on your CPU's memory controller and RAM kit rated speed.</div>}
                  {p.bench!=null&&<div style={{marginTop:14}}><div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)",marginBottom:5}}>PERFORMANCE</div><SBar v={p.bench}/></div>}
                </div>
                {/* Right: buy */}
                <div>
                  <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--accent)",letterSpacing:1,marginBottom:10,fontWeight:700,textTransform:"uppercase"}}>Buy Now</div>
                  <div style={{display:"flex",flexDirection:"column",gap:6}}>
                    {rr.length>0?rr.map((r,ri)=>{const histKey=p.id+":"+r.name;const histOpenHere=histOpen===histKey;return <React.Fragment key={r.name}>
                      <a key={r.name} href={r.url} target="_blank" rel="noopener noreferrer" style={{display:"flex",alignItems:"center",padding:"12px 14px",borderRadius:8,textDecoration:"none",gap:12,background:ri===0?"var(--mint3)":"var(--bg4)",border:`1px solid ${ri===0?"var(--mint)33":"var(--bdr)"}`}}>
                        <div style={{flex:1}}>
                          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}><span style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:700,color:"var(--txt)"}}>{r.displayName}</span>{ri===0&&rr.length>1&&<Tag color="var(--mint)">BEST</Tag>}</div>
                          <div style={{fontFamily:"var(--ff)",fontSize:13,color:r.inStock?"var(--sky)":"var(--rose)"}}>{r.inStock?"✓ In Stock":"✗ Out of Stock"}</div>
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:12}}>
                          <span style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:ri===0?"var(--mint)":"var(--txt)"}}>${fmtPrice(r.price)}</span>
                          <div style={{background:ri===0?"var(--mint)":"var(--bg3)",border:ri===0?"none":"1px solid var(--bdr2)",borderRadius:6,padding:"8px 16px",fontFamily:"var(--ff)",fontSize:13,fontWeight:700,color:ri===0?"var(--bg)":"var(--txt)"}}>Buy →</div>
                        </div>
                      </a>
                      <button onClick={()=>setHistOpen(histOpenHere?null:histKey)} style={{display:"flex",alignItems:"center",gap:5,background:"none",border:"none",cursor:"pointer",fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",letterSpacing:"0.04em",textTransform:"uppercase",padding:"3px 14px"}}>{histOpenHere?"\u25b2 Hide price history":"\u25bc 90-day price history"}</button>
                      {histOpenHere&&<div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:8,marginBottom:4}}><PriceHistoryChart product={p} retailer={r.name}/></div>}
                      </React.Fragment>;})
                    :<a href={p.deals?.amazon?.url||"#"} target="_blank" rel="noopener noreferrer" style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 16px",borderRadius:8,background:"var(--mint3)",border:"1px solid var(--mint)33",textDecoration:"none"}}>
                        <div><span style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:700,color:"var(--txt)"}}>Amazon</span><div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--sky)",marginTop:3}}>✓ In Stock</div></div>
                        <div style={{display:"flex",alignItems:"center",gap:12}}><span style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--mint)"}}>${fmtPrice($(p))}</span><div style={{background:"var(--mint)",borderRadius:6,padding:"8px 16px",fontFamily:"var(--ff)",fontSize:13,fontWeight:700,color:"var(--bg)"}}>Buy →</div></div>
                      </a>}
                    {rr.length>0&&ALL_RETAILERS.filter(name=>!rr.some(r=>r.name===name)).map(name=>{
                      const cap=retailerDisplayName(name);
                      return <div key={name} style={{display:"flex",alignItems:"center",padding:"12px 14px",borderRadius:8,gap:12,background:"var(--bg4)",border:"1px dashed var(--bdr)",opacity:0.55}}>
                        <div style={{flex:1}}>
                          <div style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:700,color:"var(--dim)",textTransform:"capitalize",marginBottom:2}}>{cap}</div>
                          <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--mute)"}}>Not tracked at this retailer</div>
                        </div>
                        <span style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:600,color:"var(--mute)",fontStyle:"italic"}}>N/A</span>
                      </div>;
                    })}
                  </div>
                  {/* Value · Ratings · Future-Proofing */}
                  <div style={{display:"flex",alignItems:"stretch",gap:14,marginTop:10}}>
                    <div style={{flex:1,minWidth:0,display:"flex"}}>
                      {(()=>{ const _v = (
                p.bench!=null&&<div style={{background:"var(--bg4)",borderRadius:10,padding:"16px 18px",width:"100%",boxSizing:"border-box"}}>
                  <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--accent)",letterSpacing:1,marginBottom:12,fontWeight:700}}>VALUE SCORE</div>
                  {(()=>{const ratio=Math.round(valueRatio(p)*10)/10;const grade=ratio>=28?"S":ratio>=20?"A":ratio>=14?"B":ratio>=8?"C":"D";const gc=ratio>=28?"var(--mint)":ratio>=20?"var(--sky)":ratio>=14?"var(--amber)":ratio>=8?"var(--dim)":"var(--rose)";const gl=ratio>=28?"Exceptional value":ratio>=20?"Great value":ratio>=14?"Good value":ratio>=8?"Average value":"Below average";return <div>
                    <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:12}}>
                      <div style={{width:52,height:52,borderRadius:12,background:gc+"18",display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{fontFamily:"var(--ff)",fontSize:26,fontWeight:800,color:gc}}>{grade}</span></div>
                      <div><div style={{fontFamily:"var(--ff)",fontSize:17,fontWeight:700,color:"var(--txt)"}}>{ratio.toFixed(1)}</div><div style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:600,color:gc}}>{gl}</div></div>
                    </div>
                    <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",lineHeight:1.6,background:"var(--bg2)",borderRadius:8,padding:"10px 12px"}}>
                      Performance ({p.bench}%) ÷ Price (${fmtPrice($(p))}) = <span style={{color:"var(--txt)",fontWeight:600}}>{ratio.toFixed(1)}</span><br/>
                      <span style={{color:"var(--mute)"}}>S ≥28 · A ≥20 · B ≥14 · C ≥8 · D &lt;8</span>
                    </div></div>;})()}
                </div>
                      ); return _v || <div style={{flex:1}}/>; })()}
                    </div>
                    <div style={{flex:1,minWidth:0,display:"flex"}}>
                      {(()=>{ const _f = (
                (p.c==="CPU"||p.c==="GPU"||p.c==="Motherboard")&&<div style={{background:"var(--bg4)",borderRadius:10,padding:"16px 18px",width:"100%",boxSizing:"border-box"}}>
                  <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--accent)",letterSpacing:1,marginBottom:12,fontWeight:700}}>FUTURE-PROOFING</div>
                  {(()=>{const f=[];
                    // Derive platform from socket OR from chipset (some DataForSEO products only have chipset)
                    const sock=(p.socket||"").toUpperCase().replace(/\s/g,"");
                    const chip=(p.chipset||"").toUpperCase();
                    const isAM5=sock==="AM5"||/^(A620|B650|B650E|X670|X670E|B840|B850|X870|X870E)$/.test(chip);
                    const isAM4=sock==="AM4"||/^(A320|B350|X370|B450|X470|A520|B550|X570)$/.test(chip);
                    const isLGA1851=sock==="LGA1851"||/^(Z890|B860|H810)$/.test(chip);
                    const isLGA1700=sock==="LGA1700"||/^(H610|B660|H670|Z690|H770|B760|Z790)$/.test(chip);
                    const isLGA1200=sock==="LGA1200"||/^(H410|B460|H470|Z490|H510|B560|H570|Z590)$/.test(chip);

                    if(p.c==="CPU"||p.c==="Motherboard"){
                      if(isAM5) f.push({t:"AM5 — supported through 2027+",g:true});
                      else if(isLGA1851) f.push({t:"LGA1851 — current Intel platform",g:true});
                      else if(isAM4) f.push({t:"AM4 — end of life, no CPU upgrade path",g:false});
                      else if(isLGA1700) f.push({t:"LGA1700 — dead socket, 14th gen is last",g:false});
                      else if(isLGA1200) f.push({t:"LGA1200 — end of life, 2+ gens old",g:false});
                    }
                    if(p.c==="CPU"){
                      if(p.memType==="DDR5") f.push({t:"DDR5 support",g:true});
                      else if(p.memType==="DDR4") f.push({t:"DDR4 only — no DDR5 path",g:false});
                    }
                    if(p.c==="Motherboard"){
                      if(p.memType==="DDR5") f.push({t:"DDR5 memory",g:true});
                      else if(p.memType==="DDR4") f.push({t:"DDR4 only — no DDR5 upgrades",g:false});
                      if(/WiFi\s*7/i.test(p.fullTitle||p.n||"")) f.push({t:"WiFi 7 ready",g:true});
                      if(/PCIe\s*5/i.test(p.fullTitle||p.n||"")) f.push({t:"PCIe 5.0 lanes",g:true});
                    }
                    if(p.c==="GPU"){
                      if(p.vram>=16)f.push({t:`${p.vram}GB VRAM — future-proof`,g:true});
                      else if(p.vram>=12)f.push({t:`${p.vram}GB — adequate for now`,g:true});
                      else if(p.vram)f.push({t:`${p.vram}GB VRAM — may limit at 4K`,g:false});
                      if(p.arch==="Blackwell"||p.arch==="RDNA 4")f.push({t:"Current gen architecture",g:true});
                    }
                    if(!f.length)f.push({t:"Platform info unavailable",g:true});
                    return f.slice(0,5).map((x,i)=><div key={i} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"8px 0",borderBottom:i<f.length-1?"1px solid var(--bdr)":"none"}}><span style={{fontSize:17,lineHeight:1,flexShrink:0}}>{x.g?"✅":"⚠️"}</span><span style={{fontFamily:"var(--ff)",fontSize:14,color:x.g?"var(--txt)":"var(--amber)",lineHeight:1.4}}>{x.t}</span></div>);})()}
                </div>
                      ); return _f || <div style={{flex:1}}/>; })()}
                    </div>
                  </div>
                  {!(p.msrp&&p.msrp>$(p))&&rr.length>1&&<div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",textAlign:"center",marginTop:8}}>Save <span style={{color:"var(--mint)",fontWeight:600}}>${(rr[rr.length-1].price-rr[0].price).toFixed(2)}</span> at {rr[0].name} vs {rr[rr.length-1].name}</div>}
                  {p.msrp&&p.msrp>$(p)&&<div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:6,background:"var(--bg4)",border:"1px solid var(--bdr)",marginTop:8,position:"relative"}}><span style={{fontSize:17}}>💰</span><div style={{flex:1}}><div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)"}}>Below MSRP</div><div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)"}}>Was <span style={{textDecoration:"line-through"}}>${fmtPrice(p.msrp)}</span> → ${fmtPrice($(p))}</div></div><div style={{position:"absolute",left:"50%",transform:"translateX(-50%)",display:"flex",justifyContent:"center",pointerEvents:"none"}}>{rr.length>1&&<span style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",textAlign:"center",whiteSpace:"nowrap"}}>Save <span style={{color:"var(--mint)",fontWeight:600}}>${(rr[rr.length-1].price-rr[0].price).toFixed(2)}</span> at {rr[0].name} vs {rr[rr.length-1].name}</span>}</div><span style={{fontFamily:"var(--ff)",fontSize:17,fontWeight:700,color:"var(--mint)"}}>{Math.round((1-$(p)/p.msrp)*100)}% off</span></div>}
                  {/* Product Image */}
                  {(p.used===true||p.condition==="used")&&<div style={{marginTop:14,background:"linear-gradient(90deg,#F59E0B 0%,#D97706 100%)",color:"#1A1A20",padding:"10px 14px",borderRadius:8,fontFamily:"var(--ff)",fontSize:13,fontWeight:700,display:"flex",alignItems:"center",gap:10,border:"1px solid #D97706"}}><span style={{fontFamily:"var(--mono)",fontSize:13,fontWeight:900,letterSpacing:1.5,background:"#1A1A20",color:"#F59E0B",padding:"3px 8px",borderRadius:4}}>USED</span><span>Pre-owned item — check seller rating, condition notes, and return policy before purchasing.</span></div>}{p.img&&<div style={{marginTop:14,background:"var(--bg4)",borderRadius:10,padding:16,display:"flex",alignItems:"center",justifyContent:"center"}}>
                    <img loading="lazy" decoding="async" src={p.img.replace('_AC_SL300_','_AC_SL500_')} alt={`${p.n}${p.c ? ' ' + p.c : ''}`} style={{maxWidth:"100%",maxHeight:220,objectFit:"contain",borderRadius:6}}/>
                  </div>}
                </div>
              </div>

              <ProductReviews product={p}/>


              {/* Consider Instead */}
              {p.bench!=null&&(()=>{const same=catP.filter(x=>x.id!==p.id&&x.bench!=null);const better=same.filter(x=>x.bench>=p.bench*0.9&&$(x)<$(p)*0.85).sort((a,b)=>(b.bench/$(b))-(a.bench/$(a)))[0];const upgrade=same.filter(x=>x.bench>p.bench*1.15&&$(x)<$(p)*1.2).sort((a,b)=>(b.bench/$(b))-(a.bench/$(a)))[0];if(!better&&!upgrade)return null;
                const specs=(x)=>{
                  if(x.c==="CPU")return [{l:"Cores",v:`${x.cores}C/${x.threads}T`},{l:"Boost",v:`${x.boostClock}GHz`},{l:"Socket",v:x.socket},{l:"TDP",v:`${x.tdp}W`}];
                  if(x.c==="GPU")return [{l:"VRAM",v:`${x.vram}GB`},{l:"TDP",v:`${x.tdp}W`},{l:"Length",v:`${x.length}mm`},{l:"Arch",v:x.arch}];
                  if(x.c==="RAM")return [{l:"Kit",v:`${x.cap||x.capacity}GB`},{l:"Speed",v:`${x.speed}MHz`},{l:"CL",v:x.cl},{l:"Type",v:x.ramType||x.memType}];
                  if(x.c==="Motherboard")return [{l:"Socket",v:x.socket},{l:"Chipset",v:x.chipset},{l:"Form",v:x.ff},{l:"WiFi",v:x.wifi||"No"}];
                  if(x.c==="Storage")return [{l:"Cap",v:x.cap},{l:"Read",v:`${x.seq_r}MB/s`},{l:"Type",v:x.storageType}];
                  if(x.c==="PSU")return [{l:"Watts",v:`${x.watts}W`},{l:"Eff",v:x.eff},{l:"Mod",v:x.modular}];
                  return [{l:"Price",v:`$${$(x)}`}];
                };
                const card=(alt,color,tag,sub)=><div style={{background:"var(--bg2)",borderRadius:10,padding:"16px 18px",border:"1px solid var(--bdr)"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><Tag color={color}>{tag}</Tag><span style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)"}}>{sub}</span></div>
                  <div style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:700,color:"var(--txt)",marginBottom:10}}>{alt.n}</div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>{specs(alt).map((s,i)=><div key={i} style={{background:"var(--bg4)",borderRadius:6,padding:"6px 10px",textAlign:"center",minWidth:60}}><div style={{fontFamily:"var(--ff)",fontSize:9,color:"var(--dim)",marginBottom:2}}>{s.l}</div><div style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--txt)",fontWeight:600}}>{s.v}</div></div>)}</div>
                  <div style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color}}>${$(alt)}</div>
                </div>;
                return <div style={{marginTop:14}}>
                  <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--accent)",letterSpacing:1,marginBottom:12,fontWeight:700}}>CONSIDER INSTEAD</div>
                  <div style={{display:"grid",gridTemplateColumns:better&&upgrade?"1fr 1fr":"1fr",gap:12}}>
                    {better&&card(better,"var(--mint)",`SAVE $${$(p)-$(better)}`,`${Math.round(better.bench/p.bench*100)}% of this product's perf`)}
                    {upgrade&&card(upgrade,"var(--sky)",`+${upgrade.bench-p.bench}% FASTER`,$(upgrade)>$(p)?`for $${$(upgrade)-$(p)} more`:`$${$(p)-$(upgrade)} cheaper`)}
                  </div>
                </div>;})()}

            </div>}
          </div>;
        })}
        </>)}
        {list.length===0&&<div style={{textAlign:"center",padding:48,color:"var(--dim)",fontFamily:"var(--ff)"}}>No products match your filters</div>}
      </div>
    </div>
  </div>;
}

/* ═══ BUILDER FPS PANEL ═══ */
function BuilderFPS({gpu,cpu,ram}){
  const [fpsRes,setFpsRes]=useState("1080p");
  const [fpsQual,setFpsQual]=useState("Ultra");
  const sample=[
    {name:"Cyberpunk 2077",icon:"🌆"},{name:"Fortnite",icon:"🏗️"},{name:"Valorant",icon:"🎯"},
    {name:"Elden Ring",icon:"💍"},{name:"Call of Duty: MW III",icon:"🔫"},{name:"Baldur's Gate 3",icon:"🎲"},
    {name:"Black Myth: Wukong",icon:"🐒"},{name:"GTA VI",icon:"🌴"},{name:"Counter-Strike 2",icon:"💣"},
    {name:"Hogwarts Legacy",icon:"🧙"},{name:"God of War Ragnarök",icon:"🪓"},{name:"Apex Legends",icon:"🏆"}
  ];
  const hasData=gpu&&cpu;
  const gpuKey=hasData?matchGPU(gpu.n):null;
  const cpuKey=hasData?matchCPU(cpu.n):null;
  const ready=gpuKey&&cpuKey;
  const ramInfo=ram?{speed:ram.speed||5600,capacity:ram.capacity||32,memType:ram.memType||"DDR5"}:null;
  const results=ready?sample.map(g=>{const r=estimateFPS(gpuKey,cpuKey,g.name,fpsRes,fpsQual,ramInfo);return r?{...r,icon:g.icon}:null;}).filter(Boolean):[];
  const avg=results.length?Math.round(results.reduce((s,r)=>s+r.fps,0)/results.length):0;
  const tc=t=>t==="Excellent"?"var(--mint)":t==="Great"?"var(--sky)":t==="Smooth"?"var(--amber)":"var(--rose)";
  const bn=results.filter(r=>r.bottleneck!=="Balanced");
  const ramNote=results.find(r=>r.ramNote)?.ramNote;
  const ramMult=results.length?results[0].ramSpeedMult:1;

  const missing=[];
  if(!gpu)missing.push("GPU");
  if(!cpu)missing.push("CPU");

  const btnStyle=(active,c="var(--sky)")=>({padding:"5px 10px",borderRadius:5,fontSize:9,fontFamily:"var(--mono)",fontWeight:600,cursor:"pointer",background:active?c+"18":"transparent",color:active?c:"var(--dim)",border:`1px solid ${active?c+"33":"var(--bdr)"}`,transition:"all .15s"});

  return <div style={{background:"var(--bg2)",border:`1px solid ${ready?"var(--sky)22":"var(--bdr)"}`,borderRadius:12,padding:16,overflow:"hidden",opacity:ready?1:0.7,transition:"opacity .3s"}}>
    {/* Header with controls */}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12,flexWrap:"wrap",gap:8}}>
      <div>
        <div style={{fontFamily:"var(--mono)",fontSize:9,color:ready?"var(--sky)":"var(--dim)",letterSpacing:1.5,fontWeight:600}}>🎮 ESTIMATED GAMING PERFORMANCE</div>
        <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",marginTop:2}}>
          {ready?`${gpuKey} + ${cpuKey}`:missing.length?`Select ${missing.join(" & ")} to see estimates`:"Waiting for parts..."}
        </div>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        {/* Resolution selector */}
        <div style={{display:"flex",gap:3}}>
          {["1080p","1440p","4K"].map(r=><button key={r} onClick={()=>setFpsRes(r)} style={btnStyle(fpsRes===r)}>{r}</button>)}
        </div>
        {/* Quality selector */}
        <div style={{display:"flex",gap:3}}>
          {["Low","Medium","High","Ultra"].map(q=><button key={q} onClick={()=>setFpsQual(q)} style={btnStyle(fpsQual===q,"var(--mint)")}>{q}</button>)}
        </div>
        {/* Avg FPS */}
        <div style={{textAlign:"right",minWidth:50}}>
          <div style={{fontFamily:"var(--mono)",fontSize:7,color:"var(--dim)"}}>AVG FPS</div>
          <div style={{fontFamily:"var(--mono)",fontSize:22,fontWeight:800,color:ready?(avg>=144?"var(--mint)":avg>=100?"var(--sky)":avg>=60?"var(--amber)":"var(--rose)"):"var(--mute)"}}>{ready?avg:"—"}</div>
        </div>
      </div>
    </div>

    {/* Game cards */}
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>
      {sample.map(g=>{
        const r=results.find(x=>x.game===g.name);
        return <div key={g.name} style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:8,padding:"8px 10px",display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:17}}>{g.icon}</span>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontFamily:"var(--ff)",fontSize:10,fontWeight:600,color:ready?"var(--txt)":"var(--dim)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{g.name}</div>
            <div style={{height:3,background:"var(--bg4)",borderRadius:2,overflow:"hidden",marginTop:3}}>
              {r&&<div style={{width:`${Math.min(r.fps/200*100,100)}%`,height:"100%",background:tc(r.tier),borderRadius:2,transition:"width .4s ease"}}/>}
            </div>
          </div>
          <div style={{fontFamily:"var(--mono)",fontSize:15,fontWeight:700,color:r?tc(r.tier):"var(--mute)",flexShrink:0,minWidth:28,textAlign:"right"}}>{r?r.fps:"—"}</div>
        </div>;
      })}
    </div>

    {/* Legend + warnings */}
    {/* Legend + warnings + RAM info */}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:8,flexWrap:"wrap",gap:4}}>
      <div style={{display:"flex",gap:10}}>
        {[{t:"Excellent",f:"144+",c:"var(--mint)"},{t:"Great",f:"100+",c:"var(--sky)"},{t:"Smooth",f:"60+",c:"var(--amber)"},{t:"Playable",f:"30+",c:"var(--rose)"}].map(x=>
          <div key={x.t} style={{display:"flex",alignItems:"center",gap:3}}>
            <div style={{width:8,height:8,borderRadius:2,background:x.c}}/>
            <span style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--txt)",fontWeight:500}}>{x.t} ({x.f})</span>
          </div>
        )}
      </div>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        {ram&&ready&&<span style={{fontFamily:"var(--mono)",fontSize:7,color:ramMult>=1.0?"var(--mint)":"var(--amber)"}}>
          ⚡ {ram.memType||"DDR5"}-{ram.speed||5600} {ram.capacity||32}GB ({ramMult>=1.0?"+":""}{Math.round((ramMult-1)*100)}% RAM impact)
        </span>}
        {!ram&&ready&&<span style={{fontFamily:"var(--mono)",fontSize:7,color:"var(--dim)"}}>
          ⚡ Add RAM for more accurate estimates
        </span>}
        {bn.length>0&&<span style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--amber)"}}>
          ⚠️ {bn[0].bottleneck} bottleneck in {bn.length} title{bn.length>1?"s":""}
        </span>}
      </div>
    </div>
    {ramNote&&<div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--rose)",marginTop:4}}>
      ⚠️ {ramNote}
    </div>}
  </div>;
}

/* ═══ BUILDER PART PICKER (full page with filters) ═══ */
function CompatibilityBanner({cat, build}){
  if(!build) return null;
  const cpu = build.CPU, mobo = build.Motherboard, cas = build.Case, gpu = build.GPU;
  // Build messages explaining filtering in friendly teaching language
  const msgs = [];
  const shortName = (p, max=40) => {
    if(!p || !p.n) return "your part";
    return p.n.length > max ? p.n.slice(0, max) + "…" : p.n;
  };
  if(cat === "Motherboard"){
    if(cpu && cpu.socket){
      msgs.push(`You picked the **${shortName(cpu, 50)}**, which uses the **${cpu.socket}** socket. We\'re only showing motherboards with that socket so your CPU will physically fit.`);
    }
    if(cas && cas.ff){
      msgs.push(`Your case (${shortName(cas, 35)}) supports **${cas.ff}** motherboard form factors. We\'re hiding boards that won\'t fit your case.`);
    }
  }
  else if(cat === "CPU"){
    if(mobo && mobo.socket){
      msgs.push(`Your motherboard (${shortName(mobo, 40)}) uses the **${mobo.socket}** socket. We\'re only showing CPUs that match it. Mixing sockets = the CPU won\'t fit.`);
    }
  }
  else if(cat === "RAM"){
    const memType = (mobo && mobo.memType) || (cpu && cpu.memType);
    if(memType){
      const src = mobo && mobo.memType ? `motherboard` : `CPU`;
      msgs.push(`Your ${src} requires **${memType}** memory. DDR4 and DDR5 are physically different — they don\'t fit each other\'s slots. We\'re filtering to ${memType} kits only.`);
    }
    if(mobo && mobo.memSlots){
      msgs.push(`Your motherboard has **${mobo.memSlots} RAM slots**. Picking a 2-stick kit leaves room to upgrade later; a 4-stick kit fills the board.`);
    }
  }
  else if(cat === "CPUCooler"){
    if(cpu && cpu.socket){
      msgs.push(`Your CPU uses the **${cpu.socket}** socket. We\'re filtering to coolers with mounting brackets that fit it. Coolers come with multiple brackets, but a few are socket-specific.`);
    }
    if(cas && cas.coolerClear){
      msgs.push(`Your case allows coolers up to **${cas.coolerClear}mm** tall. Bigger air coolers won\'t fit — we\'ve hidden the ones that are too tall.`);
    }
  }
  else if(cat === "GPU"){
    if(cas && cas.gpuClear){
      msgs.push(`Your case fits GPUs up to **${cas.gpuClear}mm** long. Modern flagship cards can hit 350mm+ — we\'re hiding ones that won\'t physically fit.`);
    }
  }
  else if(cat === "Case"){
    if(mobo && mobo.ff){
      msgs.push(`Your motherboard is **${mobo.ff}** form factor. We\'re only showing cases that support it. An ITX board fits everywhere, but ATX boards need ATX-capable cases.`);
    }
  }
  else if(cat === "PSU"){
    const gpuTDP = (gpu && gpu.tdp) || 0;
    const cpuTDP = (cpu && cpu.tdp) || 0;
    if(gpuTDP || cpuTDP){
      const est = Math.round((gpuTDP * 1.8 + cpuTDP + 100) / 50) * 50;
      msgs.push(`Based on your **GPU (${gpuTDP || "?"}W)** and **CPU (${cpuTDP || "?"}W)**, you need roughly **${est}W** minimum, accounting for transient spikes and headroom. We\'re filtering to PSUs that can handle your build safely.`);
    }
  }
  if(msgs.length === 0) return null;
  // Markdown-style **bold** rendering helper
  const renderMsg = (text) => {
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((part, i) => {
      if(part.startsWith("**") && part.endsWith("**")){
        return <strong key={i} style={{fontWeight:600,color:"var(--accent)"}}>{part.slice(2,-2)}</strong>;
      }
      return part;
    });
  };
  return <div style={{borderLeft:"3px solid var(--accent)",background:"var(--accent3)",padding:"14px 18px",marginBottom:24,maxWidth:1000}}>
    <div style={{fontFamily:"var(--mono)",fontSize:10,letterSpacing:"0.12em",textTransform:"uppercase",color:"var(--accent)",fontWeight:600,marginBottom:10}}>💡 Heads up &middot; Why this list is filtered</div>
    <ul style={{margin:0,padding:0,listStyle:"none"}}>
      {msgs.map((msg, i) => <li key={i} style={{fontFamily:"var(--ff)",fontSize:13.5,color:"var(--txt)",lineHeight:1.65,marginBottom:i < msgs.length - 1 ? 10 : 0}}>{renderMsg(msg)}</li>)}
    </ul>
  </div>;
}

/* === CURRENT BUILD SIDEBAR (sticky, desktop only) === */
function CurrentBuildSidebar({cat, build}){
  if(!build) return null;
  const ORDER = ["GPU","Case","CPU","Motherboard","Storage","RAM","CPUCooler","PSU"];
  const slots = ORDER.filter(s => build[s] || s === cat);
  if(slots.length === 0) return null;
  return <aside className="picker-sidebar" style={{position:"sticky",top:180,fontFamily:"var(--ff)"}}>
    <div style={{border:"1px solid var(--bdr)",background:"var(--bg2)",padding:"16px 18px"}}>
      <div style={{fontFamily:"var(--mono)",fontSize:10,letterSpacing:"0.08em",textTransform:"uppercase",color:"var(--mute)",marginBottom:12}}>Your build so far</div>
      {slots.map((slot, idx) => {
        const p = build[slot];
        const isCurrent = slot === cat;
        return <div key={slot} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom: idx !== slots.length - 1 ? "1px solid var(--bdr)" : "none"}}>
          <div style={{width:24,display:"flex",justifyContent:"center",flexShrink:0}}>
            <CatIcon c={slot} size={16} color={isCurrent ? "var(--accent)" : "var(--dim)"}/>
          </div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:11,fontWeight:600,color:isCurrent?"var(--accent)":"var(--dim)",letterSpacing:"0.04em",textTransform:"uppercase"}}>{slot}{isCurrent && " · picking"}</div>
            {p ? <div style={{fontSize:12,color:"var(--txt)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",marginTop:2}}>{cleanProductName(p)}</div>
               : <div style={{fontSize:12,color:"var(--mute)",fontStyle:"italic",marginTop:2}}>—</div>}
          </div>
        </div>;
      })}
    </div>
  </aside>;
}

function BuilerPartPicker({cat,meta,cols,compatList,onAdd,onBack,isMulti,build}){
  const [q,setQ]=useState("");
  const [viewMode,setViewMode]=useState(()=>{try{return localStorage.getItem("rf-viewmode")||"row";}catch{return "row";}});
  const setViewModeP=v=>{setViewMode(v);try{localStorage.setItem("rf-viewmode",v);}catch{}};
  const [sf,setSf]=useState({});
  const [showAll,setShowAll]=useState({});
  const togSf=(col,val)=>setSf(pv=>{const cu=pv[col]||[];return{...pv,[col]:cu.includes(val)?cu.filter(v=>v!==val):[...cu,val]};});
  const [sort,setSort]=useState("price-asc");
  const [brands,setBrands]=useState([]);
  const [conditions,setConditions]=useState([]);
  const [minR,setMinR]=useState(0);
  const [prMin,setPrMin]=useState(0);
  const [prMax,setPrMax]=useState(99999);
  const [expanded,setExpanded]=useState(null);

  const allBr=[...new Set(compatList.map(p=>resolveBrand(p)).filter(Boolean))].sort();
  const prMx=Math.max(...compatList.map(p=>$(p)),100);

  let list=compatList.filter(p=>{
    if(q&&!smartMatch(p,q))return false;
    if(brands.length&&!brands.includes(resolveBrand(p)))return false;
    if(conditions.length){
      const cond = (p.used===true||p.condition==="used")?"Used":(p.condition==="refurbished")?"Refurbished":(p.condition==="open-box")?"Open Box":"New";
      if(!conditions.includes(cond)) return false;
    }
    if(minR&&p.r<minR)return false;
    if($(p)<prMin||$(p)>prMax)return false;
    for(const [key,vals] of Object.entries(sf)){
      if(key.endsWith("_max")){
        const field=key.replace("_max","");
        if(p[field]!=null&&p[field]>vals)return false;
      }else if(Array.isArray(vals)&&vals.length){
        const cfg=cat&&CAT[cat]?.filters?.[key];
        const ev=cfg?.extract?cfg.extract(p):null;
        const evMatch=Array.isArray(ev)?ev.some(x=>vals.includes(x)):(ev!=null&&vals.includes(ev));
        if(!(vals.includes(String(p[key]))||evMatch))return false;
      }
    }
    return true;
  });
  if(sort==="price-asc")list.sort((a,b)=>$(a)-$(b));
  else if(sort==="price-desc")list.sort((a,b)=>$(b)-$(a));
  else if(sort==="rating-desc")list.sort((a,b)=>b.r-a.r);
  else if(sort==="bench-desc")list.sort((a,b)=>(b.bench||0)-(a.bench||0));

  return <div className="fade" style={{maxWidth:1600,margin:"0 auto",padding:"28px 20px"}}>
    <div className="picker-grid" style={{display:"grid",gridTemplateColumns:"1fr 280px",gap:24,alignItems:"start"}}>
      <div>
    {/* Header */}
    <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
      <button onClick={onBack} style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:8,padding:"8px 14px",cursor:"pointer",display:"flex",alignItems:"center",gap:6,color:"var(--txt)",fontFamily:"var(--ff)",fontSize:13,fontWeight:600}}>← Back to Build</button>
      <div style={{flex:1}}>
        <h2 style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--txt)",display:"flex",alignItems:"center",gap:8}}>
          <CatIcon c={cat} size={22}/> Choose {meta.singular||meta.label}
        </h2>
        <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",marginTop:2}}>{compatList.length} compatible parts · {list.length} shown</div>
      </div>
    </div>

    <CategoryGuide cat={cat}/>
    <div className="builder-picker-layout" style={{display:"grid",gridTemplateColumns:"200px 1fr",gap:20,alignItems:"start"}}>
      {/* Sidebar filters */}
      <div className="builder-picker-sidebar">
        <FG label="PRICE RANGE" open={true}>
          <div style={{display:"flex",gap:6}}>
            <input type="number" placeholder="Min" value={prMin||""} onChange={e=>setPrMin(+e.target.value||0)} style={{width:"50%",background:"var(--bg4)",border:"1px solid var(--bdr)",borderRadius:4,padding:"4px 6px",fontSize:10,color:"var(--txt)",fontFamily:"var(--mono)",outline:"none"}}/>
            <input type="number" placeholder="Max" value={prMax>=99999?"":prMax} onChange={e=>setPrMax(+e.target.value||99999)} style={{width:"50%",background:"var(--bg4)",border:"1px solid var(--bdr)",borderRadius:4,padding:"4px 6px",fontSize:10,color:"var(--txt)",fontFamily:"var(--mono)",outline:"none"}}/>
          </div>
        </FG>
        <FG label="BRAND">{allBr.map(b=><Chk key={b} label={b} checked={brands.includes(b)} onChange={()=>setBrands(p=>p.includes(b)?p.filter(x=>x!==b):[...p,b])} count={compatList.filter(p=>resolveBrand(p)===b).length}/>)}</FG>
        <FG label="CONDITION">{(()=>{const getCond=p=>(p.used===true||p.condition==="used")?"Used":(p.condition==="refurbished")?"Refurbished":(p.condition==="open-box")?"Open Box":"New";const counts={};compatList.forEach(p=>{const k=getCond(p);counts[k]=(counts[k]||0)+1;});return ["New","Used","Refurbished","Open Box"].filter(c=>counts[c]>0).map(c=><Chk key={c} label={c} checked={conditions.includes(c)} onChange={()=>setConditions(p=>p.includes(c)?p.filter(x=>x!==c):[...p,c])} count={counts[c]}/>);})()}</FG>
        <FG label="RATING">{[4.5,4,0].map(rv=><Chk key={rv} label={rv?`${rv}+ ★`:"All"} checked={minR===rv} onChange={()=>setMinR(minR===rv?0:rv)}/>)}</FG>
        {/* Category-specific filters (same logic as SearchPage) */}
        {cat && CAT[cat]?.filters && Object.entries(CAT[cat].filters).map(([field,cfg])=>{
          if(cfg.type==="boolean"){
            const trueCount=compatList.filter(p=>p[field]).length;
            const falseCount=compatList.filter(p=>!p[field]).length;
            if(trueCount===0)return null;
            return <FG key={field} label={cfg.label.toUpperCase()}>
              <Chk label="Yes" checked={(sf[field]||[]).includes("true")} onChange={()=>togSf(field,"true")} count={trueCount}/>
              <Chk label="No" checked={(sf[field]||[]).includes("false")} onChange={()=>togSf(field,"false")} count={falseCount}/>
            </FG>;
          }
          if(cfg.type==="range"){
            const vals=compatList.map(p=>p[field]).filter(v=>v!=null&&!isNaN(v));
            if(!vals.length)return null;
            const mn=Math.min(...vals),mx=Math.max(...vals);
            if(mn===mx)return null;
            return <FG key={field} label={cfg.label.toUpperCase()}>
              <div style={{display:"flex",alignItems:"center",gap:4}}>
                <span style={{fontFamily:"var(--mono)",fontSize:12,color:"var(--dim)",fontWeight:600,flexShrink:0,whiteSpace:"nowrap"}}>{mn}{cfg.unit||""}</span>
                <input type="range" min={mn} max={mx} value={sf[field+"_max"]||mx} onChange={e=>{const v=+e.target.value;setSf(prev=>({...prev,[field+"_max"]:v}));}} style={{flex:1,minWidth:0}}/>
                <span style={{fontFamily:"var(--mono)",fontSize:13,color:"var(--mint)",fontWeight:700,flexShrink:0,whiteSpace:"nowrap"}}>{sf[field+"_max"]||mx}{cfg.unit||""}</span>
              </div>
            </FG>;
          }
          const opts=uv(cat,field,cfg.extract);
          if(!opts.length)return null;
          const matchVal=cfg.extract?(p,v)=>{const ev=cfg.extract(p);return Array.isArray(ev)?ev.includes(v):ev===v;}:(p,v)=>String(p[field])===v;
          const lbl=cfg.extract?(v)=>String(v):(v)=>fmt(field,isNaN(v)?v:+v);
          return <FG key={field} label={cfg.label.toUpperCase()}>
            {(showAll[field]?opts:opts.slice(0,20)).map(v=><Chk key={v} label={lbl(v)} checked={(sf[field]||[]).includes(v)} onChange={()=>togSf(field,v)} count={compatList.filter(p=>matchVal(p,v)).length}/>)}
            {opts.length>20&&<button onClick={()=>setShowAll(s=>({...s,[field]:!s[field]}))} style={{background:'none',border:'none',padding:'4px 0',cursor:'pointer',fontFamily:'var(--mono)',fontSize:9,color:'var(--sky)',textAlign:'left',width:'100%'}}>{showAll[field]?'- show less':'+ '+(opts.length-20)+' more'}</button>}
          </FG>;
        })}
      </div>

      {/* Main table */}
      <div>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,position:"sticky",top:64,zIndex:50,background:"var(--bg)",padding:"10px 0",borderBottom:"1px solid var(--bdr)"}}>
          <div style={{flex:1,position:"relative"}}>
            <span style={{position:"absolute",left:8,top:"50%",transform:"translateY(-50%)",fontSize:13,color:"var(--mute)"}}>🔍</span>
            <input value={q} onChange={e=>setQ(e.target.value)} placeholder={`Search ${meta.label.toLowerCase()}...`}
              style={{width:"100%",background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:6,padding:"7px 8px 7px 28px",fontSize:13,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none"}}/>
            {q&&<button onClick={()=>setQ("")} style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"var(--dim)",fontSize:13,cursor:"pointer"}}>✕</button>}
          </div>
          <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)"}}>SORT</span>
          <select value={sort} onChange={e=>setSort(e.target.value)} style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:5,padding:"7px 8px",fontSize:10,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none",cursor:"pointer"}}>
            <option value="price-asc">Price ↑</option><option value="price-desc">Price ↓</option><option value="rating-desc">Top Rated</option><option value="bench-desc">Performance</option>
          </select><span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",marginLeft:8}}>VIEW</span><div style={{display:"flex",gap:0,background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:5,overflow:"hidden"}}><button onClick={()=>setViewModeP("row")} title="Row view" style={{background:viewMode==="row"?"var(--accent3)":"transparent",border:"none",color:viewMode==="row"?"var(--accent)":"var(--dim)",padding:"6px 10px",cursor:"pointer",fontSize:14,fontFamily:"var(--ff)",fontWeight:600}}>☰</button><button onClick={()=>setViewModeP("grid")} title="Grid view" style={{background:viewMode==="grid"?"var(--accent3)":"transparent",border:"none",color:viewMode==="grid"?"var(--accent)":"var(--dim)",padding:"6px 10px",cursor:"pointer",fontSize:14,fontFamily:"var(--ff)",fontWeight:600}}>▦</button></div>
        </div>

        {/* Table header */}
        <div style={{display:"grid",gridTemplateColumns:`2fr ${cols.map(()=>"1fr").join(" ")} 80px 80px`,gap:6,padding:"6px 10px",borderBottom:"1px solid var(--bdr2)"}}>
          <span style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",letterSpacing:1}}>NAME</span>
          {cols.map(col=><span key={col} style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",letterSpacing:1,textAlign:"center"}}>{(SL[col]||col).toUpperCase()}</span>)}
          <span style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",textAlign:"right"}}>PRICE</span>
          <span style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",textAlign:"center"}}>ACTION</span>
        </div>

        {/* Rows */}
        {list.length===0&&<div style={{padding:40,textAlign:"center",color:"var(--dim)",fontFamily:"var(--ff)"}}>No parts match your filters</div>}
        {list.map((p,i)=>{
          const isExp=expanded===p.id;
          return <div key={p.id}>
            {isExp && <ProductSchema p={p}/>}
            <div onClick={()=>setExpanded(isExp?null:p.id)} style={{display:"grid",gridTemplateColumns:`2fr ${cols.map(()=>"1fr").join(" ")} 80px 80px`,gap:6,padding:"8px 10px",alignItems:"center",borderBottom:isExp?"none":"1px solid var(--bdr)",background:isExp?"var(--bg3)":i%2?"var(--bg2)08":"transparent",cursor:"pointer",borderRadius:isExp?"8px 8px 0 0":0}}>
              <div style={{display:"flex",alignItems:"center",gap:8,minWidth:0}}>
                {p.img?<img loading="lazy" decoding="async" src={p.img} alt={`${p.n}${p.c ? ' ' + p.c : ''}`} style={{width:36,height:36,objectFit:"contain",borderRadius:6,background:"#fff",flexShrink:0}}/>:<span style={{fontSize:17}}>{meta.icon}</span>}
                <div style={{minWidth:0}}>
                  <div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)",display:"-webkit-box",WebkitLineClamp:3,WebkitBoxOrient:"vertical",overflow:"hidden",lineHeight:1.3}}>{cleanProductName(p)}</div>
                  <div style={{display:"flex",alignItems:"center",gap:4,marginTop:1}}>
                    <span style={{fontSize:10,color:"var(--dim)"}}>{p.b}</span>
                    <Stars r={p.r} s={9}/>
                    {isDeal(p)&&<span style={{display:"inline-flex",alignItems:"center",gap:3,background:"linear-gradient(90deg,#FF6B35,#F5A623)",color:"#fff",fontSize:13,fontWeight:800,padding:"3px 10px",borderRadius:4,fontFamily:"var(--mono)",letterSpacing:0.5,textShadow:"0 1px 2px rgba(0,0,0,0.2)"}}>🔥 DEAL -${dealSavings(p)}</span>}{p.condition==="refurbished"&&<Tag color="var(--sky)">REFURBISHED</Tag>}{p.condition==="open-box"&&<Tag color="var(--violet)">OPEN BOX</Tag>}{p.bundle&&<Tag color="var(--amber)">BUNDLE</Tag>}
                  </div>
                </div>
              </div>
              {cols.map(col=>{const v=p[col];return <div key={col} style={{textAlign:"center"}}>{col==="bench"&&v!=null?<SBar v={v}/>:<span style={{fontFamily:"var(--mono)",fontSize:10,color:v!=null?"var(--txt)":"var(--mute)"}}>{fmt(col,v)}</span>}</div>})}
              <div style={{textAlign:"right"}}>
                {(p.msrp&&p.msrp>$(p))&&<div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--mute)",textDecoration:"line-through"}}>${fmtPrice(p.msrp)}</div>}
                <div style={{fontFamily:"var(--mono)",fontSize:14,fontWeight:700,color:"var(--mint)"}}>${fmtPrice($(p))}</div>
              </div>
              <div style={{display:"flex",justifyContent:"center"}} onClick={e=>e.stopPropagation()}>
                <button onClick={()=>onAdd(p)} style={{background:"var(--mint)",border:"none",borderRadius:5,padding:"5px 12px",cursor:"pointer",fontFamily:"var(--mono)",fontSize:9,fontWeight:700,color:"var(--bg)"}}>+ Add</button>
              </div>
            </div>
            {/* Expanded specs */}
            {isExp&&<div style={{background:"var(--bg3)",borderRadius:"0 0 8px 8px",padding:"12px 16px",marginBottom:4,border:"1px solid var(--bdr)",borderTop:"none"}}>
              <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--mint)",letterSpacing:1.5,marginBottom:8,fontWeight:600}}>SPECIFICATIONS</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"0 20px"}}>
                {Object.entries(p).filter(([k])=>!["id","n","c","b","pr","r","cp","off","deals","msrp","url","img","bench","condition","generation","chipset","uid","reviews","asin","discount","listPrice","percentageDiscount","fullTitle","description","enrichedAt","additionalImages","amazonCategories","applicableVouchers","boughtPastMonth","isAmazonChoice","isBestSeller","isAvailable","currency","discoveredVia","discoveredAt","sourceFile","imageUrl","amazonUrl","category","brand","name","title","specs"].includes(k)&&p[k]!=null&&typeof p[k]!=="object").map(([k,v])=>
                  <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:"1px solid var(--bdr)"}}>
                    <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)"}}>{SL[k]||k}</span>
                    <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--txt)",fontWeight:500}}>{fmt(k,v)}</span>
                  </div>
                )}
              </div>
              {p.bench!=null&&<div style={{marginTop:8}}><div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",marginBottom:3}}>PERFORMANCE</div><SBar v={p.bench}/></div>}
              <div style={{marginTop:8}}>
                <button onClick={()=>onAdd(p)} style={{background:"var(--mint)",border:"none",borderRadius:6,padding:"8px 20px",cursor:"pointer",fontFamily:"var(--ff)",fontSize:13,fontWeight:700,color:"var(--bg)"}}>+ Add to Build</button>
              </div>
            </div>}
          </div>;
        })}
      </div>
    </div>
      </div>
      <CurrentBuildSidebar cat={cat} build={build}/>
    </div>
  </div>;
}

/* ═══ BUILDER ═══ */

/* === MOBILE BUILDER PART PICKER === */
function MobileBuilerPartPicker({cat,meta,cols,compatList,onAdd,onBack,isMulti,build}){
  const [q,setQ]=useState("");
  const [sort,setSort]=useState("price-asc");
  const [brands,setBrands]=useState([]);
  const [minR,setMinR]=useState(0);
  const [prMin,setPrMin]=useState(0);
  const [prMax,setPrMax]=useState(99999);
  const [expanded,setExpanded]=useState(null);
  const [filtersOpen,setFiltersOpen]=useState(false);
  const [sf,setSf]=useState({});
  const togSf=(col,val)=>setSf(pv=>{const cu=pv[col]||[];return{...pv,[col]:cu.includes(val)?cu.filter(v=>v!==val):[...cu,val]};});

  const allBr=[...new Set(compatList.map(p=>resolveBrand(p)).filter(Boolean))].sort();
  const prMx=Math.max(...compatList.map(p=>$(p)),100);

  let list=compatList.filter(p=>{
    if(q&&!smartMatch(p,q))return false;
    if(brands.length&&!brands.includes(resolveBrand(p)))return false;
    if(minR&&p.r<minR)return false;
    if($(p)<prMin||$(p)>prMax)return false;
    for(const [key,vals] of Object.entries(sf)){
      if(key.endsWith("_max")){
        const field=key.replace("_max","");
        if(p[field]!=null&&p[field]>vals)return false;
      }else if(Array.isArray(vals)&&vals.length){
        const cfg=cat&&CAT[cat]?.filters?.[key];
        const ev=cfg?.extract?cfg.extract(p):null;
        const evMatch=Array.isArray(ev)?ev.some(x=>vals.includes(x)):(ev!=null&&vals.includes(ev));
        if(!(vals.includes(String(p[key]))||evMatch))return false;
      }
    }
    return true;
  });
  if(sort==="price-asc")list.sort((a,b)=>$(a)-$(b));
  else if(sort==="price-desc")list.sort((a,b)=>$(b)-$(a));
  else if(sort==="rating-desc")list.sort((a,b)=>b.r-a.r);
  else if(sort==="bench-desc")list.sort((a,b)=>(b.bench||0)-(a.bench||0));

  const ac=[brands.length,minR,prMax<99999,prMin>0].filter(Boolean).length;
  const clearFilters=()=>{setBrands([]);setMinR(0);setPrMin(0);setPrMax(99999);};

  return <div className="fade" style={{padding:"12px 12px 80px",maxWidth:"100vw",overflow:"hidden"}}>
    {/* Header */}
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
      <button onClick={onBack} style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:8,padding:"8px 12px",cursor:"pointer",fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)",flexShrink:0}}>← Back</button>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontFamily:"var(--ff)",fontSize:17,fontWeight:800,color:"var(--txt)",display:"flex",alignItems:"center",gap:6,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
          <CatIcon c={cat} size={22}/> Choose {meta.singular||meta.label}
        </div>
        <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",marginTop:1}}>{list.length} of {compatList.length}</div>
      </div>
    </div>

    <CategoryGuide cat={cat}/>
    <CategoryGuide cat={cat}/>
    {/* Search bar */}
    <div style={{position:"relative",marginBottom:10}}>
      <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:15,color:"var(--mute)"}}>🔍</span>
      <input value={q} onChange={e=>setQ(e.target.value)} placeholder={"Search "+meta.label.toLowerCase()} style={{width:"100%",background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:8,padding:"10px 10px 10px 34px",fontSize:15,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none",boxSizing:"border-box"}}/>
      {q&&<button onClick={()=>setQ("")} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"var(--dim)",fontSize:15,cursor:"pointer"}}>✕</button>}
    </div>

    {/* Filter + Sort bar */}
    <div style={{display:"flex",gap:8,marginBottom:14}}>
      <button onClick={()=>setFiltersOpen(true)} style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,background:ac>0?"var(--accent3)":"var(--bg3)",border:"1px solid "+(ac>0?"var(--accent)":"var(--bdr)"),borderRadius:8,padding:"10px",fontFamily:"var(--ff)",fontSize:14,fontWeight:600,color:ac>0?"var(--accent)":"var(--txt)",cursor:"pointer"}}>⚙ Filters{ac>0?" ("+ac+")":""}</button>
      <select value={sort} onChange={e=>setSort(e.target.value)} style={{flex:1,background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:8,padding:"10px",fontSize:14,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none",cursor:"pointer"}}>
        <option value="price-asc">Price ↑</option>
        <option value="price-desc">Price ↓</option>
        <option value="rating-desc">Top Rated</option>
        <option value="bench-desc">Performance</option>
      </select>
    </div>

    {/* Product cards */}
    {list.length===0&&<div style={{textAlign:"center",padding:"48px 16px",color:"var(--dim)",fontFamily:"var(--ff)",fontSize:15}}>No parts match your filters</div>}
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {list.map(p=>{
        const isExp=expanded===p.id;
        return <div key={p.id} style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,overflow:"hidden",maxWidth:"100%"}}>
          {isExp&&<ProductSchema p={p}/>}
          <div onClick={()=>setExpanded(isExp?null:p.id)} style={{display:"flex",gap:12,padding:12,cursor:"pointer",minWidth:0}}>
            {p.img?<img loading="lazy" decoding="async" src={p.img} alt={`${p.n}${p.c ? ' ' + p.c : ''}`} style={{width:64,height:64,objectFit:"contain",borderRadius:8,background:"#fff",flexShrink:0}}/>:<div style={{width:64,height:64,background:"var(--bg4)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0}}>{meta.icon}</div>}
            <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column",gap:4}}>
              <div style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:600,color:"var(--txt)",lineHeight:1.3,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{p.n}</div>
              <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                <span style={{fontSize:13,color:"var(--dim)",fontFamily:"var(--ff)"}}>{p.b}</span>
                {p.r&&<Stars r={p.r} s={10}/>}
                {isDeal(p)&&<span style={{display:"inline-flex",alignItems:"center",gap:3,background:"linear-gradient(90deg,#FF6B35,#F5A623)",color:"#fff",fontSize:13,fontWeight:800,padding:"3px 10px",borderRadius:4,fontFamily:"var(--mono)",letterSpacing:0.5,textShadow:"0 1px 2px rgba(0,0,0,0.2)"}}>🔥 DEAL -${dealSavings(p)}</span>}
                {p.bundle&&<Tag color="var(--amber)">BUNDLE</Tag>}
              </div>
              <div style={{display:"flex",alignItems:"baseline",gap:8,marginTop:2}}>
                <span style={{fontFamily:"var(--ff)",fontSize:17,fontWeight:800,color:"var(--mint)"}}>${fmtPrice($(p))}</span>
                {p.msrp&&p.msrp>$(p)&&<span style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--mute)",textDecoration:"line-through"}}>${fmtPrice(p.msrp)}</span>}
              </div>
            </div>
          </div>
          <div style={{display:"flex",gap:8,padding:"0 12px 12px",alignItems:"center"}}>
            <button onClick={e=>{e.stopPropagation();setExpanded(isExp?null:p.id);}} style={{flex:1,background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:6,padding:"8px",fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)",cursor:"pointer"}}>{isExp?"Hide specs":"View specs"}</button>
            <button onClick={e=>{e.stopPropagation();onAdd(p);}} style={{flex:1,background:"var(--mint)",border:"none",borderRadius:6,padding:"8px",fontFamily:"var(--ff)",fontSize:13,fontWeight:700,color:"var(--bg)",cursor:"pointer"}}>+ Add to Build</button>
          </div>
          {isExp&&<div style={{padding:"0 12px 14px",borderTop:"1px solid var(--bdr)"}}>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",fontWeight:700,letterSpacing:1,margin:"12px 0 8px"}}>SPECIFICATIONS</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 12px"}}>
              {Object.entries(p).filter(([k])=>!["id","n","c","b","pr","r","cp","off","deals","msrp","url","img","bench","condition","generation","chipset","uid","reviews","asin","discount","listPrice","percentageDiscount","fullTitle","description","enrichedAt","additionalImages","amazonCategories","applicableVouchers","boughtPastMonth","isAmazonChoice","isBestSeller","isAvailable","currency","discoveredVia","discoveredAt","sourceFile","imageUrl","amazonUrl","category","brand","name","title","specs","needsReview","bundle"].includes(k)&&p[k]!=null&&typeof p[k]!=="object").map(([k,v])=>
                <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:"1px solid var(--bdr)",gap:8,minWidth:0}}>
                  <span style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{SL[k]||k}</span>
                  <span style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)",fontWeight:600,textAlign:"right",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{fmt(k,v)}</span>
                </div>
              )}
            </div>
            {p.bench!=null&&<div style={{marginTop:10}}>
              <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",marginBottom:4}}>PERFORMANCE</div>
              <SBar v={p.bench}/>
            </div>}
          </div>}
        </div>;
      })}
    </div>

    {/* Filter bottom sheet */}
    {filtersOpen&&<div onClick={()=>setFiltersOpen(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:1000,display:"flex",alignItems:"flex-end"}}>
      <div onClick={e=>e.stopPropagation()} style={{background:"var(--bg2)",width:"100%",maxHeight:"85vh",overflowY:"auto",borderTopLeftRadius:16,borderTopRightRadius:16,padding:"16px 16px 32px",boxSizing:"border-box"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,position:"sticky",top:0,background:"var(--bg2)",paddingBottom:8,borderBottom:"1px solid var(--bdr)"}}>
          <span style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--txt)"}}>Filters</span>
          <div style={{display:"flex",gap:10}}>
            {ac>0&&<button onClick={clearFilters} style={{background:"none",border:"none",color:"var(--rose)",fontFamily:"var(--ff)",fontSize:14,cursor:"pointer",padding:0}}>Clear</button>}
            <button onClick={()=>setFiltersOpen(false)} style={{background:"var(--accent)",border:"none",color:"#fff",fontFamily:"var(--ff)",fontSize:14,fontWeight:700,padding:"6px 16px",borderRadius:6,cursor:"pointer"}}>Done</button>
          </div>
        </div>

        <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mint)",fontWeight:700,letterSpacing:1,marginBottom:6}}>PRICE RANGE</div>
        <div style={{display:"flex",gap:8,marginBottom:16}}>
          <input type="number" value={prMin||""} onChange={e=>setPrMin(+e.target.value||0)} placeholder="Min $" style={{flex:1,background:"var(--bg4)",border:"1px solid var(--bdr)",borderRadius:6,padding:"8px 10px",fontSize:14,color:"var(--txt)",fontFamily:"var(--mono)",outline:"none",boxSizing:"border-box"}}/>
          <input type="number" value={prMax>=99999?"":prMax} onChange={e=>setPrMax(+e.target.value||99999)} placeholder="Max $" style={{flex:1,background:"var(--bg4)",border:"1px solid var(--bdr)",borderRadius:6,padding:"8px 10px",fontSize:14,color:"var(--txt)",fontFamily:"var(--mono)",outline:"none",boxSizing:"border-box"}}/>
        </div>

        {allBr.length>0&&<div style={{marginBottom:16}}>
          <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mint)",fontWeight:700,letterSpacing:1,marginBottom:8}}>BRAND</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            {allBr.map(b=>{
              const on=brands.includes(b);
              return <button key={b} onClick={()=>setBrands(p=>p.includes(b)?p.filter(x=>x!==b):[...p,b])} style={{background:on?"var(--accent3)":"var(--bg3)",border:"1px solid "+(on?"var(--accent)":"var(--bdr)"),borderRadius:18,padding:"6px 12px",fontFamily:"var(--ff)",fontSize:13,color:on?"var(--accent)":"var(--txt)",fontWeight:on?600:400,cursor:"pointer"}}>{b} <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--mute)",marginLeft:2}}>{compatList.filter(p=>resolveBrand(p)===b).length}</span></button>;
            })}
          </div>
        </div>}

        <div style={{marginBottom:16}}>
          <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mint)",fontWeight:700,letterSpacing:1,marginBottom:8}}>MIN RATING</div>
          <div style={{display:"flex",gap:6}}>
            {[0,4,4.5].map(rv=>{
              const on=minR===rv;
              return <button key={rv} onClick={()=>setMinR(rv)} style={{flex:1,background:on?"var(--accent3)":"var(--bg3)",border:"1px solid "+(on?"var(--accent)":"var(--bdr)"),borderRadius:8,padding:"8px",fontFamily:"var(--ff)",fontSize:13,color:on?"var(--accent)":"var(--txt)",fontWeight:on?600:400,cursor:"pointer"}}>{rv?rv+"+ ★":"Any"}</button>;
            })}
          </div>
        </div>

        <button onClick={()=>setFiltersOpen(false)} style={{width:"100%",background:"var(--accent)",border:"none",color:"#fff",fontFamily:"var(--ff)",fontSize:15,fontWeight:700,padding:"14px",borderRadius:8,cursor:"pointer"}}>Show {list.length} results</button>
      </div>
    </div>}
  </div>;
}

/* === Router: desktop or mobile === */
function BuilerPartPickerRouter(props){
  const isMobile=useIsMobile();
  return isMobile?<MobileBuilerPartPicker {...props}/>:<BuilerPartPicker {...props}/>;
}

/* === BUY YOUR BUILD — affiliate checkout section === */
function BuyYourBuild({build, multiParts}){
  const coreParts = Object.values(build || {}).filter(Boolean);
  const multiList = Object.values(multiParts || {}).flat().filter(Boolean);
  const allParts = [...coreParts, ...multiList];
  if(allParts.length === 0) return null;

  const rows = allParts.map(p => {
    const rr = retailers(p);
    const best = rr.find(r => r.inStock) || rr[0] || null;
    return {part: p, best};
  });
  const buyable = rows.filter(r => r.best);
  const grandTotal = buyable.reduce((s,r) => s + r.best.price, 0);

  return <div style={{marginTop:24,border:"1px solid var(--bdr)",background:"var(--bg2)"}}>
    <div style={{padding:"16px 20px",borderBottom:"1px solid var(--bdr)",display:"flex",alignItems:"center",gap:8}}>
      <ShoppingCart size={18} strokeWidth={2} style={{color:"var(--accent)"}}/>
      <span style={{fontFamily:"var(--ff-display)",fontSize:18,fontWeight:600,color:"var(--txt)"}}>Buy Your Build</span>
    </div>
    <div>
      {rows.map((r,i) => {
        const p = r.part;
        return <div key={p.uid || p.id || i} style={{display:"grid",gridTemplateColumns:"32px 1fr auto auto",gap:12,alignItems:"center",padding:"12px 20px",borderBottom:"1px solid var(--bdr)"}}>
          <div style={{display:"flex",justifyContent:"center"}}><CatIcon c={p.c} size={16} color="var(--dim)"/></div>
          <div style={{minWidth:0}}>
            <div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{cleanProductName(p)}</div>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",textTransform:"uppercase",letterSpacing:"0.04em"}}>{p.c}</div>
          </div>
          <div style={{fontFamily:"var(--mono)",fontSize:14,fontWeight:700,color:"var(--mint)",textAlign:"right"}}>
            {r.best ? "$" + fmtPrice(r.best.price) : "\u2014"}
          </div>
          <div>
            {r.best
              ? <a href={r.best.url} target="_blank" rel="noopener noreferrer sponsored" style={{display:"inline-flex",alignItems:"center",gap:5,fontFamily:"var(--ff)",fontSize:12,fontWeight:600,padding:"7px 14px",background:"var(--accent)",color:"var(--bg)",textDecoration:"none",whiteSpace:"nowrap"}}>
                  Buy on {r.best.displayName} <ExternalLink size={12} strokeWidth={2.5}/>
                </a>
              : <span style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--mute)"}}>No retailer</span>}
          </div>
        </div>;
      })}
    </div>
    <div style={{padding:"16px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:16,flexWrap:"wrap",background:"var(--bg3)"}}>
      <div>
        <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",letterSpacing:"0.08em"}}>BUILD TOTAL ({buyable.length} {buyable.length===1?"part":"parts"})</div>
        <div style={{fontFamily:"var(--mono)",fontSize:24,fontWeight:700,color:"var(--mint)"}}>{"$" + fmtPrice(grandTotal)}</div>
      </div>
      <button onClick={()=>{
        buyable.forEach((r,idx) => {
          setTimeout(()=>{ try{ window.open(r.best.url,"_blank","noopener"); }catch(e){} }, idx*300);
        });
      }} style={{display:"inline-flex",alignItems:"center",gap:6,fontFamily:"var(--ff)",fontSize:14,fontWeight:600,padding:"12px 24px",background:"var(--accent)",color:"var(--bg)",border:"none",cursor:"pointer"}}>
        <ShoppingCart size={16} strokeWidth={2.5}/> Open All Links
      </button>
    </div>
    <div style={{padding:"10px 20px",borderTop:"1px solid var(--bdr)",fontFamily:"var(--ff)",fontSize:11,color:"var(--mute)",lineHeight:1.5}}>
      Pro Rig Builder may earn a commission on purchases made through these links, at no extra cost to you. Prices and availability are checked regularly but may change at the retailer.
    </div>
  </div>;
}

function BuilderPage({th}){
  const [build,setBuild]=useState({});       // {cat: part} for single-select
  const [multiParts,setMultiParts]=useState({});  // {cat: [part,...]} for multi-select
  const [picking,setPicking]=useState(null);
  const [buildName,setBuildName]=useState("My Build");
  const [buildBudget,setBuildBudget]=useState(0); // 0 = no budget set
  const [showConfetti,setShowConfetti]=useState(false);
  const [openSections,setOpenSections]=useState({"core":true,"cooling":false,"expansion":false,"cables":false,"peripherals":false,"accessories":false});
  // Sync picker state with browser history so back button returns to builder list
  React.useEffect(()=>{
    // Read initial picker state from URL hash (?pick=<cat>) when component mounts
    try {
      const params = new URLSearchParams(window.location.search);
      const initial = params.get('pick');
      if(initial && CAT[initial]) setPicking(initial);
    } catch(e){}
    // Handle browser back/forward
    const onPickerPop = () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const cur = params.get('pick');
        if(cur && CAT[cur]) setPicking(cur);
        else setPicking(null);
      } catch(e){ setPicking(null); }
    };
    window.addEventListener('popstate', onPickerPop);
    return ()=>window.removeEventListener('popstate', onPickerPop);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  // When picking changes via UI, push history so back button works
  const lastPickRef = useRef(null);
  React.useEffect(()=>{
    if(picking === lastPickRef.current) return;
    try {
      const params = new URLSearchParams(window.location.search);
      const current = params.get('pick');
      if(picking){
        if(current !== picking){
          params.set('pick', picking);
          const q = params.toString();
          window.history.pushState({page:'builder',pick:picking}, '', '/builder' + (q?'?'+q:''));
        }
      } else {
        if(current){
          params.delete('pick');
          const q = params.toString();
          window.history.pushState({page:'builder'}, '', '/builder' + (q?'?'+q:''));
        }
      }
    } catch(e){}
    lastPickRef.current = picking;
  },[picking]);
  const prevCount=useRef(0);

  const toggleSection=id=>setOpenSections(s=>({...s,[id]:!s[id]}));

  // Add/remove for single-select categories
  const add=p=>{setBuild(b=>({...b,[p.c]:p}));setPicking(null);
    const nc=Object.keys(build).length+1;if(nc>=8&&prevCount.current<8){setShowConfetti(true);setTimeout(()=>setShowConfetti(false),3000);}prevCount.current=nc;};
  const del=c=>{setBuild(b=>{const n={...b};delete n[c];return n;});prevCount.current=Math.max(0,Object.keys(build).length-1);};
  
  // Add/remove for multi-select categories
  const addMulti=(cat,p)=>{setMultiParts(prev=>{const list=prev[cat]||[];return{...prev,[cat]:[...list,{...p,uid:Date.now()+Math.random()}]};});setPicking(null);};
  const delMulti=(cat,uid)=>{setMultiParts(prev=>{const list=(prev[cat]||[]).filter(x=>x.uid!==uid);const n={...prev};if(list.length)n[cat]=list;else delete n[cat];return n;});};

  // Computed values
  const cpu=build.CPU;const gpu=build.GPU;const mobo=build.Motherboard;const ram=build.RAM;
  const psu=build.PSU;const cas=build.Case;const cooler=build.CPUCooler;const storage=build.Storage;
  const allStorageList=[storage,...(multiParts.Storage||[])].filter(Boolean);
  const allFanList=multiParts.CaseFan||[];
  const expansionCards=[build.SoundCard,build.EthernetCard,build.WiFiCard].filter(Boolean);

  const tdp=Object.values(build).filter(p=>p.tdp).reduce((s,p)=>s+p.tdp,0);
  const coreTotal=Object.values(build).reduce((s,p)=>s+$(p),0);
  const multiTotal=Object.values(multiParts).flat().reduce((s,p)=>s+$(p),0);
  const total=coreTotal+multiTotal;
  const coreFilled=CORE_CATS.filter(c=>build[c]).length;
  const pct=Math.round((coreFilled/CORE_CATS.length)*100);
  const ringR=24;const ringC=2*Math.PI*ringR;
  const tier=coreFilled===0?"Empty":coreFilled<=3?"Starter":coreFilled<=5?"Solid":coreFilled<=7?"Strong":"Complete";

  // ── Compatibility Engine ──
  const issues=[];const warnings=[];
  if(cpu&&mobo&&cpu.socket!==mobo.socket)issues.push({t:"err",m:`Socket mismatch — ${cpu.n} (${cpu.socket}) won't fit ${mobo.n} (${mobo.socket})`,cat:"CPU+Mobo"});
  if(cpu&&mobo&&cpu.memType&&mobo.memType&&cpu.memType!==mobo.memType)issues.push({t:"err",m:`Memory conflict — ${cpu.n} needs ${cpu.memType}, ${mobo.n} supports ${mobo.memType}`,cat:"Memory"});
  if(ram&&mobo&&ram.memType&&mobo.memType&&ram.memType!==mobo.memType)issues.push({t:"err",m:`${ram.n} is ${ram.memType} but ${mobo.n} supports ${mobo.memType}`,cat:"RAM"});
  if(gpu&&cas&&gpu.gpuLen&&cas.gpuClear&&gpu.gpuLen>cas.gpuClear)issues.push({t:"err",m:`GPU won't fit — ${gpu.n} (${gpu.gpuLen}mm) vs ${cas.n} (${cas.gpuClear}mm)`,cat:"Case+GPU"});
  if(cooler&&cas&&cooler.coolerH&&cas.coolerClear&&cooler.coolerH>cas.coolerClear)issues.push({t:"err",m:`Cooler won't fit — ${cooler.n} (${cooler.coolerH}mm) vs ${cas.n} (${cas.coolerClear}mm)`,cat:"Case+Cooler"});
  if(cooler&&cpu&&cooler.sockets&&!cooler.sockets.includes(cpu.socket))issues.push({t:"err",m:`${cooler.n} doesn't support ${cpu.socket}`,cat:"Cooler+CPU"});
  if(mobo&&cas&&cas.moboSupport&&mobo.moboFF){const m2={"ATX":"ATX","mATX":"mATX","Mini-ITX":"ITX","ITX":"ITX"};if(!cas.moboSupport.includes(m2[mobo.moboFF]||mobo.moboFF))issues.push({t:"err",m:`${mobo.n} (${mobo.moboFF}) won't fit ${cas.n}`,cat:"Case+Mobo"});}
  if(ram&&mobo&&ram.capacity&&mobo.maxMem&&ram.capacity>mobo.maxMem)issues.push({t:"err",m:`${ram.n} (${ram.capacity}GB) exceeds ${mobo.n} max (${mobo.maxMem}GB)`,cat:"RAM"});
  if(ram&&mobo&&ram.sticks&&mobo.ramSlots&&ram.sticks>mobo.ramSlots)issues.push({t:"err",m:`${ram.n} needs ${ram.sticks} slots, ${mobo.n} has ${mobo.ramSlots}`,cat:"RAM"});
  if(psu&&tdp>psu.watt)issues.push({t:"err",m:`${tdp}W exceeds ${psu.n} (${psu.watt}W)`,cat:"Power"});
  if(psu&&tdp>psu.watt*0.85&&tdp<=psu.watt)warnings.push({t:"w",m:`${tdp}W near ${psu.n} limit (${psu.watt}W)`,cat:"Power"});
  if(gpu&&psu&&gpu.pciPwr&&psu.pciConns&&gpu.pciPwr>psu.pciConns)warnings.push({t:"w",m:`${gpu.n} needs ${gpu.pciPwr} PCIe cables, ${psu.n} has ${psu.pciConns}`,cat:"PSU+GPU"});
  if(ram&&mobo&&ram.speed&&mobo.maxMemSpeed&&ram.speed>mobo.maxMemSpeed)warnings.push({t:"w",m:`${ram.n} (${ram.speed}MHz) exceeds ${mobo.n} rated ${mobo.maxMemSpeed}MHz`,cat:"RAM Speed"});
  if(ram&&cpu&&ram.speed&&cpu.maxMem&&ram.speed>cpu.maxMem)warnings.push({t:"w",m:`${ram.n} (${ram.speed}MHz) exceeds ${cpu.n} IMC (${cpu.maxMem}MHz)`,cat:"RAM Speed"});
  if(cooler&&ram&&cooler.ramClear&&ram.height&&ram.height>cooler.ramClear)warnings.push({t:"w",m:`${ram.n} (${ram.height}mm) may conflict with ${cooler.n} (${cooler.ramClear}mm clearance)`,cat:"Cooler+RAM"});
  // Fan count check
  if(allFanList.length&&cas){const aioFans=cooler?.coolType?.includes("360")?3:cooler?.coolType?.includes("280")?2:cooler?.coolType?.includes("240")?2:0;
    const caseFanTotal=allFanList.reduce((s,f)=>s+(f.packQty||1),0);const totalFans=caseFanTotal+aioFans;
    if(totalFans>(cas.maxFans120||6))warnings.push({t:"w",m:`${totalFans} total fans may exceed ${cas.n} capacity`,cat:"Fans"});}
  // M.2 / SATA slot check
  if(mobo&&allStorageList.length>1){const m2c=allStorageList.filter(s=>s.iface==="M.2").length;const sc=allStorageList.filter(s=>s.iface==="SATA").length;
    if(mobo.m2Slots&&m2c>mobo.m2Slots)warnings.push({t:"w",m:`${m2c} M.2 drives but ${mobo.n} has ${mobo.m2Slots} slots`,cat:"Storage"});
    if(mobo.sataSlots&&sc>mobo.sataSlots)warnings.push({t:"w",m:`${sc} SATA devices but ${mobo.n} has ${mobo.sataSlots} ports`,cat:"Storage"});}
  // Expansion card PCIe slot check
  if(expansionCards.length&&mobo){const gpuSlots=gpu?Math.ceil(gpu.slots||2):0;const avail=(mobo.pciSlots||3)-1-(gpuSlots>2?gpuSlots-2:0);
    if(expansionCards.length>Math.max(avail,1))warnings.push({t:"w",m:`${expansionCards.length} expansion cards may exceed available PCIe slots`,cat:"PCIe"});}
  const allIssues=[...issues,...warnings];

  // Smart compat filter for part picker
  const compat=cat=>{let r=P.filter(x=>x.c===cat&&!x.bundle);
    if(cpu&&cat==="Motherboard")r=r.filter(x=>x.socket===cpu.socket);
    if(mobo&&cat==="CPU")r=r.filter(x=>x.socket===mobo.socket);
    if(mobo&&cat==="RAM"&&mobo.memType)r=r.filter(x=>x.memType===mobo.memType);
    if(cpu&&cat==="RAM"&&cpu.memType)r=r.filter(x=>x.memType===cpu.memType);
    if(cas&&cat==="GPU"&&cas.gpuClear)r=r.filter(x=>!x.gpuLen||x.gpuLen<=cas.gpuClear);
    if(cas&&cat==="CPUCooler"&&cas.coolerClear)r=r.filter(x=>!x.coolerH||x.coolerH<=cas.coolerClear);
    if(cpu&&cat==="CPUCooler")r=r.filter(x=>!x.sockets||x.sockets.includes(cpu.socket));
    if(mobo&&cat==="Case"&&mobo.moboFF){const m2={"ATX":"ATX","mATX":"mATX","Mini-ITX":"ITX","ITX":"ITX"};r=r.filter(x=>!x.moboSupport||x.moboSupport.includes(m2[mobo.moboFF]||mobo.moboFF));}
    if(cas&&cat==="Motherboard"&&cas.moboSupport)r=r.filter(x=>{const m2={"ATX":"ATX","mATX":"mATX","Mini-ITX":"ITX","ITX":"ITX"};return cas.moboSupport.includes(m2[x.moboFF]||x.moboFF);});
    if(gpu&&cat==="PSU"&&gpu.pciPwr)r=r.filter(x=>!x.pciConns||x.pciConns>=gpu.pciPwr);
    if(mobo&&cat==="RAM"&&mobo.maxMem)r=r.filter(x=>!x.capacity||x.capacity<=mobo.maxMem);
    // Bottleneck filter: hide CPUs that would severely bottleneck the selected GPU (>2.0x bench ratio = ~50% bottleneck)
    // Bottleneck filter: hide CPUs that would severely bottleneck the selected GPU
    if(gpu&&cat==="CPU"&&gpu.bench){
      const gb = gpu.bench;
      r=r.filter(x=>{
        // RTX 4000/5000 series require modern CPU sockets (LGA1700+ or AM5)
        const gpuName = (gpu.n || '').toUpperCase();
        const isModernNvidia = /\bRTX\s*[45]\d{3}\b/.test(gpuName);
        if(isModernNvidia){
          const sock = (x.socket || '').toUpperCase();
          const modernSockets = ['LGA1700','LGA1851','AM5'];
          if(sock && !modernSockets.includes(sock)) return false;
        }
        // Hide server/workstation CPUs and obvious budget chips when GPU is mid-tier+
        if(gb>=60){
          const nm = (x.n||'').toLowerCase();
          if(/\bxeon\b/.test(nm)) return false;
          if(/\bathlon\b/.test(nm)) return false;
          if(/\bpentium\b/.test(nm)) return false;
          if(/\bceleron\b/.test(nm)) return false;
          if(/\begpu\b/.test(nm)) return false;
          if(/\bdock\b/.test(nm)) return false;
        }
        // If we have bench data, enforce the 50% bottleneck threshold (GPU/CPU ratio <= 2.0)
        if(x.bench) return (gb/x.bench) <= 2.0;
        // No bench data: only allow through if GPU is low-tier (< 60 bench, budget territory)
        return gb < 60;
      });
    }
    return r;};

  const specSummary=(cat,p)=>{if(!p)return"";
    if(cat==="CPU")return `${p.cores}C · ${p.socket} · ${p.tdp}W`;
    if(cat==="GPU")return `${p.vram}GB · ${p.tdp}W · ${p.gpuLen||"?"}mm`;
    if(cat==="RAM")return `${p.capacity}GB ${p.memType||""} ${p.speed}MHz`;
    if(cat==="Motherboard")return `${p.socket} · ${p.formFactor} · ${p.m2Slots||"?"}x M.2`;
    if(cat==="Storage")return `${p.capacity>=1000?(p.capacity/1000)+"TB":p.capacity+"GB"} ${p.storageType||""}`;
    if(cat==="PSU")return `${p.watt}W ${p.efficiency} · ${p.modular}`;
    if(cat==="Case")return `${p.ff||p.formFactor} · GPU ${p.maxGPU||p.gpuClear||"?"}mm · ${p.rads||"No AIO info"}`;
    if(cat==="CPUCooler")return `${p.coolType} · ${p.coolerH||"?"}mm`;
    if(cat==="CaseFan")return `${p.fanSize}mm · ${p.packQty||1}x · ${p.airflow||"?"}CFM`;
    if(cat==="Monitor")return `${p.size}" ${p.panel} ${p.resolution} ${p.refreshRate}Hz`;
    return Object.entries(p).filter(([k])=>!["id","n","c","b","pr","r","cp","off","deals","msrp","url","img","bench","condition","generation","chipset","uid","upc"].includes(k)&&p[k]!=null&&typeof p[k]!=="object").slice(0,2).map(([k,v])=>`${fmt(k,v)}`).join(" · ");};

  // ── Render a builder section ──
  const renderSection=(section)=>{
    const isOpen=openSections[section.id];
    const sectionParts=section.cats.filter(c=>build[c]||(multiParts[c]||[]).length);
    const sectionTotal=section.cats.reduce((s,c)=>{
      if(build[c])return s+$(build[c]);
      return s+(multiParts[c]||[]).reduce((t,p)=>t+$(p),0);
    },0);
    return <div key={section.id} style={{marginBottom:8}}>

      <button onClick={()=>toggleSection(section.id)} style={{display:"flex",width:"100%",alignItems:"center",gap:8,padding:"10px 16px",background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:isOpen?"10px 10px 0 0":"10px",cursor:"pointer",textAlign:"left"}}>
        <SectionIcon name={section.icon} size={17}/>
        <span style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:"var(--txt)",flex:1}}>{section.label}</span>
        {sectionParts.length>0&&<span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--mint)"}}>{sectionParts.length} items · ${sectionTotal}</span>}
        <span style={{color:"var(--mute)",fontSize:13}}>{isOpen?"−":"+"}</span>
      </button>
      {isOpen&&<div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderTop:"none",borderRadius:"0 0 10px 10px",overflow:"hidden"}}>
        {section.cats.map((cat,ci)=>{
          const meta=CAT[cat];if(!meta)return null;
          const isMulti=meta.multi;
          const part=isMulti?null:build[cat];
          const parts=isMulti?(multiParts[cat]||[]):[];
          const isPicking2=picking===cat;
          const compatList=compat(cat);
          const maxQty=meta.maxQty||1;
          const canAdd=isMulti?parts.length<maxQty:!part;

          return <div key={cat}>
            {/* Row */}
            <div className="builder-picker-row" style={{display:"grid",gridTemplateColumns:"130px 1fr 180px 70px 40px",gap:0,padding:"10px 16px",alignItems:"center",borderBottom:"1px solid var(--bdr)",cursor:canAdd?"pointer":"default",background:isPicking2?"var(--sky)06":"transparent"}}
              onClick={()=>canAdd&&setPicking(isPicking2?null:cat)}>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <CatIcon c={cat} size={15}/>
                <div><div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)"}}>{meta.singular||meta.label}</div>
                <div style={{fontFamily:"var(--mono)",fontSize:7,color:"var(--mute)"}}>{compatList.length} options</div></div>
              </div>
              <div>
                {part?<div><div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)"}}>{cleanProductName(part)}</div>
                  <div style={{display:"flex",gap:4,alignItems:"center",marginTop:1}}><span style={{fontSize:9,color:"var(--dim)"}}>{part.b}</span><Stars r={part.r} s={8}/>{part.cp&&<Tag color="var(--amber)">-${part.off}</Tag>}</div></div>
                :isMulti&&parts.length?<div>{parts.map((p,pi)=><div key={p.uid} style={{display:"flex",alignItems:"center",gap:4,marginBottom:1}}>
                    <span style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--txt)",flex:1}}>{cleanProductName(p)}</span>
                    <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--mint)"}}>${fmtPrice($(p))}</span>
                    <button onClick={e=>{e.stopPropagation();delMulti(cat,p.uid);}} style={{background:"none",border:"none",color:"var(--rose)",fontSize:10,cursor:"pointer",padding:0}}>✕</button>
                  </div>)}{canAdd&&<button onClick={e=>{e.stopPropagation();setPicking(cat);}} style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--sky)",background:"none",border:"none",cursor:"pointer",padding:0}}>+ Add another</button>}</div>
                :<button onClick={e=>{e.stopPropagation();setPicking(isPicking2?null:cat);}} style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--sky)",background:"var(--sky)08",border:"1px dashed var(--sky)33",borderRadius:5,padding:"4px 10px",cursor:"pointer"}}>+ Choose {meta.singular||cat}</button>}
              </div>
              <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--txt)",opacity:.7}}>{part?specSummary(cat,part):isMulti&&parts.length?parts.length+" selected":""}</div>
              <div style={{textAlign:"right"}}>{part?<div style={{fontFamily:"var(--mono)",fontSize:14,fontWeight:700,color:"var(--mint)"}}>${fmtPrice($(part))}</div>
                :isMulti&&parts.length?<div style={{fontFamily:"var(--mono)",fontSize:14,fontWeight:700,color:"var(--mint)"}}>${parts.reduce((s,p)=>s+$(p),0)}</div>
                :<span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mute)"}}>—</span>}</div>
              <div style={{textAlign:"center"}}>{part&&<button onClick={e=>{e.stopPropagation();del(cat);}} style={{background:"none",border:"none",color:"var(--rose)",fontSize:13,cursor:"pointer",opacity:.5}}>✕</button>}</div>
            </div>

          </div>;
        })}
      </div>}
    </div>;
  };

  // ── Full-page part picker ──
  const renderPicker = () => {
    const cat = picking;
    const meta = CAT[cat]; if (!meta) return null;
    const isMulti = meta.multi;
    const compatList = compat(cat);
    const cols = meta.cols || [];
    const onAdd = (p) => { if (isMulti) addMulti(cat, p); else add(p); };

    return <BuilerPartPickerRouter
      cat={cat} meta={meta} cols={cols} compatList={compatList}
      onAdd={onAdd} onBack={() => setPicking(null)} isMulti={isMulti}
      build={build}
    />;
  };

  if (picking && CAT[picking]) return renderPicker();

  return (
    <div className="fade" style={{maxWidth:1600,margin:"0 auto",padding:"28px 20px"}}>
      {showConfetti&&<div style={{position:"fixed",inset:0,zIndex:999,pointerEvents:"none",display:"flex",alignItems:"center",justifyContent:"center"}}><div style={{fontSize:64,animation:"fIn .5s ease-out"}}>🎉🎊🎉</div></div>}

      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20,flexWrap:"wrap",gap:12}}>
        <div>
          <input value={buildName} onChange={e=>setBuildName(e.target.value)} style={{background:"none",border:"none",borderBottom:"1px dashed var(--mute)",fontFamily:"var(--ff)",fontSize:24,fontWeight:800,color:"var(--txt)",outline:"none",padding:"2px 0",width:280}}/>
          <div style={{display:"flex",gap:8,alignItems:"center",marginTop:6}}>
            <Tag color="var(--mint)">{tier}</Tag>
            <span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)"}}>{coreFilled}/8 core · ${fmtPrice(total)}</span>
            {(coreFilled>0||Object.keys(multiParts).length>0)&&<button onClick={()=>{if(window.confirm("Clear everything and start over?")){setBuild({});setMultiParts({});setPicking(null);setBuildName("My Build");setBuildBudget(0);prevCount.current=0;}}} style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--rose)",background:"none",border:"1px solid var(--rose)33",borderRadius:4,padding:"2px 8px",cursor:"pointer"}}>🔄 Start Over</button>}
            {coreFilled>=2&&<button onClick={()=>{const ids=Object.values(build).map(p=>p.id);const data=btoa(JSON.stringify({n:buildName,ids}));const url=window.location.origin+"/#build?d="+data;navigator.clipboard.writeText(url);alert("Build link copied to clipboard!\n\n"+url);}} style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--sky)",background:"none",border:"1px solid var(--sky)33",borderRadius:4,padding:"2px 8px",cursor:"pointer"}}>🔗 Share Build</button>}
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          {/* Budget Tracker */}
          <div style={{textAlign:"center"}}>
            <div style={{fontFamily:"var(--mono)",fontSize:7,color:"var(--dim)",letterSpacing:1}}>BUDGET</div>
            <input type="number" value={buildBudget||""} onChange={e=>setBuildBudget(+e.target.value||0)} placeholder="Set $" style={{width:65,background:"var(--bg4)",border:`1px solid ${buildBudget>0&&total>buildBudget?"var(--rose)":"var(--bdr)"}`,borderRadius:4,padding:"2px 4px",fontSize:13,color:buildBudget>0&&total>buildBudget?"var(--rose)":"var(--mint)",fontFamily:"var(--mono)",fontWeight:700,textAlign:"center",outline:"none"}}/>
            {buildBudget>0&&<div style={{fontFamily:"var(--mono)",fontSize:8,color:total>buildBudget?"var(--rose)":"var(--mint)",marginTop:2}}>{total>buildBudget?`$${total-buildBudget} over`:`$${buildBudget-total} left`}</div>}
          </div>
          {/* Power */}
          <div style={{textAlign:"center"}}><div style={{fontFamily:"var(--mono)",fontSize:7,color:"var(--dim)",letterSpacing:1}}>POWER</div>
            <div style={{fontFamily:"var(--mono)",fontSize:17,fontWeight:700,color:psu&&tdp>psu.watt?"var(--rose)":"var(--txt)"}}>{tdp}W</div>
            {psu&&<div style={{width:50,height:3,background:"var(--bg4)",borderRadius:2,overflow:"hidden",margin:"2px auto"}}><div style={{width:`${Math.min(Math.round(tdp/psu.watt*100),100)}%`,height:"100%",background:tdp>psu.watt*.85?"var(--amber)":"var(--mint)",borderRadius:2}}/></div>}
            {psu&&<div style={{fontFamily:"var(--mono)",fontSize:7,color:"var(--dim)",marginTop:1}}>~${(tdp*0.12*24*30/1000).toFixed(0)}/mo</div>}</div>
          {/* Total */}
          <div style={{textAlign:"right"}}><div style={{fontFamily:"var(--mono)",fontSize:7,color:"var(--dim)",letterSpacing:1}}>TOTAL</div>
            <div style={{fontFamily:"var(--mono)",fontSize:24,fontWeight:700,color:buildBudget>0&&total>buildBudget?"var(--rose)":total>0?"var(--mint)":"var(--mute)"}}>${fmtPrice(total)}</div></div>
          <div style={{position:"relative",width:50,height:50}}><svg width={50} height={50} style={{transform:"rotate(-90deg)"}}><circle cx={25} cy={25} r={ringR} fill="none" stroke="var(--bg4)" strokeWidth={3}/><circle cx={25} cy={25} r={ringR} fill="none" stroke={pct===100?"var(--mint)":"var(--sky)"} strokeWidth={3} strokeDasharray={ringC} strokeDashoffset={ringC*(1-pct/100)} strokeLinecap="round" style={{transition:"stroke-dashoffset .6s"}}/></svg><div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{fontFamily:"var(--mono)",fontSize:13,fontWeight:700,color:pct===100?"var(--mint)":"var(--txt)"}}>{pct}%</span></div></div>
        </div>
      </div>

      {/* Budget warning */}
      {buildBudget>0&&total>buildBudget&&<div style={{padding:"8px 12px",borderRadius:6,fontSize:13,fontFamily:"var(--ff)",background:"#ff5c7c08",color:"var(--rose)",border:"1px solid #ff5c7c18",marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
        💸 <span style={{fontWeight:600}}>${fmtPrice(total-buildBudget)} over budget!</span> Your build is ${fmtPrice(total)} but your budget is ${fmtPrice(buildBudget)}. Consider swapping components for cheaper alternatives.
      </div>}

      {/* Compat alerts */}
      {allIssues.length>0&&<div style={{display:"flex",flexDirection:"column",gap:3,marginBottom:14}}>
        {allIssues.map((x,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:6,padding:"6px 12px",borderRadius:6,fontSize:10,fontFamily:"var(--ff)",background:x.t==="err"?"#ff5c7c08":"#ffb34708",color:x.t==="err"?"var(--rose)":"var(--amber)",border:`1px solid ${x.t==="err"?"#ff5c7c18":"#ffb34718"}`}}>
          <span>{x.t==="err"?"⛔":"⚠️"}</span><span style={{fontFamily:"var(--mono)",fontSize:7,fontWeight:600,opacity:.6}}>{x.cat}</span><span style={{flex:1}}>{x.m}</span></div>)}
      </div>}
      {allIssues.length===0&&coreFilled>=2&&<div style={{padding:"6px 12px",borderRadius:6,fontSize:10,fontFamily:"var(--ff)",background:"var(--mint3)",color:"var(--mint)",border:"1px solid var(--mint)22",marginBottom:14}}>✅ All components compatible</div>}

      {/* === GETTING STARTED BANNER === */}
      {coreFilled === 0 && <div style={{marginBottom:20}}>
        <div style={{borderLeft:"3px solid var(--accent)",background:"var(--accent3)",padding:"16px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:16,flexWrap:"wrap"}}>
          <div style={{flex:1,minWidth:240}}>
            <div style={{fontFamily:"var(--ff-display)",fontSize:18,fontWeight:600,color:"var(--txt)",marginBottom:4}}>Don't know where to start?</div>
            <div style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--dim)",lineHeight:1.5}}>Check out our Build Wizard. Tell it your budget and use case, and it'll build a fully compatible parts list for you.</div>
          </div>
          <button onClick={()=>{try{window.location.href="/tools/build-wizard"}catch(e){}}} style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:600,padding:"12px 22px",background:"var(--accent)",color:"var(--bg)",border:"none",cursor:"pointer",whiteSpace:"nowrap"}}>Open Build Wizard &rarr;</button>
        </div>
      </div>}
      <div className="builder-grid" style={{display:"grid",gridTemplateColumns:"1fr 360px",gap:24,alignItems:"start"}}>
        <div>
        {/* Builder sections */}
        {BUILDER_SECTIONS.map(s=>renderSection(s))}
  
        {/* FPS Estimator */}
        <div style={{marginTop:16}}><BuilderFPS gpu={gpu} cpu={cpu} ram={ram}/></div>
        </div>
        <div className="builder-buy-col">
        {coreFilled>=1&&<BuyYourBuild build={build} multiParts={multiParts}/>}
        </div>
      </div>
    </div>
  );
}


/* ═══ COMMUNITY ═══ */
function CommunityPage({th}){
  const tierColor=t=>t==="Excellent"?"var(--mint)":t==="Great"?"var(--sky)":t==="Smooth"?"var(--amber)":t==="Playable"?"var(--rose)":"var(--mute)";
  return <div className="fade" style={{maxWidth:1180,margin:"0 auto",padding:"28px 20px"}}>
    <h2 style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--txt)",marginBottom:16}}>Community Builds</h2>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      {BUILDS.map(b=>{
        const parts=b.ids.map(fp).filter(Boolean);
        const tot=parts.reduce((s,p)=>s+$(p),0);
        const gpu=parts.find(p=>p.c==="GPU");
        const cpu=parts.find(p=>p.c==="CPU");
        const gpuKey=gpu?matchGPU(gpu.n):null;
        const cpuKey=cpu?matchCPU(cpu.n):null;
        const fpsGames=(gpuKey&&cpuKey)?estimateAllGames(gpuKey,cpuKey,"1080p","Ultra").slice(0,10):[];
        const avgFps=fpsGames.length?Math.round(fpsGames.reduce((s,g)=>s+g.fps,0)/fpsGames.length):0;
        return <div key={b.id} style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:16}}>
          <div style={{display:"flex",justifyContent:"space-between"}}>
            <div>
              <div style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:700,color:"var(--txt)"}}>{b.nm}</div>
              <div style={{fontSize:10,color:"var(--dim)",fontFamily:"var(--ff)"}}>by {b.by}</div>
            </div>
            <span style={{fontFamily:"var(--mono)",fontSize:13,color:"var(--amber)",fontWeight:600}}>▲{b.v}</span>
          </div>
          <p style={{fontSize:13,color:"var(--dim)",margin:"6px 0",fontFamily:"var(--ff)"}}>{b.d}</p>
          <div style={{display:"flex",gap:3}}>{b.tags.map(t=><Tag key={t} color="var(--sky)">{t}</Tag>)}</div>
          <div style={{marginTop:10,paddingTop:8,borderTop:"1px solid var(--bdr)"}}>
            {parts.map(p=><div key={p.id} style={{display:"flex",justifyContent:"space-between",padding:"2px 0"}}>
              <span style={{fontSize:10,color:"var(--txt)",fontFamily:"var(--ff)"}}>{ic(p)} {p.n}</span>
              <span style={{fontSize:10,color:"var(--mint)",fontFamily:"var(--mono)"}}>${fmtPrice($(p))}</span>
            </div>)}
          </div>
          {fpsGames.length>0&&<div style={{marginTop:10,paddingTop:8,borderTop:"1px solid var(--bdr)"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",letterSpacing:0.5}}>PERFORMANCE @ 1080p ULTRA</span>
              <span style={{fontFamily:"var(--mono)",fontSize:13,fontWeight:700,color:"var(--sky)"}}>{avgFps} AVG FPS</span>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"2px 10px"}}>
              {fpsGames.map(g=>{
                const game=GAMES.find(x=>x.name===g.game);
                const color=tierColor(g.tier);
                return <div key={g.game} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"1px 0",minWidth:0}}>
                  <span style={{fontSize:10,color:"var(--txt)",fontFamily:"var(--ff)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",flex:1,minWidth:0}} title={g.game}>{game?.icon||"🎮"} {g.game}</span>
                  <span style={{fontSize:10,color,fontFamily:"var(--mono)",fontWeight:700,marginLeft:4,flexShrink:0}}>{g.fps}</span>
                </div>;
              })}
            </div>
          </div>}
          <div style={{display:"flex",justifyContent:"space-between",marginTop:8,paddingTop:6,borderTop:"1px solid var(--bdr)"}}>
            <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)"}}>Total</span>
            <span style={{fontFamily:"var(--mono)",fontSize:17,color:"var(--mint)",fontWeight:700}}>${tot}</span>
          </div>
        </div>;
      })}
    </div>
  </div>;
}

/* ═══ TOOLS ═══ */
// === TOOL SEO CONFIG ===
const TOOL_URL_SLUGS = {
  fps: 'fps-estimator',
  bn: 'bottleneck-calculator',
  willitrun: 'will-it-run',
  buildcmp: 'compare-builds',
  wizard: 'build-wizard',
  power: 'power-calculator',
  cmp: 'compare-parts',
};
const TOOL_SLUG_TO_ID = Object.fromEntries(Object.entries(TOOL_URL_SLUGS).map(([id,slug])=>[slug,id]));
const TOOL_SEO_DATA = {
  fps: {
    title: 'FPS Estimator — See Game FPS for Your CPU + GPU at 1080p, 1440p, 4K',
    description: 'Free FPS estimator for PC builds. Pick your CPU and GPU to see expected FPS in popular games at 1080p, 1440p, and 4K. Covers Cyberpunk, Valorant, Fortnite, Elden Ring and more.',
    h1: 'FPS Estimator',
    intro: 'Estimate frames per second for any GPU + CPU combo across 26 popular games and three resolutions. Free, no signup.',
    faq: [
      {q:'How accurate is this FPS estimator?',a:'Our estimates are based on benchmark scores, PassMark CPU/GPU data, and resolution scaling. Real-world FPS can vary ±10-15% depending on settings, drivers, RAM speed, and game-specific optimization.'},
      {q:'Does CPU choice matter for FPS?',a:'Yes, especially at 1080p where CPU is the main bottleneck. At 4K the GPU does most of the work. We weight CPU impact differently per resolution to give realistic estimates.'},
      {q:'What games can I check?',a:'Cyberpunk 2077, Valorant, Fortnite, Elden Ring, CS2, Call of Duty, Apex Legends, Baldurs Gate 3, Starfield, Hogwarts Legacy, Spider-Man, and more — 26 games total covering esports and AAA titles.'},
      {q:'Why is my GPU not in the list?',a:'We cover NVIDIA RTX 40/50, RTX 30/20 series, AMD RX 7000/9000/6000, Intel Arc A/B series. Older cards default to a closest-match baseline. Add a comment if you want yours added.'}
    ],
    howTo: [
      'Pick your GPU from the dropdown - search by model like "RTX 4070 Ti" or "RX 9070 XT".',
      'Pick your CPU - search by name like "Ryzen 7 7800X3D" or "Intel Core i7-13700K".',
      'Choose your target resolution: 1080p, 1440p, or 4K.',
      'Select quality preset (Low/Medium/High/Ultra) - we estimate FPS for all four.',
      'Click "Estimate FPS" to see expected frame rates across 26 popular games.'
    ]
  },
  bn: {
    title: 'Bottleneck Calculator — Find Your CPU or GPU Bottleneck (PassMark Data)',
    description: 'Free bottleneck calculator using real PassMark scores. Check whether your CPU or GPU is holding back performance at 1080p, 1440p, or 4K. Resolution-aware, accurate.',
    h1: 'Bottleneck Calculator',
    intro: 'Find out if your CPU or GPU is the weak link. Resolution-aware analysis using real PassMark benchmark data.',
    faq: [
      {q:'How is bottleneck calculated?',a:'We compare your CPU PassMark score to the score required to keep up with your GPU at the chosen resolution. 1080p needs a stronger CPU; 4K shifts most work to the GPU. The deficit is your bottleneck percentage.'},
      {q:'What is a balanced PC build?',a:'A build is balanced when both CPU and GPU are within ~10% of their ideal pairing for the resolution you play at. Our calculator reports "Balanced" when neither component holds back the other.'},
      {q:'Does resolution affect bottleneck?',a:'Yes, significantly. The same CPU + GPU pair can be CPU-bottlenecked at 1080p but balanced at 4K. We compute separate target scores for 1080p, 1440p, and 4K.'},
      {q:'Should I always upgrade the bottleneck?',a:'Not always. A 5-10% bottleneck is normal and not worth fixing. Upgrade when the bottleneck is 15%+ AND you actually game at the affected resolution.'}
    ],
    howTo: [
      'Select your GPU from the dropdown.',
      'Select your CPU.',
      'Pick the resolution you actually play at (1080p stresses CPU more, 4K stresses GPU more).',
      'Click "Analyze Bottleneck" to see which component is holding back performance.',
      'Review the recommended upgrade path - we suggest the minimum upgrade to balance the build.'
    ]
  },
  willitrun: {
    title: 'Will It Run? — PC Game Compatibility Checker (Free)',
    description: 'Free game compatibility checker. Pick a game and your hardware to see if your PC can run it at Low, Medium, High, or Ultra. Covers 26 popular PC games.',
    h1: 'Will It Run?',
    intro: 'Check whether your PC can run any specific game at Low/Medium/High/Ultra settings before you buy.',
    faq: [
      {q:'How does the Will It Run checker work?',a:'Pick a game and your CPU + GPU. We estimate frame rates at every quality preset using benchmark data, so you can see if you hit 60+ FPS at your preferred settings.'},
      {q:'What FPS counts as playable?',a:'For most singleplayer games, 60 FPS is the sweet spot. Competitive shooters benefit from 120-144+ FPS. We highlight which presets reach those targets.'},
      {q:'Are the FPS results accurate?',a:'Estimates are within ±10-15% of real-world performance. Driver versions, OS, background apps, RAM speed, and storage type can all affect actual FPS.'},
      {q:'Can I check older games?',a:'Most older AAA games run on virtually any modern PC. Our list focuses on demanding 2022-2026 titles where compatibility is the actual question.'}
    ],
    howTo: [
      'Pick the game you want to check from the dropdown.',
      'Select your GPU and CPU.',
      'Choose the resolution you want to play at.',
      'Click "Check Performance" to see expected FPS at Low, Medium, High, and Ultra.',
      'Look for the highest preset that gives you 60+ FPS for smooth gameplay.'
    ]
  },
  buildcmp: {
    title: 'Compare PC Builds — Side-by-Side Performance & Value Comparison',
    description: 'Compare two PC builds side-by-side. See expected FPS, total cost, performance per dollar, and bottlenecks for both. Free build comparison tool.',
    h1: 'Compare PC Builds',
    intro: 'Stack two builds against each other. See FPS, cost, and value-per-dollar for each.',
    faq: [
      {q:'How do I compare PC builds?',a:'Pick a CPU and GPU for Build A, then for Build B. We score each on FPS, total price, and performance per dollar so you can pick the better value.'},
      {q:'What is performance per dollar?',a:'It measures how much gaming performance you get for every dollar spent on CPU + GPU. Higher is better. Useful when deciding between similar-priced configurations.'},
      {q:'Can I compare more than CPU + GPU?',a:'For now, we compare CPU + GPU since those drive 80%+ of gaming performance. RAM, storage, and PSU comparisons are on the roadmap.'}
    ],
    howTo: [
      'Select Build A: pick a CPU and GPU combination.',
      'Select Build B: pick a different CPU and GPU combination.',
      'Click "Compare Builds" to see side-by-side results.',
      'Review FPS estimates, total cost, and performance per dollar for both builds.',
      'Use the winner to inform your next purchase decision.'
    ]
  },
  wizard: {
    title: 'PC Build Wizard — Auto-Generate a Balanced Build for Any Budget',
    description: 'Free PC build wizard. Enter your budget and use case — we auto-generate a balanced gaming PC build with current pricing from Amazon, Best Buy, and more.',
    h1: 'PC Build Wizard',
    intro: 'Tell us your budget and we will auto-generate a balanced PC build using live retailer pricing.',
    faq: [
      {q:'How does the build wizard work?',a:'Enter a budget and select your target resolution and use case. The wizard picks compatible components within your budget, prioritizing balance between CPU and GPU.'},
      {q:'What budget should I use?',a:'$700-1000 for 1080p gaming, $1200-1800 for 1440p, $2000+ for 4K. The wizard gives the best fit at any budget; quality scales with spend.'},
      {q:'Are the components compatible?',a:'Yes, the wizard validates CPU socket, RAM type (DDR4/DDR5), motherboard chipset, PSU wattage, and case form factor. Compatibility is checked end-to-end.'},
      {q:'Can I customize the wizard build?',a:'Yes, after generation you can swap any component in the PC Builder. The wizard gives you a starting point; you keep full control.'}
    ],
    howTo: [
      'Set your total budget using the slider ($300 to $8,000).',
      'Pick your target use case (gaming resolution, productivity, etc.).',
      'Click "Generate Build" - we pick balanced compatible components within your budget.',
      'Review the generated build with current pricing from Amazon, Best Buy, and others.',
      'Send the build to PC Builder if you want to swap any individual components.'
    ]
  },
  power: {
    title: 'PC Power Supply Calculator — Find the Right PSU Wattage',
    description: 'Free PSU calculator for PC builds. Add your CPU, GPU, and other components to see exact wattage needed. Get PSU wattage recommendations with headroom.',
    h1: 'PC Power Supply Calculator',
    intro: 'Calculate exact PSU wattage for your build. Includes headroom recommendations for safety and efficiency.',
    faq: [
      {q:'What PSU wattage do I need?',a:'Add up TDP of all components, then add 30% headroom for transient spikes and PSU efficiency. Most modern gaming PCs need 650-850W; high-end RTX 4090/5090 builds need 1000-1200W.'},
      {q:'What does 80+ rating mean?',a:'80+ rates PSU efficiency at typical load: Bronze 82%+, Gold 87%+, Platinum 90%+. Higher is better but costs more. Gold is the sweet spot for most builds.'},
      {q:'Do I need a bigger PSU for overclocking?',a:'Yes, add another 10-20% on top of the 30% headroom for overclocked CPU + GPU builds. Power draw can spike well above stock TDP.'},
      {q:'Single rail vs multi rail PSU?',a:'For modern builds, single +12V rail is preferred. Multi-rail was useful before per-rail OCP, but single rail handles the high-power spikes of modern GPUs better.'}
    ],
    howTo: [
      'Add your CPU and GPU - the highest-draw components.',
      'Add storage drives, fans, RGB strips, and other peripherals.',
      'See total wattage with safety headroom (30% extra).',
      'Get a PSU wattage recommendation: 650W, 750W, 850W, 1000W, etc.',
      'Filter PSUs by wattage and 80+ rating to find a good match.'
    ]
  },
  cmp: {
    title: 'Compare PC Parts — Side-by-Side CPU, GPU, and Component Comparison',
    description: 'Compare any two PC components side-by-side. See benchmarks, specs, prices, and current deals. Free parts comparison for CPUs, GPUs, motherboards, and more.',
    h1: 'Compare PC Parts',
    intro: 'Compare any two parts: CPU, GPU, motherboard, RAM, storage. Specs, benchmarks, and current pricing.',
    faq: [
      {q:'How do I compare two CPUs or GPUs?',a:'Pick any two parts of the same category. We display specs, benchmark scores, current pricing across retailers, and deals side-by-side.'},
      {q:'What benchmark do you use?',a:'PassMark for CPU and GPU performance. PassMark is one of the largest community-driven benchmark databases with consistent multi-year data across millions of systems.'},
      {q:'Can I compare across retailers?',a:'Yes, we show current pricing for each part across Amazon, Best Buy, Newegg, B&H, and Antonline. The lowest in-stock price wins.'}
    ],
    howTo: [
      'Pick category: CPU, GPU, motherboard, RAM, storage, etc.',
      'Select Part A from the dropdown.',
      'Select Part B (must be same category).',
      'Click "Compare" to see all specs and prices side-by-side.',
      'Review benchmarks, current deals, and which retailer has the best in-stock price.'
    ]
  }
};
// === END TOOL SEO CONFIG ===

function ToolsPage({th}){
  // Read tool from URL hash on mount: #tools/fps-estimator -> "fps"
  const [tool,setToolRaw]=useState(()=>{
    const path=(window.location.pathname||'').replace(/^\//,'');
    const parts=path.split('/');
    if(parts[0]==='tools'&&parts[1]&&TOOL_SLUG_TO_ID[parts[1]])return TOOL_SLUG_TO_ID[parts[1]];
    // Fallback: also handle legacy #tools/x URLs
    const hash=(window.location.hash||'').replace(/^#/,'');
    const hashParts=hash.split('/');
    if(hashParts[0]==='tools'&&hashParts[1]&&TOOL_SLUG_TO_ID[hashParts[1]])return TOOL_SLUG_TO_ID[hashParts[1]];
    return 'fps';
  });
  // Wrapper: set state and update URL hash
  const setTool=React.useCallback((id)=>{
    setToolRaw(id);
    const slug=TOOL_URL_SLUGS[id];
    if(slug)window.history.replaceState(null,'','/tools/'+slug);
  },[]);
  // Listen for hash changes (e.g., browser back/forward)
  React.useEffect(()=>{
    const handler=()=>{
      const path=(window.location.pathname||'').replace(/^\//,'');
      const parts=path.split('/');
      if(parts[0]==='tools'&&parts[1]&&TOOL_SLUG_TO_ID[parts[1]]){
        setToolRaw(TOOL_SLUG_TO_ID[parts[1]]);
      }
    };
    window.addEventListener('popstate',handler);
    return ()=>window.removeEventListener('popstate',handler);
  },[]);
  // FPS tool state
  const [selGPU,setSelGPU]=useState("");const [selCPU,setSelCPU]=useState("");const [selRes,setSelRes]=useState("1080p");const [selQual,setSelQual]=useState("Ultra");const [fpsResults,setFpsResults]=useState(null);
  const [selRAMSpeed,setSelRAMSpeed]=useState(5600);const [selRAMCap,setSelRAMCap]=useState(32);const [selRAMType,setSelRAMType]=useState("DDR5");
  // Compare state
  const [cA,setCA]=useState("");const [cB,setCB]=useState("");const [cmpResult,setCmpResult]=useState(null);

  const gpuParts=SEED_PARTS.filter(p=>p.c==="GPU");
  const cpuParts=SEED_PARTS.filter(p=>p.c==="CPU");

  const [fpsLoading,setFpsLoading]=useState(false);
  const runFPS=async()=>{
    const gpu=matchGPU(selGPU)||selGPU;const cpu=matchCPU(selCPU)||selCPU;
    if(!gpu||!cpu)return;
    const ramInfo={speed:selRAMSpeed,capacity:selRAMCap,memType:selRAMType};
    setFpsLoading(true);
    // Try API first
    const apiResult=await apiFetch("/fps/estimate",{gpu,cpu,resolution:selRes,quality:selQual,ram:ramInfo});
    if(apiResult&&apiResult.games){
      setFpsResults({gpu,cpu,res:selRes,qual:selQual,ram:ramInfo,games:apiResult.games});
    } else {
      // Fallback to local
      const results=estimateAllGames(gpu,cpu,selRes,selQual,ramInfo);
      setFpsResults({gpu,cpu,res:selRes,qual:selQual,ram:ramInfo,games:results});
    }
    setFpsLoading(false);
  };

  const cmp=()=>{const a=SEED_PARTS.find(p=>p.n.toLowerCase().includes(cA.toLowerCase()));const b=SEED_PARTS.find(p=>p.n.toLowerCase().includes(cB.toLowerCase()));if(a&&b)setCmpResult({a,b});};

  // Bottleneck calculator state
  const [bnGPU,setBnGPU]=useState("");const [bnCPU,setBnCPU]=useState("");const [bnRes,setBnRes]=useState("1080p");const [bnResult,setBnResult]=useState(null);
  const [bnLoading,setBnLoading]=useState(false);
  const runBottleneck=async()=>{
    const gpuKey=matchGPU(bnGPU)||bnGPU;const cpuKey=matchCPU(bnCPU)||bnCPU;
    if(!gpuKey||!cpuKey)return;
    setBnLoading(true);
    // Skip API call - use accurate local PassMark-based calculation
    const apiResult=null;
    if(apiResult&&apiResult.who){
      setBnResult({gpuKey:apiResult.gpu,cpuKey:apiResult.cpu,gpuScore:apiResult.gpuScore,cpuScore:apiResult.cpuScore,who:apiResult.who,severity:apiResult.severity,cpuPct:apiResult.who==="CPU"?apiResult.severity:0,gpuPct:apiResult.who==="GPU"?apiResult.severity:0,ratio:apiResult.ratio,cpuUpgrade:apiResult.cpuUpgrade,gpuUpgrade:apiResult.gpuUpgrade,res:bnRes,gameResults:apiResult.gameResults||[]});
    } else {
      // Fallback to local — uses raw PassMark scores when available
      // Find product objects: bnGPU/bnCPU hold the full product name from the dropdown
      const cpuProd=P.find(x=>x.c==="CPU"&&x.n===bnCPU);
      const gpuProd=P.find(x=>x.c==="GPU"&&x.n===bnGPU);
      let cpuPct,gpuPct,who,severity,ratio,gpuScore,cpuScore;
      if(cpuProd?.cpuMark&&gpuProd?.g3dMark){
        // Real PassMark scores: use empirical resolution-aware ratio
        // The "ideal CPU mark" for a GPU at each resolution is roughly:
        //   1080p: g3dMark * 1.40 (CPU work dominates)
        //   1440p: g3dMark * 1.05 
        //   4K:    g3dMark * 0.75 (GPU does heavy lifting)
        const targetMultiplier=bnRes==="4K"?0.75:bnRes==="1440p"?1.05:1.40;
        const idealCpuMark=gpuProd.g3dMark*targetMultiplier;
        const cpuDeficit=Math.max(0,(idealCpuMark-cpuProd.cpuMark)/idealCpuMark);
        const cpuOverkill=Math.max(0,(cpuProd.cpuMark-idealCpuMark*1.30)/(idealCpuMark*1.30));
        cpuPct=Math.round(cpuDeficit*100);
        gpuPct=Math.round(cpuOverkill*100);
        who=cpuPct>=10?"CPU":gpuPct>=10?"GPU":"Balanced";
        severity=who==="CPU"?cpuPct:who==="GPU"?gpuPct:0;
        ratio=cpuProd.cpuMark/idealCpuMark;
        gpuScore=gpuProd.bench||0;
        cpuScore=cpuProd.bench||0;
      } else {
        // Fallback to old bench-based math if raw scores missing
        gpuScore=GPU_SCORES[gpuKey]||100;cpuScore=CPU_SCORES[cpuKey]||100;
        const cpuWeight=bnRes==="4K"?0.5:bnRes==="1440p"?0.75:1.0;
        const effectiveCPU=cpuScore*cpuWeight;
        ratio=effectiveCPU/gpuScore;
        cpuPct=Math.round(Math.max(0,(1-ratio))*100);
        gpuPct=Math.round(Math.max(0,(ratio-1))*100);
        who=ratio<0.85?"CPU":ratio>1.15?"GPU":"Balanced";
        severity=who==="CPU"?cpuPct:who==="GPU"?gpuPct:0;
      }
      let cpuUpgrade=null,gpuUpgrade=null;
      if(who==="CPU"){const better=Object.entries(CPU_SCORES).filter(([k,v])=>v>cpuScore).sort((a,b)=>a[1]-b[1])[0];if(better)cpuUpgrade={name:better[0],score:better[1],gain:Math.round((better[1]-cpuScore)/cpuScore*100)};}
      if(who==="GPU"){const better=Object.entries(GPU_SCORES).filter(([k,v])=>v>gpuScore&&v<gpuScore*1.5).sort((a,b)=>a[1]-b[1])[0];if(better)gpuUpgrade={name:better[0],score:better[1],gain:Math.round((better[1]-gpuScore)/gpuScore*100)};}
      const gameResults=["Cyberpunk 2077","Valorant","Fortnite","Elden Ring"].map(g=>{const r=estimateFPS(gpuKey,cpuKey,g,bnRes,"Ultra");return r;}).filter(Boolean);
      setBnResult({gpuKey,cpuKey,gpuScore,cpuScore,who,severity,cpuPct,gpuPct,ratio:Math.round(ratio*100),cpuUpgrade,gpuUpgrade,res:bnRes,gameResults});
    }
    setBnLoading(false);
  };

  const tabs=[{id:"fps",l:"🎮 FPS Estimator",c:"var(--sky)"},{id:"bn",l:"🔬 Bottleneck",c:"var(--rose)"},{id:"willitrun",l:"🕹️ Will It Run?",c:"var(--amber)"},{id:"buildcmp",l:"📊 Compare Builds",c:"var(--violet)"},{id:"wizard",l:"🧙 Build Wizard",c:"var(--mint)"},{id:"power",l:"⚡ Power Calculator",c:"var(--sky)"},{id:"cmp",l:"⚖️ Compare Parts",c:"var(--violet)"}];

  // Will It Run state
  const [wirGame,setWirGame]=useState("");const [wirGPU,setWirGPU]=useState("");const [wirCPU,setWirCPU]=useState("");const [wirRes,setWirRes]=useState("1080p");const [wirResult,setWirResult]=useState(null);
  // Build Compare state  
  const [bcBuildA,setBcBuildA]=useState({gpu:"",cpu:""});const [bcBuildB,setBcBuildB]=useState({gpu:"",cpu:""});const [bcResult,setBcResult]=useState(null);
  // Wizard state
  const [wizStep,setWizStep]=useState(0);const [wizUse,setWizUse]=useState("");const [wizBudget,setWizBudget]=useState(1000);const [wizPriority,setWizPriority]=useState("");const [wizResult,setWizResult]=useState(null);
  // Power Calc state
  const [pwCPU,setPwCPU]=useState("");const [pwGPU,setPwGPU]=useState("");const [pwFans,setPwFans]=useState(3);const [pwResult,setPwResult]=useState(null);
  const inp={width:"100%",background:"var(--bg4)",border:"1px solid var(--bdr)",borderRadius:6,padding:"7px 10px",fontSize:13,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none",marginBottom:8};
  const tierColor=t=>t==="Excellent"?"var(--mint)":t==="Great"?"var(--sky)":t==="Smooth"?"var(--amber)":t==="Playable"?"var(--rose)":"var(--mute)";

  return <div className="fade" style={{maxWidth:1536,margin:"0 auto",padding:"28px 20px"}}>
    {(()=>{const seo=TOOL_SEO_DATA[tool];const slug=TOOL_URL_SLUGS[tool];if(!seo)return null;return <SEO key={tool} title={seo.title} description={seo.description} canonical={`https://prorigbuilder.com/#tools/${slug}`} breadcrumb={[{name:'Home',url:'https://prorigbuilder.com/'},{name:'Smart Tools',url:'https://prorigbuilder.com/#tools'},{name:seo.h1,url:`https://prorigbuilder.com/#tools/${slug}`}]} faq={seo.faq}/>;})()}
    <h1 style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--txt)",marginBottom:4}}>{TOOL_SEO_DATA[tool]?.h1||'Smart Tools'}</h1>
    <p style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--dim)",marginBottom:20,maxWidth:940,lineHeight:1.5}}>{TOOL_SEO_DATA[tool]?.intro||'Estimate gaming performance, auto-generate builds, and compare parts.'}</p>
    {/* === TOOL CONTENT === Tab navigation */}
    <div style={{display:"flex",gap:6,marginBottom:20,flexWrap:"wrap"}}>{tabs.map(t=><button key={t.id} onClick={()=>setTool(t.id)} style={{padding:"8px 14px",borderRadius:8,fontSize:13,fontFamily:"var(--ff)",fontWeight:600,cursor:"pointer",background:tool===t.id?t.c+"18":"transparent",color:tool===t.id?t.c:"var(--dim)",border:`1.5px solid ${tool===t.id?t.c+"44":"var(--bdr)"}`,whiteSpace:"nowrap"}}>{t.l}</button>)}</div>

    {/* === HOW-TO + FAQ CONTENT === */}
    {TOOL_SEO_DATA[tool]?.howTo&&<div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:"16px 20px",marginBottom:20}}>
      <h2 style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:700,color:"var(--txt)",marginBottom:10}}>How to use the {TOOL_SEO_DATA[tool].h1}</h2>
      <ol style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.7,paddingLeft:24,marginBottom:0}}>
        {TOOL_SEO_DATA[tool].howTo.map((step,i)=><li key={i} style={{marginBottom:4}}>{step}</li>)}
      </ol>
    </div>}

    {/* ═══ FPS ESTIMATOR ═══ */}
    {tool==="fps"&&<div>
      <div className="tools-layout" style={{display:"grid",gridTemplateColumns:"300px 1fr",gap:20,alignItems:"start"}}>
        {/* Config panel */}
        <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:20}}>
          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--sky)",letterSpacing:1.5,marginBottom:12,fontWeight:600}}>SYSTEM CONFIG</div>

          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",marginBottom:4}}>GPU</div>
          <SearchSelect value={selGPU} onChange={setSelGPU} placeholder="Search GPUs..."
            options={gpuParts.sort((a,b)=>(b.bench||0)-(a.bench||0)).map(p=>({value:p.n,label:cleanDisplayName(p),detail:p.vram+"GB"}))}/>

          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",marginBottom:4}}>CPU</div>
          <SearchSelect value={selCPU} onChange={setSelCPU} placeholder="Search CPUs..."
            options={cpuParts.sort((a,b)=>(b.bench||0)-(a.bench||0)).map(p=>({value:p.n,label:cleanDisplayName(p),detail:p.cores+"C/"+( p.threads||p.cores*2)+"T"}))}/>

          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",marginBottom:4}}>RESOLUTION</div>
          <div style={{display:"flex",gap:4,marginBottom:10}}>
            {["1080p","1440p","4K"].map(r=><button key={r} onClick={()=>setSelRes(r)} style={{flex:1,padding:"6px 0",borderRadius:5,fontSize:10,fontFamily:"var(--mono)",fontWeight:600,cursor:"pointer",background:selRes===r?"var(--sky)18":"transparent",color:selRes===r?"var(--sky)":"var(--dim)",border:`1px solid ${selRes===r?"var(--sky)33":"var(--bdr)"}`}}>{r}</button>)}
          </div>

          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",marginBottom:4}}>QUALITY</div>
          <div style={{display:"flex",gap:4,marginBottom:10,flexWrap:"wrap"}}>
            {["Low","Medium","High","Ultra","RT Ultra"].map(q=><button key={q} onClick={()=>setSelQual(q)} style={{padding:"5px 8px",borderRadius:5,fontSize:9,fontFamily:"var(--mono)",fontWeight:600,cursor:"pointer",background:selQual===q?"var(--sky)18":"transparent",color:selQual===q?"var(--sky)":"var(--dim)",border:`1px solid ${selQual===q?"var(--sky)33":"var(--bdr)"}`}}>{q}</button>)}
          </div>

          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",marginBottom:4}}>RAM</div>
          <div style={{display:"flex",gap:6,marginBottom:6}}>
            <select value={selRAMType} onChange={e=>setSelRAMType(e.target.value)} style={{...inp,width:"40%",marginBottom:0}}>
              <option value="DDR5">DDR5</option><option value="DDR4">DDR4</option>
            </select>
            <select value={selRAMCap} onChange={e=>setSelRAMCap(+e.target.value)} style={{...inp,width:"30%",marginBottom:0}}>
              {[8,16,32,64,128].map(c=><option key={c} value={c}>{c}GB</option>)}
            </select>
            <select value={selRAMSpeed} onChange={e=>setSelRAMSpeed(+e.target.value)} style={{...inp,width:"30%",marginBottom:0}}>
              {(selRAMType==="DDR5"?[4800,5200,5600,6000,6400,7200,7600,8000]:[2400,2666,3000,3200,3600,4000]).map(s=><option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div style={{fontFamily:"var(--ff)",fontSize:8,color:"var(--mute)",marginBottom:10}}>
            RAM speed affects CPU-bound games. Low capacity (&lt;16GB) can cause stuttering.
          </div>

          <button onClick={runFPS} disabled={!selGPU||!selCPU||fpsLoading} style={{width:"100%",padding:"10px 0",borderRadius:8,background:selGPU&&selCPU?"var(--sky)":"var(--bg4)",border:"none",fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:selGPU&&selCPU?"var(--bg)":"var(--mute)",cursor:selGPU&&selCPU&&!fpsLoading?"pointer":"not-allowed"}}>
            {fpsLoading?"⏳ Calculating...":"🎮 Estimate FPS"}
          </button>
        </div>

        {/* Results */}
        <div>
          {!fpsResults&&<div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:40,textAlign:"center"}}>
            <div style={{fontSize:40,marginBottom:10}}>🎮</div>
            <div style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--dim)"}}>Select your GPU and CPU, then click Estimate FPS</div>
            <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--mute)",marginTop:6}}>Get estimated frame rates for {GAMES.length} games at any resolution</div>
          </div>}

          {fpsResults&&<div>
            {/* Summary header */}
            <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:16,marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:700,color:"var(--txt)"}}>{fpsResults.gpu} + {fpsResults.cpu}</div>
                  <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",marginTop:2}}>{fpsResults.res} · {fpsResults.qual} · {fpsResults.games.length} games tested</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)"}}>AVG FPS</div>
                  <div style={{fontFamily:"var(--mono)",fontSize:24,fontWeight:800,color:"var(--sky)"}}>{Math.round(fpsResults.games.reduce((s,g)=>s+g.fps,0)/fpsResults.games.length)}</div>
                </div>
              </div>
            </div>

            {/* Game results grid */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
              {fpsResults.games.sort((a,b)=>b.fps-a.fps).map(g=>{
                const game=GAMES.find(x=>x.name===g.game);
                return <div key={g.game} style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:8,padding:"10px 12px",display:"flex",alignItems:"center",gap:10}}>
                  <span style={{fontSize:22,width:28,textAlign:"center"}}>{game?.icon||"🎮"}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{g.game}</div>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginTop:3}}>
                      <div style={{flex:1,height:4,background:"var(--bg4)",borderRadius:2,overflow:"hidden"}}>
                        <div style={{width:`${Math.min(g.fps/180*100,100)}%`,height:"100%",background:tierColor(g.tier),borderRadius:2}}/>
                      </div>
                      <span style={{fontFamily:"var(--mono)",fontSize:8,color:tierColor(g.tier)}}>{g.tier}</span>
                    </div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <div style={{fontFamily:"var(--mono)",fontSize:17,fontWeight:700,color:tierColor(g.tier)}}>{g.fps}</div>
                    <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)"}}>FPS</div>
                  </div>
                  {g.bottleneck!=="Balanced"&&<div style={{position:"relative"}}><span title={`${g.bottleneck} bottleneck ${g.bottleneckPct}%`} style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--amber)",cursor:"help"}}>⚠️</span></div>}
                </div>;
              })}
            </div>

            {/* FPS tier legend */}
            <div style={{display:"flex",gap:12,justifyContent:"center",marginTop:12,padding:"8px 0"}}>
              {[{t:"Excellent",f:"144+",c:"var(--mint)"},{t:"Great",f:"100-143",c:"var(--sky)"},{t:"Smooth",f:"60-99",c:"var(--amber)"},{t:"Playable",f:"30-59",c:"var(--rose)"}].map(x=>
                <div key={x.t} style={{display:"flex",alignItems:"center",gap:4}}>
                  <div style={{width:8,height:8,borderRadius:2,background:x.c}}/>
                  <span style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)"}}>{x.t} ({x.f})</span>
                </div>
              )}
            </div>
          </div>}
        </div>
      </div>
    </div>}

    {/* ═══ BOTTLENECK CALCULATOR ═══ */}
    {tool==="bn"&&<div>
      <div className="tools-layout" style={{display:"grid",gridTemplateColumns:"300px 1fr",gap:20,alignItems:"start"}}>
        {/* Config */}
        <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:20}}>
          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--rose)",letterSpacing:1.5,marginBottom:12,fontWeight:600}}>BOTTLENECK CALCULATOR</div>

          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",marginBottom:4}}>GPU</div>
          <SearchSelect value={bnGPU} onChange={setBnGPU} placeholder="Search GPUs..."
            options={gpuParts.sort((a,b)=>(b.bench||0)-(a.bench||0)).map(p=>({value:p.n,label:cleanDisplayName(p),detail:p.vram+"GB"}))}/>

          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",marginBottom:4}}>CPU</div>
          <SearchSelect value={bnCPU} onChange={setBnCPU} placeholder="Search CPUs..."
            options={cpuParts.sort((a,b)=>(b.bench||0)-(a.bench||0)).map(p=>({value:p.n,label:cleanDisplayName(p),detail:p.cores+"C"}))}/>

          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",marginBottom:4}}>RESOLUTION</div>
          <div style={{display:"flex",gap:4,marginBottom:14}}>
            {["1080p","1440p","4K"].map(r=><button key={r} onClick={()=>setBnRes(r)} style={{flex:1,padding:"6px 0",borderRadius:6,fontSize:10,fontFamily:"var(--mono)",fontWeight:600,cursor:"pointer",background:bnRes===r?"var(--rose)15":"transparent",color:bnRes===r?"var(--rose)":"var(--dim)",border:`1px solid ${bnRes===r?"var(--rose)33":"var(--bdr)"}`}}>{r}</button>)}
          </div>

          <button onClick={runBottleneck} disabled={!bnGPU||!bnCPU||bnLoading} style={{width:"100%",padding:"10px 0",borderRadius:8,background:bnGPU&&bnCPU?"var(--rose)":"var(--bg4)",border:"none",fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:bnGPU&&bnCPU?"#fff":"var(--mute)",cursor:bnGPU&&bnCPU&&!bnLoading?"pointer":"not-allowed"}}>
            {bnLoading?"⏳ Analyzing...":"🔬 Analyze Bottleneck"}
          </button>
        </div>

        {/* Results */}
        <div>
          {!bnResult&&<div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:40,textAlign:"center"}}>
            <div style={{fontSize:40,marginBottom:10}}>🔬</div>
            <div style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--dim)"}}>Select your GPU and CPU to analyze bottlenecks</div>
            <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--mute)",marginTop:6}}>See which component is limiting your performance at each resolution</div>
          </div>}

          {bnResult&&<div>
            {/* Main result card */}
            <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:20,marginBottom:12}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
                <div>
                  <div style={{fontFamily:"var(--ff)",fontSize:17,fontWeight:700,color:"var(--txt)"}}>{bnResult.gpuKey} + {bnResult.cpuKey}</div>
                  <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",marginTop:2}}>at {bnResult.res} resolution</div>
                </div>
                <div style={{padding:"6px 16px",borderRadius:8,fontFamily:"var(--ff)",fontSize:14,fontWeight:700,
                  background:bnResult.who==="Balanced"?"var(--mint)15":bnResult.who==="CPU"?"var(--rose)15":"var(--amber)15",
                  color:bnResult.who==="Balanced"?"var(--mint)":bnResult.who==="CPU"?"var(--rose)":"var(--amber)"}}>
                  {bnResult.who==="Balanced"?"✅ Well Balanced":bnResult.who==="CPU"?`⚠️ CPU Bottleneck (${bnResult.severity}%)`:`⚠️ GPU Bottleneck (${bnResult.severity}%)`}
                </div>
              </div>

              {/* Visual balance bar */}
              <div style={{marginBottom:16}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                  <span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--sky)",fontWeight:600}}>CPU: {bnResult.cpuScore}pts</span>
                  <span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mint)",fontWeight:600}}>GPU: {bnResult.gpuScore}pts</span>
                </div>
                <div style={{display:"flex",height:12,borderRadius:6,overflow:"hidden",background:"var(--bg4)"}}>
                  <div style={{width:`${Math.round(bnResult.cpuScore/(bnResult.cpuScore+bnResult.gpuScore)*100)}%`,background:bnResult.who==="CPU"?"var(--rose)":"var(--sky)",transition:"width .6s ease",borderRadius:"6px 0 0 6px"}}/>
                  <div style={{flex:1,background:bnResult.who==="GPU"?"var(--amber)":"var(--mint)",borderRadius:"0 6px 6px 0"}}/>
                </div>
                <div style={{textAlign:"center",marginTop:4}}>
                  <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)"}}>Balance ratio: {bnResult.ratio}%</span>
                </div>
              </div>

              {/* Explanation */}
              <div style={{background:"var(--bg3)",borderRadius:10,padding:14}}>
                <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)",lineHeight:1.7}}>
                  {bnResult.who==="Balanced"
                    ?`Your ${bnResult.cpuKey} and ${bnResult.gpuKey} are well matched at ${bnResult.res}. Neither component is significantly holding back the other. This is an ideal pairing.`
                    :bnResult.who==="CPU"
                    ?`Your ${bnResult.cpuKey} is limiting your ${bnResult.gpuKey} by approximately ${bnResult.severity}% at ${bnResult.res}. The GPU has more headroom than the CPU can feed it, especially in CPU-intensive games. This bottleneck is ${bnResult.severity>20?"significant":"minor"} and ${bnResult.res==="1080p"?"will be more noticeable at 1080p where the CPU matters most":"would be less noticeable at higher resolutions"}.`
                    :`Your ${bnResult.gpuKey} is the limiting factor, holding back your ${bnResult.cpuKey} by approximately ${bnResult.severity}% at ${bnResult.res}. ${bnResult.res==="4K"?"At 4K, this is expected since the GPU handles the heavy lifting.":"Upgrading your GPU would unlock more of your CPU's potential."}`}
                </div>
              </div>
            </div>

            {/* Game performance preview */}
            {bnResult.gameResults.length>0&&<div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:16,marginBottom:12}}>
              <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",letterSpacing:1,marginBottom:10}}>ESTIMATED FPS AT {bnResult.res} ULTRA</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
                {bnResult.gameResults.map(g=><div key={g.game} style={{background:"var(--bg3)",borderRadius:8,padding:"10px 12px",textAlign:"center"}}>
                  <div style={{fontFamily:"var(--ff)",fontSize:10,fontWeight:600,color:"var(--txt)",marginBottom:4}}>{g.game}</div>
                  <div style={{fontFamily:"var(--mono)",fontSize:22,fontWeight:700,color:tierColor(g.tier)}}>{g.fps}</div>
                  <div style={{fontFamily:"var(--mono)",fontSize:8,color:g.bottleneck!=="Balanced"?"var(--rose)":"var(--dim)"}}>{g.bottleneck!=="Balanced"?g.bottleneck+" limited":"Balanced"}</div>
                </div>)}
              </div>
            </div>}

            {/* Upgrade suggestions */}
            {(bnResult.cpuUpgrade||bnResult.gpuUpgrade)&&<div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:16}}>
              <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",letterSpacing:1,marginBottom:10}}>💡 UPGRADE SUGGESTIONS</div>
              {bnResult.who==="CPU"&&bnResult.cpuUpgrade&&<div style={{display:"flex",alignItems:"center",gap:10,background:"var(--bg3)",borderRadius:8,padding:"10px 14px"}}>
                <span style={{fontSize:22}}>🔴</span>
                <div style={{flex:1}}>
                  <div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)"}}>Upgrade to {bnResult.cpuUpgrade.name}</div>
                  <div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)"}}>+{bnResult.cpuUpgrade.gain}% CPU performance — would reduce or eliminate the bottleneck</div>
                </div>
                <Tag color="var(--sky)">+{bnResult.cpuUpgrade.gain}%</Tag>
              </div>}
              {bnResult.who==="GPU"&&bnResult.gpuUpgrade&&<div style={{display:"flex",alignItems:"center",gap:10,background:"var(--bg3)",borderRadius:8,padding:"10px 14px"}}>
                <span style={{fontSize:22}}>💚</span>
                <div style={{flex:1}}>
                  <div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)"}}>Upgrade to {bnResult.gpuUpgrade.name}</div>
                  <div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)"}}>+{bnResult.gpuUpgrade.gain}% GPU performance — better matched to your CPU</div>
                </div>
                <Tag color="var(--sky)">+{bnResult.gpuUpgrade.gain}%</Tag>
              </div>}
              {bnResult.who==="Balanced"&&<div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--mint)",textAlign:"center",padding:8}}>✅ No upgrades needed — your system is well balanced!</div>}
            </div>}
          </div>}
        </div>
      </div>
    </div>}

    {/* ═══ COMPARE ═══ */}
    {tool==="cmp"&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
      <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:20}}>
        <h3 style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:700,color:"var(--txt)",marginBottom:8}}>Compare Parts</h3>
        <input value={cA} onChange={e=>setCA(e.target.value)} placeholder="Part A (e.g. RTX 4090)" style={inp}/>
        <input value={cB} onChange={e=>setCB(e.target.value)} placeholder="Part B (e.g. RX 7900 XTX)" style={inp}/>
        <button onClick={cmp} style={{width:"100%",padding:"8px 0",borderRadius:6,background:"var(--violet)",border:"none",fontSize:13,fontWeight:700,color:"#fff",cursor:"pointer",fontFamily:"var(--ff)",marginTop:4}}>Compare</button>
      </div>
      <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:20,minHeight:180}}>
        {!cmpResult&&<div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:"var(--mute)",fontFamily:"var(--ff)",fontSize:14}}>Enter two parts to compare →</div>}
        {cmpResult&&<><div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--violet)",letterSpacing:1,marginBottom:10}}>COMPARISON</div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>{[cmpResult.a,cmpResult.b].map(p=><div key={p.id} style={{textAlign:"center"}}><div style={{fontSize:22}}>{ic(p)}</div><div style={{fontSize:13,fontWeight:600,color:"var(--txt)",marginTop:3,fontFamily:"var(--ff)"}}>{p.n}</div><div style={{fontSize:9,color:"var(--dim)",fontFamily:"var(--ff)"}}>{p.b}</div><div style={{fontFamily:"var(--mono)",fontSize:17,fontWeight:700,color:"var(--mint)",marginTop:4}}>${fmtPrice($(p))}</div><Stars r={p.r}/>{p.bench!=null&&<div style={{marginTop:4}}><SBar v={p.bench}/></div>}</div>)}</div>{cmpResult.a.bench!=null&&cmpResult.b.bench!=null&&<div style={{marginTop:10,padding:6,borderRadius:6,background:"#a78bfa15",textAlign:"center",fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--violet)"}}>{cmpResult.a.bench>cmpResult.b.bench?`${cmpResult.a.n} is ${cmpResult.a.bench-cmpResult.b.bench}% faster`:cmpResult.b.bench>cmpResult.a.bench?`${cmpResult.b.n} is ${cmpResult.b.bench-cmpResult.a.bench}% faster`:"Tied!"}</div>}</>}
      </div>
    </div>}

    {/* ═══ WILL IT RUN? ═══ */}
    {tool==="willitrun"&&<div>
      <div className="tools-layout" style={{display:"grid",gridTemplateColumns:"300px 1fr",gap:20,alignItems:"start"}}>
        <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:20}}>
          <h3 style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:700,color:"var(--txt)",marginBottom:12}}>Will My PC Run This Game?</h3>
          <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",marginBottom:4}}>SELECT GAME</div>
          <select value={wirGame} onChange={e=>setWirGame(e.target.value)} style={inp}><option value="">Choose a game...</option>{GAMES.map(g=><option key={g.name} value={g.name}>{g.name}</option>)}</select>
          <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",marginTop:8,marginBottom:4}}>YOUR GPU</div>
          <SearchSelect options={gpuParts.map(g=>({value:g.n,label:cleanDisplayName(g),detail:`${g.vram}GB · ${g.b}`}))} value={wirGPU} onChange={setWirGPU} placeholder="Select GPU..."/>
          <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",marginTop:8,marginBottom:4}}>YOUR CPU</div>
          <SearchSelect options={cpuParts.filter(c=>!c.serverCPU).map(c=>({value:c.n,label:cleanDisplayName(c),detail:`${c.cores}C · ${c.b}`}))} value={wirCPU} onChange={setWirCPU} placeholder="Select CPU..."/>
          <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",marginTop:8,marginBottom:4}}>RESOLUTION</div>
          <div style={{display:"flex",gap:4}}>{["1080p","1440p","4K"].map(r=><button key={r} onClick={()=>setWirRes(r)} style={{flex:1,padding:6,borderRadius:5,fontSize:10,fontFamily:"var(--mono)",fontWeight:600,cursor:"pointer",background:wirRes===r?"var(--amber)":"var(--bg4)",color:wirRes===r?"#fff":"var(--dim)",border:`1px solid ${wirRes===r?"var(--amber)":"var(--bdr)"}`}}>{r}</button>)}</div>
          <button onClick={()=>{if(!wirGame||!wirGPU||!wirCPU)return;const gpu=matchGPU(wirGPU)||wirGPU;const cpu=matchCPU(wirCPU)||wirCPU;const results=["Low","Medium","High","Ultra"].map(q=>{const fps=estimateFPS(gpu,cpu,wirGame,wirRes,q);return{quality:q,fps:fps?.fps||0};});setWirResult({game:wirGame,gpu:wirGPU,cpu:wirCPU,res:wirRes,settings:results});}} style={{width:"100%",padding:"10px 0",borderRadius:6,background:"var(--amber)",border:"none",fontSize:14,fontWeight:700,color:"#fff",cursor:"pointer",fontFamily:"var(--ff)",marginTop:12}}>🕹️ Check Performance</button>
        </div>
        <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:20,minHeight:300}}>
          {!wirResult&&<div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:"var(--mute)",fontFamily:"var(--ff)",fontSize:14}}>Select a game and your hardware →</div>}
          {wirResult&&<div>
            <div style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--txt)",marginBottom:4}}>Can you run {wirResult.game}?</div>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",marginBottom:16}}>{wirResult.gpu} · {wirResult.cpu} · {wirResult.res}</div>
            {wirResult.settings.map(s=>{const playable=s.fps>=60;const smooth=s.fps>=100;const color=smooth?"var(--mint)":playable?"var(--sky)":s.fps>=30?"var(--amber)":"var(--rose)";const verdict=smooth?"Smooth":playable?"Playable":s.fps>=30?"Rough":"Unplayable";return <div key={s.quality} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 12px",borderRadius:8,background:"var(--bg3)",marginBottom:6,border:"1px solid var(--bdr)"}}>
              <div style={{width:60,fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)"}}>{s.quality}</div>
              <div style={{flex:1}}><div style={{height:8,background:"var(--bg4)",borderRadius:4,overflow:"hidden"}}><div style={{width:`${Math.min(s.fps/144*100,100)}%`,height:"100%",background:color,borderRadius:4}}/></div></div>
              <div style={{fontFamily:"var(--mono)",fontSize:22,fontWeight:700,color,minWidth:60,textAlign:"right"}}>{s.fps} FPS</div>
              <Tag color={color}>{verdict}</Tag>
            </div>})}
            <div style={{marginTop:12,padding:8,borderRadius:6,background:"var(--bg3)",fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)"}}>{wirResult.settings[3]?.fps>=60?"✅ Your PC can handle "+wirResult.game+" at "+wirResult.res+" Ultra!":wirResult.settings[2]?.fps>=60?"⚠️ Playable at High, but Ultra may struggle.":wirResult.settings[1]?.fps>=60?"⚠️ Consider lowering settings to Medium for smooth gameplay.":"❌ Your hardware may struggle with "+wirResult.game+". Consider upgrading."}</div>
          </div>}
        </div>
      </div>
    </div>}

    {/* ═══ BUILD COMPARISON ═══ */}
    {tool==="buildcmp"&&<div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        {["Build A","Build B"].map((label,bi)=>{const st=bi===0?bcBuildA:bcBuildB;const set=bi===0?setBcBuildA:setBcBuildB;return <div key={label} style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:16}}>
          <div style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:700,color:"var(--txt)",marginBottom:10}}>{label}</div>
          <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",marginBottom:4}}>GPU</div>
          <SearchSelect options={gpuParts.map(g=>({value:g.n,label:g.n,detail:`${g.vram}GB · $${$(g)}`}))} value={st.gpu} onChange={v=>set(p=>({...p,gpu:v}))} placeholder="Select GPU..."/>
          <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",marginTop:8,marginBottom:4}}>CPU</div>
          <SearchSelect options={cpuParts.filter(c=>!c.serverCPU).map(c=>({value:c.n,label:c.n,detail:`${c.cores}C · $${$(c)}`}))} value={st.cpu} onChange={v=>set(p=>({...p,cpu:v}))} placeholder="Select CPU..."/>
        </div>})}
      </div>
      <button onClick={()=>{if(!bcBuildA.gpu||!bcBuildA.cpu||!bcBuildB.gpu||!bcBuildB.cpu)return;const gA=gpuParts.find(p=>p.n===bcBuildA.gpu);const cA2=cpuParts.find(p=>p.n===bcBuildA.cpu);const gB=gpuParts.find(p=>p.n===bcBuildB.gpu);const cB2=cpuParts.find(p=>p.n===bcBuildB.cpu);const fpsA=estimateAllGames(matchGPU(bcBuildA.gpu)||bcBuildA.gpu,matchCPU(bcBuildA.cpu)||bcBuildA.cpu,"1080p","Ultra");const fpsB=estimateAllGames(matchGPU(bcBuildB.gpu)||bcBuildB.gpu,matchCPU(bcBuildB.cpu)||bcBuildB.cpu,"1080p","Ultra");const costA=(gA?$(gA):0)+(cA2?$(cA2):0);const costB=(gB?$(gB):0)+(cB2?$(cB2):0);const avgA=fpsA.length?Math.round(fpsA.reduce((s,g)=>s+g.fps,0)/fpsA.length):0;const avgB=fpsB.length?Math.round(fpsB.reduce((s,g)=>s+g.fps,0)/fpsB.length):0;setBcResult({a:{gpu:bcBuildA.gpu,cpu:bcBuildA.cpu,cost:costA,avgFps:avgA,tdp:(gA?.tdp||0)+(cA2?.tdp||0),games:fpsA},b:{gpu:bcBuildB.gpu,cpu:bcBuildB.cpu,cost:costB,avgFps:avgB,tdp:(gB?.tdp||0)+(cB2?.tdp||0),games:fpsB}});}} style={{width:"100%",padding:"10px 0",borderRadius:6,background:"var(--violet)",border:"none",fontSize:14,fontWeight:700,color:"#fff",cursor:"pointer",fontFamily:"var(--ff)",marginTop:12}}>📊 Compare Builds</button>
      {bcResult&&<div style={{marginTop:16,background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:20}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
          {[bcResult.a,bcResult.b].map((b,i)=><div key={i} style={{textAlign:"center"}}>
            <div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:700,color:"var(--txt)"}}>{b.gpu}</div>
            <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)"}}>{b.cpu}</div>
            <div style={{display:"flex",justifyContent:"center",gap:16,marginTop:10}}>
              <div><div style={{fontFamily:"var(--mono)",fontSize:22,fontWeight:700,color:"var(--mint)"}}>${b.cost}</div><div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)"}}>GPU+CPU Cost</div></div>
              <div><div style={{fontFamily:"var(--mono)",fontSize:22,fontWeight:700,color:"var(--sky)"}}>{b.avgFps}</div><div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)"}}>Avg FPS</div></div>
              <div><div style={{fontFamily:"var(--mono)",fontSize:22,fontWeight:700,color:"var(--amber)"}}>{b.tdp}W</div><div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)"}}>TDP</div></div>
            </div>
          </div>)}
        </div>
        <div style={{marginTop:12,textAlign:"center",fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--violet)",padding:8,borderRadius:6,background:"var(--violet)12"}}>
          {bcResult.a.avgFps>bcResult.b.avgFps?`Build A is ${Math.round((bcResult.a.avgFps/bcResult.b.avgFps-1)*100)}% faster`:`Build B is ${Math.round((bcResult.b.avgFps/bcResult.a.avgFps-1)*100)}% faster`}
          {bcResult.a.cost!==bcResult.b.cost&&` · ${bcResult.a.cost<bcResult.b.cost?"Build A":"Build B"} saves $${Math.abs(bcResult.a.cost-bcResult.b.cost)}`}
        </div>
      </div>}
    </div>}

    {/* ═══ BUILD WIZARD ═══ */}
    {tool==="wizard"&&<div className="wizard-container">
      <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:24}}>
        <div style={{display:"flex",gap:4,marginBottom:20}}>{[0,1,2,3].map(s=><div key={s} style={{flex:1,height:4,borderRadius:2,background:wizStep>=s?"var(--mint)":"var(--bg4)"}}/>)}</div>
        
        {wizStep===0&&<div>
          <h3 style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:700,color:"var(--txt)",marginBottom:6}}>What will you use this PC for?</h3>
          <p style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",marginBottom:16}}>This helps us prioritize the right components.</p>
          {[{id:"gaming",icon:"🎮",t:"Gaming",d:"High FPS, ray tracing, competitive & story games"},{id:"creative",icon:"🎨",t:"Content Creation",d:"Video editing, 3D rendering, streaming"},{id:"work",icon:"💼",t:"Productivity",d:"Office, multitasking, light photo editing"},{id:"server",icon:"🖥️",t:"Server / Workstation",d:"Always-on, VMs, databases, AI/ML"}].map(u=><button key={u.id} onClick={()=>{setWizUse(u.id);setWizStep(1);}} style={{display:"flex",alignItems:"center",gap:12,width:"100%",padding:"14px 16px",borderRadius:8,marginBottom:6,background:wizUse===u.id?"var(--mint3)":"var(--bg3)",border:`1px solid ${wizUse===u.id?"var(--mint)33":"var(--bdr)"}`,cursor:"pointer",textAlign:"left"}}><span style={{fontSize:24}}>{u.icon}</span><div><div style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:600,color:"var(--txt)"}}>{u.t}</div><div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)"}}>{u.d}</div></div></button>)}
        </div>}

        {wizStep===1&&<div>
          <h3 style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:700,color:"var(--txt)",marginBottom:6}}>What's your budget?</h3>
          <p style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",marginBottom:16}}>Total budget for all components (excluding monitor & peripherals).</p>
          <input type="range" min={500} max={5000} step={100} value={wizBudget} onChange={e=>setWizBudget(+e.target.value)} style={{width:"100%"}}/>
          <div style={{textAlign:"center",fontFamily:"var(--mono)",fontSize:32,fontWeight:700,color:"var(--mint)",margin:"12px 0"}}>${wizBudget}</div>
          <div style={{display:"flex",justifyContent:"center",gap:6,marginBottom:16}}>{[800,1000,1500,2000,3000].map(b=><button key={b} onClick={()=>setWizBudget(b)} style={{padding:"4px 10px",borderRadius:5,fontSize:10,fontFamily:"var(--mono)",background:wizBudget===b?"var(--mint)":"var(--bg4)",color:wizBudget===b?"#fff":"var(--dim)",border:"none",cursor:"pointer"}}>${b}</button>)}</div>
          <div style={{display:"flex",gap:8}}><button onClick={()=>setWizStep(0)} style={{flex:1,padding:10,borderRadius:6,background:"var(--bg4)",border:"none",fontSize:13,fontWeight:600,color:"var(--dim)",cursor:"pointer",fontFamily:"var(--ff)"}}>← Back</button><button onClick={()=>setWizStep(2)} style={{flex:2,padding:10,borderRadius:6,background:"var(--mint)",border:"none",fontSize:13,fontWeight:600,color:"#fff",cursor:"pointer",fontFamily:"var(--ff)"}}>Next →</button></div>
        </div>}

        {wizStep===2&&<div>
          <h3 style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:700,color:"var(--txt)",marginBottom:6}}>What matters most?</h3>
          <p style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",marginBottom:16}}>We'll optimize your build around this priority.</p>
          {[{id:"performance",icon:"🚀",t:"Max Performance",d:"Best FPS and speed, even if louder"},{id:"quiet",icon:"🤫",t:"Silent Operation",d:"Quiet fans and coolers, even if slightly slower"},{id:"value",icon:"💰",t:"Best Value",d:"Most performance per dollar"},{id:"aesthetic",icon:"✨",t:"Clean Aesthetics",d:"RGB, tempered glass, coordinated look"}].map(p=><button key={p.id} onClick={()=>{setWizPriority(p.id);setWizStep(3);
            // Generate the build
            const alloc=wizUse==="gaming"?{GPU:.4,CPU:.2,RAM:.08,Motherboard:.12,Storage:.08,PSU:.06,Case:.04,CPUCooler:.04}:wizUse==="creative"?{CPU:.3,GPU:.25,RAM:.1,Motherboard:.12,Storage:.1,PSU:.06,Case:.04,CPUCooler:.04}:{CPU:.25,GPU:.15,RAM:.1,Motherboard:.15,Storage:.15,PSU:.08,Case:.06,CPUCooler:.06};
            const picks={};for(const cat of CORE_CATS){const t=wizBudget*(alloc[cat]||.05);const o=P.filter(pp=>pp.c===cat&&$(pp)<=t*1.3&&!pp.serverCPU);if(o.length){if(p.id==="value")o.sort((a,b)=>((b.bench||0)/$(b))-((a.bench||0)/$(a)));else if(p.id==="quiet")o.sort((a,b)=>(a.tdp||999)-(b.tdp||999));else o.sort((a,b)=>(b.bench||b.r*20)-(a.bench||a.r*20));picks[cat]=o[0];}}
            if(picks.CPU&&picks.Motherboard&&picks.CPU.socket!==picks.Motherboard.socket){const fx=P.filter(pp=>pp.c==="Motherboard"&&pp.socket===picks.CPU.socket&&$(pp)<=wizBudget*.15);if(fx.length)picks.Motherboard=fx[0];}
            if(picks.CPU&&picks.RAM&&picks.CPU.memType){const rFix=P.filter(pp=>pp.c==="RAM"&&pp.ramType===picks.CPU.memType&&$(pp)<=wizBudget*.1);if(rFix.length)picks.RAM=rFix.sort((a,b)=>(b.speed||0)-(a.speed||0))[0];}
            setWizResult(picks);
          }} style={{display:"flex",alignItems:"center",gap:12,width:"100%",padding:"14px 16px",borderRadius:8,marginBottom:6,background:wizPriority===p.id?"var(--mint3)":"var(--bg3)",border:`1px solid ${wizPriority===p.id?"var(--mint)33":"var(--bdr)"}`,cursor:"pointer",textAlign:"left"}}><span style={{fontSize:24}}>{p.icon}</span><div><div style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:600,color:"var(--txt)"}}>{p.t}</div><div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)"}}>{p.d}</div></div></button>)}
          <button onClick={()=>setWizStep(1)} style={{width:"100%",padding:10,borderRadius:6,background:"var(--bg4)",border:"none",fontSize:13,fontWeight:600,color:"var(--dim)",cursor:"pointer",fontFamily:"var(--ff)",marginTop:4}}>← Back</button>
        </div>}

        {wizStep===3&&wizResult&&<div>
          <h3 style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:700,color:"var(--txt)",marginBottom:4}}>Your Recommended Build</h3>
          <p style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",marginBottom:16}}>${wizBudget} {wizUse} build · {wizPriority} priority</p>
          {Object.entries(wizResult).map(([cat,p])=>{const rr=retailers(p);const url=rr[0]?.url;return <a key={cat} href={url||'#'} target={url?"_blank":undefined} rel={url?"noopener noreferrer":undefined} onClick={url?undefined:e=>e.preventDefault()} className="wizard-row" style={{color:"inherit"}}>
            <div className="wizard-row-info">
              <div className="wizard-row-img">{p.img?<img loading="lazy" decoding="async" src={p.img} alt={`${p.n}${p.c ? ' ' + p.c : ''}`}/>:CAT[cat]?.icon}</div>
              <div className="wizard-row-text"><div className="wizard-row-name">{p.n}</div><div className="wizard-row-cat">{CAT[cat]?.singular}</div></div>
            </div>
            <div className="wizard-row-meta">
              <span className="wizard-row-price">${fmtPrice($(p))}</span>
              {url&&<span className="wizard-row-buy">Buy →</span>}
            </div>
          </a>;})}
          <div style={{display:"flex",justifyContent:"space-between",padding:"10px 10px",marginTop:8,borderTop:"1px solid var(--bdr)"}}>
            <span style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)"}}>Total</span>
            <span style={{fontFamily:"var(--mono)",fontSize:22,fontWeight:700,color:"var(--mint)"}}>${Object.values(wizResult).reduce((s,p)=>s+$(p),0)}</span>
          </div>
          <div style={{display:"flex",gap:8,marginTop:12}}><button onClick={()=>{setWizStep(0);setWizResult(null);}} style={{flex:1,padding:10,borderRadius:6,background:"var(--bg4)",border:"none",fontSize:13,fontWeight:600,color:"var(--dim)",cursor:"pointer",fontFamily:"var(--ff)"}}>Start Over</button></div>
        </div>}
      </div>
    </div>}

    {/* ═══ POWER CALCULATOR ═══ */}
    {tool==="power"&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
      <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:20}}>
        <h3 style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:700,color:"var(--txt)",marginBottom:12}}>Power Consumption Calculator</h3>
        <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",marginBottom:4}}>GPU</div>
        <SearchSelect options={gpuParts.map(g=>({value:g.n,label:g.n,detail:`TDP: ${g.tdp}W`}))} value={pwGPU} onChange={setPwGPU} placeholder="Select GPU..."/>
        <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",marginTop:8,marginBottom:4}}>CPU</div>
        <SearchSelect options={cpuParts.filter(c=>!c.serverCPU).map(c=>({value:c.n,label:c.n,detail:`TDP: ${c.tdp}W`}))} value={pwCPU} onChange={setPwCPU} placeholder="Select CPU..."/>
        <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",marginTop:8,marginBottom:4}}>CASE FANS</div>
        <input type="range" min={0} max={10} value={pwFans} onChange={e=>setPwFans(+e.target.value)} style={{width:"100%"}}/>
        <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--txt)",textAlign:"center"}}>{pwFans} fans</div>
        <button onClick={()=>{const gp=gpuParts.find(p=>p.n===pwGPU);const cp=cpuParts.find(p=>p.n===pwCPU);if(!gp||!cp)return;const gpuW=gp.tdp||0;const cpuW=cp.tdp||0;const fanW=pwFans*3;const ramW=10;const storageW=8;const moboW=40;const idle=cpuW*0.15+gpuW*0.1+moboW*0.8+ramW+storageW*0.5+fanW;const gaming=cpuW*0.7+gpuW*0.95+moboW+ramW+storageW+fanW;const full=cpuW+gpuW+moboW+ramW+storageW+fanW+20;const psuRec=Math.ceil(full*1.25/50)*50;const monthCostIdle=(idle*8*30/1000*0.12).toFixed(1);const monthCostGaming=(gaming*4*30/1000*0.12).toFixed(1);setPwResult({cpuW,gpuW,idle:Math.round(idle),gaming:Math.round(gaming),full:Math.round(full),psuRec,monthCostIdle,monthCostGaming});}} style={{width:"100%",padding:"10px 0",borderRadius:6,background:"var(--sky)",border:"none",fontSize:14,fontWeight:700,color:"#fff",cursor:"pointer",fontFamily:"var(--ff)",marginTop:12}}>⚡ Calculate Power</button>
      </div>
      <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:20,minHeight:250}}>
        {!pwResult&&<div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:"var(--mute)",fontFamily:"var(--ff)",fontSize:14}}>Select components to calculate power →</div>}
        {pwResult&&<div>
          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--sky)",letterSpacing:1,marginBottom:12,fontWeight:600}}>POWER ANALYSIS</div>
          {[{label:"Idle",w:pwResult.idle,color:"var(--mint)",desc:"Desktop, browsing, light work"},{label:"Gaming",w:pwResult.gaming,color:"var(--amber)",desc:"Gaming, GPU-intensive apps"},{label:"Full Load",w:pwResult.full,color:"var(--rose)",desc:"Stress test, all cores + GPU maxed"}].map(s=><div key={s.label} style={{marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}><span style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)"}}>{s.label}</span><span style={{fontFamily:"var(--mono)",fontSize:15,fontWeight:700,color:s.color}}>{s.w}W</span></div>
            <div style={{height:8,background:"var(--bg4)",borderRadius:4,overflow:"hidden"}}><div style={{width:`${Math.min(s.w/pwResult.psuRec*100,100)}%`,height:"100%",background:s.color,borderRadius:4}}/></div>
            <div style={{fontFamily:"var(--ff)",fontSize:9,color:"var(--dim)",marginTop:2}}>{s.desc}</div>
          </div>)}
          <div style={{borderTop:"1px solid var(--bdr)",paddingTop:12,marginTop:8}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}><span style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)"}}>Recommended PSU</span><span style={{fontFamily:"var(--mono)",fontSize:17,fontWeight:700,color:"var(--mint)"}}>{pwResult.psuRec}W+</span></div>
            <div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)"}}>Based on full load + 25% headroom</div>
            <div style={{display:"flex",gap:12,marginTop:8}}>
              <div style={{flex:1,background:"var(--bg3)",borderRadius:6,padding:"6px 8px",textAlign:"center"}}><div style={{fontFamily:"var(--mono)",fontSize:13,fontWeight:700,color:"var(--txt)"}}>${pwResult.monthCostIdle}</div><div style={{fontFamily:"var(--mono)",fontSize:7,color:"var(--dim)"}}>$/mo idle 8h</div></div>
              <div style={{flex:1,background:"var(--bg3)",borderRadius:6,padding:"6px 8px",textAlign:"center"}}><div style={{fontFamily:"var(--mono)",fontSize:13,fontWeight:700,color:"var(--txt)"}}>${pwResult.monthCostGaming}</div><div style={{fontFamily:"var(--mono)",fontSize:7,color:"var(--dim)"}}>$/mo gaming 4h</div></div>
            </div>
          </div>
        </div>}
      </div>
    </div>}
  </div>;
}

/* ═══ UPGRADE PAGE (receives specs from scanner app) ═══ */
/* ═══ FOOTER ═══ */
function Footer({go}){
  return <footer style={{background:"var(--bg2)",borderTop:"1px solid var(--bdr)",marginTop:60}}>
    <div style={{maxWidth:1600,margin:"0 auto",padding:"48px 32px 32px"}}>
      <div style={{display:"grid",gridTemplateColumns:"1.5fr 1fr 1fr 1fr 1fr",gap:40,marginBottom:32}}>
        <div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
            <div style={{height:32,overflow:"hidden"}}><TowerLogo size={26}/></div>
          </div>
          <p style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",lineHeight:1.7,maxWidth:280}}>Compare PC hardware prices across retailers, check compatibility, and build your dream rig for less. <a href="https://prorigbuilder.com" style={{color:"var(--accent)",textDecoration:"underline"}}>prorigbuilder.com</a></p>
        </div>
        <div>
          <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--accent)",fontWeight:700,marginBottom:12,letterSpacing:0.5}}>Browse</div>
          {["Processors","Graphics Cards","Memory","Motherboards","Storage","Power Supplies","Cases","Coolers"].map(l=>
            <button key={l} onClick={()=>go("search")} style={{display:"block",fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",background:"none",border:"none",cursor:"pointer",padding:"4px 0",textAlign:"left"}}>{l}</button>
          )}
        </div>
        <div>
          <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--accent)",fontWeight:700,marginBottom:12,letterSpacing:0.5}}>Tools</div>
          {[{l:"PC Builder",p:"builder"},{l:"Community Builds",p:"community"},{l:"Smart Tools",p:"tools"},{l:"Browse Prices",p:"search"}].map(x=>
            <button key={x.l} onClick={()=>go(x.p)} style={{display:"block",fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",background:"none",border:"none",cursor:"pointer",padding:"4px 0",textAlign:"left"}}>{x.l}</button>
          )}
        </div>
        <div>
          <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--accent)",fontWeight:700,marginBottom:12,letterSpacing:0.5}}>Guides</div>
          {[{l:"Why Pro Rig Builder",p:"compare"},{l:"vs PCPartPicker",p:"vs-pcpartpicker"},{l:"PCPartPicker Alternative",p:"pcpartpicker-alternative"},{l:"Best PC Builder Tools",p:"best-pc-builder-tools"}].map(x=>
            <button key={x.l} onClick={()=>go(x.p)} style={{display:"block",fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",background:"none",border:"none",cursor:"pointer",padding:"4px 0",textAlign:"left",width:"auto"}}>{x.l}</button>
          )}
        </div>
        <div>
          <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--accent)",fontWeight:700,marginBottom:12,letterSpacing:0.5}}>Legal</div>
          {[{l:"About",p:"about"},{l:"Contact",p:"contact"},{l:"Privacy Policy",p:"privacy"},{l:"Terms of Use",p:"terms"},{l:"Affiliate Disclosure",p:"affiliate"}].map(x=>
            <button key={x.l} onClick={()=>go(x.p)} style={{display:"block",fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",background:"none",border:"none",cursor:"pointer",padding:"4px 0",textAlign:"left",width:"auto"}}>{x.l}</button>
          )}
        </div>
      </div>
      <div style={{borderTop:"1px solid var(--bdr)",paddingTop:20,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
        <span style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--mute)"}}>© {new Date().getFullYear()} Pro Rig Builder. Built and managed by <a href="https://tiereduptech.com" target="_blank" rel="noopener noreferrer" style={{color:"var(--accent)",textDecoration:"underline",fontWeight:600}}>TieredUp Tech, Inc.</a> Prices and availability subject to change.</span>
        <span style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--mute)"}}>As an Amazon Associate I earn from qualifying purchases. We may earn commissions from affiliate links.</span>
      </div>
    </div>
  </footer>;
}

/* ═══ APP ═══ */
function ScrollToTop(){
  const [show,setShow]=useState(false);
  useEffect(()=>{
    const onScroll=()=>setShow(window.scrollY>400);
    window.addEventListener("scroll",onScroll);
    onScroll();
    return ()=>window.removeEventListener("scroll",onScroll);
  },[]);
  if(!show)return null;
  return <button onClick={()=>window.scrollTo({top:0,behavior:"smooth"})}
    aria-label="Scroll to top"
    style={{position:"fixed",bottom:24,right:24,zIndex:9999,width:48,height:48,borderRadius:"50%",border:"1px solid var(--bdr)",background:"var(--accent)",color:"#fff",cursor:"pointer",fontSize:22,fontWeight:700,boxShadow:"0 4px 12px rgba(0,0,0,0.25)",display:"flex",alignItems:"center",justifyContent:"center",transition:"transform .15s, background .15s"}}
    onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-2px)";}}
    onMouseLeave={e=>{e.currentTarget.style.transform="translateY(0)";}}>
    ↑
  </button>;
}

// ── ScannerPromo: sticky left-side promo for the Pro Rig Scanner desktop app ──
function ScannerPromo({ go, page }) {
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem("rf_scanner_promo_dismissed") === "1"; } catch { return false; }
  });
  if (dismissed) return null;
  if (isMobile) return null; // hide on mobile — pointless there
  if (page === "scanner") return null; // do not show on the dedicated page
  const dismiss = e => {
    e.stopPropagation();
    setDismissed(true);
    try { localStorage.setItem("rf_scanner_promo_dismissed", "1"); } catch {}
  };
  const open = () => { setExpanded(true); };
  const close = () => { setExpanded(false); };
  return (
    <div onMouseLeave={close} style={{position:"fixed",left:0,top:"50%",transform:"translateY(-50%)",zIndex:50,fontFamily:"var(--ff)"}}>
      {!expanded && (
        <button onMouseEnter={open} onClick={open} style={{background:"linear-gradient(135deg,var(--accent),#FF6B35)",border:"none",borderRadius:"12px 0 0 12px",padding:"18px 10px",cursor:"pointer",color:"#fff",writingMode:"vertical-rl",transform:"rotate(180deg)",fontSize:14,fontWeight:700,letterSpacing:1,boxShadow:"0 4px 16px rgba(0,0,0,0.3)",display:"flex",alignItems:"center",gap:6}} title="Get Pro Rig Scanner">
          <span style={{fontSize:20,transform:"rotate(90deg)"}}>💻</span>
          <span>SCAN YOUR PC</span>
        </button>
      )}
      {expanded && (
        <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:"0 14px 14px 0",padding:22,width:380,boxShadow:"0 12px 32px rgba(0,0,0,0.4)",position:"relative"}}>
          <button onClick={dismiss} title="Dismiss" style={{position:"absolute",top:6,right:6,background:"transparent",border:"none",color:"var(--dim)",fontSize:18,cursor:"pointer",padding:4,lineHeight:1}}>✕</button>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
            <span style={{fontSize:24}}>💻</span>
            <div>
              <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--accent)",fontWeight:700,letterSpacing:1}}>FREE WINDOWS APP</div>
              <div style={{fontFamily:"var(--ff)",fontSize:18,fontWeight:800,color:"var(--txt)"}}>Pro Rig Scanner</div>
            </div>
          </div>
          <div style={{width:"100%",aspectRatio:"4/3",background:"linear-gradient(135deg,#0f1117,#1a1f35)",borderRadius:6,marginBottom:10,position:"relative",overflow:"hidden",border:"1px solid var(--bdr)"}}>
            <div style={{position:"absolute",inset:0,padding:10,display:"flex",flexDirection:"column",gap:5}}>
              <div style={{display:"flex",gap:4,marginBottom:4}}>
                <span style={{width:8,height:8,borderRadius:"50%",background:"#FF5F57"}}/>
                <span style={{width:8,height:8,borderRadius:"50%",background:"#FFBD2E"}}/>
                <span style={{width:8,height:8,borderRadius:"50%",background:"#27C93F"}}/>
              </div>
              <div style={{fontFamily:"var(--mono)",fontSize:12,color:"#7FE2FF",fontWeight:700}}>$ scanning hardware...</div>
              <div style={{fontFamily:"var(--mono)",fontSize:11,color:"#7FFFB0",fontWeight:600}}>✓ CPU: i7-13700K</div>
              <div style={{fontFamily:"var(--mono)",fontSize:11,color:"#7FFFB0",fontWeight:600}}>✓ GPU: RTX 4070</div>
              <div style={{fontFamily:"var(--mono)",fontSize:11,color:"#7FFFB0",fontWeight:600}}>✓ RAM: 32GB DDR5</div>
              <div style={{fontFamily:"var(--mono)",fontSize:11,color:"#FFA552",fontWeight:700}}>→ Calculating upgrades...</div>
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:5,marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",gap:8,fontSize:14,color:"var(--txt)"}}><span style={{color:"var(--mint)"}}>✓</span> Auto-detects your hardware</div>
            <div style={{display:"flex",alignItems:"center",gap:8,fontSize:14,color:"var(--txt)"}}><span style={{color:"var(--mint)"}}>✓</span> Personalized upgrade picks</div>
            <div style={{display:"flex",alignItems:"center",gap:8,fontSize:14,color:"var(--txt)"}}><span style={{color:"var(--mint)"}}>✓</span> Real-time pricing</div>
            <div style={{display:"flex",alignItems:"center",gap:8,fontSize:14,color:"var(--txt)"}}><span style={{color:"var(--mint)"}}>✓</span> Signed &amp; safe (no installs)</div>
          </div>
          <button onClick={()=>{ if (go) go("scanner"); }} style={{width:"100%",background:"var(--accent)",color:"#fff",border:"none",borderRadius:8,padding:"14px 18px",fontFamily:"var(--ff)",fontSize:15,fontWeight:700,cursor:"pointer"}}>Get it free →</button>
        </div>
      )}
    </div>
  );
}

export default function App(){
  const [page,setPageRaw]=useState(()=>{
    if(typeof window==='undefined')return"home";
    const path=(window.location.pathname||"/").replace(/^\//,"").split("/")[0];
    if(!path)return"home";
    // Validate against known pages
    const validPages=["home","search","builder","community","tools","upgrade","scanner","about","contact","privacy","terms","affiliate","compare","vs-pcpartpicker","pcpartpicker-alternative","best-pc-builder-tools"];
    if(validPages.includes(path))return path;
    // Also handle legacy hash routes
    const hash=(window.location.hash||"").replace(/^#/,"").split("/")[0];
    if(validPages.includes(hash))return hash;
    return"home";
  });const [bc,setBc]=useState("");const [bq,setBq]=useState("");
  const th = useThumbs();
  const [theme,setTheme]=useState(()=>{try{return localStorage.getItem("rf-theme")||"light";}catch{return"light";}});
  const toggleTheme=()=>{const next=theme==="dark"?"light":"dark";setTheme(next);try{localStorage.setItem("rf-theme",next);}catch{};};

  // ── Browser history support ──
  const setPage = (p, replaceCurrent) => {
    setPageRaw(p);
    const url = p === "home" ? "/" : "/" + p;
    if (replaceCurrent) {
      window.history.replaceState({page:p}, "", url + window.location.search);
    } else {
      window.history.pushState({page:p}, "", url + window.location.search);
    }
  };

  useEffect(() => {
    // Handle browser back/forward buttons
    const onPop = (e) => {
      const state = e.state;
      const pathPage = (window.location.pathname || "/").replace(/^\//, "").split("/")[0] || "home";
      if (state && state.page) {
        setPageRaw(state.page);
        if (state.page !== "search") setBc("");
      } else {
        setPageRaw("home");
      }
    };
    window.addEventListener("popstate", onPop);

    window.addEventListener("hashchange", () => {
     const h = window.location.hash.replace("#", "").split("?")[0];
     const valid = ["home","search","builder","community","tools","upgrade"];
     if (valid.includes(h)) { setPageRaw(h); if (h !== "search") setBc(""); }
   });

    // Set initial state from pathname (primary) with hash fallback for legacy URLs
    const validPages = ["home","search","builder","community","tools","upgrade","scanner","about","contact","privacy","terms","affiliate","compare","vs-pcpartpicker","pcpartpicker-alternative","best-pc-builder-tools"];

    // Try pathname first
    const rawPath = (window.location.pathname || "/").replace(/^\//,"");
    const pathBase = rawPath.split("?")[0].split("/")[0];

    if (pathBase && validPages.includes(pathBase)) {
      setPageRaw(pathBase);
      window.history.replaceState({page:pathBase}, "", "/" + pathBase + window.location.search);
    } else if (!pathBase) {
      // Root path "/"
      setPageRaw("home");
      window.history.replaceState({page:"home"}, "", "/" + window.location.search);
    } else {
      // Try legacy hash fallback (e.g. someone bookmarked /#search)
      const rawHash = window.location.hash.replace("#","");
      const hashBase = rawHash.split("?")[0].split("/")[0];
      if (hashBase && validPages.includes(hashBase)) {
        setPageRaw(hashBase);
        // Migrate legacy hash URL to clean path URL
        window.history.replaceState({page:hashBase}, "", "/" + hashBase + window.location.search);
      } else {
        setPageRaw("home");
        window.history.replaceState({page:"home"}, "", "/" + window.location.search);
      }
    }

    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const handleBrowse=c=>{setBc(c);setPage("search");};
  const handleSearch=(q,cat)=>{setBq(q);setBc(cat||"");setPage("search");};
  return <div data-theme={theme} style={{minHeight:"100vh",background:"var(--bg)",color:"var(--txt)",fontFamily:"var(--ff)",display:"flex",flexDirection:"column",transition:"background .3s, color .3s"}}><style>{css}</style><PageMeta page={page} category={bc} parts={ACTIVE_SEED_PARTS} /><Nav page={page} setPage={p=>{setPage(p);if(p!=="search")setBc("");}} onBrowse={handleBrowse} onSearch={handleSearch} th={th} theme={theme} toggleTheme={toggleTheme}/><main style={{flex:1}}>{page==="home"&&<HomePage go={setPage} browse={handleBrowse} th={th}/>}{page==="search"&&<SearchPageRouter activeCat={bc} initialQuery={bq} th={th}/>}{page==="builder"&&<BuilderPage th={th}/>}{page==="community"&&<CommunityPage th={th}/>}{page==="tools"&&<ToolsPage th={th}/>}{page==="upgrade"&&<UpgradePage/>}{page==="scanner"&&<ScannerPage go={setPage}/>}{page==="about"&&<AboutPage go={setPage}/>}{page==="contact"&&<ContactPage/>}{page==="privacy"&&<PrivacyPage/>}{page==="terms"&&<TermsPage/>}{page==="affiliate"&&<AffiliatePage/>}{page==="compare"&&<ComparePage go={setPage}/>}{page==="vs-pcpartpicker"&&<VsPcPartPickerPage go={setPage}/>}{page==="pcpartpicker-alternative"&&<PcpAlternativePage go={setPage}/>}{page==="best-pc-builder-tools"&&<BestPcBuilderToolsPage go={setPage}/>}</main><Footer go={setPage}/><ScrollToTop /><ScannerPromo go={setPage} page={page}/></div>;
}
