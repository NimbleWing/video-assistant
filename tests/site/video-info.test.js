// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPageProps, getVideoInfo, getVideoInfoFresh, videoIdFromPath } from '../../src/site/video-info.js';

/** 站点的 ev 编码：JSON → 逐字符 +k → base64 @param {any} obj @param {number} [k] */
function encodeEv(obj, k = 3) {
  return {
    d: btoa(JSON.stringify(obj).split('').map((c) => String.fromCharCode(c.charCodeAt(0) + k)).join('')),
    k,
  };
}

/** 写入 __NEXT_DATA__ 并定位到指定路径 @param {string} path @param {any} pageProps */
function setupPage(path, pageProps) {
  window.happyDOM.setURL(`https://rou.video${path}`);
  document.body.innerHTML = pageProps == null
    ? ''
    : `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps } })}</script>`;
}

const VIDEO_PROPS = {
  video: { id: 'abc123', name: '测试视频', duration: 61, coverImageUrl: 'https://cdn.example.com/c.jpg' },
  series: { nameZh: '测试剧集', coverImageUrl: 'https://cdn.example.com/s.jpg' },
  ev: encodeEv({ videoUrl: 'https://cdn.example.com/v/abc123/index.png' }),
};

beforeEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('videoIdFromPath', () => {
  it('提取 /v/ 后的 id', () => {
    setupPage('/v/abc123', null);
    expect(videoIdFromPath()).toBe('abc123');
  });
  it('URL 编码的 id 会解码', () => {
    setupPage('/v/%E4%B8%AD%E6%96%87', null);
    expect(videoIdFromPath()).toBe('中文');
  });
  it('非播放页返回空串', () => {
    setupPage('/series', null);
    expect(videoIdFromPath()).toBe('');
  });
});

describe('getPageProps', () => {
  it('读取 props.pageProps', () => {
    setupPage('/v/abc123', { hello: 1 });
    expect(getPageProps().hello).toBe(1);
  });
  it('兼容裸 pageProps 字段', () => {
    window.happyDOM.setURL('https://rou.video/v/abc123');
    document.body.innerHTML = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ pageProps: { bare: true } })}</script>`;
    expect(getPageProps().bare).toBe(true);
  });
  it('无数据返回空对象', () => {
    setupPage('/v/abc123', null);
    expect(getPageProps()).toEqual({});
  });
});

describe('getVideoInfo', () => {
  it('解析视频信息与系列信息', () => {
    setupPage('/v/abc123', VIDEO_PROPS);
    const info = getVideoInfo();
    if (!info) throw new Error('info 不应为 null');
    expect(info.id).toBe('abc123');
    expect(info.name).toBe('测试视频');
    expect(info.duration).toBe(61);
    expect(info.videoUrl).toBe('https://cdn.example.com/v/abc123/index.png');
    expect(info.seriesName).toBe('测试剧集');
    expect(info.seriesCoverUrl).toBe('https://cdn.example.com/s.jpg');
    expect(info.coverUrl).toBe('https://cdn.example.com/c.jpg');
  });

  it('页面 id 与地址栏不一致时拒绝采信（SPA 缓存页）', () => {
    setupPage('/v/other-id', VIDEO_PROPS);
    expect(getVideoInfo()).toBeNull();
  });

  it('ev 缺失或损坏返回 null', () => {
    setupPage('/v/abc123', { video: { id: 'abc123' } });
    expect(getVideoInfo()).toBeNull();
    setupPage('/v/abc123', { video: { id: 'abc123' }, ev: { d: '!!!', k: 1 } });
    expect(getVideoInfo()).toBeNull();
  });

  it('name 缺省回退 nameZh', () => {
    setupPage('/v/abc123', {
      video: { id: 'abc123', nameZh: '中文名' },
      ev: encodeEv({ videoUrl: 'https://cdn.example.com/x.m3u8' }),
    });
    expect(getVideoInfo()?.name).toBe('中文名');
  });
});

describe('DOM 兜底（站点无 __NEXT_DATA__）', () => {
  it('h1 拆剧名/集数，og:image 作封面', () => {
    setupPage('/v/abc123', null);
    document.body.innerHTML = '<h1>测试剧集 · 第 3 集</h1>';
    document.head.innerHTML = '<meta property="og:image" content="https://cdn.example.com/c.jpg">';
    const info = getVideoInfo();
    expect(info).toMatchObject({
      id: 'abc123',
      name: '测试剧集 第3集',
      seriesName: '测试剧集',
      coverUrl: 'https://cdn.example.com/c.jpg',
    });
    expect(info?.masterM3u8).toBe(''); // 无直出播放地址，boot 走嗅探/API 兜底
  });

  it('单片：h1 无集数段 → name=h1、seriesName 为空', () => {
    setupPage('/v/xyz', null);
    document.body.innerHTML = '<h1>单一片</h1>';
    expect(getVideoInfo()).toMatchObject({ id: 'xyz', name: '单一片', seriesName: '' });
  });

  it('无 h1 时仍返回 null（交给抓取兜底）', () => {
    setupPage('/v/abc123', null);
    expect(getVideoInfo()).toBeNull();
  });

  it('__NEXT_DATA__ 存在时优先于 DOM', () => {
    setupPage('/v/abc123', VIDEO_PROPS);
    document.body.innerHTML += '<h1>DOM 名字</h1>';
    expect(getVideoInfo()?.name).toBe('测试视频');
  });
});

describe('getVideoInfoFresh', () => {
  it('本地命中时不走网络', async () => {
    setupPage('/v/abc123', VIDEO_PROPS);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const info = await getVideoInfoFresh();
    expect(info?.id).toBe('abc123');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('本地未命中时重新抓取页面解析', async () => {
    setupPage('/v/abc123', null); // 本地无 NEXT_DATA
    const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: VIDEO_PROPS } })}</script></body></html>`;
    vi.stubGlobal('fetch', vi.fn(async () => ({ text: async () => html })));
    const info = await getVideoInfoFresh();
    expect(info?.id).toBe('abc123');
    expect(info?.name).toBe('测试视频');
  });

  it('抓取失败返回 null 而不抛', async () => {
    setupPage('/v/abc123', null);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('网络挂了'); }));
    await expect(getVideoInfoFresh()).resolves.toBeNull();
  });

  it('非播放页直接返回 null', async () => {
    setupPage('/series', null);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(getVideoInfoFresh()).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
