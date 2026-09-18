// raw_files 表操作单测：upsert / 三键 touch / 作用域消失判定 / 决策 / 列表筛选 / 查重 / 物理删除。
import { afterAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from '../../lib/db.ts';
import { normPath } from '../../lib/paths.ts';
import {
  deleteRawPhysical,
  findRawByPath,
  getRawByPath,
  listPendingMissing,
  listRawDuplicates,
  listRawFiles,
  markPendingMissing,
  rawTypeOfExt,
  rawVolumeStats,
  resolveMissing,
  touchRawSeen,
  upsertRawScanned,
} from './files.ts';

afterAll(() => {
  db.exec('DELETE FROM raw_files');
});

const row = (over: Partial<Parameters<typeof upsertRawScanned>[0]> = {}) => ({
  path: 'd:/rawfiles/a.mp4',
  hash: 'h1',
  name: 'a',
  ext: 'mp4',
  type: 'video' as const,
  size: 100,
  mtime: 1000,
  volume: 'd:',
  seen: 100,
  ...over,
});

describe('rawTypeOfExt', () => {
  it('视频/图片扩展名分派，未知 null', () => {
    expect(rawTypeOfExt('mp4')).toBe('video');
    expect(rawTypeOfExt('rmvb')).toBe('video');
    expect(rawTypeOfExt('jpeg')).toBe('image');
    expect(rawTypeOfExt('txt')).toBeNull();
    expect(rawTypeOfExt('gif')).toBeNull(); // 明确不收 gif
  });
});

describe('upsert / touch', () => {
  it('插入后更新走 conflict 分支并清消失标记', () => {
    upsertRawScanned(row());
    upsertRawScanned(row({ hash: 'h2', size: 200, mtime: 2000, seen: 200 }));
    const r = findRawByPath('d:/rawfiles/a.mp4');
    expect(r).toEqual({ hash: 'h2', size: 200, mtime: 2000 });
  });

  it('touch 只刷 last_seen 并归零 missing/pending_missing', () => {
    db.exec("UPDATE raw_files SET missing = 1, pending_missing = 1 WHERE path = 'd:/rawfiles/a.mp4'");
    touchRawSeen('d:/rawfiles/a.mp4', 300);
    const it = listRawFiles({ missing: 'all' }).items[0];
    expect(it?.missing).toBe(false);
    expect(it?.pending_missing).toBe(false);
    expect(it?.last_seen).toBe(300);
  });
});

describe('作用域消失判定', () => {
  it('只判 (盘符,类型) 作用域内的过期行；missing=1 不重报；返回含历史待决策总数', () => {
    // d: video（过期→待决策）/ d: image（不在作用域，不动）/ e: video（不在作用域，不动）
    upsertRawScanned(row({ seen: 100 }));
    upsertRawScanned(row({ path: 'd:/rawfiles/b.jpg', ext: 'jpg', type: 'image', volume: 'd:', seen: 100 }));
    upsertRawScanned(row({ path: 'e:/rawfiles/c.mp4', volume: 'e:', seen: 100 }));
    const n = markPendingMissing([{ volume: 'd:', type: 'video' }], 500);
    const items = listPendingMissing();
    expect(items.map((i) => i.path)).toEqual(['d:/rawfiles/a.mp4']);
    expect(n).toBe(1);

    // 已决策 mark（missing=1）后，下次同作用域扫描不再上报
    resolveMissing('mark');
    expect(markPendingMissing([{ volume: 'd:', type: 'video' }], 600)).toBe(0);

    // 补 e: video 作用域 → e 行上报；d: image 行始终不动
    expect(markPendingMissing([{ volume: 'e:', type: 'video' }], 700)).toBe(1);
    const items2 = listPendingMissing();
    expect(items2.map((i) => i.path)).toEqual(['e:/rawfiles/c.mp4']);
  });
});

describe('resolveMissing', () => {
  it('delete 删行', () => {
    expect(resolveMissing('delete')).toBe(1);
    expect(listPendingMissing()).toHaveLength(0);
  });
});

describe('listRawFiles', () => {
  it('默认隐藏 missing；only 只看 missing；名称搜索大小写不敏感', () => {
    upsertRawScanned(row({ path: 'd:/rawfiles/Name.MP4', name: 'Name', seen: 900 }));
    db.exec("UPDATE raw_files SET missing = 1 WHERE path = 'd:/rawfiles/b.jpg'");
    expect(listRawFiles({}).total).toBeGreaterThanOrEqual(1);
    expect(listRawFiles({ q: 'name' }).total).toBe(1);
    expect(listRawFiles({ q: 'name', missing: 'all' }).total).toBe(1);
    expect(listRawFiles({ type: 'image', missing: 'only' }).items.map((i) => i.path)).toEqual(['d:/rawfiles/b.jpg']);
  });

  it('盘符统计分组', () => {
    const v = rawVolumeStats().find((x) => x.volume === 'd:');
    expect(v?.videos).toBe(2); // a.mp4 + Name.MP4
    expect(v?.images).toBe(1); // b.jpg
  });
});

describe('listRawDuplicates', () => {
  it('同 hash 现存行成组；missing/待决策行排除；冗余与汇总正确', () => {
    // dup-h1：d:/e: 两份存活 + 一份 missing + 一份待决策 → 组内只有 2 份
    upsertRawScanned(row({ path: 'd:/rawfiles/dup1.mp4', name: 'dup1', hash: 'dup-h1', size: 100, seen: 1000 }));
    upsertRawScanned(row({ path: 'e:/rawfiles/dup1-copy.mp4', name: 'dup1-copy', hash: 'dup-h1', size: 100, volume: 'e:', seen: 1000 }));
    upsertRawScanned(row({ path: 'f:/rawfiles/dup1-gone.mp4', name: 'dup1-gone', hash: 'dup-h1', size: 100, volume: 'f:', seen: 1000 }));
    db.exec("UPDATE raw_files SET missing = 1 WHERE path = 'f:/rawfiles/dup1-gone.mp4'");
    upsertRawScanned(row({ path: 'g:/rawfiles/dup1-pending.mp4', name: 'dup1-pending', hash: 'dup-h1', size: 100, volume: 'g:', seen: 1000 }));
    db.exec("UPDATE raw_files SET pending_missing = 1 WHERE path = 'g:/rawfiles/dup1-pending.mp4'");
    // dup-h2：三份存活（含跨类型同 hash 场景的 size 一致）
    for (const [i, vol] of ['d:', 'e:', 'h:'].entries()) {
      upsertRawScanned(row({ path: `${vol}/rawfiles/dup2-${i}.mp4`, name: `dup2-${i}`, hash: 'dup-h2', size: 50, volume: vol, seen: 1000 }));
    }

    const r = listRawDuplicates({});
    expect(r.total).toBe(2);
    expect(r.wastedTotal).toBe(200); // (2-1)*100 + (3-1)*50
    // 冗余大的组排前：dup-h2（冗余 100）与 dup-h1（冗余 100）并列 → 按 hash 稳定排序
    const byHash = new Map(r.items.map((g) => [g.hash, g]));
    const g1 = byHash.get('dup-h1');
    expect(g1?.count).toBe(2);
    expect(g1?.size).toBe(100);
    expect(g1?.wasted).toBe(100);
    expect(g1?.files.map((f) => f.path)).toEqual(['d:/rawfiles/dup1.mp4', 'e:/rawfiles/dup1-copy.mp4']);
    const g2 = byHash.get('dup-h2');
    expect(g2?.count).toBe(3);
    expect(g2?.wasted).toBe(100);
    expect(g2?.files.map((f) => f.volume)).toEqual(['d:', 'e:', 'h:']);
  });

  it('零字节文件不成组（hash 输入仅 size，0 B 文件互聚为假组）', () => {
    upsertRawScanned(row({ path: 'd:/rawfiles/zero1.mkv', name: 'zero1', hash: 'dup-zero', size: 0, seen: 1000 }));
    upsertRawScanned(row({ path: 'e:/rawfiles/zero2.jpg', name: 'zero2', hash: 'dup-zero', size: 0, ext: 'jpg', type: 'image', volume: 'e:', seen: 1000 }));
    const r = listRawDuplicates({});
    expect(r.items.find((g) => g.hash === 'dup-zero')).toBeUndefined();
    db.exec("DELETE FROM raw_files WHERE hash = 'dup-zero'");
  });

  it('唯一 hash 不成组；分页按组生效', () => {
    upsertRawScanned(row({ path: 'd:/rawfiles/unique.mp4', name: 'unique', hash: 'dup-unique', seen: 1000 }));
    expect(listRawDuplicates({}).total).toBe(2); // 上一用例的两组，unique 不入组
    const p1 = listRawDuplicates({ page: 1, size: 1 });
    expect(p1.items).toHaveLength(1);
    const p2 = listRawDuplicates({ page: 2, size: 1 });
    expect(p2.items).toHaveLength(1);
    expect(p1.items[0]?.hash).not.toBe(p2.items[0]?.hash);
    expect(listRawDuplicates({ page: 3, size: 1 }).items).toHaveLength(0);
    // 清理本 describe 造的行（定向路径前缀）
    db.exec("DELETE FROM raw_files WHERE path LIKE '%/rawfiles/dup%' OR path LIKE '%/rawfiles/unique%'");
  });
});

describe('deleteRawPhysical', () => {
  it('删磁盘文件与行；文件已不在盘上仅删行；行不存在返回 null', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rou-raw-del-'));
    try {
      // 存活文件：unlink + 删行
      const target = path.join(dir, 'x.mp4');
      await fs.writeFile(target, 'data');
      const np = normPath(target);
      upsertRawScanned(row({ path: np, name: 'x', hash: 'del-h1', seen: 1100 }));
      const id1 = getRawByPath(np)?.id as number;
      const r1 = await deleteRawPhysical(id1);
      expect(r1?.fileDeleted).toBe(true);
      expect(getRawByPath(np)).toBeNull();
      await expect(fs.stat(target)).rejects.toThrow();

      // 行指向的文件已消失（ENOENT）：容忍，仅删行
      const np2 = normPath(path.join(dir, 'gone.mp4'));
      upsertRawScanned(row({ path: np2, name: 'gone', hash: 'del-h2', seen: 1100 }));
      const id2 = getRawByPath(np2)?.id as number;
      const r2 = await deleteRawPhysical(id2);
      expect(r2?.fileDeleted).toBe(false);
      expect(getRawByPath(np2)).toBeNull();

      expect(await deleteRawPhysical(999_999_999)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
