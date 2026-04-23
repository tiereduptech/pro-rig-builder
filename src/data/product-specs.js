// ═══════════════════════════════════════════════════════════════════
// product-specs.js — Canonical spec tables for catalog expansion
//
// These are hardcoded from manufacturer spec sheets (Intel, AMD, NVIDIA)
// and benchmark databases (PassMark, TechPowerUp). The `bench` score is
// normalized 0-100 to match the existing catalog's scale.
//
// IMPORTANT: Updates/corrections should be made here rather than in parts.js
// so the catalog stays consistent if we re-run the fetch.
// ═══════════════════════════════════════════════════════════════════

// ─── CPU SPECS ───────────────────────────────────────────────────
// Key format: exact model identifier (e.g., "i7-13700K", "Ryzen 9 5900X")
// Fields: socket, cores, threads, boostClock (GHz), tdp (watts), bench (0-100 PassMark-normalized)
export const CPU_SPECS = {
  // ─── Intel Core Ultra 15th gen (LGA1851, Arrow Lake) ───
  "Core Ultra 9 285K":   { socket: "LGA1851", cores: 24, threads: 24, boostClock: 5.7, tdp: 125, bench: 95 },
  "Core Ultra 7 265K":   { socket: "LGA1851", cores: 20, threads: 20, boostClock: 5.5, tdp: 125, bench: 88 },
  "Core Ultra 7 265KF":  { socket: "LGA1851", cores: 20, threads: 20, boostClock: 5.5, tdp: 125, bench: 88 },
  "Core Ultra 5 245K":   { socket: "LGA1851", cores: 14, threads: 14, boostClock: 5.2, tdp: 125, bench: 82 },
  "Core Ultra 5 245KF":  { socket: "LGA1851", cores: 14, threads: 14, boostClock: 5.2, tdp: 125, bench: 82 },
  "Core Ultra 5 225":    { socket: "LGA1851", cores: 10, threads: 10, boostClock: 4.9, tdp: 65,  bench: 72 },
  "Core Ultra 5 225F":   { socket: "LGA1851", cores: 10, threads: 10, boostClock: 4.9, tdp: 65,  bench: 72 },

  // ─── Intel 14th gen (LGA1700, Raptor Lake Refresh) ───
  "i9-14900KS": { socket: "LGA1700", cores: 24, threads: 32, boostClock: 6.2, tdp: 150, bench: 94 },
  "i9-14900K":  { socket: "LGA1700", cores: 24, threads: 32, boostClock: 6.0, tdp: 125, bench: 92 },
  "i9-14900KF": { socket: "LGA1700", cores: 24, threads: 32, boostClock: 6.0, tdp: 125, bench: 92 },
  "i9-14900":   { socket: "LGA1700", cores: 24, threads: 32, boostClock: 5.8, tdp: 65,  bench: 89 },
  "i9-14900F":  { socket: "LGA1700", cores: 24, threads: 32, boostClock: 5.8, tdp: 65,  bench: 89 },
  "i7-14700K":  { socket: "LGA1700", cores: 20, threads: 28, boostClock: 5.6, tdp: 125, bench: 87 },
  "i7-14700KF": { socket: "LGA1700", cores: 20, threads: 28, boostClock: 5.6, tdp: 125, bench: 87 },
  "i7-14700":   { socket: "LGA1700", cores: 20, threads: 28, boostClock: 5.4, tdp: 65,  bench: 84 },
  "i7-14700F":  { socket: "LGA1700", cores: 20, threads: 28, boostClock: 5.4, tdp: 65,  bench: 84 },
  "i5-14600K":  { socket: "LGA1700", cores: 14, threads: 20, boostClock: 5.3, tdp: 125, bench: 79 },
  "i5-14600KF": { socket: "LGA1700", cores: 14, threads: 20, boostClock: 5.3, tdp: 125, bench: 79 },
  "i5-14600":   { socket: "LGA1700", cores: 14, threads: 20, boostClock: 5.2, tdp: 65,  bench: 77 },
  "i5-14500":   { socket: "LGA1700", cores: 14, threads: 20, boostClock: 5.0, tdp: 65,  bench: 75 },
  "i5-14400":   { socket: "LGA1700", cores: 10, threads: 16, boostClock: 4.7, tdp: 65,  bench: 68 },
  "i5-14400F":  { socket: "LGA1700", cores: 10, threads: 16, boostClock: 4.7, tdp: 65,  bench: 68 },
  "i3-14100":   { socket: "LGA1700", cores: 4,  threads: 8,  boostClock: 4.7, tdp: 60,  bench: 52 },
  "i3-14100F":  { socket: "LGA1700", cores: 4,  threads: 8,  boostClock: 4.7, tdp: 58,  bench: 52 },

  // ─── Intel 13th gen (LGA1700, Raptor Lake) ───
  "i9-13900KS": { socket: "LGA1700", cores: 24, threads: 32, boostClock: 6.0, tdp: 150, bench: 92 },
  "i9-13900K":  { socket: "LGA1700", cores: 24, threads: 32, boostClock: 5.8, tdp: 125, bench: 90 },
  "i9-13900KF": { socket: "LGA1700", cores: 24, threads: 32, boostClock: 5.8, tdp: 125, bench: 90 },
  "i9-13900":   { socket: "LGA1700", cores: 24, threads: 32, boostClock: 5.6, tdp: 65,  bench: 87 },
  "i9-13900F":  { socket: "LGA1700", cores: 24, threads: 32, boostClock: 5.6, tdp: 65,  bench: 87 },
  "i7-13700K":  { socket: "LGA1700", cores: 16, threads: 24, boostClock: 5.4, tdp: 125, bench: 85 },
  "i7-13700KF": { socket: "LGA1700", cores: 16, threads: 24, boostClock: 5.4, tdp: 125, bench: 85 },
  "i7-13700":   { socket: "LGA1700", cores: 16, threads: 24, boostClock: 5.2, tdp: 65,  bench: 82 },
  "i7-13700F":  { socket: "LGA1700", cores: 16, threads: 24, boostClock: 5.2, tdp: 65,  bench: 82 },
  "i5-13600K":  { socket: "LGA1700", cores: 14, threads: 20, boostClock: 5.1, tdp: 125, bench: 77 },
  "i5-13600KF": { socket: "LGA1700", cores: 14, threads: 20, boostClock: 5.1, tdp: 125, bench: 77 },
  "i5-13600":   { socket: "LGA1700", cores: 14, threads: 20, boostClock: 5.0, tdp: 65,  bench: 75 },
  "i5-13500":   { socket: "LGA1700", cores: 14, threads: 20, boostClock: 4.8, tdp: 65,  bench: 73 },
  "i5-13400":   { socket: "LGA1700", cores: 10, threads: 16, boostClock: 4.6, tdp: 65,  bench: 66 },
  "i5-13400F":  { socket: "LGA1700", cores: 10, threads: 16, boostClock: 4.6, tdp: 65,  bench: 66 },
  "i3-13100":   { socket: "LGA1700", cores: 4,  threads: 8,  boostClock: 4.5, tdp: 60,  bench: 50 },
  "i3-13100F":  { socket: "LGA1700", cores: 4,  threads: 8,  boostClock: 4.5, tdp: 58,  bench: 50 },

  // ─── Intel 12th gen (LGA1700, Alder Lake) ───
  "i9-12900KS": { socket: "LGA1700", cores: 16, threads: 24, boostClock: 5.5, tdp: 150, bench: 86 },
  "i9-12900K":  { socket: "LGA1700", cores: 16, threads: 24, boostClock: 5.2, tdp: 125, bench: 84 },
  "i9-12900KF": { socket: "LGA1700", cores: 16, threads: 24, boostClock: 5.2, tdp: 125, bench: 84 },
  "i9-12900":   { socket: "LGA1700", cores: 16, threads: 24, boostClock: 5.1, tdp: 65,  bench: 80 },
  "i9-12900F":  { socket: "LGA1700", cores: 16, threads: 24, boostClock: 5.1, tdp: 65,  bench: 80 },
  "i7-12700K":  { socket: "LGA1700", cores: 12, threads: 20, boostClock: 5.0, tdp: 125, bench: 78 },
  "i7-12700KF": { socket: "LGA1700", cores: 12, threads: 20, boostClock: 5.0, tdp: 125, bench: 78 },
  "i7-12700":   { socket: "LGA1700", cores: 12, threads: 20, boostClock: 4.9, tdp: 65,  bench: 75 },
  "i7-12700F":  { socket: "LGA1700", cores: 12, threads: 20, boostClock: 4.9, tdp: 65,  bench: 75 },
  "i5-12600K":  { socket: "LGA1700", cores: 10, threads: 16, boostClock: 4.9, tdp: 125, bench: 70 },
  "i5-12600KF": { socket: "LGA1700", cores: 10, threads: 16, boostClock: 4.9, tdp: 125, bench: 70 },
  "i5-12600":   { socket: "LGA1700", cores: 6,  threads: 12, boostClock: 4.8, tdp: 65,  bench: 62 },
  "i5-12500":   { socket: "LGA1700", cores: 6,  threads: 12, boostClock: 4.6, tdp: 65,  bench: 60 },
  "i5-12400":   { socket: "LGA1700", cores: 6,  threads: 12, boostClock: 4.4, tdp: 65,  bench: 58 },
  "i5-12400F":  { socket: "LGA1700", cores: 6,  threads: 12, boostClock: 4.4, tdp: 65,  bench: 58 },
  "i3-12100":   { socket: "LGA1700", cores: 4,  threads: 8,  boostClock: 4.3, tdp: 60,  bench: 46 },
  "i3-12100F":  { socket: "LGA1700", cores: 4,  threads: 8,  boostClock: 4.3, tdp: 58,  bench: 46 },

  // ─── Intel 11th gen (LGA1200, Rocket Lake) ───
  "i9-11900K":  { socket: "LGA1200", cores: 8,  threads: 16, boostClock: 5.3, tdp: 125, bench: 72 },
  "i9-11900KF": { socket: "LGA1200", cores: 8,  threads: 16, boostClock: 5.3, tdp: 125, bench: 72 },
  "i9-11900":   { socket: "LGA1200", cores: 8,  threads: 16, boostClock: 5.2, tdp: 65,  bench: 70 },
  "i9-11900F":  { socket: "LGA1200", cores: 8,  threads: 16, boostClock: 5.2, tdp: 65,  bench: 70 },
  "i7-11700K":  { socket: "LGA1200", cores: 8,  threads: 16, boostClock: 5.0, tdp: 125, bench: 68 },
  "i7-11700KF": { socket: "LGA1200", cores: 8,  threads: 16, boostClock: 5.0, tdp: 125, bench: 68 },
  "i7-11700":   { socket: "LGA1200", cores: 8,  threads: 16, boostClock: 4.9, tdp: 65,  bench: 65 },
  "i7-11700F":  { socket: "LGA1200", cores: 8,  threads: 16, boostClock: 4.9, tdp: 65,  bench: 65 },
  "i5-11600K":  { socket: "LGA1200", cores: 6,  threads: 12, boostClock: 4.9, tdp: 125, bench: 62 },
  "i5-11600KF": { socket: "LGA1200", cores: 6,  threads: 12, boostClock: 4.9, tdp: 125, bench: 62 },
  "i5-11600":   { socket: "LGA1200", cores: 6,  threads: 12, boostClock: 4.8, tdp: 65,  bench: 60 },
  "i5-11500":   { socket: "LGA1200", cores: 6,  threads: 12, boostClock: 4.6, tdp: 65,  bench: 58 },
  "i5-11400":   { socket: "LGA1200", cores: 6,  threads: 12, boostClock: 4.4, tdp: 65,  bench: 55 },
  "i5-11400F":  { socket: "LGA1200", cores: 6,  threads: 12, boostClock: 4.4, tdp: 65,  bench: 55 },
  "i3-11100":   { socket: "LGA1200", cores: 4,  threads: 8,  boostClock: 4.4, tdp: 65,  bench: 42 },
  "i3-11100F":  { socket: "LGA1200", cores: 4,  threads: 8,  boostClock: 4.4, tdp: 65,  bench: 42 },

  // ─── Intel 10th gen (LGA1200, Comet Lake) ───
  "i9-10900K":  { socket: "LGA1200", cores: 10, threads: 20, boostClock: 5.3, tdp: 125, bench: 66 },
  "i9-10900KF": { socket: "LGA1200", cores: 10, threads: 20, boostClock: 5.3, tdp: 125, bench: 66 },
  "i9-10900":   { socket: "LGA1200", cores: 10, threads: 20, boostClock: 5.2, tdp: 65,  bench: 63 },
  "i9-10900F":  { socket: "LGA1200", cores: 10, threads: 20, boostClock: 5.2, tdp: 65,  bench: 63 },
  "i7-10700K":  { socket: "LGA1200", cores: 8,  threads: 16, boostClock: 5.1, tdp: 125, bench: 60 },
  "i7-10700KF": { socket: "LGA1200", cores: 8,  threads: 16, boostClock: 5.1, tdp: 125, bench: 60 },
  "i7-10700":   { socket: "LGA1200", cores: 8,  threads: 16, boostClock: 4.8, tdp: 65,  bench: 57 },
  "i7-10700F":  { socket: "LGA1200", cores: 8,  threads: 16, boostClock: 4.8, tdp: 65,  bench: 57 },
  "i5-10600K":  { socket: "LGA1200", cores: 6,  threads: 12, boostClock: 4.8, tdp: 125, bench: 55 },
  "i5-10600KF": { socket: "LGA1200", cores: 6,  threads: 12, boostClock: 4.8, tdp: 125, bench: 55 },
  "i5-10600":   { socket: "LGA1200", cores: 6,  threads: 12, boostClock: 4.8, tdp: 65,  bench: 52 },
  "i5-10500":   { socket: "LGA1200", cores: 6,  threads: 12, boostClock: 4.5, tdp: 65,  bench: 50 },
  "i5-10400":   { socket: "LGA1200", cores: 6,  threads: 12, boostClock: 4.3, tdp: 65,  bench: 46 },
  "i5-10400F":  { socket: "LGA1200", cores: 6,  threads: 12, boostClock: 4.3, tdp: 65,  bench: 46 },
  "i3-10300":   { socket: "LGA1200", cores: 4,  threads: 8,  boostClock: 4.4, tdp: 65,  bench: 38 },
  "i3-10100":   { socket: "LGA1200", cores: 4,  threads: 8,  boostClock: 4.3, tdp: 65,  bench: 36 },
  "i3-10100F":  { socket: "LGA1200", cores: 4,  threads: 8,  boostClock: 4.3, tdp: 65,  bench: 36 },
  "i3-10105":   { socket: "LGA1200", cores: 4,  threads: 8,  boostClock: 4.4, tdp: 65,  bench: 36 },
  "i3-10105F":  { socket: "LGA1200", cores: 4,  threads: 8,  boostClock: 4.4, tdp: 65,  bench: 36 },

  // ─── AMD Ryzen 9000 (AM5, Zen 5) ───
  "Ryzen 9 9950X3D": { socket: "AM5", cores: 16, threads: 32, boostClock: 5.7, tdp: 170, bench: 99 },
  "Ryzen 9 9950X":   { socket: "AM5", cores: 16, threads: 32, boostClock: 5.7, tdp: 170, bench: 97 },
  "Ryzen 9 9900X3D": { socket: "AM5", cores: 12, threads: 24, boostClock: 5.5, tdp: 120, bench: 93 },
  "Ryzen 9 9900X":   { socket: "AM5", cores: 12, threads: 24, boostClock: 5.6, tdp: 120, bench: 91 },
  "Ryzen 7 9800X3D": { socket: "AM5", cores: 8,  threads: 16, boostClock: 5.2, tdp: 120, bench: 89 },
  "Ryzen 7 9700X":   { socket: "AM5", cores: 8,  threads: 16, boostClock: 5.5, tdp: 65,  bench: 83 },
  "Ryzen 5 9600X":   { socket: "AM5", cores: 6,  threads: 12, boostClock: 5.4, tdp: 65,  bench: 75 },
  "Ryzen 5 9600":    { socket: "AM5", cores: 6,  threads: 12, boostClock: 5.2, tdp: 65,  bench: 73 },

  // ─── AMD Ryzen 8000G APUs (AM5, Zen 4, Phoenix) ───
  "Ryzen 7 8700G":   { socket: "AM5", cores: 8,  threads: 16, boostClock: 5.1, tdp: 65,  bench: 66 },
  "Ryzen 5 8600G":   { socket: "AM5", cores: 6,  threads: 12, boostClock: 5.0, tdp: 65,  bench: 58 },
  "Ryzen 5 8500G":   { socket: "AM5", cores: 6,  threads: 12, boostClock: 5.0, tdp: 65,  bench: 52 },
  "Ryzen 3 8300G":   { socket: "AM5", cores: 4,  threads: 8,  boostClock: 4.9, tdp: 65,  bench: 40 },

  // ─── AMD Ryzen 7000 (AM5, Zen 4) ───
  "Ryzen 9 7950X3D": { socket: "AM5", cores: 16, threads: 32, boostClock: 5.7, tdp: 120, bench: 93 },
  "Ryzen 9 7950X":   { socket: "AM5", cores: 16, threads: 32, boostClock: 5.7, tdp: 170, bench: 91 },
  "Ryzen 9 7900X3D": { socket: "AM5", cores: 12, threads: 24, boostClock: 5.6, tdp: 120, bench: 87 },
  "Ryzen 9 7900X":   { socket: "AM5", cores: 12, threads: 24, boostClock: 5.6, tdp: 170, bench: 85 },
  "Ryzen 9 7900":    { socket: "AM5", cores: 12, threads: 24, boostClock: 5.4, tdp: 65,  bench: 82 },
  "Ryzen 7 7800X3D": { socket: "AM5", cores: 8,  threads: 16, boostClock: 5.0, tdp: 120, bench: 83 },
  "Ryzen 7 7700X":   { socket: "AM5", cores: 8,  threads: 16, boostClock: 5.4, tdp: 105, bench: 77 },
  "Ryzen 7 7700":    { socket: "AM5", cores: 8,  threads: 16, boostClock: 5.3, tdp: 65,  bench: 75 },
  "Ryzen 5 7600X":   { socket: "AM5", cores: 6,  threads: 12, boostClock: 5.3, tdp: 105, bench: 69 },
  "Ryzen 5 7600":    { socket: "AM5", cores: 6,  threads: 12, boostClock: 5.1, tdp: 65,  bench: 67 },

  // ─── AMD Ryzen 5000 (AM4, Zen 3) ───
  "Ryzen 9 5950X":   { socket: "AM4", cores: 16, threads: 32, boostClock: 4.9, tdp: 105, bench: 82 },
  "Ryzen 9 5900X":   { socket: "AM4", cores: 12, threads: 24, boostClock: 4.8, tdp: 105, bench: 75 },
  "Ryzen 9 5900":    { socket: "AM4", cores: 12, threads: 24, boostClock: 4.7, tdp: 65,  bench: 72 },
  "Ryzen 7 5800X3D": { socket: "AM4", cores: 8,  threads: 16, boostClock: 4.5, tdp: 105, bench: 74 },
  "Ryzen 7 5800X":   { socket: "AM4", cores: 8,  threads: 16, boostClock: 4.7, tdp: 105, bench: 66 },
  "Ryzen 7 5800":    { socket: "AM4", cores: 8,  threads: 16, boostClock: 4.6, tdp: 65,  bench: 64 },
  "Ryzen 7 5700X3D": { socket: "AM4", cores: 8,  threads: 16, boostClock: 4.1, tdp: 105, bench: 67 },
  "Ryzen 7 5700X":   { socket: "AM4", cores: 8,  threads: 16, boostClock: 4.6, tdp: 65,  bench: 62 },
  "Ryzen 7 5700":    { socket: "AM4", cores: 8,  threads: 16, boostClock: 4.6, tdp: 65,  bench: 59 },
  "Ryzen 7 5700G":   { socket: "AM4", cores: 8,  threads: 16, boostClock: 4.6, tdp: 65,  bench: 55 },
  "Ryzen 5 5600X3D": { socket: "AM4", cores: 6,  threads: 12, boostClock: 4.4, tdp: 105, bench: 60 },
  "Ryzen 5 5600X":   { socket: "AM4", cores: 6,  threads: 12, boostClock: 4.6, tdp: 65,  bench: 57 },
  "Ryzen 5 5600":    { socket: "AM4", cores: 6,  threads: 12, boostClock: 4.4, tdp: 65,  bench: 55 },
  "Ryzen 5 5600G":   { socket: "AM4", cores: 6,  threads: 12, boostClock: 4.4, tdp: 65,  bench: 50 },
  "Ryzen 5 5500":    { socket: "AM4", cores: 6,  threads: 12, boostClock: 4.2, tdp: 65,  bench: 48 },
  "Ryzen 3 5300G":   { socket: "AM4", cores: 4,  threads: 8,  boostClock: 4.2, tdp: 65,  bench: 36 },

  // ─── AMD Ryzen 4000G APUs (AM4, Zen 2, Renoir) ───
  "Ryzen 7 4700G":   { socket: "AM4", cores: 8,  threads: 16, boostClock: 4.4, tdp: 65,  bench: 44 },
  "Ryzen 5 4600G":   { socket: "AM4", cores: 6,  threads: 12, boostClock: 4.2, tdp: 65,  bench: 38 },
  "Ryzen 5 4500":    { socket: "AM4", cores: 6,  threads: 12, boostClock: 4.1, tdp: 65,  bench: 34 },
  "Ryzen 3 4300G":   { socket: "AM4", cores: 4,  threads: 8,  boostClock: 4.0, tdp: 65,  bench: 26 },
  "Ryzen 3 4100":    { socket: "AM4", cores: 4,  threads: 8,  boostClock: 4.0, tdp: 65,  bench: 24 },

};

