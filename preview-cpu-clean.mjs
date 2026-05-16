// Preview CPU name cleaner — extraction-based
import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now()).then(({PARTS: P}) => {

  function cleanCpuName(p) {
    if (!p || !p.n) return '';
    if (p.c !== 'CPU') return p.n;
    // Strip trademark symbols
    const name = p.n.replace(/[\u2122\u00AE\u00A9]/g, '');

    let m;

    // ─── Intel Core Ultra (Arrow Lake): "Core Ultra 5 225F", "Ultra5 225F" ───
    if ((m = name.match(/\bCore\s*Ultra\s*([3579])\s*[- ]?\s*(\d{3})([A-Z]{0,2})\b/i))) {
      const suffix = m[3] ? m[3].toUpperCase() : '';
      return `Intel Core Ultra ${m[1]} ${m[2]}${suffix}`;
    }

    // ─── Intel Core i3/i5/i7/i9: "i9-14900K", "Core i5-12600KF" ───
    if ((m = name.match(/\b(?:Core\s*)?i([3579])[- ]?(\d{4,5})([A-Z]{0,3})\b/i))) {
      const suffix = m[3] ? m[3].toUpperCase() : '';
      return `Intel Core i${m[1]}-${m[2]}${suffix}`;
    }

    // ─── AMD Ryzen: "Ryzen 7 7800X3D", "Ryzen 5 5600" ───
    if ((m = name.match(/\bRyzen\s*([3579])\s*(\d{4})\s*(X3D|XT|GE|G|X|F|E)?\b/i))) {
      const suffix = m[3] ? m[3].toUpperCase() : '';
      return `AMD Ryzen ${m[1]} ${m[2]}${suffix}`;
    }

    // ─── AMD Threadripper: "Threadripper 9970X" ───
    if ((m = name.match(/\bThreadripper\s*(?:PRO\s*)?(\d{4,5})(WX|X)?\b/i))) {
      const pro = /PRO/i.test(name) ? ' PRO' : '';
      const suffix = m[2] ? m[2].toUpperCase() : '';
      return `AMD Ryzen Threadripper${pro} ${m[1]}${suffix}`;
    }

    // ─── Intel Xeon: "Xeon W-2255" ───
    if ((m = name.match(/\bXeon\s*([WERD]?-?\d{3,5}[A-Z]{0,2})\b/i))) {
      return `Intel Xeon ${m[1].toUpperCase()}`;
    }

    // ─── Intel Pentium / Celeron ───
    if ((m = name.match(/\bPentium\s*(?:Gold\s*)?([A-Z]?-?\d{3,4}[A-Z]?)\b/i))) {
      const gold = /Pentium\s*Gold/i.test(name) ? ' Gold' : '';
      return `Intel Pentium${gold} ${m[1].toUpperCase().replace(/^-/, '')}`;
    }
    if ((m = name.match(/\bCeleron\s*([A-Z]?-?\d{3,4}[A-Z]?)\b/i))) {
      return `Intel Celeron ${m[1].toUpperCase().replace(/^-/, '')}`;
    }

    // ─── AMD Athlon ───
    if ((m = name.match(/\bAthlon\s*(?:II\s*)?([A-Z0-9 ]{2,12}\d{3,4})\b/i))) {
      return `AMD Athlon ${m[1].trim()}`;
    }

    // Couldn't parse — keep original
    return p.n;
  }

  const cpus = P.filter(p => p.c === 'CPU' && !p.bundle);
  // Mix of long messy + short clean names
  const samples = cpus.filter(p => p.n.length > 40).slice(0, 30);
  samples.forEach(p => {
    console.log('BEFORE:', p.n.slice(0, 90));
    console.log('AFTER :', cleanCpuName(p));
    console.log('');
  });

  // Count how many would be cleaned vs kept-as-is
  let cleaned = 0, kept = 0;
  cpus.forEach(p => { cleanCpuName(p) === p.n ? kept++ : cleaned++; });
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Cleaned:', cleaned, ' / Kept as-is:', kept, ' / Total:', cpus.length);
});
