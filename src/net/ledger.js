// 本地媒体库账本客户端（server/DESIGN.md）。
// 内容脚本不能直连 127.0.0.1（MV3 内容脚本 fetch 受 CORS 约束，
// host_permissions 豁免仅限 SW），所有请求经 SW 中转。

/**
 * 上报下载生命周期到本地服务账本（fire-and-forget，失败静默——账本缺失无害）。
 * @param {{ videoId: string, pagePath?: string, name?: string, seriesName?: string, quality?: number, filename?: string, status: 'downloading' | 'complete' | 'failed' | 'canceled' | 'skipped', error?: string, size?: number }} d
 * @returns {Promise<void>}
 */
export function reportDownload(d) {
  return chrome.runtime.sendMessage({ type: 'rv-ledger-report', payload: d })
    .catch(() => {});
}

/**
 * 查询账本（扩展侧拉取失败列表驱动重试）。
 * @param {{ status?: string, site?: string }} [opt]
 * @returns {Promise<any[] | null>} 失败返回 null（服务未启动等）
 */
export async function queryLedger(opt = {}) {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'rv-ledger-query', opt });
    return Array.isArray(r?.items) ? r.items : null;
  } catch {
    return null;
  }
}
