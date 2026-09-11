// 列出自定义目录句柄下的文件（证明 fs 写入真实落盘）
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
  const panels = r.targetInfos.filter((t) => t.url.includes('src/panel/panel.html'));
  for (const panel of panels) {
    const sid = (await send(ws, 'Target.attachToTarget', { targetId: panel.targetId, flatten: true })).sessionId;
    const r2 = await send(ws, 'Runtime.evaluate', {
      expression: `(async () => {
        const db = await new Promise((res, rej) => { const q = indexedDB.open('rv-fs', 1); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
        const h = await new Promise((res) => { const t = db.transaction('handles', 'readonly'); const r = t.objectStore('handles').get('dir'); r.onsuccess = () => res(r.result); });
        if (!h) return { handle: null };
        const perm = await h.queryPermission({ mode: 'readwrite' });
        const files = [];
        for await (const [name, entry] of h.entries()) files.push(entry.kind === 'directory' ? name + '/' : name);
        return { handle: h.name, permission: perm, entries: files.slice(0, 20) };
      })()`,
      awaitPromise: true, returnByValue: true,
    }, sid);
    console.log(`[${panel.targetId.slice(0, 8)}]`, JSON.stringify(r2.result.value));
  }
  setTimeout(() => process.exit(0), 300);
}
main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
