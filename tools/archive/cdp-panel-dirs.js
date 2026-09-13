// 列出所有 panel 实例的目录区文本
const fs = require('fs');
const [port, path] = fs.readFileSync('C:/Users/ASUS/AppData/Local/Google/Chrome/User Data/DevToolsActivePort', 'utf8').trim().split(/\r?\n/);
const ws = new WebSocket('ws://127.0.0.1:' + port + path);
let id = 0;
const pend = new Map();
const out = [];

ws.onopen = () => ws.send(JSON.stringify({ id: ++id, method: 'Target.getTargets' }));
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result); pend.delete(d.id); return; }
  if (d.id === 1) {
    const panels = d.result.targetInfos.filter((t) => t.url.includes('src/panel/panel.html'));
    console.log('panel 实例数:', panels.length);
    panels.forEach((p, i) => {
      ws.send(JSON.stringify({ id: 100 + i, method: 'Target.attachToTarget', params: { targetId: p.targetId, flatten: true } }));
      pend.set(100 + i, (r) => {
        ws.send(JSON.stringify({
          id: 200 + i, method: 'Runtime.evaluate', sessionId: r.sessionId,
          params: {
            expression: `document.querySelector('.dirbox')?.innerText.replace(/\\s+/g, ' ').trim() || '(no dirbox)'`,
            returnByValue: true,
          },
        }));
        pend.set(200 + i, (r2) => { console.log('  面板' + i + ':', r2.result.value); out.push(1); });
      });
    });
    setTimeout(() => process.exit(0), 5000);
  }
};
setTimeout(() => process.exit(1), 15000);
