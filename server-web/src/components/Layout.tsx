import { useState } from 'react';
import type { ReactNode } from 'react';

/** 页面骨架：顶栏（标题 + 补充信息）+ 左侧侧边栏导航（可选，桌面端可收合为 rail）+ 内容区。移动端侧边栏为 off-canvas 抽屉。 */
export interface TabItem<K extends string> {
  key: K;
  label: string;
  /** 导航图标（侧边栏项前缀） */
  icon?: ReactNode;
}

interface LayoutProps<K extends string> {
  /** 页面标题 */
  title: ReactNode;
  /** 标题右侧补充信息（如头部统计） */
  headerExtra?: ReactNode;
  /** 侧边栏导航项；缺省或为空时不渲染侧边栏与切换按钮 */
  tabs?: readonly TabItem<K>[];
  activeTab?: K;
  onTabChange?: (key: K) => void;
  children: ReactNode;
}

const COLLAPSE_KEY = 'side-nav-collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

export function Layout<K extends string>({ title, headerExtra, tabs, activeTab, onTabChange, children }: LayoutProps<K>) {
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const hasTabs = !!tabs && tabs.length > 0;
  const select = (key: K) => {
    onTabChange?.(key);
    setNavOpen(false);
  };
  const toggleCollapse = () => {
    setCollapsed((v) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, v ? '0' : '1');
      } catch {
        // localStorage 不可用时仅内存态
      }
      return !v;
    });
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
        <div className="flex h-14 items-center gap-3 px-5 lg:px-6">
          {hasTabs && (
            <button
              type="button"
              className="act lg:hidden"
              aria-label="菜单"
              aria-expanded={navOpen}
              onClick={() => setNavOpen((v) => !v)}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 6.5h16M4 12h16M4 17.5h16" />
              </svg>
            </button>
          )}
          {hasTabs && (
            <button
              type="button"
              onClick={toggleCollapse}
              aria-label={collapsed ? '展开侧边栏' : '收合侧边栏'}
              title={collapsed ? '展开侧边栏' : '收合侧边栏'}
              className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-line text-dim transition-colors hover:bg-raised hover:text-ink lg:inline-flex"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="4.5" width="18" height="15" rx="3" />
                <path d="M9.5 4.5v15" />
              </svg>
            </button>
          )}
          <h1 className="m-0 flex items-center gap-2.5 text-[17px] font-bold tracking-tight">{title}</h1>
          {headerExtra != null && <span className="text-[13px] text-dim">{headerExtra}</span>}
        </div>
      </header>
      {navOpen && hasTabs && (
        <div className="fixed inset-x-0 bottom-0 top-14 z-30 bg-black/50 lg:hidden" aria-hidden onClick={() => setNavOpen(false)} />
      )}
      <div className="lg:flex">
        {hasTabs && (
          <nav
            aria-label="标签"
            data-collapsed={collapsed ? 'true' : 'false'}
            className={`fixed bottom-0 left-0 top-14 z-40 flex w-[216px] flex-col gap-0.5 border-r border-line bg-surface px-4 py-6 transition-[width,transform] duration-200 lg:sticky lg:bottom-auto lg:self-start lg:h-[calc(100vh-3.5rem)] lg:translate-x-0 ${
              collapsed ? 'lg:w-[76px] lg:px-2.5' : 'lg:w-[216px]'
            } ${navOpen ? 'translate-x-0' : '-translate-x-full'}`}
          >
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                className="side-item"
                aria-selected={t.key === activeTab}
                title={collapsed ? t.label : undefined}
                onClick={() => select(t.key)}
              >
                {t.icon}
                <span className="side-label">{t.label}</span>
              </button>
            ))}
            <div className="side-foot mt-auto border-t border-line px-3.5 pt-3.5 text-xs leading-relaxed text-dim">
              127.0.0.1:17321
              <br />
              本地媒体服务
            </div>
          </nav>
        )}
        <main className="min-w-0 flex-1 px-5 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
