// 经守护：重载扩展（新保存管线）→ 批次续跑 → 合成保存验证直连 ACK 链路
const BASE = 'http://127.0.0.1:9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cmd(method, params, sessionId) {
  const r = await fetch(BASE + '/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params, sessionId }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.result;
}
async function targets() {
  const r = await fetch(BASE + '/targets');
  const j = await r.json();
  return j.result;
}
const EXT = 'fieogbjpjaiokpmfkokckebfaojncomm';

async function main() {
  // 1) 记录当前页面并重载扩展
  let page = (await targets()).find((t) => t.type === 'page' && t.url.includes('rou.video'));
  const backUrl = page ? page.url.split('|')[0] : 'https://rou.video/series';
  let sw = (await targets()).find((t) => t.type === 'service_worker' && t.url.includes(EXT));
  if (!sw) { console.log('SW 未唤醒（批次应正在跑）'); return; }
  const sws = await cmd('Target.attachToTarget', { targetId: sw.id, flatten: true });
  await cmd('Runtime.evaluate', { expression: 'chrome.runtime.reload(); "ok"' }, sws.sessionId);
  console.log('扩展已重载（16MB 分块 / offscreen 直连 ACK / 原生 base64 / remux 后释放缓冲）');
  await sleep(4000);

  // 2) 重新加载当前页面让批次续跑
  page = (await targets()).find((t) => t.type === 'page' && t.url.includes('rou.video'));
  if (page) {
    const ps = await cmd('Target.attachToTarget', { targetId: page.id, flatten: true });
    await cmd('Page.enable', {}, ps.sessionId);
    await cmd('Page.navigate', { url: backUrl }, ps.sessionId);
    console.log('已重新导航:', backUrl);
  }
  await sleep(10000);

  // 3) 批次状态
  sw = (await targets()).find((t) => t.type === 'service_worker' && t.url.includes(EXT));
  if (sw) {
    const s2 = await cmd('Target.attachToTarget', { targetId: sw.id, flatten: true });
    const r = await cmd('Runtime.evaluate', {
      expression: `(async () => { const b = (await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch'] || null; return b ? JSON.stringify({ active: b.active, done: b.done, note: b.note }) : 'null'; })()`,
      awaitPromise: true, returnByValue: true,
    }, s2.sessionId);
    console.log('批次:', r.result.value);
  }

  // 4) 合成保存验证新管线（后台面板标签）
  const tab = await cmd('Target.createTarget', {
    url: `chrome-extension://${EXT}/src/panel/panel.html`,
    background: true,
  });
  await sleep(2000);
  const ps3 = await cmd('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
  const t0 = Date.now();
  const r3 = await cmd('Runtime.evaluate', {
    expression: `(async () => {
      const saveId = 'synth' + Date.now();
      const big = new Uint8Array(48 * 1024 * 1024); // 48MB 载荷
      for (let i = 0; i < big.length; i += 65536) big[i] = i & 255;
      const blob = new Blob([big]);
      const url = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
      const b64 = url.slice(url.indexOf(',') + 1);
      const t0 = performance.now();
      await chrome.runtime.sendMessage({ type: 'rv-save-begin', saveId, filename: 'rv-perf-test.bin', mime: 'application/octet-stream', conflictAction: 'overwrite' });
      const half = Math.ceil(b64.length / 3);
      await chrome.runtime.sendMessage({ type: 'rv-save-chunk', saveId, b64: b64.slice(0, half) });
      await chrome.runtime.sendMessage({ type: 'rv-save-chunk', saveId, b64: b64.slice(half) });
      await chrome.runtime.sendMessage({ type: 'rv-save-end', saveId });
      const settled = await new Promise((resolve) => {
        const onMsg = (m) => { if (m?.type === 'dl-settled' && m.saveId === saveId) { chrome.runtime.onMessage.removeListener(onMsg); resolve(m); } };
        chrome.runtime.onMessage.addListener(onMsg);
        setTimeout(() => resolve({ ok: false, error: 'timeout' }), 60000);
      });
      return { ok: settled.ok, note: settled.note || '', ms: Math.round(performance.now() - t0) };
    })()`,
    awaitPromise: true, returnByValue: true,
  }, ps3.sessionId);
  console.log('48MB 合成保存:', JSON.stringify(r3.result.value), `(总耗时含断言 ${Date.now() - t0}ms)`);
  await cmd('Target.closeTarget', { targetId: tab.targetId });
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
