# 本地媒体库服务设计（server/）

> 状态：已实施（扩展侧 v1.9.0 接入；管理页前端已迁移 `../server-web`）。本文档是该组件的独立维护文档，后续变更先改此处再动代码。

## 1. 背景与目标

扩展现有的「已下载」判定依赖 `chrome.downloads` 历史（basename 匹配 + 封面代理），存在固有缺陷：

- 手动下载/收藏的存量视频没有下载历史，无法识别；
- 用户手动移动/重命名/删除文件后，下载历史与磁盘脱节（误报跳过，且无逃生门）；
- 清空浏览器下载历史后判定失效（重复下载，靠 overwrite 自愈）。

本项目存量视频多、分散在多个磁盘、会被手动整理——**磁盘实况是唯一能跟上整理行为的真相源**。故新增本地 Node.js 服务：扫描所有磁盘的视频与封面入 SQLite，提供查询/登记 HTTP 接口，扩展下载前先问本地服务，下载后回写登记。

## 2. 总体架构

```
┌─────────────┐  GET /api/exists（判定，超时回退 downloads 校验）
│ Chrome 扩展  │ ────────────────────────────────▶ ┌──────────────────┐
│ (SW+content) │  POST /api/downloads（生命周期/登记） │  Node.js 本地服务  │
└─────────────┘ ◀──────────────────────────────── │  127.0.0.1:17321  │
                                                     │  · SQLite 台账     │
┌─────────────┐  GET /stream/:id（Range 直连播放）    │  · 磁盘扫描        │
│ 浏览器页面    │  GET /stream/:id/index.m3u8（HLS）  │  · HLS 流（ffmpeg） │
│ (hls.js)    │  GET /stream/:id/seg/:n.ts（分段）   │  · 管理页（同源）   │
└─────────────┘ ────────────────────────────────▶ └──────────────────┘
```

职责边界：

- **服务**：被动存储与查询。磁盘扫描、去重判定查询、下载账本、管理页（配置/分页浏览/播放/账本）。不主动驱动浏览器。
- **扩展**：所有下载生命周期事件的发起方与上报方；重试动作由扩展发起（服务开不了标签页）。

判定链（三层，逐级回退）：

```
本地服务（磁盘实况，权威） → chrome.downloads 历史校验（服务未启动/超时 ~300ms） → conflictAction:'overwrite' 落盘自愈
```

服务不可用最坏后果是漏报（重复下载后覆盖），不阻塞下载。

## 3. 技术选型与运行方式

- **语言 TypeScript，Node 原生 type stripping 运行**：要求 **Node ≥ 22.18**（本机 22.19）。源码即运行时（`node src/server.ts`），零构建、零产物入库、**零运行时 npm 依赖**（`node:sqlite` + `node:http`）。约束：仅 erasable 语法（不用 enum/namespace/参数属性）；import 必须带 `.ts` 扩展；类型检查只在开发期 `npm run check`（tsc --noEmit + vitest，devDeps：typescript / @types/node / vitest，**npm install 不是运行前提**）。
- **`server/package.json` 必须显式 `"type": "module"`**——否则 `.ts` 按 CJS 解析直接崩溃。
- **目录按 feature 组织**（对齐 server-web / tauri-react 的 features 模式），为后续模块（字幕库、元数据等）打地基：

