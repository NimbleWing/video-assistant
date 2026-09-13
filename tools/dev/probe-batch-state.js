// 探针：批次失败明细 + 工作标签页下载进度 + 磁盘 .part 状态
const BASE = 'http://127.0.0.1:9223';
const EXT = 'fieogbjpjaiokpmfkokckebfaojncomm';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cmd(method, params, sessionId) {
  const r = await fetch(BASE + '/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params, sessionId }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.result;
}
async function targets() {
  return (await (await fetch(BASE + '/targets')).json()).result;
}
async function evalIn(targetId, expr) {
  const s = await cmd('Target.attachToTarget', { targetId, flatten: true });
  const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, s.sessionId);
  if (r.exceptionDetails) return { __exc: (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 500) };
  return r.result.value;
}

async function main() {
  const sw = (await targets()).find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXT}`));
  if (!sw) return console.log('SW 休眠');

  const st = await evalIn(sw.id, `(async () => {
    const b = (await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch'];
    const tab = (await chrome.storage.session.get('rv-batch-tab'))['rv-batch-tab'] ?? null;
    return { active: b?.active, done: b?.done, failed: b?.failed?.slice(0, 3), workerTab: tab, current: b?.current?.name };
  })()`);
  console.log('[批次]', JSON.stringify(st, null, 1));

  // 工作标签页进度
  const wt = st.workerTab;
  if (wt) {
    const snap = await evalIn(sw.id, `(async () => {
      try { return await chrome.tabs.sendMessage(${wt}, { type: 'rv-get-state' }); } catch (e) { return { err: String(e.message) }; }
    })()`);
    console.log('[工作页]', JSON.stringify({
      err: snap.err, path: snap.path, q: (snap.qualities || []).length,
      dl: snap.download && {
        running: snap.download.running, done: snap.download.done, total: snap.download.total,
        pct: Math.round(snap.download.pct || 0), bytes: snap.download.bytes,
        error: snap.download.error, errorCode: snap.download.errorCode,
      },
    }));
  }

  // 磁盘：目录里已有什么（经 offscreen 句柄读——offscreen 无列举 API，改查 sidecar 存在性）
  // 用 os-file-exists 探测几个名字不现实——改为读扩展 storage 的 fsdir flag（有 path 吗）
  const dir = await evalIn(sw.id, `(await chrome.storage.local.get('rv-hud:fsdir'))['rv-hud:fsdir']`);
  console.log('[目录]', JSON.stringify(dir));
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
