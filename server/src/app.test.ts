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
