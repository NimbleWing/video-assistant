// 经 CDP 守护执行：扩展重载（新 match pattern）→ 停摆页续跑验证
const BASE = 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body) {
  const opts = { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opts);
  return r.json();
}
const cmd = (method, params, sessionId) => api('/cmd', { method, params, sessionId });

async function targets() {
  const r = await api('/targets');
  return r.result;
}

async function main() {
  // 1) 到视频页唤醒 SW（旧 pattern 下 /v/<id> 可注入）
  let pages = (await targets()).filter((t) => t.url.includes('rou.video'));
  if (!pages.length) { console.log('无 rou.video 标签'); return; }
  let a1 = await cmd('Target.attachToTarget', { targetId: pages[0].id, flatten: true });
  await cmd('Page.enable', {}, a1.result.sessionId);
  await cmd('Page.navigate', { url: 'https://rou.video/v/cmtwsm9i1000imu4clzxw3ty3' }, a1.result.sessionId);
  await sleep(6000);

  // 2) 重载扩展
  const sw = (await targets()).find((t) => t.type === 'service_worker' && t.url.includes('fieogbjpjaiokpmfkokckebfaojncomm'));
  if (!sw) { console.log('SW 未唤醒'); return; }
  const a2 = await cmd('Target.attachToTarget', { targetId: sw.id, flatten: true });
  await cmd('Runtime.evaluate', { expression: 'chrome.runtime.reload(); "ok"' }, a2.result.sessionId);
  console.log('扩展已重载（/series* 新规则生效）');
  await sleep(4000);

  // 3) 回到停摆页
  pages = (await targets()).filter((t) => t.url.includes('rou.video'));
  const a3 = await cmd('Target.attachToTarget', { targetId: pages[0].id, flatten: true });
  await cmd('Page.navigate', { url: 'https://rou.video/series?page=2' }, a3.result.sessionId);
  await sleep(9000);

  // 4) 检查注入与批次
  pages = (await targets()).filter((t) => t.url.includes('rou.video'));
  const a4 = await cmd('Target.attachToTarget', { targetId: pages[0].id, flatten: true });
  const r1 = await cmd('Runtime.evaluate', {
    expression: `({ url: location.href, extHost: !!document.getElementById('rv-ext-host'), myHook: !!window.__rvPageHook })`,
    returnByValue: true,
  }, a4.result.sessionId);
  console.log('注入状态:', JSON.stringify(r1.result.result.value));

  const sw2 = (await targets()).find((t) => t.type === 'service_worker' && t.url.includes('fieogbjpjaiokpmfkokckebfaojncomm'));
  if (sw2) {
    const a5 = await cmd('Target.attachToTarget', { targetId: sw2.id, flatten: true });
    const r2 = await cmd('Runtime.evaluate', {
      expression: `(async () => { const b = (await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch'] || null; return b ? JSON.stringify({ active: b.active, mode: b.mode, done: b.done, note: b.note, vq: b.videoQueue?.length, sq: b.seriesQueue?.length, lp: b.listingPages?.length }) : 'null'; })()`,
      awaitPromise: true, returnByValue: true,
    }, a5.result.sessionId);
    console.log('批次:', r2.result.result.value);
  } else {
    console.log('批次: SW 未唤醒');
  }
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
