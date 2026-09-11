import { toAbsolute } from '../core/utils.js';
import { Logger } from '../core/logger.js';

function getNextData() {
  const script = document.getElementById('__NEXT_DATA__');
  if (!script) return null;
  try { return JSON.parse(script.textContent); } catch { return null; }
}

// Raw Next.js pageProps — used by batch mode to read listing/series data.
export function getPageProps() {
  const d = getNextData();
  return d?.props?.pageProps || d?.pageProps || {};
}

function decodeEv(ev) {
  if (!ev || !ev.d || !ev.k) return null;
  try {
    const decoded = atob(ev.d);
    const jsonStr = decoded.split('').map((c) => String.fromCharCode(c.charCodeAt(0) - ev.k)).join('');
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

export function videoIdFromPath() {
  const m = location.pathname.match(/^\/v\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

function videoInfoFromData(data) {
  const pageProps = data?.props?.pageProps || data?.pageProps;
  const video = pageProps?.video;
  if (!video) return null;
  const decoded = decodeEv(pageProps.ev);
  if (!decoded) return null;
  const videoUrl = decoded.videoUrl ? toAbsolute(decoded.videoUrl) : '';
  return {
    id: video.id,
    name: video.name || video.nameZh || 'unknown',
    masterM3u8: videoUrl,
    videoUrl,
    duration: video.duration || 0,
  };
}

export function getVideoInfo() {
  const info = videoInfoFromData(getNextData());
  const id = videoIdFromPath();
  if (info && (!id || info.id === id)) return info;
  return null;
}

export async function getVideoInfoFresh() {
  const local = getVideoInfo();
  if (local) return local;
  const id = videoIdFromPath();
  if (!id) return null;
  try {
    const html = await fetch(location.href, { credentials: 'include', cache: 'no-cache' }).then((r) => r.text());
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
    if (!match) return null;
    return videoInfoFromData(JSON.parse(match[1]));
  } catch (e) {
    Logger.warn('INFO', '刷新页面数据失败', e.message);
    return null;
  }
}
