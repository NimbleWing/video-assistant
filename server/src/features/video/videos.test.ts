// videos 表操作单测：落库缝合（video_file 四字段）、kind/演员/标签/片商筛选、q 搜索、悬空防御。
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../../lib/db.ts';
// 夹具依赖四张字典表的 DDL（随模块加载执行）
import '../country/countries.ts';
import '../tag/tags.ts';
import '../studio/studios.ts';
import '../actress/actresses.ts';
import { setRawVideoMeta, upsertRawScanned } from '../raw/files.ts';
import { insertVideo, listVideos, setVideoRating } from './videos.ts';

afterAll(() => {
  // 定向清理本测试写入的表（内存库，仅本文件实例）
  db.exec('DELETE FROM videos');
  db.exec('DELETE FROM actress_videos');
  db.exec('DELETE FROM tag_videos');
  db.exec('DELETE FROM studio_videos');
  db.exec('DELETE FROM country_videos');
  db.exec('DELETE FROM raw_files');
  db.exec('DELETE FROM actresses');
  db.exec('DELETE FROM countries');
  db.exec('DELETE FROM tags');
  db.exec('DELETE FROM studios');
});

function idOf(sql: string): number {
  return Number((db.prepare(sql).get() as { id: number | bigint }).id);
}

/** 夹具：国家/两位演员/标签/片商 + 一条 raw 视频行（含时长回填）。 */
function seed() {
  db.exec("INSERT INTO countries (name) VALUES ('日本')");
  const countryId = idOf("SELECT id FROM countries WHERE name = '日本'");
  db.exec(`INSERT INTO actresses (name, country_id, disk) VALUES ('A子', ${countryId}, 'd:')`);
  db.exec(`INSERT INTO actresses (name, country_id, disk) VALUES ('B美', ${countryId}, 'd:')`);
  db.exec("INSERT INTO tags (name, sort) VALUES ('标签1', 1)");
  db.exec("INSERT INTO studios (name) VALUES ('片商X')");
  upsertRawScanned({
    path: 'd:/rawfiles/v.mp4', hash: 'hv', name: 'v', ext: 'mp4', type: 'video',
    size: 100, mtime: 1, volume: 'd:', seen: 1,
  });
  const fileId = idOf("SELECT id FROM raw_files WHERE path = 'd:/rawfiles/v.mp4'");
  setRawVideoMeta(fileId, { duration: 1423, width: 1920, height: 1080 }); // 23:43 / 1080p
  return {
    countryId,
    a1: idOf("SELECT id FROM actresses WHERE name = 'A子'"),
    a2: idOf("SELECT id FROM actresses WHERE name = 'B美'"),
    t1: idOf("SELECT id FROM tags WHERE name = '标签1'"),
    s1: idOf("SELECT id FROM studios WHERE name = '片商X'"),
    fileId,
  };
}

const s = seed();

describe('insertVideo 落库缝合', () => {
  it('video_file 缝合 raw 行（id/path/ext/size/duration/分辨率）+ 四维 join + 评分', () => {
    const item = insertVideo({
      kind: 'single',
      title: '标题甲',
      subtitle: '副标题乙',
      code: 'ABC-123',
      rating: 87,
      videoFileId: s.fileId,
      coverFileId: null,
      actressIds: [s.a1, s.a2],
      tagIds: [s.t1],
      studioId: s.s1,
      countryId: s.countryId,
    });
    expect(item.video_file).toEqual({ id: s.fileId, path: 'd:/rawfiles/v.mp4', ext: 'mp4', size: 100, duration: 1423, width: 1920, height: 1080 });
    expect(item.rating).toBe(87);
    expect(item.actresses.map((a) => a.name)).toEqual(['A子', 'B美']);
    expect(item.tags.map((t) => t.name)).toEqual(['标签1']);
    expect(item.studios.map((x) => x.name)).toEqual(['片商X']);
    expect(item.countries.map((c) => c.name)).toEqual(['日本']);
  });

  it('raw 行不存在时 video_file=null（防御悬空，不炸列表）', () => {
    const item = insertVideo({
      kind: 'single',
      title: '悬空行',
      subtitle: null,
      code: null,
      rating: null,
      videoFileId: 999999,
      coverFileId: null,
      actressIds: [s.a1],
      tagIds: [],
      studioId: null,
      countryId: s.countryId,
    });
    expect(item.video_file).toBeNull();
    expect(item.rating).toBeNull();
    expect(listVideos({}).items.every((v) => v.id !== item.id || v.video_file === null)).toBe(true);
  });
});

describe('setVideoRating 评分修改', () => {
  it('设置/改分/清除；不存在返回 null', () => {
    const item = listVideos({ q: '标题甲' }).items[0]!;
    expect(setVideoRating(item.id, 66)?.rating).toBe(66);
    expect(setVideoRating(item.id, null)?.rating).toBeNull();
    expect(setVideoRating(999999, 80)).toBeNull();
  });
});

describe('listVideos 筛选', () => {
  it('kind 区分单片/剧集', () => {
    insertVideo({
      kind: 'series',
      title: '剧集占位',
      subtitle: null,
      code: null,
      rating: null,
      videoFileId: s.fileId,
      coverFileId: null,
      actressIds: [s.a1],
      tagIds: [],
      studioId: null,
      countryId: s.countryId,
    });
    expect(listVideos({ kind: 'single' }).total).toBe(2); // 标题甲 + 悬空行
    expect(listVideos({ kind: 'series' }).total).toBe(1);
    expect(listVideos({}).total).toBe(3);
  });

  it('actressId / tagId / studioId 命中与落空', () => {
    expect(listVideos({ actressId: s.a2 }).total).toBe(1); // 只有「标题甲」挂了 B美
    expect(listVideos({ actressId: 999999 }).total).toBe(0);
    expect(listVideos({ tagId: s.t1 }).total).toBe(1);
    expect(listVideos({ studioId: s.s1 }).total).toBe(1);
    // 组合条件取交集
    expect(listVideos({ actressId: s.a2, tagId: s.t1 }).total).toBe(1); // 标题甲同时挂了 B美 与 标签1
    expect(listVideos({ actressId: s.a2, tagId: 999999 }).total).toBe(0);
    expect(listVideos({ studioId: s.s1, actressId: 999999 }).total).toBe(0);
  });
  it('q 匹配 title/subtitle/code（大小写不敏感）', () => {
    expect(listVideos({ q: '标题甲' }).total).toBe(1);
    expect(listVideos({ q: '副标题乙' }).total).toBe(1);
    expect(listVideos({ q: 'abc-123' }).total).toBe(1);
    expect(listVideos({ q: '不存在' }).total).toBe(0);
  });
});
