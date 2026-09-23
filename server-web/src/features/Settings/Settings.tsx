import { useEffect, useState } from 'react';
import { fetchConfig, fetchLog, saveConfig } from '@/lib/api';
import type { FfmpegStatus } from '@/lib/types';

export function Settings() {
  const [ffmpegPath, setFfmpegPath] = useState('');
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null);
  const [warn, setWarn] = useState('');
  const [log, setLog] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchConfig()
      .then((j) => {
        if (!alive) return;
        setFfmpegPath(j.ffmpegPath || '');
        setFfmpeg(j.ffmpeg ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function save() {
    try {
      const j = await saveConfig(ffmpegPath.trim());
      setWarn(j.warnings?.length ? j.warnings.join('；') : '已保存');
      fetchConfig().then((c) => setFfmpeg(c.ffmpeg ?? null)).catch(() => {});
    } catch (e) {
      setWarn(String((e as Error).message));
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
      <div className="mb-2 text-xs font-medium text-dim">ffmpeg 路径（HLS 流播放用，留空 = 自动从 PATH 探测）</div>
      <input
        value={ffmpegPath}
        onChange={(e) => setFfmpegPath(e.target.value)}
        spellCheck={false}
        placeholder="D:\\Tools\\ffmpeg\\bin\\ffmpeg.exe"
        aria-label="ffmpeg 路径"
      />
      <div className="mt-1.5 text-xs">
        {ffmpeg == null ? (
          <span className="text-dim">探测中…</span>
        ) : ffmpeg.available ? (
          <span className="text-ok">已就绪：{ffmpeg.path}{ffmpeg.source === 'config' ? '（配置）' : '（PATH）'}</span>
        ) : (
          <span className="text-warn">未检测到 ffmpeg：HLS 流不可用，非原生格式视频无法播放（原生格式仍可直连）</span>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        <button type="button" className="act act-primary" onClick={() => void save()}>
          保存配置
        </button>
        <button type="button" className="act" onClick={() => void viewLog()}>
          查看日志
        </button>
        <span className="text-xs text-dim">{warn}</span>
      </div>
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
