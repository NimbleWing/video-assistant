import { toAbsolute } from '../core/utils.js';
import { unwrapIfNeeded } from './rou-png.js';

// Content-script fetch replaces both the userscript's unsafeWindow.fetch path
// and the GM_xmlhttpRequest fallback: with host_permissions for the CDN hosts,
// cross-origin requests bypass CORS while keeping the page origin
// (Origin/Referer = https://rou.video), which the CDN expects.
async function fetchOnce(url, responseType, { signal, timeoutMs } = {}) {
  const signals = [];
  if (signal) signals.push(signal);
  if (timeoutMs) signals.push(AbortSignal.timeout(timeoutMs));
  const resp = await fetch(toAbsolute(url), {
    method: 'GET',
    credentials: 'omit',
    mode: 'cors',
    redirect: 'follow',
    referrer: location.href,
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return responseType === 'arraybuffer' ? await resp.arrayBuffer() : await resp.text();
}

export async function fetchRaw(url, { signal, timeoutMs = 60000 } = {}) {
  const raw = await fetchOnce(url, 'arraybuffer', { signal, timeoutMs });
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
}

export async function fetchBuffer(url, { signal, timeoutMs } = {}) {
  return unwrapIfNeeded(await fetchRaw(url, { signal, timeoutMs }));
}

export async function fetchText(url, { signal } = {}) {
  const u8 = await fetchBuffer(url, { signal, timeoutMs: 30000 });
  return new TextDecoder('utf-8').decode(u8);
}
