// RigFinder Builder Category System v2
// Complete category definitions with compatibility rules and slot logic
//
// BUILDER SECTIONS:
//   1. Core Components (required for a functional PC)
//   2. Cooling (fans + CPU cooler)
//   3. Expansion (cards, optical, internal LCD)
//   4. Cables & Power
//   5. Peripherals
//   6. Accessories

// ═══════════════════════════════════════════
// BUILDER CATEGORY DEFINITIONS
// ═══════════════════════════════════════════

export const BUILDER_SECTIONS = [
  {
    id: "core",
    label: "Core Components",
    icon: "🔧",
    desc: "Essential parts for a working PC",
    categories: ["Case","CPU","CPUCooler","Motherboard","RAM","GPU","Storage","PSU"]
  },
  {
    id: "cooling",
    label: "Cooling & Fans",
    icon: "🌀",
    desc: "Case fans and additional cooling",
    categories: ["CaseFan"]
  },
  {
    id: "expansion",
    label: "Expansion & Drives",
    icon: "🔌",
    desc: "Add-in cards, optical drives, internal screens",
    categories: ["SoundCard","EthernetCard","WiFiCard","OpticalDrive","InternalLCD"]
  },
  {
    id: "cables",
    label: "Cables & Power",
    icon: "🔋",
    desc: "Extension cables, OS, UPS",
    categories: ["ExtensionCables","OS"]
  },
  {
    id: "peripherals",
    label: "Peripherals",
    icon: "🖥️",
    desc: "Everything outside the case",
    categories: ["Monitor","Keyboard","Mouse","Headset","Webcam","Microphone","MousePad","Chair","Desk"]
  },
  {
    id: "accessories",
    label: "Accessories",
    icon: "🎒",
    desc: "Extras and add-ons",
    categories: ["ThermalPaste","ExternalStorage","Antivirus","ExternalOptical","UPS"]
  }
];

// ═══════════════════════════════════════════
// CATEGORY METADATA
// ═══════════════════════════════════════════

