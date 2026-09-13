// 重试：导航续跑 + 批次状态 + 48MB 合成保存计时
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
  let page = (await targets()).find((t) => t.type === 'page' && t.url.includes('rou.video'));
  if (!page) { console.log('无 rou.video 页面'); return; }
  console.log('当前页:', page.url);
  const ps = await cmd('Target.attachToTarget', { targetId: page.id, flatten: true });
  await cmd('Page.navigate', { url: page.url }, ps.sessionId);
  await sleep(10000);

  const sw = (await targets()).find((t) => t.type === 'service_worker' && t.url.includes(EXT));
  if (sw) {
    const s2 = await cmd('Target.attachToTarget', { targetId: sw.id, flatten: true });
    const r = await cmd('Runtime.evaluate', {
      expression: `(async () => { const b = (await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch'] || null; return b ? JSON.stringify({ active: b.active, done: b.done, note: b.note, vq: b.videoQueue?.length, sq: b.seriesQueue?.length, lp: b.listingPages?.length }) : 'null'; })()`,
      awaitPromise: true, returnByValue: true,
    }, s2.sessionId);
    console.log('批次:', r.result.value);
  } else {
    console.log('批次: SW 未唤醒');
  }

  const tab = await cmd('Target.createTarget', { url: `chrome-extension://${EXT}/src/panel/panel.html`, background: true });
  await sleep(2000);
  const ps3 = await cmd('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
  const r3 = await cmd('Runtime.evaluate', {
    expression: `(async () => {
      const saveId = 'synth' + Date.now();
      const big = new Uint8Array(48 * 1024 * 1024);
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
        setTimeout(() => resolve({ ok: false, error: 'timeout' }), 90000);
      });
      return { ok: settled.ok, note: settled.note || '', ms_48MB: Math.round(performance.now() - t0) };
    })()`,
    awaitPromise: true, returnByValue: true,
  }, ps3.sessionId);
  console.log('48MB 合成保存:', JSON.stringify(r3.result.value));
  await cmd('Target.closeTarget', { targetId: tab.targetId });
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
