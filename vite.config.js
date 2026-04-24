import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    open: true
  },
  build: {
    // Enable minification (default terser)
    minify: 'esbuild',
    // Generate source maps for production debugging (SEO tooling benefit, no perf cost)
    sourcemap: false,
    // Chunk splitting strategy: separate vendor libs from app code
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'helmet': ['react-helmet-async']
        }
      }
    },
    // Inline small assets (< 4KB) to reduce requests
    assetsInlineLimit: 4096,
    // Enable CSS code splitting
    cssCodeSplit: true,
    // Report compressed size (helps verify chunks working)
    reportCompressedSize: true
  }
})
