// 单次连接完成：修 pattern 后的重载 + 停摆批次续跑验证
const fs = require('fs');
const [port, path] = fs.readFileSync('C:/Users/ASUS/AppData/Local/Google/Chrome/User Data/DevToolsActivePort', 'utf8').trim().split(/\r?\n/);
const ws = new WebSocket('ws://127.0.0.1:' + port + path);
let id = 0;
const pend = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    const msg = { id: mid, method, params };
    if (sessionId) msg.sessionId = sessionId;
    pend.set(mid, { resolve, reject });
    ws.send(JSON.stringify(msg));
    setTimeout(() => { if (pend.has(mid)) { pend.delete(mid); reject(new Error(method + ' 超时')); } }, 25000);
  });
}

async function findTarget(filter) {
  const r = await send('Target.getTargets');
  return r.targetInfos.find(filter);
}
async function attach(targetId) {
  const r = await send('Target.attachToTarget', { targetId, flatten: true });
  return r.sessionId;
}

async function main() {
  // 1) 先到视频页唤醒 SW（当前 pattern 下 /series?page 不注入）
  let page = await findTarget((t) => t.type === 'page' && t.url.includes('rou.video'));
  if (!page) { console.log('无 rou.video 标签'); process.exit(1); }
  let psid = await attach(page.targetId);
  await send('Page.enable', {}, psid);
  await send('Page.navigate', { url: 'https://rou.video/v/cmtwsm9i1000imu4clzxw3ty3' }, psid);
  await sleep(6000);

  // 2) 重载扩展
  const sw = await findTarget((t) => t.type === 'service_worker' && t.url.includes('fieogbjpjaiokpmfkokckebfaojncomm'));
  if (!sw) { console.log('SW 未唤醒，中止'); process.exit(1); }
  const swsid = await attach(sw.targetId);
  await send('Runtime.evaluate', { expression: 'chrome.runtime.reload(); "ok"' }, swsid);
  console.log('扩展已重载（新 pattern 生效）');
  await sleep(4000);

  // 3) 回到停摆页 /series?page=2
  page = await findTarget((t) => t.type === 'page' && t.url.includes('rou.video'));
  psid = await attach(page.targetId);
  await send('Page.navigate', { url: 'https://rou.video/series?page=2' }, psid);
  await sleep(9000);

  // 4) 检查注入 + 批次原始状态 + 是否开始推进
  page = await findTarget((t) => t.type === 'page' && t.url.includes('rou.video'));
  psid = await attach(page.targetId);
  const r1 = await send('Runtime.evaluate', {
    expression: `({ url: location.href, extHost: !!document.getElementById('rv-ext-host'), myHook: !!window.__rvPageHook })`,
    returnByValue: true,
  }, psid);
  console.log('注入状态:', JSON.stringify(r1.result.value));

  const sw2 = await findTarget((t) => t.type === 'service_worker' && t.url.includes('fieogbjpjaiokpmfkokckebfaojncomm'));
  if (sw2) {
    const s2 = await attach(sw2.targetId);
    const r2 = await send('Runtime.evaluate', {
      expression: `(async () => JSON.stringify((await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch'] || null))()`,
      awaitPromise: true, returnByValue: true,
    }, s2);
    const b = JSON.parse(r2.result.value);
    console.log('批次:', b ? JSON.stringify({ active: b.active, mode: b.mode, done: b.done, note: b.note, vq: b.videoQueue?.length, sq: b.seriesQueue?.length, lp: b.listingPages?.length }) : 'null');
  } else {
    console.log('批次: SW 未唤醒（页面可能未注入）');
  }
  process.exit(0);
}

ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) {
    const p = pend.get(d.id);
    pend.delete(d.id);
    d.error ? p.reject(new Error(JSON.stringify(d.error))) : p.resolve(d.result);
  }
};
ws.onopen = main;
ws.onerror = () => { console.error('WS 错误'); process.exit(1); };
setTimeout(() => { console.error('总超时'); process.exit(1); }, 90000);
