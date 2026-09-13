// 连续下载无反应诊断：唤醒 SW → 核对版本/存储/授权 → 模拟面板 batch-start → 轮询观察
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
  const out = (k, v) => console.log(`[${k}]`, typeof v === 'string' ? v : JSON.stringify(v));

  const panel = (await targets()).find((t) => t.type === 'page' && t.url.includes(`${EXT}/src/panel/panel.html`));
  if (!panel) return console.log('面板未打开');

  // ---------- 1) 唤醒 SW ----------
  await evalIn(panel.id, `chrome.runtime.sendMessage({ type: 'diag-noop' }).then(() => 1).catch(() => 0)`);
  let sw = null;
  for (let i = 0; i < 10; i++) {
    sw = (await targets()).find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXT}`));
    if (sw) break;
    await sleep(500);
  }
  if (!sw) return console.log('SW 未唤醒');

  // ---------- 2) SW 侧状态（tabs.query 限定 rou.video——host 权限内才有 url 字段） ----------
  const swInfo = await evalIn(sw.id, `(async () => ({
    version: chrome.runtime.getManifest().version,
    fsdir: (await chrome.storage.local.get('rv-hud:fsdir'))['rv-hud:fsdir'] || null,
    batch: ((await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch'] || {}).note || null,
    batchActive: ((await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch'] || {}).active ?? null,
    workerTab: (await chrome.storage.session.get('rv-batch-tab'))['rv-batch-tab'] ?? null,
    offscreen: await chrome.offscreen.hasDocument().catch(() => 'err'),
    rouTabs: (await chrome.tabs.query({ url: 'https://rou.video/*' })).map((t) => t.id),
  }))()`);
  out('SW', swInfo);

  // ---------- 3) 面板视角的目录授权状态（probeWritable 结果 = 真实写权限） ----------
  const dirProbe = await evalIn(panel.id, `(async () => {
    const w = (await import('/src/net/fsdir.js'));
    const h = await w.loadDirHandle();
    if (!h) return { handle: null };
    let q = 'unknown';
    try { q = await h.queryPermission({ mode: 'readwrite' }); } catch (e) { q = 'err:' + e.name; }
    let write = false;
    try { write = await w.probeWritable(); } catch (e) { write = 'err:' + e.name; }
    return { handle: h.name, query: q, write };
  })()`);
  out('面板目录', dirProbe);

  // ---------- 4) offscreen 视角的写权限（与下载路径同源） ----------
  const offProbe = await evalIn(panel.id, `(async () => {
    const r = await chrome.runtime.sendMessage({ to: 'os', type: 'os-write-file', filename: '.rv-diag-probe', b64: 'MQ==' });
    return r;
  })()`);
  out('offscreen 直写', offProbe);

  // ---------- 5) 内容脚本快照 ----------
  const tabId = swInfo.__exc ? null : swInfo.rouTabs && swInfo.rouTabs[0];
  if (!tabId) return console.log('未取到 rou.video tabId');
  const snap = await evalIn(panel.id, `(async () => {
    try { const s = await chrome.tabs.sendMessage(${tabId}, { type: 'rv-get-state' }); return { path: s.path, listing: s.listing, q: (s.qualities || []).length, dl: s.download && { running: s.download.running, error: s.download.error, errorCode: s.download.errorCode } }; }
    catch (e) { return { err: String(e.message) }; }
  })()`);
  out('快照', snap);
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
