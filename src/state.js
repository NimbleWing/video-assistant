import { RATES } from './core/constants.js';
import { storage } from './core/storage.js';

export const state = {
  booting: false,
  ready: false,
  open: false,
  qualities: [],
  download: null,
  abort: null,
  page: null,
  holdBoost: false,
  holdRate: 2,
  lastPath: location.pathname,
};

export async function loadSettings() {
  state.holdBoost = (await storage.get('holdBoost', false)) === true;
  const rate = Number(await storage.get('holdRate', 2));
  state.holdRate = RATES.includes(rate) ? rate : 2;
}

export async function saveSetting(key, value) {
  await storage.set(key, value);
}