```
server/src/
├── server.ts            # 入口：createApp().listen + 启动日志
├── app.ts               # createApp()：极简路由表（method+pattern+handler，零框架）注册各 feature、静态服务兜底、Origin 守卫、异常→JSON
├── lib/                 # 共享基础设施（无业务语义）
│   ├── db.ts            # DatabaseSync 单例（media.db 锚定 src/..；env ROU_MEDIA_DB 可覆盖，测试用 :memory:）+ WAL
│   ├── meta.ts          # meta KV 表 get/set（scan_dirs 等配置存储，后续 feature 可复用）
│   ├── http.ts          # json() / readJson() / asRecord() / HttpError / Route 与 RequestContext 类型
│   ├── static.ts        # public/ 静态服务（MIME 表 + 防路径穿越）
│   └── paths.ts         # normPath / stemOf / volumeOf / typeOfExt 纯函数
└── features/
    ├── media/           # 媒体库：磁盘实况（files 表）
    │   ├── index.ts     # 桶导出
    │   ├── files.ts     # files 表 DDL + 全部操作（upsert×2 / queryExists / listVideos / listVolumes / purge / setFileDuration / getFileBasic）
    │   ├── scanner.ts   # 扫描（消费 lib/meta 的 scan_dirs）
    │   ├── mp4.ts       # mvhd 流式时长解析
    │   ├── stream.ts    # /stream/:id Range 直连播放（封面图 + ffmpeg 缺失时的前端降级目标）
    │   ├── hls.ts       # /stream/:id/index.m3u8 + /seg/:n.ts：ffmpeg -c copy 按需分段（会话状态机）
    │   ├── routes.ts    # /api/videos、/api/files、/api/exists、/api/scan、/api/config
    │   └── types.ts     # FileRow / VideoItem / ScanResult / 各响应 DTO（纯类型）
    ├── ledger/          # 下载账本（downloads 表）
    │   ├── index.ts / downloads.ts / routes.ts / types.ts
    └── system/          # 服务级
        └── index.ts / routes.ts   # /api/ping（聚合 media+ledger 统计）、/api/log
```

组织规则：

- **feature 自治**：表 DDL 跟着 feature 走（单库多表），数据操作不跨 feature；`features/system` 的 ping 是唯一允许的跨 feature 聚合点。
- **feature 之间禁止互相 import**；新增功能模块 = 新增 `features/xxx/` 目录 + `app.ts` 注册一行。
- **lib/ 只放无业务语义的基础设施**，不放任何表操作。
- **类型单一来源**：API DTO 定义在 server 各 feature 的 `types.ts`，`server-web/src/lib/types.ts` 相对路径 re-export，字段漂移由编译器抓住。
- 测试按 feature 就近放置；vitest `setupFiles` 统一设 `ROU_MEDIA_DB=:memory:`（每测试文件隔离实例）。

- **ffmpeg 为可选增强，不破坏零依赖**：HLS 流播放（§7）依赖外部 ffmpeg 进程——启动时探测（配置路径优先、PATH 回退），缺失仅意味着 HLS 端点 503、前端降级 Range 直连（维持现状画质），`start.bat` 开箱即用不受影响。运行时其余部分维持零 npm 依赖。
- **管理页前端**：源码在 `../server-web`（独立 npm 包：React + TypeScript + Tailwind CSS + Vite + Vitest），`npm run build` 产物直出 `server/public`（文件名不带哈希、随仓库提交——服务侧维持零依赖、`start.bat` 开箱即用，代价是构建产物入库）。开发走 `npm run dev`（Vite dev server 代理 `/api`、`/stream` 到 17321；服务端写操作 Origin 白名单已含 dev origin）。
- 监听 `127.0.0.1:17321`。
- **启动方式**（二选一）：
  - 手动：`server/start.bat`（`node --no-warnings --experimental-sqlite src/server.ts`）
  - 面板一键：离线指示灯点击 → `chrome.runtime.sendNativeMessage('com.rouvideo.media', {cmd:'start'})` → native host（`native-host.ts`，经 `native-host.cmd` 包装）以 detached 方式 spawn `src/server.ts` 后即退出，服务独立存活；面板轮询 ping 确认上线。需先运行 `server/install-native.bat` 注册（HKCU 注册表 + host manifest，`allowed_origins` 锁扩展 ID；卸载用 `uninstall-native.bat`）。依赖 node 在 PATH。
- 数据库文件 `server/media.db`、日志 `server/server.log`（均锚定 server 根，代码经 `src/..` 相对定位，不依赖 cwd）。
- 开发命令：`server/` 内 `npm run check`（typecheck + test）。根目录 lint/typecheck 已排除 server（对齐 server-web 策略：无 eslint，tsc strict + 测试把关）。

## 4. 数据库设计（三张表）

