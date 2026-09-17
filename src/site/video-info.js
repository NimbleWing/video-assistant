import { errText, toAbsolute } from '../core/utils.js';
import { Logger } from '../core/logger.js';

/**
 * @typedef {Object} PageInfo
 * @property {string} id
 * @property {string} name
 * @property {string} masterM3u8
 * @property {string} videoUrl
 * @property {number} duration
 * @property {string} seriesName
 * @property {string} seriesCoverUrl
 * @property {string} coverUrl
 */

/** @returns {any} __NEXT_DATA__ 的 JSON；无或解析失败为 null */
function getNextData() {
  const script = document.getElementById('__NEXT_DATA__');
  if (!script) return null;
  try { return JSON.parse(script.textContent || ''); } catch { return null; }
}

// Raw Next.js pageProps — used by batch mode to read listing/series data.
/** @returns {any} */
export function getPageProps() {
  const d = getNextData();
  return d?.props?.pageProps || d?.pageProps || {};
}

/**
 * 站点对播放地址的简单位移加密：base64 后逐字符减 k。
 * @param {any} ev { d: base64, k: number }
 * @returns {any} { videoUrl } 或 null
 */
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

/** @returns {string} /v/<id> 中的视频 id */
export function videoIdFromPath() {
  const m = location.pathname.match(/^\/v\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * @param {any} data __NEXT_DATA__ JSON
 * @returns {PageInfo | null}
 */
function videoInfoFromData(data) {
  const pageProps = data?.props?.pageProps || data?.pageProps;
  const video = pageProps?.video;
  if (!video) return null;
  const decoded = decodeEv(pageProps.ev);
  if (!decoded) return null;
  const videoUrl = decoded.videoUrl ? toAbsolute(decoded.videoUrl) : '';
  const series = pageProps?.series;
  return {
    id: video.id,
    name: video.name || video.nameZh || 'unknown',
    masterM3u8: videoUrl,
    videoUrl,
    duration: video.duration || 0,
    seriesName: series?.nameZh || series?.name || '',
    seriesCoverUrl: series?.coverImageUrl || '',
    coverUrl: video.coverImageUrl || '',
  };
}

/**
 * DOM 兜底：站点已移除 __NEXT_DATA__（反爬），播放页信息从页面结构提取。
 * h1 形如「剧名 · 第 1 集」；og:image 为封面。
 * @returns {PageInfo | null}
 */
function videoInfoFromDom() {
  const id = videoIdFromPath();
  if (!id) return null;
  const h1 = (document.querySelector('h1')?.textContent || '').trim();
  if (!h1) return null;
  const m = h1.match(/^(.+?)\s*[·•]\s*第\s*(\d+)\s*集$/);
  const seriesName = m ? m[1].trim() : '';
  const name = m ? `${seriesName} 第${m[2]}集` : h1;
  const cover = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
  return {
    id,
    name,
    masterM3u8: '',
    videoUrl: '',
    duration: 0,
    seriesName,
    seriesCoverUrl: '',
    coverUrl: cover,
  };
}

/** @returns {PageInfo | null} 页面数据中的当前视频信息（与地址栏 id 一致才采信） */
export function getVideoInfo() {
  const info = videoInfoFromData(getNextData());
  const id = videoIdFromPath();
  if (info && (!id || info.id === id)) return info;
  return videoInfoFromDom();
}

/** @returns {Promise<PageInfo | null>} 本地解析失败时重新抓取页面 HTML 兜底 */
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
    Logger.warn('INFO', '刷新页面数据失败', errText(e));
    return null;
  }
}
