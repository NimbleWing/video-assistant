// HLS 纯函数单测：清单生成 / 段号解析 / ffmpeg 参数（会话状态机依赖真实进程，不在此覆盖）。
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { buildFfmpegArgs, buildManifest, parseSegmentParam, segmentCount } from './hls.ts';

describe('segmentCount', () => {
  it('floor(duration/2)，至少 1 段', () => {
    expect(segmentCount(262.485)).toBe(131); // 131*2=262 ≤ 262.485
    expect(segmentCount(4)).toBe(2);
    expect(segmentCount(3.9)).toBe(1);
    expect(segmentCount(0.5)).toBe(1);
  });
});

describe('buildManifest', () => {
  it('VOD 头 + 相对段 URL + ENDLIST，EXTINF 逐段递减', () => {
    const m = buildManifest(5.5);
    const lines = m.trimEnd().split('\n');
    expect(lines[0]).toBe('#EXTM3U');
    expect(lines).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(lines).toContain('#EXT-X-TARGETDURATION:2');
    expect(lines.at(-1)).toBe('#EXT-X-ENDLIST');
    // floor(5.5/2)=2 段，均为整 2s（0.5s 尾巴不承诺，避免段超时）
    expect(lines.filter((l) => l.startsWith('seg/'))).toEqual(['seg/0.ts', 'seg/1.ts']);
    expect(lines).toContain('#EXTINF:2.000000,');
    expect(lines).not.toContain('#EXTINF:1.500000,');
  });

  it('整除时长不超额承诺（尾段 ≤2s 被截断）', () => {
    const m = buildManifest(6.1);
    expect(m.trimEnd().split('\n').filter((l) => l.startsWith('seg/'))).toHaveLength(3); // floor(6.1/2)=3
  });
});

describe('parseSegmentParam', () => {
  it('合法段号解析', () => {
    expect(parseSegmentParam('0.ts')).toBe(0);
    expect(parseSegmentParam('131.ts')).toBe(131);
  });

  it('非法输入返回 null', () => {
    expect(parseSegmentParam('131')).toBeNull();
    expect(parseSegmentParam('a.ts')).toBeNull();
    expect(parseSegmentParam('-1.ts')).toBeNull();
    expect(parseSegmentParam('13.1.ts')).toBeNull();
    expect(parseSegmentParam('')).toBeNull();
  });
});

describe('buildFfmpegArgs', () => {
  const dir = path.join('cache', '7');
  const base = buildFfmpegArgs('g:/v/a.mp4', 0, dir);

  it('转码模式（libx264 + 强制关键帧网格 + copyts + 临时段名）', () => {
    expect(base).toContain('libx264');
    expect(base).toContain('-force_key_frames');
    expect(base).toContain('-copyts');
    expect(base).toContain('split_by_time');
    expect(base).toContain('-hls_time');
    expect(base[base.indexOf('-hls_time') + 1]).toBe('2');
    expect(base).toContain(path.join(dir, '.%d.ts'));
    // 首段无 -ss
    expect(base).not.toContain('-ss');
  });

  it('重启段带 -ss（段号×段长）与 -start_number', () => {
    const args = buildFfmpegArgs('g:/v/a.mp4', 37, dir);
    expect(args[args.indexOf('-ss') + 1]).toBe('74');
    expect(args[args.indexOf('-start_number') + 1]).toBe('37');
  });
});
