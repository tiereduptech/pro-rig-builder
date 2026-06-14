const fs = require("fs");
let s = fs.readFileSync("src/App.jsx", "utf8");

function one(oldStr, newStr) {
  const n = s.split(oldStr).length - 1;
  if (n !== 1) { console.error(`ABORT (need 1, got ${n}): ${oldStr.slice(0,55)}`); process.exit(1); }
  s = s.replace(oldStr, newStr);
  console.log(`ok: ${oldStr.slice(0,40)}`);
}

// Re-add SL labels: boost (per-card/OC clock) + type
one(',tier:"Suggested Use"', ',boost:"Boost (OC)",type:"Type",tier:"Suggested Use"');

// Spec grid: drop boost row only when it equals boostClock (redundant on reference cards)
one(
  '.filter(([k])=>!["id","n","c","b","pr","r","cp","off","deals","msrp","url","img","bench","condition","generation","chipset"].includes(k)&&p[k]!=null&&typeof p[k]!=="object")',
  '.filter(([k])=>!["id","n","c","b","pr","r","cp","off","deals","msrp","url","img","bench","condition","generation","chipset"].includes(k)&&!(k==="boost"&&p.boostClock!=null&&p.boost===p.boostClock)&&p[k]!=null&&typeof p[k]!=="object")'
);

fs.writeFileSync("src/App.jsx", s);
console.log("done");
