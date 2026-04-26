// migrate-to-path-routing.cjs
// Replaces #hash navigation with real path navigation in App.jsx
// SEO-safe — Google can index path URLs but not hash URLs

const fs = require('fs');
const PATH = './src/App.jsx';
let s = fs.readFileSync(PATH, 'utf8');

let changes = 0;

// 1. Main setPage function - replace #${p} with /${p}
const oldSetPage = `const setPage = (p, replaceCurrent) => {
    setPageRaw(p);
    if (replaceCurrent) {
      window.history.replaceState({page:p}, "", \`#\${p}\`);
    } else {
      window.history.pushState({page:p}, "", \`#\${p}\`);
    }
  };`;

const newSetPage = `const setPage = (p, replaceCurrent) => {
    setPageRaw(p);
    const url = p === "home" ? "/" : "/" + p;
    if (replaceCurrent) {
      window.history.replaceState({page:p}, "", url);
    } else {
      window.history.pushState({page:p}, "", url);
    }
  };`;

if (s.includes(oldSetPage)) {
  s = s.replace(oldSetPage, newSetPage);
  console.log('✓ Main setPage() updated');
  changes++;
} else {
  console.log('⚠ Main setPage() not found - search differently');
}

// 2. ToolsPage setTool: replaceState(null,'','#tools/'+slug) → /tools/+slug
const oldSetTool = `if(slug)window.history.replaceState(null,'','#tools/'+slug);`;
const newSetTool = `if(slug)window.history.replaceState(null,'','/tools/'+slug);`;
if (s.includes(oldSetTool)) {
  s = s.replace(oldSetTool, newSetTool);
  console.log('✓ ToolsPage setTool() updated');
  changes++;
}

// 3. ToolsPage init: read from pathname instead of hash
const oldToolInit = `const [tool,setToolRaw]=useState(()=>{
    const hash=(window.location.hash||'').replace(/^#/,'');
    const parts=hash.split('/');
    if(parts[0]==='tools'&&parts[1]&&TOOL_SLUG_TO_ID[parts[1]])return TOOL_SLUG_TO_ID[parts[1]];
    return 'fps';
  });`;

const newToolInit = `const [tool,setToolRaw]=useState(()=>{
    const path=(window.location.pathname||'').replace(/^\\//,'');
    const parts=path.split('/');
    if(parts[0]==='tools'&&parts[1]&&TOOL_SLUG_TO_ID[parts[1]])return TOOL_SLUG_TO_ID[parts[1]];
    // Fallback: also handle legacy #tools/x URLs
    const hash=(window.location.hash||'').replace(/^#/,'');
    const hashParts=hash.split('/');
    if(hashParts[0]==='tools'&&hashParts[1]&&TOOL_SLUG_TO_ID[hashParts[1]])return TOOL_SLUG_TO_ID[hashParts[1]];
    return 'fps';
  });`;

if (s.includes(oldToolInit)) {
  s = s.replace(oldToolInit, newToolInit);
  console.log('✓ ToolsPage init logic updated');
  changes++;
}

// 4. ToolsPage hashchange listener: switch to popstate + read from pathname
const oldToolHashListener = `React.useEffect(()=>{
    const handler=()=>{
      const hash=(window.location.hash||'').replace(/^#/,'');
      const parts=hash.split('/');
      if(parts[0]==='tools'&&parts[1]&&TOOL_SLUG_TO_ID[parts[1]]){
        setToolRaw(TOOL_SLUG_TO_ID[parts[1]]);
      }
    };
    window.addEventListener('hashchange',handler);
    return ()=>window.removeEventListener('hashchange',handler);
  },[]);`;

const newToolHashListener = `React.useEffect(()=>{
    const handler=()=>{
      const path=(window.location.pathname||'').replace(/^\\//,'');
      const parts=path.split('/');
      if(parts[0]==='tools'&&parts[1]&&TOOL_SLUG_TO_ID[parts[1]]){
        setToolRaw(TOOL_SLUG_TO_ID[parts[1]]);
      }
    };
    window.addEventListener('popstate',handler);
    return ()=>window.removeEventListener('popstate',handler);
  },[]);`;

if (s.includes(oldToolHashListener)) {
  s = s.replace(oldToolHashListener, newToolHashListener);
  console.log('✓ ToolsPage popstate listener updated');
  changes++;
}

// 5. App-level: read initial page from pathname
// Need to find any other location.hash references and migrate them
const remainingHashRefs = s.match(/window\.location\.hash|location\.hash/g) || [];
console.log('\nRemaining location.hash references in code: ' + remainingHashRefs.length);
if (remainingHashRefs.length > 0) {
  console.log('  (Some may be legitimate, like in-page anchor scrolls. Review manually if needed.)');
}

// 6. Add init: parse pathname on App mount to set initial page
// Find the useEffect for popstate in App and ensure it reads from pathname too
// Look for: const onPop = (e) => { const state = e.state; if (state && state.page) {
const oldPopHandler = /const onPop\s*=\s*\(e\)\s*=>\s*\{\s*const state\s*=\s*e\.state;\s*if\s*\(state\s*&&\s*state\.page\)\s*\{\s*setPageRaw\(state\.page\);/;

if (oldPopHandler.test(s)) {
  // Replace with version that falls back to pathname
  s = s.replace(oldPopHandler,
    `const onPop = (e) => {
      const state = e.state;
      const pathPage = (window.location.pathname || "/").replace(/^\\//, "").split("/")[0] || "home";
      if (state && state.page) {
        setPageRaw(state.page);`);
  console.log('✓ popstate handler updated to also read pathname');
  changes++;
}

// 7. CRITICAL: Initial page detection on mount
// Find: const [page,setPageRaw]=useState("home")
// Change to: read from pathname
const oldPageInit = `const [page,setPageRaw]=useState("home");`;
const newPageInit = `const [page,setPageRaw]=useState(()=>{
    if(typeof window==='undefined')return"home";
    const path=(window.location.pathname||"/").replace(/^\\//,"").split("/")[0];
    if(!path)return"home";
    // Validate against known pages
    const validPages=["home","search","builder","community","tools","upgrade","scanner","about","contact","privacy","terms","affiliate","compare"];
    if(validPages.includes(path))return path;
    // Also handle legacy hash routes
    const hash=(window.location.hash||"").replace(/^#/,"").split("/")[0];
    if(validPages.includes(hash))return hash;
    return"home";
  });`;

if (s.includes(oldPageInit)) {
  s = s.replace(oldPageInit, newPageInit);
  console.log('✓ Initial page state reads from pathname');
  changes++;
}

fs.writeFileSync(PATH, s);
console.log('\n✓ Total changes: ' + changes);
console.log('\nNext steps:');
console.log('  1. Add Railway/server rewrite to serve index.html for all paths');
console.log('  2. Update sitemap.xml with new path-based URLs');
console.log('  3. npm run build && test');
