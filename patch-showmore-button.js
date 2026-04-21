#!/usr/bin/env node
/**
 * patch-showmore-button.js — patch the +N more span and the slicing.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const path = './src/App.jsx';
let src = readFileSync(path, 'utf8');

// --- Patch 1: replace static span with button ---
const oldSpan = `{opts.length>20&&<span style={{fontFamily:"var(--mono)",fontSize:8,color:"var(--dim)"}}>+{opts.length-20} more</span>}`;
const newButton = `{opts.length>20&&<button onClick={()=>setShowAll(s=>({...s,[field]:!s[field]}))} style={{background:'none',border:'none',padding:'4px 0',cursor:'pointer',fontFamily:'var(--mono)',fontSize:9,color:'var(--sky)',textAlign:'left',width:'100%'}}>{showAll[field]?'- show less':'+ '+(opts.length-20)+' more'}</button>}`;

if (src.includes(oldSpan)) {
  src = src.replace(oldSpan, newButton);
  console.log('✓ Replaced static span with interactive button');
} else if (src.includes('setShowAll(s=>')) {
  console.log('– Button already patched');
} else {
  console.error('✗ Neither old span nor new button found. Aborting.');
  process.exit(1);
}

// --- Patch 2: slice based on showAll ---
const oldSlice = `{opts.slice(0,20).map(v=><Chk`;
const newSlice = `{(showAll[field]?opts:opts.slice(0,20)).map(v=><Chk`;

if (src.includes(oldSlice)) {
  src = src.replace(oldSlice, newSlice);
  console.log('✓ Updated slice to respect showAll state');
} else if (src.includes('showAll[field]?opts:opts.slice')) {
  console.log('– Slice already patched');
} else {
  console.error('✗ Slice pattern not found.');
  process.exit(1);
}

writeFileSync(path, src);
console.log('\nDone.');
