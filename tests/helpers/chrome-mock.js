import { vi } from 'vitest';

/**
 * 内存版 chrome.* mock：storage.local（KV）、runtime 消息总线。
 * 用 installChromeMock() 安装到全局，返回操作句柄。
 *
 * @typedef {Object} ChromeMock
 * @property {any} chrome
 * @property {Map<string, any>} store storage.local 后端
 * @property {Set<(msg: any) => void>} messageListeners runtime.onMessage 订阅者
 * @property {import('vitest').Mock} sendMessage runtime.sendMessage（可编程应答）
 * @property {(msg: any) => void} emitMessage 向所有 onMessage 订阅者派发消息
 * @property {() => void} restore 卸载
 */

/** @returns {ChromeMock} */
export function installChromeMock() {
  /** @type {Map<string, any>} */
  const store = new Map();
  /** @type {Set<(msg: any) => void>} */
  const messageListeners = new Set();
  /** @type {Set<(changes: Record<string, { oldValue?: any, newValue?: any }>, area: string) => void>} */
  const storageListeners = new Set();
  const sendMessage = vi.fn(async (_msg) => ({ ok: true }));

  const fireStorage = (/** @type {Record<string, { oldValue?: any, newValue?: any }>} */ changes) => {
    for (const fn of storageListeners) fn(changes, 'local');
  };

  const chrome = {
    storage: {
      local: {
        /** @param {string | string[] | null | undefined} [key] */
        async get(key) {
          if (key == null) return Object.fromEntries(store);
          if (typeof key === 'string') return store.has(key) ? { [key]: store.get(key) } : {};
          /** @type {Record<string, any>} */
          const out = {};
          for (const k of key) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        /** @param {Record<string, any>} obj */
        async set(obj) {
          /** @type {Record<string, { oldValue?: any, newValue?: any }>} */
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: store.get(k), newValue: v };
            store.set(k, v);
          }
          fireStorage(changes);
        },
        /** @param {string | string[]} key */
        async remove(key) {
          const keys = Array.isArray(key) ? key : [key];
          /** @type {Record<string, { oldValue?: any, newValue?: any }>} */
          const changes = {};
          for (const k of keys) {
            if (store.has(k)) changes[k] = { oldValue: store.get(k), newValue: undefined };
            store.delete(k);
          }
          fireStorage(changes);
        },
      },
      onChanged: {
        /** @param {(changes: any, area: string) => void} fn */
        addListener(fn) { storageListeners.add(fn); },
        /** @param {(changes: any, area: string) => void} fn */
        removeListener(fn) { storageListeners.delete(fn); },
      },
    },
    runtime: {
      onMessage: {
        /** @param {(msg: any) => void} fn */
        addListener(fn) { messageListeners.add(fn); },
        /** @param {(msg: any) => void} fn */
        removeListener(fn) { messageListeners.delete(fn); },
      },
      sendMessage,
      getManifest: () => ({ version: '1.7.0-test' }),
    },
  };

  vi.stubGlobal('chrome', chrome);
  return {
    chrome,
    store,
    messageListeners,
    sendMessage,
    emitMessage(msg) { for (const fn of messageListeners) fn(msg); },
    restore() { vi.unstubAllGlobals(); },
  };
}
