const fs = require('fs');
const p = 'enrich-from-dataforseo.cjs';
let s = fs.readFileSync(p, 'utf8');

// Fix flattenProductInfo to handle product_information_details_item type
const oldFlatten = `function flattenProductInfo(productInformation) {
  const flat = {};
  if (!productInformation) return flat;
  for (const section of Array.isArray(productInformation) ? productInformation : []) {
    if (section.body && typeof section.body === 'object' && !Array.isArray(section.body)) {
      for (const [k, v] of Object.entries(section.body)) {
        flat[k] = v;
      }
    }
  }
  return flat;
}`;

const newFlatten = `function flattenProductInfo(productInformation) {
  const flat = {};
  if (!productInformation) return flat;
  for (const section of Array.isArray(productInformation) ? productInformation : []) {
    // type "product_information_details_item" has body as key-value spec table
    if (section.type === 'product_information_details_item' && section.body && typeof section.body === 'object') {
      for (const [k, v] of Object.entries(section.body)) {
        flat[k] = v;
      }
    }
    // Also walk nested contents arrays
    if (Array.isArray(section.contents)) {
      for (const c of section.contents) {
        if (c.body && typeof c.body === 'object' && !Array.isArray(c.body)) {
          for (const [k, v] of Object.entries(c.body)) flat[k] = v;
        }
      }
    }
  }
  return flat;
}`;

if (!s.includes(oldFlatten)) { console.log('FATAL: old flatten not found'); process.exit(1); }
s = s.replace(oldFlatten, newFlatten);
console.log('✓ Updated flattenProductInfo');

// Update field maps with correct Amazon field names
const oldMaps = `const AMAZON_FIELD_MAPS = {
  Mouse: {
    sensor: ['Tracking Method', 'Sensor', 'Sensor Type', 'Sensor Technology', 'Mouse Sensor'],
    dpi: ['DPI', 'Maximum DPI', 'Sensor Resolution', 'Movement Resolution'],
    pollingRate: ['Polling Rate', 'Polling rate', 'Maximum Polling Rate'],
    weight: ['Item Weight', 'Weight', 'Product Weight'],
    mouseType: ['Connectivity', 'Connection Type', 'Connectivity Technology', 'Wireless Type'],
  },
  Keyboard: {
    switches: ['Key Switch Type', 'Switch Type', 'Switches', 'Key Type', 'Mechanical Switch'],
    layout: ['Form Factor', 'Layout', 'Number of Keys', 'Keyboard Type'],
    wireless: ['Connectivity', 'Connection Type', 'Wireless Type'],
    rgb: ['Backlight', 'Backlit', 'RGB', 'Lighting'],
  },
  Headset: {
    hsType: ['Connectivity', 'Connection Type', 'Wireless Type'],
    driver: ['Driver Size', 'Speaker Driver Size', 'Driver Diameter'],
    mic: ['Microphone', 'Microphone Type', 'Boom Microphone'],
    anc: ['Active Noise Cancellation', 'ANC', 'Noise Cancelling'],
  },
  Microphone: {
    micType: ['Connectivity', 'Connection Type', 'Connectivity Technology'],
    pattern: ['Polar Pattern', 'Pickup Pattern'],
    sampleRate: ['Sample Rate', 'Sampling Rate'],
  },
  Webcam: {
    resolution: ['Maximum Image Resolution', 'Resolution', 'Maximum Resolution', 'Video Capture Resolution'],
    fps: ['Maximum Frame Rate', 'Frame Rate'],
    autofocus: ['Autofocus', 'Auto Focus'],
  },
  MousePad: {
    surface: ['Material', 'Surface Material', 'Pad Material'],
    padSize: ['Size'],
  },
};`;

const newMaps = `const AMAZON_FIELD_MAPS = {
  Mouse: {
    sensor: ['Movement Detection', 'Sensor', 'Sensor Type', 'Tracking Method'],
    dpi: ['Mouse Maximum Sensitivity', 'Maximum DPI', 'DPI'],
    pollingRate: ['Polling Rate', 'Maximum Polling Rate'],
    weight: ['Item Weight', 'Weight', 'Product Weight'],
    mouseType: ['Connectivity Technology', 'Connectivity', 'Connection Type', 'Power Source'],
  },
  Keyboard: {
    switches: ['Key Switch Type', 'Switch Type', 'Keyboard Description', 'Mechanical Switch'],
    layout: ['Style', 'Form Factor', 'Number of Keys', 'Keyboard Type', 'Item Shape'],
    wireless: ['Connectivity Technology', 'Connectivity', 'Connection Type'],
    rgb: ['Light Color', 'Backlit', 'Backlight', 'Lighting', 'LED Color', 'Embellishment Feature'],
  },
  Headset: {
    hsType: ['Connectivity Technology', 'Connectivity', 'Connection Type'],
    driver: ['Driver Size', 'Speaker Driver Size', 'Driver Diameter', 'Speaker Description'],
    mic: ['Microphone', 'Microphone Form Factor', 'Microphone Type'],
    anc: ['Noise Control', 'Active Noise Cancellation', 'Noise Cancelling'],
  },
  Microphone: {
    micType: ['Connectivity Technology', 'Connectivity', 'Connector Type', 'Connection Type'],
    pattern: ['Polar Pattern', 'Pickup Pattern', 'Microphone Form Factor'],
    sampleRate: ['Sample Rate', 'Sampling Rate'],
  },
  Webcam: {
    resolution: ['Image Capture Speed', 'Maximum Image Resolution', 'Video Capture Resolution', 'Resolution'],
    fps: ['Maximum Frame Rate', 'Frame Rate'],
    autofocus: ['Special Feature', 'Image Capture Type', 'Autofocus'],
  },
  MousePad: {
    surface: ['Material', 'Surface Material', 'Specific Uses For Product'],
    padSize: ['Size', 'Item Dimensions L x W'],
  },
};`;

if (!s.includes(oldMaps)) { console.log('FATAL: old maps not found'); process.exit(1); }
s = s.replace(oldMaps, newMaps);
console.log('✓ Updated AMAZON_FIELD_MAPS');

fs.writeFileSync(p, s);
console.log('\nDone');
