// 模拟"下载历史被清空"：抹掉目标文件的下载历史 + 清账本 → 触发下载 → 验证探测兜底仍跳过
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
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' 超时')); } }, 30000);
  });
}

async function evalSW(ws, sid, expression) {
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
  const sw = r.targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('fieogbjpjaiokpmfkokckebfaojncomm'));
  if (!sw) { console.log('SW 未唤醒'); process.exit(1); }
  const sid = (await send(ws, 'Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;

  // 1) 抹掉 暗黑白雪 相关下载历史（文件保留在磁盘）+ 清账本
  const erased = await evalSW(ws, sid, `(async () => {
    const n1 = await chrome.downloads.erase({ query: ['暗黑白雪'] });
    await chrome.storage.local.remove('rv-hud:dl-ledger');
    return n1.length;
  })()`);
  console.log('已抹除下载历史条数:', erased, '（账本已清空）');

  // 2) 触发已存在文件的下载命令
  const sent = await evalSW(ws, sid, `(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://rou.video/*' });
    const snap = await chrome.tabs.sendMessage(tabs[0].id, { type: 'rv-get-state' });
    await chrome.tabs.sendMessage(tabs[0].id, { type: 'rv-cmd', cmd: 'download' });
    return snap.page.name.slice(0, 20);
  })()`);
  console.log('已对以下视频触发下载:', sent);

  // 3) 等待并读取结果状态
  await new Promise((res) => setTimeout(res, 8000));
  const state = await evalSW(ws, sid, `(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://rou.video/*' });
    return (await chrome.tabs.sendMessage(tabs[0].id, { type: 'rv-get-state' })).download;
  })()`);
  console.log('结果 download state:', JSON.stringify(state));
  setTimeout(() => process.exit(0), 300);
}
main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