// ─── GPU SPECS ───────────────────────────────────────────────────
// Key format: normalized model identifier (e.g., "RTX 4070 Ti", "RX 7800 XT")
// Fields: vram (MB), tdp (watts), bench (0-100)
export const GPU_SPECS = {
  // ─── NVIDIA RTX 50 (Blackwell) ───
  "RTX 5090":        { vram: 32768, tdp: 575, bench: 100 },
  "RTX 5080":        { vram: 16384, tdp: 360, bench: 82 },
  "RTX 5070 Ti":     { vram: 16384, tdp: 300, bench: 72 },
  "RTX 5070":        { vram: 12288, tdp: 250, bench: 60 },
  "RTX 5060 Ti":     { vram: 16384, tdp: 180, bench: 50 },
  "RTX 5060":        { vram: 8192,  tdp: 150, bench: 40 },

  // ─── NVIDIA RTX 40 (Ada Lovelace) ───
  "RTX 4090":        { vram: 24576, tdp: 450, bench: 92 },
  "RTX 4080 Super":  { vram: 16384, tdp: 320, bench: 76 },
  "RTX 4080":        { vram: 16384, tdp: 320, bench: 73 },
  "RTX 4070 Ti Super": { vram: 16384, tdp: 285, bench: 65 },
  "RTX 4070 Ti":     { vram: 12288, tdp: 285, bench: 60 },
  "RTX 4070 Super":  { vram: 12288, tdp: 220, bench: 55 },
  "RTX 4070":        { vram: 12288, tdp: 200, bench: 48 },
  "RTX 4060 Ti":     { vram: 8192,  tdp: 160, bench: 38 },
  "RTX 4060":        { vram: 8192,  tdp: 115, bench: 32 },

  // ─── NVIDIA RTX 30 (Ampere) ───
  "RTX 3090 Ti":     { vram: 24576, tdp: 450, bench: 66 },
  "RTX 3090":        { vram: 24576, tdp: 350, bench: 60 },
  "RTX 3080 Ti":     { vram: 12288, tdp: 350, bench: 58 },
  "RTX 3080":        { vram: 10240, tdp: 320, bench: 52 },
  "RTX 3070 Ti":     { vram: 8192,  tdp: 290, bench: 44 },
  "RTX 3070":        { vram: 8192,  tdp: 220, bench: 40 },
  "RTX 3060 Ti":     { vram: 8192,  tdp: 200, bench: 35 },
  "RTX 3060":        { vram: 12288, tdp: 170, bench: 28 },
  "RTX 3050":        { vram: 8192,  tdp: 130, bench: 22 },

  // ─── NVIDIA RTX 20 (Turing) ───
  "RTX 2080 Ti":     { vram: 11264, tdp: 250, bench: 36 },
  "RTX 2080 Super":  { vram: 8192,  tdp: 250, bench: 33 },
  "RTX 2080":        { vram: 8192,  tdp: 215, bench: 32 },
  "RTX 2070 Super":  { vram: 8192,  tdp: 215, bench: 30 },
  "RTX 2070":        { vram: 8192,  tdp: 175, bench: 27 },
  "RTX 2060 Super":  { vram: 8192,  tdp: 175, bench: 26 },
  "RTX 2060":        { vram: 6144,  tdp: 160, bench: 22 },

  // ─── AMD RX 9000 (RDNA 4) ───
  "RX 9070 XT":      { vram: 16384, tdp: 304, bench: 72 },
  "RX 9070":         { vram: 16384, tdp: 220, bench: 62 },
  "RX 9060 XT":      { vram: 16384, tdp: 180, bench: 50 },

  // ─── AMD RX 7000 (RDNA 3) ───
  "RX 7900 XTX":     { vram: 24576, tdp: 355, bench: 78 },
  "RX 7900 XT":      { vram: 20480, tdp: 315, bench: 70 },
  "RX 7900 GRE":     { vram: 16384, tdp: 260, bench: 60 },
  "RX 7900":         { vram: 16384, tdp: 300, bench: 65 },
  "RX 7800 XT":      { vram: 16384, tdp: 263, bench: 58 },
  "RX 7700 XT":      { vram: 12288, tdp: 245, bench: 50 },
  "RX 7600 XT":      { vram: 16384, tdp: 190, bench: 40 },
  "RX 7600":         { vram: 8192,  tdp: 165, bench: 36 },

  // ─── AMD RX 6000 (RDNA 2) ───
  "RX 6950 XT":      { vram: 16384, tdp: 335, bench: 55 },
  "RX 6900 XT":      { vram: 16384, tdp: 300, bench: 52 },
  "RX 6800 XT":      { vram: 16384, tdp: 300, bench: 48 },
  "RX 6800":         { vram: 16384, tdp: 250, bench: 44 },
  "RX 6750 XT":      { vram: 12288, tdp: 250, bench: 42 },
  "RX 6700 XT":      { vram: 12288, tdp: 230, bench: 38 },
  "RX 6700":         { vram: 10240, tdp: 175, bench: 34 },
  "RX 6650 XT":      { vram: 8192,  tdp: 180, bench: 32 },
  "RX 6600 XT":      { vram: 8192,  tdp: 160, bench: 28 },
  "RX 6600":         { vram: 8192,  tdp: 132, bench: 24 },
  "RX 6500 XT":      { vram: 4096,  tdp: 107, bench: 16 },
  "RX 6400":         { vram: 4096,  tdp: 53,  bench: 10 },

  // ─── AMD RX 5000 (RDNA 1) ───
  "RX 5700 XT":      { vram: 8192,  tdp: 225, bench: 26 },
  "RX 5700":         { vram: 8192,  tdp: 180, bench: 23 },
  "RX 5600 XT":      { vram: 6144,  tdp: 150, bench: 20 },
  "RX 5500 XT":      { vram: 8192,  tdp: 130, bench: 14 },

  // ─── AMD RX 500 (Polaris Refresh) ───
  "RX 590":          { vram: 8192,  tdp: 225, bench: 14 },
  "RX 580":          { vram: 8192,  tdp: 185, bench: 13 },
  "RX 570":          { vram: 8192,  tdp: 150, bench: 11 },
  "RX 560":          { vram: 4096,  tdp: 80,  bench: 7 },
  "RX 550":          { vram: 4096,  tdp: 50,  bench: 5 },

  // ─── Intel Arc (Battlemage, 2024-2025) ───
  "Arc B580":        { vram: 12288, tdp: 190, bench: 36 },
  "Arc B570":        { vram: 10240, tdp: 150, bench: 30 },

  // ─── Intel Arc (Alchemist, 2022-2023) ───
  "Arc A770":        { vram: 16384, tdp: 225, bench: 32 },
  "Arc A750":        { vram: 8192,  tdp: 225, bench: 28 },
  "Arc A580":        { vram: 8192,  tdp: 185, bench: 22 },
  "Arc A380":        { vram: 6144,  tdp: 75,  bench: 12 },

};

