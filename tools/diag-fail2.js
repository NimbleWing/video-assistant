// 经守护：从面板上下文读批次（含 failed 原因）+ 当前下载快照
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

async function main() {
  let panel = (await targets()).find((t) => t.type === 'page' && t.url.includes(EXT + '/src/panel/panel.html'));
  let own = false;
  if (!panel) {
    const tab = await cmd('Target.createTarget', { url: `chrome-extension://${EXT}/src/panel/panel.html`, background: true });
    panel = { id: tab.targetId };
    own = true;
  }
  await new Promise((r) => setTimeout(r, own ? 2500 : 300));
  const ps = await cmd('Target.attachToTarget', { targetId: panel.id, flatten: true });
  const r = await cmd('Runtime.evaluate', {
    expression: `(async () => {
      const b = (await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch'] || null;
      const tabs = await chrome.tabs.query({ url: 'https://rou.video/*' });
      let snap = null;
      try { snap = tabs.length ? await chrome.tabs.sendMessage(tabs[0].id, { type: 'rv-get-state' }) : null; } catch (e) { snap = { err: String(e.message) }; }
      return JSON.stringify({
        batch: b ? {
          active: b.active, mode: b.mode, done: b.done,
          failedCount: b.failed?.length || 0,
          failedSample: (b.failed || []).slice(-5).map((f) => ({ n: (f.name || '').slice(0, 24), e: (f.error || '').slice(0, 60) })),
          note: b.note, vq: b.videoQueue?.length, sq: b.seriesQueue?.length, lp: b.listingPages?.length,
          current: b.current ? (b.current.name || '').slice(0, 26) : null,
        } : null,
        snap: snap && !snap.err ? {
          path: snap.path,
          name: (snap.page?.name || '').slice(0, 26),
          qualities: snap.qualities?.length || 0,
          download: snap.download,
        } : snap,
      });
    })()`,
    awaitPromise: true, returnByValue: true,
  }, ps.sessionId);
  console.log(r.result.value);
  if (own) await cmd('Target.closeTarget', { targetId: panel.id });
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
