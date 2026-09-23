export function fmtSize(n?: number | null): string {
  if (!n) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function fmtDur(s?: number | null): string {
  if (!s || s <= 0) return '';
  const sec = Math.round(s);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

export function fmtTime(ms?: number | null): string {
  return ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '-';
}

/** 卡片用短日期（无时间部分）。 */
export function fmtDate(ms?: number | null): string {
  return ms ? new Date(ms).toLocaleDateString('zh-CN') : '-';
}
