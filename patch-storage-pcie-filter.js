#!/usr/bin/env node
/**
 * patch-storage-pcie-filter.js — adds pcie to Storage's filter list.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = './src/App.jsx';
let src = readFileSync(file, 'utf8');

// Find the Storage filters block and insert pcie after interface
const oldFilters = `filters:{storageType:{label:"Type",type:"check"},interface:{label:"Interface",type:"check"},cap:{label:"Capacity",type:"check"},ff:{label:"Form Factor",type:"check"},dram:{label:"DRAM Cache",type:"bool"}}`;
const newFilters = `filters:{storageType:{label:"Type",type:"check"},interface:{label:"Interface",type:"check"},pcie:{label:"PCIe Gen",type:"check"},cap:{label:"Capacity",type:"check"},ff:{label:"Form Factor",type:"check"},dram:{label:"DRAM Cache",type:"bool"}}`;

if (!src.includes(oldFilters)) {
  console.log('❌ Storage filters block not found. May already be patched.');
  process.exit(1);
}

src = src.replace(oldFilters, newFilters);
writeFileSync(file, src);
console.log('✓ Added pcie filter to Storage config');
