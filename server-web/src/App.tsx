import { useState } from 'react';
import type { ReactNode } from 'react';
import { Layout } from '@/components/Layout';
import { PlayerDialog } from '@/components/PlayerDialog';
import type { PlaySource } from '@/components/PlayerDialog';
import { Videos } from '@/features/Videos';
import { Raw } from '@/features/Raw';
import { Archive } from '@/features/Archive';
import { Ledger } from '@/features/Ledger';
import { Country } from '@/features/Country';
import { Settings } from '@/features/Settings';

type Tab = 'videos' | 'raw' | 'archive' | 'ledger' | 'country' | 'settings';

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
    key: 'raw',
    label: '原始资料',
    icon: icon(
      <>
        <ellipse cx="12" cy="5.5" rx="8" ry="2.8" />
        <path d="M4 5.5v13c0 1.55 3.58 2.8 8 2.8s8-1.25 8-2.8v-13" />
        <path d="M4 12c0 1.55 3.58 2.8 8 2.8s8-1.25 8-2.8" />
      </>,
    ),
  },
  {
    key: 'archive',
    label: '归档资料',
    icon: icon(
      <>
        <rect x="3" y="4" width="18" height="5" rx="1.5" />
        <path d="M5 9v9.5c0 1 .8 1.5 1.8 1.5h10.4c1 0 1.8-.5 1.8-1.5V9" />
        <path d="M10 13h4" />
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
    key: 'country',
    label: '国家',
    icon: icon(
      <>
        <circle cx="12" cy="12" r="8.5" />
        <ellipse cx="12" cy="12" rx="3.5" ry="8.5" />
        <path d="M3.5 12h17" />
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
  const [playing, setPlaying] = useState<PlaySource | null>(null);

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
        {tab === 'videos' && (
          <Videos
            onStat={setStat}
            onPlay={(it) =>
              setPlaying({ path: it.path, direct: `/stream/${it.id}`, hls: `/stream/${it.id}/index.m3u8` })
            }
          />
        )}
        {tab === 'raw' && <Raw onStat={setStat} onPlay={setPlaying} />}
        {tab === 'archive' && <Archive onStat={setStat} onPlay={setPlaying} />}
        {tab === 'ledger' && <Ledger />}
        {tab === 'country' && <Country />}
        {tab === 'settings' && <Settings />}
      </Layout>
      <PlayerDialog item={playing} onClose={() => setPlaying(null)} />
    </>
  );
}
