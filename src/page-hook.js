// MAIN world page hook: sniffs playlist URLs from page-level XHR/fetch and
// watches SPA navigations, forwarding everything to the isolated content
// script via window.postMessage. Replaces the userscript's unsafeWindow usage.
(() => {
  'use strict';
  if (window.__rvPageHook) return;
  window.__rvPageHook = true;

  const sniffed = new Set();

  function post(kind, data) {
    try {
      window.postMessage(Object.assign({ __rvHook: 1, kind }, data), location.origin);
    } catch {}
  }

  function isPlaylistUrl(url) {
    const s = String(url || '');
    if (!s || /^blob:/i.test(s)) return false;
    return /\/api\/hls\//i.test(s)
      || /\.m3u8(\?|#|$)/i.test(s)
      || /\/(?:index|master)\.(?:m3u8|jpg|jpeg|png)(\?|#|$)/i.test(s);
  }

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
    XMLHttpRequest.prototype.open = function (method, url) {
      sniff(url, 'XHR');
      this.addEventListener('load', () => {
        try { sniff(this.responseURL, 'XHR-final'); } catch {}
      });
      return origOpen.apply(this, arguments);
    };
  } catch {}

  try {
    const origFetch = window.fetch;
    window.fetch = function (input) {
      const url = typeof input === 'string' ? input : (input && input.url);
      sniff(url, 'fetch');
      const p = origFetch.apply(this, arguments);
      if (p && typeof p.then === 'function') {
        p.then((resp) => { try { sniff(resp && resp.url, 'fetch-final'); } catch {} });
      }
      return p;
    };
  } catch {}

  const wrapHistory = (fn) => {
    try {
      const orig = history[fn];
      if (typeof orig !== 'function') return;
      history[fn] = function () {
        const r = orig.apply(this, arguments);
        post('route', { path: location.pathname });
        return r;
      };
    } catch {}
  };
  wrapHistory('pushState');
  wrapHistory('replaceState');
})();
