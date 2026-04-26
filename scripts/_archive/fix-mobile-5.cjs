const fs = require('fs');
let s = fs.readFileSync('src/App.jsx', 'utf8');
s = s.replace(/\r\n/g, '\n');

const oldBlock = `/* === EXTRA SMALL (<=400px) === */
@media (max-width: 400px) {
  /* Footer 2-col -> 1-col */
  footer > div > div:first-child {
    grid-template-columns: 1fr !important;
  }

  /* Even smaller padding */
  [style*="padding: 40px 18px"] { padding: 28px 14px !important; }
}`;

const newBlock = `/* === EXTRA SMALL (<=400px) === */
@media (max-width: 400px) {
  /* Footer 2-col -> 1-col */
  footer > div > div:first-child {
    grid-template-columns: 1fr !important;
  }

  /* Even smaller padding */
  [style*="padding: 40px 18px"] { padding: 28px 14px !important; }
}

/* === MOBILE FIX 4: repeat(4,...) grids collapse to 2-col on mobile === */
@media (max-width: 640px) {
  [style*="repeat(4,1fr)"],
  [style*="repeat(4, 1fr)"] {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  }
  [style*="repeat(3,1fr)"],
  [style*="repeat(3, 1fr)"] {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  }
}
@media (max-width: 420px) {
  [style*="repeat(4,1fr)"],
  [style*="repeat(4, 1fr)"],
  [style*="repeat(3,1fr)"],
  [style*="repeat(3, 1fr)"] {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  }
}`;

if (!s.includes(oldBlock)) { console.log('ANCHOR MISS'); process.exit(1); }
s = s.replace(oldBlock, newBlock);
fs.writeFileSync('src/App.jsx', s);
console.log('DONE: repeat(4,1fr) and repeat(3,1fr) now collapse to 2-col on mobile');