export const BUILDER_CATS = {
  // ── CORE ──
  Case: {
    icon: "📦", label: "Chassis", singular: "Case",
    qty: 1, // max quantity in a build
    desc: "Tower, mid-tower, SFF cases",
    cols: ["formFactor","caseColor"],
    // Case defines constraints for everything else:
    // moboSupport, gpuClear, coolerClear, maxFans, fanSizes, has525Bay, hasLCDMount
    specFields: ["formFactor","caseColor","gpuClear","coolerClear","moboSupport",
                 "maxFans120","maxFans140","has525Bay","driveBays25","driveBays35","hasLCDMount"]
  },
  CPU: {
    icon: "🔴", label: "Processors", singular: "CPU",
    qty: 1,
    desc: "Desktop CPUs",
    cols: ["cores","socket","tdp","bench"],
    specFields: ["socket","cores","threads","baseClock","boostClock","tdp","memType","maxMem"]
  },
  CPUCooler: {
    icon: "❄️", label: "CPU Coolers", singular: "CPU Cooler",
    qty: 1,
    desc: "Air & AIO liquid coolers",
    cols: ["coolType","coolerH"],
    specFields: ["coolType","coolerH","sockets","ramClear","fanSize","fanCount"],
    // AIO fans count toward case fan total
  },
  Motherboard: {
    icon: "🟡", label: "Motherboards", singular: "Motherboard",
    qty: 1,
    desc: "ATX, mATX & ITX boards",
    cols: ["socket","formFactor","wifi"],
    specFields: ["socket","formFactor","moboFF","memType","m2Slots","sataSlots","ramSlots",
                 "maxMemSpeed","maxMem","wifi","pciSlots","pciLayout"]
    // pciSlots: total PCIe x16/x4/x1 slots
    // pciLayout: [{type:"x16",blocked_by_gpu_height:2.5}, ...] for expansion card logic
  },
  RAM: {
    icon: "⚡", label: "Memory", singular: "RAM Kit",
    qty: 1, // one kit at a time (2x or 4x sticks)
    desc: "DDR5 & DDR4 kits",
    cols: ["capacity","speed","bench"],
    specFields: ["memType","capacity","speed","sticks","height","cas"]
  },
  GPU: {
    icon: "💚", label: "Video Cards", singular: "Graphics Card",
    qty: 1,
    desc: "Gaming & workstation GPUs",
    cols: ["vram","tdp","bench"],
    specFields: ["vram","gpuLen","tdp","pciPwr","slots","busInterface","gpuHeight"]
    // gpuHeight (in slots, e.g. 2.5) determines which PCIe slots below are blocked
  },
  Storage: {
    icon: "💾", label: "Storage", singular: "Drive",
    qty: 6, // can have multiple drives
    desc: "NVMe SSDs, SATA SSDs & HDDs",
    cols: ["storageType","capacity","bench"],
    specFields: ["storageType","capacity","iface","readSpeed","writeSpeed","formFactor"]
    // iface: "M.2" or "SATA" — checked against mobo m2Slots / sataSlots
  },
  PSU: {
    icon: "🔌", label: "Power Supplies", singular: "PSU",
    qty: 1,
    desc: "ATX & SFX power supplies",
    cols: ["watt","efficiency","modular"],
    specFields: ["watt","efficiency","modular","pciConns","psuFF","sataConns","cpuConns"]
    // psuFF: "ATX" or "SFX" — must match case
  },

  // ── COOLING ──
  CaseFan: {
    icon: "🌀", label: "Case Fans", singular: "Case Fan",
    qty: 10, // max fans (actual limit from case)
    desc: "120mm & 140mm case fans",
    cols: ["fanSize","airflow"],
    specFields: ["fanSize","rpm","airflow","noise","rgb","packQty"]
    // fanSize: 120 or 140 — must fit case fan mounts
    // packQty: fans per pack (often 3-pack)
    // Total fans (case fans + AIO fans) must not exceed case maxFans
  },

  // ── EXPANSION ──
  SoundCard: {
    icon: "🔊", label: "Sound Cards", singular: "Sound Card",
    qty: 1,
    desc: "Internal PCIe sound cards",
    cols: ["interface"],
    specFields: ["pciType","cardHeight"],  // pciType: "x1" — needs available PCIe slot
  },
  EthernetCard: {
    icon: "🌐", label: "Ethernet Adapters", singular: "Ethernet Card",
    qty: 1,
    desc: "10GbE / 2.5GbE PCIe network cards",
    cols: ["speed"],
    specFields: ["pciType","speed","cardHeight"]
  },
  WiFiCard: {
    icon: "📶", label: "WiFi Adapters", singular: "WiFi Card",
    qty: 1,
    desc: "PCIe WiFi 6E / 7 cards",
    cols: ["wifiStandard"],
    specFields: ["pciType","wifiStandard","bluetooth","cardHeight"]
  },
  OpticalDrive: {
    icon: "💿", label: "Optical Drives", singular: "Optical Drive",
    qty: 1,
    desc: "Blu-ray & DVD drives",
    cols: ["driveType"],
    specFields: ["driveType","iface"],  // needs case has525Bay
    // Only show if case has 5.25" bay
  },
  InternalLCD: {
    icon: "📺", label: "Internal LCD Screens", singular: "Internal LCD",
    qty: 2,
    desc: "Case-mounted LCD panels for monitoring",
    cols: ["screenSize","resolution"],
    specFields: ["screenSize","resolution","mountType"]
    // Only show if case hasLCDMount
  },

  // ── CABLES & POWER ──
  ExtensionCables: {
    icon: "🔗", label: "Extension Cables", singular: "Cable Kit",
    qty: 3,
    desc: "Sleeved PSU cable extensions",
    cols: ["cableType"],
    specFields: ["cableType","length","connectorType"]
    // connectorType logic: GPU cables need to match PSU pciConns count
    // 24-pin ATX, 8-pin CPU, 6+2 pin GPU, SATA
  },
  OS: {
    icon: "🪟", label: "Operating Systems", singular: "OS",
    qty: 1,
    desc: "Windows, Linux",
    cols: ["osName","edition"],
    specFields: ["osName","edition","licenseType"]
  },

  // ── PERIPHERALS ──
  Monitor: {
    icon: "🖥️", label: "Monitors", singular: "Monitor",
    qty: 4,
    desc: "Gaming & productivity monitors",
    cols: ["panel","resolution","refreshRate","size"],
    specFields: ["panel","resolution","refreshRate","size","hdr","speakers","usbC"]
  },
  Keyboard: {
    icon: "⌨️", label: "Keyboards", singular: "Keyboard",
    qty: 1, cols: ["switchType","layout","connectivity"],
    specFields: ["switchType","layout","connectivity","rgb","hotswap"]
  },
  Mouse: {
    icon: "🖱️", label: "Mice", singular: "Mouse",
    qty: 1, cols: ["dpi","weight","connectivity"],
    specFields: ["dpi","weight","connectivity","sensor","buttons"]
  },
  Headset: {
    icon: "🎧", label: "Headsets", singular: "Headset",
    qty: 1, cols: ["driver","connectivity","mic"],
    specFields: ["driver","connectivity","mic","anc","wireless"]
  },
  Webcam: {
    icon: "📷", label: "Webcams", singular: "Webcam",
    qty: 1, cols: ["resolution","fps","autofocus"],
    specFields: ["resolution","fps","autofocus","fov"]
  },
  Microphone: {
    icon: "🎙️", label: "Microphones", singular: "Microphone",
    qty: 1, cols: ["micType","pattern","connectivity"],
    specFields: ["micType","pattern","connectivity","sampleRate"]
  },
  MousePad: {
    icon: "🖼️", label: "Mouse Pads", singular: "Mouse Pad",
    qty: 1, cols: ["padSize","material"],
    specFields: ["padSize","material","rgb"]
  },
  Chair: {
    icon: "💺", label: "Chairs", singular: "Chair",
    qty: 1, cols: ["chairType","material"],
    specFields: ["chairType","material","maxWeight","adjustable"]
  },
  Desk: {
    icon: "🗄️", label: "Desks", singular: "Desk",
    qty: 1, cols: ["deskSize","sitStand"],
    specFields: ["deskSize","sitStand","material","maxWeight"]
  },

  // ── ACCESSORIES ──
  ThermalPaste: {
    icon: "🧴", label: "Thermal Paste", singular: "Thermal Paste",
    qty: 1, cols: ["conductivity"],
    specFields: ["conductivity","quantity","type"]
  },
  ExternalStorage: {
    icon: "💽", label: "External Storage", singular: "External Drive",
    qty: 3, cols: ["capacity","interface"],
    specFields: ["capacity","interface","speed","formFactor"]
  },
  Antivirus: {
    icon: "🛡️", label: "Antivirus", singular: "Antivirus",
    qty: 1, cols: ["vendor","duration"],
    specFields: ["vendor","duration","devices"]
  },
  ExternalOptical: {
    icon: "📀", label: "External Optical Drives", singular: "External Optical Drive",
    qty: 1, cols: ["driveType","interface"],
    specFields: ["driveType","interface"]
  },
  UPS: {
    icon: "🔋", label: "UPS Systems", singular: "UPS",
    qty: 1, cols: ["va","watts","runtime"],
    specFields: ["va","watts","runtime","outlets","usbPorts","formFactor"]
  },
};


