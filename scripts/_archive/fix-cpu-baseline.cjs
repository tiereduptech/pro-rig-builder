const fs = require('fs');
let s = fs.readFileSync('src/UpgradePage.jsx', 'utf8');
const originalHadCRLF = s.includes('\r\n');
s = s.replace(/\r\n/g, '\n');

// PART 1: Split CPU_BASELINE_BENCH into Intel + AMD objects
const startMarker = 'const CPU_BASELINE_BENCH = {';
const fnMarker = '\nfunction lookupCPUBaseline';
const startIdx = s.indexOf(startMarker);
const fnIdx = s.indexOf(fnMarker, startIdx);
if (startIdx < 0 || fnIdx < 0) { console.log('P1 ANCHOR MISS'); process.exit(1); }
const closeIdx = s.lastIndexOf('};', fnIdx);
const oldBlock = s.substring(startIdx, closeIdx + 2);

const newBlock = `const CPU_BASELINE_INTEL = {
  "6100": 8, "6300": 10, "6500": 13, "6600": 15, "6700": 18, "6700K": 19,
  "7100": 9, "7300": 11, "7400": 13, "7500": 15, "7600": 17, "7700": 19, "7700K": 21,
  "8100": 12, "8300": 14, "8400": 17, "8500": 19, "8600": 21, "8600K": 23, "8700": 25, "8700K": 27,
  "9100": 14, "9300": 16, "9400": 19, "9500": 21, "9600K": 24, "9700K": 28, "9900K": 32,
  "10100": 15, "10105": 15, "10300": 18, "10400": 22, "10500": 24, "10600K": 28, "10700K": 32, "10900K": 38,
  "11400": 24, "11600K": 30, "11700K": 36, "11900K": 42,
  "12100": 20, "12400": 28, "12600K": 39, "12700K": 49, "12900K": 59,
  "13400": 35, "13600K": 53, "13700K": 65, "13900K": 83,
  "14400": 36, "14600K": 78, "14700K": 74, "14900K": 83,
  "245K": 62, "245KF": 62, "265K": 70, "265KF": 70, "285K": 85,
};

const CPU_BASELINE_AMD = {
  "1600": 12, "1700": 14, "1800X": 16, "1600X": 13,
  "2600": 15, "2700": 18, "2700X": 20,
  "3600": 22, "3700X": 28, "3800X": 30, "3900X": 38, "3950X": 45,
  "5600": 28, "5600X": 31, "5700X": 36, "5800X": 39, "5800X3D": 72,
  "5900X": 48, "5950X": 56,
  "7600": 38, "7600X": 40, "7700": 48, "7700X": 51, "7800X3D": 70,
  "7900": 68, "7900X": 73, "7950X": 89, "7950X3D": 88,
  "9600X": 45, "9700X": 53, "9800X3D": 80, "9900X": 78, "9900X3D": 85,
};`;

s = s.replace(oldBlock, newBlock);
console.log('P1 OK: split CPU_BASELINE_BENCH into INTEL + AMD');

// PART 2: Update lookupCPUBaseline to accept brand and pick correct table
const oldFn = `function lookupCPUBaseline(model) {
  if (!model) return null;
  const m = model.toUpperCase();
  let bestKey = null;
  for (const key of Object.keys(CPU_BASELINE_BENCH)) {
    if ((m.startsWith(key) || m === key) && (!bestKey || key.length > bestKey.length)) bestKey = key;
  }
  return bestKey ? { bench: CPU_BASELINE_BENCH[bestKey], name: bestKey } : null;
}`;

const newFn = `function lookupCPUBaseline(model, brand) {
  if (!model) return null;
  const m = model.toUpperCase();
  const b = (brand || "").toUpperCase();
  const table = (b.includes("AMD") || b.includes("RYZEN")) ? CPU_BASELINE_AMD : CPU_BASELINE_INTEL;
  let bestKey = null;
  for (const key of Object.keys(table)) {
    if ((m.startsWith(key) || m === key) && (!bestKey || key.length > bestKey.length)) bestKey = key;
  }
  return bestKey ? { bench: table[bestKey], name: bestKey } : null;
}`;

if (!s.includes(oldFn)) { console.log('P2 ANCHOR MISS'); process.exit(1); }
s = s.replace(oldFn, newFn);
console.log('P2 OK: function now brand-aware');

// PART 3: Update caller to pass brand
const oldCall = 'const b = lookupCPUBaseline(cpu.model);';
const newCall = 'const b = lookupCPUBaseline(cpu.model, cpu.brand);';
if (!s.includes(oldCall)) { console.log('P3 ANCHOR MISS'); process.exit(1); }
s = s.replace(oldCall, newCall);
console.log('P3 OK: caller passes cpu.brand');

fs.writeFileSync('src/UpgradePage.jsx', s);
console.log('DONE');
