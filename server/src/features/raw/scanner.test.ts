// 原始资料扫描流程测试：经 scanRawRoots 注入临时目录（绕过盘符解析），覆盖
// 类型分派 / .ts 嗅探 / 三键跳过 / 作用域消失判定 / 决策与恢复 / 移动与改名配对合并。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { db } from '../../lib/db.ts';
import { findRawByPath, listArchivedFiles, listPendingMissing, listRawEvents, listRawFiles, resolveMissing } from './files.ts';
import { cancelRawScan, rawLastSelection, rawScanStatus, scanRawRoots, startRawScan } from './scanner.ts';

/** raw_archive 行（file_id → name/时间戳）。 */
function archiveOf(fileId: number): { name: string; created_at: number; updated_at: number } | null {
  const r = db.prepare('SELECT name, created_at, updated_at FROM raw_archive WHERE file_id = ?').get(fileId) as
    | { name: unknown; created_at: unknown; updated_at: unknown }
    | undefined;
  return r ? { name: String(r.name), created_at: Number(r.created_at), updated_at: Number(r.updated_at) } : null;
}

let dir = '';
const p = (name: string) => path.join(dir, name);

/** MPEG-TS 魔数文件（0x47 sync 网格）。 */
function tsFile(bytes: number, fill = 0x11): Buffer {
  const b = Buffer.alloc(bytes, fill);
  for (let i = 0; i * 188 < bytes; i++) b[i * 188] = 0x47;
  return b;
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'rou-raw-'));
  mkdirSync(path.join(dir, 'sub'), { recursive: true });
  writeFileSync(p('MyVideo.MP4'), Buffer.alloc(200_000, 1));
  writeFileSync(p('sub/photo.JPG'), Buffer.alloc(5000, 2));
  writeFileSync(p('clip.ts'), tsFile(400_000));
  writeFileSync(p('script.ts'), Buffer.from('export const x = 1;\n'.repeat(50))); // TypeScript 代码
  writeFileSync(p('anim.gif'), Buffer.alloc(100, 3)); // 不收的扩展名
  writeFileSync(p('note.txt'), Buffer.alloc(100, 4));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  db.exec('DELETE FROM raw_files');
  db.exec('DELETE FROM raw_archive');
  db.exec('DELETE FROM raw_events');
  db.exec('DELETE FROM meta');
});

const scanBoth = () => scanRawRoots([{ volume: 't:', root: dir }], ['video', 'image']);
const rows = () => listRawFiles({ missing: 'all' }).items;
const find = (ext: string) => rows().find((i) => i.ext === ext);

