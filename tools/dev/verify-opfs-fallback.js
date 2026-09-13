// 实机终验 v5：SW 直接下发 batch-start（跳过面板手势/静默重授权）→ 验证纯 OPFS 降级路径
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
async function evalIn(targetId, expr) {
  const s = await cmd('Target.attachToTarget', { targetId, flatten: true });
  const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, s.sessionId);
  if (r.exceptionDetails) return { __exc: (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300) };
  return r.result.value;
}
const findSw = async () => (await targets()).find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXT}`));

async function main() {
  let sw = await findSw();
  if (!sw) {
    const page = (await targets()).find((t) => t.type === 'page' && t.url.includes('rou.video'));
    const ps = await cmd('Target.attachToTarget', { targetId: page.id, flatten: true });
    await cmd('Page.enable', {}, ps.sessionId);
    await cmd('Page.navigate', { url: page.url }, ps.sessionId);
    await sleep(4000);
    sw = await findSw();
  }
  if (!sw) return console.log('SW 未唤醒');

  // 清掉旧暂停批次，避免状态混淆
  await evalIn(sw.id, `chrome.storage.local.remove('rv-hud:batch'); 'cleared'`);

  // 找 rou.video 列表页 tab，直接下发 batch-start（limit 3）
  const tab = await evalIn(sw.id, `(await chrome.tabs.query({ url: 'https://rou.video/*' }))[0].id`);
  console.log('[tab]', tab);
  const r = await evalIn(sw.id, `chrome.tabs.sendMessage(${tab}, { type: 'rv-cmd', cmd: 'batch-start', value: { mode: 'single', allPages: false, limit: 3 } })`);
  console.log('[batch-start 应答]', JSON.stringify(r));

  // 轮询 6 分钟
  const t0 = Date.now();
  for (let i = 1; i <= 24; i++) {
    await sleep(15000);
    const s = await findSw();
    if (!s) continue;
    const st = await evalIn(s.id, `(async () => {
      const b = (await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch'];
      return { active: b?.active, done: b?.done, failed: b?.failed?.length,
        note: (b?.note || '').slice(0, 40), fsDown: !!b?.fsDown, reason: b?.stoppedReason ?? null,
        lastErr: b?.failed?.[0]?.error?.slice(0, 50) };
    })()`);
    console.log(`[t+${Math.round((Date.now() - t0) / 1000)}s]`, JSON.stringify(st));
    if (st.active === false && st.reason) { console.log('>>> 又暂停：' + st.reason); return; }
    if ((st.done || 0) >= 2) { console.log(`>>> OPFS 兜底验证通过：done=${st.done} fsDown=${st.fsDown} 全程无暂停`); return; }
  }
  console.log('窗口结束');
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
