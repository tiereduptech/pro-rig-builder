import React, { useState, useMemo, useEffect, useRef, useCallback } from "react"
import { Helmet } from "react-helmet-async";;
import { PARTS as RAW_SEED_PARTS } from "./data/parts.js";
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
  Case:{icon:"📦",label:"Cases",singular:"Case",desc:"Towers & SFF cases",cols:["ff","tower","tg","maxGPU","fans_inc"],filters:{ff:{label:"Type",type:"check"},mobo:{label:"Mobo Support",type:"check",extract:p=>(p.mobo||[]).join(",")},maxGPU:{label:"Max GPU Length",type:"range",unit:"mm"},maxCooler:{label:"Max Cooler Height",type:"range",unit:"mm"},rads:{label:"AIO/Radiator Support",type:"check",extract:p=>{const arr=Array.isArray(p.rads)?p.rads:[];if(!arr.length)return"None";const max=Math.max(...arr);return"Up to "+max+"mm"}},fans_inc:{label:"Included Fans",type:"check"},tg:{label:"Tempered Glass",type:"bool"},usb_c:{label:"Front USB-C",type:"bool"}}},
  CPU:{icon:"🔴",label:"Processors",singular:"CPU",desc:"Desktop CPUs",cols:["cores","socket","tdp","bench"],filters:{socket:{label:"Socket",type:"check"},cores:{label:"Core Count",type:"check"},tdp:{label:"TDP",type:"range",unit:"W"},arch:{label:"Architecture",type:"check"},memType:{label:"Memory Type",type:"check"},igpu:{label:"Integrated Graphics",type:"bool"},vcache:{label:"3D V-Cache",type:"bool"},serverCPU:{label:"Server CPU",type:"bool"}}},
  CPUCooler:{icon:"❄️",label:"CPU Coolers",singular:"CPU Cooler",desc:"Air & AIO liquid coolers",cols:["coolerType","tdp_rating","cfm","noise"],filters:{coolerType:{label:"Type",type:"check"},tdp_rating:{label:"TDP Rating",type:"range",unit:"W"},cfm:{label:"Airflow (CFM)",type:"range"},noise:{label:"Noise Level",type:"range",unit:"dBA"},radSize:{label:"Radiator Size",type:"check"},fans:{label:"Fan Count",type:"check"}}},
  Motherboard:{icon:"🟡",label:"Motherboards",singular:"Motherboard",desc:"ATX, mATX & ITX boards",cols:["socket","ff","chipset","wifi"],filters:{socket:{label:"Socket",type:"check"},chipset:{label:"Chipset",type:"check"},ff:{label:"Form Factor",type:"check"},memType:{label:"Memory Type",type:"check"},memSlots:{label:"Memory Slots",type:"check"},m2Slots:{label:"M.2 Slots",type:"check"},wifi:{label:"WiFi",type:"check"},usb_c:{label:"USB-C",type:"bool"}}},
  RAM:{icon:"⚡",label:"Memory",singular:"RAM Kit",desc:"DDR5 & DDR4 kits",cols:["memType","cap","sticks","speed","cl"],filters:{memType:{label:"Type",type:"check"},formFactor:{label:"Form Factor",type:"check"},cap:{label:"Total Capacity",type:"check"},sticks:{label:"Kit (Sticks)",type:"check"},speed:{label:"Speed (MHz)",type:"check"},cl:{label:"CAS Latency",type:"check"},ecc:{label:"ECC",type:"bool"},rgb:{label:"RGB",type:"bool"}}},
  GPU:{icon:"💚",label:"Video Cards",singular:"Graphics Card",desc:"Gaming & workstation GPUs",cols:["vram","tdp","length","bench"],filters:{vram:{label:"VRAM (GB)",type:"check"},memType:{label:"Memory Type",type:"check"},tdp:{label:"TDP",type:"range",unit:"W"},length:{label:"Card Length",type:"range",unit:"mm"},slots:{label:"Slot Width",type:"check"},pwr:{label:"Power Connector",type:"check"},segment:{label:"Use Case",type:"check"},arch:{label:"Architecture",type:"check"},pcie:{label:"PCIe Version",type:"check"}}},
  Storage:{icon:"💾",label:"Storage",singular:"Drive",desc:"NVMe SSDs, SATA SSDs & HDDs",cols:["storageType","cap","seq_r"],multi:true,maxQty:6,filters:{storageType:{label:"Type",type:"check"},interface:{label:"Interface",type:"check"},pcie:{label:"PCIe Gen",type:"check"},cap:{label:"Capacity",type:"check"},ff:{label:"Form Factor",type:"check"},dram:{label:"DRAM Cache",type:"bool"}}},
  PSU:{icon:"🔌",label:"Power Supplies",singular:"PSU",desc:"Modular & semi-modular",cols:["watts","eff","modular","color"],filters:{watts:{label:"Wattage",type:"check"},eff:{label:"Rating",type:"check"},modular:{label:"Modularity",type:"check"},ff:{label:"Form Factor",type:"check"},color:{label:"Color",type:"check"},rgb:{label:"RGB",type:"bool"},atx3:{label:"ATX 3.0",type:"bool"}}},
  // Cooling
  CaseFan:{icon:"🌀",label:"Case Fans",singular:"Case Fan",desc:"120mm & 140mm case fans",cols:["size","cfm","noise","color","rgb","rgbType","rgbConnector"],multi:true,maxQty:10,filters:{size:{label:"Size (mm)",type:"check"},color:{label:"Color",type:"check"},rgb:{label:"RGB",type:"bool"},rgbType:{label:"RGB Type",type:"check"},rgbConnector:{label:"RGB Connector",type:"check"},pack:{label:"Pack Size",type:"check"},connector:{label:"Fan Connector",type:"check"}}},
  // Expansion
  SoundCard:{icon:"🔊",label:"Sound Cards",singular:"Sound Card",desc:"PCIe sound cards",cols:["channels","snr","sampleRate","bitDepth","hasAmp"],filters:{channels:{label:"Channels",type:"check"},snr:{label:"SNR (dB)",type:"range",unit:"dB"},sampleRate:{label:"Sample Rate",type:"check"},bitDepth:{label:"Bit Depth",type:"check"},hasAmp:{label:"Headphone Amp",type:"bool"},impedance:{label:"Max Impedance",type:"range",unit:"Ω"},formFactor:{label:"Form Factor",type:"check"},digitalOut:{label:"Digital Output",type:"bool"}}},
  EthernetCard:{icon:"🌐",label:"Ethernet Adapters",singular:"Ethernet Card",desc:"2.5G/5G/10GbE PCIe network cards",cols:["lanSpeed","ports","chipset","pcieLane","profile"],filters:{lanSpeed:{label:"Speed",type:"check"},ports:{label:"Port Count",type:"check"},chipset:{label:"Chipset",type:"check"},pcieLane:{label:"PCIe Lane",type:"check"},profile:{label:"Profile",type:"check"},wol:{label:"Wake-on-LAN",type:"bool"},vlan:{label:"VLAN Support",type:"bool"},pxe:{label:"PXE Boot",type:"bool"}}},
  WiFiCard:{icon:"📶",label:"WiFi Adapters",singular:"WiFi Card",desc:"WiFi 6E/7 PCIe cards",cols:["wifiStandard","maxSpeed","bt","antennas","pcieLane"],filters:{wifiStandard:{label:"WiFi Standard",type:"check"},bt:{label:"Bluetooth",type:"check"},antennas:{label:"Antennas",type:"check"},pcieLane:{label:"PCIe Lane",type:"check"},band:{label:"Band",type:"check"},heatsink:{label:"Heatsink",type:"bool"}}},
  OpticalDrive:{icon:"💿",label:"Optical Drives",singular:"Optical Drive",desc:"Blu-ray & DVD drives",cols:["driveType","readSpeed","writeSpeed"],filters:{driveType:{label:"Type",type:"check"},interface:{label:"Interface",type:"check"}}},
  InternalLCD:{icon:"📺",label:"Internal LCDs",singular:"Internal LCD",desc:"Case-mounted monitoring screens",cols:[]},
  ExtensionCables:{icon:"🔗",label:"Extension Cables",singular:"Cable Kit",desc:"Sleeved PSU extensions",cols:[],multi:true,maxQty:4},
  
  InternalDisplay:{icon:"🖥️",label:"Internal Displays",singular:"Display",desc:"LCD/IPS screens for inside your PC case",cols:["size","resolution","connection"],filters:{size:{label:"Screen Size",type:"check"},connection:{label:"Connection",type:"check"},panelType:{label:"Panel",type:"check"},ecosystem:{label:"Ecosystem",type:"check"},touch:{label:"Touchscreen",type:"bool"}}},
OS:{icon:"🪟",label:"Operating Systems",singular:"OS",desc:"Windows & Linux",cols:[]},
  // Peripherals
  Monitor:{icon:"🖥️",label:"Monitors",singular:"Monitor",desc:"Gaming & productivity",cols:["screenSize","res","refresh","panel"],multi:true,maxQty:4,filters:{screenSize:{label:"Screen Size",type:"check"},res:{label:"Resolution",type:"check"},refresh:{label:"Refresh Rate",type:"check"},panel:{label:"Panel Type",type:"check"},sync:{label:"Adaptive Sync",type:"check"},hdr:{label:"HDR",type:"check"},response:{label:"Response Time",type:"range",unit:"ms"}}},
  Keyboard:{icon:"⌨️",label:"Keyboards",singular:"Keyboard",desc:"Mechanical & membrane",cols:["switches","layout","wireless"],filters:{switches:{label:"Switch Type",type:"check"},layout:{label:"Layout",type:"check"},wireless:{label:"Wireless",type:"bool"},rgb:{label:"RGB",type:"bool"}}},
  Mouse:{icon:"🖱️",label:"Mice",singular:"Mouse",desc:"Gaming & productivity mice",cols:["sensor","dpi","weight"],filters:{mouseType:{label:"Connectivity",type:"check"},weight:{label:"Weight",type:"range",unit:"g"},dpi:{label:"Max DPI",type:"range"}}},
  Headset:{icon:"🎧",label:"Headsets",singular:"Headset",desc:"Gaming & audiophile",cols:["hsType","driver","mic"],filters:{hsType:{label:"Connectivity",type:"check"},mic:{label:"Microphone",type:"bool"},anc:{label:"ANC",type:"bool"}}},
  Webcam:{icon:"📷",label:"Webcams",singular:"Webcam",desc:"4K & 1080p cameras",cols:[]},
  Microphone:{icon:"🎙️",label:"Microphones",singular:"Microphone",desc:"USB & XLR mics",cols:[]},
  MousePad:{icon:"🖼️",label:"Mouse Pads",singular:"Mouse Pad",desc:"Cloth & hard surface",cols:[]},
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
// Builder table sections
const CORE_CATS=["Case","CPU","CPUCooler","Motherboard","RAM","GPU","Storage","PSU"];
const COOLING_CATS=["CaseFan"];
const EXPANSION_CATS=["SoundCard","EthernetCard","WiFiCard","OpticalDrive","InternalLCD"];
const CABLE_CATS=["ExtensionCables","OS"];
const PERIPH_CATS=["Monitor","Keyboard","Mouse","Headset","Webcam","Microphone","MousePad","Chair","Desk"];
const ACCESSORY_CATS=["ThermalPaste","ExternalStorage","Antivirus","ExternalOptical","UPS"];
const BUILD_CATS=[...CORE_CATS,...COOLING_CATS,...EXPANSION_CATS,...CABLE_CATS];
const ALL_BUILDER_CATS=[...BUILD_CATS,...PERIPH_CATS,...ACCESSORY_CATS];
const BUILDER_SECTIONS=[
  {id:"core",label:"Core Components",icon:"🔧",cats:CORE_CATS},
  {id:"cooling",label:"Cooling & Fans",icon:"🌀",cats:COOLING_CATS},
  {id:"expansion",label:"Expansion & Drives",icon:"🔌",cats:EXPANSION_CATS},
  {id:"cables",label:"Cables & OS",icon:"🔗",cats:CABLE_CATS},
  {id:"peripherals",label:"Peripherals",icon:"🖥️",cats:PERIPH_CATS},
  {id:"accessories",label:"Accessories",icon:"🎒",cats:ACCESSORY_CATS},
];
const SL={cores:"Cores/Threads",socket:"Socket",tdp:"TDP",bench:"Score",vram:"VRAM",cap:"Capacity",speed:"Speed",ff:"Form Factor",wifi:"WiFi",storageType:"Type",watts:"Watts",eff:"Rating",modular:"Modular",panel:"Panel",res:"Resolution",refresh:"Refresh",screenSize:"Screen",switches:"Switches",layout:"Layout",wireless:"Wireless",baseClock:"Base Clock",boostClock:"Boost Clock",threads:"Threads",length:"Length",pwr:"Power",seq_r:"Read",seq_w:"Write",cl:"CAS Latency",ramType:"Type",chipset:"Chipset",coolerType:"Type",noise:"Noise",tdp_rating:"TDP Rating",fans_inc:"Fans Included",maxGPU:"Max GPU Length",maxCooler:"Max Cooler",cfm:"Airflow",size:"Size",sensor:"Sensor",dpi:"DPI",weight:"Weight",driver:"Driver",mic:"Mic",hsType:"Type",mouseType:"Type",segment:"Use Case",arch:"Architecture",pcie:"PCIe",tg:"Glass Panel",usb_c:"USB-C",mobo:"Mobo Support",drive25:"2.5in Bays",drive35:"3.5in Bays",memType:"Memory",memSlots:"RAM Slots",maxMem:"Max RAM",m2Slots:"M.2 Slots",lan:"Ethernet",ecc:"ECC",rgb:"RGB",rgbType:"RGB Type",rgbConnector:"RGB Connector",color:"Color",igpu:"iGPU",igpuName:"iGPU Name",vcache:"V-Cache",serverCPU:"Server",pCores:"P-Cores",eCores:"E-Cores",l3:"L3 Cache",nm:"Process",bus:"Bus Width",slots:"Slot Width",interface:"Interface",dram:"DRAM Cache",tlc:"NAND Type",pack:"Pack",atx3:"ATX 3.0",radSize:"Radiator",rads:"AIO Support",height:"Height",fans:"Fans",fanSize:"Fan Size",response:"Response",sync:"Adaptive Sync",hdr:"HDR",curved:"Curved",hotswap:"Hot-Swap",pollingRate:"Polling Rate",shape:"Grip",anc:"ANC",surroundSound:"Surround",openBack:"Open Back",autofocus:"Autofocus",fov:"FOV",pattern:"Pattern",sampleRate:"Sample Rate",bitDepth:"Bit Depth",connection:"Connection",connector:"Fan Connector",channels:"Channels",snr:"SNR",hasAmp:"Headphone Amp",lanSpeed:"Speed",ports:"Ports",wifiStandard:"WiFi",bt:"Bluetooth",driveType:"Drive Type",readSpeed:"Read Speed",writeSpeed:"Write Speed",memSpeed:"Memory Speed*",audio:"Audio",sticks:"Sticks",voltage:"Voltage",cuda:"CUDA Cores",boost:"Boost Clock",tier:"Suggested Use",sp:"Stream Processors",xeCores:"Xe Cores",maxMemSpeed:"Max RAM Speed",sata:"SATA Ports",pciSlots:"PCIe Slots",impedance:"Max Impedance",formFactor:"Form Factor",digitalOut:"Digital Output",pcieLane:"PCIe Lane",profile:"Profile",wol:"Wake-on-LAN",vlan:"VLAN",pxe:"PXE Boot",maxSpeed:"Max Speed",antennas:"Antennas",band:"Band",heatsink:"Heatsink",dacChip:"DAC Chip",outputPower:"Output Power",upc:"UPC",mpn:"Model #",model:"Model",generation:"Generation",vramType:"VRAM Type",dimensions:"Dimensions",form:"Form",tower:"Tower",series:"Series",compatibility:"Compatibility",contrast:"Contrast",rpm:"RPM"};
const SF={cores:(v,p)=>p&&p.threads?v+"C/"+p.threads+"T":v+"C",sticks:(v,p)=>{if(!v)return v;const total=p&&(p.cap||p.capacity);if(total&&v>0){const per=Math.round(total/v);return v+"x"+per+"GB";}return v+"x";},tdp:v=>v+"W",vram:v=>typeof v==="number"?v+"GB":v,cap:v=>typeof v==="number"?(v>=1000?(Math.round(v/100)/10).toString().replace(/\.0$/,"")+"TB":v+"GB"):v,speed:v=>v+"MHz",watts:v=>v+"W",wifi:v=>v||"None",refresh:v=>v+"Hz",screenSize:v=>v+'"',bench:v=>v+"%",baseClock:v=>v+"GHz",boostClock:v=>v+"GHz",length:v=>v+"mm",seq_r:v=>v>=1000?(v/1000).toFixed(1)+"GB/s":v+"MB/s",seq_w:v=>v>=1000?(v/1000).toFixed(1)+"GB/s":v+"MB/s",noise:v=>{const n=typeof v==="number"?v:parseFloat(v);if(isNaN(n))return v;const ref=n<=15?"Near silent":n<=20?"Whisper quiet":n<=25?"Library quiet":n<=30?"Quiet room":n<=35?"Light hum":n<=40?"Noticeable":"Loud";return n+"dBA\n"+ref;},tdp_rating:(v,p)=>p&&p.tdp_rating_est?"~"+v+"W":v+"W",maxGPU:v=>v+"mm",maxCooler:v=>v+"mm",cfm:v=>typeof v==="number"?v.toFixed(1)+" CFM":v,dpi:v=>v>=1000?(v/1000)+"K":v,weight:v=>{if(v==null)return"—";if(typeof v==="number")return v+"g";const s=String(v);let m=s.match(/([\d.]+)\s*(kilogram|kg)/i);if(m)return(parseFloat(m[1])*2.20462).toFixed(1)+" lbs";m=s.match(/([\d.]+)\s*(gram|g)\b/i);if(m)return(parseFloat(m[1])/453.592).toFixed(2)+" lbs";m=s.match(/([\d.]+)\s*(pound|lb|lbs)/i);if(m)return parseFloat(m[1]).toFixed(1)+" lbs";m=s.match(/([\d.]+)\s*(ounce|oz)/i);if(m)return(parseFloat(m[1])/16).toFixed(2)+" lbs";return s;},cl:v=>"CL"+v,driver:v=>v+"mm",height:v=>v+"mm",voltage:v=>v+"V",boost:v=>v+"MHz",tier:v=>typeof v==="string"?v.charAt(0).toUpperCase()+v.slice(1):v,snr:v=>v+"dB",sampleRate:v=>v+"kHz",lanSpeed:v=>v,tg:v=>v?"Yes":"No",usb_c:v=>v?"Yes":"No",ecc:v=>v?"Yes":"No",rgb:v=>v?"Yes":"No",igpu:v=>v?"Yes":"No",vcache:v=>v?"Yes":"No",serverCPU:v=>v?"Yes":"No",atx3:v=>v?"Yes":"No",dram:v=>v?"Yes":"No",wireless:v=>v?"Yes":"No",curved:v=>v?"Yes":"No",hotswap:v=>v?"Yes":"No",anc:v=>v?"Yes":"No",mic:v=>typeof v==="boolean"?(v?"Yes":"No"):v,hasAmp:v=>v?"Yes":"No",autofocus:v=>v?"Yes":"No",wol:v=>v?"Yes":"No",vlan:v=>v?"Yes":"No",pxe:v=>v?"Yes":"No",digitalOut:v=>v?"Yes":"No",heatsink:v=>v?"Yes":"No",pwm:v=>v?"Yes":"No",impedance:v=>v+"Ω",pcie:v=>String(v).startsWith("Gen")?v:"Gen"+v,fanSize:v=>typeof v==="number"?v+"mm":v,fans_inc:v=>v+(v===1?" fan":" fans"),socket:v=>typeof v==="string"?v.toUpperCase():v,chipset:v=>typeof v==="string"?v.toUpperCase():v,memType:v=>typeof v==="string"?v.toUpperCase():v,panel:v=>typeof v==="string"?v.toUpperCase():v,upc:v=>{if(!v)return"—";const list=String(v).split(",").map(x=>x.trim()).filter(Boolean);return list.length>1?list[0]+" (+"+(list.length-1)+")":list[0];},rads:v=>{if(!v)return"None";const sizes=String(v).split(",").map(s=>s.trim());const max=Math.max(...sizes.map(s=>parseInt(s)||0));return max>=360?"Up to 360mm":max>=280?"Up to 280mm":max>=240?"Up to 240mm":max>=120?"120mm only":"None";}};
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
const msrp = p => p.msrp || p.pr;
const fmtPrice = n => { if (n == null) return '0'; const r = Math.round(n * 100) / 100; return r % 1 === 0 ? String(r) : r.toFixed(2); };
const retailers = p => {
  if (!p.deals || typeof p.deals !== "object") return [];
  return Object.entries(p.deals)
    .filter(([k,v]) => typeof v === "object" && v.price)
    .map(([name, info]) => ({ name, price: info.price, url: info.url, inStock: info.inStock !== false }))
    .sort((a,b) => a.price - b.price);
};

// ── Global list of retailers tracked anywhere in the dataset — for N/A display on missing retailers ──
const ALL_RETAILERS = [...new Set(SEED_PARTS.flatMap(p =>
  p.deals && typeof p.deals === "object"
    ? Object.keys(p.deals).filter(k => p.deals[k] && typeof p.deals[k] === "object" && p.deals[k].price)
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
const uv=(cat,f,extract)=>{const items=P.filter(p=>p.c===cat&&p[f]!=null);const vals=extract?items.map(p=>extract(p)).filter(v=>v!=null&&v!==""):items.map(p=>String(p[f]));return [...new Set(vals)].sort((a,b)=>String(a).localeCompare(String(b),undefined,{numeric:true}));};

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
            <span style={{fontFamily:"var(--ff)",fontSize:10,fontWeight:600,color:"var(--txt)",textTransform:"capitalize"}}>{r.name}</span>
            {i===0 && <Tag color="var(--mint)">BEST</Tag>}
            {!r.inStock && <Tag color="var(--rose)">OOS</Tag>}
          </div>
          <span style={{fontFamily:"var(--mono)",fontSize:12,fontWeight:700,color:i===0?"var(--mint)":"var(--txt)"}}>${fmtPrice(r.price)}</span>
        </a>
      ))}
    </div>
  );
}

