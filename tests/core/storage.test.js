// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from '../helpers/chrome-mock.js';

/** @type {ReturnType<typeof installChromeMock>} */
let mock;
/** @type {typeof import('../../src/core/storage.js')} */
let mod;

beforeEach(async () => {
  vi.resetModules();
  mock = installChromeMock();
  mod = await import('../../src/core/storage.js');
});

afterEach(() => {
  mock.restore();
});

describe('storage（chrome.storage.local 后端）', () => {
  it('set/get 往返，键带命名空间前缀', async () => {
    await mod.storage.set('holdRate', 3);
    expect(mock.store.get('rv-hud:holdRate')).toBe(3);
    expect(await mod.storage.get('holdRate', 2)).toBe(3);
  });

  it('未命中返回 fallback', async () => {
    expect(await mod.storage.get('不存在', '默认')).toBe('默认');
  });

  it('chrome 存储抛错时回退 fallback 而不抛', async () => {
    vi.spyOn(mock.chrome.storage.local, 'get').mockRejectedValue(new Error('上下文销毁'));
    expect(await mod.storage.get('holdRate', 2)).toBe(2);
  });

  it('set 抛错时静默降级 localStorage', async () => {
    vi.spyOn(mock.chrome.storage.local, 'set').mockRejectedValue(new Error('配额满'));
    await mod.storage.set('holdBoost', true);
    expect(localStorage.getItem('rv-hud:holdBoost')).toBe('true');
  });
});
