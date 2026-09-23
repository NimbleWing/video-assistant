import { useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { fetchLan } from '@/lib/api';
import type { LanResponse } from '@/lib/types';

interface Props {
  onClose: () => void;
}

/** 生成 QR SVG 字符串（纠错级 M，scalable 由容器定尺寸）。 */
function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true });
}

/**
 * 手机扫码访问弹窗（顶栏标题点击发起）：GET /api/lan 取局域网 IP 列表，
 * 二维码内容 = http://{ip}:{port}/（当前页面地址族；多网卡时 chips 切换）。
 * 服务端写操作 Origin 白名单不含局域网来源——手机端只读，弹窗注明。
 */
export function QrDialog({ onClose }: Props) {
  const [lan, setLan] = useState<LanResponse | null>(null);
  const [err, setErr] = useState('');
  const [ipIdx, setIpIdx] = useState(0);
  const dlgRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dlgRef.current;
    if (d && !d.open) d.showModal();
  }, []);

  useEffect(() => {
    let alive = true;
    fetchLan()
      .then((d) => {
        if (alive) setLan(d);
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const ip = lan?.ips[ipIdx] ?? '';
  const url = ip ? `http://${ip}:${lan!.port}/` : '';
  const svg = useMemo(() => (url ? qrSvg(url) : ''), [url]);

  return (
    <dialog ref={dlgRef} onClose={onClose} closedby="any">
      <div className="w-[min(360px,90vw)]">
        <div className="mb-1 text-[15px] font-bold">手机扫码访问</div>
        <p className="mb-3 text-xs text-dim">手机连接同一 WiFi 扫码打开管理页（只读：浏览与播放，写操作仅限本机）。</p>

        {err ? (
          <p className="py-6 text-center text-xs text-err">{err}</p>
        ) : lan == null ? (
          <p className="py-6 text-center text-xs text-dim">获取局域网地址中…</p>
        ) : lan.ips.length === 0 ? (
          <p className="py-6 text-center text-xs text-dim">未探测到局域网 IPv4 地址（检查网络连接）</p>
        ) : (
          <>
            {lan.ips.length > 1 ? (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {lan.ips.map((x, i) => (
                  <button
                    key={x}
                    type="button"
                    className={`chip ${i === ipIdx ? '' : 'opacity-60'}`}
                    aria-pressed={i === ipIdx}
                    onClick={() => setIpIdx(i)}
                  >
                    {x}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="mx-auto w-56 overflow-hidden rounded-xl bg-white p-2" dangerouslySetInnerHTML={{ __html: svg }} />
            <p className="mt-2 break-all text-center font-mono text-xs text-dim">{url}</p>
          </>
        )}

        <div className="mt-4 flex justify-end">
          <button type="button" className="act" onClick={() => dlgRef.current?.close()}>
            关闭
          </button>
        </div>
      </div>
    </dialog>
  );
}
