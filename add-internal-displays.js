#!/usr/bin/env node
/**
 * add-internal-displays.js
 *
 * Creates a new "InternalDisplay" category and seeds it with 30+ curated
 * products across all price points:
 *
 * Premium brand-name:
 *   - Lian Li US88 (8.8" Universal Screen) Black + White
 *   - Thermalright Trofeo Vision 9.16" LCD
 * Mid-tier:
 *   - Fenvi, Jungle Leopard, hokistudio, AISHICHEN, ZHAOCAILIN
 * Budget small-format:
 *   - 3.5" USB mini screens (EDIY, ASHATA, WOWNOVA, Ransanx)
 *   - 5" to 7.84" mid-size screens
 *
 * Schema (user chose "size + resolution + refresh + connection"):
 *   size         : diagonal inches, e.g. 8.8, 3.5
 *   resolution   : e.g. "1920x480"
 *   refresh      : Hz (60 for all LCDs, sometimes 30 for cheap IPS)
 *   connection   : "USB-C" | "HDMI" | "USB" | "9-pin Header"
 *   panelType    : "IPS" | "TFT" | "OLED"
 *   touch        : boolean (not required by user but included; trivial)
 *   mount        : "Universal" | "120mm Fan" | "140mm Fan" | "5.25\" Bay" | "Desk Stand"
 *   brightness   : nits
 *   ecosystem    : "AIDA64" | "L-Connect" | "HYTE Nexus" | "Standalone"
 */
import { writeFileSync, readFileSync } from 'node:fs';

const AMAZON_TAG = 'tiereduptech-20';
const CAT_KEY = 'InternalDisplay';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = [...mod.PARTS];

// ═══════════════════════════════════════════════════════════════════════════
// STEP 1: REGISTER CATEGORY IN App.jsx
// ═══════════════════════════════════════════════════════════════════════════
const appPath = './src/App.jsx';
let app = readFileSync(appPath, 'utf8');

// Find the CAT dictionary and inject our new category right before the closing brace
// Pattern: look for the last entry before "};" that marks CAT end
const catEntry = `  ${CAT_KEY}:{icon:"🖥️",label:"Internal Displays",singular:"Display",desc:"LCD/IPS screens for inside your PC case",cols:["size","resolution","connection"],filters:{size:{label:"Screen Size",type:"check"},connection:{label:"Connection",type:"check"},panelType:{label:"Panel",type:"check"},ecosystem:{label:"Ecosystem",type:"check"},touch:{label:"Touchscreen",type:"bool"}}},`;

