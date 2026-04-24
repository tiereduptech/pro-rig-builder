import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

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

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
