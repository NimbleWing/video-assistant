import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from './app.ts';
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

  it('GET / 提供管理页静态资源', async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
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
