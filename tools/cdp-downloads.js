// 查询 chrome.downloads 最近记录，确认每个文件的来源与时间
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
  if (!sw) { console.log('SW 未唤醒'); process.exit(1); }
  const sid = (await send(ws, 'Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
  const expr = `(async () => {
    const items = await chrome.downloads.search({ limit: 8, orderBy: ['-startTime'] });
    return items.map(d => ({
      t: new Date(d.startTime).toLocaleTimeString('zh-CN'),
      file: (d.filename || '').split('\\\\').pop(),
      bytes: d.fileSize,
      state: d.state,
      mime: d.mime,
    }));
  })()`;
  const r2 = await send(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
  for (const it of r2.result.value) console.log(`${it.t}  ${(it.bytes / 1024).toFixed(0)}KB  [${it.state}/${it.mime}]  ${it.file}`);
  setTimeout(() => process.exit(0), 300);
}
main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
