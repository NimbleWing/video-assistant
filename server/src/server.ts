// 服务入口：createApp().listen。启动方式见 DESIGN.md §3（start.bat / native host）。
import path from 'node:path';
import { SERVER_ROOT } from './lib/db.ts';
import { createApp, HOST, PORT } from './app.ts';
import { initHlsCache } from './lib/hls-core.ts';

initHlsCache(); // 清理上次运行残留的 HLS 分段缓存

const server = createApp();
server.listen(PORT, HOST, () => {
  console.log(`[media-server] http://${HOST}:${PORT} （媒体库 ${path.join(SERVER_ROOT, 'media.db')}）`);
});
