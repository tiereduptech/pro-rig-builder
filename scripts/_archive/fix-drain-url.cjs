const fs = require('fs');
const p = 'drain-dfs-queue.cjs';
let s = fs.readFileSync(p, 'utf8');

const old = `await fetch(BASE + task.endpoint_advanced, { headers: { 'Authorization': AUTH } });`;
const neu = `await fetch('https://api.dataforseo.com' + task.endpoint_advanced, { headers: { 'Authorization': AUTH } });`;

if (!s.includes(old)) { console.log('FATAL: anchor not found'); process.exit(1); }
s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('✓ Fixed: now uses bare api.dataforseo.com (endpoint_advanced has /v3 prefix)');
