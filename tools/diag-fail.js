// 经守护一次性收集：当前页 URL / 批次状态 / 页面控制台日志 / 下载状态
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
  const page = (await targets()).find((t) => t.type === 'page' && t.url.includes('rou.video'));
  if (!page) { console.log('无 rou.video 页面'); return; }
  console.log('当前页:', page.url);

  const ps = await cmd('Target.attachToTarget', { targetId: page.id, flatten: true });
  await cmd('Log.enable', {}, ps.sessionId).catch(() => {});

  const r1 = await cmd('Runtime.evaluate', {
    expression: `(async () => {
      // 读取 __NEXT_DATA__ 的关键信息
      let video = null, ev = null;
      try {
        const d = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
        const pp = d?.props?.pageProps || {};
        video = pp.video ? { id: pp.video.id, name: (pp.video.nameZh || pp.video.name || '').slice(0, 30) } : null;
        ev = !!pp.ev;
      } catch (e) {}
      return { url: location.pathname, video, hasEv: ev, extHost: !!document.getElementById('rv-ext-host') };
    })()`,
    awaitPromise: true, returnByValue: true,
  }, ps.sessionId);
  console.log('页面信息:', JSON.stringify(r1.result.value));

  const sw = (await targets()).find((t) => t.type === 'service_worker' && t.url.includes(EXT));
  if (sw) {
    const s2 = await cmd('Target.attachToTarget', { targetId: sw.id, flatten: true });
    const r2 = await cmd('Runtime.evaluate', {
      expression: `(async () => {
        const b = (await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch'] || null;
        const tabs = await chrome.tabs.query({ url: 'https://rou.video/*' });
        let snap = null;
        try { snap = tabs.length ? await chrome.tabs.sendMessage(tabs[0].id, { type: 'rv-get-state' }) : null; } catch (e) { snap = { err: e.message }; }
        return JSON.stringify({
          batch: b ? { active: b.active, mode: b.mode, done: b.done, note: b.note, failed: b.failed?.slice(0, 5) } : null,
          snap: snap ? { path: snap.path, name: snap.page?.name?.slice(0, 30), download: snap.download ? { running: snap.download.running, done: snap.download.done, total: snap.download.total, error: snap.download.error, pct: snap.download.pct } : null } : null,
        });
      })()`,
      awaitPromise: true, returnByValue: true,
    }, s2.sessionId);
    console.log('批次与下载:', r2.result.value);
  } else {
    console.log('SW 未唤醒');
  }

  // 收集 2 秒日志
  await new Promise((r) => setTimeout(r, 2500));
}
// 日志收集
const http = require('http');
const logs = [];

main().catch((e) => console.error('ERR:', e.message));

// 简易：重复请求不实用；改为在 main 里通过 Log.entryAdded —— 守护未转发事件。
// 退而求其次：直接读 window 上的错误痕迹不可行；保留上面输出即可。
setTimeout(() => process.exit(0), 4000);
