import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from './app.ts';
import { upsertRawScanned } from './features/raw/files.ts';
import { setExitHandlerForTest } from './features/system/routes.ts';
import type { PingResponse } from './features/system/types.ts';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  if (addr == null || typeof addr === 'string') throw new Error('unexpected address');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('app 集成', () => {
  it('GET /api/ping 返回统计', async () => {
    const r = await fetch(`${base}/api/ping`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as PingResponse;
    expect(j.ok).toBe(true);
    expect(typeof j.videos).toBe('number');
    expect(typeof j.uptime).toBe('number');
  });

  it('GET /api/exists 空库返回不存在', async () => {
    const r = await fetch(`${base}/api/exists?rel=${encodeURIComponent('剧名/xx.mp4')}`);
    const j = (await r.json()) as { ok: boolean; exists: boolean };
    expect(j.exists).toBe(false);
  });

  it('GET /api/exists raw_files 层命中（本地物理存在即已下载，与来源无关）', async () => {
    upsertRawScanned({
      path: 'd:/rawfiles/剧名/第9集.mp4', hash: 'ex-raw-h1', name: '第9集', ext: 'mp4',
      type: 'video', size: 4567, mtime: 1000, volume: 'd:', seen: 1300,
    });
    const r = await fetch(`${base}/api/exists?rel=${encodeURIComponent('剧名/第9集.mp4')}`);
    const j = (await r.json()) as { exists: boolean; matches: { path: string; type: string; size: number }[] };
    expect(j.exists).toBe(true);
    expect(j.matches).toContainEqual({ path: 'd:/rawfiles/剧名/第9集.mp4', type: 'video', size: 4567 });
  });

  it('GET /api/exists 账本优先判定：complete/skipped 命中、failed 不算、vid 精确与 filename 回退', async () => {
    const post = (body: Record<string, unknown>) => fetch(`${base}/api/downloads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // vid 精确命中：filename 完全不同的 rel 也能对上（站点改名场景）
    await post({ videoId: 'ex-vid-1', status: 'complete', filename: '旧名/第1集.mp4', name: '第1集', size: 123 });
    const byVid = await (await fetch(
      `${base}/api/exists?vid=ex-vid-1&rel=${encodeURIComponent('新名/第1集.mp4')}`,
    )).json() as { exists: boolean; matches: { path: string; type: string; size: number }[] };
    expect(byVid.exists).toBe(true);
    expect(byVid.matches[0]).toMatchObject({ path: '旧名/第1集.mp4', type: 'video', size: 123 });

    // filename 相等回退命中（skipped 也是「已在本地」证据）；大小写不敏感
    await post({ videoId: 'ex-vid-2', status: 'skipped', filename: '剧名/Skipped集.mp4', name: 'Skipped集' });
    const byName = await (await fetch(
      `${base}/api/exists?rel=${encodeURIComponent('剧名/skipped集.MP4')}`,
    )).json() as { exists: boolean; matches: { path: string }[] };
    expect(byName.exists).toBe(true);
    expect(byName.matches[0].path).toBe('剧名/Skipped集.mp4');

    // canceled / downloading 不构成已下载证据（failed 同一过滤器，不建行以免撞上文计数断言）
    await post({ videoId: 'ex-c-1', status: 'canceled', filename: '剧名/取消集.mp4', name: '取消集' });
    await post({ videoId: 'ex-d-1', status: 'downloading', filename: '剧名/进行中.mp4', name: '进行中' });
    const missByName = await (await fetch(
      `${base}/api/exists?rel=${encodeURIComponent('剧名/取消集.mp4')}`,
    )).json() as { exists: boolean };
    expect(missByName.exists).toBe(false);
    const missByVid = await (await fetch(
      `${base}/api/exists?vid=ex-d-1&rel=${encodeURIComponent('剧名/进行中.mp4')}`,
    )).json() as { exists: boolean };
    expect(missByVid.exists).toBe(false);
  });

  it('未知路径 404', async () => {
    const r = await fetch(`${base}/api/nope`);
    expect(r.status).toBe(404);
  });

  it('写操作：非法 Origin 403，放行 Origin 正常登记', async () => {
    const evil = await fetch(`${base}/api/downloads`, {
      method: 'POST',
      headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: 'x', status: 'failed' }),
    });
    expect(evil.status).toBe(403);

    const ok = await fetch(`${base}/api/downloads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: 'it1', status: 'failed', error: '网络中断' }),
    });
    expect(ok.status).toBe(200);

    const list = await fetch(`${base}/api/downloads?status=failed`);
    const j = (await list.json()) as { total: number };
    expect(j.total).toBe(1);
  });

  it('登记请求缺 videoId 返回 400', async () => {
    const r = await fetch(`${base}/api/downloads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'failed' }),
    });
    expect(r.status).toBe(400);
  });

  it('POST /api/shutdown 响应 200 并调度退出（exit 注入为 spy，不真杀 worker）', async () => {
    const exit = vi.fn();
    setExitHandlerForTest(exit);
    const r = await fetch(`${base}/api/shutdown`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
    await new Promise((res) => setTimeout(res, 300)); // 越过 200ms 延迟
    expect(exit).toHaveBeenCalledTimes(1);
    setExitHandlerForTest(() => process.exit(0)); // 还原
  });

  it('GET / 提供管理页静态资源', async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
  });
});

describe('app 集成：国家字典 CRUD', () => {
  const post = (body: Record<string, unknown>) => fetch(`${base}/api/countries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('新增 → 列表 id 正序 → 改名 → 删除', async () => {
    const c1 = await (await post({ name: '  日本  ' })).json() as { ok: boolean; item: { id: number; name: string } };
    expect(c1.ok).toBe(true);
    expect(c1.item.name).toBe('日本'); // trim
    await post({ name: '美国' });

    const list = await (await fetch(`${base}/api/countries`)).json() as { items: { id: number; name: string }[] };
    expect(list.items.map((i) => i.name)).toEqual(['日本', '美国']); // id 正序
    const jp = list.items[0]!;

    const renamed = await (await fetch(`${base}/api/countries/${jp.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Japan' }),
    })).json() as { item: { name: string } };
    expect(renamed.item.name).toBe('Japan');

    const del = await fetch(`${base}/api/countries/${jp.id}/delete`, { method: 'POST' });
    expect(del.status).toBe(200);
    const after = await (await fetch(`${base}/api/countries`)).json() as { items: { name: string }[] };
    expect(after.items.map((i) => i.name)).toEqual(['美国']);
    // 清理本测试造的行（定向删除）
    const ids = (await (await fetch(`${base}/api/countries`)).json() as { items: { id: number }[] }).items.map((i) => i.id);
    for (const id of ids) await fetch(`${base}/api/countries/${id}/delete`, { method: 'POST' });
  });

  it('空名 400 / 超长 400 / 重名 409 / 目标不存在 404', async () => {
    expect((await post({ name: '   ' })).status).toBe(400);
    expect((await post({ name: 'x'.repeat(61) })).status).toBe(400);
    const created = await post({ name: '韩国' });
    expect(created.status).toBe(200);
    expect((await post({ name: '韩国' })).status).toBe(409);
    const id = (await (await created.json() as Promise<{ item: { id: number } }>)).item.id;
    // 改名与自身同名不算重名
    const self = await fetch(`${base}/api/countries/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '韩国' }),
    });
    expect(self.status).toBe(200);
    expect((await fetch(`${base}/api/countries/999999`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    })).status).toBe(404);
    expect((await fetch(`${base}/api/countries/999999/delete`, { method: 'POST' })).status).toBe(404);
    // 清理
    await fetch(`${base}/api/countries/${id}/delete`, { method: 'POST' });
  });
});