// ─── MOTHERBOARD CHIPSET SPECS ───────────────────────────────────
// Key format: chipset identifier (Z790, B550, X670E, etc.)
// Fields: socket, memType, memSlots (typical), maxMem, m2Slots (typical), sataPorts (typical)
// NOTE: These are typical mid-range values; specific motherboard models may differ slightly
export const MOBO_CHIPSET_SPECS = {
  // ─── Intel LGA1851 (15th gen) ───
  "Z890":   { socket: "LGA1851", memType: "DDR5", memSlots: 4, maxMem: 256, m2Slots: 4, sataPorts: 4, tier: "enthusiast" },
  "B860":   { socket: "LGA1851", memType: "DDR5", memSlots: 4, maxMem: 192, m2Slots: 3, sataPorts: 4, tier: "mainstream" },
  "H810":   { socket: "LGA1851", memType: "DDR5", memSlots: 2, maxMem: 128, m2Slots: 2, sataPorts: 4, tier: "budget" },

  // ─── Intel LGA1700 (12/13/14th gen) ───
  "Z790":   { socket: "LGA1700", memType: "DDR5", memSlots: 4, maxMem: 192, m2Slots: 4, sataPorts: 6, tier: "enthusiast" },
  "Z690":   { socket: "LGA1700", memType: "DDR5", memSlots: 4, maxMem: 128, m2Slots: 4, sataPorts: 6, tier: "enthusiast" },
  "B760":   { socket: "LGA1700", memType: "DDR5", memSlots: 4, maxMem: 192, m2Slots: 3, sataPorts: 4, tier: "mainstream" },
  "B660":   { socket: "LGA1700", memType: "DDR5", memSlots: 4, maxMem: 128, m2Slots: 2, sataPorts: 4, tier: "mainstream" },
  "H770":   { socket: "LGA1700", memType: "DDR5", memSlots: 4, maxMem: 128, m2Slots: 3, sataPorts: 4, tier: "mid" },
  "H670":   { socket: "LGA1700", memType: "DDR5", memSlots: 4, maxMem: 128, m2Slots: 3, sataPorts: 4, tier: "mid" },
  "H610":   { socket: "LGA1700", memType: "DDR5", memSlots: 2, maxMem: 64,  m2Slots: 1, sataPorts: 4, tier: "budget" },

  // ─── Intel LGA1200 (10/11th gen) ───
  "Z590":   { socket: "LGA1200", memType: "DDR4", memSlots: 4, maxMem: 128, m2Slots: 3, sataPorts: 6, tier: "enthusiast" },
  "Z490":   { socket: "LGA1200", memType: "DDR4", memSlots: 4, maxMem: 128, m2Slots: 3, sataPorts: 6, tier: "enthusiast" },
  "B560":   { socket: "LGA1200", memType: "DDR4", memSlots: 4, maxMem: 128, m2Slots: 2, sataPorts: 6, tier: "mainstream" },
  "B460":   { socket: "LGA1200", memType: "DDR4", memSlots: 4, maxMem: 128, m2Slots: 1, sataPorts: 6, tier: "mainstream" },
  "H570":   { socket: "LGA1200", memType: "DDR4", memSlots: 4, maxMem: 128, m2Slots: 2, sataPorts: 6, tier: "mid" },
  "H470":   { socket: "LGA1200", memType: "DDR4", memSlots: 4, maxMem: 128, m2Slots: 2, sataPorts: 6, tier: "mid" },
  "H510":   { socket: "LGA1200", memType: "DDR4", memSlots: 2, maxMem: 64,  m2Slots: 1, sataPorts: 4, tier: "budget" },
  "H410":   { socket: "LGA1200", memType: "DDR4", memSlots: 2, maxMem: 64,  m2Slots: 1, sataPorts: 4, tier: "budget" },

  // ─── AMD AM5 (Ryzen 7000+) ───
  "X870E":  { socket: "AM5", memType: "DDR5", memSlots: 4, maxMem: 256, m2Slots: 4, sataPorts: 4, tier: "enthusiast" },
  "X870":   { socket: "AM5", memType: "DDR5", memSlots: 4, maxMem: 192, m2Slots: 3, sataPorts: 4, tier: "enthusiast" },
  "X670E":  { socket: "AM5", memType: "DDR5", memSlots: 4, maxMem: 128, m2Slots: 4, sataPorts: 4, tier: "enthusiast" },
  "X670":   { socket: "AM5", memType: "DDR5", memSlots: 4, maxMem: 128, m2Slots: 3, sataPorts: 4, tier: "enthusiast" },
  "B850":   { socket: "AM5", memType: "DDR5", memSlots: 4, maxMem: 192, m2Slots: 3, sataPorts: 4, tier: "mainstream" },
  "B840":   { socket: "AM5", memType: "DDR5", memSlots: 4, maxMem: 128, m2Slots: 2, sataPorts: 4, tier: "budget" },
  "B650E":  { socket: "AM5", memType: "DDR5", memSlots: 4, maxMem: 128, m2Slots: 3, sataPorts: 4, tier: "mainstream" },
  "B650":   { socket: "AM5", memType: "DDR5", memSlots: 4, maxMem: 128, m2Slots: 2, sataPorts: 4, tier: "mainstream" },
  "A620":   { socket: "AM5", memType: "DDR5", memSlots: 4, maxMem: 128, m2Slots: 1, sataPorts: 4, tier: "budget" },

  // ─── AMD AM4 (Ryzen 2000-5000) ───
  "X570":   { socket: "AM4", memType: "DDR4", memSlots: 4, maxMem: 128, m2Slots: 2, sataPorts: 6, tier: "enthusiast" },
  "X470":   { socket: "AM4", memType: "DDR4", memSlots: 4, maxMem: 64,  m2Slots: 2, sataPorts: 6, tier: "enthusiast" },
  "B550":   { socket: "AM4", memType: "DDR4", memSlots: 4, maxMem: 128, m2Slots: 2, sataPorts: 6, tier: "mainstream" },
  "B450":   { socket: "AM4", memType: "DDR4", memSlots: 4, maxMem: 64,  m2Slots: 1, sataPorts: 6, tier: "mainstream" },
  "A520":   { socket: "AM4", memType: "DDR4", memSlots: 4, maxMem: 64,  m2Slots: 1, sataPorts: 4, tier: "budget" },
};

