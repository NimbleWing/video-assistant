import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Layout } from './Layout';

const TABS = [
  { key: 'videos', label: '视频库' },
  { key: 'settings', label: '设置' },
] as const;

describe('Layout', () => {
  it('渲染标题、补充信息与内容', () => {
    render(
      <Layout title="本地媒体库" headerExtra="视频 1 · 命中 1">
        <div>内容区</div>
      </Layout>,
    );
    expect(screen.getByRole('heading', { level: 1, name: '本地媒体库' })).toBeTruthy();
    expect(screen.getByText('视频 1 · 命中 1')).toBeTruthy();
    expect(screen.getByText('内容区')).toBeTruthy();
  });

  it('渲染标签栏：选中态与切换回调', () => {
    const onTabChange = vi.fn();
    render(
      <Layout title="t" tabs={TABS} activeTab="videos" onTabChange={onTabChange}>
        <div />
      </Layout>,
    );
    expect(screen.getByRole('button', { name: '视频库' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: '设置' }).getAttribute('aria-selected')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(onTabChange).toHaveBeenCalledWith('settings');
  });

  it('无 tabs 时不渲染标签栏', () => {
    render(
      <Layout title="t">
        <div />
      </Layout>,
    );
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('无 headerExtra 时不渲染补充信息占位', () => {
    render(
      <Layout title="t">
        <div />
      </Layout>,
    );
    expect(document.querySelector('header span')).toBeNull();
  });

  it('收合切换：按钮切换 data-collapsed 并持久化 localStorage', () => {
    localStorage.removeItem('side-nav-collapsed');
    render(
      <Layout title="t" tabs={TABS} activeTab="videos">
        <div />
      </Layout>,
    );
    const nav = document.querySelector('nav');
    expect(nav?.getAttribute('data-collapsed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '收合侧边栏' }));
    expect(nav?.getAttribute('data-collapsed')).toBe('true');
    expect(nav?.className).toContain('lg:w-[76px]');
    expect(localStorage.getItem('side-nav-collapsed')).toBe('1');
    expect(screen.getByRole('button', { name: '展开侧边栏' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '展开侧边栏' }));
    expect(nav?.getAttribute('data-collapsed')).toBe('false');
    expect(localStorage.getItem('side-nav-collapsed')).toBe('0');
  });

  it('初始状态读自 localStorage', () => {
    localStorage.setItem('side-nav-collapsed', '1');
    render(
      <Layout title="t" tabs={TABS}>
        <div />
      </Layout>,
    );
    expect(document.querySelector('nav')?.getAttribute('data-collapsed')).toBe('true');
    localStorage.removeItem('side-nav-collapsed');
  });
});
