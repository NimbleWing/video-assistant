import { useState } from 'react';
import type { ReactNode } from 'react';
import { Layout } from './components/Layout';
import { LedgerSection } from './components/LedgerSection';
import { PlayerDialog } from './components/PlayerDialog';
import { SettingsSection } from './components/SettingsSection';
import { VideosSection } from './components/VideosSection';

type Tab = 'videos' | 'ledger' | 'settings';

const icon = (path: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {path}
  </svg>
);

const TABS = [
  {
    key: 'videos',
    label: '视频库',
    icon: icon(
      <>
        <rect x="2.5" y="4.5" width="19" height="15" rx="3" />
        <path d="M10 9.2v5.6l5-2.8z" fill="currentColor" stroke="none" />
      </>,
    ),
  },
  {
    key: 'ledger',
    label: '下载账本',
    icon: icon(
      <>
        <rect x="4" y="3.5" width="16" height="17" rx="3" />
        <path d="M8.5 8.5h7M8.5 12.5h7M8.5 16.5h4" />
      </>,
    ),
  },
  {
    key: 'settings',
    label: '设置',
    icon: icon(
      <>
        <path d="M4 7h16M4 12h16M4 17h16" />
        <path d="M9 5v4M15 10v4M7 15v4" />
      </>,
    ),
  },
] as const satisfies readonly { key: Tab; label: string; icon: ReactNode }[];

export default function App() {
  const [tab, setTab] = useState<Tab>('videos');
  const [stat, setStat] = useState('加载中…');
  const [playing, setPlaying] = useState<{ id: number; path: string } | null>(null);

  return (
    <>
      <Layout
        title={
          <>
            <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-full bg-brand shadow-[0_0_10px_#f07759aa]" />
            本地媒体库
          </>
        }
        headerExtra={stat}
        tabs={TABS}
        activeTab={tab}
        onTabChange={setTab}
      >
        {tab === 'videos' && <VideosSection onStat={setStat} onPlay={setPlaying} />}
        {tab === 'ledger' && <LedgerSection />}
        {tab === 'settings' && <SettingsSection />}
      </Layout>
      <PlayerDialog item={playing} onClose={() => setPlaying(null)} />
    </>
  );
}