```sql
-- 1. files：磁盘实况，去重判定唯一依据
CREATE TABLE files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT NOT NULL UNIQUE,      -- 绝对路径，统一小写 + 正斜杠
  stem       TEXT NOT NULL,             -- basename 去扩展名（小写），匹配主键位
  ext        TEXT NOT NULL,             -- mp4 / ts / jpg / png / webp
  type       TEXT NOT NULL CHECK (type IN ('video','cover')),
  size       INTEGER NOT NULL DEFAULT 0,
  mtime      INTEGER NOT NULL,          -- 文件修改时间（扫描游标 + 展示）
  volume     TEXT NOT NULL,             -- 盘符，如 'd:'（页面筛选）
  video_id   TEXT,                      -- 站点视频 ID：扩展登记时填，扫描存量为 NULL
  duration   REAL,                      -- 秒：登记时可带，存量为 NULL
  source     TEXT NOT NULL DEFAULT 'scanned' CHECK (source IN ('scanned','recorded')),
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
CREATE INDEX idx_files_stem      ON files (stem);
CREATE INDEX idx_files_type_stem ON files (type, stem);

-- 2. downloads：下载账本，一行一视频（upsert by (site, video_id)）
CREATE TABLE downloads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site        TEXT NOT NULL DEFAULT 'rou.video',
  video_id    TEXT NOT NULL,
  page_path   TEXT NOT NULL,           -- /v/{id} 或 /s/{id}：重试入口
  name        TEXT NOT NULL,           -- 视频标题
  series_name TEXT,
  quality     INTEGER,                 -- 最后一次下载使用的清晰度（720/1080）
  filename    TEXT NOT NULL,           -- 最后一次目标相对路径（剧名/xx.mp4）
  status      TEXT NOT NULL CHECK (status IN ('downloading','complete','failed','canceled','skipped')),
  error       TEXT,                    -- 最后一次失败原因（只记最终失败）
  attempts    INTEGER NOT NULL DEFAULT 1,
  size        INTEGER,                 -- 完成后回填
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_dl ON downloads (site, video_id);

-- 3. meta：配置与扫描游标
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- scan_dirs（JSON 数组）、ffmpeg_path（HLS 流用，空/缺省 = PATH 探测）、每目录 mtime 游标、页面偏好
```

已定决策记录：

| 决策 | 结论 | 备注 |
|------|------|------|
| 单表 vs 视频/文件双表 | files 单表 | 多盘副本各成行，页面按 stem 动态聚合，无视频级元数据需求 |
| 一行一视频 vs 一行一次尝试 | upsert 单行，attempts 累加 | error 只保留最后一次 |
| 唯一键含 quality？ | 不含，`(site, video_id)` | quality 语义 = 最后一次下载清晰度，丢失多版本历史（已接受） |
| 全集上报（pending）？ | 不做 | 「未下载清单」覆盖范围以批次实际跑到过的为准 |
| 失败粒度 | 只记最终失败 | 中途中断不单独记 |
| skipped 入账？ | 入账 | 支撑「该站点哪些视频没下过」视角：`status NOT IN ('complete','skipped')` |
| `.ts` 透传文件 | type='video' | 对齐扩展落盘行为（非 H.264 流存 .ts） |
| 封面存储 | 同表 `type='cover'` | 单片：stem 与视频相同；剧集：stem=剧名，与分集靠同目录关联 |

### 匹配与维护语义

- **判定匹配**：`/api/exists` 携带完整相对路径 `rel`（`剧名/xx.mp4`）与 `stem`；**路径后缀（`/{rel}`）优先，stem 相等回退**。匹配结果返回完整 path 列表，面板 toast 展示「已存在：D:\xxx.mp4」，误报（同名不同视频）一眼可辨。
- **封面关联（管理页卡片）**：`/api/videos` 对视频条目补 `cover_id`——优先 `type='cover' AND stem = 视频stem`（单片），回退 `stem = 视频所在目录名`（剧集封面 stem=剧名）；同页 stem 集合一次 `IN` 查询，未命中为 null（前端渲染占位图）。
- **files upsert（扫描）**：按 path 唯一。文件在 → 更新 `size/mtime/last_seen`，**不触碰 `video_id/source`**（保护登记数据）；文件消失 → 删行（判定自然回到未下载，正是期望行为）。全量重扫幂等。
- **downloads upsert（登记）**：按 `(site, video_id)`。开始 → `downloading`（attempts+1）；终态 → `complete/failed/canceled/skipped`。
- **两表不做硬外键**，靠 filename/stem 宽松关联——手动移动文件后 files.path 变，任务记录不失效。
- **去重判定只查 files**：downloads 有 complete 记录但文件已被删时，仍应判「未下载」。

