// 授权失效现场对照：批次状态 vs 面板侧权限 vs offscreen 侧写能力
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
  if (r.exceptionDetails) return { __exc: (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 400) };
  return r.result.value;
}

async function main() {
  const all = await targets();
  const sw = all.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXT}`));
  let panel = all.find((t) => t.type === 'page' && t.url.includes(`${EXT}/src/panel/panel.html`));
  if (!sw) return console.log('SW 休眠，先在页面上动一下再跑本探针');

  // 1) 批次状态
  const b = await evalIn(sw.id, `(async () => {
    const b = (await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch'];
    return { active: b?.active, done: b?.done, failed: b?.failed?.length,
      note: (b?.note || '').slice(0, 60), reason: b?.stoppedReason ?? null,
      stoppedAt: b?.stoppedAt ? new Date(b.stoppedAt).toLocaleTimeString() : null };
  })()`);
  console.log('[批次]', JSON.stringify(b));

  // 2) SW/offscreen 侧：os-write-file 直写探针（真实下载路径）
  const off = await evalIn(sw.id, `(async () => {
    try {
      await chrome.runtime.sendMessage({ to: 'os', type: 'noop' }).catch(() => {});
      return await chrome.runtime.sendMessage({ to: 'os', type: 'os-write-file', filename: '.rv-diag-probe', b64: 'MQ==' });
    } catch (e) { return { err: String(e.message) }; }
  })()`);
  console.log('[offscreen 直写]', JSON.stringify(off));

  // 3) offscreen 里句柄的 queryPermission（借 os-file-exists 触发后查？offscreen 不暴露查询——改从面板读 IDB 句柄）
  if (!panel) {
    const t = await cmd('Target.createTarget', { url: `chrome-extension://${EXT}/src/panel/panel.html`, background: true });
    panel = { id: t.targetId };
    await sleep(2000);
  }
  const pdir = await evalIn(panel.id, `(async () => {
    const w = await import('/src/net/fsdir.js');
    const h = await w.loadDirHandle();
    if (!h) return { handle: null };
    let q = '?';
    try { q = await h.queryPermission({ mode: 'readwrite' }); } catch (e) { q = 'err:' + e.name; }
    let write = false;
    try { write = await w.probeWritable(); } catch (e) { write = 'err:' + e.name; }
    return { handle: h.name, query: q, write };
  })()`);
  console.log('[面板侧句柄]', JSON.stringify(pdir));

  // 4) 浏览器启动时长（判断是否中途重启过）：performance.now 只到页面——改为看 SW 启动时刻
  const swUp = await evalIn(sw.id, `(async () => {
    const since = Date.now() - (chrome.runtime.id ? performance.timeOrigin : 0);
    return { swStartedAt: new Date(performance.timeOrigin).toLocaleTimeString() };
  })()`);
  console.log('[SW 启动时刻]', JSON.stringify(swUp));
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
