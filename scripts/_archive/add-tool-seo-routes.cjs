const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/\r\n/g, '\n');

let fixes = 0;

// =====================================================================
// 1. Add TOOL_SEO + TOOL_URL_SLUGS config (right before ToolsPage function)
// =====================================================================
if (s.includes('// === TOOL SEO CONFIG ===')) {
  console.log('Stripping prior version');
  const start = s.indexOf('// === TOOL SEO CONFIG ===');
  const end = s.indexOf('// === END TOOL SEO CONFIG ===');
  if (start > 0 && end > start) {
    const endLine = s.indexOf('\n', end) + 1;
    s = s.substring(0, start) + s.substring(endLine);
  }
}

const seoConfig = `// === TOOL SEO CONFIG ===
const TOOL_URL_SLUGS = {
  fps: 'fps-estimator',
  bn: 'bottleneck-calculator',
  willitrun: 'will-it-run',
  buildcmp: 'compare-builds',
  wizard: 'build-wizard',
  power: 'power-calculator',
  cmp: 'compare-parts',
};
const TOOL_SLUG_TO_ID = Object.fromEntries(Object.entries(TOOL_URL_SLUGS).map(([id,slug])=>[slug,id]));
const TOOL_SEO_DATA = {
  fps: {
    title: 'FPS Estimator — See Game FPS for Your CPU + GPU at 1080p, 1440p, 4K',
    description: 'Free FPS estimator for PC builds. Pick your CPU and GPU to see expected FPS in popular games at 1080p, 1440p, and 4K. Covers Cyberpunk, Valorant, Fortnite, Elden Ring and more.',
    h1: 'FPS Estimator',
    intro: 'Estimate frames per second for any GPU + CPU combo across 26 popular games and three resolutions. Free, no signup.',
    faq: [
      {q:'How accurate is this FPS estimator?',a:'Our estimates are based on benchmark scores, PassMark CPU/GPU data, and resolution scaling. Real-world FPS can vary ±10-15% depending on settings, drivers, RAM speed, and game-specific optimization.'},
      {q:'Does CPU choice matter for FPS?',a:'Yes, especially at 1080p where CPU is the main bottleneck. At 4K the GPU does most of the work. We weight CPU impact differently per resolution to give realistic estimates.'},
      {q:'What games can I check?',a:'Cyberpunk 2077, Valorant, Fortnite, Elden Ring, CS2, Call of Duty, Apex Legends, Baldurs Gate 3, Starfield, Hogwarts Legacy, Spider-Man, and more — 26 games total covering esports and AAA titles.'},
      {q:'Why is my GPU not in the list?',a:'We cover NVIDIA RTX 40/50, RTX 30/20 series, AMD RX 7000/9000/6000, Intel Arc A/B series. Older cards default to a closest-match baseline. Add a comment if you want yours added.'}
    ]
  },
  bn: {
    title: 'Bottleneck Calculator — Find Your CPU or GPU Bottleneck (PassMark Data)',
    description: 'Free bottleneck calculator using real PassMark scores. Check whether your CPU or GPU is holding back performance at 1080p, 1440p, or 4K. Resolution-aware, accurate.',
    h1: 'Bottleneck Calculator',
    intro: 'Find out if your CPU or GPU is the weak link. Resolution-aware analysis using real PassMark benchmark data.',
    faq: [
      {q:'How is bottleneck calculated?',a:'We compare your CPU PassMark score to the score required to keep up with your GPU at the chosen resolution. 1080p needs a stronger CPU; 4K shifts most work to the GPU. The deficit is your bottleneck percentage.'},
      {q:'What is a balanced PC build?',a:'A build is balanced when both CPU and GPU are within ~10% of their ideal pairing for the resolution you play at. Our calculator reports "Balanced" when neither component holds back the other.'},
      {q:'Does resolution affect bottleneck?',a:'Yes, significantly. The same CPU + GPU pair can be CPU-bottlenecked at 1080p but balanced at 4K. We compute separate target scores for 1080p, 1440p, and 4K.'},
      {q:'Should I always upgrade the bottleneck?',a:'Not always. A 5-10% bottleneck is normal and not worth fixing. Upgrade when the bottleneck is 15%+ AND you actually game at the affected resolution.'}
    ]
  },
  willitrun: {
    title: 'Will It Run? — PC Game Compatibility Checker (Free)',
    description: 'Free game compatibility checker. Pick a game and your hardware to see if your PC can run it at Low, Medium, High, or Ultra. Covers 26 popular PC games.',
    h1: 'Will It Run?',
    intro: 'Check whether your PC can run any specific game at Low/Medium/High/Ultra settings before you buy.',
    faq: [
      {q:'How does the Will It Run checker work?',a:'Pick a game and your CPU + GPU. We estimate frame rates at every quality preset using benchmark data, so you can see if you hit 60+ FPS at your preferred settings.'},
      {q:'What FPS counts as playable?',a:'For most singleplayer games, 60 FPS is the sweet spot. Competitive shooters benefit from 120-144+ FPS. We highlight which presets reach those targets.'},
      {q:'Are the FPS results accurate?',a:'Estimates are within ±10-15% of real-world performance. Driver versions, OS, background apps, RAM speed, and storage type can all affect actual FPS.'},
      {q:'Can I check older games?',a:'Most older AAA games run on virtually any modern PC. Our list focuses on demanding 2022-2026 titles where compatibility is the actual question.'}
    ]
  },
  buildcmp: {
    title: 'Compare PC Builds — Side-by-Side Performance & Value Comparison',
    description: 'Compare two PC builds side-by-side. See expected FPS, total cost, performance per dollar, and bottlenecks for both. Free build comparison tool.',
    h1: 'Compare PC Builds',
    intro: 'Stack two builds against each other. See FPS, cost, and value-per-dollar for each.',
    faq: [
      {q:'How do I compare PC builds?',a:'Pick a CPU and GPU for Build A, then for Build B. We score each on FPS, total price, and performance per dollar so you can pick the better value.'},
      {q:'What is performance per dollar?',a:'It measures how much gaming performance you get for every dollar spent on CPU + GPU. Higher is better. Useful when deciding between similar-priced configurations.'},
      {q:'Can I compare more than CPU + GPU?',a:'For now, we compare CPU + GPU since those drive 80%+ of gaming performance. RAM, storage, and PSU comparisons are on the roadmap.'}
    ]
  },
  wizard: {
    title: 'PC Build Wizard — Auto-Generate a Balanced Build for Any Budget',
    description: 'Free PC build wizard. Enter your budget and use case — we auto-generate a balanced gaming PC build with current pricing from Amazon, Best Buy, and more.',
    h1: 'PC Build Wizard',
    intro: 'Tell us your budget and we will auto-generate a balanced PC build using live retailer pricing.',
    faq: [
      {q:'How does the build wizard work?',a:'Enter a budget and select your target resolution and use case. The wizard picks compatible components within your budget, prioritizing balance between CPU and GPU.'},
      {q:'What budget should I use?',a:'$700-1000 for 1080p gaming, $1200-1800 for 1440p, $2000+ for 4K. The wizard gives the best fit at any budget; quality scales with spend.'},
      {q:'Are the components compatible?',a:'Yes, the wizard validates CPU socket, RAM type (DDR4/DDR5), motherboard chipset, PSU wattage, and case form factor. Compatibility is checked end-to-end.'},
      {q:'Can I customize the wizard build?',a:'Yes, after generation you can swap any component in the PC Builder. The wizard gives you a starting point; you keep full control.'}
    ]
  },
  power: {
    title: 'PC Power Supply Calculator — Find the Right PSU Wattage',
    description: 'Free PSU calculator for PC builds. Add your CPU, GPU, and other components to see exact wattage needed. Get PSU wattage recommendations with headroom.',
    h1: 'PC Power Supply Calculator',
    intro: 'Calculate exact PSU wattage for your build. Includes headroom recommendations for safety and efficiency.',
    faq: [
      {q:'What PSU wattage do I need?',a:'Add up TDP of all components, then add 30% headroom for transient spikes and PSU efficiency. Most modern gaming PCs need 650-850W; high-end RTX 4090/5090 builds need 1000-1200W.'},
      {q:'What does 80+ rating mean?',a:'80+ rates PSU efficiency at typical load: Bronze 82%+, Gold 87%+, Platinum 90%+. Higher is better but costs more. Gold is the sweet spot for most builds.'},
      {q:'Do I need a bigger PSU for overclocking?',a:'Yes, add another 10-20% on top of the 30% headroom for overclocked CPU + GPU builds. Power draw can spike well above stock TDP.'},
      {q:'Single rail vs multi rail PSU?',a:'For modern builds, single +12V rail is preferred. Multi-rail was useful before per-rail OCP, but single rail handles the high-power spikes of modern GPUs better.'}
    ]
  },
  cmp: {
    title: 'Compare PC Parts — Side-by-Side CPU, GPU, and Component Comparison',
    description: 'Compare any two PC components side-by-side. See benchmarks, specs, prices, and current deals. Free parts comparison for CPUs, GPUs, motherboards, and more.',
    h1: 'Compare PC Parts',
    intro: 'Compare any two parts: CPU, GPU, motherboard, RAM, storage. Specs, benchmarks, and current pricing.',
    faq: [
      {q:'How do I compare two CPUs or GPUs?',a:'Pick any two parts of the same category. We display specs, benchmark scores, current pricing across retailers, and deals side-by-side.'},
      {q:'What benchmark do you use?',a:'PassMark for CPU and GPU performance. PassMark is one of the largest community-driven benchmark databases with consistent multi-year data across millions of systems.'},
      {q:'Can I compare across retailers?',a:'Yes, we show current pricing for each part across Amazon, Best Buy, Newegg, B&H, and Antonline. The lowest in-stock price wins.'}
    ]
  }
};
// === END TOOL SEO CONFIG ===
`;

