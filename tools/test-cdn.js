// 取当前解析到的 CDN 播放列表 URL，在页面/SW 两个上下文分别测连通性
const BASE = 'http://127.0.0.1:9223';
const EXT = 'fieogbjpjaiokpmfkokckebfaojncomm';

async function cmd(method, params, sessionId) {
  const r = await fetch(BASE + '/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params, sessionId }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.result;
}
async function targets() {
  return (await (await fetch(BASE + '/targets')).json()).result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 1) 从面板拿 qualities[0].url
  let panel = (await targets()).find((t) => t.type === 'page' && t.url.includes(EXT + '/src/panel/panel.html'));
  let own = false;
  if (!panel) {
    const tab = await cmd('Target.createTarget', { url: `chrome-extension://${EXT}/src/panel/panel.html`, background: true });
    panel = { id: tab.targetId }; own = true;
  }
  await sleep(2000);
  const pps = await cmd('Target.attachToTarget', { targetId: panel.id, flatten: true });
  const r0 = await cmd('Runtime.evaluate', {
    expression: `(async () => {
      const t = (await chrome.tabs.query({ url: 'https://rou.video/*' }))[0];
      const s = await chrome.tabs.sendMessage(t.id, { type: 'rv-get-state' });
      return s.qualities?.[0]?.url || '';
    })()`,
    awaitPromise: true, returnByValue: true,
  }, pps.sessionId);
  const url = r0.result.value;
  console.log('CDN 播放列表 URL:', url || '(空)');
  if (!url) { if (own) await cmd('Target.closeTarget', { targetId: panel.id }); return; }

  // 2) 页面主世界 fetch 测试（15s 超时）
  const page = (await targets()).find((t) => t.type === 'page' && t.url.includes('rou.video'));
  const pgs = await cmd('Target.attachToTarget', { targetId: page.id, flatten: true });
  const r1 = await cmd('Runtime.evaluate', {
    expression: `(async () => {
      const t0 = performance.now();
      try {
        const r = await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(15000) });
        const buf = await r.arrayBuffer();
        return { ctx: 'page', status: r.status, ms: Math.round(performance.now() - t0), bytes: buf.byteLength };
      } catch (e) { return { ctx: 'page', err: e.name + ': ' + (e.message || '').slice(0, 50), ms: Math.round(performance.now() - t0) }; }
    })()`,
    awaitPromise: true, returnByValue: true,
  }, pgs.sessionId);
  console.log('页面主世界:', JSON.stringify(r1.result.value));

  // 3) SW fetch 测试（带 host_permissions 的扩展上下文）
  const sw = (await targets()).find((t) => t.type === 'service_worker' && t.url.includes(EXT));
  if (sw) {
    const sws = await cmd('Target.attachToTarget', { targetId: sw.id, flatten: true });
    const r2 = await cmd('Runtime.evaluate', {
      expression: `(async () => {
        const t0 = performance.now();
        try {
          const r = await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(15000) });
          const buf = await r.arrayBuffer();
          return { ctx: 'sw', status: r.status, ms: Math.round(performance.now() - t0), bytes: buf.byteLength };
        } catch (e) { return { ctx: 'sw', err: e.name + ': ' + (e.message || '').slice(0, 50), ms: Math.round(performance.now() - t0) }; }
      })()`,
      awaitPromise: true, returnByValue: true,
    }, sws.sessionId);
    console.log('SW 扩展上下文:', JSON.stringify(r2.result.value));
  } else {
    console.log('SW 未唤醒');
  }
  if (own) await cmd('Target.closeTarget', { targetId: panel.id });
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
