// =============================================================================
//  vite.config.js
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Build configuration. Key SEO/perf decisions:
//
//  - manualChunks splits the giant App.jsx + parts.js bundle into chunks that
//    download in parallel and cache independently. Browsers can fetch up to ~6
//    chunks at once on HTTP/1.1 and unlimited on HTTP/2, so splitting helps
//    even when total bytes stay the same.
//
//  - Parts data is split BY CATEGORY: each src/data/parts/<cat>.js becomes
//    its own chunk via dynamic imports in src/data/parts-frontend.js. The
//    barrel src/data/parts.js (used only server-side by prerender) is never
//    pulled into the browser graph. Category landing pages only download the
//    one chunk they need; Builder/Upgrade fan-out to all of them.
//
//  - upgrade-page chunk isolates the scanner-facing UpgradePage so first-time
//    visitors to the homepage don't pay the cost of code only used after a
//    hardware scan.
//
//  - assetsInlineLimit set conservatively (4 KB) to avoid bloating index.html
//    with base64-encoded images that defeat browser image caching.
// =============================================================================

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],

  server: {
    port: 3000,
    open: true,
  },

  build: {
    minify: 'esbuild',
    sourcemap: false,
    cssCodeSplit: true,
    assetsInlineLimit: 4096,
    reportCompressedSize: true,

    // Bumped because parts.js (catalog data) is large by nature; warning
    // pollutes the build output without indicating a real problem now that
    // we've split it into its own chunk.
    chunkSizeWarningLimit: 4000,

    rollupOptions: {
      output: {
        // Function form gives us per-module decisions instead of static lists.
        // Order matters — the FIRST matching rule wins.
        manualChunks(id) {
          // Vendor splits — keep node_modules separate from app code so
          // upgrading a dep doesn't bust the app cache and vice-versa.
          if (id.includes('node_modules')) {
            if (id.includes('react-helmet-async')) return 'helmet';
            if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('/scheduler/')
            ) {
              return 'react-vendor';
            }
            // Other small node_modules go into a generic vendor chunk.
            return 'vendor';
          }

          // App code splits.
          // Per-category parts data: each /src/data/parts/<cat>.js gets its
          // own named chunk. They're dynamic-imported from parts-frontend.js,
          // so Rollup would split them anyway, but naming them parts-<cat>
          // makes them easy to spot in dist/assets/ and gives a stable
          // filename prefix for cache-control rules.
          {
            const m = id.match(/[\\/]src[\\/]data[\\/]parts[\\/]([a-z0-9-]+)\.js$/);
            if (m) return `parts-${m[1]}`;
          }
          if (id.includes('/src/data/asin')) return 'parts-data-asin';
          if (id.includes('/src/UpgradePage')) return 'upgrade-page';
          if (id.includes('/src/PageMeta')) return 'page-meta';

          // Everything else falls into the main app chunk (App.jsx + co).
        },
      },
    },
  },
});
