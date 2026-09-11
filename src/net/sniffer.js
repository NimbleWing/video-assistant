import { Logger } from '../core/logger.js';
import { isPlaylistUrl } from '../hls/playlist.js';

export const sniffedUrls = new Set();

export function maybeSniff(url, via) {
  if (!isPlaylistUrl(url)) return;
  const s = String(url);
  if (sniffedUrls.has(s)) return;
  sniffedUrls.add(s);
  Logger.info('SNIFF', `捕获 ${via}: ${s}`);
}

export function collectSniffedFromPerformance() {
  try {
    performance.getEntriesByType('resource').forEach((entry) => {
      maybeSniff(entry.name, 'Performance');
    });
  } catch {}
}

// Receives sniff results from the MAIN-world page hook (src/page-hook.js).
// The hook always broadcasts the full set, so late listeners lose nothing.
export function installPageHookListener() {
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__rvHook !== 1 || d.kind !== 'sniff') return;
    const urls = Array.isArray(d.urls) ? d.urls : [d.url];
    for (const u of urls) maybeSniff(u, d.via || 'hook');
  });
}
