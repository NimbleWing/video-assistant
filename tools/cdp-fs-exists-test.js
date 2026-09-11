// fs 模式已下载直查：rv-file-exists 应命中自定义目录
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
    const panels = d.result.targetInfos.filter((t) => t.url.includes('src/panel/panel.html'));
    const panel = panels[0];
    if (!panel) { console.log('no panel'); process.exit(1); }
    ws.send(JSON.stringify({ id: ++id, method: 'Target.attachToTarget', params: { targetId: panel.targetId, flatten: true } }));
    pend.set(2, (r) => {
      ws.send(JSON.stringify({
        id: ++id, method: 'Runtime.evaluate', sessionId: r.sessionId,
        params: {
          expression: `chrome.runtime.sendMessage({ type: 'rv-file-exists', filename: 'rv-fs-test.txt' })`,
          awaitPromise: true, returnByValue: true,
        },
      }));
      pend.set(3, (r2) => {
        console.log('fs 直查结果:', JSON.stringify(r2.result.value));
        // 顺带清理测试文件
        ws.send(JSON.stringify({
          id: ++id, method: 'Runtime.evaluate', sessionId: r.sessionId,
          params: {
            expression: `(async () => {
              const db = await new Promise((res) => { const q = indexedDB.open('rv-fs', 1); q.onsuccess = () => res(q.result); });
              const h = await new Promise((res) => { const t = db.transaction('handles', 'readonly'); const r = t.objectStore('handles').get('dir'); r.onsuccess = () => res(r.result); });
              if (h) { try { await h.removeEntry('rv-fs-test.txt'); return 'cleaned'; } catch (e) { return 'clean-err:' + e.message; } }
              return 'no-handle';
            })()`,
            awaitPromise: true, returnByValue: true,
          },
        }));
        pend.set(4, (r3) => { console.log('清理测试文件:', r3.result.value); process.exit(0); });
      });
    });
  }
};
setTimeout(() => process.exit(1), 25000);