// Insert before ToolsPage function
const anchorTools = 'function ToolsPage({th}){';
const toolsIdx = s.indexOf(anchorTools);
if (toolsIdx < 0) { console.log('FATAL: ToolsPage anchor missing'); process.exit(1); }
s = s.substring(0, toolsIdx) + seoConfig + '\n' + s.substring(toolsIdx);
console.log('✓ Inserted TOOL_SEO config');
fixes++;

// =====================================================================
// 2. Update ToolsPage to read URL hash on mount + sync on tool change
// Replace: const [tool,setTool]=useState("fps");
// With: read sub-route on mount, write to URL on change
// =====================================================================
const oldStateLine = `  const [tool,setTool]=useState("fps");`;
const newStateLine = `  // Read tool from URL hash on mount: #tools/fps-estimator -> "fps"
  const [tool,setToolRaw]=useState(()=>{
    const hash=(window.location.hash||'').replace(/^#/,'');
    const parts=hash.split('/');
    if(parts[0]==='tools'&&parts[1]&&TOOL_SLUG_TO_ID[parts[1]])return TOOL_SLUG_TO_ID[parts[1]];
    return 'fps';
  });
  // Wrapper: set state and update URL hash
  const setTool=React.useCallback((id)=>{
    setToolRaw(id);
    const slug=TOOL_URL_SLUGS[id];
    if(slug)window.history.replaceState(null,'','#tools/'+slug);
  },[]);
  // Listen for hash changes (e.g., browser back/forward)
  React.useEffect(()=>{
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

if (s.includes(oldStateLine)) {
  s = s.replace(oldStateLine, newStateLine);
  console.log('✓ ToolsPage: tool state synced with URL hash');
  fixes++;
} else {
  console.log('FATAL: tool state line missing');
  process.exit(1);
}

// =====================================================================
// 3. Inject <SEO> component at top of ToolsPage render
// Find the H1: <h2 ...>Smart Tools</h2> and inject SEO + dynamic intro before it
// =====================================================================
const oldHeading = `    <h2 style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--txt)",marginBottom:4}}>Smart Tools</h2>
    <p style={{fontFamily:"var(--ff)",fontSize:12,color:"var(--dim)",marginBottom:20}}>Estimate gaming performance, auto-generate builds, and compare parts.</p>`;

const newHeading = `    {(()=>{const seo=TOOL_SEO_DATA[tool];const slug=TOOL_URL_SLUGS[tool];if(!seo)return null;return <SEO key={tool} title={seo.title} description={seo.description} canonical={\`https://prorigbuilder.com/#tools/\${slug}\`} breadcrumb={[{name:'Home',url:'https://prorigbuilder.com/'},{name:'Smart Tools',url:'https://prorigbuilder.com/#tools'},{name:seo.h1,url:\`https://prorigbuilder.com/#tools/\${slug}\`}]} faq={seo.faq}/>;})()}
    <h1 style={{fontFamily:"var(--ff)",fontSize:22,fontWeight:800,color:"var(--txt)",marginBottom:4}}>{TOOL_SEO_DATA[tool]?.h1||'Smart Tools'}</h1>
    <p style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--dim)",marginBottom:20,maxWidth:720,lineHeight:1.5}}>{TOOL_SEO_DATA[tool]?.intro||'Estimate gaming performance, auto-generate builds, and compare parts.'}</p>`;

if (s.includes(oldHeading)) {
  s = s.replace(oldHeading, newHeading);
  console.log('✓ ToolsPage: dynamic SEO + H1 + intro per tool');
  fixes++;
} else {
  console.log('WARN: heading anchor missing');
}

// =====================================================================
// 4. Update main hash router to recognize tools/* sub-routes
// =====================================================================
const oldRouter = `    if (hash && ["home","search","builder","community","tools","upgrade","scanner","about","contact","privacy","terms","affiliate","compare","vs-pcpartpicker","pcpartpicker-alternative","best-pc-builder-tools"].includes(hash)) {
      setPageRaw(hash);
      window.history.replaceState({page:hash}, "", window.location.hash);`;

const newRouter = `    // Strip sub-route for matching: "tools/fps-estimator" -> "tools"
    const baseHash = hash.split('/')[0];
    if (baseHash && ["home","search","builder","community","tools","upgrade","scanner","about","contact","privacy","terms","affiliate","compare","vs-pcpartpicker","pcpartpicker-alternative","best-pc-builder-tools"].includes(baseHash)) {
      setPageRaw(baseHash);
      window.history.replaceState({page:baseHash}, "", window.location.hash);`;

if (s.includes(oldRouter)) {
  s = s.replace(oldRouter, newRouter);
  console.log('✓ Hash router: handles sub-routes (tools/fps-estimator)');
  fixes++;
} else {
  console.log('WARN: hash router anchor missing - may need manual fix');
}

fs.writeFileSync(p, s);
console.log('\nTotal fixes: ' + fixes);
console.log('\nNew SEO-friendly URLs:');
console.log('  /#tools/fps-estimator');
console.log('  /#tools/bottleneck-calculator');
console.log('  /#tools/will-it-run');
console.log('  /#tools/compare-builds');
console.log('  /#tools/build-wizard');
console.log('  /#tools/power-calculator');
console.log('  /#tools/compare-parts');
