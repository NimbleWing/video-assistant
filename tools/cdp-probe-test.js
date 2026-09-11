// 在扩展 SW 中直接测试磁盘探测 probeExists 的三种情形
const fs = require('fs');
const [port, path] = fs.readFileSync('C:/Users/ASUS/AppData/Local/Google/Chrome/User Data/DevToolsActivePort', 'utf8').trim().split(/\r?\n/);

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const t = setTimeout(() => reject(new Error('WS 超时')), 10000);
    ws.onopen = () => { clearTimeout(t); resolve(ws); };
    ws.onerror = () => { clearTimeout(t); reject(new Error('WS 错误')); };
  });
}

let msgId = 0;
const pending = new Map();
function send(ws, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(msg));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, 25000);
  });
}

async function main() {
  const ws = await connect();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id);
      pending.delete(d.id);
      d.error ? p.reject(new Error(JSON.stringify(d.error))) : p.resolve(d.result);
    }
  };
  const r = await send(ws, 'Target.getTargets');
  const sw = r.targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('fieogbjpjaiokpmfkokckebfaojncomm'));
  if (!sw) { console.log('SW 未唤醒'); process.exit(1); }
  const sid = (await send(ws, 'Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
  const expr = `(async () => {
    const existFile = '暗黑白雪/暗黑白雪 · 第1集 暗黑白雪：全員惡人無童話 第1集.mp4';
    const newFile = '探测专用ZZZ/探测专用ZZZ · 第1集.mp4';
    const t1 = await probeExists(existFile);   // 期望 true
    const t2 = await probeExists(newFile);     // 期望 false
    // 探测后不应留下历史/文件痕迹
    const leftovers = await chrome.downloads.search({ query: ['探测专用ZZZ'] });
    const ledger = (await chrome.storage.local.get('rv-hud:dl-ledger'))['rv-hud:dl-ledger'] || {};
    return { t1_已存在文件: t1, t2_不存在文件: t2, 历史残留: leftovers.length, 账本条数: Object.keys(ledger).length };
  })()`;
  const r2 = await send(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  console.log(JSON.stringify(r2.result.value, null, 1));
  setTimeout(() => process.exit(0), 300);
}
main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
