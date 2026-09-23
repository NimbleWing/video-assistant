import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from './app.ts';
import { db } from './lib/db.ts';
import { normPath } from './lib/paths.ts';
import { getRawByPath, upsertRawScanned } from './features/raw/files.ts';
import { setExitHandlerForTest } from './features/system/routes.ts';
import type { LanResponse, PingResponse } from './features/system/types.ts';

/** 女优条目（本文件局部形状，断言用）。 */
interface ActressItem {
  id: number;
  name: string;
  country_id: number;
  country_name: string;
  rating: number | null;
  disk: string;
  avatar_file_id: number | null;
  aliases: string[];
  tags: { id: number; name: string; sort: number }[];
  video_count: number;
}

/** 最小合法 png（1×1 透明，8 字节魔数足够过白名单；内容不解析）。 */
const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

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

  it('GET /api/lan 返回局域网 IPv4 列表与端口', async () => {
    const r = await fetch(`${base}/api/lan`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as LanResponse;
    expect(j.ok).toBe(true);
    expect(j.port).toBe(17321);
    expect(Array.isArray(j.ips)).toBe(true);
    for (const ip of j.ips) expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(j.ips).not.toContain('127.0.0.1');
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

describe('app 集成：片商字典 CRUD + logo 管理', () => {
  interface StudioItem { id: number; name: string; has_logo: boolean; video_count: number; actor_count: number }
  const post = (body: Record<string, unknown>) => fetch(`${base}/api/studios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const list = async (): Promise<StudioItem[]> =>
    (await ((await fetch(`${base}/api/studios`)).json() as Promise<{ items: StudioItem[] }>)).items;
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

  it('CRUD 同款字典口径；列表不回 logo 字节', async () => {
    await post({ name: '  片商A  ' });
    await post({ name: '片商B' });
    let items = await list();
    expect(items.map((i) => i.name)).toEqual(['片商A', '片商B']); // trim + id 正序
    expect(items.every((i) => i.has_logo === false && i.video_count === 0 && i.actor_count === 0)).toBe(true);
    expect('logo' in (items[0] as unknown as Record<string, unknown>)).toBe(false); // 列表不含 logo 键
    expect((await post({ name: '片商A' })).status).toBe(409); // 重名
    expect((await fetch(`${base}/api/studios/${items[0]!.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '片商A改' }),
    })).status).toBe(200);
    expect((await fetch(`${base}/api/studios/999999/delete`, { method: 'POST' })).status).toBe(404);
    await fetch(`${base}/api/studios/${items[1]!.id}/delete`, { method: 'POST' });
    items = await list();
    expect(items.map((i) => i.name)).toEqual(['片商A改']);
    for (const it of items) await fetch(`${base}/api/studios/${it.id}/delete`, { method: 'POST' }); // 清理
  });

  it('logo：b64 设置 → 字节直出（Content-Type/缓存头）→ 清除 → 随片商删除', async () => {
    const created = await (await post({ name: '带图片商' })).json() as { item: { id: number } };
    const id = created.item.id;
    // b64 设置
    const set = await fetch(`${base}/api/studios/${id}/logo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ b64: b64(PNG_MAGIC) }),
    });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { item: { has_logo: boolean } }).item.has_logo).toBe(true);
    // 字节直出
    const logo = await fetch(`${base}/api/studios/${id}/logo`);
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/png');
    expect(logo.headers.get('cache-control')).toContain('max-age=300');
    expect(new Uint8Array(await logo.arrayBuffer())).toEqual(PNG_MAGIC);
    // 列表 has_logo = true
    expect((await list()).find((i) => i.id === id)?.has_logo).toBe(true);
    // 清除 → 直出 404、has_logo = false
    expect((await fetch(`${base}/api/studios/${id}/logo/delete`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${base}/api/studios/${id}/logo`)).status).toBe(404);
    expect((await list()).find((i) => i.id === id)?.has_logo).toBe(false);
    // 清除不存在的片商 → 404；片商不存在设置 logo → 404
    expect((await fetch(`${base}/api/studios/999999/logo/delete`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/api/studios/999999/logo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ b64: b64(PNG_MAGIC) }),
    })).status).toBe(404);
    await fetch(`${base}/api/studios/${id}/delete`, { method: 'POST' }); // 清理
  });

  it('logo 校验：非图片字节 / 超限 / 空载荷 400', async () => {
    const created = await (await post({ name: '校验片商' })).json() as { item: { id: number } };
    const id = created.item.id;
    const call = (body: Record<string, unknown>) => fetch(`${base}/api/studios/${id}/logo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect((await call({ b64: b64(new TextEncoder().encode('not an image')) })).status).toBe(400);
    expect((await call({ b64: b64(new Uint8Array(513 * 1024).fill(0x89)) })).status).toBe(400); // 超限
    expect((await call({})).status).toBe(400);
    await fetch(`${base}/api/studios/${id}/delete`, { method: 'POST' }); // 清理
  });

  it('logo：URL 抓取（本地测试 HTTP 服务；含 404 与非图片 400 路径）', async () => {
    // 起一个本地服务供给抓取：/ok.png 回魔数字节，/big.png 回超限，/404 回 404
    const src = http.createServer((rq, rs) => {
      if (rq.url === '/ok.png') {
        rs.writeHead(200, { 'Content-Type': 'image/png' });
        rs.end(Buffer.from(PNG_MAGIC));
      } else if (rq.url === '/big.png') {
        rs.writeHead(200, { 'Content-Type': 'image/png' });
        rs.end(Buffer.from(new Uint8Array(513 * 1024).fill(0x89)));
      } else if (rq.url === '/text') {
        rs.writeHead(200, { 'Content-Type': 'text/plain' });
        rs.end('hello');
      } else {
        rs.writeHead(404);
        rs.end();
      }
    });
    await new Promise<void>((r) => src.listen(0, '127.0.0.1', r));
    const addr = src.address();
    const sBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    try {
      const created = await (await post({ name: 'URL片商' })).json() as { item: { id: number } };
      const id = created.item.id;
      const call = (url: string) => fetch(`${base}/api/studios/${id}/logo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const ok = await call(`${sBase}/ok.png`);
      expect(ok.status).toBe(200);
      const logo = await fetch(`${base}/api/studios/${id}/logo`);
      expect(new Uint8Array(await logo.arrayBuffer())).toEqual(PNG_MAGIC);
      expect((await call(`${sBase}/404`)).status).toBe(400); // 抓取 HTTP 错误 → 400
      expect((await call(`${sBase}/big.png`)).status).toBe(400); // 超限
      expect((await call(`${sBase}/text`)).status).toBe(400); // 魔数不符
      expect((await call('ftp://x/y.png')).status).toBe(400); // 非 http(s)
      await fetch(`${base}/api/studios/${id}/delete`, { method: 'POST' }); // 清理
    } finally {
      await new Promise<void>((r) => src.close(() => r()));
    }
  });
});

