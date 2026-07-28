// detect-wrong-asin.cjs — same-domain wrong-ASIN / wrong-link detector.
//
// Category-mismatch (review text says a DIFFERENT category) only catches
// cross-category mis-attaches. Matchers operate WITHIN a category, so the more
// likely failure is a row linked to a DIFFERENT product in the SAME category
// (a DDR5-6000 kit linked to a DDR5-5200 kit; a 2TB SSD linked to the 1TB).
// This detector finds those using signals that work same-domain.
//
// SAFETY CHECK IS REUSED, NOT REIMPLEMENTED: token overlap + distinctive
// model-suffix come from ingest-msi-impact-v2.cjs (nameTokenOverlap/extractSuffix).
//
// Signals per (product, deal):
//   S1  low name<->linked-slug token overlap        (BB / Newegg — needs URL slug)
//   S2  model-suffix mismatch  (Z890-A vs Z890-S)   (BB / Newegg)
//   S3  capacity/spec disagreement row vs linked     (slug or review text)
//   S4  pr diverges >=3x from the deal's own price   (all retailers)
//   S5  review text describes a different product     (all retailers; incl. Amazon)
//
// READ-ONLY. Prints the hit list with confidence. Never remediates.

const fs = require('fs');
const path = require('path');
const { nameTokenOverlap, extractSuffix } = require('./ingest-msi-impact-v2.cjs');

const ROOT = __dirname;
const PARTS_DIR = path.join(ROOT, 'src/data/parts');
const RDIR = path.join(ROOT, 'public/reviews');
const CHUNKS = ['gpu','cpu','motherboard','storage','psu','case','cpu-cooler','case-fan','monitor','ram'];

const LOW_OVERLAP = 0.34;   // below this = likely a different product (hard)
const REVIEW_OVERLAP = 0.6; // for slugs present but not clearly a suffix issue

