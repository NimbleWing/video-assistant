// Native messaging 引导 host：接收扩展消息，detached 启动媒体库服务后即退出。
// 协议：4 字节小端长度前缀 + JSON（Chrome native messaging 标准）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** 读一条 native message。 @returns {Promise<any | null>} */
function readMessage() {
  return new Promise((resolve) => {
    /** @type {number | null} */
    let len = null;
    let buf = Buffer.alloc(0);
    process.stdin.on('data', (chunk) => {
      buf = Buffer.concat([buf, /** @type {Buffer} */ (chunk)]);
      if (len === null) {
        if (buf.length < 4) return;
        len = buf.readUInt32LE(0);
        buf = buf.subarray(4);
      }
      if (buf.length >= len) {
        try { resolve(JSON.parse(buf.subarray(0, len).toString('utf8'))); }
        catch { resolve(null); }
        return;
      }
    });
    process.stdin.on('end', () => resolve(null));
    process.stdin.on('error', () => resolve(null));
  });
}

/** @param {any} obj */
function sendMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

const msg = await readMessage();
if (msg?.cmd === 'start') {
  // detached：独立于本 host 与扩展连接存活（sendNativeMessage 一次性，host 随即退出）
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-sqlite', path.join(ROOT, 'server.js')], {
    detached: true,
    stdio: 'ignore',
    cwd: ROOT,
    windowsHide: true,
  });
  child.unref();
  sendMessage({ ok: true, pid: child.pid });
} else {
  sendMessage({ ok: false, error: 'unknown cmd' });
}
process.exit(0);
