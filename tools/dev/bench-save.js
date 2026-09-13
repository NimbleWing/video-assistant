// 经守护在页面里基准测试：JS 循环 base64 vs FileReader 原生 base64 vs 消息往返
const BASE = 'http://127.0.0.1:9223';

async function cmd(method, params, sessionId) {
  const r = await fetch(BASE + '/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params, sessionId }) });
  return (await r.json()).result;
}
async function targets() {
  const r = await fetch(BASE + '/targets');
  return (await r.json()).result;
}

async function main() {
  const page = (await targets()).find((t) => t.type === 'page' && t.url.includes('rou.video'));
  if (!page) { console.log('无 rou.video 页面'); return; }
  const a = await cmd('Target.attachToTarget', { targetId: page.id, flatten: true });
  const r = await cmd('Runtime.evaluate', {
    expression: `(async () => {
      const MB = 1024 * 1024;
      const buf = new Uint8Array(64 * MB);
      crypto.getRandomValues(buf.subarray(0, 4096));
      // 1) JS 循环 + btoa（现方案）
      let t0 = performance.now();
      let s = '';
      const step = 0x8000;
      for (let i = 0; i < buf.length; i += step) s += String.fromCharCode.apply(null, buf.subarray(i, i + step));
      const b64a = btoa(s);
      const tJs = performance.now() - t0;
      s = null;
      // 2) FileReader 原生
      t0 = performance.now();
      const blob = new Blob([buf]);
      const dataUrl = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
      const b64b = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const tNative = performance.now() - t0;
      // 3) 消息往返 4MB×8
      const chunk4 = b64b.slice(0, 4 * MB);
      t0 = performance.now();
      for (let i = 0; i < 8; i++) await chrome.runtime.sendMessage({ type: 'rv-bench', b64: chunk4 });
      const tMsg32MB = performance.now() - t0;
      return {
        jsBase64_ms_64MB: Math.round(tJs),
        nativeBase64_ms_64MB: Math.round(tNative),
        msgRoundTrip_ms_32MB: Math.round(tMsg32MB),
        est_1GB_js_s: Math.round(tJs * 16 / 1000),
        est_1GB_native_s: Math.round(tNative * 16 / 1000),
        est_1GB_msg_s: Math.round(tMsg32MB * 32 / 1000),
        same: b64a === b64b,
      };
    })()`,
    awaitPromise: true, returnByValue: true,
  }, a.sessionId);
  console.log(JSON.stringify(r.result.value, null, 1));
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
