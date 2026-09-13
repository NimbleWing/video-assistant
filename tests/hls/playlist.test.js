// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isPlaylistUrl, parseMasterPlaylist, parseMediaPlaylist, pickVariant, playlistCandidates } from '../../src/hls/playlist.js';

describe('isPlaylistUrl', () => {
  it('识别 m3u8 / api / 伪装图片', () => {
    expect(isPlaylistUrl('https://cdn.example.com/a/index.m3u8')).toBe(true);
    expect(isPlaylistUrl('https://rou.video/api/hls/abc123')).toBe(true);
    expect(isPlaylistUrl('https://cdn.example.com/v/x/index.png?token=t')).toBe(true);
    expect(isPlaylistUrl('https://cdn.example.com/v/x/master.jpg')).toBe(true);
  });
  it('排除 blob 与普通资源', () => {
    expect(isPlaylistUrl('blob:https://rou.video/x')).toBe(false);
    expect(isPlaylistUrl('https://cdn.example.com/a/seg1.ts')).toBe(false);
    expect(isPlaylistUrl('https://cdn.example.com/a/cover.jpeg2000')).toBe(false);
    expect(isPlaylistUrl('')).toBe(false);
    expect(isPlaylistUrl(null)).toBe(false);
    expect(isPlaylistUrl(undefined)).toBe(false);
  });
});

describe('playlistCandidates', () => {
  it('index/master 伪装变体去重生成', () => {
    const out = playlistCandidates('https://cdn.example.com/v/x/index.png');
    expect(out[0]).toBe('https://cdn.example.com/v/x/index.png');
    expect(out).toContain('https://cdn.example.com/v/x/index.jpg');
    expect(out).toContain('https://cdn.example.com/v/x/index.m3u8');
    expect(out).toContain('https://cdn.example.com/v/x/master.m3u8');
    expect(new Set(out).size).toBe(out.length); // 无重复
  });
  it('非 index/master 地址只回传自身', () => {
    expect(playlistCandidates('https://rou.video/api/hls/abc')).toEqual(['https://rou.video/api/hls/abc']);
  });
});

describe('parseMasterPlaylist', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,NAME="720p"',
    '720/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080,NAME="1080p"',
    '1080/index.m3u8',
  ].join('\n');
  it('解析变体并按高度降序', () => {
    const v = parseMasterPlaylist(text, 'https://cdn.example.com/v/abc/master.m3u8');
    expect(v.length).toBe(2);
    expect(v[0].height).toBe(1080);
    expect(v[0].label).toBe('1080p');
    expect(v[0].bandwidth).toBe(2000000);
    expect(v[0].url).toBe('https://cdn.example.com/v/abc/1080/index.m3u8');
    expect(v[0].prefix).toBe('https://cdn.example.com/v/abc/1080/');
    expect(v[1].height).toBe(720);
  });
  it('无 RESOLUTION 时从 NAME 猜高度', () => {
    const t = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,NAME="480p"\nx/index.m3u8';
    const v = parseMasterPlaylist(t, 'https://cdn.example.com/m.m3u8');
    expect(v[0].height).toBe(480);
    expect(v[0].label).toBe('480p');
  });
  it('空列表返回空数组', () => {
    expect(parseMasterPlaylist('#EXTM3U\n#EXTINF:1.0\na.ts', 'https://x/m.m3u8')).toEqual([]);
  });
});

describe('parseMediaPlaylist', () => {
  it('明文流：序号、时长累加、相对地址解析', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-MEDIA-SEQUENCE:42',
      '#EXTINF:2.5,',
      'seg0.ts',
      '#EXTINF:3.0,',
      'seg1.ts',
    ].join('\n');
    const m = parseMediaPlaylist(text, 'https://cdn.example.com/v/x/index.m3u8');
    expect(m.keyUri).toBe('');
    expect(m.duration).toBeCloseTo(5.5);
    expect(m.segments.length).toBe(2);
    expect(m.segments[0].seq).toBe(42);
    expect(m.segments[1].seq).toBe(43);
    expect(m.segments[0].url).toBe('https://cdn.example.com/v/x/seg0.ts');
    // 无明文 IV 时按序列号生成
    expect(m.segments[0].iv[15]).toBe(42);
    expect(m.segments[1].iv[15]).toBe(43);
  });

  it('AES-128：keyUri 解析与显式 IV', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="../keys/k.bin",IV=0x00000000000000000000000000000007',
      '#EXTINF:2.0,',
      's.ts',
    ].join('\n');
    const m = parseMediaPlaylist(text, 'https://cdn.example.com/v/x/index.m3u8');
    expect(m.keyUri).toBe('https://cdn.example.com/v/keys/k.bin');
    expect(Array.from(m.segments[0].iv.slice(12))).toEqual([0, 0, 0, 7]);
  });

  it('METHOD=NONE 清除密钥', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXTINF:1.0,',
      'a.ts',
    ].join('\n');
    const m = parseMediaPlaylist(text, 'https://cdn.example.com/i.m3u8');
    expect(m.keyUri).toBe('');
  });

  it('分段无查询串时继承 base 查询串（CDN 签名）', () => {
    const text = '#EXTM3U\n#EXTINF:1.0,\ns0.ts';
    const m = parseMediaPlaylist(text, 'https://cdn.example.com/v/i.m3u8?sign=abc');
    expect(m.segments[0].url).toBe('https://cdn.example.com/v/s0.ts?sign=abc');
  });

  it('EXTINF 与其地址间允许注释行', () => {
    const text = '#EXTM3U\n#EXTINF:1.0,\n#EXT-X-BITRATE:100\ns0.ts';
    const m = parseMediaPlaylist(text, 'https://cdn.example.com/v/i.m3u8');
    expect(m.segments.length).toBe(1);
  });
});

describe('pickVariant', () => {
  const variants = parseMasterPlaylist([
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720,NAME="720p"',
    '720/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080,NAME="1080p"',
    '1080/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=854x480,NAME="480p"',
    '480/index.m3u8',
  ].join('\n'), 'https://cdn.example.com/v/abc/master.m3u8');
  it('偏好 0 → 最高档', () => {
    expect(pickVariant(variants, 0)?.height).toBe(1080);
  });
  it('≤偏好的最高档', () => {
    expect(pickVariant(variants, 720)?.height).toBe(720);
    expect(pickVariant(variants, 900)?.height).toBe(720);
    expect(pickVariant(variants, 1080)?.height).toBe(1080);
  });
  it('全部更高时取可用最低档', () => {
    expect(pickVariant(variants, 360)?.height).toBe(480);
  });
  it('空列表返回 null', () => {
    expect(pickVariant([], 720)).toBeNull();
  });
});