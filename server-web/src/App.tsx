import { useState } from 'react';
import { LedgerSection } from './components/LedgerSection';
import { PlayerDialog } from './components/PlayerDialog';
import { SettingsSection } from './components/SettingsSection';
import { VideosSection } from './components/VideosSection';

type Tab = 'videos' | 'ledger' | 'settings';

const TABS: { key: Tab; label: string }[] = [
  { key: 'videos', label: '视频库' },
  { key: 'ledger', label: '下载账本' },
  { key: 'settings', label: '设置' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('videos');
  const [stat, setStat] = useState('加载中…');
  const [playing, setPlaying] = useState<{ id: number; path: string } | null>(null);

  return (
    <>
      <header className="flex items-baseline gap-3 pt-3.5 pr-5 pb-2.5 pl-5">
        <h1 className="m-0 text-lg font-semibold">本地媒体库</h1>
        <span className="text-[13px] text-dim">{stat}</span>
      </header>
      <nav className="flex gap-1 border-b border-line pr-5 pl-5">
        {TABS.map((t) => (
          <button key={t.key} type="button" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>
      <main className="max-w-[1200px] px-5 pt-4 pb-10">
        {tab === 'videos' && <VideosSection onStat={setStat} onPlay={setPlaying} />}
        {tab === 'ledger' && <LedgerSection />}
        {tab === 'settings' && <SettingsSection />}
      </main>
      <PlayerDialog item={playing} onClose={() => setPlaying(null)} />
    </>
  );
}