describe('app 集成：标签字典 CRUD + 拖拽排序', () => {
  interface TagItem { id: number; name: string; sort: number; video_count: number; actor_count: number }
  const post = (body: Record<string, unknown>) => fetch(`${base}/api/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const list = async (): Promise<TagItem[]> =>
    (await ((await fetch(`${base}/api/tags`)).json() as Promise<{ items: TagItem[] }>)).items;
  const reorder = (ids: number[]) => fetch(`${base}/api/tags/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });

  it('新增追加末尾（sort=max+1）；列表按 sort 升序；改名；删除', async () => {
    await post({ name: '高清' });
    await post({ name: '  经典  ' });
    let items = await list();
    expect(items.map((i) => [i.name, i.sort])).toEqual([['高清', 1], ['经典', 2]]); // trim + 追加末尾
    expect(items.every((i) => i.video_count === 0 && i.actor_count === 0)).toBe(true); // 预留计数
    const renamed = await (await fetch(`${base}/api/tags/${items[0]!.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '4K' }),
    })).json() as { item: { name: string; sort: number } };
    expect(renamed.item.name).toBe('4K');
    expect(renamed.item.sort).toBe(1); // 改名不动排序
    expect((await fetch(`${base}/api/tags/${items[1]!.id}/delete`, { method: 'POST' })).status).toBe(200);
    items = await list();
    expect(items.map((i) => i.name)).toEqual(['4K']);
    // 清理
    for (const it of items) await fetch(`${base}/api/tags/${it.id}/delete`, { method: 'POST' });
  });

  it('reorder 全量重编号（紧凑 1..n）；忽略不存在的 id；未携带的行续编末尾', async () => {
    for (const n of ['甲', '乙', '丙']) await post({ name: n });
    const items = await list();
    const [a, b, c] = items; // 甲(1) 乙(2) 丙(3)
    // 拖「丙」到「甲」前 → 丙,甲,乙 = 1,2,3
    const r1 = await (await reorder([c!.id, a!.id, b!.id])).json() as { items: TagItem[] };
    expect(r1.items.map((i) => i.id)).toEqual([c!.id, a!.id, b!.id]);
    expect(r1.items.map((i) => i.sort)).toEqual([1, 2, 3]); // 紧凑重编号
    // 混入不存在的 id：忽略；未携带的行（乙、丙）按原相对顺序续编到末尾
    const r2 = await (await reorder([a!.id, 999999])).json() as { items: TagItem[] };
    expect(r2.items.map((i) => i.id)).toEqual([a!.id, c!.id, b!.id]);
    expect(r2.items.map((i) => i.sort)).toEqual([1, 2, 3]);
    // 非法请求体 400
    expect((await reorder([])).status).toBe(400);
    expect((await reorder(['x' as unknown as number])).status).toBe(400);
    // 清理
    for (const it of await list()) await fetch(`${base}/api/tags/${it.id}/delete`, { method: 'POST' });
  });

  it('重名 409 / 空名 400 / 不存在 404', async () => {
    expect((await post({ name: '' })).status).toBe(400);
    const created = await post({ name: '唯一' });
    expect((await post({ name: '唯一' })).status).toBe(409);
    const id = (await (await created.json() as Promise<{ item: { id: number } }>)).item.id;
    expect((await fetch(`${base}/api/tags/999999/delete`, { method: 'POST' })).status).toBe(404);
    await fetch(`${base}/api/tags/${id}/delete`, { method: 'POST' }); // 清理
  });
});

describe('app 集成：raw feature', () => {
  it('GET /api/raw/volumes 返回盘符数组与上次勾选', async () => {
    const r = await fetch(`${base}/api/raw/volumes`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; volumes: { volume: string }[]; lastSelection: unknown };
    expect(j.ok).toBe(true);
    expect(Array.isArray(j.volumes)).toBe(true);
    for (const v of j.volumes) expect(v.volume).toMatch(/^[a-z]:$/);
  });

  it('GET /api/raw/files / missing 空库正常', async () => {
    const f = await fetch(`${base}/api/raw/files`);
    expect(((await f.json()) as { ok: boolean }).ok).toBe(true);
    const m = await fetch(`${base}/api/raw/missing`);
    expect(((await m.json()) as { ok: boolean; items: unknown[] }).items).toEqual([]);
  });

  it('POST /api/raw/scan 非法请求体 400', async () => {
    const bad = await fetch(`${base}/api/raw/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ volumes: ['zz'], types: ['video'] }),
    });
    expect(bad.status).toBe(400);
    const empty = await fetch(`${base}/api/raw/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ volumes: [], types: [] }),
    });
    expect(empty.status).toBe(400);
  });

  it('POST /api/raw/missing/resolve 非法 op 400', async () => {
    const r = await fetch(`${base}/api/raw/missing/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'nuke' }),
    });
    expect(r.status).toBe(400);
  });

  it('GET /api/raw/file/:id/content 未知 id 404', async () => {
    const r = await fetch(`${base}/api/raw/file/99999/content`);
    expect(r.status).toBe(404);
  });

  it('GET /api/raw/scan/events SSE 先推 snapshot 事件', async () => {
    const ctrl = new AbortController();
    const r = await fetch(`${base}/api/raw/scan/events`, { signal: ctrl.signal });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    const reader = r.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('event: snapshot');
    ctrl.abort();
  });
});
