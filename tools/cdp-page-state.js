// 直接在 rou.video 页面主世界检查扩展痕迹 + 控制台最近的 RouVideo 日志 + 批次存储
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
    const page = d.result.targetInfos.find((t) => t.type === 'page' && t.url.includes('rou.video'));
    if (!page) { console.log('无 rou.video 页面'); process.exit(1); }
    ws.send(JSON.stringify({ id: ++id, method: 'Target.attachToTarget', params: { targetId: page.targetId, flatten: true } }));
    pend.set(2, (r) => {
      const sid = r.sessionId;
      ws.send(JSON.stringify({
        id: ++id, method: 'Runtime.evaluate', sessionId: sid,
        params: {
          expression: `({
            url: location.href,
            extHost: !!document.getElementById('rv-ext-host'),
            myHook: !!window.__rvPageHook,
            nextData: !!document.getElementById('__NEXT_DATA__'),
          })`,
          returnByValue: true,
        },
      }));
      pend.set(3, (r2) => {
        console.log('页面状态:', JSON.stringify(r2.result.value));
        ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable', sessionId: sid }));
        // 拿最近的 console 消息（历史 + 新的）
        ws.send(JSON.stringify({
          id: ++id, method: 'Runtime.evaluate', sessionId: sid,
          params: {
            expression: `(function(){
              const orig = console.error, origWarn = console.warn;
              return 'enabled';
            })()`,
            returnByValue: true,
          },
        }));
        // 用 Log domain 拿历史
        ws.send(JSON.stringify({ id: ++id, method: 'Log.enable', sessionId: sid }));
        pend.set(5, () => {});
        setTimeout(() => {
          ws.send(JSON.stringify({ id: ++id, method: 'Log.disable', sessionId: sid }));
          process.exit(0);
        }, 2500);
      });
    });
  }
};
let logCount = 0;
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.method === 'Log.entryAdded') {
    const e = d.params.entry;
    if (/RouVideo|batch|BATCH|下载|剧/i.test(e.text) && logCount < 25) {
      logCount++;
      console.log(`[console.${e.level}] ${e.text.slice(0, 130)}`);
    }
  }
};
setTimeout(() => process.exit(1), 15000);
