const m = await import("file://" + process.cwd().replace(/\\/g, "/") + "/src/data/parts.js?t=" + Date.now());
const specs = await import("file://" + process.cwd().replace(/\\/g, "/") + "/src/data/product-specs.js?t=" + Date.now());
const parts = m.PARTS;

const cpuExisting = new Set();
for (const p of parts) {
  if (p.c !== "CPU") continue;
  const model = specs.extractCPUModel(p.n);
  if (model) cpuExisting.add(model);
}
const cpuMissing = Object.keys(specs.CPU_SPECS).filter(k => !cpuExisting.has(k));

const gpuExisting = new Set();
for (const p of parts) {
  if (p.c !== "GPU") continue;
  const model = specs.extractGPUModel(p.n);
  if (model) gpuExisting.add(model);
}
const gpuMissing = Object.keys(specs.GPU_SPECS).filter(k => !gpuExisting.has(k));

const moboChipsetsExisting = new Set();
for (const p of parts) {
  if (p.c !== "Motherboard") continue;
  if (p.chipset) moboChipsetsExisting.add(p.chipset);
}
const moboMissing = Object.keys(specs.MOBO_CHIPSET_SPECS).filter(k => !moboChipsetsExisting.has(k));

console.log("═══ GAP ANALYSIS ═══");
console.log(`\nCPU: ${cpuExisting.size}/${Object.keys(specs.CPU_SPECS).length} SKUs have representation`);
if (cpuMissing.length) {
  console.log(`Missing CPU models (${cpuMissing.length}):`);
  cpuMissing.forEach(m => console.log("  " + m));
}

console.log(`\nGPU: ${gpuExisting.size}/${Object.keys(specs.GPU_SPECS).length} models have representation`);
if (gpuMissing.length) {
  console.log(`Missing GPU models (${gpuMissing.length}):`);
  gpuMissing.forEach(m => console.log("  " + m));
}

console.log(`\nMobo: ${moboChipsetsExisting.size}/${Object.keys(specs.MOBO_CHIPSET_SPECS).length} chipsets have representation`);
if (moboMissing.length) {
  console.log(`Missing Mobo chipsets (${moboMissing.length}):`);
  moboMissing.forEach(m => console.log("  " + m));
}
