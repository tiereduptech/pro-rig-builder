const fs = require('fs');
let s = fs.readFileSync('src/App.jsx', 'utf8');
s = s.replace(/\r\n/g, '\n');

// Increase mobile side padding from 12px to 16-20px for breathing room
const oldRule = `@media (max-width: 900px) {
  .home-main-grid {
    display: block !important;
    padding: 24px 12px !important;`;

const newRule = `@media (max-width: 900px) {
  .home-main-grid {
    display: block !important;
    padding: 24px 18px !important;`;

if (!s.includes(oldRule)) { console.log('ANCHOR MISS'); process.exit(1); }
s = s.replace(oldRule, newRule);
fs.writeFileSync('src/App.jsx', s);
console.log('DONE: mobile padding 12px -> 18px');