/* ═══ STYLES ═══ */
const css=`
[data-theme="dark"]{--bg:#141418;--bg2:#1c1c22;--bg3:#232329;--bg4:#2c2c34;--bdr:rgba(255,255,255,0.06);--bdr2:rgba(255,255,255,0.1);--accent:#FF6B35;--accent2:#FF6B3540;--accent3:#FF6B3514;--mint:#FF6B35;--mint2:#FF6B3540;--mint3:#FF6B3514;--txt:#f0ede8;--dim:#a29d93;--mute:#6f685d;--amber:#f5a623;--rose:#ef4444;--sky:#38bdf8;--violet:#a78bfa;--ff:'Sora',system-ui,sans-serif;--mono:'DM Mono',monospace;--navbg:rgba(20,20,24,0.88);--heroGrad:linear-gradient(160deg,#141418 0%,#1e1410 40%,#141418 100%);--card:rgba(28,28,34,0.7);--shadow:0 4px 24px rgba(0,0,0,.25);--shadowSm:0 2px 8px rgba(0,0,0,.15)}
[data-theme="light"]{--bg:#faf8f5;--bg2:#ffffff;--bg3:#f2efe8;--bg4:#e8e4dc;--bdr:rgba(120,100,80,0.1);--bdr2:rgba(120,100,80,0.15);--accent:#d94e1c;--accent2:#d94e1c40;--accent3:#d94e1c10;--mint:#d94e1c;--mint2:#d94e1c40;--mint3:#d94e1c10;--txt:#1f1a16;--dim:#5a5248;--mute:#8a8378;--amber:#d4940a;--rose:#dc2626;--sky:#0284c7;--violet:#7c3aed;--ff:'Sora',system-ui,sans-serif;--mono:'DM Mono',monospace;--navbg:rgba(250,248,245,0.92);--heroGrad:linear-gradient(160deg,#faf8f5 0%,#fff4ec 40%,#faf8f5 100%);--card:rgba(255,255,255,0.8);--shadow:0 4px 24px rgba(80,60,30,.08);--shadowSm:0 2px 8px rgba(80,60,30,.05)}
*{box-sizing:border-box;margin:0}::selection{background:var(--accent3);color:var(--accent)}
.mega-in{animation:mIn .2s cubic-bezier(.16,1,.3,1)}@keyframes mIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
.fade{animation:fIn .35s cubic-bezier(.16,1,.3,1)}@keyframes fIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.card{background:var(--card,var(--bg2));border-radius:16px;border:1px solid var(--bdr);box-shadow:var(--shadowSm);transition:all .25s cubic-bezier(.16,1,.3,1)}.card:hover{box-shadow:var(--shadow);transform:translateY(-2px)}
input[type=range]{-webkit-appearance:none;background:transparent;cursor:pointer}input[type=range]::-webkit-slider-runnable-track{height:6px;border-radius:3px;background:#c8bfb2}input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--accent);margin-top:-5px;border:2px solid var(--bg2);box-shadow:0 1px 3px rgba(0,0,0,.15)}input[type=range]::-moz-range-track{height:6px;border-radius:3px;background:#c8bfb2;border:none}input[type=range]::-moz-range-thumb{width:18px;height:18px;border-radius:50%;background:var(--accent);border:2px solid var(--bg);box-shadow:0 2px 8px rgba(255,107,53,.4)}select{-webkit-appearance:none}
@media(max-width:768px){.hero-grid{grid-template-columns:1fr!important}.cat-grid{grid-template-columns:repeat(3,1fr)!important}.deals-grid{grid-template-columns:1fr!important}.how-grid{grid-template-columns:1fr!important}.search-layout{grid-template-columns:1fr!important}.footer-grid{grid-template-columns:1fr 1fr!important;gap:20px!important}.hero-stats{grid-template-columns:1fr 1fr!important}}
@media(max-width:480px){.cat-grid{grid-template-columns:repeat(2,1fr)!important}.footer-grid{grid-template-columns:1fr!important}}

/* === MOBILE RESPONSIVE === */
html, body { overflow-x: hidden; max-width: 100vw; }
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
  [style*="padding:\"72px 32px"] { padding: 40px 18px !important; }

  /* Pills/cards in grids become stack-friendly */
  [style*="gridTemplateColumns"] { gap: 12px !important; }

  /* Large wizard/tool grids */
  [style*="gridTemplateColumns:\"2fr"], [style*="gridTemplateColumns:\"4fr"] {
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
  [style*="position:\"sticky"][style*="top:80"] {
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
  overflow-x: hidden !important;
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
  return <label style={{display:"flex",alignItems:"center",gap:6,padding:"3px 0",cursor:"pointer",fontSize:11,fontFamily:"var(--ff)",color:checked?"var(--accent)":"var(--txt)"}}>
    <input type="checkbox" checked={checked} onChange={onChange} style={{accentColor:"var(--accent)",margin:0}}/>
    <span style={{flex:1}}>{label}</span>
    {count!=null&&<span style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--mute)"}}>{count}</span>}
  </label>;
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
  const filtered=query?options.filter(o=>o.label.toLowerCase().includes(query.toLowerCase())):options;
  const selectedLabel=options.find(o=>o.value===value)?.label||"";
  return <div ref={ref} style={{position:"relative",marginBottom:8}}>
    <div onClick={()=>{setOpen(!open);if(!open)setTimeout(()=>inputRef.current?.focus(),50);}}
      style={{display:"flex",alignItems:"center",gap:6,width:"100%",background:"var(--bg4)",border:`1px solid ${open?"var(--accent)44":"var(--bdr)"}`,borderRadius:8,padding:"8px 12px",cursor:"pointer",transition:"border .15s"}}>
      {open
        ?<input ref={inputRef} value={query} onChange={e=>{e.stopPropagation();setQuery(e.target.value);}}
          onClick={e=>e.stopPropagation()}
          placeholder={selectedLabel||placeholder}
          style={{flex:1,background:"none",border:"none",outline:"none",fontSize:12,color:"var(--txt)",fontFamily:"var(--ff)",width:"100%"}}/>
        :<span style={{flex:1,fontSize:12,fontFamily:"var(--ff)",color:value?"var(--txt)":"var(--mute)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{selectedLabel||placeholder}</span>
      }
      <span style={{fontSize:10,color:"var(--mute)",transition:"transform .2s",transform:open?"rotate(180deg)":"none",flexShrink:0}}>▾</span>
    </div>
    {open&&<div style={{position:"absolute",top:"calc(100% + 4px)",left:0,right:0,background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,boxShadow:"0 8px 32px rgba(0,0,0,.15)",zIndex:50,maxHeight:240,overflowY:"auto",padding:4}}>
      {filtered.length===0&&<div style={{padding:"12px 16px",fontFamily:"var(--ff)",fontSize:11,color:"var(--mute)",textAlign:"center"}}>No results found</div>}
      {filtered.map(o=><button key={o.value} onClick={e=>{e.stopPropagation();onChange(o.value);setOpen(false);setQuery("");}}
        style={{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"8px 12px",borderRadius:6,background:value===o.value?"var(--accent3)":"transparent",border:"none",cursor:"pointer",textAlign:"left",fontFamily:"var(--ff)",fontSize:12,color:value===o.value?"var(--accent)":"var(--txt)",transition:"background .1s"}}
        onMouseEnter={e=>{if(value!==o.value)e.currentTarget.style.background="var(--bg3)";}}
        onMouseLeave={e=>{if(value!==o.value)e.currentTarget.style.background="transparent";}}>
        <span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{o.label}</span>
        {o.detail&&<span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",flexShrink:0}}>{o.detail}</span>}
        {value===o.value&&<span style={{fontSize:11,color:"var(--accent)",flexShrink:0}}>✓</span>}
      </button>)}
    </div>}
  </div>;
}

/* ═══ TOWER LOGO SVG ═══ */
function TowerLogo({size=36}){
  return <svg width={size} height={size*44/36} viewBox="0 0 36 44" fill="none" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="tg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#FF6B35"/><stop offset="100%" stopColor="#F5A623"/></linearGradient></defs>
    <rect x="0" y="0" width="36" height="44" rx="5" fill="none" stroke="var(--accent)" strokeWidth="1" opacity=".3"/>
    <rect x="5" y="5" width="26" height="7" rx="2" fill="url(#tg)"/>
    <rect x="5" y="15" width="26" height="5" rx="1.5" fill="var(--accent)"/>
    <rect x="5" y="23" width="26" height="4" rx="1" fill="var(--accent)" opacity=".7"/>
    <rect x="10" y="30" width="16" height="5" rx="1.5" fill="var(--accent)" opacity=".85"/>
    <rect x="5" y="38" width="26" height="3" rx="1" fill="var(--accent)" opacity=".4"/>
  </svg>;
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
  InternalLCD: null, // no product image available
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
function MegaMenu({onSelect,onClose,th}){
  const G=[{t:"Components",cats:["CPU","GPU","RAM","Motherboard","Storage","PSU"]},{t:"Build",cats:["Case","CPUCooler","CaseFan"]},{t:"Peripherals",cats:["Monitor","Keyboard","Mouse","Headset"]},{t:"Expansion",cats:["SoundCard","WiFiCard","EthernetCard","ExtensionCables"]}];
  return <div className="mega-in" style={{position:"absolute",top:"100%",left:0,right:0,background:"var(--bg2)",borderBottom:"1px solid var(--bdr2)",zIndex:100,padding:"20px 0"}} onMouseLeave={onClose}>
    <div style={{maxWidth:960,margin:"0 auto",display:"flex",gap:32,padding:"0 24px"}}>
      {G.map(g=><div key={g.t} style={{flex:1}}><div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--mint)",letterSpacing:2,marginBottom:10,fontWeight:600}}>{g.t.toUpperCase()}</div>{g.cats.map(c=>{const m=CAT[c];return <button key={c} onClick={()=>{onSelect(c);onClose();}} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 8px",borderRadius:6,background:"transparent",border:"none",cursor:"pointer",textAlign:"left",color:"var(--txt)",fontFamily:"var(--ff)",width:"100%"}}><CatThumb cat={c} thumbs={th.thumbs} setThumb={th.setThumb} removeThumb={th.removeThumb} size={32} rounded={6} editable={false}/><div style={{flex:1}}><div style={{fontSize:12,fontWeight:600}}>{m.label}</div><div style={{fontSize:9,color:"var(--dim)"}}>{m.desc}</div></div><span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--mute)"}}>{P.filter(p=>p.c===c).length}</span></button>})}</div>)}
      <div style={{width:180,background:"var(--bg3)",borderRadius:10,padding:14}}><div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--amber)",letterSpacing:1,marginBottom:6}}>🔥 TRENDING</div>{P.filter(p=>p.bench>=95).slice(0,3).map(p=><div key={p.id} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:"1px solid var(--bdr)"}}><span style={{fontSize:11,color:"var(--txt)"}}>{p.n}</span><span style={{fontSize:10,color:"var(--mint)",fontFamily:"var(--mono)",fontWeight:600}}>${fmtPrice($(p))}</span></div>)}</div>
    </div>
  </div>;
}

/* ═══ NAV ═══ */
function Nav({page,setPage,onBrowse,th,theme,toggleTheme}){
  const [mega,setMega]=useState(false);
  const canGoBack = page !== "home";
  return <nav style={{position:"sticky",top:0,zIndex:200,backdropFilter:"blur(20px)",background:"var(--navbg)"}}>
    <div style={{maxWidth:1200,margin:"0 auto",display:"flex",alignItems:"center",height:64,padding:"0 32px",gap:8}}>
      {canGoBack&&<button onClick={()=>window.history.back()} style={{background:"none",border:"none",cursor:"pointer",color:"var(--dim)",fontSize:18,padding:"4px 8px 4px 0"}} title="Go back">←</button>}
      {/* Logo */}
      <button onClick={()=>setPage("home")} style={{background:"none",border:"none",cursor:"pointer",display:"flex",alignItems:"center",gap:8,marginRight:24}}>
        <TowerLogo size={30}/>
        <div><div style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:700,color:"var(--txt)",lineHeight:1.1}}>Pro Rig</div><div style={{fontFamily:"var(--ff)",fontSize:9,fontWeight:500,color:"var(--dim)",letterSpacing:1.5}}>BUILDER</div></div>
      </button>
      <button onClick={()=>setPage("scanner")} style={{display:"inline-flex",alignItems:"center",gap:6,padding:"6px 12px",borderRadius:20,background:"var(--accent3)",border:"1px solid var(--accent)",color:"var(--accent)",fontFamily:"var(--ff)",fontSize:11,fontWeight:700,cursor:"pointer",marginRight:20,transition:"all .15s"}}
        onMouseEnter={e=>{e.currentTarget.style.background="var(--accent)";e.currentTarget.style.color="#fff";}}
        onMouseLeave={e=>{e.currentTarget.style.background="var(--accent3)";e.currentTarget.style.color="var(--accent)";}}>
        <span style={{fontSize:13}}>📥</span> Scanner
      </button>
      {/* Nav links */}
      <div style={{display:"flex",gap:2,flex:1,position:"relative"}}>
        {[{id:"browse",label:"Browse Parts",act:()=>setMega(!mega),arrow:true},{id:"builder",label:"PC Builder"},{id:"community",label:"Builds"},{id:"tools",label:"Smart Tools"}].map(n=>
          <button key={n.id} onClick={n.act||(()=>{setPage(n.id);setMega(false);})} style={{padding:"8px 16px",borderRadius:10,fontSize:13,fontFamily:"var(--ff)",fontWeight:page===n.id?600:400,cursor:"pointer",background:page===n.id?"var(--accent3)":"transparent",color:page===n.id?"var(--accent)":"var(--dim)",border:"none",transition:"all .2s"}}>{n.label}{n.arrow?" ▾":""}</button>
        )}
        {mega&&<MegaMenu onSelect={c=>{onBrowse(c);setPage("search");}} onClose={()=>setMega(false)} th={th}/>}
      </div>
      {/* Theme toggle — pill shape */}
      <button onClick={toggleTheme} style={{background:"var(--bg4)",border:"none",borderRadius:20,padding:"6px 14px",cursor:"pointer",display:"flex",alignItems:"center",gap:6,fontSize:13,color:"var(--dim)",fontFamily:"var(--ff)",fontWeight:500,transition:"all .2s"}} title={theme==="dark"?"Switch to light mode":"Switch to dark mode"}>
        {theme==="dark"?"☀️":"🌙"}<span style={{fontSize:10,fontWeight:600}}>{theme==="dark"?"Light":"Dark"}</span>
      </button>
    </div>
  </nav>;
}

/* ═══ HOME ═══ */
function ScannerPage({go}) {
  return (
    <div className="fade">
      <SEO title="Pro Rig Scanner — Free PC Hardware Scanner for Windows" description="Download our free Windows app that detects your PC hardware automatically and recommends personalized upgrades within your budget. 100% private — no data collected." canonical="https://prorigbuilder.com/#scanner" breadcrumb={[{name:"Home",url:"https://prorigbuilder.com/"},{name:"Scanner",url:"https://prorigbuilder.com/#scanner"}]}/>
      {/* ── HERO ── */}
      <div style={{background:"var(--heroGrad)",position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",top:"10%",right:"-5%",width:500,height:500,borderRadius:"50%",background:"radial-gradient(circle, rgba(255,107,53,0.08) 0%, transparent 60%)",pointerEvents:"none"}}/>
        <div style={{maxWidth:1000,margin:"0 auto",padding:"72px 32px 56px",position:"relative"}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"var(--amber)",color:"#1a1a20",padding:"5px 14px",borderRadius:14,fontFamily:"var(--mono)",fontSize:11,fontWeight:800,letterSpacing:1.5,marginBottom:24}}>
            ✨ NEW · PROPRIETARY SOLUTION
          </div>
          <h1 style={{fontFamily:"var(--ff)",fontSize:48,fontWeight:800,color:"var(--txt)",lineHeight:1.05,letterSpacing:-1.2,maxWidth:720}}>
            Meet the <span style={{background:"linear-gradient(135deg, var(--accent), var(--amber))",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>Pro Rig Scanner</span>
          </h1>
          <p style={{fontFamily:"var(--ff)",fontSize:17,color:"var(--dim)",marginTop:18,lineHeight:1.7,maxWidth:640}}>
            Download our free Windows app, run a quick scan, and get personalized upgrade recommendations tailored to your budget. The scan runs 100% locally on your PC — we never see, store, or collect any of your hardware data. No other site offers this.
          </p>
          <div style={{display:"flex",gap:12,marginTop:32,flexWrap:"wrap"}}>
            <a href="https://github.com/tiereduptech/pro-rig-builder/releases/latest/download/ProRigScanner.exe" download style={{textDecoration:"none",padding:"14px 32px",borderRadius:14,fontSize:15,fontFamily:"var(--ff)",fontWeight:700,background:"var(--accent)",color:"#fff",border:"none",boxShadow:"0 6px 24px rgba(255,107,53,.3)",display:"inline-flex",alignItems:"center",gap:8,transition:"transform .15s"}}
              onMouseEnter={e=>e.currentTarget.style.transform="translateY(-1px)"}
              onMouseLeave={e=>e.currentTarget.style.transform="none"}>
              📥 Download for Windows
            </a>
            <button onClick={()=>go("search")} style={{padding:"14px 32px",borderRadius:14,fontSize:15,fontFamily:"var(--ff)",fontWeight:600,cursor:"pointer",background:"var(--bg3)",color:"var(--txt)",border:"1px solid var(--bdr)"}}>
              Browse Parts Manually
            </button>
          </div>
          <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",marginTop:14,letterSpacing:1}}>
            WINDOWS 10 / 11 · 100% PRIVATE · NO ACCOUNT · NO TRACKING · FREE
          </div>
        </div>
      </div>

      {/* ── HOW IT WORKS ── */}
      <div style={{background:"var(--bg2)",borderBottom:"1px solid var(--bdr)"}}>
        <div style={{maxWidth:1000,margin:"0 auto",padding:"64px 32px"}}>
          <div style={{textAlign:"center",marginBottom:48}}>
            <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",fontWeight:600,letterSpacing:2,marginBottom:8}}>HOW IT WORKS</div>
            <h2 style={{fontFamily:"var(--ff)",fontSize:32,fontWeight:800,color:"var(--txt)",letterSpacing:-0.5}}>Three steps. Thirty seconds.</h2>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:32}} className="how-grid">
            {[
              {n:"01",t:"Download & Run",d:"Get the free Pro Rig Scanner for Windows. Under 2 MB, no install, no account required. Just double-click to launch."},
              {n:"02",t:"Scan Your Hardware",d:"The scanner detects your CPU, GPU, RAM, storage, and motherboard in about 10 seconds. Choose your budget and storage preferences."},
              {n:"03",t:"Get Recommendations",d:"Open your personalized upgrade page on prorigbuilder.com with ranked options, pricing, and compatibility already validated."},
            ].map(s=><div key={s.n} style={{background:"var(--bg3)",borderRadius:14,padding:"28px 24px",border:"1px solid var(--bdr)"}}>
              <div style={{fontFamily:"var(--mono)",fontSize:36,fontWeight:800,color:"var(--accent)",opacity:.4,lineHeight:1,marginBottom:14}}>{s.n}</div>
              <div style={{fontFamily:"var(--ff)",fontSize:17,fontWeight:700,color:"var(--txt)",marginBottom:10}}>{s.t}</div>
              <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",lineHeight:1.65}}>{s.d}</div>
            </div>)}
          </div>
        </div>
      </div>

      {/* ── WHY IT'S DIFFERENT ── */}
      <div style={{maxWidth:1000,margin:"0 auto",padding:"64px 32px"}}>
        <div style={{textAlign:"center",marginBottom:48}}>
          <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",fontWeight:600,letterSpacing:2,marginBottom:8}}>WHY SCANNER</div>
          <h2 style={{fontFamily:"var(--ff)",fontSize:32,fontWeight:800,color:"var(--txt)",letterSpacing:-0.5}}>No other site does this.</h2>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:24}} className="how-grid">
          {[
            {i:"🔍",t:"No guessing required",d:"You don't need to know your CPU or GPU model. The scanner reads it directly from your PC. Accurate every time."},
            {i:"🎯",t:"Budget-aware recommendations",d:"Tell us your budget — we'll recommend the biggest performance upgrade for the money, including motherboard/RAM if your platform is outdated."},
            {i:"🔒",t:"100% private by design",d:"Scans run entirely on your PC. We never see, store, or transmit your hardware details anywhere. Your data never leaves your machine. Period."},
            {i:"💎",t:"Built exclusively here",d:"You won't find this feature on PCPartPicker, Newegg, or any other builder site. Pro Rig Builder is the only one offering it."},
          ].map(f=><div key={f.t} style={{background:"var(--card)",borderRadius:14,padding:"24px 22px",border:"1px solid var(--bdr)",display:"flex",gap:16,alignItems:"flex-start"}}>
            <div style={{fontSize:32,lineHeight:1}}>{f.i}</div>
            <div>
              <div style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:700,color:"var(--txt)",marginBottom:6}}>{f.t}</div>
              <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",lineHeight:1.6}}>{f.d}</div>
            </div>
          </div>)}
        </div>
      </div>

      {/* ── SMARTSCREEN REASSURANCE ── */}
      <div style={{background:"var(--bg2)",borderTop:"1px solid var(--bdr)"}}>
        <div style={{maxWidth:720,margin:"0 auto",padding:"48px 32px"}}>
          <div style={{background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:14,padding:"24px 26px"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
              <span style={{fontSize:20}}>🛡️</span>
              <div style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:700,color:"var(--txt)"}}>Seeing a Windows warning?</div>
            </div>
            <p style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",lineHeight:1.7,marginBottom:12}}>
              Windows SmartScreen may show a warning because Pro Rig Scanner is newly released. The app is <strong style={{color:"var(--txt)"}}>digitally signed by TieredUp Tech, Inc.</strong> (our parent company) and safe to run.
            </p>
            <p style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",lineHeight:1.7,marginBottom:0}}>
              <strong style={{color:"var(--txt)"}}>To run it:</strong> Click <span style={{fontFamily:"var(--mono)",fontSize:12,background:"var(--bg4)",padding:"2px 8px",borderRadius:4,color:"var(--accent)"}}>More info</span> on the blue warning, then click <span style={{fontFamily:"var(--mono)",fontSize:12,background:"var(--bg4)",padding:"2px 8px",borderRadius:4,color:"var(--accent)"}}>Run anyway</span>. The warning will disappear automatically as more users download without issue.
            </p>
          </div>
        </div>
      </div>

      {/* ── DOWNLOAD CTA ── */}
      <div style={{background:"var(--bg2)",borderTop:"1px solid var(--bdr)"}}>
        <div style={{maxWidth:720,margin:"0 auto",padding:"64px 32px",textAlign:"center"}}>
          <h2 style={{fontFamily:"var(--ff)",fontSize:32,fontWeight:800,color:"var(--txt)",letterSpacing:-0.5,marginBottom:14}}>Ready to find your next upgrade?</h2>
          <p style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--dim)",marginBottom:28,lineHeight:1.65}}>
            Download the Pro Rig Scanner and get personalized recommendations in under a minute.
          </p>
          <a href="https://github.com/tiereduptech/pro-rig-builder/releases/latest/download/ProRigScanner.exe" download style={{textDecoration:"none",padding:"16px 40px",borderRadius:14,fontSize:16,fontFamily:"var(--ff)",fontWeight:700,background:"var(--accent)",color:"#fff",border:"none",boxShadow:"0 6px 28px rgba(255,107,53,.35)",display:"inline-flex",alignItems:"center",gap:10,transition:"transform .15s"}}
            onMouseEnter={e=>e.currentTarget.style.transform="translateY(-2px)"}
            onMouseLeave={e=>e.currentTarget.style.transform="none"}>
            📥 Download Pro Rig Scanner
          </a>
          <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mute)",marginTop:16,letterSpacing:1}}>
            Free · Windows 10/11 · 100% Private · No account · No tracking · No data collection
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
        <div style={{maxWidth:860,margin:"0 auto",padding:"56px 32px 40px"}}>
          <h1 style={{fontFamily:"var(--ff)",fontSize:40,fontWeight:800,color:"var(--txt)",letterSpacing:-1,lineHeight:1.1,marginBottom:subtitle?12:0}}>{title}</h1>
          {subtitle && <p style={{fontFamily:"var(--ff)",fontSize:16,color:"var(--dim)",lineHeight:1.6,maxWidth:640}}>{subtitle}</p>}
        </div>
      </div>
      <div style={{maxWidth:860,margin:"0 auto",padding:"48px 32px 64px"}}>
        {children}
      </div>
    </div>
  );
}

function SectionHeading({children}) {
  return <h2 style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:700,color:"var(--txt)",letterSpacing:-0.3,marginTop:36,marginBottom:14}}>{children}</h2>;
}
function SubHeading({children}) {
  return <h3 style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:700,color:"var(--txt)",marginTop:22,marginBottom:8}}>{children}</h3>;
}
function Para({children}) {
  return <p style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.75,marginBottom:14}}>{children}</p>;
}
function Bullet({children}) {
  return <li style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.75,marginBottom:8}}>{children}</li>;
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
        <div style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:700,color:"var(--txt)",marginBottom:10}}>Ready to build?</div>
        <Para>Try the PC builder, or download our scanner to get upgrade recommendations for your current rig.</Para>
        <div style={{display:"flex",gap:12,marginTop:14,flexWrap:"wrap"}}>
          <button onClick={()=>go("builder")} style={{padding:"11px 22px",borderRadius:10,fontSize:13,fontFamily:"var(--ff)",fontWeight:700,cursor:"pointer",background:"var(--accent)",color:"#fff",border:"none"}}>Start Building →</button>
          <button onClick={()=>go("scanner")} style={{padding:"11px 22px",borderRadius:10,fontSize:13,fontFamily:"var(--ff)",fontWeight:600,cursor:"pointer",background:"var(--bg3)",color:"var(--txt)",border:"1px solid var(--bdr)"}}>Try the Scanner</button>
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
          <p style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",lineHeight:1.6,marginTop:12,marginBottom:0}}>
            Use this email for all support questions, feature requests, data corrections, partnership inquiries, and anything else.
          </p>
        </div>
        <div style={{background:"var(--card)",borderRadius:12,padding:"24px 26px",border:"1px solid var(--bdr)"}}>
          <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",fontWeight:700,letterSpacing:1.5,marginBottom:10}}>MAILING ADDRESS</div>
          <div style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:700,color:"var(--txt)",marginBottom:8}}>TieredUp Tech, Inc.</div>
          <div style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.6}}>
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
        Pro Rig Builder participates in affiliate programs with Amazon Associates, Best Buy, Newegg, B&H Photo, Antonline, and others. When you click an affiliate link and make a purchase, we may receive a commission at no additional cost to you. See our <a href="#affiliate" style={{color:"var(--accent)"}}>Affiliate Disclosure</a> for more details.
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
        <div style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--dim)",lineHeight:1.6}}>
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
          <div style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:700,color:"var(--txt)"}}>FTC-Compliant Summary</div>
        </div>
        <div style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.65}}>
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
        <Bullet><strong>Amazon Associates</strong> — "As an Amazon Associate, we earn from qualifying purchases." Associate tag: <code style={{background:"var(--bg3)",padding:"2px 6px",borderRadius:4,fontFamily:"var(--mono)",fontSize:12}}>tiereduptech-20</code></Bullet>
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
    if (val === true) return <span style={{fontSize:18,color:isPb?"var(--accent)":"var(--mint)",fontWeight:700}}>✓</span>;
    if (val === false) return <span style={{fontSize:18,color:"var(--mute)",fontWeight:700}}>✗</span>;
    return <span style={{fontFamily:"var(--ff)",fontSize:11,color:isPb?"var(--accent)":"var(--txt)",fontWeight:isPb?700:500,lineHeight:1.3}}>{val}</span>;
  };

  return (
    <div className="fade">
      <SEO title="Why Pro Rig Builder vs PCPartPicker, Newegg & Logical Increments" description="Factual comparison of Pro Rig Builder vs PCPartPicker, Newegg PC Builder, and Logical Increments. Features, pricing, tools, and business model breakdown." canonical="https://prorigbuilder.com/#compare" breadcrumb={[{name:"Home",url:"https://prorigbuilder.com/"},{name:"Compare",url:"https://prorigbuilder.com/#compare"}]} faq={[{"q":"How does Pro Rig Builder compare to PCPartPicker?","a":"Pro Rig Builder matches PCPartPicker's core features and adds 8 exclusive features: hardware scanner, FPS estimator, bottleneck calculator, Will-It-Run checker, USED flags, budget-aware upgrade recommendations, budget build wizard, and light/dark mode. Pro Rig Builder also runs zero ads."},{"q":"How does Pro Rig Builder compare to Newegg PC Builder?","a":"Newegg PC Builder shows only Newegg inventory. Pro Rig Builder compares prices across five retailers (Amazon, Best Buy, Newegg, B&H, Antonline) and ranks parts neutrally with no retailer bias."},{"q":"How does Pro Rig Builder compare to Logical Increments?","a":"Logical Increments is a static tier-based build guide. Pro Rig Builder is an interactive platform with live pricing, compatibility validation, and modern tools that Logical Increments does not offer."},{"q":"Is Pro Rig Builder biased toward certain retailers?","a":"No. Pro Rig Builder ranks products by benchmark performance, price, and compatibility - never by affiliate commission rates."}]}/>
      {/* HERO */}
      <div style={{background:"var(--heroGrad)",borderBottom:"1px solid var(--bdr)",position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",top:"-10%",right:"-5%",width:500,height:500,borderRadius:"50%",background:"radial-gradient(circle, rgba(255,107,53,0.08) 0%, transparent 60%)",pointerEvents:"none"}}/>
        <div style={{maxWidth:1100,margin:"0 auto",padding:"72px 32px 48px",position:"relative"}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"var(--accent3)",border:"1px solid var(--accent)",color:"var(--accent)",padding:"5px 14px",borderRadius:14,fontFamily:"var(--mono)",fontSize:11,fontWeight:700,letterSpacing:1.5,marginBottom:24}}>
            WHY PRO RIG BUILDER
          </div>
          <h1 style={{fontFamily:"var(--ff)",fontSize:44,fontWeight:800,color:"var(--txt)",letterSpacing:-1.2,lineHeight:1.08,maxWidth:780}}>
            How we compare to the <span style={{background:"linear-gradient(135deg, var(--accent), var(--amber))",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>other PC builder tools</span>
          </h1>
          <p style={{fontFamily:"var(--ff)",fontSize:16,color:"var(--dim)",marginTop:18,lineHeight:1.7,maxWidth:680}}>
            An honest, factual comparison with PCPartPicker, Newegg PC Builder, and Logical Increments — the three biggest PC builder platforms. We focus on facts, not hype. You decide.
          </p>
        </div>
      </div>

      {/* BIG COMPARISON TABLE */}
      <div style={{maxWidth:1100,margin:"0 auto",padding:"48px 32px 24px"}}>
        <h2 style={{fontFamily:"var(--ff)",fontSize:28,fontWeight:800,color:"var(--txt)",letterSpacing:-0.5,marginBottom:18}}>Feature-by-feature comparison</h2>
        <p style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--dim)",marginBottom:24,lineHeight:1.6}}>
          Green check = feature is available. Red X = feature is not available. Text = brief note on implementation. Last verified: April 2026.
        </p>

        <div style={{overflowX:"auto",border:"1px solid var(--bdr)",borderRadius:12,background:"var(--bg2)"}}>
          <table style={{width:"100%",borderCollapse:"collapse",minWidth:720}}>
            <thead>
              <tr style={{background:"var(--bg3)",borderBottom:"2px solid var(--bdr)"}}>
                <th style={{textAlign:"left",padding:"14px 16px",fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",fontWeight:700,letterSpacing:1.5,minWidth:180}}>FEATURE</th>
                {competitors.map(c => (
                  <th key={c.key} style={{textAlign:"center",padding:"14px 12px",minWidth:130}}>
                    <div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:700,color:c.color,marginBottom:c.badge?4:0}}>{c.name}</div>
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
                      <td style={{padding:"12px 16px",fontFamily:"var(--ff)",fontSize:12,fontWeight:600,color:"var(--txt)"}}>{row.f}</td>
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
        <div style={{maxWidth:1100,margin:"0 auto",padding:"56px 32px"}}>
          <div style={{textAlign:"center",marginBottom:40}}>
            <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",fontWeight:700,letterSpacing:2,marginBottom:8}}>DEEP DIVE</div>
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
                <div style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:700,color:"var(--txt)",marginBottom:10,lineHeight:1.25}}>{f.t}</div>
                <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",lineHeight:1.7}}>{f.d}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* HEAD-TO-HEAD SECTIONS */}
      <div style={{maxWidth:1000,margin:"0 auto",padding:"56px 32px"}}>
        <div style={{textAlign:"center",marginBottom:40}}>
          <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",fontWeight:700,letterSpacing:2,marginBottom:8}}>HEAD TO HEAD</div>
          <h2 style={{fontFamily:"var(--ff)",fontSize:32,fontWeight:800,color:"var(--txt)",letterSpacing:-0.5}}>Direct comparisons</h2>
        </div>

        {/* vs PCPartPicker */}
        <div style={{background:"var(--bg2)",borderRadius:14,padding:"32px 34px",border:"1px solid var(--bdr)",marginBottom:24}}>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
            <div style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--txt)"}}>Pro Rig Builder vs. PCPartPicker</div>
          </div>
          <p style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--dim)",lineHeight:1.75,marginBottom:18}}>
            PCPartPicker is the best-known PC builder platform. It's solid: a large community build library, solid compatibility engine, real-time pricing across retailers. But it's also 15+ years old and shows it. Pro Rig Builder does everything PCPartPicker does — plus eight tools PCPartPicker doesn't have.
          </p>
          <div style={{background:"var(--bg3)",padding:"18px 22px",borderRadius:10}}>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",fontWeight:700,letterSpacing:1.5,marginBottom:10}}>WHAT WE HAVE THAT PCPARTPICKER DOESN'T</div>
            <ul style={{paddingLeft:20,margin:0}}>
              <li style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)",lineHeight:1.8,marginBottom:4}}>Free Windows hardware scanner app</li>
              <li style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)",lineHeight:1.8,marginBottom:4}}>FPS estimator and Will-It-Run checker for specific games</li>
              <li style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)",lineHeight:1.8,marginBottom:4}}>Bottleneck calculator with percentage severity</li>
              <li style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)",lineHeight:1.8,marginBottom:4}}>USED product flags</li>
              <li style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)",lineHeight:1.8,marginBottom:4}}>Budget-aware automated upgrade recommendations</li>
              <li style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)",lineHeight:1.8,marginBottom:4}}>Automated budget build wizard</li>
              <li style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)",lineHeight:1.8,marginBottom:4}}>Light + dark mode</li>
              <li style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)",lineHeight:1.8,marginBottom:0}}>Zero ads (PCPartPicker is ad-supported)</li>
            </ul>
          </div>
        </div>

        {/* vs Newegg */}
        <div style={{background:"var(--bg2)",borderRadius:14,padding:"32px 34px",border:"1px solid var(--bdr)",marginBottom:24}}>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
            <div style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--txt)"}}>Pro Rig Builder vs. Newegg PC Builder</div>
          </div>
          <p style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--dim)",lineHeight:1.75,marginBottom:18}}>
            Newegg's PC Builder is a shopping tool first, a builder tool second. It only shows Newegg inventory. Its AI "Build with AI" feature uses ChatGPT to generate recommendations, but pricing, stock, and inventory are Newegg-only — no comparison with Amazon, Best Buy, or anywhere else. The tool exists to drive purchases on Newegg.com.
          </p>
          <div style={{background:"var(--bg3)",padding:"18px 22px",borderRadius:10}}>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",fontWeight:700,letterSpacing:1.5,marginBottom:10}}>THE KEY DIFFERENCE</div>
            <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)",lineHeight:1.7}}>
              Pro Rig Builder compares pricing across <strong>five retailers</strong>. We're neutral — we'll recommend the best deal regardless of which retailer offers it. Newegg PC Builder is a Newegg sales tool. If Amazon is $50 cheaper, Newegg won't tell you.
            </div>
          </div>
        </div>

        {/* vs Logical Increments */}
        <div style={{background:"var(--bg2)",borderRadius:14,padding:"32px 34px",border:"1px solid var(--bdr)"}}>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
            <div style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--txt)"}}>Pro Rig Builder vs. Logical Increments</div>
          </div>
          <p style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--dim)",lineHeight:1.75,marginBottom:18}}>
            Logical Increments is a static build guide — not an interactive builder. Its "Grid" recommends parts for budget tiers (Excellent, Outstanding, Exceptional, etc.), updated manually by the team. There's no compatibility engine, no real-time pricing, no personalized recommendations. Good for beginners who want a curated list; limited for anyone building a specific rig.
          </p>
          <div style={{background:"var(--bg3)",padding:"18px 22px",borderRadius:10}}>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",fontWeight:700,letterSpacing:1.5,marginBottom:10}}>THE KEY DIFFERENCE</div>
            <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)",lineHeight:1.7}}>
              Logical Increments tells you what parts to buy. Pro Rig Builder lets you build, compare, validate, and benchmark — with your specific hardware, budget, and games. One is a cookbook. The other is a kitchen.
            </div>
          </div>
        </div>
      </div>

      {/* BOTTOM CTA */}
      <div style={{background:"var(--bg2)",borderTop:"1px solid var(--bdr)"}}>
        <div style={{maxWidth:760,margin:"0 auto",padding:"56px 32px",textAlign:"center"}}>
          <h2 style={{fontFamily:"var(--ff)",fontSize:30,fontWeight:800,color:"var(--txt)",letterSpacing:-0.5,marginBottom:14}}>Try the difference yourself</h2>
          <p style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--dim)",lineHeight:1.65,marginBottom:26}}>
            Start a build, scan your existing rig, or browse parts with better filters than the competition. We're confident you'll see the difference within 30 seconds.
          </p>
          <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap"}}>
            <button onClick={()=>go("builder")} style={{padding:"14px 28px",borderRadius:12,fontSize:14,fontFamily:"var(--ff)",fontWeight:700,cursor:"pointer",background:"var(--accent)",color:"#fff",border:"none",boxShadow:"0 6px 20px rgba(255,107,53,.3)"}}>Start Building →</button>
            <button onClick={()=>go("scanner")} style={{padding:"14px 28px",borderRadius:12,fontSize:14,fontFamily:"var(--ff)",fontWeight:600,cursor:"pointer",background:"var(--bg3)",color:"var(--txt)",border:"1px solid var(--bdr)"}}>📥 Try the Scanner</button>
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
      <div style={{maxWidth:760,margin:"0 auto",padding:"52px 32px",textAlign:"center"}}>
        <h2 style={{fontFamily:"var(--ff)",fontSize:28,fontWeight:800,color:"var(--txt)",letterSpacing:-0.5,marginBottom:12}}>Ready to build smarter?</h2>
        <p style={{fontFamily:"var(--ff)",fontSize:15,color:"var(--dim)",lineHeight:1.7,marginBottom:24}}>
          Every tool free. Zero ads. Real multi-retailer pricing. Plus our exclusive hardware scanner.
        </p>
        <div style={{display:"flex",gap:12,justifyContent:"center",flexWrap:"wrap"}}>
          <button onClick={()=>go("builder")} style={{padding:"14px 28px",borderRadius:12,fontSize:14,fontFamily:"var(--ff)",fontWeight:700,cursor:"pointer",background:"var(--accent)",color:"#fff",border:"none",boxShadow:"0 6px 20px rgba(255,107,53,.3)"}}>Start Building →</button>
          <button onClick={()=>go("scanner")} style={{padding:"14px 28px",borderRadius:12,fontSize:14,fontFamily:"var(--ff)",fontWeight:600,cursor:"pointer",background:"var(--bg3)",color:"var(--txt)",border:"1px solid var(--bdr)"}}>📥 Try the Scanner</button>
          <button onClick={()=>go("compare")} style={{padding:"14px 28px",borderRadius:12,fontSize:14,fontFamily:"var(--ff)",fontWeight:600,cursor:"pointer",background:"transparent",color:"var(--txt)",border:"1px solid var(--bdr)"}}>Full Comparison</button>
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
        <div style={{maxWidth:900,margin:"0 auto",padding:"60px 32px 40px",position:"relative"}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"var(--accent3)",border:"1px solid var(--accent)",color:"var(--accent)",padding:"5px 14px",borderRadius:14,fontFamily:"var(--mono)",fontSize:11,fontWeight:700,letterSpacing:1.5,marginBottom:22}}>COMPARISON GUIDE</div>
          <h1 style={{fontFamily:"var(--ff)",fontSize:42,fontWeight:800,color:"var(--txt)",letterSpacing:-1.2,lineHeight:1.12,marginBottom:16}}>Pro Rig Builder vs PCPartPicker: A 2026 Feature Comparison</h1>
          <p style={{fontFamily:"var(--ff)",fontSize:16,color:"var(--dim)",lineHeight:1.65,maxWidth:720}}>
            PCPartPicker has been the go-to PC builder platform for over a decade. Pro Rig Builder is the modern alternative with features PCPartPicker doesn't offer. Here's how we compare, side-by-side, with no hype.
          </p>
        </div>
      </div>

      <div style={{maxWidth:900,margin:"0 auto",padding:"48px 32px"}}>
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
              <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",lineHeight:1.65}}>{f.d}</div>
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
          <div style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--dim)",lineHeight:1.6}}>
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
        <div style={{maxWidth:900,margin:"0 auto",padding:"60px 32px 40px",position:"relative"}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"var(--accent3)",border:"1px solid var(--accent)",color:"var(--accent)",padding:"5px 14px",borderRadius:14,fontFamily:"var(--mono)",fontSize:11,fontWeight:700,letterSpacing:1.5,marginBottom:22}}>ALTERNATIVE GUIDE</div>
          <h1 style={{fontFamily:"var(--ff)",fontSize:42,fontWeight:800,color:"var(--txt)",letterSpacing:-1.2,lineHeight:1.12,marginBottom:16}}>The Best PCPartPicker Alternative in 2026</h1>
          <p style={{fontFamily:"var(--ff)",fontSize:16,color:"var(--dim)",lineHeight:1.65,maxWidth:720}}>
            Looking for a PC builder platform with more tools, zero ads, and modern features? Pro Rig Builder is the alternative built for 2026 — with eight features you won't find on PCPartPicker.
          </p>
        </div>
      </div>

      <div style={{maxWidth:900,margin:"0 auto",padding:"48px 32px"}}>
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
            <li style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.75,marginBottom:10}}><strong>Pro Rig Scanner</strong> — free Windows app that detects your hardware automatically. Runs 100% locally with zero data collection.</li>
            <li style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.75,marginBottom:10}}><strong>FPS Estimator</strong> — see projected FPS for popular games on your proposed build.</li>
            <li style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.75,marginBottom:10}}><strong>Bottleneck Calculator</strong> — percentage severity of CPU/GPU bottleneck for informed upgrade decisions.</li>
            <li style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.75,marginBottom:10}}><strong>Will It Run</strong> — check if your current PC handles a specific game before you try it.</li>
            <li style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.75,marginBottom:10}}><strong>Budget Build Wizard</strong> — automated build generation based on your budget.</li>
            <li style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.75,marginBottom:10}}><strong>USED Product Flags</strong> — pre-owned listings clearly marked for transparent shopping.</li>
            <li style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.75,marginBottom:10}}><strong>Budget-Aware Upgrade Recs</strong> — tell us your budget, we show the biggest performance uplift.</li>
            <li style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",lineHeight:1.75,marginBottom:0}}><strong>Light + Dark Mode</strong> — modern UI with theme switching.</li>
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
        <div style={{maxWidth:900,margin:"0 auto",padding:"60px 32px 40px",position:"relative"}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"var(--accent3)",border:"1px solid var(--accent)",color:"var(--accent)",padding:"5px 14px",borderRadius:14,fontFamily:"var(--mono)",fontSize:11,fontWeight:700,letterSpacing:1.5,marginBottom:22}}>2026 LISTICLE</div>
          <h1 style={{fontFamily:"var(--ff)",fontSize:42,fontWeight:800,color:"var(--txt)",letterSpacing:-1.2,lineHeight:1.12,marginBottom:16}}>Best PC Builder Tools in 2026: Ranked & Reviewed</h1>
          <p style={{fontFamily:"var(--ff)",fontSize:16,color:"var(--dim)",lineHeight:1.65,maxWidth:720}}>
            We reviewed the four most popular PC builder tools of 2026. Here's how they stack up on features, pricing engines, UX, and business model transparency.
          </p>
        </div>
      </div>

      <div style={{maxWidth:900,margin:"0 auto",padding:"48px 32px"}}>
        <Para>
          Whether you're building your first PC or upgrading an existing rig, the right tool saves you hours of research and prevents costly compatibility mistakes. We evaluated each of these platforms on four criteria: <strong>feature depth</strong>, <strong>pricing accuracy</strong>, <strong>user experience</strong>, and <strong>business model transparency</strong>.
        </Para>

        <SectionHeading>1. Pro Rig Builder — The Most Feature-Complete</SectionHeading>
        <div style={{background:"var(--card)",border:"1px solid var(--accent)",borderRadius:12,padding:"22px 26px",marginBottom:20}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
            <div style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",fontWeight:700,letterSpacing:1.5}}>OUR PICK · BEST OVERALL</div>
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
                  <td style={{padding:"12px 14px",fontFamily:"var(--ff)",fontSize:13,fontWeight:i===0?700:500,color:i===0?"var(--accent)":"var(--txt)"}}>{row[0]}</td>
                  <td style={{padding:"12px 10px",textAlign:"center",fontFamily:"var(--ff)",fontSize:12,color:"var(--txt)"}}>{row[1]}</td>
                  <td style={{padding:"12px 10px",textAlign:"center",fontFamily:"var(--ff)",fontSize:12,color:"var(--txt)"}}>{row[2]}</td>
                  <td style={{padding:"12px 10px",textAlign:"center",fontFamily:"var(--ff)",fontSize:12,color:"var(--txt)"}}>{row[3]}</td>
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
  const deals=P.filter(p=>p.cp).sort((a,b)=>(b.off||0)-(a.off||0)).slice(0,6);
  const top=P.filter(p=>p.bench>=85).sort((a,b)=>(b.bench||0)-(a.bench||0)).slice(0,6);
  const totalParts=P.length;
  const totalDeals=P.filter(p=>p.cp).length;

  // Split categories into groups for visual variety
  const coreCats=["Case","CPU","CPUCooler","Motherboard","RAM","GPU","Storage","PSU"];
  const otherCats=CATS.filter(c=>!coreCats.includes(c));

  return <div className="fade">
    <SEO description="Compare PC parts across Amazon, Best Buy, Newegg & more. Free hardware scanner, compatibility engine, FPS estimator, and budget-aware upgrade recommendations." canonical="https://prorigbuilder.com/"/>
    {/* ── HERO — full-width split layout ── */}
    <div style={{background:"var(--heroGrad)",position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",top:"20%",right:"-5%",width:600,height:600,borderRadius:"50%",background:"radial-gradient(circle, rgba(255,107,53,0.06) 0%, transparent 60%)",pointerEvents:"none"}}/>
      <div style={{position:"absolute",bottom:"-30%",left:"10%",width:400,height:400,borderRadius:"50%",background:"radial-gradient(circle, rgba(245,166,35,0.04) 0%, transparent 60%)",pointerEvents:"none"}}/>
      <div style={{maxWidth:1200,margin:"0 auto",padding:"80px 32px 72px"}}>
        <div style={{maxWidth:640}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:8,background:"var(--accent3)",borderRadius:20,padding:"6px 16px",marginBottom:24}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:"var(--accent)",animation:"pulse 2s infinite"}}/>
            <span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--accent)",fontWeight:500}}>{totalParts} parts tracked · {totalDeals} deals live</span>
          </div>
          <h1 style={{fontFamily:"var(--ff)",fontSize:52,fontWeight:800,color:"var(--txt)",lineHeight:1.05,letterSpacing:-1.5}}>
            Find the best price<br/>on every <span style={{background:"linear-gradient(135deg, var(--accent), var(--amber))",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>PC part.</span>
          </h1>
          <p style={{fontFamily:"var(--ff)",fontSize:17,color:"var(--dim)",marginTop:20,lineHeight:1.7,maxWidth:480}}>
            Compare prices across Amazon, Newegg, B&H and more. Check compatibility instantly. Build smarter.
          </p>
          <div style={{display:"flex",gap:12,marginTop:36}}>
            <button onClick={()=>go("builder")} style={{padding:"14px 32px",borderRadius:14,fontSize:15,fontFamily:"var(--ff)",fontWeight:700,cursor:"pointer",background:"var(--accent)",color:"#fff",border:"none",boxShadow:"0 6px 24px rgba(255,107,53,.3)",transition:"transform .15s"}}
              onMouseEnter={e=>e.currentTarget.style.transform="translateY(-1px)"}
              onMouseLeave={e=>e.currentTarget.style.transform="none"}>Start Building →</button>
            <button onClick={()=>go("search")} style={{padding:"14px 32px",borderRadius:14,fontSize:15,fontFamily:"var(--ff)",fontWeight:600,cursor:"pointer",background:"var(--bg3)",color:"var(--txt)",border:"1px solid var(--bdr)",transition:"all .15s"}}
              onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--accent)";e.currentTarget.style.transform="translateY(-1px)";}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--bdr)";e.currentTarget.style.transform="none";}}>Browse Parts</button>
          </div>
        </div>
      </div>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}@keyframes scanLine{0%,100%{transform:translateX(-100%)}50%{transform:translateX(100%)}}`}</style>
    </div>

    {/* ── SCANNER BANNER — promote proprietary scanner app ── */}
    <div style={{background:"var(--bg2)",borderBottom:"1px solid var(--bdr)",position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:"linear-gradient(90deg,transparent 0%,var(--accent) 50%,transparent 100%)",animation:"scanLine 3s ease-in-out infinite"}}/>
      <div className="hero-grid" style={{maxWidth:1200,margin:"0 auto",padding:"48px 32px",display:"grid",gridTemplateColumns:"auto 1fr auto",gap:32,alignItems:"center"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <div style={{padding:18,background:"var(--accent3)",borderRadius:16,border:"1px solid var(--accent)"}}>
            <TowerLogo size={56}/>
          </div>
        </div>
        <div>
          <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"var(--amber)",color:"#1a1a20",padding:"4px 12px",borderRadius:12,fontFamily:"var(--mono)",fontSize:10,fontWeight:800,letterSpacing:1.5,marginBottom:10}}>
            ✨ NEW · 100% PRIVATE · NOT AVAILABLE ANYWHERE ELSE
          </div>
          <h2 style={{fontFamily:"var(--ff)",fontSize:26,fontWeight:800,color:"var(--txt)",letterSpacing:-0.5,lineHeight:1.15,marginBottom:8}}>
            Introducing the <span style={{background:"linear-gradient(135deg, var(--accent), var(--amber))",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>Pro Rig Scanner</span>
          </h2>
          <p style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--dim)",lineHeight:1.6,marginBottom:16,maxWidth:600}}>
            Free Windows app that detects your hardware and recommends upgrades in your budget. Runs 100% locally on your PC — we don't store or collect any of your data. Download, scan, upgrade — three steps, thirty seconds.
          </p>
          <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
            {[
              {n:"1",t:"Download",d:"Free, under 2 MB"},
              {n:"2",t:"Scan",d:"10 seconds"},
              {n:"3",t:"Upgrade",d:"Get recommendations"},
            ].map(s=>(
              <div key={s.n} style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{width:26,height:26,borderRadius:"50%",background:"var(--accent3)",color:"var(--accent)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"var(--mono)",fontSize:12,fontWeight:800,flexShrink:0}}>{s.n}</div>
                <div>
                  <div style={{fontFamily:"var(--ff)",fontSize:12,fontWeight:700,color:"var(--txt)",lineHeight:1.1}}>{s.t}</div>
                  <div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)",lineHeight:1.2}}>{s.d}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={{flexShrink:0,display:"flex",flexDirection:"column",alignItems:"stretch",gap:6}}>
          <button onClick={()=>go("scanner")} style={{padding:"14px 24px",borderRadius:12,fontSize:14,fontFamily:"var(--ff)",fontWeight:700,cursor:"pointer",background:"var(--accent)",color:"#fff",border:"none",boxShadow:"0 6px 22px rgba(255,107,53,.3)",transition:"transform .15s",whiteSpace:"nowrap"}}
            onMouseEnter={e=>e.currentTarget.style.transform="translateY(-1px)"}
            onMouseLeave={e=>e.currentTarget.style.transform="none"}>
            Learn More →
          </button>
          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--mute)",textAlign:"center",letterSpacing:1}}>WIN 10/11 · PRIVATE</div>
        </div>
      </div>
    </div>

    {/* ── HOW IT WORKS — horizontal strip ── */}
    <div style={{background:"var(--bg2)",borderBottom:"1px solid var(--bdr)"}}>
      <div style={{maxWidth:1200,margin:"0 auto",padding:"48px 32px",display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:32}}>
        {[
          {num:"01",t:"Browse & Compare",d:"Search across retailers. See real-time prices from Amazon, Newegg, B&H, and Best Buy."},
          {num:"02",t:"Check Compatibility",d:"18+ automatic checks — socket matching, GPU clearance, PSU wattage, RAM type, and more."},
          {num:"03",t:"Build & Save",d:"Find the best price, apply coupon codes, and buy through affiliate links at no extra cost."},
        ].map(s=><div key={s.num} style={{display:"flex",gap:16,alignItems:"flex-start"}}>
          <div style={{fontFamily:"var(--mono)",fontSize:28,fontWeight:800,color:"var(--accent)",opacity:.3,lineHeight:1,flexShrink:0}}>{s.num}</div>
          <div>
            <div style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:700,color:"var(--txt)",marginBottom:6}}>{s.t}</div>
            <div style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",lineHeight:1.65}}>{s.d}</div>
          </div>
        </div>)}
      </div>
    </div>


    {/* 2-COLUMN LAYOUT: categories (left) + deals/top sidebar (right) */}
    <div className="home-main-grid" style={{maxWidth:1200,margin:"0 auto",gap:32,alignItems:"start"}}>
      {/* LEFT COLUMN — Core Components + More Categories */}
      <div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:24}}>
          <div>
            <h2 style={{fontFamily:"var(--ff)",fontSize:28,fontWeight:800,color:"var(--txt)"}}>Core Components</h2>
            <p style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",marginTop:4}}>The essential parts for your build</p>
          </div>
          <button onClick={()=>go("search")} style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--accent)",background:"none",border:"none",cursor:"pointer",fontWeight:600}}>View All →</button>
        </div>
        <div className="home-cat-grid" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
          {coreCats.map(c=>{const m=CAT[c];const cnt=P.filter(p=>p.c===c).length;
            return <button key={c} onClick={()=>{browse(c);go("search");}} style={{background:"var(--bg2)",borderRadius:20,border:"1px solid var(--bdr)",padding:0,cursor:"pointer",overflow:"hidden",textAlign:"left",transition:"all .3s cubic-bezier(.16,1,.3,1)",boxShadow:"var(--shadowSm,none)"}}
              onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-4px)";e.currentTarget.style.boxShadow="0 8px 32px rgba(0,0,0,.12)";}}
              onMouseLeave={e=>{e.currentTarget.style.transform="none";e.currentTarget.style.boxShadow="var(--shadowSm,none)";}}>
              <div style={{height:100,background:"var(--bg3)",display:"flex",alignItems:"center",justifyContent:"center",borderBottom:"1px solid var(--bdr)"}}>
                <CatThumb cat={c} thumbs={th.thumbs} setThumb={th.setThumb} removeThumb={th.removeThumb} size={64} rounded={14} editable={false}/>
              </div>
              <div style={{padding:"14px 16px"}}>
                <div style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:"var(--txt)"}}>{m.label}</div>
                <div style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--dim)",marginTop:2}}>{m.desc}</div>
                <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--accent)",marginTop:6,fontWeight:500}}>{cnt} products →</div>
              </div>
            </button>})}
        </div>

        {/* More Categories — inline below Core Components */}
        {otherCats.length>0&&<div style={{marginTop:36}}>
          <h3 style={{fontFamily:"var(--ff)",fontSize:18,fontWeight:700,color:"var(--txt)",marginBottom:16}}>More Categories</h3>
          <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
            {otherCats.map(c=>{const m=CAT[c];const cnt=P.filter(p=>p.c===c).length;
              return <button key={c} onClick={()=>{browse(c);go("search");}} style={{display:"flex",alignItems:"center",gap:8,background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:"8px 16px 8px 10px",cursor:"pointer",transition:"all .2s"}}
                onMouseEnter={e=>{e.currentTarget.style.borderColor="var(--accent)44";e.currentTarget.style.background="var(--bg3)";}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor="var(--bdr)";e.currentTarget.style.background="var(--bg2)";}}>
                <span style={{fontSize:16}}>{m.icon}</span>
                <span style={{fontFamily:"var(--ff)",fontSize:12,fontWeight:600,color:"var(--txt)"}}>{m.label}</span>
                <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--mute)"}}>{cnt}</span>
              </button>})}
          </div>
        </div>}
      </div>

      {/* RIGHT SIDEBAR — Best Deals + Top Performers */}
      <div style={{display:"flex",flexDirection:"column",gap:16,position:"sticky",top:80}}>
        {/* Best Deals */}
        <div style={{background:"var(--bg2)",borderRadius:20,border:"1px solid var(--bdr)",padding:18,boxShadow:"var(--shadowSm,none)"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
            <h2 style={{fontFamily:"var(--ff)",fontSize:17,fontWeight:700,color:"var(--txt)"}}>Best Deals</h2>
            <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--accent)",fontWeight:600,background:"var(--accent3)",padding:"3px 8px",borderRadius:6}}>{totalDeals} active</span>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {deals.slice(0,5).map(p=>{const rr=retailers(p);const url=rr[0]?.url;return <button key={p.id} onClick={()=>{if(url)window.open(url,"_blank","noopener,noreferrer");else{browse(p.c);go("search");}}} style={{display:"flex",alignItems:"center",gap:10,width:"100%",background:"var(--bg3)",borderRadius:10,padding:"10px 12px",cursor:"pointer",textAlign:"left",border:"1px solid transparent",transition:"all .2s"}}
              onMouseEnter={e=>e.currentTarget.style.borderColor="var(--amber)33"}
              onMouseLeave={e=>e.currentTarget.style.borderColor="transparent"}>
              <div style={{width:36,height:36,borderRadius:8,background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0,overflow:"hidden"}}>{p.img?<img loading="lazy" decoding="async" src={p.img} alt="" style={{width:"100%",height:"100%",objectFit:"contain"}}/>:ic(p)}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontFamily:"var(--ff)",fontSize:11,fontWeight:600,color:"var(--txt)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.n}</div>
                <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--amber)",fontWeight:600,marginTop:1}}>Save ${p.off}</div>
              </div>
              <div style={{textAlign:"right",flexShrink:0}}>
                <div style={{fontFamily:"var(--mono)",fontSize:13,fontWeight:700,color:"var(--accent)"}}>${fmtPrice($(p))}</div>
                <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--mute)",textDecoration:"line-through"}}>${fmtPrice(p.msrp||p.pr)}</div>
              </div>
            </button>;})}
          </div>
        </div>

        {/* Top Performers */}
        <div style={{background:"var(--bg2)",borderRadius:20,border:"1px solid var(--bdr)",padding:18,boxShadow:"var(--shadowSm,none)"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
            <h2 style={{fontFamily:"var(--ff)",fontSize:17,fontWeight:700,color:"var(--txt)"}}>Top Performers</h2>
            <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--sky)",fontWeight:600}}>by benchmark</span>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {top.slice(0,5).map(p=>{const rr=retailers(p);const url=rr[0]?.url;return <button key={p.id} onClick={()=>{if(url)window.open(url,"_blank","noopener,noreferrer");else{browse(p.c);go("search");}}} style={{display:"flex",alignItems:"center",gap:10,width:"100%",background:"var(--bg3)",borderRadius:10,padding:"10px 12px",cursor:"pointer",textAlign:"left",border:"1px solid transparent",transition:"all .2s"}}
              onMouseEnter={e=>e.currentTarget.style.borderColor="var(--sky)33"}
              onMouseLeave={e=>e.currentTarget.style.borderColor="transparent"}>
              <div style={{width:36,height:36,borderRadius:8,background:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0,overflow:"hidden"}}>{p.img?<img loading="lazy" decoding="async" src={p.img} alt="" style={{width:"100%",height:"100%",objectFit:"contain"}}/>:ic(p)}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontFamily:"var(--ff)",fontSize:11,fontWeight:600,color:"var(--txt)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{p.n}</div>
                <Stars r={p.r} s={9}/>
              </div>
              <div style={{fontFamily:"var(--mono)",fontSize:13,fontWeight:700,color:"var(--accent)",minWidth:40,textAlign:"right",flexShrink:0}}>${fmtPrice($(p))}</div>
            </button>;})}
          </div>
        </div>
      </div>
    </div>

  </div>;
}