// ═══════════════════════════════════════════
// COMPATIBILITY RULES
// ═══════════════════════════════════════════

export const COMPAT_RULES = {
  // ── Case constraints ──
  "Case→Motherboard": {
    desc: "Motherboard form factor must be supported by case",
    check: (cas, mobo) => {
      if (!cas.moboSupport || !mobo.moboFF) return null;
      const ok = cas.moboSupport.includes(mobo.moboFF);
      return ok ? null : { t: "err", cat: "Case+Mobo", m: `${mobo.n} (${mobo.moboFF}) won't fit in ${cas.n} — supports ${cas.moboSupport.join(", ")}` };
    }
  },
  "Case→GPU": {
    desc: "GPU length must be within case clearance",
    check: (cas, gpu) => {
      if (!cas.gpuClear || !gpu.gpuLen) return null;
      if (gpu.gpuLen > cas.gpuClear) return { t: "err", cat: "Case+GPU", m: `${gpu.n} (${gpu.gpuLen}mm) won't fit — ${cas.n} clears ${cas.gpuClear}mm` };
      if (cas.gpuClear - gpu.gpuLen < 15) return { t: "w", cat: "Case+GPU", m: `Tight fit — only ${cas.gpuClear - gpu.gpuLen}mm GPU clearance` };
      return null;
    }
  },
  "Case→CPUCooler": {
    desc: "CPU cooler height must be within case clearance",
    check: (cas, cooler) => {
      if (!cas.coolerClear || !cooler.coolerH) return null;
      if (cooler.coolerH > cas.coolerClear) return { t: "err", cat: "Case+Cooler", m: `${cooler.n} (${cooler.coolerH}mm) won't fit — ${cas.n} clears ${cas.coolerClear}mm` };
      return null;
    }
  },
  "Case→OpticalDrive": {
    desc: "Case must have 5.25\" bay for optical drive",
    check: (cas, _) => {
      if (cas.has525Bay === false) return { t: "err", cat: "Case+Optical", m: `${cas.n} has no 5.25" bay for an optical drive` };
      return null;
    }
  },
  "Case→InternalLCD": {
    desc: "Case must support internal LCD mounting",
    check: (cas, _) => {
      if (cas.hasLCDMount === false) return { t: "w", cat: "Case+LCD", m: `${cas.n} may not have a dedicated LCD mount point` };
      return null;
    }
  },

  // ── CPU constraints ──
  "CPU→Motherboard": {
    desc: "CPU socket must match motherboard",
    check: (cpu, mobo) => {
      if (cpu.socket !== mobo.socket) return { t: "err", cat: "CPU+Mobo", m: `${cpu.n} (${cpu.socket}) won't fit ${mobo.n} (${mobo.socket})` };
      return null;
    }
  },
  "CPU→CPUCooler": {
    desc: "Cooler must support CPU socket",
    check: (cpu, cooler) => {
      if (!cooler.sockets) return null;
      if (!cooler.sockets.includes(cpu.socket)) return { t: "err", cat: "CPU+Cooler", m: `${cooler.n} doesn't support ${cpu.socket}` };
      if (cpu.tdp >= 200 && cooler.coolType === "Air") return { t: "w", cat: "Cooling", m: `${cpu.n} (${cpu.tdp}W) may benefit from an AIO over ${cooler.n}` };
      return null;
    }
  },
  "CPU→RAM": {
    desc: "RAM type must match CPU memory controller",
    check: (cpu, ram) => {
      if (cpu.memType && ram.memType && cpu.memType !== ram.memType) return { t: "err", cat: "CPU+RAM", m: `${cpu.n} needs ${cpu.memType} but ${ram.n} is ${ram.memType}` };
      if (ram.speed && cpu.maxMem && ram.speed > cpu.maxMem) return { t: "w", cat: "RAM Speed", m: `${ram.n} (${ram.speed}MHz) exceeds ${cpu.n}'s rated ${cpu.maxMem}MHz — may need XMP/EXPO` };
      return null;
    }
  },

  // ── Motherboard constraints ──
  "Motherboard→RAM": {
    desc: "RAM must be compatible with motherboard",
    check: (mobo, ram) => {
      const issues = [];
      if (mobo.memType && ram.memType && mobo.memType !== ram.memType) issues.push({ t: "err", cat: "Mobo+RAM", m: `${ram.n} is ${ram.memType} but ${mobo.n} only supports ${mobo.memType}` });
      if (ram.capacity && mobo.maxMem && ram.capacity > mobo.maxMem) issues.push({ t: "err", cat: "RAM", m: `${ram.n} (${ram.capacity}GB) exceeds ${mobo.n} max (${mobo.maxMem}GB)` });
      if (ram.sticks && mobo.ramSlots && ram.sticks > mobo.ramSlots) issues.push({ t: "err", cat: "RAM", m: `${ram.n} needs ${ram.sticks} slots but ${mobo.n} has ${mobo.ramSlots}` });
      if (ram.speed && mobo.maxMemSpeed && ram.speed > mobo.maxMemSpeed) issues.push({ t: "w", cat: "RAM Speed", m: `${ram.n} (${ram.speed}MHz) exceeds ${mobo.n}'s rated ${mobo.maxMemSpeed}MHz — will downclock` });
      return issues.length ? issues : null;
    }
  },
  "Motherboard→Storage": {
    desc: "Storage interface must have available slots on motherboard",
    // This is checked dynamically based on total M.2 and SATA counts
    check: (mobo, storageList) => {
      const m2Count = storageList.filter(s => s.iface === "M.2").length;
      const sataCount = storageList.filter(s => s.iface === "SATA").length;
      const issues = [];
      if (mobo.m2Slots && m2Count > mobo.m2Slots) issues.push({ t: "w", cat: "Storage", m: `${m2Count} M.2 drives but ${mobo.n} only has ${mobo.m2Slots} M.2 slots` });
      if (mobo.sataSlots && sataCount > mobo.sataSlots) issues.push({ t: "w", cat: "Storage", m: `${sataCount} SATA devices but ${mobo.n} only has ${mobo.sataSlots} ports` });
      return issues.length ? issues : null;
    }
  },

  // ── PSU constraints ──
  "PSU→System": {
    desc: "PSU wattage and connectors must support all components",
    check: (psu, totalTdp, gpu) => {
      const issues = [];
      if (totalTdp > psu.watt) issues.push({ t: "err", cat: "Power", m: `System draws ${totalTdp}W but ${psu.n} only provides ${psu.watt}W` });
      else if (totalTdp > psu.watt * 0.85) issues.push({ t: "w", cat: "Power", m: `${totalTdp}W is near ${psu.n}'s ${psu.watt}W limit — recommend 20% headroom` });
      if (gpu && gpu.pciPwr && psu.pciConns && gpu.pciPwr > psu.pciConns) issues.push({ t: "w", cat: "PSU+GPU", m: `${gpu.n} needs ${gpu.pciPwr} PCIe cables, ${psu.n} has ${psu.pciConns}` });
      return issues.length ? issues : null;
    }
  },

  // ── Fan constraints ──
  "CaseFan→Case": {
    desc: "Fan size must fit case mounts, total fans cannot exceed case maximum",
    check: (cas, fanList, cooler) => {
      const issues = [];
      const aioFans = cooler?.coolType?.includes("AIO") ? (cooler.coolType.includes("360") ? 3 : cooler.coolType.includes("280") ? 2 : cooler.coolType.includes("240") ? 2 : 1) : 0;
      const caseFans120 = fanList.filter(f => f.fanSize === 120).reduce((s, f) => s + (f.packQty || 1), 0);
      const caseFans140 = fanList.filter(f => f.fanSize === 140).reduce((s, f) => s + (f.packQty || 1), 0);
      const total = caseFans120 + caseFans140 + aioFans;

      const max120 = cas.maxFans120 || 6;
      const max140 = cas.maxFans140 || 4;
      const maxTotal = Math.max(max120, max140, 6);

      if (total > maxTotal) issues.push({ t: "w", cat: "Fans", m: `${total} total fans (${aioFans} AIO + ${caseFans120 + caseFans140} case) may exceed ${cas.n}'s capacity (~${maxTotal} max)` });
      if (caseFans140 > max140) issues.push({ t: "w", cat: "Fans", m: `${cas.n} supports up to ${max140} 140mm fans — you have ${caseFans140}` });

      return issues.length ? issues : null;
    }
  },

  // ── Cooler + RAM clearance ──
  "CPUCooler→RAM": {
    desc: "Tower cooler may block tall RAM",
    check: (cooler, ram) => {
      if (!cooler.ramClear || !ram.height) return null;
      if (ram.height > cooler.ramClear) return { t: "w", cat: "Cooler+RAM", m: `${ram.n} (${ram.height}mm tall) may conflict with ${cooler.n} (${cooler.ramClear}mm clearance)` };
      return null;
    }
  },

  // ── Expansion card constraints ──
  "ExpansionCard→Motherboard": {
    desc: "Expansion cards need available PCIe slots not blocked by GPU",
    check: (mobo, gpu, expansionCards) => {
      if (!mobo.pciSlots || !expansionCards.length) return null;
      const gpuSlots = gpu ? Math.ceil(gpu.slots || 2) : 0;
      const availableSlots = mobo.pciSlots - 1 - (gpuSlots > 2 ? gpuSlots - 2 : 0); // GPU takes 1 x16 + may block adjacent
      if (expansionCards.length > availableSlots) return { t: "w", cat: "PCIe Slots", m: `${expansionCards.length} expansion cards but only ~${availableSlots} PCIe slots available (GPU blocks ${gpuSlots > 2 ? gpuSlots - 2 : 0} adjacent)` };
      return null;
    }
  },

  // ── Extension cable constraints ──
  "ExtensionCables→PSU": {
    desc: "GPU extension cables must match PSU connector count",
    check: (psu, cables) => {
      const gpuCables = cables.filter(c => c.connectorType === "GPU" || c.cableType?.includes("GPU") || c.cableType?.includes("PCIe"));
      if (gpuCables.length > (psu.pciConns || 0)) return { t: "w", cat: "Cables", m: `${gpuCables.length} GPU cable extensions but PSU only has ${psu.pciConns || 0} PCIe connectors` };
      return null;
    }
  }
};


// ═══════════════════════════════════════════
// CORE BUILD CATEGORIES (for the main builder table)
// ═══════════════════════════════════════════
// These appear as rows in the PCPartPicker-style table

export const BUILDER_TABLE_CATS = [
  // Core
  "Case","CPU","CPUCooler","Motherboard","RAM","GPU","Storage","PSU",
  // Cooling
  "CaseFan",
  // Expansion
  "SoundCard","EthernetCard","WiFiCard","OpticalDrive","InternalLCD",
  // Cables
  "ExtensionCables","OS",
];

// These are separate sections below the main build table
export const PERIPHERAL_CATS = [
  "Monitor","Keyboard","Mouse","Headset","Webcam","Microphone","MousePad","Chair","Desk"
];

export const ACCESSORY_CATS = [
  "ThermalPaste","ExternalStorage","Antivirus","ExternalOptical","UPS"
];
