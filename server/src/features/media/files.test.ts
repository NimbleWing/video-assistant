import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../lib/db.ts';
import {
  getFileBasic,
  listVideos,
  listVolumes,
  mediaStats,
  purgeMissing,
  queryExists,
  upsertFileRecorded,
  upsertFileScanned,
} from './files.ts';

const T0 = 1_700_000_000_000;

function scanned(partial: Partial<Parameters<typeof upsertFileScanned>[0]> = {}) {
  return {
    path: 'd:/v/a.mp4',
    stem: 'a',
    ext: 'mp4',
    type: 'video' as const,
    size: 100,
    mtime: 1,
    volume: 'd:',
    seen: T0,
    ...partial,
  };
}

beforeEach(() => {
  db.exec('DELETE FROM files');
});

describe('upsertFileScanned', () => {
  it('重复扫描只刷新 size/mtime/last_seen，不触碰 video_id/source', () => {
    upsertFileScanned(scanned());
    upsertFileRecorded({ path: 'D:\\v\\a.mp4', size: 200, videoId: 'vid1', duration: 61 });
    upsertFileScanned(scanned({ size: 300, mtime: 2, seen: T0 + 5 }));
    const r = listVideos({}).items[0]!;
    expect(r.size).toBe(300);
    expect(r.mtime).toBe(2);
    expect(r.last_seen).toBe(T0 + 5);
    expect(r.video_id).toBe('vid1');
    expect(r.source).toBe('recorded');
  });
});

describe('upsertFileRecorded', () => {
  it('新行：归一化路径 + recorded + video_id/duration', () => {
    upsertFileRecorded({ path: 'G:\\肉视频\\剧\\第1集.MP4', size: 5, videoId: 'v9', duration: 12.5 });
    const r = listVideos({}).items[0]!;
    expect(r.path).toBe('g:/肉视频/剧/第1集.mp4');
    expect(r.stem).toBe('第1集');
    expect(r.ext).toBe('mp4');
    expect(r.volume).toBe('g:');
    expect(r.video_id).toBe('v9');
    expect(r.duration).toBe(12.5);
    expect(r.source).toBe('recorded');
  });
  it('已存在行：size 为 0 不覆盖旧值，字段 COALESCE 合并', () => {
    upsertFileScanned(scanned({ size: 100 }));
    upsertFileRecorded({ path: 'd:/v/a.mp4', size: 0 });
    const r = listVideos({}).items[0]!;
    expect(r.size).toBe(100);
    expect(r.source).toBe('recorded');
  });
  it('未知扩展名静默忽略', () => {
    upsertFileRecorded({ path: 'd:/v/readme.txt' });
    expect(listVideos({}).total).toBe(0);
  });
});

describe('queryExists', () => {
  it('仅 video 计为存在，路径后缀优先排序', () => {
    upsertFileScanned(scanned({ path: 'e:/b/a.mp4', stem: 'a', volume: 'e:', size: 1 }));
    upsertFileScanned(scanned({ path: 'd:/剧/a.mp4', stem: 'a', size: 2 }));
    upsertFileScanned(scanned({ path: 'd:/剧/a.jpg', stem: 'a', type: 'cover', ext: 'jpg' }));
    const { exists, matches } = queryExists('剧/a.mp4');
    expect(exists).toBe(true);
    expect(matches).toHaveLength(2);
    expect(matches[0]!.path).toBe('d:/剧/a.mp4');
    expect(matches.every((m) => m.type === 'video')).toBe(true);
  });
  it('无匹配返回 exists:false', () => {
    expect(queryExists('不存在的.mp4').exists).toBe(false);
  });
});

describe('purgeMissing', () => {
  it('删除 last_seen 小于 token 的行', () => {
    upsertFileScanned(scanned({ path: 'd:/old.mp4', seen: 100 }));
    upsertFileScanned(scanned({ path: 'd:/new.mp4', seen: 200 }));
    expect(purgeMissing(150)).toBe(1);
    expect(listVideos({}).total).toBe(1);
  });
});

describe('listVideos', () => {
  it('cover_id：stem 同名优先、目录名回退', () => {
    upsertFileScanned(scanned({ path: 'd:/单片/movie.mp4', stem: 'movie' }));
    upsertFileScanned(scanned({ path: 'd:/剧名/第1集.mp4', stem: '第1集' }));
    upsertFileScanned(scanned({ path: 'd:/单片/movie.jpg', stem: 'movie', type: 'cover', ext: 'jpg' }));
    upsertFileScanned(scanned({ path: 'd:/剧名/剧名.jpg', stem: '剧名', type: 'cover', ext: 'jpg' }));
    const items = listVideos({}).items;
    const byStem = new Map(items.map((i) => [i.stem, i]));
    expect(byStem.get('movie')!.cover_id).not.toBeNull(); // stem 同名
    expect(byStem.get('第1集')!.cover_id).not.toBeNull(); // 目录名回退（剧名.jpg）
  });
  it('q / volume / type 过滤与分页', () => {
    upsertFileScanned(scanned({ path: 'd:/aa/x.mp4', stem: 'x' }));
    upsertFileScanned(scanned({ path: 'e:/bb/y.mp4', stem: 'y', volume: 'e:' }));
    upsertFileScanned(scanned({ path: 'd:/aa/z.jpg', stem: 'z', type: 'cover', ext: 'jpg' }));
    expect(listVideos({ q: 'aa' }).total).toBe(1);
    expect(listVideos({ volume: 'e:' }).total).toBe(1);
    expect(listVideos({ type: 'cover' }).total).toBe(1);
    expect(listVideos({ size: 1 }).items).toHaveLength(1);
  });
  it('LIKE 通配符转义', () => {
    upsertFileScanned(scanned({ path: 'd:/100%.mp4', stem: '100%' }));
    expect(listVideos({ q: '100%' }).total).toBe(1);
  });
});

describe('统计与查询辅助', () => {
  it('listVolumes / mediaStats / getFileBasic', () => {
    upsertFileScanned(scanned({}));
    upsertFileScanned(scanned({ path: 'd:/a.jpg', stem: 'a', type: 'cover', ext: 'jpg' }));
    expect(listVolumes()).toEqual([{ volume: 'd:', videos: 1 }]);
    expect(mediaStats()).toEqual({ videos: 1, covers: 1 });
    const first = listVideos({}).items[0]!;
    const basic = getFileBasic(first.id);
    expect(basic?.path).toBe('d:/v/a.mp4');
    expect(getFileBasic(9999)).toBeNull();
  });
});
