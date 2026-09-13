// 检查每个 panel 目标（侧边栏/标签）中 showDirectoryPicker 的可用性
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, 15000);
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
  console.log('panel 目标数:', panels.length);
  for (const p of panels) {
    const sid = (await send(ws, 'Target.attachToTarget', { targetId: p.targetId, flatten: true })).sessionId;
    const r2 = await send(ws, 'Runtime.evaluate', {
      expression: 'typeof window.showDirectoryPicker + " / isSecureContext=" + isSecureContext',
      returnByValue: true,
    }, sid);
    console.log(`[${p.type}] ${p.targetId.slice(0, 8)} => ${r2.result.value}`);
  }
  setTimeout(() => process.exit(0), 300);
}
main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
