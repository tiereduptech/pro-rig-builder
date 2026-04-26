const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/\r\n/g, '\n');

let fixes = 0;

// Strip prior content if exists
if (s.includes('// === TOOL CONTENT ===')) {
  console.log('Stripping prior version');
  const start = s.indexOf('// === TOOL CONTENT ===');
  const end = s.indexOf('// === END TOOL CONTENT ===');
  if (start > 0 && end > start) {
    const endLine = s.indexOf('\n', end) + 1;
    s = s.substring(0, start) + s.substring(endLine);
  }
}

// =====================================================================
// 1. Add HOW-TO steps for each tool to TOOL_SEO_DATA
// =====================================================================
const howToReplacements = [
  // FPS - add howTo before the closing ]} of fps's faq
  {
    find: `{q:'Why is my GPU not in the list?',a:'We cover NVIDIA RTX 40/50, RTX 30/20 series, AMD RX 7000/9000/6000, Intel Arc A/B series. Older cards default to a closest-match baseline. Add a comment if you want yours added.'}
    ]
  },`,
    replace: `{q:'Why is my GPU not in the list?',a:'We cover NVIDIA RTX 40/50, RTX 30/20 series, AMD RX 7000/9000/6000, Intel Arc A/B series. Older cards default to a closest-match baseline. Add a comment if you want yours added.'}
    ],
    howTo: [
      'Pick your GPU from the dropdown - search by model like "RTX 4070 Ti" or "RX 9070 XT".',
      'Pick your CPU - search by name like "Ryzen 7 7800X3D" or "Intel Core i7-13700K".',
      'Choose your target resolution: 1080p, 1440p, or 4K.',
      'Select quality preset (Low/Medium/High/Ultra) - we estimate FPS for all four.',
      'Click "Estimate FPS" to see expected frame rates across 26 popular games.'
    ]
  },`
  },
  // BN - add howTo
  {
    find: `{q:'Should I always upgrade the bottleneck?',a:'Not always. A 5-10% bottleneck is normal and not worth fixing. Upgrade when the bottleneck is 15%+ AND you actually game at the affected resolution.'}
    ]
  },`,
    replace: `{q:'Should I always upgrade the bottleneck?',a:'Not always. A 5-10% bottleneck is normal and not worth fixing. Upgrade when the bottleneck is 15%+ AND you actually game at the affected resolution.'}
    ],
    howTo: [
      'Select your GPU from the dropdown.',
      'Select your CPU.',
      'Pick the resolution you actually play at (1080p stresses CPU more, 4K stresses GPU more).',
      'Click "Analyze Bottleneck" to see which component is holding back performance.',
      'Review the recommended upgrade path - we suggest the minimum upgrade to balance the build.'
    ]
  },`
  },
  // Will It Run
  {
    find: `{q:'Can I check older games?',a:'Most older AAA games run on virtually any modern PC. Our list focuses on demanding 2022-2026 titles where compatibility is the actual question.'}
    ]
  },`,
    replace: `{q:'Can I check older games?',a:'Most older AAA games run on virtually any modern PC. Our list focuses on demanding 2022-2026 titles where compatibility is the actual question.'}
    ],
    howTo: [
      'Pick the game you want to check from the dropdown.',
      'Select your GPU and CPU.',
      'Choose the resolution you want to play at.',
      'Click "Check Performance" to see expected FPS at Low, Medium, High, and Ultra.',
      'Look for the highest preset that gives you 60+ FPS for smooth gameplay.'
    ]
  },`
  },
  // BuildCmp
  {
    find: `{q:'Can I compare more than CPU + GPU?',a:'For now, we compare CPU + GPU since those drive 80%+ of gaming performance. RAM, storage, and PSU comparisons are on the roadmap.'}
    ]
  },`,
    replace: `{q:'Can I compare more than CPU + GPU?',a:'For now, we compare CPU + GPU since those drive 80%+ of gaming performance. RAM, storage, and PSU comparisons are on the roadmap.'}
    ],
    howTo: [
      'Select Build A: pick a CPU and GPU combination.',
      'Select Build B: pick a different CPU and GPU combination.',
      'Click "Compare Builds" to see side-by-side results.',
      'Review FPS estimates, total cost, and performance per dollar for both builds.',
      'Use the winner to inform your next purchase decision.'
    ]
  },`
  },
  // Wizard
  {
    find: `{q:'Can I customize the wizard build?',a:'Yes, after generation you can swap any component in the PC Builder. The wizard gives you a starting point; you keep full control.'}
    ]
  },`,
    replace: `{q:'Can I customize the wizard build?',a:'Yes, after generation you can swap any component in the PC Builder. The wizard gives you a starting point; you keep full control.'}
    ],
    howTo: [
      'Set your total budget using the slider ($300 to $8,000).',
      'Pick your target use case (gaming resolution, productivity, etc.).',
      'Click "Generate Build" - we pick balanced compatible components within your budget.',
      'Review the generated build with current pricing from Amazon, Best Buy, and others.',
      'Send the build to PC Builder if you want to swap any individual components.'
    ]
  },`
  },
  // Power
  {
    find: `{q:'Single rail vs multi rail PSU?',a:'For modern builds, single +12V rail is preferred. Multi-rail was useful before per-rail OCP, but single rail handles the high-power spikes of modern GPUs better.'}
    ]
  },`,
    replace: `{q:'Single rail vs multi rail PSU?',a:'For modern builds, single +12V rail is preferred. Multi-rail was useful before per-rail OCP, but single rail handles the high-power spikes of modern GPUs better.'}
    ],
    howTo: [
      'Add your CPU and GPU - the highest-draw components.',
      'Add storage drives, fans, RGB strips, and other peripherals.',
      'See total wattage with safety headroom (30% extra).',
      'Get a PSU wattage recommendation: 650W, 750W, 850W, 1000W, etc.',
      'Filter PSUs by wattage and 80+ rating to find a good match.'
    ]
  },`
  },
  // Cmp
  {
    find: `{q:'Can I compare across retailers?',a:'Yes, we show current pricing for each part across Amazon, Best Buy, Newegg, B&H, and Antonline. The lowest in-stock price wins.'}
    ]
  },`,
    replace: `{q:'Can I compare across retailers?',a:'Yes, we show current pricing for each part across Amazon, Best Buy, Newegg, B&H, and Antonline. The lowest in-stock price wins.'}
    ],
    howTo: [
      'Pick category: CPU, GPU, motherboard, RAM, storage, etc.',
      'Select Part A from the dropdown.',
      'Select Part B (must be same category).',
      'Click "Compare" to see all specs and prices side-by-side.',
      'Review benchmarks, current deals, and which retailer has the best in-stock price.'
    ]
  },`
  }
];