## 5. 接口设计

| 接口 | 方向 | 说明 |
|------|------|------|
| `GET /api/ping` | 扩展面板 | 心跳：`{ok, uptime, videos, covers, downloads:{status:count}, ffmpeg:{available, path}}`；面板打开期间 30s 轮询——在线（绿）点击 = 新标签页打开管理页，离线（红）点击 = native messaging 启动服务 |
| `GET /api/log` | 管理页 | 服务日志尾部 200 行（native 启动时重定向到 server/server.log） |
| `GET /api/exists?rel=剧名/xx.mp4` | 扩展 | 路径后缀优先、stem 回退；返回 `{exists, matches:[{path,type,size}]}`；仅 `type='video'` 计为已下载 |
| `POST /api/downloads` | 扩展 | 账本 upsert（一行一视频）：开始（downloading）/最终失败（failed+error）/取消/跳过/完成（complete，带 size/duration） |
| `POST /api/files` | 扩展 | 落盘成功后登记物理文件（`{absPath, size}`，封面与视频统一经此入库，`source='recorded'`）；与账本分离、无竞态 |
| `POST /api/scan` | 页面/手动 | 触发扫描（幂等） |
| `GET /api/config` / `POST /api/config` | 页面 | 读取/保存 scan_dirs 与 ffmpeg_path（POST 校验目录/文件存在性，警告不阻断）；GET 附带 ffmpeg 探测状态 |
| `GET /api/videos?page=&size=&q=&volume=&type=` | 页面 | 分页 + 搜索 + 盘符/类型筛选，附盘符统计；视频条目带 `cover_id`（封面关联：stem 同名优先、目录名回退，`/stream/{cover_id}` 取图） |
| `GET /api/downloads?status=&site=&q=` | 页面/扩展 | 账本查询（含各 status 计数）；扩展拉 `status=failed` 驱动重试 |
| `GET /stream/:id` | 页面 | files.id 的 Range 直连播放（封面图固定走此端点；视频在 ffmpeg 缺失/HLS 失败时由前端降级到此处） |
| `GET /stream/:id/index.m3u8` | 页面 | HLS VOD 清单（服务端自生成，段数按时长算，详见 §7） |
| `GET /stream/:id/seg/:n.ts` | 页面 | 按需驱动 ffmpeg 生成第 n 段 MPEG-TS 并回流（`-c copy` 无损重整） |
| `GET /` | 页面 | 管理页：配置、视频分页浏览、播放、账本 |

安全：仅监听 127.0.0.1；校验 `Origin`/`Referer` 头，放行扩展 origin（`chrome-extension://fieogbjpjaiokpmfkokckebfaojncomm`）与自身页面，其余 403。无鉴权 token（本地个人使用，接受）。

## 6. 扫描机制

- **范围**：`meta.scan_dirs` 配置的目录列表（页面可改，默认引导用户配置而非全盘乱扫，系统盘排除靠不配置）。
- **首次**：全量遍历，收集 `mp4/ts` → `type='video'`，`jpg/png/webp` → `type='cover'`。
- **之后**：每目录 mtime 游标增量扫描；启动时自动增量一次 + 页面手动触发（定时任务暂不做，留配置项余地）。
- 增量与全量同一 upsert 路径，幂等。

## 7. HLS 流播放（ffmpeg 可选增强）

### 7.1 背景与决策

