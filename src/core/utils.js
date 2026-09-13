/**
 * 相对地址转绝对地址；解析失败时原样返回。
 * @param {string} url
 * @returns {string}
 */
export function toAbsolute(url) {
  try { return new URL(String(url || ''), location.href).href; } catch { return String(url || ''); }
}

/**
 * 按 base 解析播放列表中的相对路径；路径无查询串时继承 base 的查询串（CDN 签名参数）。
 * @param {string} base
 * @param {string} path
 * @returns {string}
 */
export function resolveUrl(base, path) {
  if (/^https?:\/\//i.test(path)) return path;
  try {
    const resolved = new URL(path, base);
    if (!resolved.search && path.indexOf('?') < 0) {
      const baseU = new URL(base);
      if (baseU.search) resolved.search = baseU.search;
    }
    return resolved.href;
  } catch { return path; }
}

// Windows 保留设备名（按主名判定，CON.mp4 同样被保留）
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 清洗文件/目录名：去除非法字符并压缩空白，最长 120 字符。
 * 尾部点/空格会被 Windows 静默剥除（不处理会导致已下载判定名与落盘名不一致），
 * 保留设备名加下划线前缀。
 * @param {unknown} name
 * @returns {string}
 */
export function sanitizeName(name) {
  let s = String(name || 'video')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120)
    .replace(/[. ]+$/, '');
  if (!s) s = 'video';
  if (WIN_RESERVED.test(s.split('.')[0])) s = `_${s}`;
  return s;
}

/**
 * 人性化字节数。
 * @param {number} n
 * @returns {string}
 */
export function formatBytes(n) {
  if (!n || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/**
 * 剩余时间显示：59s / 3m 5s / 1h 2m。
 * @param {number} seconds
 * @returns {string}
 */
export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * 时长显示：m:ss 或 h:mm:ss。
 * @param {number} sec
 * @returns {string}
 */
export function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * HTML 转义（面板模板注入安全）。
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * catch 块中的 unknown 转可读消息（strict 模式下替代 e?.message || e）。
 * @param {unknown} e
 * @returns {string}
 */
export function errText(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 是否为用户主动中止（AbortError）。
 * @param {unknown} e
 * @returns {boolean}
 */
export function isAbortError(e) {
  return e instanceof DOMException && e.name === 'AbortError';
}

/**
 * 页面中的第一个 video 元素。
 * @returns {HTMLVideoElement | null}
 */
export function pageVideo() {
  return document.querySelector('video');
}

/**
 * 事件目标是否为输入类控件（此时快捷键不生效）。
 * @param {unknown} el
 * @returns {boolean}
 */
export function isTypingTarget(el) {
  if (!el || el === document.body || el === document.documentElement) return false;
  const tag = ((/** @type {HTMLElement} */ (el).tagName) || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return !!(/** @type {HTMLElement} */ (el).isContentEditable);
}

/**
 * 锚点下载回退路径。
 * @param {Blob} blob
 * @param {string} filename
 * @returns {string} objectURL（调用方负责后续释放）
 */
export function saveBlobAs(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  return url;
}
