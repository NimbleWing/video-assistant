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
  const m = Math.floor(s / 60);
  const ss = Math.round(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

export function fmtTime(ms?: number | null): string {
  return ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '-';
}
