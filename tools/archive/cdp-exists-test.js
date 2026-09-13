// 在扩展 SW 里实测文件存在判断的两条路径（账本 + 下载历史搜索）
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, 20000);
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
  if (!sw) { console.log('SW 未唤醒（需先打开 rou.video 页面）'); process.exit(1); }
  const sid = (await send(ws, 'Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
  const expr = `(async () => {
    const base1 = '暗黑白雪 · 第1集 暗黑白雪：全員惡人無童話 第1集.mp4';   // 应存在
    const base2 = '不存在的视频名XYZ.mp4';                                // 应不存在
    const out = {};
    for (const [k, b] of [['hit', base1], ['miss', base2]]) {
      const items = await chrome.downloads.search({ query: [b], limit: 200 });
      const exact = items.filter(d => d.state === 'complete' && d.exists !== false && (d.filename || '').endsWith(b));
      out[k] = { searchResults: items.length, exact: exact.length, sample: exact[0] ? exact[0].filename.split('\\\\\\\\').pop().slice(0, 60) : null };
    }
    const ledger = (await chrome.storage.local.get('rv-hud:dl-ledger'))['rv-hud:dl-ledger'] || {};
    out.ledgerSize = Object.keys(ledger).length;
    return out;
  })()`;
  const r2 = await send(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  console.log(JSON.stringify(r2.result.value, null, 1));
  setTimeout(() => process.exit(0), 300);
}
main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
