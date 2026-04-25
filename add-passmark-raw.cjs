// Add raw PassMark scores (cpuMark, g3dMark) to each CPU/GPU in parts.js
// then implement a proper resolution-aware bottleneck calculator

const fs = require('fs');

// Load PassMark data
const cpuMarks = JSON.parse(fs.readFileSync('passmark-cpus.json', 'utf8'));
const gpuMarks = JSON.parse(fs.readFileSync('passmark-gpus.json', 'utf8'));

console.log('PassMark CPUs:', Object.keys(cpuMarks).length);
console.log('PassMark GPUs:', Object.keys(gpuMarks).length);

// Normalize a name for matching (lowercase, strip whitespace, remove common noise)
function normalizeName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/\bcpu\b/g, '')
    .replace(/\bprocessor\b/g, '')
    .replace(/\bgpu\b/g, '')
    .replace(/\bgraphics card\b/g, '')
    .replace(/\bdesktop\b/g, '')
    .replace(/\bunlocked\b/g, '')
    .replace(/[\(\)\[\],®™]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Find the best PassMark entry for a given product name
// Strategy: try exact match first, then strip extras and re-try
function findCpuMark(productName) {
  const norm = normalizeName(productName);
  // Exact match
  for (const [pmName, score] of Object.entries(cpuMarks)) {
    if (normalizeName(pmName) === norm) return score;
  }
  // Substring match - product contains pmName or vice versa
  // Find pm name with the most overlapping tokens
  const productTokens = new Set(norm.split(' ').filter(t => t.length > 1));
  let best = null, bestScore = 0;
  for (const [pmName, score] of Object.entries(cpuMarks)) {
    const pmNorm = normalizeName(pmName);
    const pmTokens = new Set(pmNorm.split(' ').filter(t => t.length > 1));
    let overlap = 0;
    for (const t of pmTokens) if (productTokens.has(t)) overlap++;
    // Require model number-looking tokens (have digit + letter) to match
    const modelTokens = [...pmTokens].filter(t => /\d/.test(t) && /[a-z]/i.test(t));
    const modelMatch = modelTokens.length === 0 || modelTokens.every(t => productTokens.has(t));
    if (!modelMatch) continue;
    // Score = overlap ratio
    const ratio = pmTokens.size ? overlap / pmTokens.size : 0;
    if (ratio > bestScore && ratio >= 0.6) {
      bestScore = ratio;
      best = score;
    }
  }
  return best;
}

function findGpuMark(productName) {
  const norm = normalizeName(productName);
  for (const [pmName, score] of Object.entries(gpuMarks)) {
    if (normalizeName(pmName) === norm) return score;
  }
  const productTokens = new Set(norm.split(' ').filter(t => t.length > 1));
  let best = null, bestScore = 0;
  for (const [pmName, score] of Object.entries(gpuMarks)) {
    const pmNorm = normalizeName(pmName);
    const pmTokens = new Set(pmNorm.split(' ').filter(t => t.length > 1));
    let overlap = 0;
    for (const t of pmTokens) if (productTokens.has(t)) overlap++;
    const modelTokens = [...pmTokens].filter(t => /\d{3,}/.test(t));
    const modelMatch = modelTokens.length === 0 || modelTokens.every(t => productTokens.has(t));
    if (!modelMatch) continue;
    const ratio = pmTokens.size ? overlap / pmTokens.size : 0;
    if (ratio > bestScore && ratio >= 0.6) {
      bestScore = ratio;
      best = score;
    }
  }
  return best;
}

// Patch parts.js: add cpuMark/g3dMark fields where matchable
let s = fs.readFileSync('src/data/parts.js', 'utf8');

// Load parts via dynamic import to find what to patch
(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;

  let cpuPatched = 0, cpuMissed = [];
  let gpuPatched = 0, gpuMissed = [];

  for (const p of parts) {
    if (p.c === 'CPU' && !p.bundle && !p.needsReview) {
      // Skip if cpuMark already present
      if (p.cpuMark) continue;
      const score = findCpuMark(p.n);
      if (score) {
        // Inject cpuMark field after the id line of THIS object
        const marker = `"id": ${p.id},`;
        const idx = s.indexOf(marker);
        if (idx < 0) continue;
        const lineEnd = s.indexOf('\n', idx);
        const insertion = `    "cpuMark": ${score},\n`;
        s = s.substring(0, lineEnd + 1) + insertion + s.substring(lineEnd + 1);
        cpuPatched++;
      } else {
        cpuMissed.push(p.n);
      }
    } else if (p.c === 'GPU' && !p.bundle && !p.needsReview) {
      if (p.g3dMark) continue;
      const score = findGpuMark(p.n);
      if (score) {
        const marker = `"id": ${p.id},`;
        const idx = s.indexOf(marker);
        if (idx < 0) continue;
        const lineEnd = s.indexOf('\n', idx);
        const insertion = `    "g3dMark": ${score},\n`;
        s = s.substring(0, lineEnd + 1) + insertion + s.substring(lineEnd + 1);
        gpuPatched++;
      } else {
        gpuMissed.push(p.n);
      }
    }
  }

  fs.writeFileSync('src/data/parts.js', s);

  console.log('\n=== PATCH RESULTS ===');
  console.log('CPUs patched: ' + cpuPatched);
  console.log('CPUs missed: ' + cpuMissed.length);
  if (cpuMissed.length > 0 && cpuMissed.length <= 20) {
    console.log('Missed CPU samples:');
    cpuMissed.slice(0, 20).forEach(n => console.log('  - ' + n));
  } else if (cpuMissed.length > 20) {
    console.log('First 10 missed CPUs:');
    cpuMissed.slice(0, 10).forEach(n => console.log('  - ' + n));
  }
  console.log('\nGPUs patched: ' + gpuPatched);
  console.log('GPUs missed: ' + gpuMissed.length);
  if (gpuMissed.length > 0 && gpuMissed.length <= 20) {
    console.log('Missed GPU samples:');
    gpuMissed.slice(0, 20).forEach(n => console.log('  - ' + n));
  } else if (gpuMissed.length > 20) {
    console.log('First 10 missed GPUs:');
    gpuMissed.slice(0, 10).forEach(n => console.log('  - ' + n));
  }
})();