describe('scanRawRoots', () => {
  it('入库视频/图片，.ts 嗅探排除代码文件，忽略未收扩展名，name 保留大小写', async () => {
    const r = await scanBoth();
    expect(r.newCount).toBe(3); // MyVideo.MP4 + photo.JPG + clip.ts
    expect(r.updatedCount).toBe(0);
    expect(r.canceled).toBe(false);
    expect(r.missingCount).toBe(0);
    expect(rows().map((i) => i.ext).sort()).toEqual(['jpg', 'mp4', 'ts']);
    expect(rows().some((i) => i.path.endsWith('script.ts'))).toBe(false);
    expect(find('mp4')?.name).toBe('MyVideo'); // 原始大小写（path 列归一小写）
    expect(find('mp4')?.volume).toBe('t:'); // 注入盘符仅入 volume 列
  });

  it('幂等重扫：三键未变走 touch（new=0，hash 沿用）', async () => {
    const before = findRawByPath(find('mp4')!.path)?.hash;
    const r = await scanBoth();
    expect(r.newCount).toBe(0);
    expect(r.updatedCount).toBe(3);
    expect(findRawByPath(find('mp4')!.path)?.hash).toBe(before);
  });

  it('内容变化（mtime/size 变）→ 重算 hash', async () => {
    const mp4Path = find('mp4')!.path;
    const before = findRawByPath(mp4Path)?.hash;
    writeFileSync(p('MyVideo.MP4'), Buffer.alloc(200_000, 9)); // 同尺寸不同内容
    const now = new Date();
    utimesSync(p('MyVideo.MP4'), now, now); // 确保触发三键变化
    await scanBoth();
    expect(findRawByPath(mp4Path)?.hash).not.toBe(before);
  });

  it('文件消失 → 待决策（pending_missing）；未决策下次扫描继续上报', async () => {
    unlinkSync(p('sub/photo.JPG'));
    const r1 = await scanBoth();
    expect(r1.missingCount).toBe(1);
    expect(listPendingMissing()).toHaveLength(1);
    const r2 = await scanBoth();
    expect(r2.missingCount).toBe(1); // 不决策 → 重报
  });

  it('作用域防护：只勾视频重扫，图片行不被误判为本次新消失', async () => {
    unlinkSync(p('MyVideo.MP4'));
    const r = await scanRawRoots([{ volume: 't:', root: dir }], ['video']); // 只扫视频
    // 视频行（MyVideo）本次消失 → 上报；photo 的历史待决策计入总数
    expect(r.missingCount).toBe(2);
    const paths = listPendingMissing().map((i) => i.path);
    expect(paths.some((x) => x.endsWith('myvideo.mp4'))).toBe(true);
  });

  it('决策 mark 后不再上报；文件重现自动恢复', async () => {
    resolveMissing('mark'); // 清空历史待决策（photo / myvideo → missing=1）
    expect(listPendingMissing()).toHaveLength(0);

    writeFileSync(p('MyVideo.MP4'), Buffer.alloc(200_000, 1));
    let r = await scanBoth();
    expect(r.missingCount).toBe(0); // photo 已 mark 不重报；myvideo 重现自动恢复
    expect(find('mp4')?.missing).toBe(false);

    unlinkSync(p('clip.ts'));
    r = await scanBoth();
    expect(r.missingCount).toBe(1);
    resolveMissing('mark');
    r = await scanBoth();
    expect(r.missingCount).toBe(0); // clip 已 mark 不再上报
    expect(listRawFiles({ missing: 'only' }).total).toBe(2); // photo + clip 均 missing=1（myvideo 已恢复）

    writeFileSync(p('clip.ts'), tsFile(400_000));
    await scanBoth();
    expect(find('ts')?.missing).toBe(false); // 重现自动恢复
    expect(listRawFiles({ missing: 'only' }).total).toBe(1); // 仅剩 photo
  });

  it('RawFiles 根缺失 → warning 且不判消失', async () => {
    const r = await scanRawRoots([{ volume: 'z:', root: path.join(dir, 'nope') }], ['video', 'image']);
    expect(r.warnings[0]).toContain('RawFiles 目录不存在');
    expect(r.missingCount).toBe(0);
  });
});

