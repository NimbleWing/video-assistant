// 原始资料扫描流程测试：经 scanRawRoots 注入临时目录（绕过盘符解析），覆盖
// 类型分派 / .ts 嗅探 / 三键跳过 / 作用域消失判定 / 决策与恢复。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { db } from '../../lib/db.ts';
import { findRawByPath, listPendingMissing, listRawFiles, resolveMissing } from './files.ts';
import { cancelRawScan, rawLastSelection, rawScanStatus, scanRawRoots, startRawScan } from './scanner.ts';

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
