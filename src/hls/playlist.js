import { resolveUrl, toAbsolute } from '../core/utils.js';
import { hexToBytes, sequenceIv } from '../core/crypto.js';

export function isPlaylistUrl(url) {
  const s = String(url || '');
  if (!s || /^blob:/i.test(s)) return false;
  return /\/api\/hls\//i.test(s)
    || /\.m3u8(\?|#|$)/i.test(s)
    || /\/(?:index|master)\.(?:m3u8|jpg|jpeg|png)(\?|#|$)/i.test(s);
}

export function playlistCandidates(videoUrl) {
  const out = [];
  const add = (u) => { if (u && !out.includes(u)) out.push(u); };
  const abs = toAbsolute(videoUrl);
  add(abs);
  add(videoUrl);
  try {
    const u = new URL(abs);
    const names = ['index.png', 'index.jpg', 'index.m3u8', 'master.m3u8'];
    const m = u.pathname.match(/\/(index|master)\.(png|jpg|jpeg|m3u8)$/i);
    if (m) {
      for (const name of names) {
        const alt = new URL(abs);
        alt.pathname = u.pathname.replace(/\/(index|master)\.(png|jpg|jpeg|m3u8)$/i, `/${name}`);
        add(alt.href);
      }
    }
  } catch {}
  return out;
}

export function parseMasterPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const meta = line.slice('#EXT-X-STREAM-INF:'.length);
    let next = '';
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && !lines[j].trim().startsWith('#')) { next = lines[j].trim(); break; }
    }
    if (!next) continue;
    const res = (meta.match(/RESOLUTION=(\d+x\d+)/i) || [])[1] || '';
    const bw = Number((meta.match(/BANDWIDTH=(\d+)/i) || [])[1] || 0);
    const name = (meta.match(/NAME="?([^",]+)"?/i) || [])[1] || '';
    const height = Number((res.split('x')[1] || name.match(/(\d{3,4})/)?.[1] || 0));
    variants.push({
      label: name || (height ? `${height}p` : 'Source'),
      resolution: res,
      bandwidth: bw,
      height: height || 0,
      url: resolveUrl(baseUrl, next),
      prefix: resolveUrl(baseUrl, next.replace(/[^/]+$/, '')),
    });
  }
  variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  return variants;
}

export function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let keyUri = '';
  let keyIv = null;
  let seq = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      seq = Number(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const method = (line.match(/METHOD=([^,]+)/) || [])[1];
      if (method === 'NONE') { keyUri = ''; keyIv = null; }
      else if (method === 'AES-128') {
        const uri = (line.match(/URI="([^"]+)"/) || [])[1] || '';
        const ivHex = (line.match(/IV=0x([0-9a-f]+)/i) || [])[1];
        keyUri = resolveUrl(baseUrl, uri);
        keyIv = ivHex ? hexToBytes(ivHex) : null;
      }
    } else if (line.startsWith('#EXTINF')) {
      let path = '';
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() && !lines[j].trim().startsWith('#')) { path = lines[j].trim(); break; }
      }
      if (!path) continue;
      const iv = keyIv || sequenceIv(seq);
      const duration = Number((line.match(/#EXTINF:([\d.]+)/) || [])[1] || 0);
      segments.push({ url: resolveUrl(baseUrl, path), iv, seq, duration });
      seq++;
    }
  }
  const duration = segments.reduce((sum, seg) => sum + (Number(seg.duration) || 0), 0);
  return { segments, keyUri, duration };
}
