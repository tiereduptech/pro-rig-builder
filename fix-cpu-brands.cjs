const fs = require('fs');

(async () => {
  const p = 'src/data/parts.js';
  let s = fs.readFileSync(p, 'utf8');

  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;

  const bad = parts.filter(x =>
    x.c === 'CPU' &&
    !x.bundle &&
    !x.needsReview &&
    !['Intel', 'AMD', 'intel', 'amd'].includes(x.b)
  );

  console.log('Found ' + bad.length + ' non-Intel/AMD CPUs to review:');
  bad.forEach(b => console.log('  ' + b.id + ' [' + b.b + '] ' + b.n.slice(0, 80)));

  let count = 0;
  for (const b of bad) {
    // Match both id:"abc" and id:'abc' and id:`abc`
    const markers = [
      'id:"' + b.id + '"',
      "id:'" + b.id + "'",
      'id:`' + b.id + '`'
    ];
    let idx = -1;
    for (const marker of markers) {
      idx = s.indexOf(marker);
      if (idx >= 0) break;
    }
    if (idx < 0) {
      console.log('  MISS: could not locate ' + b.id);
      continue;
    }
    // Inject needsReview:true,bundle:true right after the id field closing quote
    const afterId = s.indexOf(',', idx);
    if (afterId < 0) continue;
    s = s.substring(0, afterId) + ',needsReview:true,bundle:true' + s.substring(afterId);
    count++;
  }

  fs.writeFileSync(p, s);
  console.log('Patched ' + count + ' entries');
})();