// Helper: extract canonical CPU model from a product name
export function extractCPUModel(name) {
  if (!name) return null;
  const n = name.replace(/™|®/g, '').replace(/\s+/g, ' ').trim();
  // AMD Ryzen patterns — including APU G-variants and X3D variants
  let m = n.match(/\bRyzen\s+(\d)\s+(\d{4}[A-Z0-9]{0,3})\b/i);
  if (m) return `Ryzen ${m[1]} ${m[2].toUpperCase()}`;
  // Intel Core Ultra (15th gen) — model may be separated from tier in marketing titles
  // e.g., "Core Ultra 5 245K" (direct) or "Core™ Ultra 5 Desktop Processor 225F" (separated)
  m = n.match(/\bCore\s*(?:™|\(TM\))?\s+Ultra\s+(\d)\b/i);
  if (m) {
    const tier = m[1];
    // Find the 3-digit model number with optional K/KF/F suffix anywhere in string
    const modelMatch = n.match(/\b(\d{3}[A-Z]{0,3})\b/);
    if (modelMatch) return `Core Ultra ${tier} ${modelMatch[1].toUpperCase()}`;
  }
  // Intel Core iX-YYYY (with F/K/KF/KS/KFS suffix)
  m = n.match(/\b(i[3579])-(\d{4,5}[A-Z]{0,3})\b/i);
  if (m) return `${m[1].toLowerCase()}-${m[2].toUpperCase()}`;
  return null;
}

