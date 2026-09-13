// 授权寿命观察器（纯面板侧探测，不唤醒 SW/offscreen，排除干扰变量）
// 每 60s 记录 queryPermission；结束时汇总授权死亡时刻。用法：node watch-grant.js > log
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
  if (r.exceptionDetails) return { __exc: (r.exceptionDetails.exception?.description || '').slice(0, 200) };
  return r.result.value;
}

async function main() {
  const panel = (await targets()).find((t) => t.type === 'page' && t.url.includes(`${EXT}/src/panel/panel.html`));
  if (!panel) return console.log('FATAL 面板页不存在');
  const t0 = Date.now();
  const log = (m) => console.log(`${new Date().toLocaleTimeString()} [+${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
  log(`start handle 探测`);
  for (let i = 0; i < 15; i++) {
    const st = await evalIn(panel.id, `(async () => {
      const w = await import('/src/net/fsdir.js');
      const h = await w.loadDirHandle();
      if (!h) return { handle: null };
      try { return { handle: h.name, query: await h.queryPermission({ mode: 'readwrite' }) }; }
      catch (e) { return { handle: h.name, query: 'err:' + e.name }; }
    })()`);
    log(JSON.stringify(st));
    if (st.query !== 'granted') { log('>>> 授权死亡'); return; }
    await sleep(60000);
  }
  log('>>> 15 分钟仍 granted');
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
