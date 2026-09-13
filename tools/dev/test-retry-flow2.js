// 核心逻辑验证（绕过面板 UI 的 currentTabId，直接对内容脚本发命令）
const BASE = 'http://127.0.0.1:9223';
const EXT = 'fieogbjpjaiokpmfkokckebfaojncomm';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cmd(method, params, sessionId) {
  const r = await fetch(BASE + '/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params, sessionId }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.result;
}
async function targets() {
  return (await (await fetch(BASE + '/targets')).json()).result;
}

async function main() {
  let sw = (await targets()).find((t) => t.type === 'service_worker' && t.url.includes(EXT));
  if (!sw) { console.log('SW 未唤醒'); return; }
  const sws = await cmd('Target.attachToTarget', { targetId: sw.id, flatten: true });
  const evalSW = async (expr) => (await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sws.sessionId)).result.value;
  const getBatch = async () => JSON.parse(await evalSW(`(async()=>JSON.stringify((await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch']||null))()`));
  const sendRou = (expr) => evalSW(`(async()=>{const t=(await chrome.tabs.query({url:'https://rou.video/*'}))[0];try{return String(await chrome.tabs.sendMessage(t.id,${expr}))}catch(e){return 'ERR:'+e.message}})()`);

  // 重新注入干净的种子
  const seed = {
    active: false, mode: 'single', limit: 0,
    listingPages: [], seriesQueue: [],
    videoQueue: [{ id: 'cmtwsn5mr000lmu4c154j1bfz', name: '暗黑白雪 · 第2集' }],
    current: null, done: 2,
    failed: [
      { id: 'cmtwsm9i1000imu4clzxw3ty3', name: '暗黑白雪 · 第1集', error: '测试-网络错误' },
      { id: 'zzz-bogus-id', name: '测试-必然失败项', error: '解析超时' },
    ],
    total: 5, note: '已停止', lastHarvested: '',
    startedAt: Date.now(), updatedAt: Date.now(), stoppedAt: Date.now(),
  };
  await evalSW(`(async()=>{await chrome.storage.local.set({['rv-hud:batch']: JSON.parse(${JSON.stringify(JSON.stringify(seed))})});return 'ok'})()`);
  console.log('种子已注入');

  // 1) 重试失败项
  console.log('retry →', await sendRou(`{type:'rv-cmd',cmd:'batch-retry'}`));
  await sleep(3000);
  let b = await getBatch();
  console.log('重试后:', JSON.stringify({ active: b.active, note: b.note, done: b.done, vq: b.videoQueue.length, current: (b.current?.name || '').slice(0, 12) }));

  // 2) 等已有文件项被秒跳
  for (let i = 0; i < 8; i++) {
    await sleep(3000);
    b = await getBatch();
    if (b.done >= 1) break;
  }
  console.log('跳过后:', JSON.stringify({ done: b.done, current: (b.current?.name || '').slice(0, 12), failed: b.failed.length }));

  // 3) 停止 → 应保留并回队
  console.log('stop →', await sendRou(`{type:'rv-cmd',cmd:'batch-stop'}`));
  await sleep(2500);
  b = await getBatch();
  console.log('停止后:', JSON.stringify({ active: b.active, stopped: !!b.stoppedAt, done: b.done, vq: b.videoQueue.length, failed: b.failed.length }));

  // 4) 继续剩余
  console.log('resume →', await sendRou(`{type:'rv-cmd',cmd:'batch-resume'}`));
  await sleep(3000);
  b = await getBatch();
  console.log('续跑后:', JSON.stringify({ active: b.active, note: b.note, current: (b.current?.name || '').slice(0, 12) }));

  // 5) 停止 + 清除
  await sendRou(`{type:'rv-cmd',cmd:'batch-stop'}`);
  await sleep(2000);
  console.log('clear →', await sendRou(`{type:'rv-cmd',cmd:'batch-clear'}`));
  await sleep(1200);
  console.log('清除后批次:', await getBatch());
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
