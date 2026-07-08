import React from 'react'
import ReactDOM from 'react-dom/client'
import { HelmetProvider } from 'react-helmet-async'
import { loadPartsForPath } from './data/parts-frontend.js'

// Polyfill window.storage for local dev (the Claude artifact has persistent storage,
// but locally we'll use localStorage as a fallback)
if (!window.storage) {
  window.storage = {
    async get(key) {
      const val = localStorage.getItem(`rigfinder:${key}`);
      return val ? { key, value: val, shared: false } : null;
    },
    async set(key, value) {
      localStorage.setItem(`rigfinder:${key}`, value);
      return { key, value, shared: false };
    },
    async delete(key) {
      localStorage.removeItem(`rigfinder:${key}`);
      return { key, deleted: true, shared: false };
    },
    async list(prefix = '') {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith(`rigfinder:${prefix}`)) {
          keys.push(k.replace('rigfinder:', ''));
        }
      }
      return { keys, prefix, shared: false };
    }
  };
}

// Pre-load just the parts categories this route needs (or all, for routes
// that surface the whole catalog) before mounting App. This is the gate that
// makes per-category code splitting actually save bytes: App.jsx runs its
// module-init code (SEED_PARTS / P / ALL_RETAILERS) AFTER the relevant chunk
// has been fetched, so first paint sees populated data without a flash.
//
// We start the App.jsx import in parallel with the data load so the two
// network requests overlap. App.jsx is bundled into the main chunk and the
// parts chunks are siblings — both arrive concurrently.
const initialPath = window.location.pathname || "/";
const partsPromise = loadPartsForPath(initialPath);
const appPromise   = import('./App.jsx');

Promise.all([partsPromise, appPromise]).then(([, { default: App }]) => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <HelmetProvider>
        <App />
      </HelmetProvider>
    </React.StrictMode>
  )
}).catch(err => {
  // If the initial parts load fails (e.g. a chunk 404s) we still want SOMETHING
  // on screen. Render App with whatever did load.
  console.error('Initial parts load failed, mounting App anyway:', err);
  import('./App.jsx').then(({ default: App }) => {
    ReactDOM.createRoot(document.getElementById('root')).render(
      <React.StrictMode>
        <HelmetProvider>
          <App />
        </HelmetProvider>
      </React.StrictMode>
    );
  });
});