扩展 remux 产出的 MP4 存在结构性时基缺陷（不写 ctts、B 帧负 PTS 差被钳 1 tick），Chrome 严格 demuxer 下表现为周期性丢帧抖动；VLC/PotPlayer 靠码流 POC 容错无感。**病在帧级合成时间轴（含 DTS 缺失）而非段级**——实测 `ffmpeg -c copy` 重整出的 TS 无 DTS、段头丢帧、PTS 锯齿，MSE 丢帧比直连更狠；故采用 **libx264 实时转码**分段（对齐 stash 默认 HLS 路线），编码器重建全新时间轴（含 DTS），播放全程经服务端转码，不动磁盘文件。

已定决策：

| 决策 | 结论 | 备注 |
|------|------|------|
| 流形态 | HLS（m3u8 + MPEG-TS 分段） | seek/缓冲由 hls.js 免费解决；fMP4 管道直出会丢 Range/seek，弃 |
| 重整 vs 转码 | **libx264 转码**（veryfast/CRF 23） | copy 无法修复无 ctts 源的帧级时间轴（实测段头丢帧、无 DTS）；转码代价 = 轻微质量再损 + CPU（480p 约 1 核，可接受） |
| 切换策略 | 全部视频统一走 HLS | 单一路径可预期；`.ts` 透传文件一并救活；封面仍走 `/stream/:id` |
| remuxer 治本 | 不修 | 新文件继续带病落盘，库外 Chrome 直开仍抖（VLC/PotPlayer 无妨），已知已接受 |
| ffmpeg 定位 | 可选增强 + 自动降级 | 缺失 → HLS 端点 503 → 前端自动降级 `/stream/:id` 直连（维持现状画质） |
| 分段参数 | 2s 段、gap>5 判 seek 重启、预生成上限 15 段、段等待 15s 超时、空闲 30s 清理 | 对齐 stash 实测参数 |

### 7.2 ffmpeg 探测

- 优先 `meta.ffmpeg_path`（管理页设置页可配），其次 PATH 上的 `ffmpeg`。
- 探测结果进程内缓存（避免 ping 轮询反复 spawn）；保存配置后失效重探。
- `ffmpegInfo()` 暴露 `{ available, path, source: 'config' | 'path' | null }`，供 `/api/config` 与 `/api/ping` 聚合。
- 时长兜底：manifest 需要总时长——`files.duration` 缺失时（如 `.ts` 透传），spawn `ffmpeg -i` 解析 stderr `Duration:` 行，成功则 `setFileDuration` 回写。

### 7.3 清单与分段

- **清单服务端自生成**（不用 ffmpeg 写的）：段数 = `floor(duration / 2)`（宁可少承诺尾段 ≤2s，不超额承诺引发尾部段超时）；`#EXT-X-VERSION:3`、`TARGETDURATION:2`、`PLAYLIST-TYPE:VOD`、段 URL 用相对路径 `seg/{n}.ts`（对 Vite dev 代理天然友好）。
- **ffmpeg 参数**（每会话一个进程，按需起）：

  ```
  ffmpeg -hide_banner -loglevel error [-ss <n*2>] -i <file> \
    -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -sc_threshold 0 \
    -force_key_frames expr:gte(t,n_forced*2) \
    -c:a aac -b:a 128k -ac 2 \
    -sn -dn -copyts -avoid_negative_ts disabled \
    -f hls -start_number <n> -hls_time 2 -hls_flags split_by_time \
    -hls_segment_type mpegts -hls_playlist_type vod \
    -hls_segment_filename <dir>/.%d.ts <dir>/manifest.m3u8
  ```

  - **libx264 重建时间轴**：源 MP4 无 ctts/DTS，copy 无法修复；编码器输出全新 DTS/PTS（B 帧重排正确）。
  - `-copyts`：保持原始时间轴，seek 重启后段 PTS 与全局 2s 网格对齐，hls.js 时间线连续。
  - `force_key_frames` 每 2s 全局网格强关键帧：段起始必为关键帧（MSE 干净 append）。
  - 音频转 AAC：编码器输出完整 ADTS 帧，避免 copy 模式跨段切割 AAC 帧产生破音。
  - 临时段名 `.{n}.ts`（前置点）→ 下一段出现才改名为 `{n}.ts`，即「完整性确认」信号。

### 7.4 会话状态机（移植自 stash StreamManager，简化为单文件粒度）

