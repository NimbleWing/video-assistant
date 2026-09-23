import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchConfig, fetchDownloads, fetchRawDuplicates, saveConfig } from './api';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  fetchMock.mockReset();
});

describe('api', () => {
  it('成功返回解析后的 JSON', async () => {
    fetchMock.mockResolvedValue(okJson({ ok: true, ffmpegPath: 'D:\\ffmpeg.exe' }));
    const j = await fetchConfig();
    expect(j.ffmpegPath).toBe('D:\\ffmpeg.exe');
    expect(fetchMock).toHaveBeenCalledWith('/api/config', undefined);
  });

  it('ok:false 抛出服务端 error', async () => {
    fetchMock.mockResolvedValue(okJson({ ok: false, error: '坏了' }));
    await expect(fetchConfig()).rejects.toThrow('坏了');
  });

  it('HTTP 错误且响应非 JSON 时回退 statusText', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500, statusText: 'ISE' }));
    await expect(fetchConfig()).rejects.toThrow('ISE');
  });

  it('saveConfig 以 POST + JSON 体发送（仅 ffmpegPath）', async () => {
    fetchMock.mockResolvedValue(okJson({ ok: true, warnings: [] }));
    await saveConfig('D:\\ffmpeg.exe');
    const [path, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/config');
    expect(opts.method).toBe('POST');
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(opts.body).toBe(JSON.stringify({ ffmpegPath: 'D:\\ffmpeg.exe' }));
  });

  it('fetchDownloads 拼接查询参数（空字段省略）', async () => {
    fetchMock.mockResolvedValue(okJson({ ok: true, total: 0, items: [], counts: {} }));
    await fetchDownloads({ page: 2, size: 50, status: 'failed' });
    const [path] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/downloads?page=2&size=50&status=failed');
  });

  it('fetchRawDuplicates 拼接分页参数', async () => {
    fetchMock.mockResolvedValue(okJson({ ok: true, total: 0, wastedTotal: 0, items: [] }));
    await fetchRawDuplicates({ page: 2, size: 20 });
    const [path] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/raw/duplicates?page=2&size=20');
  });
});
