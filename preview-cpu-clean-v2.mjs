// Preview CPU name cleaner v2 — polished
import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now()).then(({PARTS: P}) => {

  function cleanCpuName(p) {
    if (!p || !p.n) return '';
    if (p.c !== 'CPU') return p.n;
    // Strip trademark/registered/copyright symbols
    const name = p.n.replace(/[\u2122\u00AE\u00A9]/g, ' ');

    let m;

    // ─── Intel Core Ultra (Arrow Lake) ───
    // Handles: "Core Ultra 5 245K", "Ultra5 225F", and the verbose
    // "Core Ultra 7 Desktop Processor 265F ..." / "Core Ultra 7 Processor 270K Plus"
    // Model is a 3-digit number with optional K/KF/F suffix. "Plus" is marketing — dropped.
    if (/\bCore\s*Ultra\b/i.test(name) || /\bUltra\s*[3579]\b/i.test(name)) {
      // tier digit (3/5/7/9) then later a 3-digit model
      const tier = name.match(/\bUltra\s*([3579])\b/i);
      const model = name.match(/\b(\d{3})\s*(KF|KS|K|F)?\b(?!\d)/);
      if (tier && model) {
        const suffix = model[2] ? model[2].toUpperCase() : '';
        return `Intel Core Ultra ${tier[1]} ${model[1]}${suffix}`;
      }
    }

    // ─── Intel Core i3/i5/i7/i9 ───
    if ((m = name.match(/\b(?:Core\s*)?i([3579])[- ]?(\d{4,5})([A-Z]{0,3})\b/i))) {
      const suffix = m[3] ? m[3].toUpperCase() : '';
      return `Intel Core i${m[1]}-${m[2]}${suffix}`;
    }

    // ─── AMD Ryzen Threadripper (check BEFORE plain Ryzen) ───
    // "Threadripper PRO 7995WX", "Threadripper 7970X", "Threadripper 9980X"
    if (/\bThreadripper\b/i.test(name)) {
      const pro = /Threadripper[\s\u2122]*PRO/i.test(name) ? ' PRO' : '';
      const tr = name.match(/\b(\d{4,5})\s*(WX|X)?\b/);
      if (tr) {
        const suffix = tr[2] ? tr[2].toUpperCase() : '';
        return `AMD Ryzen Threadripper${pro} ${tr[1]}${suffix}`;
      }
    }

    // ─── AMD Ryzen ───
    // "Ryzen 7 7800X3D", "Ryzen 5 5600GT", "Ryzen 9 9950X3D2 Dual Edition" → 9950X3D
    if ((m = name.match(/\bRyzen\s*([3579])\s*(\d{4})\s*(X3D|XT|GT|GE|G|X|F|E)?\b/i))) {
      const suffix = m[3] ? m[3].toUpperCase() : '';
      return `AMD Ryzen ${m[1]} ${m[2]}${suffix}`;
    }

    // ─── Intel Xeon ───
    // Many sub-brands. Normalize the common ones; fall back to original if too exotic.
    // W-series: "Xeon W-2255", "Xeon W9-3475X"
    if ((m = name.match(/\bXeon\s*(W\d?-\d{3,4}[A-Z]{0,2})\b/i))) {
      return `Intel Xeon ${m[1].toUpperCase()}`;
    }
    // E5/E3/E7: "Xeon E5-2697 v3", "E5-2680v4", "E5-2699V4" (V attached, no space).
    // "Xeon" word is optional — some listings only have the bare E-code.
    // Model is strictly 4 digits; an optional v/V + digit is the version.
    if ((m = name.match(/\b(E[357])-(\d{4})\s*[vV](\d)\b/))) {
      return `Intel Xeon ${m[1].toUpperCase()}-${m[2]} v${m[3]}`;
    }
    if ((m = name.match(/\b(E[357])-(\d{4})\b/))) {
      return `Intel Xeon ${m[1].toUpperCase()}-${m[2]}`;
    }
    // Scalable: "Xeon Platinum 8160", "Xeon Gold 6330"
    if ((m = name.match(/\bXeon\s*(Platinum|Gold|Silver|Bronze)\s*(\d{4}[A-Z]?)\b/i))) {
      const tier = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
      return `Intel Xeon ${tier} ${m[2].toUpperCase()}`;
    }
    // Bare X-series legacy: "Xeon X5675"
    if ((m = name.match(/\bXeon\s*(X\d{3,4})\b/i))) {
      return `Intel Xeon ${m[1].toUpperCase()}`;
    }

    // ─── Intel Pentium ───
    // "Pentium Gold G-6400" → G6400 (strip stray hyphen). "Pentium G4400", "Pentium 4 3.0GHz"
    if (/\bPentium\b/i.test(name)) {
      const gold = /Pentium\s*Gold/i.test(name) ? ' Gold' : '';
      const gm = name.match(/\bG-?(\d{3,4}[A-Z]?)\b/i);
      if (gm) return `Intel Pentium${gold} G${gm[1].toUpperCase()}`;
      const em = name.match(/\bE(\d{4})\b/);
      if (em) return `Intel Pentium E${em[1]}`;
    }

    // ─── Intel Celeron ───
    // "Celeron G4930", "Celeron G-5900" → G5900, "Celeron G1610"
    if (/\bCeleron\b/i.test(name)) {
      const gm = name.match(/\bG-?(\d{3,4}[A-Z]?)\b/i);
      if (gm) return `Intel Celeron G${gm[1].toUpperCase()}`;
    }

    // ─── AMD Athlon ───
    if ((m = name.match(/\bAthlon\s*(II\s*)?(X\d\s*)?(\d{3,4}[A-Z]{0,2})\b/i))) {
      const ii = m[1] ? 'II ' : '';
      const x = m[2] ? m[2].toUpperCase().replace(/\s+/g, '') + ' ' : '';
      return `AMD Athlon ${ii}${x}${m[3].toUpperCase()}`;
    }

    // Couldn't confidently parse — keep original
    return p.n;
  }

  const cpus = P.filter(p => p.c === 'CPU' && !p.bundle);

  // Show the previously-missed long names specifically
  console.log('═══ PREVIOUSLY-MISSED LONG NAMES ═══');
  const longOnes = cpus.filter(p => p.n.length > 45);
  longOnes.forEach(p => {
    const cleaned = cleanCpuName(p);
    const flag = cleaned === p.n ? ' ⚠STILL UNCHANGED' : '';
    console.log('BEFORE:', p.n.slice(0, 78));
    console.log('AFTER :', cleaned + flag);
    console.log('');
  });

  let cleaned = 0, kept = 0;
  cpus.forEach(p => { cleanCpuName(p) === p.n ? kept++ : cleaned++; });
  console.log('═══════════════════════════════');
  console.log('Cleaned:', cleaned, '/ Kept as-is:', kept, '/ Total:', cpus.length);

  // What's STILL long and unchanged after polish
  const stillMissed = cpus.filter(p => cleanCpuName(p) === p.n && p.n.length > 35);
  console.log('\nStill long + unchanged (' + stillMissed.length + '):');
  stillMissed.forEach(p => console.log('  L' + p.n.length, '|', p.n.slice(0, 72)));
});