/* ═══ SEARCH PAGE ═══ */

// === MOBILE SEARCH PAGE ===
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

  // Category picker
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

  // Product list
  return <div className="fade" style={{padding:"12px 12px 80px",maxWidth:"100vw",overflow:"hidden"}}>
    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10,flexWrap:"wrap"}}>
      <button onClick={()=>setCat("")} style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--dim)",background:"none",border:"none",cursor:"pointer",padding:0}}>← All</button>
      <span style={{color:"var(--mute)"}}>/</span>
      <span style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--accent)",fontWeight:700}}>{CAT[cat].label}</span>
      <span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",marginLeft:"auto"}}>{list.length}</span>
    </div>

    <div style={{position:"relative",marginBottom:10}}>
      <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:14,color:"var(--mute)"}}>🔍</span>
      <input value={q} onChange={e=>setQ(e.target.value)} placeholder={"Search "+CAT[cat].label.toLowerCase()} style={{width:"100%",background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:8,padding:"10px 10px 10px 34px",fontSize:14,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none",boxSizing:"border-box"}}/>
      {q&&<button onClick={()=>setQ("")} style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"var(--dim)",fontSize:14,cursor:"pointer"}}>✕</button>}
    </div>

    <div style={{display:"flex",gap:8,marginBottom:14}}>
      <button onClick={()=>setFiltersOpen(true)} style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,background:ac>0?"var(--accent3)":"var(--bg3)",border:"1px solid "+(ac>0?"var(--accent)":"var(--bdr)"),borderRadius:8,padding:"10px",fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:ac>0?"var(--accent)":"var(--txt)",cursor:"pointer"}}>
        ⚙ Filters{ac>0?" ("+ac+")":""}
      </button>
      <select value={sort} onChange={e=>setSort(e.target.value)} style={{flex:1,background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:8,padding:"10px",fontSize:13,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none",cursor:"pointer"}}>
        <option value="price-asc">Price ↑</option>
        <option value="price-desc">Price ↓</option>
        <option value="rating-desc">Top Rated</option>
        <option value="bench-desc">Performance</option>
        <option value="value-desc">Best Value</option>
      </select>
    </div>

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
                <span style={{fontFamily:"var(--ff)",fontSize:18,fontWeight:800,color:"var(--mint)"}}>${fmtPrice($(p))}</span>
                {p.msrp&&p.msrp>$(p)&&<span style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--mute)",textDecoration:"line-through"}}>${fmtPrice(p.msrp)}</span>}
              </div>
            </div>
            <div style={{display:"flex",alignItems:"center",color:"var(--dim)",fontSize:18,transition:"transform .2s",transform:isExp?"rotate(90deg)":"none"}}>›</div>
          </div>

          {isExp&&<div style={{padding:"0 12px 14px",borderTop:"1px solid var(--bdr)"}}>
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
                    <span style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:800,color:ri===0?"var(--mint)":"var(--txt)"}}>${fmtPrice(r.price)}</span>
                    <div style={{background:ri===0?"var(--mint)":"var(--bg4)",borderRadius:6,padding:"6px 12px",fontFamily:"var(--ff)",fontSize:11,fontWeight:700,color:ri===0?"var(--bg)":"var(--txt)"}}>Buy</div>
                  </div>
                </a>
              ):<a href={p.deals?.amazon?.url||"#"} target="_blank" rel="noopener noreferrer" style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 12px",borderRadius:8,background:"var(--mint3)",border:"1px solid var(--mint)33",textDecoration:"none"}}>
                <div>
                  <span style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:700,color:"var(--txt)"}}>Amazon</span>
                  <div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--sky)"}}>✓ In Stock</div>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:800,color:"var(--mint)"}}>${fmtPrice($(p))}</span>
                  <div style={{background:"var(--mint)",borderRadius:6,padding:"6px 12px",fontFamily:"var(--ff)",fontSize:11,fontWeight:700,color:"var(--bg)"}}>Buy</div>
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
          <span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mute)"}}>${minPr}</span>
          <span style={{fontFamily:"var(--mono)",fontSize:11,color:"var(--mint)",fontWeight:600}}>to ${maxPr>=5000?"∞":"$"+maxPr}</span>
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
function SearchPage({activeCat,th}){
  const [cat,setCat]=useState(activeCat||"");const [q,setQ]=useState("");const [brands,setBrands]=useState([]);const [marketplaces,setMarketplaces]=useState([]);const [maxPr,setMaxPr]=useState(5000);const [minPr,setMinPr]=useState(0);const [minR,setMinR]=useState(0);const [cpO,setCpO]=useState(false);const [sf,setSf]=useState({});const [sort,setSort]=useState("price-asc");
  const [expanded,setExpanded]=useState(null);
  const [showAll,setShowAll]=useState({});
  useEffect(()=>{if(activeCat)setCat(activeCat);},[activeCat]);
  const sel=c=>{setCat(c);setBrands([]);setMarketplaces([]);setSf({});setQ("");setMaxPr(5000);setMinPr(0);setMinR(0);setCpO(false);};
  const catP=cat?P.filter(p=>p.c===cat):P;const allBr=[...new Set(catP.map(p=>p.b))].sort();const allMarkets=[...new Set(catP.flatMap(p=>p.deals&&typeof p.deals==="object"?Object.keys(p.deals).filter(k=>p.deals[k]&&typeof p.deals[k]==="object"&&p.deals[k].price):[]))].sort();const cols=cat?(CAT[cat]?.cols||[]):[];const prMx=Math.max(...catP.map(p=>$(p)),100);
  const togSf=(col,val)=>setSf(pv=>{const c=pv[col]||[];return{...pv,[col]:c.includes(val)?c.filter(v=>v!==val):[...c,val]};});
  const list=useMemo(()=>{let r=catP;if(q)r=r.filter(p=>p.n.toLowerCase().includes(q.toLowerCase())||p.b.toLowerCase().includes(q.toLowerCase()));if(brands.length)r=r.filter(p=>brands.includes(p.b));if(marketplaces.length)r=r.filter(p=>p.deals&&typeof p.deals==="object"&&marketplaces.some(m=>p.deals[m]&&typeof p.deals[m]==="object"&&p.deals[m].price));r=r.filter(p=>$(p)<=maxPr&&$(p)>=minPr);if(minR)r=r.filter(p=>p.r>=minR);if(cpO)r=r.filter(p=>p.cp);Object.entries(sf).forEach(([key,vals])=>{if(key.endsWith("_max")){const field=key.replace("_max","");r=r.filter(p=>p[field]==null||p[field]<=vals);}else if(Array.isArray(vals)&&vals.length){r=r.filter(p=>{const pv=String(p[key]!=null?!!p[key]?p[key]:"false":"false");const cfg=cat&&CAT[cat]?.filters?.[key];const ev=cfg?.extract?cfg.extract(p):null;return vals.includes(pv)||vals.includes(String(p[key]))||(ev!=null&&vals.includes(ev));});}});const [sk,sd]=sort.split("-");r=[...r].sort((a,b)=>{const va=sk==="price"?$(a):sk==="rating"?a.r:sk==="value"?(a.value!=null?a.value:(a.bench||0)/Math.max($(a)/100,1)):(a.bench||0);const vb=sk==="price"?$(b):sk==="rating"?b.r:sk==="value"?(b.value!=null?b.value:(b.bench||0)/Math.max($(b)/100,1)):(b.bench||0);return sd==="asc"?va-vb:vb-va;});return r;},[cat,q,brands,marketplaces,maxPr,minPr,minR,cpO,sf,sort]);
  const ac=[brands.length,marketplaces.length,cpO,minR,maxPr<prMx,minPr>0,...Object.values(sf).map(v=>v.length)].filter(Boolean).length;

  if(!cat) return <CategoryBrowse sel={sel} th={th} CATS={CATS} CAT={CAT} P={P} CatThumb={CatThumb}/>;

  return <div className="fade" style={{maxWidth:1080,margin:"0 auto",padding:"16px 20px"}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}><button onClick={()=>setCat("")} style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--dim)",background:"none",border:"none",cursor:"pointer"}}>All Parts</button><span style={{color:"var(--mute)"}}>/</span><CatThumb cat={cat} thumbs={th.thumbs} setThumb={th.setThumb} removeThumb={th.removeThumb} size={24} rounded={4} editable={false}/><select value={cat} onChange={e=>sel(e.target.value)} style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--accent)",fontWeight:600,background:"none",border:"none",cursor:"pointer",outline:"none",padding:"2px 4px",appearance:"auto"}}>{CATS.map(c=><option key={c} value={c}>{CAT[c].label}</option>)}</select><div style={{flex:1}}/><span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)"}}>{list.length} results</span></div>
    <div className="browse-layout" style={{gap:16,alignItems:"start"}}>
      {/* SIDEBAR */}
      <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:14,position:"sticky",top:64}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}><span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mint)",fontWeight:600,letterSpacing:1}}>FILTERS</span>{ac>0&&<button onClick={()=>{setBrands([]);setMarketplaces([]);setMaxPr(5000);setMinPr(0);setMinR(0);setCpO(false);setSf({});}} style={{fontSize:9,color:"var(--rose)",background:"none",border:"none",cursor:"pointer",fontFamily:"var(--ff)"}}>Clear ({ac})</button>}</div>
        <FG label="PRICE RANGE">
          <div style={{display:"flex",gap:6,marginBottom:6}}>
            <input type="number" value={minPr||""} onChange={e=>setMinPr(+e.target.value||0)} placeholder="Min $" style={{width:"50%",background:"var(--bg4)",border:"1px solid var(--bdr)",borderRadius:4,padding:"4px 6px",fontSize:10,color:"var(--txt)",fontFamily:"var(--mono)",outline:"none"}}/>
            <input type="number" value={maxPr>=5000?"":maxPr} onChange={e=>setMaxPr(+e.target.value||5000)} placeholder="Max $" style={{width:"50%",background:"var(--bg4)",border:"1px solid var(--bdr)",borderRadius:4,padding:"4px 6px",fontSize:10,color:"var(--txt)",fontFamily:"var(--mono)",outline:"none"}}/>
          </div>
          <input type="range" min={0} max={Math.ceil(prMx/50)*50} value={Math.min(maxPr,Math.ceil(prMx/50)*50)} onChange={e=>setMaxPr(+e.target.value)} style={{width:"100%"}}/>
          <div style={{display:"flex",justifyContent:"space-between",marginTop:2}}><span style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--mute)"}}>${minPr}</span><span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--mint)",fontWeight:600}}>to ${maxPr>=5000?"∞":"$"+maxPr}</span></div>
        </FG>
        <FG label="BRAND">{allBr.map(b=><Chk key={b} label={b} checked={brands.includes(b)} onChange={()=>setBrands(p=>p.includes(b)?p.filter(x=>x!==b):[...p,b])} count={catP.filter(p=>p.b===b).length}/>)}</FG>
        {allMarkets.length>0&&<FG label="MARKETPLACE" open={true}>{allMarkets.map(m=>{const cap=m.charAt(0).toUpperCase()+m.slice(1);const cnt=catP.filter(p=>p.deals&&typeof p.deals==="object"&&p.deals[m]&&typeof p.deals[m]==="object"&&p.deals[m].price).length;return <Chk key={m} label={cap} checked={marketplaces.includes(m)} onChange={()=>setMarketplaces(p=>p.includes(m)?p.filter(x=>x!==m):[...p,m])} count={cnt}/>;})}</FG>}
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
                <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)"}}>{mn}{cfg.unit||""}</span>
                <input type="range" min={mn} max={mx} value={sf[field+"_max"]||mx} onChange={e=>{const v=+e.target.value;setSf(prev=>({...prev,[field+"_max"]:v}));}} style={{flex:1}}/>
                <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--mint)",fontWeight:600}}>{sf[field+"_max"]||mx}{cfg.unit||""}</span>
              </div>
            </FG>;
          }
          // Default: checkbox filter
          const opts=uv(cat,field,cfg.extract);
          if(!opts.length)return null;
          const matchVal=cfg.extract?(p,v)=>cfg.extract(p)===v:(p,v)=>String(p[field])===v;
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
            <span style={{position:"absolute",left:8,top:"50%",transform:"translateY(-50%)",fontSize:12,color:"var(--mute)"}}>🔍</span>
            <input value={q} onChange={e=>setQ(e.target.value)} placeholder={`Search ${cat?CAT[cat].label.toLowerCase():"all parts"}...`}
              style={{width:"100%",background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:6,padding:"7px 8px 7px 28px",fontSize:12,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none"}}/>
            {q&&<button onClick={()=>setQ("")} style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"var(--dim)",fontSize:11,cursor:"pointer"}}>✕</button>}
          </div>
          <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)"}}>SORT</span>
          <select value={sort} onChange={e=>setSort(e.target.value)} style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:5,padding:"7px 8px",fontSize:10,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none",cursor:"pointer"}}><option value="price-asc">Price ↑</option><option value="price-desc">Price ↓</option><option value="rating-desc">Top Rated</option><option value="bench-desc">Performance</option><option value="value-desc">Best Value</option></select>
        </div>
        {/* Header */}
        <div style={{display:"grid",gridTemplateColumns:`4fr ${cols.map(()=>"1fr").join(" ")} 60px 80px 70px`,gap:8,padding:"10px 12px",borderBottom:"2px solid var(--bdr2)",background:"var(--bg3)",borderRadius:"8px 8px 0 0"}}>
          <span style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)",fontWeight:600,letterSpacing:0.5,textTransform:"uppercase"}}>Product</span>
          {cols.map(col=><span key={col} style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)",fontWeight:600,letterSpacing:0.5,textAlign:"center",textTransform:"uppercase"}}>{(SL[col]||col)}</span>)}
          <span style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)",fontWeight:600,textAlign:"center",textTransform:"uppercase"}}>Value</span>
          <span style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)",fontWeight:600,textAlign:"right",textTransform:"uppercase"}}>Price</span><span/>
        </div>
        {/* Rows */}
        {list.map((p,i)=>{
          const isExp=expanded===p.id;
          const rr=retailers(p);
          return <div key={p.id}>
            {isExp && <ProductSchema p={p}/>}
            <div onClick={()=>setExpanded(isExp?null:p.id)} style={{display:"grid",gridTemplateColumns:`4fr ${cols.map(()=>"1fr").join(" ")} 60px 80px 70px`,gap:8,padding:"10px 12px",alignItems:"center",borderBottom:isExp?"none":"1px solid var(--bdr)",background:isExp?"var(--bg3)":i%2?"var(--bg2)":"transparent",cursor:"pointer",borderRadius:isExp?"8px 8px 0 0":0,transition:"background .2s"}}>
              <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>{p.img?<img loading="lazy" decoding="async" src={p.img} alt="" style={{width:40,height:40,objectFit:"contain",borderRadius:6,background:"var(--bg4)"}}/>:<span style={{fontSize:18,width:40,textAlign:"center"}}>{ic(p)}</span>}<div style={{minWidth:0}}><div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)",display:"-webkit-box",WebkitLineClamp:3,WebkitBoxOrient:"vertical",overflow:"hidden",lineHeight:1.3}}>{p.n}</div><div style={{display:"flex",alignItems:"center",gap:4,marginTop:2}}><span style={{fontSize:11,color:"var(--dim)",fontFamily:"var(--ff)"}}>{p.b}</span><Stars r={p.r} s={10}/>{p.cp&&<Tag color="var(--amber)">-${p.off}</Tag>}{(p.used===true||p.condition==="used")&&<Tag color="#F59E0B">USED</Tag>}{p.condition==="refurbished"&&<Tag color="var(--sky)">REFURBISHED</Tag>}{p.condition==="open-box"&&<Tag color="var(--violet)">OPEN BOX</Tag>}{p.bundle&&<Tag color="var(--amber)">BUNDLE</Tag>}</div></div></div>
              {cols.map(col=>{const v=p[col];const fmtVal=fmt(col,v,p);return <div key={col} style={{textAlign:"center"}}>{col==="bench"&&v!=null?<SBar v={v}/>:typeof fmtVal==="string"&&fmtVal.includes("\n")?<div><div style={{fontFamily:"var(--ff)",fontSize:12,color:v!=null?"var(--txt)":"var(--mute)",fontWeight:500}}>{fmtVal.split("\n")[0]}</div><div style={{fontFamily:"var(--ff)",fontSize:9,color:"var(--dim)"}}>{fmtVal.split("\n")[1]}</div></div>:<span style={{fontFamily:"var(--ff)",fontSize:12,color:v!=null?"var(--txt)":"var(--mute)",fontWeight:500}}>{fmtVal}</span>}</div>})}
              {(()=>{if(p.bench==null)return <div style={{textAlign:"center"}}><span style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--mute)"}}>—</span></div>;const ratio=Math.round((p.bench/Math.max($(p)/100,1))*10)/10;const grade=ratio>=28?"S":ratio>=20?"A":ratio>=14?"B":ratio>=8?"C":"D";const gc=ratio>=28?"var(--mint)":ratio>=20?"var(--sky)":ratio>=14?"var(--amber)":ratio>=8?"var(--dim)":"var(--rose)";return <div style={{textAlign:"center"}}><span style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:800,color:gc}}>{grade}</span></div>;})()}
              <div style={{textAlign:"right"}}>{(p.msrp&&p.msrp>$(p)||p.off>0)&&<div style={{fontFamily:"var(--ff)",fontSize:9,color:"var(--mute)",textDecoration:"line-through"}}>${fmtPrice(p.msrp||p.pr)}</div>}<div style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:700,color:"var(--mint)"}}>${fmtPrice($(p))}</div>{rr.length>1&&<div style={{fontFamily:"var(--ff)",fontSize:9,color:"var(--dim)"}}>{rr.length} stores</div>}</div>
              <div style={{display:"flex",justifyContent:"flex-end"}} onClick={e=>{e.stopPropagation();setExpanded(isExp?null:p.id);}}>
                <button style={{background:isExp?"var(--bg4)":"var(--mint)",border:isExp?"1px solid var(--mint)":"none",borderRadius:6,padding:"6px 14px",cursor:"pointer",fontFamily:"var(--ff)",fontSize:10,fontWeight:700,color:isExp?"var(--mint)":"var(--bg)",transition:"all .15s"}}>{isExp?"Close":"Buy →"}</button>
              </div>
            </div>
            {/* Expanded: pricing, availability & deals */}
            {isExp&&<div style={{background:"var(--bg3)",borderRadius:"0 0 10px 10px",padding:"22px 24px",marginBottom:6,border:"1px solid var(--bdr)",borderTop:"none"}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1.4fr",gap:28}}>
                {/* Left: specs */}
                <div>
                  <div style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--accent)",letterSpacing:1,marginBottom:10,fontWeight:700,textTransform:"uppercase"}}>Specifications</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"0 20px"}}>
                    {Object.entries(p).filter(([k])=>!["id","n","c","b","pr","r","cp","off","deals","msrp","url","img","bench","condition","generation","chipset"].includes(k)&&p[k]!=null&&typeof p[k]!=="object").map(([k,v])=>
                      <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:"1px solid var(--bdr)"}}>
                        <span style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--dim)"}}>{SL[k]||k}</span>
                        <span style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--txt)",fontWeight:600}}>{fmt(k,v)}</span>
                      </div>)}
                  </div>
                  {p.c==="Motherboard"&&p.memSpeed&&<div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)",marginTop:8,padding:"6px 8px",background:"var(--bg2)",borderRadius:6,lineHeight:1.5}}>* Memory Speed is the max supported by this motherboard. Actual speed also depends on your CPU's memory controller and RAM kit rated speed.</div>}
                  {p.bench!=null&&<div style={{marginTop:14}}><div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)",marginBottom:5}}>PERFORMANCE</div><SBar v={p.bench}/></div>}
                </div>
                {/* Right: buy */}
                <div>
                  <div style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--accent)",letterSpacing:1,marginBottom:10,fontWeight:700,textTransform:"uppercase"}}>Buy Now</div>
                  <div style={{display:"flex",flexDirection:"column",gap:6}}>
                    {rr.length>0?rr.map((r,ri)=>
                      <a key={r.name} href={r.url} target="_blank" rel="noopener noreferrer" style={{display:"flex",alignItems:"center",padding:"12px 14px",borderRadius:8,textDecoration:"none",gap:12,background:ri===0?"var(--mint3)":"var(--bg4)",border:`1px solid ${ri===0?"var(--mint)33":"var(--bdr)"}`}}>
                        <div style={{flex:1}}>
                          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}><span style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:"var(--txt)",textTransform:"capitalize"}}>{r.name}</span>{ri===0&&rr.length>1&&<Tag color="var(--mint)">BEST</Tag>}</div>
                          <div style={{fontFamily:"var(--ff)",fontSize:11,color:r.inStock?"var(--sky)":"var(--rose)"}}>{r.inStock?"✓ In Stock":"✗ Out of Stock"}</div>
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:12}}>
                          <span style={{fontFamily:"var(--ff)",fontSize:20,fontWeight:800,color:ri===0?"var(--mint)":"var(--txt)"}}>${fmtPrice(r.price)}</span>
                          <div style={{background:ri===0?"var(--mint)":"var(--bg3)",border:ri===0?"none":"1px solid var(--bdr2)",borderRadius:6,padding:"8px 16px",fontFamily:"var(--ff)",fontSize:11,fontWeight:700,color:ri===0?"var(--bg)":"var(--txt)"}}>Buy →</div>
                        </div>
                      </a>
                    ):<a href={p.deals?.amazon?.url||"#"} target="_blank" rel="noopener noreferrer" style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 16px",borderRadius:8,background:"var(--mint3)",border:"1px solid var(--mint)33",textDecoration:"none"}}>
                        <div><span style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:"var(--txt)"}}>Amazon</span><div style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--sky)",marginTop:3}}>✓ In Stock</div></div>
                        <div style={{display:"flex",alignItems:"center",gap:12}}><span style={{fontFamily:"var(--ff)",fontSize:20,fontWeight:800,color:"var(--mint)"}}>${fmtPrice($(p))}</span><div style={{background:"var(--mint)",borderRadius:6,padding:"8px 16px",fontFamily:"var(--ff)",fontSize:11,fontWeight:700,color:"var(--bg)"}}>Buy →</div></div>
                      </a>}
                    {rr.length>0&&ALL_RETAILERS.filter(name=>!rr.some(r=>r.name===name)).map(name=>{
                      const cap=name.charAt(0).toUpperCase()+name.slice(1);
                      return <div key={name} style={{display:"flex",alignItems:"center",padding:"12px 14px",borderRadius:8,gap:12,background:"var(--bg4)",border:"1px dashed var(--bdr)",opacity:0.55}}>
                        <div style={{flex:1}}>
                          <div style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:"var(--dim)",textTransform:"capitalize",marginBottom:2}}>{cap}</div>
                          <div style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--mute)"}}>Not tracked at this retailer</div>
                        </div>
                        <span style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:600,color:"var(--mute)",fontStyle:"italic"}}>N/A</span>
                      </div>;
                    })}
                  </div>
                  {(p.r||p.reviews)&&<div style={{marginTop:10,display:"flex",justifyContent:"center",padding:"8px 0"}}><ReviewStars rating={p.r} reviews={p.reviews} size="md"/></div>}
                  {rr.length>1&&<div style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--dim)",textAlign:"center",marginTop:8}}>Save <span style={{color:"var(--mint)",fontWeight:600}}>${(rr[rr.length-1].price-rr[0].price).toFixed(2)}</span> at {rr[0].name} vs {rr[rr.length-1].name}</div>}
                  {p.msrp&&p.msrp>$(p)&&<div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:6,background:"var(--bg4)",border:"1px solid var(--bdr)",marginTop:8}}><span style={{fontSize:16}}>💰</span><div style={{flex:1}}><div style={{fontFamily:"var(--ff)",fontSize:12,fontWeight:600,color:"var(--txt)"}}>Below MSRP</div><div style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--dim)"}}>Was <span style={{textDecoration:"line-through"}}>${fmtPrice(p.msrp)}</span> → ${fmtPrice($(p))}</div></div><span style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:700,color:"var(--mint)"}}>{Math.round((1-$(p)/p.msrp)*100)}% off</span></div>}
                  {/* Product Image */}
                  {(p.used===true||p.condition==="used")&&<div style={{marginTop:14,background:"linear-gradient(90deg,#F59E0B 0%,#D97706 100%)",color:"#1A1A20",padding:"10px 14px",borderRadius:8,fontFamily:"var(--ff)",fontSize:12,fontWeight:700,display:"flex",alignItems:"center",gap:10,border:"1px solid #D97706"}}><span style={{fontFamily:"var(--mono)",fontSize:11,fontWeight:900,letterSpacing:1.5,background:"#1A1A20",color:"#F59E0B",padding:"3px 8px",borderRadius:4}}>USED</span><span>Pre-owned item — check seller rating, condition notes, and return policy before purchasing.</span></div>}{p.img&&<div style={{marginTop:14,background:"var(--bg4)",borderRadius:10,padding:16,display:"flex",alignItems:"center",justifyContent:"center"}}>
                    <img loading="lazy" decoding="async" src={p.img.replace('_AC_SL300_','_AC_SL500_')} alt={p.n} style={{maxWidth:"100%",maxHeight:220,objectFit:"contain",borderRadius:6}}/>
                  </div>}
                </div>
              </div>

              {/* Value + Future-Proofing */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14,marginTop:20,paddingTop:20,borderTop:"1px solid var(--bdr)"}}>
                {p.bench!=null&&<div style={{background:"var(--bg4)",borderRadius:10,padding:"16px 18px"}}>
                  <div style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--accent)",letterSpacing:1,marginBottom:12,fontWeight:700}}>VALUE SCORE</div>
                  {(()=>{const ratio=Math.round((p.bench/Math.max($(p)/100,1))*10)/10;const grade=ratio>=28?"S":ratio>=20?"A":ratio>=14?"B":ratio>=8?"C":"D";const gc=ratio>=28?"var(--mint)":ratio>=20?"var(--sky)":ratio>=14?"var(--amber)":ratio>=8?"var(--dim)":"var(--rose)";const gl=ratio>=28?"Exceptional value":ratio>=20?"Great value":ratio>=14?"Good value":ratio>=8?"Average value":"Below average";return <div>
                    <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:12}}>
                      <div style={{width:52,height:52,borderRadius:12,background:gc+"18",display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{fontFamily:"var(--ff)",fontSize:26,fontWeight:800,color:gc}}>{grade}</span></div>
                      <div><div style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:700,color:"var(--txt)"}}>{ratio.toFixed(1)}</div><div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:gc}}>{gl}</div></div>
                    </div>
                    <div style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--dim)",lineHeight:1.6,background:"var(--bg2)",borderRadius:8,padding:"10px 12px"}}>
                      Performance ({p.bench}%) ÷ Price (${fmtPrice($(p))}) = <span style={{color:"var(--txt)",fontWeight:600}}>{ratio.toFixed(1)}</span><br/>
                      <span style={{color:"var(--mute)"}}>S ≥28 · A ≥20 · B ≥14 · C ≥8 · D &lt;8</span>
                    </div></div>;})()}
                </div>}
                {(p.c==="CPU"||p.c==="GPU"||p.c==="Motherboard")&&<div style={{background:"var(--bg4)",borderRadius:10,padding:"16px 18px"}}>
                  <div style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--accent)",letterSpacing:1,marginBottom:12,fontWeight:700}}>FUTURE-PROOFING</div>
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
                    return f.slice(0,5).map((x,i)=><div key={i} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"8px 0",borderBottom:i<f.length-1?"1px solid var(--bdr)":"none"}}><span style={{fontSize:16,lineHeight:1,flexShrink:0}}>{x.g?"✅":"⚠️"}</span><span style={{fontFamily:"var(--ff)",fontSize:13,color:x.g?"var(--txt)":"var(--amber)",lineHeight:1.4}}>{x.t}</span></div>);})()}
                </div>}
              </div>

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
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><Tag color={color}>{tag}</Tag><span style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--dim)"}}>{sub}</span></div>
                  <div style={{fontFamily:"var(--ff)",fontSize:15,fontWeight:700,color:"var(--txt)",marginBottom:10}}>{alt.n}</div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>{specs(alt).map((s,i)=><div key={i} style={{background:"var(--bg4)",borderRadius:6,padding:"6px 10px",textAlign:"center",minWidth:60}}><div style={{fontFamily:"var(--ff)",fontSize:9,color:"var(--dim)",marginBottom:2}}>{s.l}</div><div style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--txt)",fontWeight:600}}>{s.v}</div></div>)}</div>
                  <div style={{fontFamily:"var(--ff)",fontSize:20,fontWeight:800,color}}>${$(alt)}</div>
                </div>;
                return <div style={{marginTop:14}}>
                  <div style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--accent)",letterSpacing:1,marginBottom:12,fontWeight:700}}>CONSIDER INSTEAD</div>
                  <div style={{display:"grid",gridTemplateColumns:better&&upgrade?"1fr 1fr":"1fr",gap:12}}>
                    {better&&card(better,"var(--mint)",`SAVE $${$(p)-$(better)}`,`${Math.round(better.bench/p.bench*100)}% of this product's perf`)}
                    {upgrade&&card(upgrade,"var(--sky)",`+${upgrade.bench-p.bench}% FASTER`,$(upgrade)>$(p)?`for $${$(upgrade)-$(p)} more`:`$${$(p)-$(upgrade)} cheaper`)}
                  </div>
                </div>;})()}

            </div>}
          </div>;
        })}
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
        <div style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--dim)",marginTop:2}}>
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
          <div style={{fontFamily:"var(--mono)",fontSize:20,fontWeight:800,color:ready?(avg>=144?"var(--mint)":avg>=100?"var(--sky)":avg>=60?"var(--amber)":"var(--rose)"):"var(--mute)"}}>{ready?avg:"—"}</div>
        </div>
      </div>
    </div>

    {/* Game cards */}
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>
      {sample.map(g=>{
        const r=results.find(x=>x.game===g.name);
        return <div key={g.name} style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:8,padding:"8px 10px",display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:16}}>{g.icon}</span>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontFamily:"var(--ff)",fontSize:10,fontWeight:600,color:ready?"var(--txt)":"var(--dim)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{g.name}</div>
            <div style={{height:3,background:"var(--bg4)",borderRadius:2,overflow:"hidden",marginTop:3}}>
              {r&&<div style={{width:`${Math.min(r.fps/200*100,100)}%`,height:"100%",background:tc(r.tier),borderRadius:2,transition:"width .4s ease"}}/>}
            </div>
          </div>
          <div style={{fontFamily:"var(--mono)",fontSize:14,fontWeight:700,color:r?tc(r.tier):"var(--mute)",flexShrink:0,minWidth:28,textAlign:"right"}}>{r?r.fps:"—"}</div>
        </div>;
      })}
    </div>

    {/* Legend + warnings */}
    {/* Legend + warnings + RAM info */}
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:8,flexWrap:"wrap",gap:4}}>
      <div style={{display:"flex",gap:10}}>
        {[{t:"Excellent",f:"144+",c:"var(--mint)"},{t:"Great",f:"100+",c:"var(--sky)"},{t:"Smooth",f:"60+",c:"var(--amber)"},{t:"Playable",f:"30+",c:"var(--rose)"}].map(x=>
          <div key={x.t} style={{display:"flex",alignItems:"center",gap:3}}>
            <div style={{width:6,height:6,borderRadius:2,background:x.c}}/>
            <span style={{fontFamily:"var(--mono)",fontSize:7,color:"var(--dim)"}}>{x.t} ({x.f})</span>
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
function BuilerPartPicker({cat,meta,cols,compatList,onAdd,onBack,isMulti}){
  const [q,setQ]=useState("");
  const [sort,setSort]=useState("price-asc");
  const [brands,setBrands]=useState([]);
  const [minR,setMinR]=useState(0);
  const [prMin,setPrMin]=useState(0);
  const [prMax,setPrMax]=useState(99999);
  const [expanded,setExpanded]=useState(null);

  const allBr=[...new Set(compatList.map(p=>p.b))].sort();
  const prMx=Math.max(...compatList.map(p=>$(p)),100);

  let list=compatList.filter(p=>{
    if(q&&!p.n.toLowerCase().includes(q.toLowerCase())&&!p.b.toLowerCase().includes(q.toLowerCase()))return false;
    if(brands.length&&!brands.includes(p.b))return false;
    if(minR&&p.r<minR)return false;
    if($(p)<prMin||$(p)>prMax)return false;
    return true;
  });
  if(sort==="price-asc")list.sort((a,b)=>$(a)-$(b));
  else if(sort==="price-desc")list.sort((a,b)=>$(b)-$(a));
  else if(sort==="rating-desc")list.sort((a,b)=>b.r-a.r);
  else if(sort==="bench-desc")list.sort((a,b)=>(b.bench||0)-(a.bench||0));

  return <div className="fade" style={{maxWidth:1080,margin:"0 auto",padding:"28px 20px"}}>
    {/* Header */}
    <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
      <button onClick={onBack} style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:8,padding:"8px 14px",cursor:"pointer",display:"flex",alignItems:"center",gap:6,color:"var(--txt)",fontFamily:"var(--ff)",fontSize:12,fontWeight:600}}>← Back to Build</button>
      <div style={{flex:1}}>
        <h2 style={{fontFamily:"var(--ff)",fontSize:20,fontWeight:800,color:"var(--txt)",display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:22}}>{meta.icon}</span> Choose {meta.singular||meta.label}
        </h2>
        <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",marginTop:2}}>{compatList.length} compatible parts · {list.length} shown</div>
      </div>
    </div>

    <div className="builder-picker-layout" style={{gap:20,alignItems:"start"}}>
      {/* Sidebar filters */}
      <div>
        <FG label="PRICE RANGE" open={true}>
          <div style={{display:"flex",gap:6}}>
            <input type="number" placeholder="Min" value={prMin||""} onChange={e=>setPrMin(+e.target.value||0)} style={{width:"50%",background:"var(--bg4)",border:"1px solid var(--bdr)",borderRadius:4,padding:"4px 6px",fontSize:10,color:"var(--txt)",fontFamily:"var(--mono)",outline:"none"}}/>
            <input type="number" placeholder="Max" value={prMax>=99999?"":prMax} onChange={e=>setPrMax(+e.target.value||99999)} style={{width:"50%",background:"var(--bg4)",border:"1px solid var(--bdr)",borderRadius:4,padding:"4px 6px",fontSize:10,color:"var(--txt)",fontFamily:"var(--mono)",outline:"none"}}/>
          </div>
        </FG>
        <FG label="BRAND">{allBr.map(b=><Chk key={b} label={b} checked={brands.includes(b)} onChange={()=>setBrands(p=>p.includes(b)?p.filter(x=>x!==b):[...p,b])} count={compatList.filter(p=>p.b===b).length}/>)}</FG>
        <FG label="RATING">{[4.5,4,0].map(rv=><Chk key={rv} label={rv?`${rv}+ ★`:"All"} checked={minR===rv} onChange={()=>setMinR(minR===rv?0:rv)}/>)}</FG>
        {/* Dynamic spec filters based on category cols */}
        {cols.filter(col=>col!=="bench").map(col=>{
          const vals=[...new Set(compatList.map(p=>p[col]).filter(v=>v!=null))].sort();
          if(vals.length<=1||vals.length>15)return null;
          return <FG key={col} label={(SL[col]||col).toUpperCase()}>
            {vals.map(v=><Chk key={String(v)} label={fmt(col,v)} checked={false} onChange={()=>{}} count={compatList.filter(p=>p[col]===v).length}/>)}
          </FG>;
        })}
      </div>

      {/* Main table */}
      <div>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
          <div style={{flex:1,position:"relative"}}>
            <span style={{position:"absolute",left:8,top:"50%",transform:"translateY(-50%)",fontSize:12,color:"var(--mute)"}}>🔍</span>
            <input value={q} onChange={e=>setQ(e.target.value)} placeholder={`Search ${meta.label.toLowerCase()}...`}
              style={{width:"100%",background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:6,padding:"7px 8px 7px 28px",fontSize:12,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none"}}/>
            {q&&<button onClick={()=>setQ("")} style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"var(--dim)",fontSize:11,cursor:"pointer"}}>✕</button>}
          </div>
          <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)"}}>SORT</span>
          <select value={sort} onChange={e=>setSort(e.target.value)} style={{background:"var(--bg3)",border:"1px solid var(--bdr)",borderRadius:5,padding:"7px 8px",fontSize:10,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none",cursor:"pointer"}}>
            <option value="price-asc">Price ↑</option><option value="price-desc">Price ↓</option><option value="rating-desc">Top Rated</option><option value="bench-desc">Performance</option>
          </select>
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
                {p.img?<img loading="lazy" decoding="async" src={p.img} alt="" style={{width:36,height:36,objectFit:"contain",borderRadius:6,background:"#fff",flexShrink:0}}/>:<span style={{fontSize:16}}>{meta.icon}</span>}
                <div style={{minWidth:0}}>
                  <div style={{fontFamily:"var(--ff)",fontSize:12,fontWeight:600,color:"var(--txt)",display:"-webkit-box",WebkitLineClamp:3,WebkitBoxOrient:"vertical",overflow:"hidden",lineHeight:1.3}}>{p.n}</div>
                  <div style={{display:"flex",alignItems:"center",gap:4,marginTop:1}}>
                    <span style={{fontSize:10,color:"var(--dim)"}}>{p.b}</span>
                    <Stars r={p.r} s={9}/>
                    {p.cp&&<Tag color="var(--amber)">-${p.off}</Tag>}{p.condition==="refurbished"&&<Tag color="var(--sky)">REFURBISHED</Tag>}{p.condition==="open-box"&&<Tag color="var(--violet)">OPEN BOX</Tag>}{p.bundle&&<Tag color="var(--amber)">BUNDLE</Tag>}
                  </div>
                </div>
              </div>
              {cols.map(col=>{const v=p[col];return <div key={col} style={{textAlign:"center"}}>{col==="bench"&&v!=null?<SBar v={v}/>:<span style={{fontFamily:"var(--mono)",fontSize:10,color:v!=null?"var(--txt)":"var(--mute)"}}>{fmt(col,v)}</span>}</div>})}
              <div style={{textAlign:"right"}}>
                {(p.msrp&&p.msrp>$(p))&&<div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--mute)",textDecoration:"line-through"}}>${fmtPrice(p.msrp)}</div>}
                <div style={{fontFamily:"var(--mono)",fontSize:13,fontWeight:700,color:"var(--mint)"}}>${fmtPrice($(p))}</div>
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
                <button onClick={()=>onAdd(p)} style={{background:"var(--mint)",border:"none",borderRadius:6,padding:"8px 20px",cursor:"pointer",fontFamily:"var(--ff)",fontSize:12,fontWeight:700,color:"var(--bg)"}}>+ Add to Build</button>
              </div>
            </div>}
          </div>;
        })}
      </div>
    </div>
  </div>;
}