for (const {find, replace} of howToReplacements) {
  if (s.includes(find)) {
    s = s.replace(find, replace);
    fixes++;
  } else {
    console.log('  WARN: howTo anchor missing for one tool');
  }
}
console.log('✓ Added howTo arrays to ' + fixes + ' tools');

// =====================================================================
// 2. Add visible content section in ToolsPage render
// Inject after the H1+intro block but before the tabs nav
// =====================================================================
const oldTabsAnchor = `    <div style={{display:"flex",gap:6,marginBottom:20,flexWrap:"wrap"}}>{tabs.map(t=><button key={t.id} onClick={()=>setTool(t.id)}`;

const newAnchor = `    {/* === TOOL CONTENT === Tab navigation */}
    <div style={{display:"flex",gap:6,marginBottom:20,flexWrap:"wrap"}}>{tabs.map(t=><button key={t.id} onClick={()=>setTool(t.id)}`;

if (s.includes(oldTabsAnchor)) {
  s = s.replace(oldTabsAnchor, newAnchor);
  console.log('✓ Marked tab nav anchor');
}

// Now append "How to use" section AFTER tab nav and BEFORE the {tool==="fps"&&} blocks
// Find the closing of tab nav: }}>{t.l}</button>)}</div>
const oldAfterTabs = `}}>{t.l}</button>)}</div>

    {/* ═══ FPS ESTIMATOR ═══ */}`;

const newAfterTabs = `}}>{t.l}</button>)}</div>

    {/* === HOW-TO + FAQ CONTENT === */}
    {TOOL_SEO_DATA[tool]?.howTo&&<div style={{background:"var(--bg2)",border:"1px solid var(--bdr)",borderRadius:12,padding:"16px 20px",marginBottom:20}}>
      <h2 style={{fontFamily:"var(--ff)",fontSize:14,fontWeight:700,color:"var(--txt)",marginBottom:10}}>How to use the {TOOL_SEO_DATA[tool].h1}</h2>
      <ol style={{fontFamily:"var(--ff)",fontSize:13,color:"var(--txt)",lineHeight:1.7,paddingLeft:24,marginBottom:0}}>
        {TOOL_SEO_DATA[tool].howTo.map((step,i)=><li key={i} style={{marginBottom:4}}>{step}</li>)}
      </ol>
    </div>}

    {/* ═══ FPS ESTIMATOR ═══ */}`;

if (s.includes(oldAfterTabs)) {
  s = s.replace(oldAfterTabs, newAfterTabs);
  console.log('✓ Inserted How-To section after tab nav');
  fixes++;
} else {
  console.log('WARN: After-tab anchor missing');
}

// =====================================================================
// 3. Add visible FAQ section at the bottom of ToolsPage (after all tool blocks)
// Find: }</div>; at the end of ToolsPage function
// =====================================================================
// Looking for the closing of the {tool==="cmp"&&...} block and end of ToolsPage
// Strategy: find the last </div></div>; pattern in ToolsPage area and inject before
// Easier: find a unique closing marker

// Add FAQ section as part of the howTo block area for now - actually let's put it in its own section
// We need to find where ToolsPage's return content ends. Hard to anchor without more context.
// Skip the FAQ-visible-render for now since FAQ schema is already in <SEO>.
// Users get FAQ via "People also ask" Google rich results which is the SEO win.

fs.writeFileSync(p, s);
console.log('\nTotal fixes: ' + fixes);
console.log('Note: FAQ items are in schema (visible to Google) but not yet rendered as visible content.');
console.log('How-To steps are now visible above each tool UI.');