describe('app 集成：女优（创建建目录 / CRUD / 头像归档流）', () => {
  // 定向测试目录（D: 盘真实创建，测试后递归清理——只删本 describe 自己建的子树）
  const TEST_COUNTRY = '冒烟测试国';
  const TEST_ACTRESS = '冒烟测试女优';
  const TEST_TREE = `d:/archives/${TEST_COUNTRY}/${TEST_ACTRESS}`;

  async function cleanupTree() {
    await fs.rm(TEST_TREE, { recursive: true, force: true }).catch(() => {});
    await fs.rmdir(`d:/archives/${TEST_COUNTRY}`).catch(() => {}); // 国家层目录（空则删）
  }

  it('创建即建目录树（国家/女优/图集，幂等）；列表 join 国家/别名/标签；q 匹配主名与别名', async () => {
    const country = await (await fetch(`${base}/api/countries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: TEST_COUNTRY }),
    })).json() as { item: { id: number } };
    const tag = await (await fetch(`${base}/api/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '冒烟标签' }),
    })).json() as { item: { id: number } };

    const r = await fetch(`${base}/api/actresses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: TEST_ACTRESS, countryId: country.item.id, rating: 87, disk: 'd:',
        tagIds: [tag.item.id], aliases: ['别名甲', '别名乙'],
      }),
    });
    expect(r.status).toBe(200);
    const st = await fs.stat(`${TEST_TREE}/图集`);
    expect(st.isDirectory()).toBe(true);

    const items = (await ((await fetch(`${base}/api/actresses`)).json() as Promise<{ items: ActressItem[] }>)).items;
    const me = items.find((i) => i.name === TEST_ACTRESS)!;
    expect(me.country_name).toBe(TEST_COUNTRY);
    expect(me.rating).toBe(87);
    expect(me.aliases).toEqual(['别名甲', '别名乙']);
    expect(me.tags.map((t) => t.name)).toEqual(['冒烟标签']);

    // q 匹配主名与别名
    const byAlias = (await ((await fetch(`${base}/api/actresses?q=${encodeURIComponent('别名乙')}`)).json() as Promise<{ items: ActressItem[] }>)).items;
    expect(byAlias.some((i) => i.id === me.id)).toBe(true);

    // 重名 409 / 缺国家 400 / 盘符非法 400 / 评分越界 400
    expect((await fetch(`${base}/api/actresses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: TEST_ACTRESS, countryId: country.item.id, disk: 'd:', tagIds: [], aliases: [] }),
    })).status).toBe(409);
    expect((await fetch(`${base}/api/actresses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', countryId: 999999, disk: 'd:', tagIds: [], aliases: [] }),
    })).status).toBe(400);
    expect((await fetch(`${base}/api/actresses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'y', countryId: country.item.id, disk: 'zz', tagIds: [], aliases: [] }),
    })).status).toBe(400);
    expect((await fetch(`${base}/api/actresses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'z', countryId: country.item.id, disk: 'd:', rating: 101, tagIds: [], aliases: [] }),
    })).status).toBe(400);

    // 国家被引用禁删 409
    expect((await fetch(`${base}/api/countries/${country.item.id}/delete`, { method: 'POST' })).status).toBe(409);

    // 编辑全量替换（评分清空、别名/标签换血）
    const tag2 = await (await fetch(`${base}/api/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '冒烟标签2' }),
    })).json() as { item: { id: number } };
    const upd = await (await fetch(`${base}/api/actresses/${me.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: TEST_ACTRESS, countryId: country.item.id, rating: null, tagIds: [tag2.item.id], aliases: ['新别名'] }),
    })).json() as { item: ActressItem };
    expect(upd.item.rating).toBeNull();
    expect(upd.item.aliases).toEqual(['新别名']);
    expect(upd.item.tags.map((t) => t.name)).toEqual(['冒烟标签2']);

    // tags.actor_count 真实化
    const tags = (await ((await fetch(`${base}/api/tags`)).json() as Promise<{ items: { name: string; actor_count: number }[] }>)).items;
    expect(tags.find((t) => t.name === '冒烟标签2')?.actor_count).toBe(1);
    expect(tags.find((t) => t.name === '冒烟标签')?.actor_count).toBe(0);

    // 删除级联清关联；删除后国家可删；头像相关行留给下例
    await fetch(`${base}/api/actresses/${me.id}/delete`, { method: 'POST' });
    expect((await fetch(`${base}/api/countries/${country.item.id}/delete`, { method: 'POST' })).status).toBe(200);
    await fetch(`${base}/api/tags/${tag.item.id}/delete`, { method: 'POST' }); // 级联清关系（无孤儿报错）
    await fetch(`${base}/api/tags/${tag2.item.id}/delete`, { method: 'POST' });
    await cleanupTree();
  });

  it('设为头像：图片 raw 行归档移动到 图集/head.ext（跨盘 copy+unlink），行跟随 + avatar 引用', async () => {
    const country = await (await fetch(`${base}/api/countries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: TEST_COUNTRY }),
    })).json() as { item: { id: number } };
    const actress = await (await fetch(`${base}/api/actresses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: TEST_ACTRESS, countryId: country.item.id, disk: 'd:', tagIds: [], aliases: [] }),
    })).json() as { item: ActressItem };

    // 临时目录造一个图片 raw 行（跨盘：tmp 在 c: → 目标在 d:）
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rou-avatar-'));
    const src = path.join(dir, 'photo.png');
    await fs.writeFile(src, Buffer.from(PNG_MAGIC));
    upsertRawScanned({
      path: normPath(src), hash: 'avatar-h1', name: 'photo', ext: 'png',
      type: 'image', size: PNG_MAGIC.length, mtime: 1000, volume: 'c:', seen: 2000,
    });
    const rawRow = getRawByPath(normPath(src))!;

    const r = await fetch(`${base}/api/actresses/${actress.item.id}/avatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: rawRow.id }),
    });
    expect(r.status).toBe(200);
    const after = (await r.json()) as { item: ActressItem };
    expect(after.item.avatar_file_id).toBe(rawRow.id);

    // 文件已移动到图集/head.png；原文件不在
    const moved = `${TEST_TREE}/图集/head.png`;
    expect((await fs.readFile(moved)).equals(Buffer.from(PNG_MAGIC))).toBe(true);
    await expect(fs.stat(src)).rejects.toThrow();

    // raw 行跟随：path 更新、archived=1；归档登记最新名 head；事件含 move
    const row = getRawByPath(normPath(moved))!;
    expect(row.archived).toBe(true);
    expect(row.volume).toBe('d:');
    const arc = db.prepare('SELECT name FROM raw_archive WHERE file_id = ?').get(rawRow.id) as { name: string };
    expect(arc.name).toBe('head');
    const evs = db.prepare('SELECT kind FROM raw_events WHERE file_id = ?').all(rawRow.id) as { kind: string }[];
    expect(evs.map((e) => e.kind)).toContain('move');
    expect(evs.map((e) => e.kind)).toContain('rename'); // photo.png → head.png

    // 非图片行 400；不存在的女优/文件 404
    const vidDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rou-avatar-v-'));
    const vid = path.join(vidDir, 'clip.mp4');
    await fs.writeFile(vid, 'x');
    upsertRawScanned({ path: normPath(vid), hash: 'avatar-h2', name: 'clip', ext: 'mp4', type: 'video', size: 1, mtime: 1000, volume: 'c:', seen: 2000 });
    const vidRow = getRawByPath(normPath(vid))!;
    expect((await fetch(`${base}/api/actresses/${actress.item.id}/avatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: vidRow.id }),
    })).status).toBe(400);
    expect((await fetch(`${base}/api/actresses/999999/avatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: rawRow.id }),
    })).status).toBe(404);

    // 清理：raw 行、女优、国家、临时与目标目录
    db.exec(`DELETE FROM raw_events WHERE file_id IN (${rawRow.id}, ${vidRow.id})`);
    db.exec(`DELETE FROM raw_archive WHERE file_id = ${rawRow.id}`);
    db.exec(`DELETE FROM raw_files WHERE id IN (${rawRow.id}, ${vidRow.id})`);
    await fetch(`${base}/api/actresses/${actress.item.id}/delete`, { method: 'POST' });
    await fetch(`${base}/api/countries/${country.item.id}/delete`, { method: 'POST' });
    await fs.rm(vidDir, { recursive: true, force: true });
    await fs.rm(dir, { recursive: true, force: true });
    await cleanupTree();
  });
});

