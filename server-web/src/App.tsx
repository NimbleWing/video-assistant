import { useState } from 'react';
import type { ReactNode } from 'react';
import { Layout } from '@/components/Layout';
import { PlayerDialog } from '@/components/PlayerDialog';
import type { PlaySource } from '@/components/PlayerDialog';
import { ImageViewer } from '@/components/ImageViewer';
import type { ViewImage } from '@/components/ImageViewer';
import { QrDialog } from '@/components/QrDialog';
import { Raw } from '@/features/Raw';
import { Archive } from '@/features/Archive';
import { Ledger } from '@/features/Ledger';
import { Country } from '@/features/Country';
import { Tag } from '@/features/Tag';
import { Studio } from '@/features/Studio';
import { Actress } from '@/features/Actress';
import { Video } from '@/features/Video';
import { Settings } from '@/features/Settings';

type Tab = 'raw' | 'archive' | 'video' | 'ledger' | 'country' | 'tag' | 'studio' | 'actress' | 'settings';

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
    key: 'video',
    label: '视频库',
    icon: icon(
      <>
        <rect x="3" y="5" width="18" height="14" rx="2.5" />
        <path d="M10.3 9.4v5.2l4.6-2.6z" fill="currentColor" stroke="none" />
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
    key: 'tag',
    label: '标签',
    icon: icon(
      <>
        <path d="M9.5 4.5 7.8 19.5M16.2 4.5 14.5 19.5M4.8 9.2h14.4M4 15h14.4" />
      </>,
    ),
  },
  {
    key: 'studio',
    label: '片商',
    icon: icon(
      <>
        <rect x="2" y="6.5" width="12.5" height="11" rx="2.5" />
        <path d="M14.5 10.8l5.2-2.9v8.2l-5.2-2.9" />
      </>,
    ),
  },
  {
    key: 'actress',
    label: '女优',
    icon: icon(
      <>
        <circle cx="12" cy="8.2" r="3.4" />
        <path d="M5.5 19.5c.9-3.3 3.5-5 6.5-5s5.6 1.7 6.5 5" />
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
  const [tab, setTab] = useState<Tab>('raw');
  const [stat, setStat] = useState('加载中…');
  const [playing, setPlaying] = useState<PlaySource | null>(null);
  const [viewing, setViewing] = useState<{ items: ViewImage[]; index: number } | null>(null);
  const [qrOpen, setQrOpen] = useState(false);

  return (
    <>
      <Layout
        title={
          <>
            <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-full bg-brand shadow-[0_0_10px_#f07759aa]" />
            <button
              type="button"
              title="手机扫码访问（同一 WiFi）"
              className="cursor-pointer rounded-md px-1 transition-colors hover:bg-raised"
              onClick={() => setQrOpen(true)}
            >
              本地媒体库
            </button>
          </>
        }
        headerExtra={stat}
        tabs={TABS}
        activeTab={tab}
        onTabChange={setTab}
      >
        {tab === 'raw' && <Raw onStat={setStat} onPlay={setPlaying} onView={(items, index) => setViewing({ items, index })} />}
        {tab === 'archive' && (
          <Archive onStat={setStat} onPlay={setPlaying} onView={(items, index) => setViewing({ items, index })} />
        )}
        {tab === 'video' && <Video onStat={setStat} onPlay={setPlaying} onView={(items, index) => setViewing({ items, index })} />}
        {tab === 'ledger' && <Ledger />}
        {tab === 'country' && <Country />}
        {tab === 'tag' && <Tag />}
        {tab === 'studio' && <Studio />}
        {tab === 'actress' && <Actress />}
        {tab === 'settings' && <Settings />}
      </Layout>
      <PlayerDialog item={playing} onClose={() => setPlaying(null)} />
      <ImageViewer items={viewing?.items ?? null} index={viewing?.index ?? 0} onClose={() => setViewing(null)} />
      {qrOpen ? <QrDialog onClose={() => setQrOpen(false)} /> : null}
    </>
  );
}
