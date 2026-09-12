// 常驻 CDP 代理：与 Chrome 保持一条长连接（整个会话只需一次远程调试确认），
// 本地 HTTP 127.0.0.1:9223 提供 /cmd 转发，后续所有诊断/操作经此进行。
const http = require('http');
const fs = require('fs');

const [port, path] = fs.readFileSync('C:/Users/ASUS/AppData/Local/Google/Chrome/User Data/DevToolsActivePort', 'utf8').trim().split(/\r?\n/);
const WS_URL = `ws://127.0.0.1:${port}${path}`;
const LISTEN = 9223;

let ws = null;
let nextId = 0;
const pending = new Map();
let connectedAt = 0;
let cmdCount = 0;

function log(msg) {
  console.log(`[cdp-daemon ${new Date().toLocaleTimeString()}] ${msg}`);
}

function connect() {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(WS_URL);
    const t = setTimeout(() => reject(new Error('连接超时（可能等待用户确认）')), 120000);
    sock.onopen = () => { clearTimeout(t); resolve(sock); };
    sock.onerror = (e) => { clearTimeout(t); reject(new Error('WS 错误')); };
  });
}

function rpc(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const mid = ++nextId;
    const msg = { id: mid, method, params };
    if (sessionId) msg.sessionId = sessionId;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify(msg));
    setTimeout(() => {
      if (pending.has(mid)) { pending.delete(mid); reject(new Error(method + ' 超时')); }
    }, 30000);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function main() {
  ws = await connect();
  connectedAt = Date.now();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id);
      pending.delete(d.id);
      d.error ? p.reject(new Error(JSON.stringify(d.error))) : p.resolve(d.result);
    }
  };
  ws.onclose = () => {
    log('WS 断开，5 秒后重连（会再弹一次确认）');
    setTimeout(() => process.exit(42), 5000); // 由外部守护重启
  };
  log('已连接 Chrome：' + WS_URL);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method === 'GET' && req.url === '/ping') {
      res.end(JSON.stringify({ ok: true, ws: ws.readyState, since: connectedAt, cmds: cmdCount }));
      return;
    }
    if (req.method === 'GET' && req.url === '/targets') {
      try {
        const r = await rpc('Target.getTargets');
        res.end(JSON.stringify({ ok: true, result: r.targetInfos.map((t) => ({ type: t.type, id: t.targetId, url: t.url.slice(0, 110) })) }));
      } catch (e) { res.end(JSON.stringify({ ok: false, error: e.message })); }
      return;
    }
    if (req.method === 'POST' && req.url === '/cmd') {
      cmdCount += 1;
      try {
        const { method, params = {}, sessionId } = JSON.parse(await readBody(req));
        const r = await rpc(method, params, sessionId);
        res.end(JSON.stringify({ ok: true, result: r }));
      } catch (e) {
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });

  server.listen(LISTEN, '127.0.0.1', () => log(`本地接口 http://127.0.0.1:${LISTEN} 就绪`));

  // 保活：周期性心跳，及时发现断连
  setInterval(() => { rpc('Browser.getVersion').catch(() => {}); }, 20000);
}

main().catch((e) => { log('启动失败: ' + e.message); process.exit(1); });
