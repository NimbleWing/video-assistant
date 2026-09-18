import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../lib/db.ts';
import { dlStatusCounts, listDownloads, upsertDownload } from './downloads.ts';

beforeEach(() => {
  db.exec('DELETE FROM downloads');
});

function upsert(partial: Partial<Parameters<typeof upsertDownload>[0]> = {}) {
  return upsertDownload({
    videoId: 'v1',
    status: 'downloading',
    ...partial,
  });
}

describe('upsertDownload', () => {
  it('开始下载：downloading 且 attempts+1', () => {
    upsert();
    upsert();
    const r = listDownloads({}).items[0]!;
    expect(r.status).toBe('downloading');
    expect(r.attempts).toBe(2);
  });

  it('终态不改 attempts；可 NULL 字段缺省保留旧值', () => {
    upsert({ name: '标题', seriesName: '剧集', quality: 720 });
    upsert({ status: 'failed', error: '网络中断' });
    const r = listDownloads({ status: 'failed' }).items[0]!;
    expect(r.attempts).toBe(1);
    expect(r.series_name).toBe('剧集');
    expect(r.quality).toBe(720);
    expect(r.error).toBe('网络中断');
  });

  it('NOT NULL 字段（name/filename）缺省时以默认值覆盖', () => {
    upsert({ name: '标题', filename: '剧/标.mp4' });
    upsert({ status: 'failed' });
    const r = listDownloads({}).items[0]!;
    expect(r.name).toBe('v1');
    expect(r.filename).toBe('');
  });

  it('完成回填 size；再次失败 error 更新、size 保留', () => {
    upsert({ status: 'complete', size: 1024 });
    upsert({ status: 'failed', error: 'x' });
    const r = listDownloads({}).items[0]!;
    expect(r.status).toBe('failed');
    expect(r.size).toBe(1024);
    expect(r.error).toBe('x');
  });

  it('不同 (site, video_id) 各自成行', () => {
    upsert();
    upsert({ site: 'other.site' });
    expect(listDownloads({}).total).toBe(2);
  });
});

describe('listDownloads', () => {
  it('q 匹配 name 与 series_name', () => {
    upsert({ videoId: 'a', name: '甲视频', seriesName: null });
    upsert({ videoId: 'b', name: '乙视频', seriesName: '甲剧集' });
    expect(listDownloads({ q: '甲' }).total).toBe(2);
    expect(listDownloads({ q: '甲剧集' }).total).toBe(1);
  });

  it('counts 汇总各状态', () => {
    upsert({ videoId: 'a', status: 'failed' });
    upsert({ videoId: 'b', status: 'failed' });
    upsert({ videoId: 'c', status: 'complete' });
    expect(dlStatusCounts()).toEqual({ failed: 2, complete: 1 });
    expect(listDownloads({}).counts).toEqual({ failed: 2, complete: 1 });
  });

  it('分页', () => {
    for (let i = 0; i < 5; i++) upsert({ videoId: `v${i}` });
    expect(listDownloads({ size: 2, page: 2 }).items).toHaveLength(2);
  });
});
