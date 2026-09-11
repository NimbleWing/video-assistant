// 直连 Chrome DevTools Protocol：连接浏览器端点并执行一系列操作
// 用法: node cdp-direct.js <step>
const fs = require('fs');

const [port, path] = fs.readFileSync('C:/Users/ASUS/AppData/Local/Google/Chrome/User Data/DevToolsActivePort', 'utf8').trim().split(/\r?\n/);
const URL_ = `ws://127.0.0.1:${port}${path}`;

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL_);
    const t = setTimeout(() => { reject(new Error('WS 连接超时')); try { ws.close(); } catch {} }, 10000);
    ws.onopen = () => { clearTimeout(t); resolve(ws); };
    ws.onerror = (e) => { clearTimeout(t); reject(new Error('WS 错误: ' + (e.message || e.type))); };
  });
}

let msgId = 0;
const pending = new Map();

function send(ws, method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(msg));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(method + ' 超时'));
      }
    }, 30000);
  });
}

function attach(ws, handle) {
  return new Promise(async (resolve, reject) => {
    try {
      const r = await send(ws, 'Target.attachToTarget', { targetId: handle, flatten: true });
      resolve(r.sessionId);
    } catch (e) { reject(e); }
  });
}

async function main() {
  const step = process.argv[2];
  const ws = await connect();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id);
      pending.delete(d.id);
      d.error ? p.reject(new Error(JSON.stringify(d.error))) : p.resolve(d.result);
    }
  };

  if (step === 'open-panel-tab') {
    const r = await send(ws, 'Target.createTarget', {
      url: 'chrome-extension://fieogbjpjaiokpmfkokckebfaojncomm/src/panel/panel.html',
      background: true,
    });
    console.log('PANEL_TAB_TARGET=' + r.targetId);
  }

  if (step === 'close-panel-tab') {
    const r = await send(ws, 'Target.getTargets');
    const panel = r.targetInfos.find((t) => t.type === 'page' && t.url.includes('fieogbjpjaiokpmfkokckebfaojncomm/src/panel/panel.html'));
    if (panel) { await send(ws, 'Target.closeTarget', { targetId: panel.targetId }); console.log('面板标签已关闭'); }
    else console.log('无面板标签');
  }

  if (step === 'synth-save') {
    // 从面板标签发起一次微型保存，验证 SW→offscreen→落盘 全链路
    // 可用环境变量 PANEL_TARGET 指定标签目标（侧边栏不是 tab，sender.tab 为空会被 SW 忽略）
    const r = await send(ws, 'Target.getTargets');
    const panels = r.targetInfos.filter((t) => t.url.includes('src/panel/panel.html'));
    const wanted = process.env.PANEL_TARGET;
    const panel = wanted ? panels.find((t) => t.targetId === wanted) : panels[0];
    if (!panel) { console.log('面板页未打开'); process.exit(1); }
    const sid = await attach(ws, panel.targetId);
    const name = process.argv[3] || ('rv-pipeline-test-' + Date.now() + '.txt');
    const expr = `(async () => {
      const saveId = 'synth' + Date.now();
      const b64 = btoa(' RouVideo save pipeline test @ ' + new Date().toISOString());
      await chrome.runtime.sendMessage({ type: 'rv-save-begin', saveId, filename: '${name}', mime: 'text/plain', conflictAction: 'overwrite' });
      await chrome.runtime.sendMessage({ type: 'rv-save-chunk', saveId, b64 });
      const settled = await new Promise((resolve) => {
        const onMsg = (m) => { if (m?.type === 'dl-settled' && m.saveId === saveId) { chrome.runtime.onMessage.removeListener(onMsg); resolve(m); } };
        chrome.runtime.onMessage.addListener(onMsg);
        chrome.runtime.sendMessage({ type: 'rv-save-end', saveId }).catch(() => {});
        setTimeout(() => { chrome.runtime.onMessage.removeListener(onMsg); resolve({ ok: false, error: 'timeout' }); }, 20000);
      });
      return settled;
    })()`;
    const r2 = await send(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sid);
    console.log('落盘结果:', JSON.stringify(r2.result.value), ' 文件名:', name);
  }

  if (step === 'activate-rou') {
    const r = await send(ws, 'Target.getTargets');
    const page = r.targetInfos.find((t) => t.type === 'page' && t.url.includes('rou.video'));
    if (!page) { console.log('未找到 rou.video 标签'); process.exit(1); }
    await send(ws, 'Target.activateTarget', { targetId: page.targetId });
    console.log('已激活 rou.video 标签');
  }

  if (step === 'panel-check') {
    const r = await send(ws, 'Target.getTargets');
    const panel = r.targetInfos.find((t) => t.url.includes('fieogbjpjaiokpmfkokckebfaojncomm/src/panel/panel.html'));
    if (!panel) { console.log('面板页未打开'); process.exit(1); }
    const sid = await attach(ws, panel.targetId);
    const r2 = await send(ws, 'Runtime.evaluate', {
      expression: `(async () => {
        await new Promise(r => setTimeout(r, 1500));
        const app = document.getElementById('app');
        return {
          dirText: app.querySelector('.dirbox')?.innerText.replace(/\\s+/g, ' ') || null,
          hasPickBtn: !!app.querySelector('[data-dact="pickdir"]'),
          meta: app.querySelector('.meta')?.textContent || '',
        };
      })()`,
      awaitPromise: true, returnByValue: true,
    }, sid);
    console.log(JSON.stringify(r2.result.value));
  }

  if (step === 'targets') {
    const r = await send(ws, 'Target.getTargets');
    for (const t of r.targetInfos) {
      console.log(`[${t.type}] ${t.targetId} ${t.url.slice(0, 90)}`);
    }
  }

  if (step === 'reload-ext') {
    // 在我们扩展的 service worker 里执行 chrome.runtime.reload()
    const r = await send(ws, 'Target.getTargets');
    const sw = r.targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('fieogbjpjaiokpmfkokckebfaojncomm'));
    if (!sw) { console.log('未找到扩展 SW'); process.exit(1); }
    const sid = await attach(ws, sw.targetId);
    await send(ws, 'Runtime.evaluate', { expression: 'chrome.runtime.reload(); "reloading"', awaitPromise: false }, sid);
    console.log('已执行 chrome.runtime.reload()');
  }

  if (step === 'reload-via-panel') {
    const r = await send(ws, 'Target.getTargets');
    const panel = r.targetInfos.find((t) => t.url.includes('fieogbjpjaiokpmfkokckebfaojncomm/src/panel/panel.html'));
    if (!panel) { console.log('未找到扩展面板页'); process.exit(1); }
    const sid = await attach(ws, panel.targetId);
    await send(ws, 'Runtime.evaluate', { expression: 'chrome.runtime.reload(); "reloading"' }, sid);
    console.log('已通过面板执行 chrome.runtime.reload()');
  }

  if (step === 'navigate') {
    const url = process.argv[3];
    const r = await send(ws, 'Target.getTargets');
    const page = r.targetInfos.find((t) => t.type === 'page' && t.url.includes('rou.video'));
    if (!page) { console.log('未找到 rou.video 标签页'); process.exit(1); }
    const sid = await attach(ws, page.targetId);
    await send(ws, 'Page.enable', {}, sid);
    await send(ws, 'Page.navigate', { url }, sid);
    console.log('已导航到', url);
  }

  if (step === 'state') {
    const r = await send(ws, 'Target.getTargets');
    const sw = r.targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('fieogbjpjaiokpmfkokckebfaojncomm'));
    if (!sw) { console.log('SW 未唤醒'); process.exit(1); }
    const swSid = await attach(ws, sw.targetId);
    const expr = `(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://rou.video/*' });
      if (!tabs.length) return 'no-tab';
      return await chrome.tabs.sendMessage(tabs[0].id, { type: 'rv-get-state' });
    })()`;
    const r2 = await send(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, swSid);
    const s = r2.result.value;
    console.log(JSON.stringify({ path: s.path, page: s.page?.name, series: s.page?.seriesName, download: s.download, listing: s.listing ? s.listing.kind : null }));
  }

  if (step === 'batch-start') {
    const mode = process.argv[3] || 'series';
    const limit = Number(process.argv[4]) || 0;
    const r = await send(ws, 'Target.getTargets');
    const sw = r.targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('fieogbjpjaiokpmfkokckebfaojncomm'));
    if (!sw) { console.log('SW 未唤醒'); process.exit(1); }
    const swSid = await attach(ws, sw.targetId);
    const expr = `(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://rou.video/*' });
      if (!tabs.length) return 'no-tab';
      await chrome.tabs.sendMessage(tabs[0].id, { type: 'rv-cmd', cmd: 'batch-start', value: { mode: '${mode}', allPages: false, limit: ${limit} } });
      return 'batch-started';
    })()`;
    const r2 = await send(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true }, swSid);
    console.log('SW 执行结果:', JSON.stringify(r2.result.value));
  }

  if (step === 'batch-state') {
    const r = await send(ws, 'Target.getTargets');
    const sw = r.targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('fieogbjpjaiokpmfkokckebfaojncomm'));
    if (!sw) { console.log('SW 未唤醒'); process.exit(1); }
    const swSid = await attach(ws, sw.targetId);
    const r2 = await send(ws, 'Runtime.evaluate', {
      expression: `(async () => (await chrome.storage.local.get('rv-hud:batch'))['rv-hud:batch'])()`,
      awaitPromise: true, returnByValue: true,
    }, swSid);
    const b = r2.result.value;
    console.log(b ? JSON.stringify({ active: b.active, done: b.done, failed: b.failed?.length, note: b.note, vq: b.videoQueue?.length, sq: b.seriesQueue?.length }) : 'null');
  }

  if (step === 'download') {
    // 通过扩展 SW 向 rou.video 标签发 rv-cmd download
    const r = await send(ws, 'Target.getTargets');
    const page = r.targetInfos.find((t) => t.type === 'page' && t.url.includes('rou.video'));
    const sw = r.targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('fieogbjpjaiokpmfkokckebfaojncomm'));
    if (!page || !sw) { console.log('缺目标', !!page, !!sw); process.exit(1); }
    const swSid = await attach(ws, sw.targetId);
    const expr = `(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://rou.video/*' });
      if (!tabs.length) return 'no-tab';
      const snap = await chrome.tabs.sendMessage(tabs[0].id, { type: 'rv-get-state' });
      await chrome.tabs.sendMessage(tabs[0].id, { type: 'rv-cmd', cmd: 'download' });
      return 'sent, qualities=' + snap.qualities.length + ', seriesName=' + (snap.page && snap.page.seriesName);
    })()`;
    const r2 = await send(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true }, swSid);
    console.log('SW 执行结果:', JSON.stringify(r2.result.value));
  }

  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
