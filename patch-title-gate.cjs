const fs = require('fs');
const path = 'prerender.cjs';
let lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
const find = (s, from=0) => { for (let i=from;i<lines.length;i++) if (lines[i].includes(s)) return i; return -1; };

// Replace the title readiness check so it is ROUTE-AWARE, mirroring the canonical
// check. On non-home routes, the title must NOT still be the generic home-page
// title (the react-helmet race left the home fallback in <title> while OG/canonical
// had already updated). This forces the snapshot to wait for helmet to finish.
const titleLine = find('const titleOk = document.title && document.title.length > 5;');
if (titleLine === -1) { console.log("TITLE ANCHOR MISSING"); process.exit(1); }
lines[titleLine] =
'      const _t = document.title || "";\n' +
'      const _p = location.pathname || "/";\n' +
'      // Generic home/site title fallbacks that must NOT appear on a sub-route.\n' +
'      const HOME_TITLE_RE = /Compare, Build & Save on PC Parts|Free PC Part Picker & Hardware Scanner/i;\n' +
'      const titleOk = _t.length > 5 && (_p === "/" || !HOME_TITLE_RE.test(_t));';

fs.writeFileSync(path, Buffer.from(new (require('util').TextEncoder)().encode(lines.join('\r\n'))));
console.log("OK \u2014 prerender title gate is now route-aware (waits for non-home title before snapshot).");
