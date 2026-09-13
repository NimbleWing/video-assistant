// 经守护在页面主世界测 base64 两种实现（FileReader vs JS 循环）
const BASE = 'http://127.0.0.1:9223';

async function cmd(method, params, sessionId) {
  const r = await fetch(BASE + '/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params, sessionId }) });
  return (await r.json()).result;
}

async function main() {
  const t = await (await fetch(BASE + '/targets')).json();
  const page = t.result.find((x) => x.type === 'page' && x.url.includes('rou.video'));
  if (!page) { console.log('无 rou.video 页面'); return; }
  const a = await cmd('Target.attachToTarget', { targetId: page.id, flatten: true });
  const r = await cmd('Runtime.evaluate', {
    expression: `(async () => {
      const MB = 1024 * 1024;
      const buf = new Uint8Array(64 * MB);
      for (let i = 0; i < buf.length; i += 4096) buf[i] = i & 255;
      // JS 循环 + btoa
      let t0 = performance.now();
      let s = '';
      const step = 0x8000;
      for (let i = 0; i < buf.length; i += step) s += String.fromCharCode.apply(null, buf.subarray(i, i + step));
      const b64a = btoa(s);
      const tJs = performance.now() - t0;
      s = '';
      // FileReader 原生
      t0 = performance.now();
      const blob = new Blob([buf]);
      const dataUrl = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
      const b64b = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const tNative = performance.now() - t0;
      return {
        jsLoop_ms_per_64MB: Math.round(tJs),
        fileReader_ms_per_64MB: Math.round(tNative),
        speedup: (tJs / tNative).toFixed(1) + 'x',
        same: b64a.length === b64b.length && b64a[0] === b64b[0],
        jsLoop_est_1GB_s: Math.round(tJs / 64),
        native_est_1GB_s: Math.round(tNative / 64),
      };
    })()`,
    awaitPromise: true, returnByValue: true,
  }, a.sessionId);
  console.log(JSON.stringify(r.result.value, null, 1));
}

main().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
