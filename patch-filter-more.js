#!/usr/bin/env node
/**
 * patch-filter-more.js — replace the non-interactive "+N more" span in
 * the filter panel with a working expand/collapse button, and wire up
 * the showAll state that drives it.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const path = './src/App.jsx';
let src = readFileSync(path, 'utf8');

// 1) Replace the static span with a button.
const oldSpan = `{opts.length>20&&<span style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)"}}>+{opts.length-20} more</span>}`;
const newButton = `{opts.length>20&&<button onClick={()=>setShowAll(s=>({...s,[field]:!s[field]}))} style={{background:'none',border:'none',padding:'4px 0',cursor:'pointer',fontFamily:'var(--mono)',fontSize:9,color:'var(--sky)',textAlign:'left',width:'100%'}}>{showAll[field]?'- show less':'+ '+(opts.length-20)+' more'}</button>}`;

if (!src.includes(oldSpan)) {
  console.error('✗ Could not find the static "+N more" span. Maybe already patched?');
  process.exit(1);
}
src = src.replace(oldSpan, newButton);
console.log('✓ Replaced "+N more" span with interactive button');

// 2) Change slice(0,20) to respect showAll state.
const oldSlice = `{opts.slice(0,20).map(v=><Chk`;
const newSlice = `{(showAll[field]?opts:opts.slice(0,20)).map(v=><Chk`;
if (!src.includes(oldSlice)) {
  console.error('✗ Could not find opts.slice(0,20).map');
  process.exit(1);
}
src = src.replace(oldSlice, newSlice);
console.log('✓ Updated slicing to respect showAll state');

// 3) Add showAll state to SearchPage component.
const oldState = `const [expanded,setExpanded]=useState(null);
  const sel=c`;
const newState = `const [expanded,setExpanded]=useState(null);
  const [showAll,setShowAll]=useState({});
  const sel=c`;
if (!src.includes(oldState)) {
  console.error('✗ Could not find the expanded state definition');
  process.exit(1);
}
src = src.replace(oldState, newState);
console.log('✓ Added showAll state to SearchPage');

writeFileSync(path, src);
console.log('\nDone. Run `npm run build` to verify.');
