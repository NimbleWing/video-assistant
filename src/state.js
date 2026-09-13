import { RATES } from './core/constants.js';
import { storage } from './core/storage.js';

/**
 * @typedef {Object} DownloadUiState
 * @property {boolean} running
 * @property {boolean} finished
 * @property {number} [done]
 * @property {number} [total]
 * @property {number} [bytes]
 * @property {number} [speed]
 * @property {number} [eta]
 * @property {number} [pct]
 * @property {string} [error]
 * @property {string} [filename]
 * @property {boolean} [skipped]
 * @property {boolean} [saving]
 * @property {number} [savePct]
 */

/**
 * @typedef {Object} AppState
 * @property {boolean} booting
 * @property {boolean} starting startDownload 入口同步守卫（防双击并发下载）
 * @property {boolean} ready
 * @property {boolean} open
 * @property {import('./hls/playlist.js').Variant[]} qualities
 * @property {DownloadUiState | null} download
 * @property {AbortController | null} abort
 * @property {import('./site/video-info.js').PageInfo | null} page
 * @property {boolean} holdBoost
 * @property {number} holdRate
 * @property {number} qualityHeight 清晰度偏好（0 = 最高）
 * @property {string} lastPath
 */

/** @type {AppState} */
export const state = {
  booting: false,
  starting: false,
  ready: false,
  open: false,
  qualities: [],
  download: null,
  abort: null,
  page: null,
  holdBoost: false,
  holdRate: 2,
  qualityHeight: 0,
  lastPath: location.pathname,
};

/** @returns {Promise<void>} */
export async function loadSettings() {
  state.holdBoost = (await storage.get('holdBoost', false)) === true;
  const rate = Number(await storage.get('holdRate', 2));
  state.holdRate = RATES.includes(rate) ? rate : 2;
  state.qualityHeight = Math.max(0, Number(await storage.get('qualityHeight', 0)) || 0);
}

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function saveSetting(key, value) {
  await storage.set(key, value);
}
