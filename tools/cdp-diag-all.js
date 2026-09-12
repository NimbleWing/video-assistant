// 一次连接完成全部诊断：批次状态 / 页面扩展状态 / 控制台日志 / SW 状态
const fs = require('fs');
const [port, path] = fs.readFileSync('C:/Users/ASUS/AppData/Local/Google/Chrome/User Data/DevToolsActivePort', 'utf8').trim().split(/\r?\n/);
const ws = new WebSocket('ws://127.0.0.1:' + port + path);
let id = 0;
const pend = new Map();
const logs = [];

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    const msg = { id: mid, method, params };
    if (sessionId) msg.sessionId = sessionId;
    pend.set(mid, { resolve, reject });
    ws.send(JSON.stringify(msg));
    setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); reject(new Error(method + ' 超时')); } }, 20000);
  });
}

async function main() {
  const r = await send('Target.getTargets');
  const page = r.targetInfos.find((t) => t.type === 'page' && t.url.includes('rou.video'));
  const sw = r.targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('fieogbjpjaiokpmfkokckebfaojncomm'));

  // 1) 页面诊断（含 Log 域收集历史日志）
  if (page) {
    const sid = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
    await send('Log.enable', {}, sid).catch(() => {});
    const r2 = await send('Runtime.evaluate', {
      expression: `({
        url: location.href,
        extHost: !!document.getElementById('rv-ext-host'),
        myHook: !!window.__rvPageHook,
        batchLocalStorageKeys: Object.keys(localStorage).filter(k => k.includes('rv-')),
      })`,
      returnByValue: true,
    }, sid);
    console.log('页面状态:', JSON.stringify(r2.result.value));
  } else {
    console.log('页面状态: 无 rou.video 页面');
  }

  // 2) SW：批次存储 + 诊断
  let swSid = null;
  if (sw) {
    swSid = (await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
  }
  const evalSW = async (expr) => {
    if (swSid) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, swSid);
      return r.result.value;
    }
    return '(SW 未唤醒)';
  };
  const batch = await evalSW(`(async () => (await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch'] || null)()`);
  console.log('批次状态:', batch ? JSON.stringify({
    active: batch.active, mode: batch.mode, done: batch.done,
    failed: batch.failed?.length, note: batch.note,
    vq: batch.videoQueue?.length, sq: batch.seriesQueue?.length,
    lp: batch.listingPages?.length, lastHarvested: batch.lastHarvested,
    current: batch.current?.name || null,
  }) : 'null');

  // 等待 Log 域异步推送
  await new Promise((r) => setTimeout(r, 2000));
  const rvLogs = logs.filter((l) => /RouVideo|BATCH|BOOT|SNIFF|DL/.test(l.text));
  console.log('--- 页面控制台最近相关日志 (' + rvLogs.length + ') ---');
  for (const l of rvLogs.slice(-25)) console.log(`[${l.level}] ${l.text.slice(0, 140)}`);
  process.exit(0);
}

ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.method === 'Log.entryAdded') { logs.push(d.params.entry); return; }
  if (d.id && pend.has(d.id)) {
    const p = pend.get(d.id);
    pend.delete(d.id);
    d.error ? p.reject(new Error(JSON.stringify(d.error))) : p.resolve(d.result);
  }
};

ws.onopen = main;
ws.onerror = () => { console.error('WS 连接错误'); process.exit(1); };
setTimeout(() => { console.error('总超时'); process.exit(1); }, 30000);