- 会话键 = `files.id`，缓存根 `os.tmpdir()/rou-media-hls/<id>/`；服务启动时清空缓存根（残留自杀清理）。
- 全局 200ms monitor tick（有会话才运行）：
  1. **段确认**：从 `procSegment` 起向上扫 `.{i}.ts`，存在则将上一段改名转正（重复生成不覆盖已有段）；进程退出时按退出码决定末段转正（成功）或删除（失败，可能不完整）。
  2. **等待段派发**：文件已出现 → 回流该段（`video/mp2t`，`createReadStream` 管道）；超时 15s → 500。
  3. **按需起进程**：无进程 → 从最早等待段起；`idx < procSegment || procSegment + 5 < idx`（seek 跳变）→ 杀进程（下一 tick 待退出后再起新进程于目标段）。
  4. **回收**：无等待段且 30s 未访问 → 杀进程 + 删会话目录；`lastSegment..+15` 段全部就绪 → 杀进程（预生成封顶，保留文件与会话）。
- 同文件多播放页共享会话/进程；不同文件各自独立。

## 8. 扩展侧改动（已实施 v1.9.0）

1. **判定接入**：`background.js fileExists()` 先 `fetch http://127.0.0.1:17321/api/exists`（超时 ~300ms），失败/超时回退现有 `chrome.downloads.search` 逻辑；命中时 `matches` 路径带回面板 toast 展示。
2. **生命周期上报**：`main.js` 下载开始/最终失败/取消/跳过各上报一次（fire-and-forget）；`background.js downloadToDisk` 成功后（取 `DownloadItem.filename` 绝对路径）`POST /api/files` 登记物理文件（视频与封面统一）。
3. **SW 中转消息**：内容脚本不能直连 127.0.0.1（MV3 内容脚本 fetch 受 CORS 约束，host_permissions 豁免仅限 SW），新增 `rv-ledger-report` / `rv-ledger-query` 经 SW 转发（`src/net/ledger.js`）。
4. **逃生门**：跳过状态面板显示「仍然下载」，`download-force` 命令绕过判定强制重下。
5. **失败重试持久化**：批次失败列表从内存态升级为本地服务账本，面板「重试历史失败」拉 `status=failed` 复用 worker 标签页机制重跑；浏览器重启后失败列表不丢。
6. **manifest**：`host_permissions` 增加 `http://127.0.0.1:17321/*`。

## 9. 已知弱点与边界

- **同名 stem 误报**（不同视频同名）：靠 matches 路径展示 + 逃生门缓解，不做匹配收紧。
- **登记窗口期**：服务未运行时下载成功不落账，靠下次扫描补齐；判定侧有 downloads 回退层，无实质影响。
- **服务需手动启动**：不启动仅降级为现有行为，不影响功能。
- **「未下载清单」语义**：仅覆盖批次实际跑到过的视频（未做全集上报）。
- **remuxer 时基缺陷不治本**：新下载文件继续带病落盘（Chrome 直接打开仍抖）；HLS 转码只救「经管理页播放」这一路径。
- **转码质量/CPU 权衡**：播放流为 CRF 23 再编码（视觉近无损）+ 480p 约 1 核、1080p 约 1-2 核（veryfast）；长时间播放持续占用。
- **极短尾段（<2s）可能被清单 floor 截断**。
- **ffmpeg 缺失降级**：HLS 503 → 前端降级 Range 直连，画质回到「现状抖动」水平；设置页可见 ffmpeg 状态。

## 10. 实施阶段

1. **P1 服务本体**：建表、扫描（全量+增量）、`/api/exists`、`/api/scan`、start.bat。
2. **P2 管理页**：配置、视频分页浏览、播放（Range 流）、账本页。
3. **P3 扩展接入**：判定接入 + 回退、生命周期上报、manifest 权限。
4. **P4 增强**：逃生门、失败重试持久化拉取。
5. **P5 HLS 流播放**：ffmpeg 探测与配置、m3u8/分段端点与会话状态机、管理页 hls.js 播放 + 降级链（本次）。

## 11. 待确认项

- 无（全部决策已定稿；新决策先改本文档再动代码）。