/* ═══ BUILDER ═══ */
function BuilderPage({th}){
  const [build,setBuild]=useState({});       // {cat: part} for single-select
  const [multiParts,setMultiParts]=useState({});  // {cat: [part,...]} for multi-select
  const [picking,setPicking]=useState(null);
  const [buildName,setBuildName]=useState("My Build");
  const [buildBudget,setBuildBudget]=useState(0); // 0 = no budget set
  const [showConfetti,setShowConfetti]=useState(false);
  const [openSections,setOpenSections]=useState({"core":true,"cooling":false,"expansion":false,"cables":false,"peripherals":false,"accessories":false});
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
        <span style={{fontSize:16}}>{section.icon}</span>
        <span style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:700,color:"var(--txt)",flex:1}}>{section.label}</span>
        {sectionParts.length>0&&<span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--mint)"}}>{sectionParts.length} items · ${sectionTotal}</span>}
        <span style={{color:"var(--mute)",fontSize:12}}>{isOpen?"−":"+"}</span>
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
                <span style={{fontSize:14}}>{meta.icon}</span>
                <div><div style={{fontFamily:"var(--ff)",fontSize:11,fontWeight:600,color:"var(--txt)"}}>{meta.singular||meta.label}</div>
                <div style={{fontFamily:"var(--mono)",fontSize:7,color:"var(--mute)"}}>{compatList.length} options</div></div>
              </div>
              <div>
                {part?<div><div style={{fontFamily:"var(--ff)",fontSize:11,fontWeight:600,color:"var(--txt)"}}>{part.n}</div>
                  <div style={{display:"flex",gap:4,alignItems:"center",marginTop:1}}><span style={{fontSize:9,color:"var(--dim)"}}>{part.b}</span><Stars r={part.r} s={8}/>{part.cp&&<Tag color="var(--amber)">-${part.off}</Tag>}</div></div>
                :isMulti&&parts.length?<div>{parts.map((p,pi)=><div key={p.uid} style={{display:"flex",alignItems:"center",gap:4,marginBottom:1}}>
                    <span style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--txt)",flex:1}}>{p.n}</span>
                    <span style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--mint)"}}>${fmtPrice($(p))}</span>
                    <button onClick={e=>{e.stopPropagation();delMulti(cat,p.uid);}} style={{background:"none",border:"none",color:"var(--rose)",fontSize:10,cursor:"pointer",padding:0}}>✕</button>
                  </div>)}{canAdd&&<button onClick={e=>{e.stopPropagation();setPicking(cat);}} style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--sky)",background:"none",border:"none",cursor:"pointer",padding:0}}>+ Add another</button>}</div>
                :<button onClick={e=>{e.stopPropagation();setPicking(isPicking2?null:cat);}} style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--sky)",background:"var(--sky)08",border:"1px dashed var(--sky)33",borderRadius:5,padding:"4px 10px",cursor:"pointer"}}>+ Choose {meta.singular||cat}</button>}
              </div>
              <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--txt)",opacity:.7}}>{part?specSummary(cat,part):isMulti&&parts.length?parts.length+" selected":""}</div>
              <div style={{textAlign:"right"}}>{part?<div style={{fontFamily:"var(--mono)",fontSize:13,fontWeight:700,color:"var(--mint)"}}>${fmtPrice($(part))}</div>
                :isMulti&&parts.length?<div style={{fontFamily:"var(--mono)",fontSize:13,fontWeight:700,color:"var(--mint)"}}>${parts.reduce((s,p)=>s+$(p),0)}</div>
                :<span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--mute)"}}>—</span>}</div>
              <div style={{textAlign:"center"}}>{part&&<button onClick={e=>{e.stopPropagation();del(cat);}} style={{background:"none",border:"none",color:"var(--rose)",fontSize:12,cursor:"pointer",opacity:.5}}>✕</button>}</div>
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

    return <BuilerPartPicker
      cat={cat} meta={meta} cols={cols} compatList={compatList}
      onAdd={onAdd} onBack={() => setPicking(null)} isMulti={isMulti}
    />;
  };

  if (picking && CAT[picking]) return renderPicker();

  return (
    <div className="fade" style={{maxWidth:1080,margin:"0 auto",padding:"28px 20px"}}>
      {showConfetti&&<div style={{position:"fixed",inset:0,zIndex:999,pointerEvents:"none",display:"flex",alignItems:"center",justifyContent:"center"}}><div style={{fontSize:64,animation:"fIn .5s ease-out"}}>🎉🎊🎉</div></div>}

      {/* Header */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20,flexWrap:"wrap",gap:12}}>
        <div>
          <input value={buildName} onChange={e=>setBuildName(e.target.value)} style={{background:"none",border:"none",borderBottom:"1px dashed var(--mute)",fontFamily:"var(--ff)",fontSize:24,fontWeight:800,color:"var(--txt)",outline:"none",padding:"2px 0",width:280}}/>
          <div style={{display:"flex",gap:8,alignItems:"center",marginTop:6}}>
            <Tag color="var(--mint)">{tier}</Tag>
            <span style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)"}}>{coreFilled}/8 core · ${total}</span>
            {(coreFilled>0||Object.keys(multiParts).length>0)&&<button onClick={()=>{if(window.confirm("Clear everything and start over?")){setBuild({});setMultiParts({});setPicking(null);setBuildName("My Build");setBuildBudget(0);prevCount.current=0;}}} style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--rose)",background:"none",border:"1px solid var(--rose)33",borderRadius:4,padding:"2px 8px",cursor:"pointer"}}>🔄 Start Over</button>}
            {coreFilled>=2&&<button onClick={()=>{const ids=Object.values(build).map(p=>p.id);const data=btoa(JSON.stringify({n:buildName,ids}));const url=window.location.origin+"/#build?d="+data;navigator.clipboard.writeText(url);alert("Build link copied to clipboard!\n\n"+url);}} style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--sky)",background:"none",border:"1px solid var(--sky)33",borderRadius:4,padding:"2px 8px",cursor:"pointer"}}>🔗 Share Build</button>}
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          {/* Budget Tracker */}
          <div style={{textAlign:"center"}}>
            <div style={{fontFamily:"var(--mono)",fontSize:7,color:"var(--dim)",letterSpacing:1}}>BUDGET</div>
            <input type="number" value={buildBudget||""} onChange={e=>setBuildBudget(+e.target.value||0)} placeholder="Set $" style={{width:65,background:"var(--bg4)",border:`1px solid ${buildBudget>0&&total>buildBudget?"var(--rose)":"var(--bdr)"}`,borderRadius:4,padding:"2px 4px",fontSize:12,color:buildBudget>0&&total>buildBudget?"var(--rose)":"var(--mint)",fontFamily:"var(--mono)",fontWeight:700,textAlign:"center",outline:"none"}}/>
            {buildBudget>0&&<div style={{fontFamily:"var(--mono)",fontSize:8,color:total>buildBudget?"var(--rose)":"var(--mint)",marginTop:2}}>{total>buildBudget?`$${total-buildBudget} over`:`$${buildBudget-total} left`}</div>}
          </div>
          {/* Power */}
          <div style={{textAlign:"center"}}><div style={{fontFamily:"var(--mono)",fontSize:7,color:"var(--dim)",letterSpacing:1}}>POWER</div>
            <div style={{fontFamily:"var(--mono)",fontSize:16,fontWeight:700,color:psu&&tdp>psu.watt?"var(--rose)":"var(--txt)"}}>{tdp}W</div>
            {psu&&<div style={{width:50,height:3,background:"var(--bg4)",borderRadius:2,overflow:"hidden",margin:"2px auto"}}><div style={{width:`${Math.min(Math.round(tdp/psu.watt*100),100)}%`,height:"100%",background:tdp>psu.watt*.85?"var(--amber)":"var(--mint)",borderRadius:2}}/></div>}
            {psu&&<div style={{fontFamily:"var(--mono)",fontSize:7,color:"var(--dim)",marginTop:1}}>~${(tdp*0.12*24*30/1000).toFixed(0)}/mo</div>}</div>
          {/* Total */}
          <div style={{textAlign:"right"}}><div style={{fontFamily:"var(--mono)",fontSize:7,color:"var(--dim)",letterSpacing:1}}>TOTAL</div>
            <div style={{fontFamily:"var(--mono)",fontSize:24,fontWeight:700,color:buildBudget>0&&total>buildBudget?"var(--rose)":total>0?"var(--mint)":"var(--mute)"}}>${total}</div></div>
          <div style={{position:"relative",width:50,height:50}}><svg width={50} height={50} style={{transform:"rotate(-90deg)"}}><circle cx={25} cy={25} r={ringR} fill="none" stroke="var(--bg4)" strokeWidth={3}/><circle cx={25} cy={25} r={ringR} fill="none" stroke={pct===100?"var(--mint)":"var(--sky)"} strokeWidth={3} strokeDasharray={ringC} strokeDashoffset={ringC*(1-pct/100)} strokeLinecap="round" style={{transition:"stroke-dashoffset .6s"}}/></svg><div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center"}}><span style={{fontFamily:"var(--mono)",fontSize:11,fontWeight:700,color:pct===100?"var(--mint)":"var(--txt)"}}>{pct}%</span></div></div>
        </div>
      </div>

      {/* Budget warning */}
      {buildBudget>0&&total>buildBudget&&<div style={{padding:"8px 12px",borderRadius:6,fontSize:11,fontFamily:"var(--ff)",background:"#ff5c7c08",color:"var(--rose)",border:"1px solid #ff5c7c18",marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
        💸 <span style={{fontWeight:600}}>${total-buildBudget} over budget!</span> Your build is ${total} but your budget is ${buildBudget}. Consider swapping components for cheaper alternatives.
      </div>}

      {/* Compat alerts */}
      {allIssues.length>0&&<div style={{display:"flex",flexDirection:"column",gap:3,marginBottom:14}}>
        {allIssues.map((x,i)=><div key={i} style={{display:"flex",alignItems:"center",gap:6,padding:"6px 12px",borderRadius:6,fontSize:10,fontFamily:"var(--ff)",background:x.t==="err"?"#ff5c7c08":"#ffb34708",color:x.t==="err"?"var(--rose)":"var(--amber)",border:`1px solid ${x.t==="err"?"#ff5c7c18":"#ffb34718"}`}}>
          <span>{x.t==="err"?"⛔":"⚠️"}</span><span style={{fontFamily:"var(--mono)",fontSize:7,fontWeight:600,opacity:.6}}>{x.cat}</span><span style={{flex:1}}>{x.m}</span></div>)}
      </div>}
      {allIssues.length===0&&coreFilled>=2&&<div style={{padding:"6px 12px",borderRadius:6,fontSize:10,fontFamily:"var(--ff)",background:"var(--mint3)",color:"var(--mint)",border:"1px solid var(--mint)22",marginBottom:14}}>✅ All components compatible</div>}

      {/* Builder sections */}
      {BUILDER_SECTIONS.map(s=>renderSection(s))}

      {/* FPS Estimator */}
      <div style={{marginTop:16}}><BuilderFPS gpu={gpu} cpu={cpu} ram={ram}/></div>
    </div>
  );
}


