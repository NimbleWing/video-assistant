// 复现"点重新授权无弹窗"：插桩 requestPermission → 可信点击 → 读回真实结果
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
  if (r.exceptionDetails) return { __exc: (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 600) };
  return r.result.value;
}
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
  let panel = (await targets()).find((t) => t.type === 'page' && t.url.includes(`${EXT}/src/panel/panel.html`));
  if (!panel) return console.log('面板页不存在');
  await cmd('Target.activateTarget', { targetId: panel.id });
  await sleep(600);

  // 1) 插桩：记录 requestPermission 的调用/返回/耗时/激活态
  await evalIn(panel.id, `(() => {
    window.__rvDiag = [];
    const proto = FileSystemDirectoryHandle.prototype;
    const orig = proto.requestPermission;
    proto.requestPermission = function (...args) {
      const t0 = performance.now();
      const act = navigator.userActivation ? { been: navigator.userActivation.hasBeenActive, active: navigator.userActivation.isActive } : null;
      const rec = { call: 'requestPermission', args: JSON.stringify(args), activation: act };
      window.__rvDiag.push(rec);
      return orig.apply(this, args).then(
        (v) => { rec.result = v; rec.ms = Math.round(performance.now() - t0); return v; },
        (e) => { rec.error = e.name + ': ' + (e.message || '').slice(0, 200); rec.ms = Math.round(performance.now() - t0); throw e; },
      );
    };
    return 'instrumented';
  })()`);

  // 2) 点"重新授权并继续"（可信输入 → 真实用户手势）
  console.log('[点击] 重新授权并继续 —— 请留意浏览器是否弹出授权气泡');
  console.log('  ->', await trustedClick(panel.id, '[data-bact="reauth-resume"]'));
  await sleep(2500);

  // 3) 读回插桩结果
  for (let i = 0; i < 10; i++) {
    const diag = await evalIn(panel.id, `window.__rvDiag || []`);
    console.log('[插桩]', JSON.stringify(diag, null, 1));
    const rec = (diag || [])[0];
    if (rec && (rec.result || rec.error)) {
      if (rec.result === 'granted') console.log('>>> 已授权（' + (rec.ms < 500 ? '无弹窗直接授予' : '经弹窗授予') + '）');
      else if (rec.error) console.log('>>> 失败：' + rec.error);
      else console.log('>>> 返回：' + rec.result);
      break;
    }
    await sleep(1500);
  }

  // 4) 授权后确认批次侧生效
  const sw = (await targets()).find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${EXT}`));
  if (sw) {
    const off = await evalIn(sw.id, `chrome.runtime.sendMessage({ to: 'os', type: 'os-write-file', filename: '.rv-diag-probe', b64: 'MQ==' })`);
    console.log('[offscreen 直写]', JSON.stringify(off));
  }
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
