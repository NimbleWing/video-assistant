// 诊断自定义目录：面板 queryPermission / 存储标记 / offscreen 视角
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

async function evalIn(ws, targetId, expression) {
  const sid = (await send(ws, 'Target.attachToTarget', { targetId, flatten: true })).sessionId;
  const r = await send(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
  return r.result.value;
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
  const panel = r.targetInfos.find((t) => t.url.includes('src/panel/panel.html'));
  const sw = r.targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('fieogbjpjaiokpmfkokckebfaojncomm'));

  if (panel) {
    const p = await evalIn(ws, panel.targetId, `(async () => {
      const db = await new Promise((res, rej) => { const q = indexedDB.open('rv-fs', 1); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
      const h = await new Promise((res) => { const t = db.transaction('handles', 'readonly'); const r = t.objectStore('handles').get('dir'); r.onsuccess = () => res(r.result); });
      if (!h) return { handle: null };
      let perm = 'err';
      try { perm = await h.queryPermission({ mode: 'readwrite' }); } catch (e) { perm = 'ERR:' + e.message; }
      return { handle: h.name, permission: perm };
    })()`);
    console.log('面板视角:', JSON.stringify(p));
  } else {
    console.log('面板未打开');
  }

  if (sw) {
    const flag = await evalIn(ws, sw.targetId, `(async () => (await chrome.storage.local.get('rv-hud:fsdir'))['rv-hud:fsdir'] || null)()`);
    console.log('存储标记:', JSON.stringify(flag));
  } else {
    console.log('SW 休眠');
  }
  setTimeout(() => process.exit(0), 300);
}
main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
