// enrich-accessory-specs.cjs
// Extracts spec fields from product names using regex patterns
// No API costs - pure data mining of existing names
// Updates parts.js in place

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;

  const stats = { Mouse: 0, Keyboard: 0, Headset: 0, Microphone: 0, Webcam: 0, MousePad: 0, ExtensionCables: 0 };
  const enrichments = {}; // id -> {fields}

  for (const p of parts) {
    if (!['Mouse','Keyboard','Headset','Microphone','Webcam','MousePad','ExtensionCables'].includes(p.c)) continue;
    const name = p.n || '';
    const lc = name.toLowerCase();
    const updates = {};

    // ============ MOUSE ============
    if (p.c === 'Mouse') {
      // Sensor: HERO, PixArt, PMW, focal, etc.
      let mSensor = name.match(/\b(HERO\s*\d+K?|PixArt\s*\w+|PMW\s*\d+|Focus\s*Pro|TrueMove|Razer\s*\d+|Owl-Eye|PAW\s*\d+)\b/i);
      if (mSensor) updates.sensor = mSensor[1].replace(/\s+/g, ' ').trim();
      else if (/\boptical\b/i.test(name)) updates.sensor = 'Optical';
      else if (/\blaser\b/i.test(name)) updates.sensor = 'Laser';
      // DPI
      let mDpi = name.match(/(\d{1,3}[,]?\d{3})\s*DPI/i);
      if (mDpi) updates.dpi = parseInt(mDpi[1].replace(/,/g, ''));
      // Weight (grams)
      let mWeight = name.match(/(\d{2,3})\s*(?:g\b|grams|gram)/i);
      if (mWeight && parseInt(mWeight[1]) > 30 && parseInt(mWeight[1]) < 200) updates.weight = parseInt(mWeight[1]);
      // Connectivity
      if (/wireless|2\.4\s*ghz|lightspeed|hyperspeed/i.test(name)) updates.mouseType = 'Wireless';
      else if (/wired|usb-?[abc]?\s*cable/i.test(name)) updates.mouseType = 'Wired';
    }

    // ============ KEYBOARD ============
    if (p.c === 'Keyboard') {
      // Switch type
      if (/(MX\s+)?(Cherry|Red|Blue|Brown|Yellow|Black|Silver|Speed|Silent|Clear)\s*(switch|switches)/i.test(name)) {
        const m = name.match(/(MX\s+)?(Cherry|Red|Blue|Brown|Yellow|Black|Silver|Speed|Silent|Clear)\s*(switch|switches)/i);
        updates.switches = m[2];
      } else if (/optical/i.test(name)) updates.switches = 'Optical';
      else if (/magnetic|hall\s*effect/i.test(name)) updates.switches = 'Hall Effect';
      else if (/mechanical/i.test(name)) updates.switches = 'Mechanical';
      else if (/membrane/i.test(name)) updates.switches = 'Membrane';
      // Layout
      if (/full[\s-]?size|104[\s-]?key|108[\s-]?key/i.test(name)) updates.layout = 'Full-Size';
      else if (/tkl|tenkeyless|87[\s-]?key/i.test(name)) updates.layout = 'TKL';
      else if (/75%|82[\s-]?key/i.test(name)) updates.layout = '75%';
      else if (/65%|68[\s-]?key/i.test(name)) updates.layout = '65%';
      else if (/60%|61[\s-]?key/i.test(name)) updates.layout = '60%';
      else if (/96%|100[\s-]?key/i.test(name)) updates.layout = '96%';
      // Wireless
      if (/wireless|bluetooth|2\.4\s*ghz/i.test(name)) updates.wireless = true;
      else if (/wired/i.test(name)) updates.wireless = false;
      // RGB
      if (/rgb|chroma|backlit|backlight/i.test(name)) updates.rgb = true;
    }

    // ============ HEADSET ============
    if (p.c === 'Headset') {
      // Connectivity
      if (/wireless|2\.4\s*ghz|bluetooth/i.test(name)) updates.hsType = 'Wireless';
      else if (/usb/i.test(name) && !/3\.5mm|aux/i.test(name)) updates.hsType = 'USB';
      else if (/wired|3\.5mm|aux/i.test(name)) updates.hsType = 'Wired';
      // Driver size
      let mDriver = name.match(/(\d{2,3})\s*mm\s*(driver|driver)/i);
      if (mDriver) updates.driver = parseInt(mDriver[1]) + 'mm';
      // Mic
      if (/mic|microphone|boom/i.test(name)) updates.mic = true;
      // ANC
      if (/anc\b|active\s*noise|noise\s*cancel/i.test(name)) updates.anc = true;
    }

    // ============ MICROPHONE ============
    if (p.c === 'Microphone') {
      // Type
      if (/usb-?c?\b/i.test(name) && !/usb cable/i.test(name)) updates.micType = 'USB';
      else if (/xlr/i.test(name)) updates.micType = 'XLR';
      // Polar pattern
      if (/cardioid/i.test(name)) updates.pattern = 'Cardioid';
      else if (/condenser/i.test(name)) updates.pattern = 'Condenser';
      else if (/dynamic/i.test(name)) updates.pattern = 'Dynamic';
      else if (/omnidirectional/i.test(name)) updates.pattern = 'Omnidirectional';
      else if (/multi-?pattern/i.test(name)) updates.pattern = 'Multi-Pattern';
      // Sample rate
      let mRate = name.match(/(\d{2,3})[\s-]*(kHz|bit)/i);
      if (mRate) updates.sampleRate = mRate[1] + (mRate[2].toLowerCase() === 'khz' ? 'kHz' : '-bit');
    }

    // ============ WEBCAM ============
    if (p.c === 'Webcam') {
      // Resolution
      if (/\b4k\b|2160p|3840.*2160/i.test(name)) updates.resolution = '4K';
      else if (/1440p|qhd|2k\b/i.test(name)) updates.resolution = '1440p';
      else if (/1080p|full\s*hd|fhd|1920.*1080/i.test(name)) updates.resolution = '1080p';
      else if (/720p|hd\b/i.test(name)) updates.resolution = '720p';
      // FPS
      let mFps = name.match(/(\d{2,3})\s*fps\b/i);
      if (mFps) updates.fps = parseInt(mFps[1]);
      // Autofocus
      if (/autofocus|auto\s*focus/i.test(name)) updates.autofocus = true;
      else if (/fixed\s*focus/i.test(name)) updates.autofocus = false;
    }

    // ============ MOUSE PAD ============
    if (p.c === 'MousePad') {
      // Surface
      if (/cloth|fabric/i.test(name)) updates.surface = 'Cloth';
      else if (/hard|aluminum|metal|glass|plastic\s*surface/i.test(name)) updates.surface = 'Hard';
      else if (/hybrid/i.test(name)) updates.surface = 'Hybrid';
      // Size: XXL, XL, L, M, S
      if (/\b3?xl\b|3xl|extended|gigantic|deskpad|desk\s*mat/i.test(name)) updates.padSize = 'XXL';
      else if (/\bxl\b|xlarge|extra\s*large/i.test(name)) updates.padSize = 'XL';
      else if (/\blarge\b|\blg\b/i.test(name)) updates.padSize = 'Large';
      else if (/\bmedium\b|\bmed\b/i.test(name)) updates.padSize = 'Medium';
      else if (/\bsmall\b|\bsm\b/i.test(name)) updates.padSize = 'Small';
    }

    // ============ EXTENSION CABLES ============
    if (p.c === 'ExtensionCables') {
      if (/pcie\s*riser/i.test(name)) updates.cableType = 'PCIe Riser';
      else if (/24[\s-]?pin/i.test(name)) updates.cableType = '24-pin ATX';
      else if (/eps\s*8|cpu\s*8[\s-]?pin/i.test(name)) updates.cableType = 'EPS/CPU 8-pin';
      else if (/12vhpwr|16[\s-]?pin/i.test(name)) updates.cableType = '12VHPWR';
      else if (/pcie\s*power|6.?\+?2/i.test(name)) updates.cableType = 'PCIe Power';
      else if (/sleeved|extension|kit/i.test(name)) updates.cableType = 'PSU Kit';
      // Length
      let mLen = name.match(/(\d{1,3})\s*(in|inch|cm|mm)/i);
      if (mLen) updates.cableLength = mLen[1] + mLen[2].toLowerCase();
    }

    if (Object.keys(updates).length > 0) {
      enrichments[p.id] = updates;
      stats[p.c]++;
    }
  }

  // Print stats
  console.log('═══ ENRICHMENT STATS ═══');
  for (const [cat, n] of Object.entries(stats)) {
    console.log('  ' + cat.padEnd(18) + ' ' + n + ' enriched');
  }
  console.log('  Total: ' + Object.keys(enrichments).length);

  // Save enrichment data for review
  fs.writeFileSync('catalog-build/_enrichments.json', JSON.stringify(enrichments, null, 2));
  console.log('\nWrote catalog-build/_enrichments.json');
  console.log('Run apply-enrichments.cjs to merge into parts.js');
})();
