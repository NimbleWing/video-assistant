// MAIN world page hook: sniffs playlist URLs from page-level XHR/fetch and
// watches SPA navigations, forwarding everything to the isolated content
// script via window.postMessage. Replaces the userscript's unsafeWindow usage.
(() => {
  'use strict';
  const w = /** @type {any} */ (window);
  if (w.__rvPageHook) return;
  w.__rvPageHook = true;

  /** @type {Set<string>} */
  const sniffed = new Set();

  /**
   * @param {string} kind
   * @param {object} [data]
   */
  function post(kind, data) {
    try {
      window.postMessage(Object.assign({ __rvHook: 1, kind }, data), location.origin);
    } catch {}
  }

  /**
   * @param {unknown} url
   * @returns {boolean}
   */
  function isPlaylistUrl(url) {
    const s = String(url || '');
    if (!s || /^blob:/i.test(s)) return false;
    return /\/api\/hls\//i.test(s)
      || /\.m3u8(\?|#|$)/i.test(s)
      || /\/(?:index|master)\.(?:m3u8|jpg|jpeg|png)(\?|#|$)/i.test(s);
  }

  /**
   * @param {unknown} url
   * @param {string} via
   */
  function sniff(url, via) {
    try {
      if (!isPlaylistUrl(url)) return;
      const s = String(url);
      if (sniffed.has(s)) return;
      sniffed.add(s);
      // Always broadcast the full set so a late-attaching listener in the
      // isolated world still receives URLs captured at document_start.
      post('sniff', { urls: Array.from(sniffed), via });
    } catch {}
  }

  try {
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (/** @type {string} */ method, /** @type {string | URL} */ url) {
      sniff(url, 'XHR');
      this.addEventListener('load', () => {
        try { sniff(this.responseURL, 'XHR-final'); } catch {}
      });
      return origOpen.apply(this, /** @type {any} */ (arguments));
    };
  } catch {}

  try {
    const origFetch = window.fetch;
    window.fetch = function (/** @type {any} */ input) {
      const url = typeof input === 'string' ? input : (input && input.url);
      sniff(url, 'fetch');
      const p = origFetch.apply(this, /** @type {any} */ (arguments));
      if (p && typeof p.then === 'function') {
        p.then((/** @type {Response} */ resp) => { try { sniff(resp && resp.url, 'fetch-final'); } catch {} });
      }
      return p;
    };
  } catch {}

  /** @param {'pushState' | 'replaceState'} fn */
  const wrapHistory = (fn) => {
    try {
      const orig = history[fn];
      if (typeof orig !== 'function') return;
      /** @type {any} */
      const h = history;
      h[fn] = function () {
        const r = orig.apply(this, /** @type {any} */ (arguments));
        post('route', { path: location.pathname });
        return r;
      };
    } catch {}
  };
  wrapHistory('pushState');
  wrapHistory('replaceState');
})();
