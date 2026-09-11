// 验证路径记录：存储标记 / 面板显示 / 残留文件与下载历史
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
    if (!panels.length) { console.log('面板未打开'); process.exit(1); }
    ws.send(JSON.stringify({ id: ++id, method: 'Target.attachToTarget', params: { targetId: panels[0].targetId, flatten: true } }));
    pend.set(2, (r) => {
      ws.send(JSON.stringify({
        id: ++id, method: 'Runtime.evaluate', sessionId: r.sessionId,
        params: {
          expression: `(async () => {
            const flag = (await chrome.storage.local.get('rv-hud:fsdir'))['rv-hud:fsdir'] || null;
            const dirText = document.querySelector('.dirbox')?.innerText.replace(/\\s+/g, ' ').trim() || null;
            const residue = await chrome.downloads.search({ query: ['rv-path'] });
            return { flag, dirText, 下载残留: residue.length };
          })()`,
          awaitPromise: true, returnByValue: true,
        },
      }));
      pend.set(3, (r2) => { console.log(JSON.stringify(r2.result.value, null, 1)); process.exit(0); });
    });
  }
};
setTimeout(() => process.exit(1), 20000);