describe('scanRawRoots 配对合并（移动/改名自动判定）', () => {
  let root2 = '';
  const q = (name: string) => path.join(root2, name);
  /** 本组测试的行（volume='m:'，排除前组 't:' 残留）。 */
  const mRows = () => listRawFiles({ missing: 'all' }).items.filter((i) => i.volume === 'm:');

  beforeAll(() => {
    root2 = mkdtempSync(path.join(tmpdir(), 'rou-move-'));
    writeFileSync(q('origin.mp4'), Buffer.alloc(150_000, 5)); // hash 唯一
  });

  afterAll(() => {
    rmSync(root2, { recursive: true, force: true });
  });

  it('改名：同目录换名 → 旧行续命 + archived + rename 事件 + 归档最新名', async () => {
    await scanRawRoots([{ volume: 'm:', root: root2 }], ['video']);
    const oldRow = mRows().find((i) => i.path.endsWith('origin.mp4'));
    expect(oldRow).toBeTruthy();
    const oldId = oldRow!.id;
    const firstSeen = oldRow!.first_seen;

    renameSync(q('origin.mp4'), q('renamed.mp4'));
    const r = await scanRawRoots([{ volume: 'm:', root: root2 }], ['video']);
    expect(r.movedCount).toBe(1);
    expect(r.newCount).toBe(0); // 合并对不算真新增
    expect(r.missingCount).toBe(0); // 配对行不进 pending

    const rows = mRows();
    expect(rows).toHaveLength(1); // 单行跟随，无双行
    const row = rows[0]!;
    expect(row.id).toBe(oldId); // id 不变
    expect(row.first_seen).toBe(firstSeen); // 初见时间保留
    expect(row.path.endsWith('renamed.mp4')).toBe(true);
    expect(row.name).toBe('origin'); // name 永远=最初名
    expect(row.archived).toBe(true);

    const ev = listRawEvents({});
    expect(ev.total).toBe(1);
    expect(ev.items[0]!.kind).toBe('rename');
    expect(ev.items[0]!.result).toContain('origin');
    expect(ev.items[0]!.result).toContain('renamed');
    expect(ev.items[0]!.file?.id).toBe(oldId);

    const arc = archiveOf(oldId);
    expect(arc?.name).toBe('renamed'); // 最新名
  });

  it('移动：换目录（含改名）→ move + rename 两条事件；归档行 updated_at 前移', async () => {
    const before = archiveOf(mRows()[0]!.id);
    mkdirSync(q('sub'), { recursive: true });
    renameSync(q('renamed.mp4'), q('sub/moved.mp4'));
    const r = await scanRawRoots([{ volume: 'm:', root: root2 }], ['video']);
    expect(r.movedCount).toBe(1);

    const ev = listRawEvents({ kind: 'move' });
    expect(ev.total).toBe(1);
    expect(ev.items[0]!.kind).toBe('move');
    expect(ev.items[0]!.result).toContain('sub/moved.mp4');
    expect(listRawEvents({ kind: 'rename' }).total).toBe(2); // origin→renamed + renamed→moved

    const row = mRows().find((i) => i.path.endsWith('moved.mp4'))!;
    expect(row.path.endsWith('sub/moved.mp4')).toBe(true);
    const after = archiveOf(row.id);
    expect(after!.updated_at).toBeGreaterThanOrEqual(before!.updated_at);
    expect(after!.name).toBe('moved');
  });

  it('歧义：同 hash 存在第三条存活行 → 不配对，消失行走 pending', async () => {
    // 复制一份同内容文件 → 入库后两行同 hash 存活
    writeFileSync(q('dup.mp4'), Buffer.alloc(150_000, 5));
    await scanRawRoots([{ volume: 'm:', root: root2 }], ['video']); // dup 入库（两行同 hash 存活）
    expect(mRows().some((i) => i.path.endsWith('dup.mp4'))).toBe(true);

    // 「移动」sub/moved.mp4：因 dup.mp4 同 hash 存活 → 不许猜
    renameSync(q('sub/moved.mp4'), q('sub/moved2.mp4'));
    const r = await scanRawRoots([{ volume: 'm:', root: root2 }], ['video']);
    expect(r.movedCount).toBe(0);
    expect(r.missingCount).toBe(1); // moved.mp4 进待决策
    expect(listPendingMissing().some((i) => i.path.endsWith('moved.mp4'))).toBe(true);
    expect(listRawEvents({}).total).toBe(3); // 无新事件

    // 清理：决策掉 pending；删 dup 恢复 hash 唯一
    resolveMissing('delete');
    unlinkSync(q('dup.mp4'));
    await scanRawRoots([{ volume: 'm:', root: root2 }], ['video']);
    resolveMissing('delete'); // dup 行也消失待决策 → 清掉
  });

  it('数量不为一（2 消失 + 1 新建）→ 条件①不满足，不配对', async () => {
    const content = Buffer.alloc(120_000, 9);
    writeFileSync(q('pair-a.mp4'), content);
    writeFileSync(q('pair-b.mp4'), content);
    await scanRawRoots([{ volume: 'm:', root: root2 }], ['video']); // 两个同 hash 新建入库
    unlinkSync(q('pair-a.mp4'));
    unlinkSync(q('pair-b.mp4'));
    writeFileSync(q('pair-c.mp4'), content); // 1 新建 vs 2 消失
    const r = await scanRawRoots([{ volume: 'm:', root: root2 }], ['video']);
    expect(r.movedCount).toBe(0);
    resolveMissing('delete');
    unlinkSync(q('pair-c.mp4'));
    await scanRawRoots([{ volume: 'm:', root: root2 }], ['video']);
    resolveMissing('delete');
  });

  it('历史 pending 行（跨会话）不参与配对：新位置按新建处理', async () => {
    const content = Buffer.alloc(130_000, 11);
    writeFileSync(q('cross.mp4'), content);
    await scanRawRoots([{ volume: 'm:', root: root2 }], ['video']);
    // 会话 1：删掉 → 旧行 pending
    unlinkSync(q('cross.mp4'));
    await scanRawRoots([{ volume: 'm:', root: root2 }], ['video']);
    expect(listPendingMissing().some((i) => i.path.endsWith('cross.mp4'))).toBe(true);
    // 会话 2：文件在「新路径」出现 → 不追认（用户工作流兜底：手动删旧行，新行唯一）
    writeFileSync(q('cross-new.mp4'), content);
    const r = await scanRawRoots([{ volume: 'm:', root: root2 }], ['video']);
    expect(r.movedCount).toBe(0);
    expect(r.newCount).toBe(1);
    expect(mRows().some((i) => i.path.endsWith('cross-new.mp4'))).toBe(true);
    expect(listPendingMissing().some((i) => i.path.endsWith('cross.mp4'))).toBe(true); // 旧行仍待决策
    resolveMissing('delete');
    unlinkSync(q('cross-new.mp4'));
    await scanRawRoots([{ volume: 'm:', root: root2 }], ['video']);
    resolveMissing('delete');
  });

  it('归档列表与单文件事件时间线', async () => {
    // 当前 m: 唯一行 sub/moved2.mp4（歧义测试后存活的非归档行）；再配对一次产生归档行
    const idY = mRows().find((i) => i.path.endsWith('moved2.mp4'))!.id;
    renameSync(q('sub/moved2.mp4'), q('sub/moved3.mp4'));
    const r = await scanRawRoots([{ volume: 'm:', root: root2 }], ['video']);
    expect(r.movedCount).toBe(1);

    const arc = listArchivedFiles({});
    expect(arc.total).toBe(1);
    expect(arc.items[0]!.id).toBe(idY); // 单行跟随
    expect(arc.items[0]!.archived).toBe(true);
    expect(arc.items[0]!.name).toBe('moved2'); // 最初名
    expect(arc.items[0]!.latest_name).toBe('moved3'); // 最新名
    expect(arc.items[0]!.event_count).toBe(1);
    // 搜索命中最初名或当前路径
    expect(listArchivedFiles({ q: 'moved2' }).total).toBe(1);
    expect(listArchivedFiles({ q: 'moved3' }).total).toBe(1);
    // 单文件事件：全量、时间正序
    const ev = listRawEvents({ fileId: idY });
    expect(ev.total).toBe(1);
    expect(ev.items[0]!.kind).toBe('rename');
    expect(ev.items[0]!.file?.id).toBe(idY);
  });
});

describe('任务状态', () => {
  it('空闲时 cancel 返回 false', () => {
    expect(cancelRawScan()).toBe(false);
  });

  it('startRawScan 全局任务路径：RawFiles 缺失仍产出结果并记忆勾选', async () => {
    startRawScan(['z:'], ['video']);
    for (let i = 0; i < 100 && rawScanStatus().running; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const s = rawScanStatus();
    expect(s.running).toBe(false);
    expect(s.lastResult?.canceled).toBe(false);
    expect(s.lastResult?.warnings[0]).toContain('RawFiles 目录不存在');
    expect(rawLastSelection()).toEqual({ volumes: ['z:'], types: ['video'] });
  });
});
