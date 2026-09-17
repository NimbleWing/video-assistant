import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { fetchConfig, fetchLog, saveConfig, triggerScan } from '../api';

export function SettingsSection() {
  const [dirs, setDirs] = useState('');
  const [warn, setWarn] = useState('');
  const [scanResult, setScanResult] = useState<ReactNode>(null);
  const [scanning, setScanning] = useState(false);
  const [log, setLog] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchConfig()
      .then((j) => {
        if (alive) setDirs((j.scanDirs || []).join('\n'));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function save() {
    const list = dirs.split('\n').map((s) => s.trim()).filter(Boolean);
    try {
      const j = await saveConfig(list);
      setWarn(j.warnings?.length ? j.warnings.join('；') : '已保存');
    } catch (e) {
      setWarn(String((e as Error).message));
    }
  }

  async function scan() {
    setScanning(true);
    setScanResult('扫描中…（大目录可能需要较长时间）');
    try {
      const j = await triggerScan();
      const r = j.result;
      setScanResult(
        <>
          完成：视频 {r.videos} · 封面 {r.covers} · 清理失效 {r.removed} · 耗时 {(r.ms / 1000).toFixed(1)}s
          {r.warnings?.length ? (
            <div className="whitespace-pre-line text-xs text-warn">{r.warnings.join('\n')}</div>
          ) : null}
        </>,
      );
    } catch (e) {
      setScanResult(`扫描失败：${String((e as Error).message)}`);
    } finally {
      setScanning(false);
    }
  }

  async function viewLog() {
    setLog('加载日志…');
    try {
      const j = await fetchLog();
      setLog(j.tail || '(空)');
    } catch (e) {
      setLog(`读取失败：${String((e as Error).message)}`);
    }
  }

  return (
    <section className="min-h-0 flex-1 overflow-y-auto">
      <div className="card p-5">
      <div className="mb-2 text-xs font-medium text-dim">扫描目录（每行一个绝对路径）</div>
      <textarea
        value={dirs}
        onChange={(e) => setDirs(e.target.value)}
        spellCheck={false}
        placeholder={'D:\\Videos\nE:\\收藏'}
      />
      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        <button type="button" className="act act-primary" onClick={() => void save()}>
          保存目录
        </button>
        <button type="button" className="act" disabled={scanning} onClick={() => void scan()}>
          立即扫描
        </button>
        <button type="button" className="act" onClick={() => void viewLog()}>
          查看日志
        </button>
        <span className="text-xs text-dim">{warn}</span>
      </div>
      <div className="mt-3 text-[13px]">{scanResult}</div>
      {log != null && (
        <pre className="mt-2 max-h-[260px] overflow-auto whitespace-pre-line rounded-lg bg-raised p-3 text-xs text-warn select-text">
          {log}
        </pre>
      )}
      <p className="mt-4 text-xs text-dim">
        服务运行于 127.0.0.1:17321，仅供本机使用；扩展会自动调用判定接口，服务未启动时扩展自动回退浏览器下载历史判定。
      </p>
      </div>
    </section>
  );
}
