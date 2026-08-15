# Codespaces / Dev Container

A browser-based dev environment for rigfinder. Node 20 (matches CI), `npm ci`
on create, and Vite's port 3000 forwarded so the preview opens automatically.

## Start it

1. GitHub → this repo → green **Code** button → **Codespaces** tab →
   **Create codespace on `<branch>`**.
2. Wait for the build + `npm ci` (first time ~1–2 min; skips the Puppeteer
   Chromium download on purpose).
3. In the terminal: `npm run dev`.
4. A **Simple Browser** preview opens on port 3000. Edit files under `src/` and
   the page hot-reloads. Real catalog data loads from the committed
   `src/data/parts/*.js` — no ingest needed.

To open the preview in a real browser tab instead, use the **Ports** panel →
port 3000 → globe icon.

## What works

- `npm run dev` — live-reload dev server with the full, real catalog.
- Editing layout/components under `src/`.
- `npm run build:fast` — `vite build` only (no prerender step).
- `npm test` — `node --test`.

## What does NOT work here (works locally)

- **`npm run build` (full) / `prerender.cjs`** — needs Puppeteer + a Chromium
  browser, which the container skips downloading to keep creation fast. Use
  `build:fast` for a dev build. If you truly need prerender in the codespace:
  `npx puppeteer browsers install chrome` first, then `node prerender.cjs`.
- **Ingest / verify / deploy scripts** (`sftp-ingest`, `verify-catalog-asins.js`,
  Newegg refresh, Epik deploy, etc.) — these need credentials (DataForSEO, Amazon
  Creators, SFTP) that live in Actions secrets / a local `.env`, not in the
  codespace. They run in CI, not here.
- **Auto-open native browser** — Vite's `open: true` can't launch a browser
  inside the container; it prints a harmless warning. Codespaces' port
  forwarding opens the preview instead.

## Codespaces free hours (60/mo on the 2-core machine)

Billing is by **wall-clock time the codespace is running**, not by CPU work — an
idle-but-running codespace still burns hours.

- **It auto-stops after 30 min idle** (default). That's the main safety net.
- **Stop it when done:** Codespaces list (github.com/codespaces) → `⋯` → **Stop
  codespace**. Stopped = 0 compute hours (only a little storage).
- **Leaving `npm run dev` running does not by itself burn extra hours** — the
  clock is the codespace being *on*, not the process. But an active terminal/dev
  server resets the idle timer, so a forgotten `npm run dev` in an open tab can
  keep it from auto-stopping. Close the tab or stop the codespace.
- **Stay on the 2-core machine.** A 4-core burns hours 2x faster, 8-core 4x.
- Delete codespaces you're done with to free the storage quota.