describe('app 集成：视频归档（单片流程 + 作品落库）', () => {
  const T = {
    country: '归档测试国',
    actress: '归档测试女优',
    actress2: '归档测试女优2',
    tag: '归档测试标签',
    studio: '归档测试片商',
    tree: 'd:/archives/归档测试国/归档测试女优',
    tree2: 'd:/archives/归档测试国/归档测试女优2',
  };

  /** 建基础数据（国家 + 两位女优同盘 + 标签 + 片商），返回各 id。 */
  async function setup() {
    const post = (url: string, body: unknown) => fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const country = await (await post('/api/countries', { name: T.country })).json() as { item: { id: number } };
    const a1 = await (await post('/api/actresses', { name: T.actress, countryId: country.item.id, rating: 80, disk: 'd:', tagIds: [], aliases: [] })).json() as { item: ActressItem };
    const a2 = await (await post('/api/actresses', { name: T.actress2, countryId: country.item.id, rating: 55, disk: 'd:', tagIds: [], aliases: [] })).json() as { item: ActressItem };
    const tag = await (await post('/api/tags', { name: T.tag })).json() as { item: { id: number } };
    const studio = await (await post('/api/studios', { name: T.studio })).json() as { item: { id: number } };
    return { countryId: country.item.id, a1: a1.item.id, a2: a2.item.id, tagId: tag.item.id, studioId: studio.item.id };
  }

  async function cleanup(ids: ReturnType<typeof setup> extends Promise<infer R> ? R : never, extra: string[]) {
    for (const f of extra) await fs.rm(f, { recursive: true, force: true }).catch(() => {});
    await fs.rm(T.tree, { recursive: true, force: true }).catch(() => {});
    await fs.rm(T.tree2, { recursive: true, force: true }).catch(() => {});
    await fs.rmdir(`d:/archives/${T.country}`).catch(() => {});
    db.exec('DELETE FROM actress_videos');
    db.exec('DELETE FROM tag_videos');
    db.exec('DELETE FROM studio_videos');
    db.exec('DELETE FROM country_videos');
    db.exec('DELETE FROM videos');
    await fetch(`${base}/api/actresses/${ids.a1}/delete`, { method: 'POST' });
    await fetch(`${base}/api/actresses/${ids.a2}/delete`, { method: 'POST' });
    await fetch(`${base}/api/countries/${ids.countryId}/delete`, { method: 'POST' });
    await fetch(`${base}/api/tags/${ids.tagId}/delete`, { method: 'POST' });
    await fetch(`${base}/api/studios/${ids.studioId}/delete`, { method: 'POST' });
  }

  /** 造一个 raw 文件 + 行。 */
  async function makeRaw(name: string, ext: string, type: 'video' | 'image', hash: string): Promise<{ id: number; path: string; dir: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rou-varch-'));
    const p = path.join(dir, name);
    await fs.writeFile(p, Buffer.from(PNG_MAGIC)); // 内容不解析，任意字节
    upsertRawScanned({ path: normPath(p), hash, name: name.replace(/\.[a-z0-9]+$/i, ''), ext, type, size: 12, mtime: 1000, volume: 'c:', seen: 3000 });
    const row = getRawByPath(normPath(p))!;
    return { id: row.id, path: p, dir };
  }

  it('归档：双文件移动改名（番号 标题 副标题）+ 关系表 + 计数真实化 + 列表', async () => {
    const ids = await setup();
    const vid = await makeRaw('clip.mp4', 'mp4', 'video', 'varch-v1');
    const cover = await makeRaw('clip.jpg', 'jpg', 'image', 'varch-c1');
    try {
      // 加分制校验：基础分 = 演员最高评分 80 → 上限 20；21 → 400 且不动文件
      const over = await fetch(`${base}/api/videos/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: vid.id, title: '标题', rating: 21,
          actressIds: [ids.a1, ids.a2], countryId: ids.countryId, tagIds: [], kind: 'single',
        }),
      });
      expect(over.status).toBe(400);
      expect((await fs.readFile(vid.path)).length).toBeGreaterThan(0); // 原文件未动

      const r = await fetch(`${base}/api/videos/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: vid.id, coverFileId: cover.id,
          title: '标题', subtitle: '副题', code: 'ABC-123', rating: 20,
          actressIds: [ids.a1, ids.a2], countryId: ids.countryId, tagIds: [ids.tagId], studioId: ids.studioId, kind: 'single',
        }),
      });
      expect(r.status).toBe(200);
      const j = await r.json() as { item: { id: number; title: string; code: string; rating: number | null; base_rating: number } };
      expect(j.item.title).toBe('标题');
      expect(j.item.rating).toBe(20); // 加分配额
      expect(j.item.base_rating).toBe(80); // 基础分 = 演员最高评分

      // 卡片评分环：加分上限 100−80=20——21 → 400；15 → 200；null → 清除
      const put = (body: unknown) => fetch(`${base}/api/videos/${j.item.id}/rating`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect((await put({ rating: 21 })).status).toBe(400);
      const ok15 = await (await put({ rating: 15 })).json() as { item: { rating: number | null } };
      expect(ok15.item.rating).toBe(15);
      const clr = await (await put({ rating: null })).json() as { item: { rating: number | null } };
      expect(clr.item.rating).toBeNull();

      // 落盘：第一个演员目录树（第二位演员目录无文件）、命名「番号 标题 副题」
      const stem = 'ABC-123 标题 副题';
      expect((await fs.readFile(`${T.tree}/${stem}.mp4`)).length).toBeGreaterThan(0);
      expect((await fs.readFile(`${T.tree}/${stem}.jpg`)).length).toBeGreaterThan(0);
      await expect(fs.stat(`${T.tree2}/${stem}.mp4`)).rejects.toThrow();
      await expect(fs.stat(vid.path)).rejects.toThrow(); // 原位置已移走

      // raw 行跟随 + 归档
      expect(getRawByPath(normPath(`${T.tree}/${stem}.mp4`))?.archived).toBe(true);
      expect(getRawByPath(normPath(`${T.tree}/${stem}.jpg`))?.archived).toBe(true);

      // 作品列表 + 关系
      const list = await (await fetch(`${base}/api/works`)).json() as { total: number; items: ActressItem2[] };
      expect(list.total).toBe(1);
      const v = list.items[0]!;
      expect(v.code).toBe('ABC-123');
      expect(v.actresses.map((a) => a.name)).toEqual([T.actress, T.actress2]);
      expect(v.studios.map((s) => s.name)).toEqual([T.studio]);
      expect(v.countries.map((c) => c.name)).toEqual([T.country]);
      expect(v.tags.map((t) => t.name)).toEqual([T.tag]);

      // 计数真实化：女优 video_count / 标签 video_count / 片商两计数
      const acts = await (await fetch(`${base}/api/actresses`)).json() as { items: ActressItem[] };
      expect(acts.items.find((a) => a.id === ids.a1)?.video_count).toBe(1);
      const tags = await (await fetch(`${base}/api/tags`)).json() as { items: { id: number; video_count: number }[] };
      expect(tags.items.find((t) => t.id === ids.tagId)?.video_count).toBe(1);
      const sts = await (await fetch(`${base}/api/studios`)).json() as { items: { id: number; video_count: number; actor_count: number }[] };
      const st = sts.items.find((s) => s.id === ids.studioId)!;
      expect(st.video_count).toBe(1);
      expect(st.actor_count).toBe(2); // 两位演员去重
    } finally {
      await cleanup(ids, [vid.dir, cover.dir]);
      db.exec(`DELETE FROM raw_files WHERE hash IN ('varch-v1', 'varch-c1')`);
    }
  });

  it('无封面归档（无番号命名）；冲突 409；校验 400', async () => {
    const ids = await setup();
    const vid = await makeRaw('solo.mp4', 'mp4', 'video', 'varch-v2');
    const call = (body: unknown) => fetch(`${base}/api/videos/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    try {
      // 无封面无番号：命名「标题 副题」
      const r = await call({ fileId: vid.id, title: '独奏', subtitle: '', actressIds: [ids.a1], countryId: ids.countryId, tagIds: [], kind: 'single' });
      expect(r.status).toBe(200);
      expect((await fs.readFile(`${T.tree}/独奏.mp4`)).length).toBeGreaterThan(0);

      // 再造一个文件归档同名 → 409
      const vid2 = await makeRaw('again.mp4', 'mp4', 'video', 'varch-v3');
      const r2 = await call({ fileId: vid2.id, title: '独奏', actressIds: [ids.a1], countryId: ids.countryId, tagIds: [], kind: 'single' });
      expect(r2.status).toBe(409);
      expect(getRawByPath(normPath(vid2.path))).toBeTruthy(); // 冲突未动文件
      await fs.rm(vid2.dir, { recursive: true, force: true });
      db.exec(`DELETE FROM raw_files WHERE hash = 'varch-v3'`);

      // 校验：无标题 400 / 无演员 400 / 图片归档 400 / kind=series 400
      expect((await call({ fileId: vid.id, title: '', actressIds: [ids.a1], countryId: ids.countryId, tagIds: [], kind: 'single' })).status).toBe(400);
      expect((await call({ fileId: vid.id, title: 'x', actressIds: [], countryId: ids.countryId, tagIds: [], kind: 'single' })).status).toBe(400);
      const img = await makeRaw('pic.jpg', 'jpg', 'image', 'varch-i1');
      expect((await call({ fileId: img.id, title: 'x', actressIds: [ids.a1], countryId: ids.countryId, tagIds: [], kind: 'single' })).status).toBe(400);
      expect((await call({ fileId: vid.id, title: 'x', actressIds: [ids.a1], countryId: ids.countryId, tagIds: [], kind: 'series' })).status).toBe(400);
      await fs.rm(img.dir, { recursive: true, force: true });
      db.exec(`DELETE FROM raw_files WHERE hash = 'varch-i1'`);
    } finally {
      await cleanup(ids, [vid.dir]);
      db.exec(`DELETE FROM raw_files WHERE hash IN ('varch-v2')`);
    }
  });
});

/** 作品条目（本文件局部形状，断言用）。 */
interface ActressItem2 {
  id: number;
  title: string;
  code: string | null;
  actresses: { id: number; name: string }[];
  tags: { id: number; name: string }[];
  studios: { id: number; name: string }[];
  countries: { id: number; name: string }[];
}

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
