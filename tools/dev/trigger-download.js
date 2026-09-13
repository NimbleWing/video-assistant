// 触发当前页下载并跟踪结果
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
  let panel = (await targets()).find((t) => t.type === 'page' && t.url.includes(EXT + '/src/panel/panel.html'));
  let own = false;
  if (!panel) {
    const tab = await cmd('Target.createTarget', { url: `chrome-extension://${EXT}/src/panel/panel.html`, background: true });
    panel = { id: tab.targetId };
    own = true;
  }
  await sleep(2000);
  const ps = await cmd('Target.attachToTarget', { targetId: panel.id, flatten: true });

  const evalPanel = async (expr) => {
    const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, ps.sessionId);
    return r.result.value;
  };
  const snap = () => evalPanel(`(async () => {
    const t = (await chrome.tabs.query({ url: 'https://rou.video/*' }))[0];
    try { return await chrome.tabs.sendMessage(t.id, { type: 'rv-get-state' }); } catch (e) { return { err: String(e.message) }; }
  })()`);

  console.log('触发下载…');
  await evalPanel(`(async () => {
    const t = (await chrome.tabs.query({ url: 'https://rou.video/*' }))[0];
    await chrome.tabs.sendMessage(t.id, { type: 'rv-cmd', cmd: 'download' });
    return 'sent';
  })()`);

  for (let i = 1; i <= 12; i++) {
    await sleep(i <= 3 ? 2000 : 5000);
    const s = await snap();
    if (s.err) { console.log(`t+${i}: 消息失败 ${s.err}`); break; }
    const d = s.download || {};
    const line = `t+${i * (i <= 3 ? 2 : 5)}s running=${d.running} pct=${(d.pct || 0).toFixed(0)}% done=${d.done}/${d.total} err=${d.error || '-'} skipped=${!!d.skipped}`;
    console.log(line);
    if (!d.running && (d.finished || d.error || d.skipped)) break;
    if (!d.running && !d.finished && !d.error && !d.skipped && i > 2) { console.log('  (无下载状态——可能尚未开始)'); break; }
  }
  const final = await snap();
  console.log('最终 download:', JSON.stringify(final.download));
  if (own) await cmd('Target.closeTarget', { targetId: panel.id });
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