// ── slug extraction (mirrors audit-deal-links-v2.cjs) ──
function neweggSlug(url){ if(!url) return ''; let d=url; try{d=decodeURIComponent(url);}catch{} const m=d.match(/newegg\.com\/([^/]+)\/p\//i); return m?m[1]:''; }
function bestbuySlug(url){ if(!url) return ''; let d=url; try{d=decodeURIComponent(url);}catch{} const m=d.match(/bestbuy\.com\/(?:product|site)\/([^/]+)/i); return m?m[1]:''; }

// ── reviewSlug — faithful port of src/App.jsx reviewSlug() ──
function reviewSlug(p){
  const N=String(p.n||'').toUpperCase();
  const pats=[/\bRTX\s?\d{4}\s?(?:TI|SUPER)?\b/,/\bGTX\s?\d{3,4}\s?(?:TI|SUPER)?\b/,/\bRX\s?\d{3,4}\s?(?:XT|GRE)?\b/,/\bRYZEN\s?\d\s?\d{3,4}[A-Z0-9]*\b/,/\bCORE\s?(?:ULTRA\s?\d\s?)?I?\d?-?\d{3,5}[A-Z]*\b/,/\bI[3579]-\d{4,5}[A-Z]*\b/,/\b\d{4,5}X3D\b/];
  let tok=null; for(const re of pats){const m=N.match(re);if(m){tok=m[0].replace(/\s+/g,'');break;}}
  const safe=s=>String(s).toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,80).replace(/-$/,'');
  if(tok){const brand=String(p.b||'').toUpperCase().trim();return 'tok-'+safe(brand+'|'+(p.c||'')+'|'+tok);}
  let asin=p.asin?String(p.asin).toUpperCase():null;
  if(!asin){const u=p.deals&&p.deals.amazon&&p.deals.amazon.url;const m=u&&String(u).match(/\/dp\/([A-Z0-9]{10})/);if(m)asin=m[1].toUpperCase();}
  if(asin)return 'asin-'+asin.toLowerCase().replace(/[^a-z0-9]/g,'');
  const n=String(p.n||'').toLowerCase().replace(/\s+/g,' ').replace(/[^a-z0-9 ]/g,'').trim();
  return n?safe(n):'';
}
function reviewTexts(p){
  const f=path.join(RDIR, reviewSlug(p)+'.json');
  if(!fs.existsSync(f)) return [];
  try{ return (JSON.parse(fs.readFileSync(f,'utf8')).reviews||[]).map(r=>((r.title||'')+' '+(r.comment||'')).toLowerCase()); }catch{ return []; }
}

// ── capacity parsing (GB) ──
function capsInText(text){
  const out=[]; const re=/(\d+(?:\.\d+)?)\s*(tb|gb)\b/gi; let m;
  while((m=re.exec(text))){ let v=parseFloat(m[1]); if(/tb/i.test(m[2])) v*=1000; out.push(Math.round(v)); }
  return out;
}
// Same nominal capacity? Marketing vs raw differ within a class (240/250/256,
// 480/500/512, 960/1000/1024, 2000/2048). Treat within 15% as the SAME size so
// only a real class jump (500 vs 1000) counts as disagreement.
const sameCapClass = (a,b) => { const r=Math.max(a,b)/Math.min(a,b); return r<=1.15; };
// does the row's own capacity match ANY capacity stated in the linked source?
function capacityDisagrees(rowCap, sourceText){
  if(!(rowCap>0)) return null;
  const meaningful=capsInText(sourceText).filter(c=>c>=8); // ignore cache/lane numbers
  if(!meaningful.length) return null;
  if(meaningful.some(c=>sameCapClass(c,rowCap))) return false; // a stated cap matches → OK
  return { rowCap, stated:[...new Set(meaningful)].slice(0,4) };
}

// ── cross-domain review noun check (from the category-mismatch audit) ──
const STORAGE_N=/\b(ssd|nvme|the drive|this drive|boot drive|hard drive)\b/, RAM_N=/\b(these sticks|ram kit|\bdimm\b|xmp profile|cas latency)\b/, GPU_N=/\b(graphics card|video card|\bvram\b|ray tracing)\b/, MON_N=/\b(this monitor|refresh rate|viewing angle|ips panel)\b/;
const OWN_SIG={RAM:/\b(these sticks|ram kit|memory kit|\bdimm\b|xmp|expo|cas latency|\bmhz\b|dual channel)\b/,Storage:/\b(ssd|nvme|the drive|boot drive|read speed|nand)\b/,GPU:/\b(graphics card|video card|this card|\bvram\b|\bfps\b|ray tracing)\b/,CPU:/\b(this processor|the processor|this cpu|this chip|overclock|these cores)\b/,Monitor:/\b(this monitor|the monitor|this display|the screen|refresh rate|the panel)\b/};
const IMPOSSIBLE={RAM:[['Storage',STORAGE_N],['GPU',GPU_N],['Monitor',MON_N]],Storage:[['RAM',RAM_N],['GPU',GPU_N],['Monitor',MON_N]],GPU:[['Storage',STORAGE_N],['RAM',RAM_N]],CPU:[['Storage',STORAGE_N],['Monitor',MON_N]],Monitor:[['Storage',STORAGE_N],['RAM',RAM_N],['GPU',GPU_N]],Motherboard:[['Storage',STORAGE_N],['Monitor',MON_N]],PSU:[['Storage',STORAGE_N],['RAM',RAM_N],['Monitor',MON_N]],CPUCooler:[['Storage',STORAGE_N],['RAM',RAM_N],['GPU',GPU_N]],CaseFan:[['Storage',STORAGE_N],['RAM',RAM_N],['GPU',GPU_N],['Monitor',MON_N]],Case:[['Storage',STORAGE_N],['RAM',RAM_N]]};

const dealPrice = (d) => { const v=d&&(d.saleprice??d.price); return v>0?v:null; };
const capField = (r) => (r.c==='Storage'||r.c==='RAM'||r.c==='ExternalStorage') ? r.cap : (r.c==='PSU'? r.watts : null);

(async () => {
  let parts=[];
  for(const c of CHUNKS){ const arr=(await import('file:///'+PARTS_DIR.replace(/\\/g,'/')+'/'+c+'.js?t='+Date.now())).default||[]; parts=parts.concat(arr); }
  console.log(`Loaded ${parts.length} products from ${CHUNKS.length} chunks.\n`);

  const hits=[]; // {id,cat,retailer,signals:[],confidence,detail}
  const medium=[]; // low-overlap only

  for(const p of parts){
    const cat=p.c;
    const rTexts=reviewTexts(p);
    const rAll=rTexts.join(' • ');

    // S5 — cross-domain review mismatch (the #40034 class). ONLY for categories
    // that (a) have a reliable own-signal and (b) whose foreign nouns are truly
    // impossible. Motherboard/Case/PSU house drives, so "the drive/SSD" in their
    // reviews is legitimate — they are deliberately excluded here.
    let s5=null;
    if(rTexts.length && OWN_SIG[cat]){
      const own=rTexts.filter(t=>OWN_SIG[cat].test(t)).length;
      if(own===0){
        let best=null,bn=0; for(const [fc,re] of (IMPOSSIBLE[cat]||[])){const n=rTexts.filter(t=>re.test(t)).length; if(n>bn){bn=n;best=fc;}}
        if(best&&bn>=2) s5={foreign:best,n:bn,nr:rTexts.length};
      }
    }
    // NOTE: capacity-from-REVIEWS is intentionally NOT used — Amazon listings
    // aggregate reviews across capacity variants (a 1TB drive's page carries 2TB/
    // 4TB reviews), so it is structurally noisy. Capacity is checked against the
    // linked SLUG (the specific product) below. Verifying an Amazon deal's real
    // capacity needs the ASIN page (network) — out of scope for this read-only pass.

    for(const [retailer,d] of Object.entries(p.deals||{})){
      if(!d||typeof d!=='object') continue;
      const url=d.linkurl||d.url||'';
      const signals=[]; const detail={};

      // slug-based signals (BB / Newegg)
      let slug='';
      if(retailer.startsWith('newegg')) slug=neweggSlug(url);
      else if(retailer.startsWith('bestbuy')) slug=bestbuySlug(url);
      else if(d.name) slug=d.name; // rare: deal carries the linked product name

      // Guard: a real slug only. Best Buy links frequently resolve to a "-"
      // placeholder or an empty path; scoring a name against those is garbage
      // (mirrors audit-deal-links-v2's `slug && slug !== '-'` guard).
      if(slug==='-' || slug.length<5) slug='';

      if(slug){
        const ov=nameTokenOverlap(p.n, slug.replace(/[-_]+/g,' '));
        const ns=extractSuffix(p.n), ss=extractSuffix(slug);
        const suffixMis = ns && ss && ns!==ss;
        if(suffixMis){ signals.push('S2:suffix'); detail.suffix=`${ns}!=${ss}`; }
        if(ov<LOW_OVERLAP){ signals.push('S1:overlap<'+LOW_OVERLAP); detail.overlap=Number(ov.toFixed(2)); }
        else if(ov<REVIEW_OVERLAP){ detail.overlap=Number(ov.toFixed(2)); detail._medOnly=true; }
        // S3 slug capacity disagreement
        const capDis = capacityDisagrees(capField(p), slug.replace(/[-_]+/g,' '));
        if(capDis){ signals.push('S3:capacity'); detail.capacity=`row ${capDis.rowCap} vs slug ${capDis.stated.join('/')}`; }
      }

      // S4 — pr diverges >=3x from THIS deal's price
      const dp=dealPrice(d);
      if(p.pr>0 && dp){ const ratio=Math.max(dp,p.pr)/Math.min(dp,p.pr); if(ratio>=3){ signals.push('S4:pr'+ratio.toFixed(1)+'x'); detail.pr=`pr=${p.pr} vs ${retailer}=${dp}`; } }

      // attach retailer-agnostic S3rev / S5 to the deal that is likely the source:
      // amazon (reviews are ASIN-scoped) or the only deal.
      const isReviewSource = retailer==='amazon' || Object.keys(p.deals).length===1;
      if(isReviewSource && s5){ signals.push('S5:reviews-'+s5.foreign); detail.reviews=`${s5.n}/${s5.nr} reviews read as ${s5.foreign}`; }

      if(!signals.length){
        if(detail._medOnly){ medium.push({id:p.id,cat,retailer,overlap:detail.overlap,name:p.n.slice(0,48),slug:slug.slice(0,48)}); }
        continue;
      }
      // confidence: any hard signal => HIGH; only S1 low-overlap alone => MEDIUM-HIGH
      const hard = signals.some(s=>/^S2|^S3|^S4|^S5/.test(s));
      hits.push({ id:p.id, cat, retailer, signals, confidence: hard?'HIGH':'MED-HIGH', detail, name:p.n.slice(0,60), slug:slug.slice(0,60) });
    }
  }

  // ── report ──
  const order={HIGH:0,'MED-HIGH':1};
  hits.sort((a,b)=> (order[a.confidence]-order[b.confidence]) || (b.signals.length-a.signals.length));
  const byConf = c => hits.filter(h=>h.confidence===c);
  const bySignal={}; for(const h of hits) for(const s of h.signals){const k=s.split(':')[0];bySignal[k]=(bySignal[k]||0)+1;}
  const byCat={}; for(const h of hits){byCat[h.cat]=(byCat[h.cat]||0)+1;}

  console.log('══════════ SAME-DOMAIN WRONG-ASIN DETECTOR — HIT LIST ══════════');
  console.log(`Signals reused from ingest-msi-impact-v2.cjs (nameTokenOverlap, extractSuffix).`);
  console.log(`\nSignal legend: S1 token-overlap<${LOW_OVERLAP} | S2 suffix-mismatch | S3 capacity-disagree | S4 pr>=3x deal | S5 reviews-describe-other-product\n`);
  console.log(`Total flagged deals: ${hits.length}  (HIGH ${byConf('HIGH').length}, MED-HIGH ${byConf('MED-HIGH').length})`);
  console.log(`By signal: ${JSON.stringify(bySignal)}`);
  console.log(`By category: ${JSON.stringify(byCat)}`);
  console.log(`Plus ${medium.length} MEDIUM (slug overlap ${LOW_OVERLAP}-${REVIEW_OVERLAP}, no hard signal) — context only, not listed.\n`);

  console.log('───────────── HIGH confidence (hard same-domain signal) ─────────────');
  for(const h of byConf('HIGH')){
    console.log(`  #${h.id} [${h.cat}/${h.retailer}] ${h.signals.join(', ')}`);
    console.log(`     ${h.name}`);
    const bits=Object.entries(h.detail).filter(([k])=>!k.startsWith('_')).map(([k,v])=>`${k}: ${v}`);
    if(bits.length) console.log(`     ${bits.join(' | ')}`);
    if(h.slug) console.log(`     linked: ${h.slug}`);
  }
  const mh=byConf('MED-HIGH');
  console.log(`\n───────────── MED-HIGH (very low token overlap, no corroborating signal) : ${mh.length} ─────────────`);
  for(const h of mh.slice(0,25)){
    console.log(`  #${h.id} [${h.cat}/${h.retailer}] overlap=${h.detail.overlap} :: ${h.name}  <-> ${h.slug}`);
  }
  if(mh.length>25) console.log(`  ... and ${mh.length-25} more.`);

  console.log('\n=== READ-ONLY — no remediation performed. ===');
})().catch(e=>{ console.error('FATAL:',e); process.exit(1); });
