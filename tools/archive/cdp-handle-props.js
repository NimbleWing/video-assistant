// 检查目录句柄上是否存在任何路径相关属性
const fs = require('fs');
const [port, path] = fs.readFileSync('C:/Users/ASUS/AppData/Local/Google/Chrome/User Data/DevToolsActivePort', 'utf8').trim().split(/\r?\n/);
const ws = new WebSocket('ws://127.0.0.1:' + port + path);
let id = 0;
const pend = new Map();

ws.onopen = () => ws.send(JSON.stringify({ id: ++id, method: 'Target.getTargets' }));
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result); pend.delete(d.id); return; }
  if (d.id === 1) {
    const panel = d.result.targetInfos.find((t) => t.url.includes('src/panel/panel.html'));
    if (!panel) { console.log('面板未打开'); process.exit(1); }
    ws.send(JSON.stringify({ id: ++id, method: 'Target.attachToTarget', params: { targetId: panel.targetId, flatten: true } }));
    pend.set(2, (r) => {
      ws.send(JSON.stringify({
        id: ++id, method: 'Runtime.evaluate', sessionId: r.sessionId,
        params: {
          expression: `(async () => {
            const db = await new Promise((res) => { const q = indexedDB.open('rv-fs', 1); q.onsuccess = () => res(q.result); });
            const h = await new Promise((res) => { const t = db.transaction('handles', 'readonly'); const r = t.objectStore('handles').get('dir'); r.onsuccess = () => res(r.result); });
            if (!h) return 'no handle';
            const own = Object.getOwnPropertyNames(h);
            const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(h)).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(Object.getPrototypeOf(h)) || {}));
            return { ownProps: own, protoProps: [...new Set(proto)], name: h.name, resolve: typeof h.resolve };
          })()`,
          awaitPromise: true, returnByValue: true,
        },
      }));
      pend.set(3, (r2) => { console.log(JSON.stringify(r2.result.value, null, 1)); process.exit(0); });
    });
  }
};
setTimeout(() => process.exit(1), 20000);
