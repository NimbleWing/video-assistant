// 实机验证 v3：可信输入事件（Input.dispatchMouseEvent）驱动真实点击 → 授权 → 批次续跑
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
  if (r.exceptionDetails) return { __exc: (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 400) };
  return r.result.value;
}
const findSw = async () => (await targets()).find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXT}`));
const findPage = async () => (await targets()).find((t) => t.type === 'page' && t.url.includes('rou.video'));

async function trustedClick(targetId, selector) {
  const rect = await evalIn(targetId, `(() => {
    const el = document.querySelector('${selector}');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!rect) return 'btn-not-found';
  const s = await cmd('Target.attachToTarget', { targetId, flatten: true });
  await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, s.sessionId);
  await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }, s.sessionId);
  return `clicked@${Math.round(rect.x)},${Math.round(rect.y)}`;
}

async function main() {
  // 1) 唤醒 SW 并重载扩展（载入最新修复）
  let page = await findPage();
  let ps = await cmd('Target.attachToTarget', { targetId: page.id, flatten: true });
  await cmd('Page.enable', {}, ps.sessionId);
  await cmd('Page.navigate', { url: page.url }, ps.sessionId);
  await sleep(4000);
  let sw = await findSw();
  if (!sw) return console.log('SW 未唤醒');
  await evalIn(sw.id, `chrome.runtime.reload(); 'ok'`);
  console.log('扩展已重载');
  await sleep(4000);

  // 2) 刷新 rou.video 页
  page = await findPage();
  ps = await cmd('Target.attachToTarget', { targetId: page.id, flatten: true });
  await cmd('Page.navigate', { url: page.url }, ps.sessionId);
  await sleep(5000);

  // 3) 面板（后台标签页）并激活到前台（可信事件需要可见视口）
  let panel = (await targets()).find((t) => t.type === 'page' && t.url.includes(`${EXT}/src/panel/panel.html`));
  if (!panel) {
    const t = await cmd('Target.createTarget', { url: `chrome-extension://${EXT}/src/panel/panel.html` });
    panel = { id: t.targetId };
  }
  await sleep(2500);
  await cmd('Target.activateTarget', { targetId: panel.id });
  await sleep(800);

  // 4) 渲染核对：报告卡应有一键修复按钮（含旧状态兼容推断）
  const pre = await evalIn(panel.id, `(() => ({
    reauthBtn: document.querySelector('[data-bact="reauth-resume"]')?.textContent || null,
    note: document.querySelector('.batch-report .batch-s:last-of-type')?.textContent?.slice(0, 60) || null,
  }))()`);
  console.log('[面板]', JSON.stringify(pre));
  if (!pre.reauthBtn) return console.log('一键修复按钮未渲染');

  // 5) 可信点击 → 浏览器将弹系统授权框
  console.log('[点击] 重新授权并继续 —— ★ 请在浏览器弹窗中点"允许文件访问" ★');
  console.log('  ->', await trustedClick(panel.id, '[data-bact="reauth-resume"]'));

  // 6) 轮询 90s：授权生效 → 批次续跑 → 后台标签页下载
  for (let i = 1; i <= 30; i++) {
    await sleep(3000);
    const s = await findSw();
    if (!s) { console.log(`[t+${i * 3}s] SW 休眠`); continue; }
    const st = await evalIn(s.id, `(async () => {
      const b = (await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch'];
      const tab = (await chrome.storage.session.get('rv-batch-tab'))['rv-batch-tab'] ?? null;
      return { active: b?.active, note: (b?.note || '').slice(0, 44), done: b?.done, failed: b?.failed?.length, workerTab: tab };
    })()`);
    const rouTabs = (await targets()).filter((t) => t.type === 'page' && t.url.includes('rou.video')).length;
    console.log(`[t+${i * 3}s]`, JSON.stringify(st), `rouTabs=${rouTabs}`);
    if ((st.done || 0) > 0) { console.log('>>> 批次产出成功项：全链路（授权→续跑→后台标签页→下载落盘）打通'); break; }
  }
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
