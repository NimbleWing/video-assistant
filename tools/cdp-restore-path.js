// 恢复 fsdir flag 的 path 字段
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
    const sw = d.result.targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('fieogbjpjaiokpmfkokckebfaojncomm'));
    if (!sw) { console.log('SW 未唤醒'); process.exit(1); }
    ws.send(JSON.stringify({ id: ++id, method: 'Target.attachToTarget', params: { targetId: sw.targetId, flatten: true } }));
    pend.set(2, (r) => {
      ws.send(JSON.stringify({
        id: ++id, method: 'Runtime.evaluate', sessionId: r.sessionId,
        params: {
          expression: `chrome.storage.local.set({'rv-hud:fsdir': {name: '视频', path: 'G:\\\\肉视频\\\\视频'}})`,
          awaitPromise: true,
        },
      }));
      pend.set(3, () => { console.log('path 已恢复'); process.exit(0); });
    });
  }
};
setTimeout(() => process.exit(1), 15000);
