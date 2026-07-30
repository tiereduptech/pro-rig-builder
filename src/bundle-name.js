// Bundle display helpers — combo pages (CPU + motherboard etc.) must show BOTH
// components AND the word "Bundle" in the H1, <title>, and JSON-LD name so they
// rank for "<cpu> <chipset> motherboard bundle" queries. These are called ONLY
// when p.bundle is true; the normal product path is untouched.
//
// The default product H1 uses cleanProductName(), which for a CPU/GPU-category row
// extracts just the chip model ("AMD Ryzen 9 7900X") — that would strip the second
// component off a combo. bundleH1() overrides that for bundles.

// Pull the CPU model and the motherboard (chipset + short model) out of a combo name.
function bundleComponents(name) {
  const n = String(name || '');
  const cpu = (n.match(
    /(?:Ryzen\s+(?:Threadripper\s+(?:PRO\s+)?)?[3579]\s+\d{3,4}[A-Z0-9]*|Core\s+Ultra\s+[3579]\s+\d{3}[A-Z]{0,2}|Core\s+i[3579][-\s]\d{4,5}[A-Z]{0,2}|\bi[3579]-\d{4,5}[A-Z]{0,2}\b)/i,
  ) || [''])[0].replace(/\s+/g, ' ').trim();
  let mobo = '';
  const m = n.match(/\b([BXZHA]\d{3}[A-Z]?)\b([A-Za-z0-9 \-]{0,24}?)\s*(?:Motherboard|Mobo)\b/i);
  if (m) mobo = (m[1] + ' ' + (m[2] || '')).replace(/\s+/g, ' ').trim();
  else { const cm = n.match(/\b([BXZHA]\d{3}[A-Z]?)\b/); if (cm) mobo = cm[1]; }
  return { cpu, mobo };
}

// H1 / browse-row name: full combo + "Bundle", no length cap.
export function bundleH1(p) {
  const { cpu, mobo } = bundleComponents(p && p.n);
  if (cpu && mobo) return `${cpu} + ${mobo} Motherboard Bundle`;
  const n = String((p && p.n) || '').trim();
  return /\b(bundle|combo)\b/i.test(n) ? n : `${n} Bundle`;
}

// <title> / og:title: both components + "Bundle", kept within 60 chars by
// dropping mobo model words (never the CPU or the chipset), then the boilerplate.
export function bundleTitle(p) {
  const { cpu, mobo } = bundleComponents(p && p.n);
  if (cpu && mobo) {
    let t = `${cpu} + ${mobo} Motherboard Bundle`;
    if (t.length <= 60) return t;
    t = `${cpu} + ${mobo} Bundle`;
    if (t.length <= 60) return t;
    const chip = (mobo.match(/[BXZHA]\d{3}[A-Z]?/) || [''])[0];
    return `${cpu} + ${chip} Bundle`;            // ~26 chars — always fits, keeps both + word
  }
  const n = String((p && p.n) || '').trim();
  const base = /\b(bundle|combo)\b/i.test(n) ? n : `${n} Bundle`;
  return base.length <= 60 ? base : `${base.slice(0, 52).replace(/[\s+\-,]+$/, '')} Bundle`;
}

// JSON-LD Product name: full combo name, guaranteed to contain "Bundle"/"Combo".
export function bundleLdName(p) {
  const n = String((p && p.n) || '').trim();
  return /\b(bundle|combo)\b/i.test(n) ? n : `${n} Bundle`;
}
