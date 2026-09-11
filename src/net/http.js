import { toAbsolute } from '../core/utils.js';
import { unwrapIfNeeded } from './rou-png.js';

// Content-script fetch replaces both the userscript's unsafeWindow.fetch path
// and the GM_xmlhttpRequest fallback: with host_permissions for the CDN hosts,
// cross-origin requests bypass CORS while keeping the page origin
// (Origin/Referer = https://rou.video), which the CDN expects.
async function fetchOnce(url, responseType) {
  const resp = await fetch(toAbsolute(url), {
    method: 'GET',
    credentials: 'omit',
    mode: 'cors',
    redirect: 'follow',
    referrer: location.href,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return responseType === 'arraybuffer' ? await resp.arrayBuffer() : await resp.text();
}

export async function fetchRaw(url) {
  const raw = await fetchOnce(url, 'arraybuffer');
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
}

export async function fetchBuffer(url) {
  return unwrapIfNeeded(await fetchRaw(url));
}

export async function fetchText(url) {
  const u8 = await fetchBuffer(url);
  return new TextDecoder('utf-8').decode(u8);
}
