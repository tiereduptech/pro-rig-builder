const fs = require('fs');
const s = fs.readFileSync('./src/App.jsx', 'utf8');
const idx = s.indexOf('cfg.type===\"check\"');
console.log('check filter at:', idx);
if (idx > 0) console.log(s.slice(Math.max(0,idx-200), idx+1500));