// Helper: extract canonical GPU model
export function extractGPUModel(name) {
  if (!name) return null;
  const n = name.toUpperCase();
  // NVIDIA RTX with Ti/Super/Ti Super suffix
  let m = n.match(/\bRTX\s*(\d{4})\s*(TI\s*SUPER|SUPER|TI)?\b/);
  if (m) {
    const suffix = m[2] ? ' ' + m[2].replace(/\s+/g, ' ') : '';
    // Normalize "Ti Super" -> "Ti Super" (title case)
    const normalized = suffix.replace(/\bTI\b/g, 'Ti').replace(/\bSUPER\b/g, 'Super');
    return `RTX ${m[1]}${normalized}`;
  }
  // AMD RX with XTX/XT/GRE suffix
  m = n.match(/\bRX\s*(\d{3,4})\s*(XTX|XT|GRE)?\b/);
  if (m) {
    const suffix = m[2] ? ' ' + m[2] : '';
    return `RX ${m[1]}${suffix}`;
  }
  // Intel Arc (Battlemage B-series, Alchemist A-series)
  m = n.match(/\bARC\s*([AB]\d{3})\b/);
  if (m) return `Arc ${m[1].toUpperCase()}`;
  return null;
}

export default { CPU_SPECS, GPU_SPECS, MOBO_CHIPSET_SPECS, extractCPUModel, extractGPUModel };
