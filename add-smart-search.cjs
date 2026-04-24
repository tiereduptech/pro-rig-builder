const fs = require('fs');

const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/\r\n/g, '\n');

// Strip any old version
if (s.includes('function smartMatch(')) {
  console.log('Old smartMatch present - stripping');
  const start = s.indexOf('/* === SMART SEARCH ===');
  const end = s.indexOf('/* === END SMART SEARCH ===');
  if (start > 0 && end > start) {
    const endLine = s.indexOf('\n', end) + 1;
    s = s.substring(0, start) + s.substring(endLine);
  }
}

// Helper function block
const helper = `/* === SMART SEARCH === */
// Build a search blob from a product: name, brand, and relevant spec fields
function buildSearchBlob(p) {
  const parts = [
    p.n || '',
    p.b || '',
    p.fullTitle || '',
    p.model || '',
    p.asin || '',
    p.mpn || '',
    // CPU specs
    p.socket || '', p.arch || '', p.memType || '',
    p.cores != null ? p.cores + 'core ' + p.cores + 'c' : '',
    p.threads != null ? p.threads + 'thread ' + p.threads + 't' : '',
    // GPU specs
    p.vram != null ? p.vram + 'gb' : '',
    // RAM specs
    p.cap != null ? p.cap + 'gb' : '',
    p.speed != null ? p.speed + 'mhz ' + p.speed : '',
    p.cl != null ? 'cl' + p.cl : '',
    p.sticks != null ? p.sticks + 'x ' + p.sticks + 'stick' : '',
    // Storage
    p.storageType || '', p.interface || '',
    p.ff || '',
    // Mobo
    p.chipset || '',
    // PSU
    p.watts != null ? p.watts + 'w ' + p.watts + 'watt' : '',
    p.eff || '',
    // Monitor
    p.res || '', p.refresh != null ? p.refresh + 'hz' : '',
    p.panel || '',
  ];
  return parts.join(' ').toLowerCase();
}

// Synonyms: query token -> alternate(s). Both directions.
const SEARCH_SYNONYMS = {
  'ram': 'memory',
  'memory': 'ram',
  'gpu': 'graphics card video',
  'graphics': 'gpu video',
  'video': 'gpu graphics',
  'cpu': 'processor',
  'processor': 'cpu',
  'mobo': 'motherboard',
  'motherboard': 'mobo',
  'psu': 'power supply',
  'ssd': 'solid state nvme',
  'hdd': 'hard drive',
  'mhz': 'mhz',
};

// Match a single token against the blob, with synonym fallback
function tokenMatches(token, blob) {
  if (blob.includes(token)) return true;
  const syn = SEARCH_SYNONYMS[token];
  if (syn) {
    for (const alt of syn.split(' ')) {
      if (blob.includes(alt)) return true;
    }
  }
  return false;
}

// Main smart match: returns true if all tokens in query match the product
function smartMatch(p, query) {
  if (!query) return true;
  const blob = buildSearchBlob(p);
  // Split query on whitespace, dashes, commas, slashes, parens
  const tokens = query.toLowerCase().split(/[\\s\\-,\\/\\(\\)]+/).filter(Boolean);
  if (tokens.length === 0) return true;
  // Every token must match somewhere
  return tokens.every(t => tokenMatches(t, blob));
}
/* === END SMART SEARCH === */

`;

// Insert before the BRAND RESOLVER block (which goes before CATEGORY GUIDES)
const insertBefore = '/* === BRAND RESOLVER ===';
const idx = s.indexOf(insertBefore);
if (idx < 0) { console.log('BRAND RESOLVER anchor not found'); process.exit(1); }
s = s.substring(0, idx) + helper + s.substring(idx);
console.log('✓ Inserted smartMatch helper');

// Now replace all the existing search filters to use smartMatch
// Pattern A: SearchPage / MobileSearchPage uses:
//   if(q)r=r.filter(p=>p.n.toLowerCase().includes(q.toLowerCase())||p.b.toLowerCase().includes(q.toLowerCase()));
const oldSearchA = 'if(q)r=r.filter(p=>p.n.toLowerCase().includes(q.toLowerCase())||p.b.toLowerCase().includes(q.toLowerCase()));';
const newSearchA = 'if(q)r=r.filter(p=>smartMatch(p,q));';
const cntA = (s.split(oldSearchA).length - 1);
if (cntA > 0) {
  while (s.includes(oldSearchA)) s = s.replace(oldSearchA, newSearchA);
  console.log(`✓ Updated ${cntA} SearchPage/MobileSearchPage search filter(s)`);
} else {
  console.log('WARN: Pattern A not found');
}

// Pattern B: BuilerPartPicker uses:
//   if(q&&!p.n.toLowerCase().includes(q.toLowerCase())&&!p.b.toLowerCase().includes(q.toLowerCase()))return false;
const oldSearchB = 'if(q&&!p.n.toLowerCase().includes(q.toLowerCase())&&!p.b.toLowerCase().includes(q.toLowerCase()))return false;';
const newSearchB = 'if(q&&!smartMatch(p,q))return false;';
const cntB = (s.split(oldSearchB).length - 1);
if (cntB > 0) {
  while (s.includes(oldSearchB)) s = s.replace(oldSearchB, newSearchB);
  console.log(`✓ Updated ${cntB} BuilerPartPicker search filter(s)`);
} else {
  console.log('WARN: Pattern B not found');
}

fs.writeFileSync(p, s);
console.log('\nDONE');
