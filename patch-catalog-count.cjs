const fs = require("fs");

function patch(file, edits) {
  let s = fs.readFileSync(file, "utf8");
  for (const [oldStr, newStr] of edits) {
    const n = s.split(oldStr).length - 1;
    if (n !== 1) { console.error(`ABORT ${file}: "${oldStr.slice(0,40)}..." found ${n}x (need 1)`); process.exit(1); }
    s = s.replace(oldStr, newStr);
  }
  fs.writeFileSync(file, s);
  console.log(`patched ${file}`);
}

patch("src/PageMeta.jsx", [
  ["Build your PC with 5,290+ verified parts.", "Build your PC with 5,500+ verified parts."],
  ["Search and compare 5,290+ PC parts", "Search and compare 5,500+ PC parts"],
]);

patch("src/App.jsx", [
  ["over 3,400 verified PC components as of April 2026, updated continuously",
   "over 5,500 verified PC components, updated continuously"],
]);

console.log("done");
