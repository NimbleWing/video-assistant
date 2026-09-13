// 端到端验证：失败重试 / 停止保留 / 继续剩余 / 清除记录
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
  // 0) 重载扩展（先确认无活动批次，再导航唤醒 SW）
  let sw = (await targets()).find((t) => t.type === 'service_worker' && t.url.includes(EXT));
  if (!sw) {
    const page = (await targets()).find((t) => t.type === 'page' && t.url.includes('rou.video'));
    if (page) {
      const ps0 = await cmd('Target.attachToTarget', { targetId: page.id, flatten: true });
      await cmd('Page.navigate', { url: 'https://rou.video/series' }, ps0.sessionId);
      await sleep(6000);
    }
    sw = (await targets()).find((t) => t.type === 'service_worker' && t.url.includes(EXT));
  }
  if (!sw) { console.log('SW 无法唤醒'); return; }
  const sws = await cmd('Target.attachToTarget', { targetId: sw.id, flatten: true });
  const evalSW = async (expr) => (await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sws.sessionId)).result.value;

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
  await evalSW(`chrome.storage.local.set({ 'rv-hud:batch': ${JSON.stringify(seed).replace(/"/g, "'")} })`.replace(/'rv-hud:batch'/, "'rv-hud:batch'"));
  // 上面的引号处理不可靠，直接用安全方式重写：
  await cmd('Runtime.evaluate', {
    expression: `chrome.storage.local.set({ 'rv-hud:batch': ${JSON.stringify(JSON.stringify(seed))}.length ? JSON.parse(${JSON.stringify(JSON.stringify(seed))}) : null })`,
    awaitPromise: true,
  }, sws.sessionId);
  console.log('已注入伪造批次记录（2 成功 / 2 失败 / 1 剩余，停止态）');
  await sleep(500);

  // 面板上下文操作（后台面板标签）
  let panel = (await targets()).find((t) => t.type === 'page' && t.url.includes(EXT + '/src/panel/panel.html'));
  let own = false;
  if (!panel) {
    const tab = await cmd('Target.createTarget', { url: `chrome-extension://${EXT}/src/panel/panel.html`, background: true });
    panel = { id: tab.targetId }; own = true;
  }
  await sleep(2200);
  const pps = await cmd('Target.attachToTarget', { targetId: panel.id, flatten: true });
  const evalPanel = async (expr) => (await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, pps.sessionId)).result.value;

  const report = await evalPanel(`document.querySelector('.batch')?.innerText.replace(/\\s+/g, ' ').slice(0, 220)`);
  console.log('面板报告区:', report);

  // 1) 重试失败项
  await evalPanel(`document.querySelector('[data-bact="retry"]')?.click(); 'clicked'`);
  await sleep(3000);
  let b = JSON.parse(await evalSW(`(async()=>JSON.stringify((await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch']||null))()`));
  console.log('重试后批次:', JSON.stringify({ active: b.active, note: b.note, done: b.done, vq: b.videoQueue.length, current: (b.current?.name || '').slice(0, 14) }));

  // 2) 等第一个失败项（真实文件已存在）被跳过
  for (let i = 0; i < 10; i++) {
    await sleep(3000);
    b = JSON.parse(await evalSW(`(async()=>JSON.stringify((await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch']||null))()`));
    if (b.done >= 1 || b.current?.id === 'zzz-bogus-id') break;
  }
  console.log('跳过后:', JSON.stringify({ done: b.done, current: (b.current?.name || '').slice(0, 14), failed: b.failed.length }));

  // 3) 停止（应保留记录并回队当前项）
  await evalPanel(`(async()=>{const t=(await chrome.tabs.query({url:'https://rou.video/*'}))[0];await chrome.tabs.sendMessage(t.id,{type:'rv-cmd',cmd:'batch-stop'});return 'stopped'})()`);
  await sleep(2500);
  b = JSON.parse(await evalSW(`(async()=>JSON.stringify((await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch']||null))()`));
  console.log('停止后:', JSON.stringify({ active: b.active, stoppedAt: !!b.stoppedAt, done: b.done, vq: b.videoQueue.length, failed: b.failed.length }));

  // 4) 继续剩余
  await evalPanel(`document.querySelector('[data-bact="resume"]')?.click(); 'clicked'`);
  await sleep(2500);
  b = JSON.parse(await evalSW(`(async()=>JSON.stringify((await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch']||null))()`));
  console.log('续跑后:', JSON.stringify({ active: b.active, note: b.note, current: (b.current?.name || '').slice(0, 14) }));

  // 5) 再停止并清除记录
  await evalPanel(`(async()=>{const t=(await chrome.tabs.query({url:'https://rou.video/*'}))[0];await chrome.tabs.sendMessage(t.id,{type:'rv-cmd',cmd:'batch-stop'});return 'ok'})()`);
  await sleep(2000);
  await evalPanel(`document.querySelector('[data-bact="clear"]')?.click(); 'clicked'`);
  await sleep(1500);
  const after = await evalSW(`(async()=>JSON.stringify((await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch']||null))()`);
  console.log('清除后批次:', after);
  if (own) await cmd('Target.closeTarget', { targetId: panel.id });
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