/* ═══ COMMUNITY ═══ */
function CommunityPage({th}){
  const tierColor=t=>t==="Excellent"?"var(--mint)":t==="Great"?"var(--sky)":t==="Smooth"?"var(--amber)":t==="Playable"?"var(--rose)":"var(--mute)";
  return <div className="fade" style={{maxWidth:900,margin:"0 auto",padding:"28px 20px"}}>
    <h2 style={{fontFamily:"var(--ff)",fontSize:20,fontWeight:800,color:"var(--txt)",marginBottom:16}}>Community Builds</h2>
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
              <div style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:"var(--txt)"}}>{b.nm}</div>
              <div style={{fontSize:10,color:"var(--dim)",fontFamily:"var(--ff)"}}>by {b.by}</div>
            </div>
            <span style={{fontFamily:"var(--mono)",fontSize:12,color:"var(--amber)",fontWeight:600}}>▲{b.v}</span>
          </div>
          <p style={{fontSize:11,color:"var(--dim)",margin:"6px 0",fontFamily:"var(--ff)"}}>{b.d}</p>
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
              <span style={{fontFamily:"var(--mono)",fontSize:11,fontWeight:700,color:"var(--sky)"}}>{avgFps} AVG FPS</span>
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
            <span style={{fontFamily:"var(--mono)",fontSize:16,color:"var(--mint)",fontWeight:700}}>${tot}</span>
          </div>
        </div>;
      })}
    </div>
  </div>;
}

