(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + Date.now());
  const P = (m.PARTS || m.default).filter(p => !p.needsReview);
  const cpus = P.filter(p => p.c === "CPU" && !p.bundle);
  // does any field indicate integrated graphics?
  const fields = {};
  cpus.forEach(p => Object.keys(p).forEach(k => fields[k] = (fields[k]||0)+1));
  console.log("CPU fields:", Object.keys(fields).join(", "));
  console.log("\nSample CPUs - name + any igpu-ish field:");
  ["9950X","9600G","8500G","5600G","5600X","14600K","245K"].forEach(model => {
    const c = cpus.find(p => p.n.includes(model));
    if (c) console.log(` ${model}: igpu=${c.igpu} | graphics=${c.graphics} | name="${c.n.slice(0,55)}"`);
  });
  // how many AMD non-G vs G chips, and do Intel non-F have igpu?
  const amdG = cpus.filter(p => /RYZEN.*\dG\b|\dG\s|G\s*$/i.test(p.n) && /AMD|RYZEN/i.test(p.n));
  console.log("\nAMD G-suffix (APU) count:", amdG.length);
})();