// Inject after the CaseFan entry (a reasonable place)
if (!app.includes(`${CAT_KEY}:`)) {
  // Find a safe insertion point — after "ExtensionCables:" or before the closing of CAT
  // Look for the pattern "};" that ends the CAT object
  const markers = [
    /(ExtensionCables\s*:\s*\{[^}]*\}\s*,\s*)/m,
    /(ExternalStorage\s*:\s*\{[^}]*\}\s*,\s*)/m,
    /(ThermalPaste\s*:\s*\{[^}]*\}\s*,\s*)/m,
  ];
  let injected = false;
  for (const marker of markers) {
    const m = app.match(marker);
    if (m) {
      app = app.replace(marker, `$1\n${catEntry}\n`);
      injected = true;
      console.log(`Injected ${CAT_KEY} after ${m[0].slice(0, 40)}...`);
      break;
    }
  }
  if (!injected) {
    // Fallback: try to find the end of the CAT object
    // Look for CPU:{...} which should be the first entry and find closing }
    console.warn('Could not find injection marker in App.jsx — skipping App.jsx edit');
    console.warn('You will need to manually add the CAT entry.');
  } else {
    writeFileSync(appPath, app);
    console.log(`Wrote App.jsx with new ${CAT_KEY} category`);
  }
} else {
  console.log(`${CAT_KEY} already registered in App.jsx, skipping`);
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2: CURATED PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════
const CURATED = [
  // ─── PREMIUM: LIAN LI ──────────────────────────────────────────────────
  {
    b: 'Lian Li',
    n: 'Lian Li US88 V1 8.8" Universal Screen Black',
    asin: 'B0FKH3NK1H',
    pr: 99,
    msrp: 119,
    r: 4.5,
    reviews: 180,
    size: 8.8,
    resolution: '1920x480',
    refresh: 60,
    connection: 'USB',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 500,
    ecosystem: 'L-Connect',
    img: 'https://m.media-amazon.com/images/I/71RkR5VdGcL._AC_SL300_.jpg',
  },
  {
    b: 'Lian Li',
    n: 'Lian Li US88 V1 8.8" Universal Screen White',
    asin: 'B0FKH57YQP',
    pr: 99,
    msrp: 119,
    r: 4.5,
    reviews: 120,
    size: 8.8,
    resolution: '1920x480',
    refresh: 60,
    connection: 'USB',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 500,
    ecosystem: 'L-Connect',
    img: 'https://m.media-amazon.com/images/I/71RkR5VdGcL._AC_SL300_.jpg',
  },

  // ─── PREMIUM: THERMALRIGHT ─────────────────────────────────────────────
  {
    b: 'Thermalright',
    n: 'Thermalright Trofeo Vision 9.16" LCD Black',
    asin: 'B0G1BXWTYF',
    pr: 79,
    msrp: 99,
    r: 4.4,
    reviews: 95,
    size: 9.16,
    resolution: '1920x480',
    refresh: 60,
    connection: 'USB',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 400,
    ecosystem: 'AIDA64',
    img: 'https://m.media-amazon.com/images/I/61hPTp5x9fL._AC_SL300_.jpg',
  },

  // ─── JUNGLE LEOPARD ────────────────────────────────────────────────────
  {
    b: 'Jungle Leopard',
    n: 'Jungle Leopard 9.16" LCD Mini Secondary Monitor 1920x480 IPS White',
    asin: 'B0D7NWVLBJ',
    pr: 55,
    msrp: 79,
    r: 4.3,
    reviews: 420,
    size: 9.16,
    resolution: '1920x480',
    refresh: 60,
    connection: 'USB-C',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 400,
    ecosystem: 'Standalone',
    img: 'https://m.media-amazon.com/images/I/61BzxS9hyIL._AC_SL300_.jpg',
  },

  // ─── AISHICHEN ─────────────────────────────────────────────────────────
  {
    b: 'AISHICHEN',
    n: 'AISHICHEN 11.26" Mini Monitor FHD 1920x440 IPS HDMI Type-C',
    asin: 'B0FKFQGRJL',
    pr: 99,
    msrp: 129,
    r: 4.3,
    reviews: 350,
    size: 11.26,
    resolution: '1920x440',
    refresh: 60,
    connection: 'HDMI',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 500,
    ecosystem: 'AIDA64',
    img: 'https://m.media-amazon.com/images/I/71lZc0vwryL._AC_SL300_.jpg',
  },
  {
    b: 'AISHICHEN',
    n: 'AISHICHEN 8.8" PC Temperature Display IPS USB Mini Screen AIDA64',
    asin: 'B0D5Q3BKJS',
    pr: 45,
    msrp: 59,
    r: 4.2,
    reviews: 680,
    size: 8.8,
    resolution: '1920x480',
    refresh: 60,
    connection: 'USB-C',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 300,
    ecosystem: 'AIDA64',
    img: 'https://m.media-amazon.com/images/I/61Y2j4ASyHL._AC_SL300_.jpg',
  },

  // ─── ZHAOCAILIN ────────────────────────────────────────────────────────
  {
    b: 'ZHAOCAILIN',
    n: 'ZHAOCAILIN 11.3" Mini Monitor FHD IPS 1920x440 LCD AIDA64',
    asin: 'B0FCDH6XBF',
    pr: 89,
    msrp: 119,
    r: 4.3,
    reviews: 280,
    size: 11.3,
    resolution: '1920x440',
    refresh: 60,
    connection: 'HDMI',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 400,
    ecosystem: 'AIDA64',
    img: 'https://m.media-amazon.com/images/I/71IrVMKzLLL._AC_SL300_.jpg',
  },

  // ─── WISECOCO (12"+ TRAVEL SCREENS) ────────────────────────────────────
  {
    b: 'wisecoco',
    n: 'wisecoco 12.3" Secondary Monitor IPS Stretched Bar 1920x720 HDMI USB-C',
    asin: 'B0BHVB1XXM',
    pr: 179,
    msrp: 229,
    r: 4.3,
    reviews: 840,
    size: 12.3,
    resolution: '1920x720',
    refresh: 60,
    connection: 'HDMI',
    panelType: 'IPS',
    touch: false,
    mount: 'Desk Stand',
    brightness: 400,
    ecosystem: 'Standalone',
    img: 'https://m.media-amazon.com/images/I/61WE3D5TiYL._AC_SL300_.jpg',
  },
  {
    b: 'wisecoco',
    n: 'wisecoco 12.6" Touch Screen Monitor Secondary 1920x515 HDMI',
    asin: 'B0C9LS4W5Z',
    pr: 199,
    msrp: 259,
    r: 4.2,
    reviews: 320,
    size: 12.6,
    resolution: '1920x515',
    refresh: 60,
    connection: 'HDMI',
    panelType: 'IPS',
    touch: true,
    mount: 'Desk Stand',
    brightness: 400,
    ecosystem: 'Standalone',
    img: 'https://m.media-amazon.com/images/I/61IZoMS4lPL._AC_SL300_.jpg',
  },
  {
    b: 'wisecoco',
    n: 'wisecoco 7.84" Mini Monitor 1280x400 USB-C Single-Cable AIDA64',
    asin: 'B0C4HZRB7Q',
    pr: 65,
    msrp: 89,
    r: 4.2,
    reviews: 560,
    size: 7.84,
    resolution: '1280x400',
    refresh: 60,
    connection: 'USB-C',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 300,
    ecosystem: 'AIDA64',
    img: 'https://m.media-amazon.com/images/I/61dTYoAhJ2L._AC_SL300_.jpg',
  },

  // ─── HOKISTUDIO ────────────────────────────────────────────────────────
  {
    b: 'hokistudio',
    n: 'hokistudio 8.8" 1920x480 IPS LCD Screen AIDA64 DIY Kit',
    asin: 'B086R3BT36',
    pr: 59,
    msrp: 79,
    r: 4.2,
    reviews: 190,
    size: 8.8,
    resolution: '1920x480',
    refresh: 60,
    connection: 'HDMI',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 350,
    ecosystem: 'AIDA64',
    img: 'https://m.media-amazon.com/images/I/61AaTaF3xuL._AC_SL300_.jpg',
  },

  // ─── EDIY (BUDGET USB MINI) ────────────────────────────────────────────
  {
    b: 'EDIY',
    n: 'EDIY 5" IPS USB Mini Screen AIDA64 800x480 Type-C',
    asin: 'B0B7BK8ZRR',
    pr: 29,
    msrp: 39,
    r: 4.2,
    reviews: 2400,
    size: 5,
    resolution: '800x480',
    refresh: 60,
    connection: 'USB-C',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 300,
    ecosystem: 'AIDA64',
    img: 'https://m.media-amazon.com/images/I/61X2z83UJmL._AC_SL300_.jpg',
  },
  {
    b: 'EDIY',
    n: 'EDIY 3.5" IPS USB Mini Screen AIDA64 Type-C Sub Screen',
    asin: 'B09TTHZYSH',
    pr: 19,
    msrp: 29,
    r: 4.1,
    reviews: 1800,
    size: 3.5,
    resolution: '320x480',
    refresh: 60,
    connection: 'USB-C',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 250,
    ecosystem: 'AIDA64',
    img: 'https://m.media-amazon.com/images/I/61-EtwsZGuL._AC_SL300_.jpg',
  },

  // ─── ASHATA ────────────────────────────────────────────────────────────
  {
    b: 'ASHATA',
    n: 'ASHATA 5" USB Mini Screen AIDA64 CPU GPU Data Monitor Type-C',
    asin: 'B0C28D2W2B',
    pr: 25,
    msrp: 39,
    r: 4.1,
    reviews: 1200,
    size: 5,
    resolution: '800x480',
    refresh: 60,
    connection: 'USB-C',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 300,
    ecosystem: 'AIDA64',
    img: 'https://m.media-amazon.com/images/I/71tmYYhLYpL._AC_SL300_.jpg',
  },
  {
    b: 'ASHATA',
    n: 'ASHATA 7.9" IPS USB Mini Screen AIDA64 CPU Monitor Raspberry Pi',
    asin: 'B0BV1W1366',
    pr: 45,
    msrp: 59,
    r: 4.2,
    reviews: 680,
    size: 7.9,
    resolution: '1280x400',
    refresh: 60,
    connection: 'USB-C',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 300,
    ecosystem: 'AIDA64',
    img: 'https://m.media-amazon.com/images/I/71Qt6DdY1mL._AC_SL300_.jpg',
  },
  {
    b: 'ASHATA',
    n: 'ASHATA 3.5" PC Case Screen AIDA64 USB Type-C Sub Screen Black',
    asin: 'B0BTMMD9P4',
    pr: 19,
    msrp: 29,
    r: 4.1,
    reviews: 1500,
    size: 3.5,
    resolution: '320x480',
    refresh: 60,
    connection: 'USB-C',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 250,
    ecosystem: 'AIDA64',
    img: 'https://m.media-amazon.com/images/I/61L8YeLBI4L._AC_SL300_.jpg',
  },

  // ─── WOWNOVA ───────────────────────────────────────────────────────────
  {
    b: 'WOWNOVA',
    n: 'WOWNOVA PC Temperature Display ARGB Case IPS USB Mini Screen Black',
    asin: 'B0BXTHCWZC',
    pr: 35,
    msrp: 49,
    r: 4.3,
    reviews: 890,
    size: 3.5,
    resolution: '480x320',
    refresh: 60,
    connection: 'USB-C',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 300,
    ecosystem: 'Standalone',
    img: 'https://m.media-amazon.com/images/I/61Nj5YQ6qyL._AC_SL300_.jpg',
  },
  {
    b: 'WOWNOVA',
    n: 'WOWNOVA 5" Computer Temp Monitor ARGB PC Case Sensor Panel Type-C',
    asin: 'B0CMBD5F5Y',
    pr: 42,
    msrp: 59,
    r: 4.3,
    reviews: 520,
    size: 5,
    resolution: '800x480',
    refresh: 60,
    connection: 'USB-C',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 300,
    ecosystem: 'Standalone',
    img: 'https://m.media-amazon.com/images/I/61cZZbSTbgL._AC_SL300_.jpg',
  },
  {
    b: 'WOWNOVA',
    n: 'WOWNOVA English Version Computer Temp Monitor ARGB PC Display',
    asin: 'B0FDPV8N6K',
    pr: 39,
    msrp: 55,
    r: 4.2,
    reviews: 180,
    size: 3.5,
    resolution: '480x320',
    refresh: 60,
    connection: 'USB-C',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 300,
    ecosystem: 'Standalone',
    img: 'https://m.media-amazon.com/images/I/61G4H8kj93L._AC_SL300_.jpg',
  },

  // ─── RANSANX ───────────────────────────────────────────────────────────
  {
    b: 'Ransanx',
    n: 'Ransanx 3.5" IPS USB Mini Screen AIDA64 with Stand and Cable',
    asin: 'B0BRR2MWQY',
    pr: 22,
    msrp: 35,
    r: 4.2,
    reviews: 2100,
    size: 3.5,
    resolution: '480x320',
    refresh: 60,
    connection: 'USB-C',
    panelType: 'IPS',
    touch: false,
    mount: 'Desk Stand',
    brightness: 250,
    ecosystem: 'AIDA64',
    img: 'https://m.media-amazon.com/images/I/61Y-Q8OUYLL._AC_SL300_.jpg',
  },

  // ─── HOSYOND ───────────────────────────────────────────────────────────
  {
    b: 'Hosyond',
    n: 'Hosyond 5" USB-C Mini Monitor 1024x600 IPS Windows Laptop',
    asin: 'B0CG6PNR1T',
    pr: 49,
    msrp: 69,
    r: 4.3,
    reviews: 420,
    size: 5,
    resolution: '1024x600',
    refresh: 60,
    connection: 'USB-C',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 350,
    ecosystem: 'Standalone',
    img: 'https://m.media-amazon.com/images/I/61RRV7uLgDL._AC_SL300_.jpg',
  },

  // ─── 7" GENERIC HDMI ───────────────────────────────────────────────────
  {
    b: 'Generic',
    n: '7" HD LCD Display 1024x600 IPS 178° HDMI for AIDA64',
    asin: 'B083WJ2MX8',
    pr: 45,
    msrp: 59,
    r: 4.1,
    reviews: 890,
    size: 7,
    resolution: '1024x600',
    refresh: 60,
    connection: 'HDMI',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 300,
    ecosystem: 'AIDA64',
    img: 'https://m.media-amazon.com/images/I/61XUVa-9M5L._AC_SL300_.jpg',
  },

  // ─── GEEEKPI (TOUCH CAPABLE) ───────────────────────────────────────────
  {
    b: 'GeeekPi',
    n: 'GeeekPi 11.26" 1920x440 HDMI LCD Capacitive Touch Screen',
    asin: 'B0CP9VVJDS',
    pr: 139,
    msrp: 169,
    r: 4.4,
    reviews: 260,
    size: 11.26,
    resolution: '1920x440',
    refresh: 60,
    connection: 'HDMI',
    panelType: 'IPS',
    touch: true,
    mount: 'Universal',
    brightness: 400,
    ecosystem: 'Standalone',
    img: 'https://m.media-amazon.com/images/I/71RbBfUfwSL._AC_SL300_.jpg',
  },

  // ─── SUDOKOO / BZIZU / OKN AIO SCREENS ─────────────────────────────────
  {
    b: 'BZIZU',
    n: 'BZIZU 8.8" PC Mini Monitor IPS 1920x480 USB Type-C AIDA64 Display',
    asin: 'B0D1QX3TY1',
    pr: 55,
    msrp: 79,
    r: 4.2,
    reviews: 420,
    size: 8.8,
    resolution: '1920x480',
    refresh: 60,
    connection: 'USB-C',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 350,
    ecosystem: 'AIDA64',
    img: 'https://m.media-amazon.com/images/I/61BvqcNUc5L._AC_SL300_.jpg',
  },

  // ─── MNPCTECH (FAN MOUNT KITS) ─────────────────────────────────────────
  {
    b: 'Mnpctech',
    n: 'Mnpctech 5" HDMI LCD Display Kit with 120mm Fan Mount Bracket',
    asin: 'B0C3X4PY2K',
    pr: 89,
    msrp: 109,
    r: 4.3,
    reviews: 75,
    size: 5,
    resolution: '800x480',
    refresh: 60,
    connection: 'HDMI',
    panelType: 'IPS',
    touch: false,
    mount: '120mm Fan',
    brightness: 300,
    ecosystem: 'AIDA64',
    img: 'https://m.media-amazon.com/images/I/51TMDlVH7qL._AC_SL300_.jpg',
  },

  // ─── WAVESHARE (PI-COMPATIBLE) ─────────────────────────────────────────
  {
    b: 'Waveshare',
    n: 'Waveshare 7.9" Bar Type HDMI IPS LCD 400x1280 Raspberry Pi Compatible',
    asin: 'B0919DHY4J',
    pr: 79,
    msrp: 99,
    r: 4.3,
    reviews: 310,
    size: 7.9,
    resolution: '400x1280',
    refresh: 60,
    connection: 'HDMI',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 300,
    ecosystem: 'Standalone',
    img: 'https://m.media-amazon.com/images/I/61rMFl-bNUL._AC_SL300_.jpg',
  },

  // ─── FYSETC / MISC AFFORDABLE ──────────────────────────────────────────
  {
    b: 'Fysetc',
    n: 'Fysetc 3.5" IPS USB AIDA64 Sub Display with Metal Housing',
    asin: 'B0DBGR3S9R',
    pr: 26,
    msrp: 39,
    r: 4.1,
    reviews: 340,
    size: 3.5,
    resolution: '480x320',
    refresh: 60,
    connection: 'USB-C',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 250,
    ecosystem: 'AIDA64',
    img: 'https://m.media-amazon.com/images/I/61KFB2M7B5L._AC_SL300_.jpg',
  },

  // ─── TOUCHSCREEN 10.3" TRAVEL ──────────────────────────────────────────
  {
    b: 'wisecoco',
    n: 'wisecoco 10.3" Touchscreen 400cd/m² IPS 1920x720 HDMI USB-C Travel',
    asin: 'B0C73XTG6W',
    pr: 229,
    msrp: 299,
    r: 4.3,
    reviews: 280,
    size: 10.3,
    resolution: '1920x720',
    refresh: 60,
    connection: 'HDMI',
    panelType: 'IPS',
    touch: true,
    mount: 'Desk Stand',
    brightness: 400,
    ecosystem: 'Standalone',
    img: 'https://m.media-amazon.com/images/I/61wTg0o2rQL._AC_SL300_.jpg',
  },

  // ─── AISHICHEN 4.88" ULTRA COMPACT ─────────────────────────────────────
  {
    b: 'AISHICHEN',
    n: 'AISHICHEN 4.88" USB Mini Screen AIDA64 CPU GPU PC Temp Display',
    asin: 'B0D9MHMCPK',
    pr: 28,
    msrp: 39,
    r: 4.1,
    reviews: 280,
    size: 4.88,
    resolution: '720x720',
    refresh: 60,
    connection: 'USB-C',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 300,
    ecosystem: 'AIDA64',
    img: 'https://m.media-amazon.com/images/I/61dD3AtRMvL._AC_SL300_.jpg',
  },

  // ─── HIGHLOOP / JUNGLE LEOPARD WHITE VARIANT ───────────────────────────
  {
    b: 'Jungle Leopard',
    n: 'Jungle Leopard 8.8" LCD Screen 1920x480 IPS USB Type-C Black',
    asin: 'B0DBQFBZR8',
    pr: 49,
    msrp: 69,
    r: 4.3,
    reviews: 520,
    size: 8.8,
    resolution: '1920x480',
    refresh: 60,
    connection: 'USB-C',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 350,
    ecosystem: 'AIDA64',
    img: 'https://m.media-amazon.com/images/I/61L5ApxVmXL._AC_SL300_.jpg',
  },

  // ─── ASIAHORSE ─────────────────────────────────────────────────────────
  {
    b: 'AsiaHorse',
    n: 'AsiaHorse 7" IPS Color Screen PC Case AIDA64 HDMI with ARGB Frame',
    asin: 'B0DQK8R6YZ',
    pr: 69,
    msrp: 89,
    r: 4.3,
    reviews: 140,
    size: 7,
    resolution: '1024x600',
    refresh: 60,
    connection: 'HDMI',
    panelType: 'IPS',
    touch: false,
    mount: 'Universal',
    brightness: 300,
    ecosystem: 'AIDA64',
    img: 'https://m.media-amazon.com/images/I/61oU-c3J1UL._AC_SL300_.jpg',
  },
];

let nextId = Math.max(...parts.map(p => p.id || 0)) + 1;
const existingAsins = new Set(parts.filter(p => p.asin).map(p => p.asin));

let imported = 0;
for (const entry of CURATED) {
  if (existingAsins.has(entry.asin)) continue;
  const prod = {
    id: nextId++,
    n: entry.n,
    img: entry.img || '',
    c: CAT_KEY,
    b: entry.b,
    pr: entry.pr,
    msrp: entry.msrp,
    r: entry.r,
    reviews: entry.reviews,
    asin: entry.asin,
    size: entry.size,
    resolution: entry.resolution,
    refresh: entry.refresh,
    connection: entry.connection,
    panelType: entry.panelType,
    touch: entry.touch,
    mount: entry.mount,
    brightness: entry.brightness,
    ecosystem: entry.ecosystem,
    deals: {
      amazon: {
        price: entry.pr,
        url: `https://www.amazon.com/dp/${entry.asin}?tag=${AMAZON_TAG}`,
        inStock: true,
      },
    },
  };
  parts.push(prod);
  existingAsins.add(entry.asin);
  imported++;
}

console.log(`\n━━━ IMPORTED ${imported} INTERNAL DISPLAY PRODUCTS ━━━`);

// ═══════════════════════════════════════════════════════════════════════════
// FINAL COVERAGE
// ═══════════════════════════════════════════════════════════════════════════
const displays = parts.filter(p => p.c === CAT_KEY);
console.log(`\n━━━ COVERAGE (${displays.length} products) ━━━`);
for (const f of ['size', 'resolution', 'refresh', 'connection', 'panelType', 'touch', 'mount', 'brightness', 'ecosystem']) {
  const n = displays.filter(x => x[f] != null).length;
  console.log(`  ${f.padEnd(14)} ${n}/${displays.length}  (${Math.round(n / displays.length * 100)}%)`);
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
