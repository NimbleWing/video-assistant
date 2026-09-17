import { useEffect, useState } from 'react';
import { fetchDownloads } from '../api';
import { fmtSize, fmtTime } from '../format';
import type { DownloadsResponse } from '../types';
import { Pager } from './Pager';

const PAGE_SIZE = 50;
const STATUSES = ['failed', 'complete', 'downloading', 'canceled', 'skipped'] as const;
type Status = '' | (typeof STATUSES)[number];

export function LedgerSection() {
  const [status, setStatus] = useState<Status>('failed');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<DownloadsResponse | null>(null);

  useEffect(() => {
    let alive = true;
    fetchDownloads({ status: status || undefined, page, size: PAGE_SIZE })
      .then((d) => {
        if (alive) setData(d);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [status, page]);

  const counts = data?.counts ?? {};
  const totalAll = STATUSES.reduce((a, s) => a + (counts[s] || 0), 0);
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="card p-5">
      <div className="mb-4 flex flex-wrap gap-1.5">
        {(['', ...STATUSES] as Status[]).map((s) => (
          <button
            key={s || 'all'}
            type="button"
            className="chip"
            aria-pressed={status === s}
            onClick={() => {
              setStatus(s);
              setPage(1);
            }}
          >
            {s === '' ? '全部' : s}
            <span className="n">{s === '' ? totalAll : counts[s] || 0}</span>
          </button>
        ))}
      </div>
      <p className="mb-3 text-xs text-dim">失败项重试由扩展侧面板发起（「重试历史失败」），本页仅展示。</p>
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line py-14 text-center text-dim">没有记录</div>
      ) : (
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th>视频</th>
                <th>状态</th>
                <th>清晰度</th>
                <th>尝试</th>
                <th>大小 / 错误</th>
                <th>更新</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td className="max-w-[460px] [overflow-wrap:anywhere]">
                    {it.series_name ? (
                      <>
                        <b>{it.series_name}</b> /{' '}
                      </>
                    ) : null}
                    <span>{it.name}</span>
                    <div className="path mt-1 text-xs text-dim">
                      {it.site} {it.page_path}
                      {it.filename ? ` → ${it.filename}` : ''}
                    </div>
                  </td>
                  <td>
                    <span className={`badge badge-${it.status}`}>{it.status}</span>
                  </td>
                  <td>{it.quality || '-'}</td>
                  <td>{it.attempts}</td>
                  <td>{it.error ? <span className="text-err">{it.error}</span> : fmtSize(it.size)}</td>
                  <td>{fmtTime(it.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        page={page}
        pages={pages}
        total={total}
        onPrev={() => setPage((p) => p - 1)}
        onNext={() => setPage((p) => p + 1)}
      />
    </section>
  );
}
