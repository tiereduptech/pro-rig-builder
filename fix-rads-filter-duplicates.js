#!/usr/bin/env node
/**
 * fix-rads-filter-duplicates.js (CRLF-aware)
 */
import { readFileSync, writeFileSync } from 'node:fs';

const appPath = './src/App.jsx';
let app = readFileSync(appPath, 'utf8');

// Detect line ending
const NL = app.includes('\r\n') ? '\r\n' : '\n';
console.log(`Detected line ending: ${NL === '\r\n' ? 'CRLF' : 'LF'}`);

// ─── 1. Patch uv() — single line, no NL issue ─────────────────────────
const oldUv = 'const uv=(cat,f)=>[...new Set(P.filter(p=>p.c===cat&&p[f]!=null).map(p=>String(p[f])))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));';
const newUv = 'const uv=(cat,f,extract)=>{const items=P.filter(p=>p.c===cat&&p[f]!=null);const vals=extract?items.map(p=>extract(p)).filter(v=>v!=null&&v!==""):items.map(p=>String(p[f]));return [...new Set(vals)].sort((a,b)=>String(a).localeCompare(String(b),undefined,{numeric:true}));};';

if (app.includes(newUv)) {
  console.log('• uv() already patched');
} else if (app.includes(oldUv)) {
  app = app.replace(oldUv, newUv);
  console.log('✓ Patched uv()');
} else {
  console.error('✗ uv() not found in either old or new form');
  process.exit(1);
}

// ─── 2. Patch render block — build with NL aware ──────────────────────
const oldOpts = [
  'const opts=uv(cat,field);',
  '          if(!opts.length)return null;',
  '          return <FG key={field} label={cfg.label.toUpperCase()}>',
  '            {(showAll[field]?opts:opts.slice(0,20)).map(v=><Chk key={v} label={fmt(field,isNaN(v)?v:+v)} checked={(sf[field]||[]).includes(v)} onChange={()=>togSf(field,v)} count={catP.filter(p=>String(p[field])===v).length}/>)}'
].join(NL);

const newOpts = [
  'const opts=uv(cat,field,cfg.extract);',
  '          if(!opts.length)return null;',
  '          const matchVal=cfg.extract?(p,v)=>cfg.extract(p)===v:(p,v)=>String(p[field])===v;',
  '          const lbl=cfg.extract?(v)=>String(v):(v)=>fmt(field,isNaN(v)?v:+v);',
  '          return <FG key={field} label={cfg.label.toUpperCase()}>',
  '            {(showAll[field]?opts:opts.slice(0,20)).map(v=><Chk key={v} label={lbl(v)} checked={(sf[field]||[]).includes(v)} onChange={()=>togSf(field,v)} count={catP.filter(p=>matchVal(p,v)).length}/>)}'
].join(NL);

if (app.includes(newOpts)) {
  console.log('• render block already patched');
} else if (app.includes(oldOpts)) {
  app = app.replace(oldOpts, newOpts);
  console.log('✓ Patched render block to use cfg.extract');
} else {
  console.error('✗ Render block not found');
  process.exit(1);
}

// ─── 3. Diagnose: find where sf[field] is used to filter products ─────
console.log('\n--- Looking for product-filter code that uses sf ---');
const patterns = [
  'sf[k].includes(String(p[k]))',
  'sf[k].includes(p[k])',
  'sf[field].includes(',
  'Object.entries(sf)',
  'Object.keys(sf)',
];
for (const pat of patterns) {
  const i = app.indexOf(pat);
  if (i > 0) {
    console.log(`  Found "${pat}" at offset ${i}`);
    console.log('  Context: ' + app.slice(Math.max(0, i-100), i+200).replace(/\r?\n/g,' | '));
    console.log('');
  }
}

writeFileSync(appPath, app);
console.log('\nWrote App.jsx');
