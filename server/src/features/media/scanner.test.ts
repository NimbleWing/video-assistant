import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { db } from '../../lib/db.ts';
import { scanAll, saveScanDirs } from './scanner.ts';
import { listVideos, mediaStats } from './files.ts';

let dir = '';
const sub = () => path.join(dir, '剧名');

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'rou-scan-'));
  mkdirSync(sub(), { recursive: true });
  writeFileSync(path.join(sub(), '第1集.mp4'), 'x');
  writeFileSync(path.join(sub(), '第1集.jpg'), 'y');
  writeFileSync(path.join(sub(), 'readme.txt'), 'z');
  saveScanDirs([dir]);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('scanAll', () => {
  it('扫描入库 mp4/jpg，忽略未知扩展', async () => {
    const result = await scanAll();
    expect(result.videos).toBe(1);
    expect(result.covers).toBe(1);
    expect(result.removed).toBe(0);
    expect(mediaStats()).toEqual({ videos: 1, covers: 1 });
  });

  it('幂等：重复扫描不重复入库', async () => {
    await scanAll();
    expect(listVideos({}).total).toBe(1);
  });

  it('文件消失后清失', async () => {
    unlinkSync(path.join(sub(), '第1集.mp4'));
    const r = await scanAll();
    expect(r.removed).toBe(1);
    expect(mediaStats().videos).toBe(0);
  });

  it('未配置目录时返回警告', async () => {
    saveScanDirs([]);
    const r = await scanAll();
    expect(r.warnings[0]).toContain('未配置扫描目录');
  });
});

afterAll(() => {
  db.exec('DELETE FROM files');
  db.exec('DELETE FROM meta');
});
