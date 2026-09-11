import { NS } from './constants.js';

const keyOf = (key) => `${NS}:${key}`;
const hasChromeStorage = typeof chrome !== 'undefined' && !!chrome.storage?.local;

// chrome.storage.local backed settings store, with a localStorage fallback so
// behavior matches the userscript even if the extension context is gone.
export const storage = {
  async get(key, fallback) {
    if (hasChromeStorage) {
      try {
        const raw = await chrome.storage.local.get(keyOf(key));
        const v = raw[keyOf(key)];
        return v === undefined ? fallback : v;
      } catch {
        return fallback;
      }
    }
    try {
      const raw = localStorage.getItem(keyOf(key));
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  async set(key, value) {
    if (hasChromeStorage) {
      try {
        await chrome.storage.local.set({ [keyOf(key)]: value });
        return;
      } catch {}
    }
    try { localStorage.setItem(keyOf(key), JSON.stringify(value)); } catch {}
  },
};
