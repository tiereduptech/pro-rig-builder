// check-wifi-cat.cjs
(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;

  // Get all unique categories
  const cats = [...new Set(parts.map(p => p.c))].sort();
  console.log('All categories:');
  cats.forEach(c => {
    const count = parts.filter(p => p.c === c).length;
    console.log('  ' + c + ': ' + count);
  });

  console.log('\nProducts with wifi/wireless in name:');
  const wifi = parts.filter(p => /wifi|wireless adapter|wi-fi|802\.11/i.test(p.n || ''));
  wifi.slice(0, 30).forEach(p => console.log('  c=' + p.c + ' | ' + (p.n || '').substring(0, 65)));
})();
