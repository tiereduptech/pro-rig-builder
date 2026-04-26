const fs = require('fs');

const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/\r\n/g, '\n');

// Check if already patched
if (s.includes('const CATEGORY_GUIDES')) {
  console.log('Already has CATEGORY_GUIDES - stripping old version');
  const start = s.indexOf('/* === CATEGORY GUIDES ===');
  const end = s.indexOf('/* === END CATEGORY GUIDES ===');
  if (start > 0 && end > start) {
    const endLine = s.indexOf('\n', end) + 1;
    s = s.substring(0, start) + s.substring(endLine);
  }
}

// ============================================================
// PART A: Category guides data + renderer component
// ============================================================
const guidesBlock = `/* === CATEGORY GUIDES === */
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
  InternalLCD: {
    title: "Internal LCD displays",
    look: ["Screen size and resolution", "Mounting compatibility with your case", "Software ecosystem (AIDA64, NZXT CAM, etc.)"],
    tip: "Great for showing temps, usage, or custom animations inside your build"
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
      <div style={{fontFamily:"var(--ff)",fontSize:13,fontWeight:700,color:"var(--accent)",marginBottom:8,display:"flex",alignItems:"center",gap:6}}>
        <span style={{fontSize:14}}>💡</span> {g.title}
      </div>
      <div style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--txt)",lineHeight:1.6,marginBottom:8}}>
        What to look for:
      </div>
      <ul style={{margin:0,paddingLeft:18,fontFamily:"var(--ff)",fontSize:12,color:"var(--dim)",lineHeight:1.7}}>
        {g.look.map((item, i) => <li key={i} style={{marginBottom:2}}>{item}</li>)}
      </ul>
      <div style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--mint)",marginTop:10,paddingTop:8,borderTop:"1px solid var(--bdr)",fontWeight:500}}>
        💰 {g.tip}
      </div>
    </div>
  );
}
/* === END CATEGORY GUIDES === */

`;

// PART B: Insert the guides right before the first function that uses them.
// MobileSearchPage is at line ~2043, SearchPage at ~2269. Insert before MobileSearchPage.
const insertBefore = '// === MOBILE SEARCH PAGE ===';
const idx = s.indexOf(insertBefore);
if (idx < 0) { console.log('Insert anchor not found'); process.exit(1); }
s = s.substring(0, idx) + guidesBlock + s.substring(idx);
console.log('✓ Inserted CATEGORY_GUIDES block before MobileSearchPage');

// PART C: Wire into MobileSearchPage — right after breadcrumb, before search bar
{
  const anchor = '    {/* Search bar */}\n    <div style={{position:"relative",marginBottom:10}}>\n      <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:14,color:"var(--mute)"}}>\u{1F50D}</span>';
  if (!s.includes(anchor)) {
    console.log('WARN: MobileSearchPage search bar anchor not found');
  } else {
    const withGuide = '    <CategoryGuide cat={cat}/>\n' + anchor;
    s = s.replace(anchor, withGuide);
    console.log('✓ Wired CategoryGuide into MobileSearchPage');
  }
}

// PART D: Wire into desktop SearchPage — right after breadcrumb header div, before the .browse-layout div
{
  // Anchor: the <div className="browse-layout" line
  const anchor = '    <div className="browse-layout" style={{display:"grid",gridTemplateColumns:"200px 1fr",gap:16,alignItems:"start"}}>';
  if (!s.includes(anchor)) {
    console.log('WARN: SearchPage browse-layout anchor not found');
  } else {
    const withGuide = '    <CategoryGuide cat={cat}/>\n' + anchor;
    s = s.replace(anchor, withGuide);
    console.log('✓ Wired CategoryGuide into desktop SearchPage');
  }
}

// PART E: Wire into MobileBuilerPartPicker — right after header, before search bar
{
  const anchor = '    {/* Search bar */}\n    <div style={{position:"relative",marginBottom:10}}>\n      <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",fontSize:14,color:"var(--mute)"}}>\u{1F50D}</span>\n      <input value={q} onChange={e=>setQ(e.target.value)} placeholder={"Search "+meta.label.toLowerCase()}';
  if (!s.includes(anchor)) {
    console.log('WARN: MobileBuilerPartPicker search bar anchor not found');
  } else {
    const withGuide = '    <CategoryGuide cat={cat}/>\n' + anchor;
    s = s.replace(anchor, withGuide);
    console.log('✓ Wired CategoryGuide into MobileBuilerPartPicker');
  }
}

// PART F: Wire into desktop BuilerPartPicker — right before .builder-picker-layout div
{
  const anchor = '    <div className="builder-picker-layout" style={{display:"grid",gridTemplateColumns:"200px 1fr",gap:20,alignItems:"start"}}>';
  if (!s.includes(anchor)) {
    console.log('WARN: desktop BuilerPartPicker builder-picker-layout anchor not found');
  } else {
    const withGuide = '    <CategoryGuide cat={cat}/>\n' + anchor;
    s = s.replace(anchor, withGuide);
    console.log('✓ Wired CategoryGuide into desktop BuilerPartPicker');
  }
}

fs.writeFileSync(p, s);
console.log('\nDONE');
