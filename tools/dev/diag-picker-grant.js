// 更换目录路径的授权寿命实验：可信点击"更换" → 用户选同一文件夹 → 轮询授权存活
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
  await sleep(500);

  // 插桩 picker（如果面板代码里 showDirectoryPicker 抛错/被取消也能看到）
  await evalIn(panel.id, `(() => {
    window.__pickDiag = [];
    const orig = window.showDirectoryPicker;
    window.showDirectoryPicker = function (...a) {
      const rec = { at: new Date().toLocaleTimeString() };
      window.__pickDiag.push(rec);
      return orig.apply(this, a).then((h) => { rec.name = h.name; return h; }, (e) => { rec.err = e.name; throw e; });
    };
    return 'ok';
  })()`);

  console.log('即将打开目录选择器——请选中原来的"视频"文件夹并确认；留意之后是否弹出带选项的权限气泡');
  console.log('  ->', await trustedClick(panel.id, '[data-bact="pickdir"]:not([data-bact="cleardir"])'));

  // 轮询：picker 完成 + 授权状态 + 存活时长
  const t0 = Date.now();
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const st = await evalIn(panel.id, `(async () => {
      const w = await import('/src/net/fsdir.js');
      const h = await w.loadDirHandle();
      if (!h) return { handle: null };
      let q = '?';
      try { q = await h.queryPermission({ mode: 'readwrite' }); } catch (e) { q = 'err:' + e.name; }
      return { handle: h.name, query: q, picks: window.__pickDiag || [] };
    })()`);
    console.log(`[+${Math.round((Date.now() - t0) / 1000)}s]`, JSON.stringify(st));
    if (st.query === 'granted') break;
  }

  // 授予后：每 60s 探一次存活（观察 picker 授权的寿命；期间不要点任何扩展界面）
  console.log('--- 开始寿命观察（每 60s 一次，共 12 分钟；期间请勿操作扩展界面） ---');
  for (let i = 1; i <= 12; i++) {
    await sleep(60000);
    const st = await evalIn(panel.id, `(async () => {
      const w = await import('/src/net/fsdir.js');
      const h = await w.loadDirHandle();
      try { return { query: await h.queryPermission({ mode: 'readwrite' }) }; } catch (e) { return { query: 'err:' + e.name }; }
    })()`);
    console.log(`[+${Math.round((Date.now() - t0) / 1000)}s]`, JSON.stringify(st));
    if (st.query !== 'granted') { console.log('>>> picker 授权也回收了'); return; }
  }
  console.log('>>> 12 分钟仍 granted —— picker 授权至少是长寿命的');
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