/* ═══ TOOLS ═══ */
function ToolsPage({th}){
  const [tool,setTool]=useState("fps");
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
    // Try API first
    const apiResult=await apiFetch("/bottleneck/analyze",{gpu:bnGPU,cpu:bnCPU,resolution:bnRes});
    if(apiResult&&apiResult.who){
      setBnResult({gpuKey:apiResult.gpu,cpuKey:apiResult.cpu,gpuScore:apiResult.gpuScore,cpuScore:apiResult.cpuScore,who:apiResult.who,severity:apiResult.severity,cpuPct:apiResult.who==="CPU"?apiResult.severity:0,gpuPct:apiResult.who==="GPU"?apiResult.severity:0,ratio:apiResult.ratio,cpuUpgrade:apiResult.cpuUpgrade,gpuUpgrade:apiResult.gpuUpgrade,res:bnRes,gameResults:apiResult.gameResults||[]});
    } else {
      // Fallback to local
      const gpuScore=GPU_SCORES[gpuKey]||100;const cpuScore=CPU_SCORES[cpuKey]||100;
      const cpuWeight=bnRes==="4K"?0.5:bnRes==="1440p"?0.75:1.0;
      const effectiveCPU=cpuScore*cpuWeight;
      const ratio=effectiveCPU/gpuScore;
      const cpuPct=Math.round(Math.max(0,(1-ratio))*100);
      const gpuPct=Math.round(Math.max(0,(ratio-1))*100);
      const who=ratio<0.85?"CPU":ratio>1.15?"GPU":"Balanced";
      const severity=who==="CPU"?cpuPct:who==="GPU"?gpuPct:0;
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
  const inp={width:"100%",background:"var(--bg4)",border:"1px solid var(--bdr)",borderRadius:6,padding:"7px 10px",fontSize:11,color:"var(--txt)",fontFamily:"var(--ff)",outline:"none",marginBottom:8};
  const tierColor=t=>t==="Excellent"?"var(--mint)":t==="Great"?"var(--sky)":t==="Smooth"?"var(--amber)":t==="Playable"?"var(--rose)":"var(--mute)";

  return <div className="fade" style={{maxWidth:1000,margin:"0 auto",padding:"28px 20px"}}>
    <h2 style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--txt)",marginBottom:4}}>Smart Tools</h2>
    <p style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--dim)",marginBottom:20}}>Estimate gaming performance, auto-generate builds, and compare parts.</p>
    <div style={{display:"flex",gap:6,marginBottom:20,flexWrap:"wrap"}}>{tabs.map(t=><button key={t.id} onClick={()=>setTool(t.id)} style={{padding:"8px 14px",borderRadius:8,fontSize:11,fontFamily:"var(--ff)",fontWeight:600,cursor:"pointer",background:tool===t.id?t.c+"18":"transparent",color:tool===t.id?t.c:"var(--dim)",border:`1.5px solid ${tool===t.id?t.c+"44":"var(--bdr)"}`,whiteSpace:"nowrap"}}>{t.l}</button>)}</div>

    {/* ═══ FPS ESTIMATOR ═══ */}
    {tool==="fps"&&<div>
      <div className="tools-layout" style={{gap:20,alignItems:"start"}}>
        {/* Config panel */}
        <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:20}}>
          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--sky)",letterSpacing:1.5,marginBottom:12,fontWeight:600}}>SYSTEM CONFIG</div>

          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",marginBottom:4}}>GPU</div>
          <SearchSelect value={selGPU} onChange={setSelGPU} placeholder="Search GPUs..."
            options={gpuParts.sort((a,b)=>(b.bench||0)-(a.bench||0)).map(p=>({value:p.n,label:p.n,detail:p.vram+"GB"}))}/>

          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",marginBottom:4}}>CPU</div>
          <SearchSelect value={selCPU} onChange={setSelCPU} placeholder="Search CPUs..."
            options={cpuParts.sort((a,b)=>(b.bench||0)-(a.bench||0)).map(p=>({value:p.n,label:p.n,detail:p.cores+"C/"+( p.threads||p.cores*2)+"T"}))}/>

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

          <button onClick={runFPS} disabled={!selGPU||!selCPU||fpsLoading} style={{width:"100%",padding:"10px 0",borderRadius:8,background:selGPU&&selCPU?"var(--sky)":"var(--bg4)",border:"none",fontFamily:"var(--ff)",fontSize:13,fontWeight:700,color:selGPU&&selCPU?"var(--bg)":"var(--mute)",cursor:selGPU&&selCPU&&!fpsLoading?"pointer":"not-allowed"}}>
            {fpsLoading?"⏳ Calculating...":"🎮 Estimate FPS"}
          </button>
        </div>

        {/* Results */}
        <div>
          {!fpsResults&&<div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:40,textAlign:"center"}}>
            <div style={{fontSize:40,marginBottom:10}}>🎮</div>
            <div style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--dim)"}}>Select your GPU and CPU, then click Estimate FPS</div>
            <div style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--mute)",marginTop:6}}>Get estimated frame rates for {GAMES.length} games at any resolution</div>
          </div>}

          {fpsResults&&<div>
            {/* Summary header */}
            <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:16,marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:"var(--txt)"}}>{fpsResults.gpu} + {fpsResults.cpu}</div>
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
                  <span style={{fontSize:20,width:28,textAlign:"center"}}>{game?.icon||"🎮"}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontFamily:"var(--ff)",fontSize:11,fontWeight:600,color:"var(--txt)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{g.game}</div>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginTop:3}}>
                      <div style={{flex:1,height:4,background:"var(--bg4)",borderRadius:2,overflow:"hidden"}}>
                        <div style={{width:`${Math.min(g.fps/180*100,100)}%`,height:"100%",background:tierColor(g.tier),borderRadius:2}}/>
                      </div>
                      <span style={{fontFamily:"var(--mono)",fontSize:8,color:tierColor(g.tier)}}>{g.tier}</span>
                    </div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <div style={{fontFamily:"var(--mono)",fontSize:16,fontWeight:700,color:tierColor(g.tier)}}>{g.fps}</div>
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
      <div className="tools-layout" style={{gap:20,alignItems:"start"}}>
        {/* Config */}
        <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:20}}>
          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--rose)",letterSpacing:1.5,marginBottom:12,fontWeight:600}}>BOTTLENECK CALCULATOR</div>

          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",marginBottom:4}}>GPU</div>
          <SearchSelect value={bnGPU} onChange={setBnGPU} placeholder="Search GPUs..."
            options={gpuParts.sort((a,b)=>(b.bench||0)-(a.bench||0)).map(p=>({value:p.n,label:p.n,detail:p.vram+"GB"}))}/>

          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",marginBottom:4}}>CPU</div>
          <SearchSelect value={bnCPU} onChange={setBnCPU} placeholder="Search CPUs..."
            options={cpuParts.sort((a,b)=>(b.bench||0)-(a.bench||0)).map(p=>({value:p.n,label:p.n,detail:p.cores+"C"}))}/>

          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",marginBottom:4}}>RESOLUTION</div>
          <div style={{display:"flex",gap:4,marginBottom:14}}>
            {["1080p","1440p","4K"].map(r=><button key={r} onClick={()=>setBnRes(r)} style={{flex:1,padding:"6px 0",borderRadius:6,fontSize:10,fontFamily:"var(--mono)",fontWeight:600,cursor:"pointer",background:bnRes===r?"var(--rose)15":"transparent",color:bnRes===r?"var(--rose)":"var(--dim)",border:`1px solid ${bnRes===r?"var(--rose)33":"var(--bdr)"}`}}>{r}</button>)}
          </div>

          <button onClick={runBottleneck} disabled={!bnGPU||!bnCPU||bnLoading} style={{width:"100%",padding:"10px 0",borderRadius:8,background:bnGPU&&bnCPU?"var(--rose)":"var(--bg4)",border:"none",fontFamily:"var(--ff)",fontSize:13,fontWeight:700,color:bnGPU&&bnCPU?"#fff":"var(--mute)",cursor:bnGPU&&bnCPU&&!bnLoading?"pointer":"not-allowed"}}>
            {bnLoading?"⏳ Analyzing...":"🔬 Analyze Bottleneck"}
          </button>
        </div>

        {/* Results */}
        <div>
          {!bnResult&&<div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:40,textAlign:"center"}}>
            <div style={{fontSize:40,marginBottom:10}}>🔬</div>
            <div style={{fontFamily:"var(--ff)",fontSize:14,color:"var(--dim)"}}>Select your GPU and CPU to analyze bottlenecks</div>
            <div style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--mute)",marginTop:6}}>See which component is limiting your performance at each resolution</div>
          </div>}

          {bnResult&&<div>
            {/* Main result card */}
            <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:20,marginBottom:12}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
                <div>
                  <div style={{fontFamily:"var(--ff)",fontSize:16,fontWeight:700,color:"var(--txt)"}}>{bnResult.gpuKey} + {bnResult.cpuKey}</div>
                  <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",marginTop:2}}>at {bnResult.res} resolution</div>
                </div>
                <div style={{padding:"6px 16px",borderRadius:8,fontFamily:"var(--ff)",fontSize:13,fontWeight:700,
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
                <div style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--txt)",lineHeight:1.7}}>
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
                  <div style={{fontFamily:"var(--mono)",fontSize:20,fontWeight:700,color:tierColor(g.tier)}}>{g.fps}</div>
                  <div style={{fontFamily:"var(--mono)",fontSize:8,color:g.bottleneck!=="Balanced"?"var(--rose)":"var(--dim)"}}>{g.bottleneck!=="Balanced"?g.bottleneck+" limited":"Balanced"}</div>
                </div>)}
              </div>
            </div>}

            {/* Upgrade suggestions */}
            {(bnResult.cpuUpgrade||bnResult.gpuUpgrade)&&<div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:16}}>
              <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)",letterSpacing:1,marginBottom:10}}>💡 UPGRADE SUGGESTIONS</div>
              {bnResult.who==="CPU"&&bnResult.cpuUpgrade&&<div style={{display:"flex",alignItems:"center",gap:10,background:"var(--bg3)",borderRadius:8,padding:"10px 14px"}}>
                <span style={{fontSize:18}}>🔴</span>
                <div style={{flex:1}}>
                  <div style={{fontFamily:"var(--ff)",fontSize:12,fontWeight:600,color:"var(--txt)"}}>Upgrade to {bnResult.cpuUpgrade.name}</div>
                  <div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)"}}>+{bnResult.cpuUpgrade.gain}% CPU performance — would reduce or eliminate the bottleneck</div>
                </div>
                <Tag color="var(--sky)">+{bnResult.cpuUpgrade.gain}%</Tag>
              </div>}
              {bnResult.who==="GPU"&&bnResult.gpuUpgrade&&<div style={{display:"flex",alignItems:"center",gap:10,background:"var(--bg3)",borderRadius:8,padding:"10px 14px"}}>
                <span style={{fontSize:18}}>💚</span>
                <div style={{flex:1}}>
                  <div style={{fontFamily:"var(--ff)",fontSize:12,fontWeight:600,color:"var(--txt)"}}>Upgrade to {bnResult.gpuUpgrade.name}</div>
                  <div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)"}}>+{bnResult.gpuUpgrade.gain}% GPU performance — better matched to your CPU</div>
                </div>
                <Tag color="var(--sky)">+{bnResult.gpuUpgrade.gain}%</Tag>
              </div>}
              {bnResult.who==="Balanced"&&<div style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--mint)",textAlign:"center",padding:8}}>✅ No upgrades needed — your system is well balanced!</div>}
            </div>}
          </div>}
        </div>
      </div>
    </div>}

    {/* ═══ COMPARE ═══ */}
    {tool==="cmp"&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
      <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:20}}>
        <h3 style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:"var(--txt)",marginBottom:8}}>Compare Parts</h3>
        <input value={cA} onChange={e=>setCA(e.target.value)} placeholder="Part A (e.g. RTX 4090)" style={inp}/>
        <input value={cB} onChange={e=>setCB(e.target.value)} placeholder="Part B (e.g. RX 7900 XTX)" style={inp}/>
        <button onClick={cmp} style={{width:"100%",padding:"8px 0",borderRadius:6,background:"var(--violet)",border:"none",fontSize:12,fontWeight:700,color:"#fff",cursor:"pointer",fontFamily:"var(--ff)",marginTop:4}}>Compare</button>
      </div>
      <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:20,minHeight:180}}>
        {!cmpResult&&<div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:"var(--mute)",fontFamily:"var(--ff)",fontSize:13}}>Enter two parts to compare →</div>}
        {cmpResult&&<><div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--violet)",letterSpacing:1,marginBottom:10}}>COMPARISON</div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>{[cmpResult.a,cmpResult.b].map(p=><div key={p.id} style={{textAlign:"center"}}><div style={{fontSize:20}}>{ic(p)}</div><div style={{fontSize:12,fontWeight:600,color:"var(--txt)",marginTop:3,fontFamily:"var(--ff)"}}>{p.n}</div><div style={{fontSize:9,color:"var(--dim)",fontFamily:"var(--ff)"}}>{p.b}</div><div style={{fontFamily:"var(--mono)",fontSize:16,fontWeight:700,color:"var(--mint)",marginTop:4}}>${fmtPrice($(p))}</div><Stars r={p.r}/>{p.bench!=null&&<div style={{marginTop:4}}><SBar v={p.bench}/></div>}</div>)}</div>{cmpResult.a.bench!=null&&cmpResult.b.bench!=null&&<div style={{marginTop:10,padding:6,borderRadius:6,background:"#a78bfa15",textAlign:"center",fontFamily:"var(--ff)",fontSize:11,fontWeight:600,color:"var(--violet)"}}>{cmpResult.a.bench>cmpResult.b.bench?`${cmpResult.a.n} is ${cmpResult.a.bench-cmpResult.b.bench}% faster`:cmpResult.b.bench>cmpResult.a.bench?`${cmpResult.b.n} is ${cmpResult.b.bench-cmpResult.a.bench}% faster`:"Tied!"}</div>}</>}
      </div>
    </div>}

    {/* ═══ WILL IT RUN? ═══ */}
    {tool==="willitrun"&&<div>
      <div className="tools-layout" style={{gap:20,alignItems:"start"}}>
        <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:20}}>
          <h3 style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:"var(--txt)",marginBottom:12}}>Will My PC Run This Game?</h3>
          <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",marginBottom:4}}>SELECT GAME</div>
          <select value={wirGame} onChange={e=>setWirGame(e.target.value)} style={inp}><option value="">Choose a game...</option>{GAMES.map(g=><option key={g.name} value={g.name}>{g.name}</option>)}</select>
          <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",marginTop:8,marginBottom:4}}>YOUR GPU</div>
          <SearchSelect options={gpuParts.map(g=>({value:g.n,label:g.n,detail:`${g.vram}GB · ${g.b}`}))} value={wirGPU} onChange={setWirGPU} placeholder="Select GPU..."/>
          <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",marginTop:8,marginBottom:4}}>YOUR CPU</div>
          <SearchSelect options={cpuParts.filter(c=>!c.serverCPU).map(c=>({value:c.n,label:c.n,detail:`${c.cores}C · ${c.b}`}))} value={wirCPU} onChange={setWirCPU} placeholder="Select CPU..."/>
          <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",marginTop:8,marginBottom:4}}>RESOLUTION</div>
          <div style={{display:"flex",gap:4}}>{["1080p","1440p","4K"].map(r=><button key={r} onClick={()=>setWirRes(r)} style={{flex:1,padding:6,borderRadius:5,fontSize:10,fontFamily:"var(--mono)",fontWeight:600,cursor:"pointer",background:wirRes===r?"var(--amber)":"var(--bg4)",color:wirRes===r?"#fff":"var(--dim)",border:`1px solid ${wirRes===r?"var(--amber)":"var(--bdr)"}`}}>{r}</button>)}</div>
          <button onClick={()=>{if(!wirGame||!wirGPU||!wirCPU)return;const gpu=matchGPU(wirGPU)||wirGPU;const cpu=matchCPU(wirCPU)||wirCPU;const results=["Low","Medium","High","Ultra"].map(q=>{const fps=estimateFPS(gpu,cpu,wirGame,wirRes,q);return{quality:q,fps:fps?.fps||0};});setWirResult({game:wirGame,gpu:wirGPU,cpu:wirCPU,res:wirRes,settings:results});}} style={{width:"100%",padding:"10px 0",borderRadius:6,background:"var(--amber)",border:"none",fontSize:13,fontWeight:700,color:"#fff",cursor:"pointer",fontFamily:"var(--ff)",marginTop:12}}>🕹️ Check Performance</button>
        </div>
        <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:20,minHeight:300}}>
          {!wirResult&&<div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:"var(--mute)",fontFamily:"var(--ff)",fontSize:13}}>Select a game and your hardware →</div>}
          {wirResult&&<div>
            <div style={{fontFamily:"var(--ff)",fontSize:18,fontWeight:800,color:"var(--txt)",marginBottom:4}}>Can you run {wirResult.game}?</div>
            <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--dim)",marginBottom:16}}>{wirResult.gpu} · {wirResult.cpu} · {wirResult.res}</div>
            {wirResult.settings.map(s=>{const playable=s.fps>=60;const smooth=s.fps>=100;const color=smooth?"var(--mint)":playable?"var(--sky)":s.fps>=30?"var(--amber)":"var(--rose)";const verdict=smooth?"Smooth":playable?"Playable":s.fps>=30?"Rough":"Unplayable";return <div key={s.quality} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 12px",borderRadius:8,background:"var(--bg3)",marginBottom:6,border:"1px solid var(--bdr)"}}>
              <div style={{width:60,fontFamily:"var(--ff)",fontSize:12,fontWeight:600,color:"var(--txt)"}}>{s.quality}</div>
              <div style={{flex:1}}><div style={{height:8,background:"var(--bg4)",borderRadius:4,overflow:"hidden"}}><div style={{width:`${Math.min(s.fps/144*100,100)}%`,height:"100%",background:color,borderRadius:4}}/></div></div>
              <div style={{fontFamily:"var(--mono)",fontSize:18,fontWeight:700,color,minWidth:60,textAlign:"right"}}>{s.fps} FPS</div>
              <Tag color={color}>{verdict}</Tag>
            </div>})}
            <div style={{marginTop:12,padding:8,borderRadius:6,background:"var(--bg3)",fontFamily:"var(--ff)",fontSize:11,color:"var(--dim)"}}>{wirResult.settings[3]?.fps>=60?"✅ Your PC can handle "+wirResult.game+" at "+wirResult.res+" Ultra!":wirResult.settings[2]?.fps>=60?"⚠️ Playable at High, but Ultra may struggle.":wirResult.settings[1]?.fps>=60?"⚠️ Consider lowering settings to Medium for smooth gameplay.":"❌ Your hardware may struggle with "+wirResult.game+". Consider upgrading."}</div>
          </div>}
        </div>
      </div>
    </div>}

    {/* ═══ BUILD COMPARISON ═══ */}
    {tool==="buildcmp"&&<div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        {["Build A","Build B"].map((label,bi)=>{const st=bi===0?bcBuildA:bcBuildB;const set=bi===0?setBcBuildA:setBcBuildB;return <div key={label} style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:16}}>
          <div style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:"var(--txt)",marginBottom:10}}>{label}</div>
          <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",marginBottom:4}}>GPU</div>
          <SearchSelect options={gpuParts.map(g=>({value:g.n,label:g.n,detail:`${g.vram}GB · $${$(g)}`}))} value={st.gpu} onChange={v=>set(p=>({...p,gpu:v}))} placeholder="Select GPU..."/>
          <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",marginTop:8,marginBottom:4}}>CPU</div>
          <SearchSelect options={cpuParts.filter(c=>!c.serverCPU).map(c=>({value:c.n,label:c.n,detail:`${c.cores}C · $${$(c)}`}))} value={st.cpu} onChange={v=>set(p=>({...p,cpu:v}))} placeholder="Select CPU..."/>
        </div>})}
      </div>
      <button onClick={()=>{if(!bcBuildA.gpu||!bcBuildA.cpu||!bcBuildB.gpu||!bcBuildB.cpu)return;const gA=gpuParts.find(p=>p.n===bcBuildA.gpu);const cA2=cpuParts.find(p=>p.n===bcBuildA.cpu);const gB=gpuParts.find(p=>p.n===bcBuildB.gpu);const cB2=cpuParts.find(p=>p.n===bcBuildB.cpu);const fpsA=estimateAllGames(matchGPU(bcBuildA.gpu)||bcBuildA.gpu,matchCPU(bcBuildA.cpu)||bcBuildA.cpu,"1080p","Ultra");const fpsB=estimateAllGames(matchGPU(bcBuildB.gpu)||bcBuildB.gpu,matchCPU(bcBuildB.cpu)||bcBuildB.cpu,"1080p","Ultra");const costA=(gA?$(gA):0)+(cA2?$(cA2):0);const costB=(gB?$(gB):0)+(cB2?$(cB2):0);const avgA=fpsA.length?Math.round(fpsA.reduce((s,g)=>s+g.fps,0)/fpsA.length):0;const avgB=fpsB.length?Math.round(fpsB.reduce((s,g)=>s+g.fps,0)/fpsB.length):0;setBcResult({a:{gpu:bcBuildA.gpu,cpu:bcBuildA.cpu,cost:costA,avgFps:avgA,tdp:(gA?.tdp||0)+(cA2?.tdp||0),games:fpsA},b:{gpu:bcBuildB.gpu,cpu:bcBuildB.cpu,cost:costB,avgFps:avgB,tdp:(gB?.tdp||0)+(cB2?.tdp||0),games:fpsB}});}} style={{width:"100%",padding:"10px 0",borderRadius:6,background:"var(--violet)",border:"none",fontSize:13,fontWeight:700,color:"#fff",cursor:"pointer",fontFamily:"var(--ff)",marginTop:12}}>📊 Compare Builds</button>
      {bcResult&&<div style={{marginTop:16,background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:20}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
          {[bcResult.a,bcResult.b].map((b,i)=><div key={i} style={{textAlign:"center"}}>
            <div style={{fontFamily:"var(--ff)",fontSize:12,fontWeight:700,color:"var(--txt)"}}>{b.gpu}</div>
            <div style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--dim)"}}>{b.cpu}</div>
            <div style={{display:"flex",justifyContent:"center",gap:16,marginTop:10}}>
              <div><div style={{fontFamily:"var(--mono)",fontSize:20,fontWeight:700,color:"var(--mint)"}}>${b.cost}</div><div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)"}}>GPU+CPU Cost</div></div>
              <div><div style={{fontFamily:"var(--mono)",fontSize:20,fontWeight:700,color:"var(--sky)"}}>{b.avgFps}</div><div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)"}}>Avg FPS</div></div>
              <div><div style={{fontFamily:"var(--mono)",fontSize:20,fontWeight:700,color:"var(--amber)"}}>{b.tdp}W</div><div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)"}}>TDP</div></div>
            </div>
          </div>)}
        </div>
        <div style={{marginTop:12,textAlign:"center",fontFamily:"var(--ff)",fontSize:12,fontWeight:600,color:"var(--violet)",padding:8,borderRadius:6,background:"var(--violet)12"}}>
          {bcResult.a.avgFps>bcResult.b.avgFps?`Build A is ${Math.round((bcResult.a.avgFps/bcResult.b.avgFps-1)*100)}% faster`:`Build B is ${Math.round((bcResult.b.avgFps/bcResult.a.avgFps-1)*100)}% faster`}
          {bcResult.a.cost!==bcResult.b.cost&&` · ${bcResult.a.cost<bcResult.b.cost?"Build A":"Build B"} saves $${Math.abs(bcResult.a.cost-bcResult.b.cost)}`}
        </div>
      </div>}
    </div>}

    {/* ═══ BUILD WIZARD ═══ */}
    {tool==="wizard"&&<div style={{maxWidth:600,margin:"0 auto"}}>
      <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:24}}>
        <div style={{display:"flex",gap:4,marginBottom:20}}>{[0,1,2,3].map(s=><div key={s} style={{flex:1,height:4,borderRadius:2,background:wizStep>=s?"var(--mint)":"var(--bg4)"}}/>)}</div>
        
        {wizStep===0&&<div>
          <h3 style={{fontFamily:"var(--ff)",fontSize:18,fontWeight:700,color:"var(--txt)",marginBottom:6}}>What will you use this PC for?</h3>
          <p style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--dim)",marginBottom:16}}>This helps us prioritize the right components.</p>
          {[{id:"gaming",icon:"🎮",t:"Gaming",d:"High FPS, ray tracing, competitive & story games"},{id:"creative",icon:"🎨",t:"Content Creation",d:"Video editing, 3D rendering, streaming"},{id:"work",icon:"💼",t:"Productivity",d:"Office, multitasking, light photo editing"},{id:"server",icon:"🖥️",t:"Server / Workstation",d:"Always-on, VMs, databases, AI/ML"}].map(u=><button key={u.id} onClick={()=>{setWizUse(u.id);setWizStep(1);}} style={{display:"flex",alignItems:"center",gap:12,width:"100%",padding:"14px 16px",borderRadius:8,marginBottom:6,background:wizUse===u.id?"var(--mint3)":"var(--bg3)",border:`1px solid ${wizUse===u.id?"var(--mint)33":"var(--bdr)"}`,cursor:"pointer",textAlign:"left"}}><span style={{fontSize:24}}>{u.icon}</span><div><div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)"}}>{u.t}</div><div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)"}}>{u.d}</div></div></button>)}
        </div>}

        {wizStep===1&&<div>
          <h3 style={{fontFamily:"var(--ff)",fontSize:18,fontWeight:700,color:"var(--txt)",marginBottom:6}}>What's your budget?</h3>
          <p style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--dim)",marginBottom:16}}>Total budget for all components (excluding monitor & peripherals).</p>
          <input type="range" min={500} max={5000} step={100} value={wizBudget} onChange={e=>setWizBudget(+e.target.value)} style={{width:"100%"}}/>
          <div style={{textAlign:"center",fontFamily:"var(--mono)",fontSize:32,fontWeight:700,color:"var(--mint)",margin:"12px 0"}}>${wizBudget}</div>
          <div style={{display:"flex",justifyContent:"center",gap:6,marginBottom:16}}>{[800,1000,1500,2000,3000].map(b=><button key={b} onClick={()=>setWizBudget(b)} style={{padding:"4px 10px",borderRadius:5,fontSize:10,fontFamily:"var(--mono)",background:wizBudget===b?"var(--mint)":"var(--bg4)",color:wizBudget===b?"#fff":"var(--dim)",border:"none",cursor:"pointer"}}>${b}</button>)}</div>
          <div style={{display:"flex",gap:8}}><button onClick={()=>setWizStep(0)} style={{flex:1,padding:10,borderRadius:6,background:"var(--bg4)",border:"none",fontSize:12,fontWeight:600,color:"var(--dim)",cursor:"pointer",fontFamily:"var(--ff)"}}>← Back</button><button onClick={()=>setWizStep(2)} style={{flex:2,padding:10,borderRadius:6,background:"var(--mint)",border:"none",fontSize:12,fontWeight:600,color:"#fff",cursor:"pointer",fontFamily:"var(--ff)"}}>Next →</button></div>
        </div>}

        {wizStep===2&&<div>
          <h3 style={{fontFamily:"var(--ff)",fontSize:18,fontWeight:700,color:"var(--txt)",marginBottom:6}}>What matters most?</h3>
          <p style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--dim)",marginBottom:16}}>We'll optimize your build around this priority.</p>
          {[{id:"performance",icon:"🚀",t:"Max Performance",d:"Best FPS and speed, even if louder"},{id:"quiet",icon:"🤫",t:"Silent Operation",d:"Quiet fans and coolers, even if slightly slower"},{id:"value",icon:"💰",t:"Best Value",d:"Most performance per dollar"},{id:"aesthetic",icon:"✨",t:"Clean Aesthetics",d:"RGB, tempered glass, coordinated look"}].map(p=><button key={p.id} onClick={()=>{setWizPriority(p.id);setWizStep(3);
            // Generate the build
            const alloc=wizUse==="gaming"?{GPU:.4,CPU:.2,RAM:.08,Motherboard:.12,Storage:.08,PSU:.06,Case:.04,CPUCooler:.04}:wizUse==="creative"?{CPU:.3,GPU:.25,RAM:.1,Motherboard:.12,Storage:.1,PSU:.06,Case:.04,CPUCooler:.04}:{CPU:.25,GPU:.15,RAM:.1,Motherboard:.15,Storage:.15,PSU:.08,Case:.06,CPUCooler:.06};
            const picks={};for(const cat of CORE_CATS){const t=wizBudget*(alloc[cat]||.05);const o=P.filter(pp=>pp.c===cat&&$(pp)<=t*1.3&&!pp.serverCPU);if(o.length){if(p.id==="value")o.sort((a,b)=>((b.bench||0)/$(b))-((a.bench||0)/$(a)));else if(p.id==="quiet")o.sort((a,b)=>(a.tdp||999)-(b.tdp||999));else o.sort((a,b)=>(b.bench||b.r*20)-(a.bench||a.r*20));picks[cat]=o[0];}}
            if(picks.CPU&&picks.Motherboard&&picks.CPU.socket!==picks.Motherboard.socket){const fx=P.filter(pp=>pp.c==="Motherboard"&&pp.socket===picks.CPU.socket&&$(pp)<=wizBudget*.15);if(fx.length)picks.Motherboard=fx[0];}
            if(picks.CPU&&picks.RAM&&picks.CPU.memType){const rFix=P.filter(pp=>pp.c==="RAM"&&pp.ramType===picks.CPU.memType&&$(pp)<=wizBudget*.1);if(rFix.length)picks.RAM=rFix.sort((a,b)=>(b.speed||0)-(a.speed||0))[0];}
            setWizResult(picks);
          }} style={{display:"flex",alignItems:"center",gap:12,width:"100%",padding:"14px 16px",borderRadius:8,marginBottom:6,background:wizPriority===p.id?"var(--mint3)":"var(--bg3)",border:`1px solid ${wizPriority===p.id?"var(--mint)33":"var(--bdr)"}`,cursor:"pointer",textAlign:"left"}}><span style={{fontSize:24}}>{p.icon}</span><div><div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:600,color:"var(--txt)"}}>{p.t}</div><div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)"}}>{p.d}</div></div></button>)}
          <button onClick={()=>setWizStep(1)} style={{width:"100%",padding:10,borderRadius:6,background:"var(--bg4)",border:"none",fontSize:12,fontWeight:600,color:"var(--dim)",cursor:"pointer",fontFamily:"var(--ff)",marginTop:4}}>← Back</button>
        </div>}

        {wizStep===3&&wizResult&&<div>
          <h3 style={{fontFamily:"var(--ff)",fontSize:18,fontWeight:700,color:"var(--txt)",marginBottom:4}}>Your Recommended Build</h3>
          <p style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--dim)",marginBottom:16}}>${wizBudget} {wizUse} build · {wizPriority} priority</p>
          {Object.entries(wizResult).map(([cat,p])=><div key={cat} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 10px",borderRadius:6,background:"var(--bg3)",marginBottom:4,border:"1px solid var(--bdr)"}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:14}}>{CAT[cat]?.icon}</span>
              <div><div style={{fontFamily:"var(--ff)",fontSize:11,fontWeight:600,color:"var(--txt)"}}>{p.n}</div><div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--dim)"}}>{CAT[cat]?.singular}</div></div>
            </div>
            <span style={{fontFamily:"var(--mono)",fontSize:13,fontWeight:700,color:"var(--mint)"}}>${fmtPrice($(p))}</span>
          </div>)}
          <div style={{display:"flex",justifyContent:"space-between",padding:"10px 10px",marginTop:8,borderTop:"1px solid var(--bdr)"}}>
            <span style={{fontFamily:"var(--ff)",fontSize:12,fontWeight:600,color:"var(--txt)"}}>Total</span>
            <span style={{fontFamily:"var(--mono)",fontSize:20,fontWeight:700,color:"var(--mint)"}}>${Object.values(wizResult).reduce((s,p)=>s+$(p),0)}</span>
          </div>
          <div style={{display:"flex",gap:8,marginTop:12}}><button onClick={()=>{setWizStep(0);setWizResult(null);}} style={{flex:1,padding:10,borderRadius:6,background:"var(--bg4)",border:"none",fontSize:12,fontWeight:600,color:"var(--dim)",cursor:"pointer",fontFamily:"var(--ff)"}}>Start Over</button></div>
        </div>}
      </div>
    </div>}

    {/* ═══ POWER CALCULATOR ═══ */}
    {tool==="power"&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
      <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:20}}>
        <h3 style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:"var(--txt)",marginBottom:12}}>Power Consumption Calculator</h3>
        <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",marginBottom:4}}>GPU</div>
        <SearchSelect options={gpuParts.map(g=>({value:g.n,label:g.n,detail:`TDP: ${g.tdp}W`}))} value={pwGPU} onChange={setPwGPU} placeholder="Select GPU..."/>
        <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",marginTop:8,marginBottom:4}}>CPU</div>
        <SearchSelect options={cpuParts.filter(c=>!c.serverCPU).map(c=>({value:c.n,label:c.n,detail:`TDP: ${c.tdp}W`}))} value={pwCPU} onChange={setPwCPU} placeholder="Select CPU..."/>
        <div style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)",marginTop:8,marginBottom:4}}>CASE FANS</div>
        <input type="range" min={0} max={10} value={pwFans} onChange={e=>setPwFans(+e.target.value)} style={{width:"100%"}}/>
        <div style={{fontFamily:"var(--mono)",fontSize:10,color:"var(--txt)",textAlign:"center"}}>{pwFans} fans</div>
        <button onClick={()=>{const gp=gpuParts.find(p=>p.n===pwGPU);const cp=cpuParts.find(p=>p.n===pwCPU);if(!gp||!cp)return;const gpuW=gp.tdp||0;const cpuW=cp.tdp||0;const fanW=pwFans*3;const ramW=10;const storageW=8;const moboW=40;const idle=cpuW*0.15+gpuW*0.1+moboW*0.8+ramW+storageW*0.5+fanW;const gaming=cpuW*0.7+gpuW*0.95+moboW+ramW+storageW+fanW;const full=cpuW+gpuW+moboW+ramW+storageW+fanW+20;const psuRec=Math.ceil(full*1.25/50)*50;const monthCostIdle=(idle*8*30/1000*0.12).toFixed(1);const monthCostGaming=(gaming*4*30/1000*0.12).toFixed(1);setPwResult({cpuW,gpuW,idle:Math.round(idle),gaming:Math.round(gaming),full:Math.round(full),psuRec,monthCostIdle,monthCostGaming});}} style={{width:"100%",padding:"10px 0",borderRadius:6,background:"var(--sky)",border:"none",fontSize:13,fontWeight:700,color:"#fff",cursor:"pointer",fontFamily:"var(--ff)",marginTop:12}}>⚡ Calculate Power</button>
      </div>
      <div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:10,padding:20,minHeight:250}}>
        {!pwResult&&<div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",color:"var(--mute)",fontFamily:"var(--ff)",fontSize:13}}>Select components to calculate power →</div>}
        {pwResult&&<div>
          <div style={{fontFamily:"var(--mono)",fontSize:9,color:"var(--sky)",letterSpacing:1,marginBottom:12,fontWeight:600}}>POWER ANALYSIS</div>
          {[{label:"Idle",w:pwResult.idle,color:"var(--mint)",desc:"Desktop, browsing, light work"},{label:"Gaming",w:pwResult.gaming,color:"var(--amber)",desc:"Gaming, GPU-intensive apps"},{label:"Full Load",w:pwResult.full,color:"var(--rose)",desc:"Stress test, all cores + GPU maxed"}].map(s=><div key={s.label} style={{marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}><span style={{fontFamily:"var(--ff)",fontSize:11,fontWeight:600,color:"var(--txt)"}}>{s.label}</span><span style={{fontFamily:"var(--mono)",fontSize:14,fontWeight:700,color:s.color}}>{s.w}W</span></div>
            <div style={{height:8,background:"var(--bg4)",borderRadius:4,overflow:"hidden"}}><div style={{width:`${Math.min(s.w/pwResult.psuRec*100,100)}%`,height:"100%",background:s.color,borderRadius:4}}/></div>
            <div style={{fontFamily:"var(--ff)",fontSize:9,color:"var(--dim)",marginTop:2}}>{s.desc}</div>
          </div>)}
          <div style={{borderTop:"1px solid var(--bdr)",paddingTop:12,marginTop:8}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}><span style={{fontFamily:"var(--ff)",fontSize:12,fontWeight:600,color:"var(--txt)"}}>Recommended PSU</span><span style={{fontFamily:"var(--mono)",fontSize:16,fontWeight:700,color:"var(--mint)"}}>{pwResult.psuRec}W+</span></div>
            <div style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--dim)"}}>Based on full load + 25% headroom</div>
            <div style={{display:"flex",gap:12,marginTop:8}}>
              <div style={{flex:1,background:"var(--bg3)",borderRadius:6,padding:"6px 8px",textAlign:"center"}}><div style={{fontFamily:"var(--mono)",fontSize:12,fontWeight:700,color:"var(--txt)"}}>${pwResult.monthCostIdle}</div><div style={{fontFamily:"var(--mono)",fontSize:7,color:"var(--dim)"}}>$/mo idle 8h</div></div>
              <div style={{flex:1,background:"var(--bg3)",borderRadius:6,padding:"6px 8px",textAlign:"center"}}><div style={{fontFamily:"var(--mono)",fontSize:12,fontWeight:700,color:"var(--txt)"}}>${pwResult.monthCostGaming}</div><div style={{fontFamily:"var(--mono)",fontSize:7,color:"var(--dim)"}}>$/mo gaming 4h</div></div>
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
    <div style={{maxWidth:1200,margin:"0 auto",padding:"48px 32px 32px"}}>
      <div style={{display:"grid",gridTemplateColumns:"1.5fr 1fr 1fr 1fr 1fr",gap:40,marginBottom:32}}>
        <div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
            <div style={{width:32,height:32,borderRadius:8,overflow:"hidden"}}><TowerLogo size={26}/></div>
            <div><div style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:"var(--txt)"}}>Pro Rig</div><div style={{fontFamily:"var(--ff)",fontSize:8,fontWeight:500,color:"var(--dim)",letterSpacing:1.5}}>BUILDER</div></div>
          </div>
          <p style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--dim)",lineHeight:1.7,maxWidth:280}}>Compare PC hardware prices across retailers, check compatibility, and build your dream rig for less. <a href="https://prorigbuilder.com" style={{color:"var(--accent)",textDecoration:"underline"}}>prorigbuilder.com</a></p>
        </div>
        <div>
          <div style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--accent)",fontWeight:700,marginBottom:12,letterSpacing:0.5}}>Browse</div>
          {["Processors","Graphics Cards","Memory","Motherboards","Storage","Power Supplies","Cases","Coolers"].map(l=>
            <button key={l} onClick={()=>go("search")} style={{display:"block",fontFamily:"var(--ff)",fontSize:12,color:"var(--dim)",background:"none",border:"none",cursor:"pointer",padding:"4px 0",textAlign:"left"}}>{l}</button>
          )}
        </div>
        <div>
          <div style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--accent)",fontWeight:700,marginBottom:12,letterSpacing:0.5}}>Tools</div>
          {[{l:"PC Builder",p:"builder"},{l:"Community Builds",p:"community"},{l:"Smart Tools",p:"tools"},{l:"Browse Prices",p:"search"}].map(x=>
            <button key={x.l} onClick={()=>go(x.p)} style={{display:"block",fontFamily:"var(--ff)",fontSize:12,color:"var(--dim)",background:"none",border:"none",cursor:"pointer",padding:"4px 0",textAlign:"left"}}>{x.l}</button>
          )}
        </div>
        <div>
          <div style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--accent)",fontWeight:700,marginBottom:12,letterSpacing:0.5}}>Guides</div>
          {[{l:"Why Pro Rig Builder",p:"compare"},{l:"vs PCPartPicker",p:"vs-pcpartpicker"},{l:"PCPartPicker Alternative",p:"pcpartpicker-alternative"},{l:"Best PC Builder Tools",p:"best-pc-builder-tools"}].map(x=>
            <button key={x.l} onClick={()=>go(x.p)} style={{display:"block",fontFamily:"var(--ff)",fontSize:12,color:"var(--dim)",background:"none",border:"none",cursor:"pointer",padding:"4px 0",textAlign:"left",width:"auto"}}>{x.l}</button>
          )}
        </div>
        <div>
          <div style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--accent)",fontWeight:700,marginBottom:12,letterSpacing:0.5}}>Legal</div>
          {[{l:"About",p:"about"},{l:"Contact",p:"contact"},{l:"Privacy Policy",p:"privacy"},{l:"Terms of Use",p:"terms"},{l:"Affiliate Disclosure",p:"affiliate"}].map(x=>
            <button key={x.l} onClick={()=>go(x.p)} style={{display:"block",fontFamily:"var(--ff)",fontSize:12,color:"var(--dim)",background:"none",border:"none",cursor:"pointer",padding:"4px 0",textAlign:"left",width:"auto"}}>{x.l}</button>
          )}
        </div>
      </div>
      <div style={{borderTop:"1px solid var(--bdr)",paddingTop:20,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
        <span style={{fontFamily:"var(--ff)",fontSize:11,color:"var(--mute)"}}>© {new Date().getFullYear()} Pro Rig Builder. Built and managed by <a href="https://tiereduptech.com" target="_blank" rel="noopener noreferrer" style={{color:"var(--accent)",textDecoration:"underline",fontWeight:600}}>TieredUp Tech, Inc.</a> Prices and availability subject to change.</span>
        <span style={{fontFamily:"var(--ff)",fontSize:10,color:"var(--mute)"}}>As an Amazon Associate I earn from qualifying purchases. We may earn commissions from affiliate links.</span>
      </div>
    </div>
  </footer>;
}

/* ═══ APP ═══ */
export default function App(){
  const [page,setPageRaw]=useState("home");const [bc,setBc]=useState("");
  const th = useThumbs();
  const [theme,setTheme]=useState(()=>{try{return localStorage.getItem("rf-theme")||"light";}catch{return"light";}});
  const toggleTheme=()=>{const next=theme==="dark"?"light":"dark";setTheme(next);try{localStorage.setItem("rf-theme",next);}catch{};};

  // ── Browser history support ──
  const setPage = (p, replaceCurrent) => {
    setPageRaw(p);
    if (replaceCurrent) {
      window.history.replaceState({page:p}, "", `#${p}`);
    } else {
      window.history.pushState({page:p}, "", `#${p}`);
    }
  };

  useEffect(() => {
    // Handle browser back/forward buttons
    const onPop = (e) => {
      const state = e.state;
      if (state && state.page) {
        setPageRaw(state.page);
        if (state.page !== "search") setBc("");
      } else {
        setPageRaw("home");
      }
    };
    window.addEventListener("popstate", onPop);

    // Set initial state
    const rawHash = window.location.hash.replace("#","");
    const hash = rawHash.split("?")[0]; // strip query params for page matching
    if (hash && ["home","search","builder","community","tools","upgrade","scanner","about","contact","privacy","terms","affiliate","compare","vs-pcpartpicker","pcpartpicker-alternative","best-pc-builder-tools"].includes(hash)) {
      setPageRaw(hash);
      window.history.replaceState({page:hash}, "", window.location.hash);
    } else {
      window.history.replaceState({page:"home"}, "", "#home");
    }

    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const handleBrowse=c=>{setBc(c);setPage("search");};
  return <div data-theme={theme} style={{minHeight:"100vh",background:"var(--bg)",color:"var(--txt)",fontFamily:"var(--ff)",display:"flex",flexDirection:"column",transition:"background .3s, color .3s"}}><style>{css}</style><Nav page={page} setPage={p=>{setPage(p);if(p!=="search")setBc("");}} onBrowse={handleBrowse} th={th} theme={theme} toggleTheme={toggleTheme}/><main style={{flex:1}}>{page==="home"&&<HomePage go={setPage} browse={handleBrowse} th={th}/>}{page==="search"&&<SearchPageRouter activeCat={bc} th={th}/>}{page==="builder"&&<BuilderPage th={th}/>}{page==="community"&&<CommunityPage th={th}/>}{page==="tools"&&<ToolsPage th={th}/>}{page==="upgrade"&&<UpgradePage/>}{page==="scanner"&&<ScannerPage go={setPage}/>}{page==="about"&&<AboutPage go={setPage}/>}{page==="contact"&&<ContactPage/>}{page==="privacy"&&<PrivacyPage/>}{page==="terms"&&<TermsPage/>}{page==="affiliate"&&<AffiliatePage/>}{page==="compare"&&<ComparePage go={setPage}/>}{page==="vs-pcpartpicker"&&<VsPcPartPickerPage go={setPage}/>}{page==="pcpartpicker-alternative"&&<PcpAlternativePage go={setPage}/>}{page==="best-pc-builder-tools"&&<BestPcBuilderToolsPage go={setPage}/>}</main><Footer go={setPage}/></div>;
}
