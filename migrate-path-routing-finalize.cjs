// migrate-path-routing-finalize.cjs
// Updates the App's initial mount logic to use pathname instead of hash

const fs = require('fs');
const PATH = './src/App.jsx';
let s = fs.readFileSync(PATH, 'utf8');

const oldBlock = `    // Set initial state
    const rawHash = window.location.hash.replace("#","");
    const hash = rawHash.split("?")[0]; // strip query params for page matching
    // Strip sub-route for matching: "tools/fps-estimator" -> "tools"
    const baseHash = hash.split('/')[0];
    if (baseHash && ["home","search","builder","community","tools","upgrade","scanner","about","contact","privacy","terms","affiliate","compare","vs-pcpartpicker","pcpartpicker-alternative","best-pc-builder-tools"].includes(baseHash)) {
      setPageRaw(baseHash);
      window.history.replaceState({page:baseHash}, "", window.location.hash);
    } else {
      window.history.replaceState({page:"home"}, "", "#home");
    }`;

const newBlock = `    // Set initial state from pathname (primary) with hash fallback for legacy URLs
    const validPages = ["home","search","builder","community","tools","upgrade","scanner","about","contact","privacy","terms","affiliate","compare","vs-pcpartpicker","pcpartpicker-alternative","best-pc-builder-tools"];

    // Try pathname first
    const rawPath = (window.location.pathname || "/").replace(/^\\//,"");
    const pathBase = rawPath.split("?")[0].split("/")[0];

    if (pathBase && validPages.includes(pathBase)) {
      setPageRaw(pathBase);
      window.history.replaceState({page:pathBase}, "", "/" + pathBase);
    } else if (!pathBase) {
      // Root path "/"
      setPageRaw("home");
      window.history.replaceState({page:"home"}, "", "/");
    } else {
      // Try legacy hash fallback (e.g. someone bookmarked /#search)
      const rawHash = window.location.hash.replace("#","");
      const hashBase = rawHash.split("?")[0].split("/")[0];
      if (hashBase && validPages.includes(hashBase)) {
        setPageRaw(hashBase);
        // Migrate legacy hash URL to clean path URL
        window.history.replaceState({page:hashBase}, "", "/" + hashBase);
      } else {
        setPageRaw("home");
        window.history.replaceState({page:"home"}, "", "/");
      }
    }`;

if (s.includes(oldBlock)) {
  s = s.replace(oldBlock, newBlock);
  fs.writeFileSync(PATH, s);
  console.log('✓ App init block updated to use pathname');

  // Also need to update the migrate script's validPages to include the SEO landing pages
  // We have this in setPage init - check
  if (s.includes('"home","search","builder","community","tools","upgrade","scanner","about","contact","privacy","terms","affiliate","compare"];')) {
    s = s.replace(
      '"home","search","builder","community","tools","upgrade","scanner","about","contact","privacy","terms","affiliate","compare"];',
      '"home","search","builder","community","tools","upgrade","scanner","about","contact","privacy","terms","affiliate","compare","vs-pcpartpicker","pcpartpicker-alternative","best-pc-builder-tools"];'
    );
    fs.writeFileSync(PATH, s);
    console.log('✓ Page state init updated with SEO landing pages');
  }
} else {
  console.log('⚠ Old block not found - check if already migrated');
}
