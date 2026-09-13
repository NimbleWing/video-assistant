// 用与 http.js 完全一致的 fetch 选项复测（定位哪个选项引发挂起）
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
  const page = (await targets()).find((t) => t.type === 'page' && t.url.includes('rou.video'));
  const ps = await cmd('Target.attachToTarget', { targetId: page.id, flatten: true });
  const url = 'https://rou.video/api/hls/cmtynm5cw0000s6c6pqfz1mfa';

  const r = await cmd('Runtime.evaluate', {
    expression: `(async () => {
      const url = ${JSON.stringify(url)};
      const variants = [
        { tag: '默认(同源+cookie)', init: {} },
        { tag: 'omit', init: { credentials: 'omit' } },
        { tag: 'cors', init: { mode: 'cors' } },
        { tag: 'omit+cors+referrer', init: { credentials: 'omit', mode: 'cors', referrer: location.href } },
      ];
      const out = [];
      for (const v of variants) {
        const t0 = performance.now();
        try {
          const r = await fetch(url, { ...v.init, method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(12000) });
          const b = await r.arrayBuffer();
          out.push({ tag: v.tag, status: r.status, ms: Math.round(performance.now() - t0), bytes: b.byteLength });
        } catch (e) {
          out.push({ tag: v.tag, err: e.name, ms: Math.round(performance.now() - t0) });
        }
      }
      return out;
    })()`,
    awaitPromise: true, returnByValue: true,
  }, ps.sessionId);
  for (const row of r.result.value) console.log(JSON.stringify(row));
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
