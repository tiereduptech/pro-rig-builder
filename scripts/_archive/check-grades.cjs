(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  const price = p => p.deals?.amazon?.price || p.deals?.bestbuy?.price || p.pr || 0;
  const grade = r => r>=28?'S':r>=20?'A':r>=14?'B':r>=8?'C':'D';
  for (const cat of ['Mouse','Keyboard','Headset','Microphone','Webcam','MousePad']) {
    const items = parts.filter(p => p.c === cat && p.bench);
    const grades = {};
    const top = [];
    for (const p of items) {
      const ratio = p.bench / Math.max(price(p)/100, 1);
      const g = grade(ratio);
      grades[g] = (grades[g] || 0) + 1;
      top.push({ name: p.n.substring(0,50), price: price(p), bench: p.bench, ratio: ratio.toFixed(1), grade: g });
    }
    console.log(cat.padEnd(12) + 'S:' + (grades.S||0) + ' A:' + (grades.A||0) + ' B:' + (grades.B||0) + ' C:' + (grades.C||0) + ' D:' + (grades.D||0));
    // Show top 3 best value
    top.sort((a,b) => parseFloat(b.ratio) - parseFloat(a.ratio));
    console.log('  Best value top 3:');
    top.slice(0,3).forEach(t => console.log('    ' + t.grade + ' ratio=' + t.ratio + ' bench=' + t.bench + ' $' + t.price + ' | ' + t.name));
  }
})();
