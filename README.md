# RigFinder — PC Hardware Builder

A modern PC hardware finder and builder with smart compatibility checking, mega menu navigation, custom category thumbnails, and an interactive build experience.

---

## Quick Start (3 commands)

### Prerequisites
- **Node.js 18+** — Download from [nodejs.org](https://nodejs.org/) if you don't have it
- Verify with: `node --version` (should show v18 or higher)

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Start the dev server
npm run dev
```

That's it. Your browser will open to **http://localhost:3000** automatically.

---

## Project Structure

```
rigfinder/
├── index.html          ← HTML entry point
├── package.json        ← Dependencies & scripts
├── vite.config.js      ← Vite dev server config
├── src/
│   ├── main.jsx        ← React mount + storage polyfill
│   └── App.jsx         ← Entire app (single file)
└── README.md
```

## Available Scripts

| Command           | What it does                                      |
| ----------------- | ------------------------------------------------- |
| `npm run dev`     | Start dev server at localhost:3000 with hot reload |
| `npm run build`   | Build for production into `dist/` folder           |
| `npm run preview` | Preview the production build locally               |

## Build for Production

```bash
# Create optimized production build
npm run build

# Preview it locally before deploying
npm run preview
```

The `dist/` folder contains static files you can deploy to any hosting:
- **Netlify** — drag & drop the `dist` folder
- **Vercel** — `npx vercel --prod`
- **GitHub Pages** — push `dist/` contents to `gh-pages` branch
- **Any static host** — upload the `dist/` folder

## Features

- **Mega Menu Navigation** — Browse all component categories from a rich dropdown
- **Smart Part Finder** — Filter by brand, price, specs with category-specific filters
- **Interactive PC Builder** — Visual assembly grid with progress tracking
- **Compatibility Engine** — 18+ automated checks including:
  - CPU/Motherboard socket matching
  - GPU length vs case clearance (mm)
  - Cooler height vs case clearance (mm)
  - M.2 slot count validation
  - SATA port count validation
  - PSU wattage & PCIe connector checks
  - RAM type (DDR4/DDR5) cross-validation
  - RAM speed vs motherboard/CPU rated max
  - Motherboard form factor vs case support
  - Cooler vs RAM height clearance
- **Addons & Setup** — Monitors, keyboards, mice, headsets, webcams, mics, desks, chairs
- **Core Add-ons** — Extra storage, sleeved cables, expansion cards (part of system build)
- **Custom Thumbnails** — Upload your own images for each category
- **Smart Tools** — Auto-build by budget, bottleneck analyzer, FPS predictor, part comparison
- **Community Builds** — Pre-built configurations with voting

## Notes

- **Hot Reload** — Edit `src/App.jsx` and changes appear instantly in the browser
- **Storage** — Thumbnail uploads persist via `localStorage` in dev mode (the Claude artifact version uses Anthropic's persistent storage API)
- **No backend needed** — Everything runs client-side
