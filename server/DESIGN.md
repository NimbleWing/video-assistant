# 本地媒体库服务设计（server/）

> 状态：已实施（扩展侧 v1.9.0 接入；管理页前端已迁移 `../server-web`）。本文档是该组件的独立维护文档，后续变更先改此处再动代码。

## 1. 背景与目标

扩展现有的「已下载」判定依赖 `chrome.downloads` 历史（basename 匹配 + 封面代理），存在固有缺陷：

- 手动下载/收藏的存量视频没有下载历史，无法识别；
- 用户手动移动/重命名/删除文件后，下载历史与磁盘脱节（误报跳过，且无逃生门）；
- 清空浏览器下载历史后判定失效（重复下载，靠 overwrite 自愈）。

本项目存量视频多、分散在多个磁盘、会被手动整理——**磁盘实况是唯一能跟上整理行为的真相源**。故新增本地 Node.js 服务：扫描各盘 `RawFiles/` 入 SQLite（raw_files 表，本地媒体唯一基座），提供查询/登记 HTTP 接口，扩展下载前先问本地服务，下载后回写账本。

**files 表退役（2026-09-23）**：早期另设 `files` 表 + `scan_dirs` 目录扫描（media feature）承载判定与「视频库」页。后 G 盘存量已全部整理进各盘 `RawFiles/`，raw_files 覆盖完整、且带 hash/查重/归档策展能力，files 表沦为过期快照（手动扫描不常跑、purge 不执行）。故整体移除：`files` 表 DROP、`/api/videos`、`POST /api/files`、`/api/scan`、`/stream/:id` 全家接口与视频库页、设置页扫描配置一并退役，判定链收敛为「账本 → raw_files」两层。

## 2. 总体架构

```
┌─────────────┐  GET /api/exists（判定，超时回退 downloads 校验）
│ Chrome 扩展  │ ────────────────────────────────▶ ┌──────────────────┐
│ (SW+content) │  POST /api/downloads（生命周期/登记） │  Node.js 本地服务  │
└─────────────┘ ◀──────────────────────────────── │  127.0.0.1:17321  │
                                                      │  · SQLite 台账     │
┌─────────────┐  GET /api/raw/file/:id/content      │  · 磁盘扫描        │
│ 浏览器页面    │  （图片/原生视频 Range 直连）        │  · HLS 流（ffmpeg） │
│ (hls.js)    │  GET /api/raw/file/:id/index.m3u8   │  · 管理页（同源）   │
│             │  + /seg/:n.ts（HLS 分段）            │                   │
└─────────────┘ ────────────────────────────────▶ └──────────────────┘
```

职责边界：

- **服务**：被动存储与查询。磁盘扫描（各盘 RawFiles/）、去重判定查询、下载账本、原始资料库（盘点 + 抽样 hash，见 §6）、管理页（配置/分页浏览/播放/账本/原始资料）。不主动驱动浏览器。
- **扩展**：所有下载生命周期事件的发起方与上报方；重试动作由扩展发起（服务开不了标签页）。

判定链（服务内两层：账本 → raw_files；服务不可用时扩展侧逐级回退）：

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
│   ├── db.ts            # DatabaseSync 单例（media.db 锚定 src/..；env ROU_MEDIA_DB 可覆盖，测试用 :memory:）+ WAL + 旧表迁移（files 表 DROP）
│   ├── meta.ts          # meta KV 表 get/set（ffmpeg_path 等配置存储，后续 feature 可复用）
│   ├── http.ts          # json() / readJson() / asRecord() / HttpError / Route 与 RequestContext 类型
│   ├── static.ts        # public/ 静态服务（MIME 表 + 防路径穿越）
│   ├── paths.ts         # normPath / stemOf / volumeOf / dirName 纯函数
│   └── hls-core.ts      # HLS 会话状态机 + ffmpeg 探测（无业务语义：键泛化为字符串，raw 用）
└── features/
    ├── raw/             # 原始资料库：各盘 RawFiles/ 盘点 + 抽样 hash（raw_files 表，本地媒体唯一基座）
    │   ├── index.ts     # 桶导出
    │   ├── files.ts     # raw_files/raw_archive/raw_events 三表 DDL + 全部操作（upsert/touch/配对合并/消失判定/事件列表）
    │   ├── hash.ts      # 抽样 SHA-256（头/中/尾 64KB + size）+ .ts 魔数嗅探
    │   ├── volumes.ts   # 盘符探测（A:–Z: 根下 RawFiles/ 存在才返回 + statfs 容量）
    │   ├── scanner.ts   # 扫描任务（单任务、作用域消失判定、协作取消、SSE 广播）
    │   ├── stream.ts    # /api/raw/file/:id/content（图片/原生视频 Range 直连）
    │   ├── hls.ts       # raw 适配层：raw_files.id → 行 → ffmpeg 探时长 → lib/hls-core 会话
    │   ├── routes.ts    # /api/raw/*（volumes/scan 启停/状态/SSE/files/missing/duplicates/archived/file/events）
    │   └── types.ts     # RawFileRow / RawScanStatus 等响应 DTO（纯类型）
    ├── ledger/          # 下载账本（downloads 表）
    │   ├── index.ts / downloads.ts / routes.ts / types.ts
    ├── country/         # 国家字典（countries 表，演员体系基石）
    │   ├── index.ts / countries.ts / routes.ts / types.ts
    ├── tag/             # 标签字典（tags 表，sort 全量重编号拖拽排序）
    │   ├── index.ts / tags.ts / routes.ts / types.ts
    ├── studio/          # 片商字典（studios 表，logo BLOB 入库）
    │   ├── index.ts / studios.ts / routes.ts / types.ts
    ├── actress/         # 女优（actresses + actress_aliases + actress_tags 三表；头像=归档 raw 文件）
    │   ├── index.ts / actresses.ts / routes.ts / types.ts
    ├── video/           # 作品（videos + 四张多对多关系表；原始资料页归档流）
    │   ├── index.ts / videos.ts / routes.ts / types.ts
    └── system/          # 服务级
        ├── index.ts / routes.ts / types.ts   # /api/ping（聚合 raw+ledger 统计）、/api/log、/api/shutdown、/api/exists（账本→raw 两层判定）、/api/config（ffmpeg_path）
```

组织规则：

- **feature 自治**：表 DDL 跟着 feature 走（单库多表），数据操作不跨 feature；`features/system` 的 ping 是唯一允许的跨 feature 聚合点。
- **feature 之间禁止互相 import**；新增功能模块 = 新增 `features/xxx/` 目录 + `app.ts` 注册一行。
  - **放宽注记（2026-09-21）**：关联表归从属 feature，引用方经导出**纯函数**协作（先例：exists 组合 import ledger/raw；tag 删除级联清 actress_tags、country 禁删查 actress 引用、tags.actor_count 读 actress_tags 计数）。禁止跨 feature 直接写对方表。
- **lib/ 只放无业务语义的基础设施**，不放任何表操作。
- **类型单一来源**：API DTO 定义在 server 各 feature 的 `types.ts`，`server-web/src/lib/types.ts` 相对路径 re-export，字段漂移由编译器抓住。
- 测试按 feature 就近放置；vitest `setupFiles` 统一设 `ROU_MEDIA_DB=:memory:`（每测试文件隔离实例）。

- **ffmpeg 为可选增强，不破坏零依赖**：HLS 流播放（§7）依赖外部 ffmpeg 进程——启动时探测（配置路径优先、PATH 回退），缺失仅意味着 HLS 端点 503、前端降级 Range 直连（维持现状画质），`start.bat` 开箱即用不受影响。运行时其余部分维持零 npm 依赖。
- **管理页前端**：源码在 `../server-web`（独立 npm 包：React + TypeScript + Tailwind CSS + Vite + Vitest），`npm run build` 产物直出 `server/public`（文件名不带哈希、随仓库提交——服务侧维持零依赖、`start.bat` 开箱即用，代价是构建产物入库）。开发走 `npm run dev`（Vite dev server 代理 `/api`、`/stream` 到 17321；服务端写操作 Origin 白名单已含 dev origin）。
- 监听 `127.0.0.1:17321`。
- **启动方式**（二选一）：
  - 手动：`server/start.bat`（`node --no-warnings --experimental-sqlite src/server.ts`）
   - 面板一键：离线指示灯点击 → `chrome.runtime.sendNativeMessage('com.rouvideo.media', {cmd:'start'})` → native host（`native-host.ts`，经 `native-host.cmd` 包装）以 detached 方式 spawn `src/server.ts` 后即退出，服务独立存活；面板轮询 ping 确认上线。需先运行 `server/install-native.bat` 注册（HKCU 注册表 + host manifest，`allowed_origins` 锁扩展 ID；卸载用 `uninstall-native.bat`）。依赖 node 在 PATH。
   - 面板重启（v1.13.0）：在线时指示灯旁 `⟳` 按钮 → `POST /api/shutdown` → 确认离线（≤3s）→ native start 拉起 → 轮询至在线（≤15s）。服务无状态（数据全在 SQLite），重启安全；进行中的 raw 扫描会中断（扫描幂等可重跑）。
- 数据库文件 `server/media.db`、日志 `server/server.log`（均锚定 server 根，代码经 `src/..` 相对定位，不依赖 cwd）。
- 开发命令：`server/` 内 `npm run check`（typecheck + test）。根目录 lint/typecheck 已排除 server（对齐 server-web 策略：无 eslint，tsc strict + 测试把关）。

## 4. 数据库设计

```sql
-- 0. files 表：已退役（2026-09-23 DROP，见 §1）；启动迁移见 lib/db.ts

-- 1. downloads：下载账本，一行一视频（upsert by (site, video_id)）
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

-- 2. meta：配置存储
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- ffmpeg_path（HLS 流用，空/缺省 = PATH 探测）、raw_last_selection（原始资料页上次的盘符+类型勾选）、页面偏好
-- （scan_dirs 已随 files 表退役清除）

-- 3. raw_files：原始资料库（各盘 RawFiles/ 盘点 + hash 查重底账；本地媒体唯一基座）
CREATE TABLE raw_files (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  path            TEXT NOT NULL UNIQUE,       -- 绝对路径，normPath 归一（小写 + 正斜杠）
  hash            TEXT NOT NULL,              -- 抽样 SHA-256 hex（头/中/尾 64KB + size）
  name            TEXT NOT NULL,              -- **最初名字**（改名永不更新，供扩展下载查重匹配）
  ext             TEXT NOT NULL,              -- mp4 / ts / jpg ...
  type            TEXT NOT NULL CHECK (type IN ('video','image')),
  size            INTEGER NOT NULL,
  mtime           INTEGER NOT NULL,           -- 跳过重算的三键之一
  volume          TEXT NOT NULL,              -- 'd:'（列表筛选 + 消失判定作用域）
  missing         INTEGER NOT NULL DEFAULT 0, -- 用户已确认的消失标记（不重报，查重排除）
  pending_missing INTEGER NOT NULL DEFAULT 0, -- 扫描发现消失、待用户决策
  archived        INTEGER NOT NULL DEFAULT 0,  -- 1=发生过移动/改名（单行跟随：id 不变，path/volume 随文件更新）
  duration        INTEGER,                    -- 视频时长（秒；技术元数据归 raw_files。扫描新建/变更时 ffmpeg 探测回填 + 扫描收尾存量补录，归档流程兜底，缺失为 NULL）
  width           INTEGER,                    -- 视频宽（px；与 duration 同一次 ffmpeg -i 探测，2026-09-23 视频卡片复刻引入）
  height          INTEGER,                    -- 视频高（px；同上）
  first_seen      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL
);
CREATE INDEX idx_raw_hash ON raw_files (hash);  -- 后续查重的关键路径

-- 4. raw_archive：归档登记（一行一文件；其余数据关联 raw_files 查）
CREATE TABLE raw_archive (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id    INTEGER NOT NULL UNIQUE,
  name       TEXT NOT NULL,        -- 当前最新名字（改名时更新；移动不动）
  created_at INTEGER NOT NULL,     -- 首次归档时间（首次改名或移动）
  updated_at INTEGER NOT NULL      -- 最近一次变更时间
);

-- 5. raw_events：变更日志（全部变更一张表；kind 按需扩枚举）
CREATE TABLE raw_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id    INTEGER NOT NULL,     -- 关联 raw_files（无外键约定，行删则悬空保留）
  kind       TEXT NOT NULL CHECK (kind IN ('rename','move')),
  result     TEXT NOT NULL,        -- 「名称从 xx 改为 xx」「从 xx 移动到 xx」
  created_at INTEGER NOT NULL     -- = 扫描 token
);
CREATE INDEX idx_raw_events_file ON raw_events (file_id, created_at);

-- 6. countries：国家字典（演员体系基石；2026-09-21 首期仅 CRUD）
CREATE TABLE countries (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE           -- trim 后非空、≤60 字符，重复返回 409
);
-- 终局语义（2026-09-21 女优落地）：actresses.country_id 引用本表；无演员视频人工指定国家。
-- 删除保护（2026-09-21 落地）：被女优引用的国家禁删（409，提示先解除关联）。
-- 列表 ORDER BY id 正序（添加顺序），不分页。

-- 7. tags：标签字典（sort 拖拽排序；2026-09-21 首期仅 CRUD + 重排）
CREATE TABLE tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,          -- trim 后非空、≤60 字符，重复 409
  sort INTEGER NOT NULL               -- 紧凑连续 1..n：reorder 按新顺序全量重编号（事务）
);
-- 列表 ORDER BY sort ASC, id ASC；新增 sort = max+1 追加末尾。
-- GET 响应含 video_count / actor_count：actor_count = 挂此标签的女优数（COUNT actress_tags）；
-- video_count = 挂此标签的作品数（COUNT tag_videos，2026-09-21 归档流落地起真实计算）。
-- 终局语义：演员可挂标签，视频可直挂标签；视频最终标签 = 直挂(tag_videos) ∪ 演员标签。
-- 删除保护（2026-09-21 落地）：标签删除级联清 actress_tags 行，女优保留。

-- 8. studios：片商字典（logo BLOB 入库；2026-09-21 首期仅 CRUD + logo 管理）
CREATE TABLE studios (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL UNIQUE,     -- trim 后非空、≤60 字符，重复 409
  logo      BLOB,                     -- 原始字节（无图像处理能力，存原图；魔数白名单 jpg/png/webp、≤512KB）
  logo_type TEXT                      -- MIME（image/jpeg 等）；logo 为 NULL 时本列同置 NULL
);
-- **BLOB 存储决策**：片商 ≤ 几百个 × 单图 ≤512KB，总占用几十 MB 内，SQLite 无压力；
-- 随行增删零孤儿文件、备份 = 复制 media.db；磁盘文件方案（目录约定/孤儿清理/删除联动）
-- 在个人项目里纯属自找边界。列表接口不回 BLOB（条目含 has_logo），logo 经专用端点取。
-- 终局语义：视频直接挂片商（studio_videos 多对多；2026-09-21 归档流落地，表单单选写入单行）；
-- 删除保护随关联落地时定（当前仍自由删）。
-- GET 条目含 video_count / actor_count（2026-09-21 归档流落地起真实计算：
-- video_count = COUNT studio_videos；actor_count = 片商作品关联演员的去重数）。

-- 9. actresses：女优（演员体系核心；2026-09-21 落地）
CREATE TABLE actresses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,   -- 主名（trim 非空 ≤60，409；真同名加后缀区分）
  country_id     INTEGER NOT NULL,       -- → countries.id（必选：目录结构依赖国家）
  rating         INTEGER,                -- 0-100 百分制，NULL=未评分
  disk           TEXT NOT NULL,          -- 创建时选定的盘符（'d:'；创建时建目录，此后不可改）
  avatar_file_id INTEGER                 -- → raw_files.id（头像=归档的 raw 图片；悬空容忍，前端占位）
);
CREATE INDEX idx_actress_country ON actresses (country_id);

-- 10. actress_aliases：女优别名（无唯一性——同名艺名跨女优复用是事实；
-- 将来视频侧名字匹配遇重复别名需消解策略，落地时定）
CREATE TABLE actress_aliases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actress_id INTEGER NOT NULL,
  name       TEXT NOT NULL
);
CREATE INDEX idx_alias_actress ON actress_aliases (actress_id);
CREATE INDEX idx_alias_name    ON actress_aliases (name);

-- 11. actress_tags：女优-标签多对多（标签删除时级联清本表行，女优保留）
CREATE TABLE actress_tags (
  actress_id INTEGER NOT NULL,
  tag_id     INTEGER NOT NULL,
  PRIMARY KEY (actress_id, tag_id)
);
-- 创建女优时 mkdir recursive：{disk}/Archives/{dirName(国家)}/{dirName(女优)}/图集（幂等；
-- 目录段经 lib/paths dirName() 清洗 Windows 非法字符）。改名/换国家不联动磁盘目录（目录名=创建时快照）。
-- 头像：仅「原始资料页标记」通道——图片卡片设为头像 → 物理移动+改名 head.{ext} 到图集目录 →
-- raw 行跟随（archived=1，真·归档语义，归档页持续可见）；旧 head.* 保留不删。

-- 12. videos：作品（原始资料页归档流落库；2026-09-21 首期仅单片）
CREATE TABLE videos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL CHECK (kind IN ('single','series')),  -- 本次只写 'single'；剧集待后续迭代
  title          TEXT NOT NULL,        -- 标题（必填）
  subtitle       TEXT,                 -- 副标题（可选）
  code           TEXT,                 -- 番号（可选；落文件名 + 视频库卡片展示）
  rating         INTEGER,              -- 评分 0-100，NULL=未评分（与女优评分同约定；归档表单录入 + 视频库卡片评分环修改，2026-09-23）
  video_file_id  INTEGER NOT NULL,     -- → raw_files.id（归档后的视频行；悬空容忍）
  cover_file_id  INTEGER,              -- → raw_files.id（归档后的封面行；可空）
  created_at     INTEGER NOT NULL      -- 归档时间（作品列表排序）
);

-- 13-16. 四张多对多关系表（国家/片商表单单选、表多对多预留）
CREATE TABLE actress_videos (video_id INTEGER NOT NULL, actress_id INTEGER NOT NULL, PRIMARY KEY (video_id, actress_id));
CREATE TABLE tag_videos     (video_id INTEGER NOT NULL, tag_id     INTEGER NOT NULL, PRIMARY KEY (video_id, tag_id));
CREATE TABLE studio_videos  (video_id INTEGER NOT NULL, studio_id  INTEGER NOT NULL, PRIMARY KEY (video_id, studio_id));
CREATE TABLE country_videos (video_id INTEGER NOT NULL, country_id INTEGER NOT NULL, PRIMARY KEY (video_id, country_id));
-- 归档落盘：目标 = 第一个演员的目录树 {她的盘}/Archives/{她的国家}/{她}/（表单国家仅元数据，
-- 不影响落点）；文件名 stem = 清洗段空格连接：有番号「{番号} {标题} {副标题}」/ 无番号
-- 「{标题} {副标题}」（空段跳过，dirName 同款清洗）；视频与封面同 stem 各自扩展名；
-- 目标已存在同名 → 409（防误覆盖）；番号不进目录只落 code 列。
-- 视频最终标签 = tag_videos ∪ 演员标签（actress_tags）——展示层推导，表不冗余。
```

已定决策记录（账本）：

| 决策 | 结论 | 备注 |
|------|------|------|
| 一行一视频 vs 一行一次尝试 | upsert 单行，attempts 累加 | error 只保留最后一次 |
| 唯一键含 quality？ | 不含，`(site, video_id)` | quality 语义 = 最后一次下载清晰度，丢失多版本历史（已接受） |
| 全集上报（pending）？ | 不做 | 「未下载清单」覆盖范围以批次实际跑到过的为准 |
| 失败粒度 | 只记最终失败 | 中途中断不单独记 |
| skipped 入账？ | 入账 | 支撑「该站点哪些视频没下过」视角：`status NOT IN ('complete','skipped')` |

raw 已定决策记录：

| 决策 | 结论 | 备注 |
|------|------|------|
| 与已退役 media 的关系 | raw_files 为本地媒体唯一基座（2026-09-23） | files 表/scan_dirs 扫描/视频库页整体退役（见 §1）；判定链第二层由 raw_files 独扛 |
| 消失处理 | 不自动删行 | 扫描结束上报「待决策」清单（pending_missing），用户批量删除或标记；missing=1 不重报，文件重现自动归 0；后续查重只看 missing=0 |
| hash 算法 | 抽样 SHA-256 | 头/中/尾各 64KB + size；全文件读整盘小时级不可接受；查重时可再对候选对补全文件校验 |
| hash 时机 | 扫描 inline 计算 | path+size+mtime 三键未变 → 沿用旧 hash 只刷 last_seen（重扫近纯遍历） |
| 假消失防护 | 消失判定限定作用域 | 只对本次实际扫过的 (盘符, 类型) 组合判定，勾选类型变化不误伤 |
| `.ts` 歧义 | 魔数嗅探 | 首字节 0x47 且偏移 188 处 0x47 判视频，否则整文件跳过；复用 hash 头部缓冲零额外 IO |
| 扩展名清单 | video=mp4/ts/mkv/avi/mov/wmv/flv/webm/m4v/mpg/mpeg/rm/rmvb；image=jpg/jpeg/png | 清单内聚 features/raw，不动 lib/paths 的 typeOfExt |
| 启动行为 | 不自动扫 | raw 永远手动触发（可能挂冷备份盘）；上次勾选存 meta（raw_last_selection） |
| 行身份 | 单行跟随（逻辑文件） | 移动/改名不换行：UPDATE path/volume，name 永远=最初名；行仅 resolve 接口可删 |
| 移动/改名自动判定 | 同会话配对，四条件全满足 | ①恰好 1 消失行+1 新建行同 hash ②全库无第三条 missing=0 同 hash 行 ③本次扫描正常完成；命中→旧行合并（archived=1）+写归档/事件，改名+移动同发记两条事件；不满足→回退 pending 由用户定夺，宁缺毋错 |
| 跨会话追认 | 不做 | 分次扫描的移动由用户工作流兜底：待决策确认后手动删除，新位置行成为唯一记录 |
| 查重口径 | 抽样 hash 分组，仅现存行 | missing=1 与待决策（pending_missing=1）行排除（文件可能已不在盘上）；size=0 排除（hash 输入仅 size，全部 0 B 文件同指纹互聚成假组）；hash 输入含 size，同组必同大小，冗余=(n-1)×size；抽样指纹理论碰撞经生产库全量 sha256 抽检 8/8 通过，误报风险靠组内展示完整路径人工复核兜底，不做全文件校验 |
| 查重删除 | 磁盘文件 + 行同删 | 查重面板（行级/组级删多余副本）与文件卡片两入口共用；前端样式化确认弹窗二次确认（ConfirmDialog，列路径清单）；护栏=路径前缀校验；不做回收站（磁盘 unlink 直删，不可恢复） |
| 归档表粒度 | 一行一文件 | file_id UNIQUE；name=最新名；中间历代名字不单存，沿革看 raw_events.result |

### 匹配与维护语义

- **判定边界（2026-09-20 定）**：是否下载 = **该视频文件是否在本地物理存在**，与「是否从本站下载」无关——为扩展未来支持多站点下载做准备（各站点同视频名字大同小异，stem 归一化匹配覆盖同名；跨站不同名不做模糊匹配，误报代价高于漏报）。
- **判定匹配（账本优先 → raw_files，2026-09-23 起 files 层移除）**：`/api/exists` 携带完整相对路径 `rel`（`剧名/xx.mp4`）与可选 `vid`（video_id）。**第一层查 downloads 账本**：`status ∈ complete/skipped`（均为「已在本地」证据；failed/canceled/downloading 不算），`vid` 精确命中优先（site 限定 rou.video——video_id 各站命名空间独立），回退 `LOWER(filename)=rel` 相等（**不限 site**，对齐判定边界）；命中即 `exists=true`，matches 首位带账本 filename（相对路径）。**第二层查 raw_files**：`type='video'` 且现存（`missing=0 AND pending_missing=0`，与查重口径一致），stem 与最初名（`name`）或最新名（`raw_archive.name`，改名场景）相等。匹配结果返回完整 path 列表，面板 toast 展示「已存在：D:\xxx.mp4」，误报（同名不同视频）一眼可辨。
- **downloads upsert（登记）**：按 `(site, video_id)`。开始 → `downloading`（attempts+1）；终态 → `complete/failed/canceled/skipped`。
- **账本与 raw_files 不做硬外键**，靠 filename/stem 宽松关联——手动移动文件后 raw 行跟随（单行跟随语义），账本记录不失效。
- **账本命中即判已下载（已知取舍，2026-09-20 用户决策）**：downloads 有 complete/skipped 记录但文件事后被删时仍判「已下载」→ 扩展跳过下载；此时靠面板「仍然下载」逃生门（download-force）补录。换来的是文件移动改名 / 站点改名（vid 命中不受 filename 影响）场景不重复下载。

## 5. 接口设计

| 接口 | 方向 | 说明 |
|------|------|------|
| `GET /api/ping` | 扩展面板 | 心跳：`{ok, uptime, videos, covers, downloads:{status:count}, ffmpeg:{available, path}}`；videos/covers = raw_files 现存 video/image 计数；面板打开期间 30s 轮询——在线（绿）点击 = 新标签页打开管理页，离线（红）点击 = native messaging 启动服务 |
| `GET /api/log` | 管理页 | 服务日志尾部 200 行（native 启动时重定向到 server/server.log） |
| `GET /api/exists?rel=剧名/xx.mp4&vid=<videoId>` | 扩展 | 账本优先（`status∈complete/skipped`，vid 精确 → filename 相等回退不限 site，命中 matches 首位带账本 filename）→ raw_files 回退（现存视频行，stem 匹配最初名/最新名）；返回 `{exists, matches:[{path,type,size}]}`；仅 `type='video'` 计为已下载 |
| `POST /api/downloads` | 扩展 | 账本 upsert（一行一视频）：开始（downloading）/最终失败（failed+error）/取消/跳过/完成（complete，带 size/duration） |
| `GET /api/config` / `POST /api/config` | 页面 | 读取/保存 ffmpeg_path（POST 校验文件存在性，警告不阻断）；GET 附带 ffmpeg 探测状态 |
| `GET /api/downloads?status=&site=&q=` | 页面/扩展 | 账本查询（含各 status 计数）；扩展拉 `status=failed` 驱动重试 |
| `GET /` | 页面 | 管理页：原始资料/归档资料/账本/字典/设置（配置 ffmpeg、日志） |
| `GET /api/countries` | 页面 | 国家字典全量列表（`ORDER BY id` 正序，不分页） |
| `POST /api/countries` | 页面 | 新增 `{name}`：trim 非空、≤60，重复 409 |
| `PUT /api/countries/:id` | 页面 | 改名 `{name}`（同校验；404 不存在） |
| `POST /api/countries/:id/delete` | 页面 | 删除（404 不存在；无引用方，当前自由删） |
| `GET /api/tags` | 页面 | 标签字典全量列表（`ORDER BY sort ASC, id ASC`）；条目含 `video_count`/`actor_count`（预留恒 0） |
| `POST /api/tags` | 页面 | 新增 `{name}`：trim 非空、≤60，重复 409；`sort = max+1` 追加末尾 |
| `PUT /api/tags/:id` | 页面 | 改名 `{name}`（同校验；404 不存在） |
| `POST /api/tags/:id/delete` | 页面 | 删除（404 不存在；无引用方，当前自由删） |
| `POST /api/tags/reorder` | 页面 | 拖拽排序落库 `{ids:[...]}`：按给定顺序全量重编号 `sort=1..n`（事务；不存在的 id 忽略）；响应返回新列表 |
| `GET /api/studios` | 页面 | 片商全量列表（`ORDER BY id` 正序，不分页）；条目含 `has_logo`/`video_count`/`actor_count`（计数预留恒 0），**不回 logo 字节** |
| `POST /api/studios` | 页面 | 新增 `{name}`：trim 非空、≤60，重复 409 |
| `PUT /api/studios/:id` | 页面 | 改名 `{name}`（同校验；404 不存在） |
| `POST /api/studios/:id/delete` | 页面 | 删除（404 不存在；logo 随行删除；当前无引用方自由删） |
| `POST /api/studios/:id/logo` | 页面 | 设置/替换 logo：JSON `{b64}`（前端文件转 base64）或 `{url}`（服务端抓取，5s 超时，仅 http/https）；解码后魔数白名单 jpg/png/webp + ≤512KB，违规 400 报因 |
| `GET /api/studios/:id/logo` | 页面 | logo 字节直出（Content-Type = logo_type，Cache-Control max-age=300；无 logo 404） |
| `POST /api/studios/:id/logo/delete` | 页面 | 清除 logo（置 NULL；404 片商不存在） |
| `GET /api/actresses?q=` | 页面 | 女优全量列表（id 正序）：条目 join 出 country_name、aliases[]、tags[]（id/name/sort）、video_count（预留恒 0）、avatar_file_id；q 匹配主名与别名 |
| `GET /api/actresses/disks` | 页面 | 可用盘符：探测 A:–Z: 根目录存在者（创建表单磁盘单选） |
| `POST /api/actresses` | 页面 | 创建 `{name, countryId, rating?, tagIds, aliases, disk}`：name 同字典校验 409；countryId 必须存在；rating 0-100 或 null；disk `^[a-z]:$`；**mkdir recursive `{disk}/Archives/{国家}/{女优}/图集`**（幂等，目录段 dirName() 清洗） |
| `PUT /api/actresses/:id` | 页面 | 全量编辑（name/countryId/rating/tagIds/aliases，事务全量替换；disk 不可改；404）；**不联动磁盘目录** |
| `POST /api/actresses/:id/delete` | 页面 | 删除 + 级联清 aliases/actress_tags（404）；头像文件保留（归档页可见） |
| `POST /api/actresses/:id/avatar` | 页面 | 设为头像 `{fileId}`：raw 行必须 type='image'；物理移动（同盘 rename / 跨盘 copy+unlink）+ 改名 `head.{ext}` 至 `{disk}/Archives/{国家}/{女优}/图集/`；raw 行跟随新路径 archived=1 + raw_archive 登记 + raw_events 记 rename/move（真·归档）；更新 avatar_file_id；旧 head.* 保留 |
| `POST /api/videos/archive` | 页面 | 视频归档（单片）：`{fileId, coverFileId?, title, subtitle?, code?, rating?, actressIds(≥1), countryId, tagIds, studioId?, kind:'single'}`——落盘至第一个演员目录树、命名 `{番号 标题 副标题}.{ext}`（空段跳过）、冲突 409、`archiveRawFileTo` 双文件移动 + videos 及四张关系表事务写入；收尾尽力回填 `raw_files.duration/width/height`（ffmpeg 可用时 `ffmpeg -i` 一次探测，缺失/失败静默跳过，不阻断归档）；rating 0-100 或 null |
| `PUT /api/videos/:id/rating` | 页面 | 卡片评分环修改：`{rating: 0-100 \| null}`（null=清除）；404/取值域 400；响应 `{ok, item}` |
| `GET /api/works?page=&size=&q=&kind=&actressId=&tagId=&studioId=` | 页面 | 作品分页列表（title/subtitle/code LIKE，`ORDER BY created_at DESC`）；kind 区分单片/剧集（视频库页传 single，将来剧集库页传 series）；actressId/tagId/studioId 为 EXISTS 子查询筛选；条目含 rating + join 演员名/标签/片商/国家 + `video_file`（path/ext/size/duration/width/height，缝合 raw_files；正常恒有值，null 仅防御库被手工改动）。注意：路径用 /api/works——避免与 video feature 语义混淆（历史注记：GET /api/videos 曾被已退役的 media feature 占用） |
| `POST /api/shutdown` | 扩展面板 | 优雅退出：响应 200 后延迟 200ms `process.exit(0)`（等响应刷盘）；面板「重启」按钮的下半程——先 shutdown 确认离线，再经 native messaging 拉起，避免双实例撞端口 |
| `GET /api/raw/volumes` | 页面 | 原始资料盘符列表：探测 `A:`–`Z:` 根下 `RawFiles/` 目录，**只返回存在的盘**，附 statfs 总容量/剩余空间；网络盘等无盘符形态不支持 |
| `POST /api/raw/scan` | 页面 | 启动原始资料扫描 `{volumes:['d:'], types:['video','image']}`：202 即返（异步任务）；已有任务 409；请求时二次校验 RawFiles 存在性（拔盘跳过记 warning） |
| `POST /api/raw/scan/cancel` | 页面 | 协作式取消（文件/目录间查标志位；取消**不做**消失判定，已入库数据保留） |
| `GET /api/raw/scan/status` | 页面 | 任务快照 `{running, currentVolume, scanned, videos, images, probed, lastResult}`（无 SSE 环境兜底；结果保留到下次启动；lastResult 含 probedCount 探测数） |
| `GET /api/raw/scan/events` | 页面 | **SSE**：连接即推 `snapshot` → 运行中 ~500ms 推 `progress` → 结束推 `done`（含 missingCount 摘要）；15s 心跳注释行保活 |
| `GET /api/raw/files?page=&size=&q=&type=&volume=&missing=&archived=` | 页面 | 分页 + 名称搜索 + 类型/盘符筛选，`ORDER BY last_seen DESC, id DESC`；missing 取值 hide(默认)/only/all；**archived 取值 hide(默认，仅未归档——归档行在归档页有专属视图)/only(仅已归档)/all** |
| `GET /api/raw/missing` | 页面 | 待决策消失清单（pending_missing=1，全量返回） |
| `GET /api/raw/duplicates?page=&size=` | 页面 | 文件查重：按抽样 hash 聚合现存行（missing=0 且 pending_missing=0），≥2 份成组，组内文件按 path 排序，组按冗余空间（(n-1)×size）降序分页；响应附全库组数 total 与重复占用总量 wastedTotal |
| `POST /api/raw/missing/resolve` | 页面 | `{op:'delete'\|'mark'}` 批量处理全部待决策行：delete 删行；mark 置 missing=1；均清 pending_missing |
| `POST /api/raw/file/:id/delete` | 页面 | 查重清理：unlink 磁盘文件（ENOENT 视为已删）+ 删 raw_files 行；**护栏：路径前缀必须为所在盘 `{volume}/rawfiles/`**（防库外路径误删）；文件被占用等 unlink 失败 → 报错保留行；raw_archive/raw_events 悬空保留（对齐 resolveMissing） |
| `GET /api/raw/events?page=&size=&kind=&file_id=` | 页面 | 变更日志：通用列表分页（kind 筛选，倒序）；`file_id` 时返回该文件全部事件（正序，弹窗用）；条目关联 raw_files 带出当前 path/hash/volume/最初名，行已删则 file=null |
| `GET /api/raw/archived?page=&size=&q=&type=&volume=` | 页面 | 归档文件分页（`archived=1` 且 missing=0 的逻辑文件）：搜索/类型/盘符筛选；条目附最新名（raw_archive.name）与变更计数（event_count） |
| `GET /api/raw/file/:id/content` | 页面 | 图片缩略图 / 原生格式视频 Range 直连（mp4/webm/m4v/mov/mkv） |
| `GET /api/raw/file/:id/index.m3u8` + `/seg/:seg` | 页面 | 非原生格式视频 HLS 转码（复用 lib/hls-core；ffmpeg 缺失 503 → 前端禁播提示） |

安全：仅监听 127.0.0.1；校验 `Origin`/`Referer` 头，放行扩展 origin（`chrome-extension://fieogbjpjaiokpmfkokckebfaojncomm`）与自身页面，其余 403。无鉴权 token（本地个人使用，接受）。

## 6. 扫描机制

（media 目录扫描已随 files 表退役移除，2026-09-23；仅存 raw 扫描）

### 原始资料库扫描（raw）

- **范围**：所选盘符根下的 `RawFiles/` 目录递归遍历（用户自管目录，无系统目录排除清单）；跳过符号链接/junction（防循环）；无权限子目录静默跳过。
- **任务模型**：全局单任务（POST 时已有任务 → 409）；202 即返，进度经 SSE 推送（见 §5）；协作式取消——取消收尾不做消失判定。
- **单文件流程**：stat → 按扩展名分派类型（未勾选的类型直接跳过）→ 查库中行：`path+size+mtime` 三键未变 → 只刷 `last_seen`（missing/pending_missing 归 0）；否则读头 64KB（`.ts` 在同一缓冲区做魔数嗅探，不过则整文件跳过）→ 读中/尾 64KB → 抽样 SHA-256 → upsert（hash/size/mtime/last_seen 更新，missing/pending_missing 归 0；**变更行顺带清空 duration/width/height**——内容变了旧元数据即失效）。
- **视频元数据探测（2026-09-23）**：技术元数据（duration/width/height）是文件属性，归 raw 域在扫描链路记录——新建/变更的视频行 upsert 后顺带 `ffmpeg -i` 一次探测三项（`lib/hls-core` 的 `ffmpegProbeMeta`，stderr 解析 Duration + 首个 Video 流 WxH）；ffmpeg 不可用/探测失败静默留 NULL（归档流程兜底）。**存量补录**：扫描正常收尾时对本次作用域内 `duration IS NULL` 的现存视频统一探测一轮（三键未变走跳过分支的存量行由此补齐，失败留 NULL 下轮重试）。探测数计入任务状态 `probed` 与结果 `probedCount`；取消在文件间生效。配对合并时新行已探测的元数据经 COALESCE 转移给续命旧行。
- **消失判定（作用域化）**：扫描正常完成后，对本次**实际扫过且遍历成功**的每个 (扫描根, 类型) 组合：行路径在扫描根内（前缀匹配）且 `last_seen < 本次 token 且 missing=0` 的行置 `pending_missing=1`。已标 missing=1 的不重报；未扫的类型/盘符的行不受影响（勾选类型变化不产生假消失）。**根外豁免（2026-09-21）**：路径不在扫描根内的行（头像移入 Archives、手动移出 RawFiles 的策展文件）不判——扫描对它们本就无从「看见」；范围内归档行照判（配对/待决策维持原语义）。
- **移动/改名自动判定（配对合并）**：消失判定**之前**执行——本次会话累计的消失行 × 新建行按 hash 分组配对，hash 满足「恰好 1 消失 + 1 新建，且全库无第三条 missing=0 同 hash 行」时：旧行保留 id/name/first_seen，UPDATE path/volume/last_seen 并置 `archived=1`，删除本次误建的新行；`raw_archive` upsert（无行则建，改名更新 name，updated_at=token）；`raw_events` 按路径差异记 `rename`（同目录不同名）/`move`（不同目录），两者同发记两条。配对行 last_seen 已=token，自然不进 pending。取消收尾不配对（与不判消失同理）。
- **待决策**：`GET /api/raw/missing` 拉清单，`POST /api/raw/missing/resolve` 批量 delete（删行）或 mark（missing=1）；不决策下次扫描继续上报。
- **服务启动不自动扫**；页面记住上次勾选（meta.raw_last_selection）。

## 7. HLS 流播放（ffmpeg 可选增强）

### 7.1 背景与决策

扩展 remux 产出的 MP4 存在结构性时基缺陷（不写 ctts、B 帧负 PTS 差被钳 1 tick），Chrome 严格 demuxer 下表现为周期性丢帧抖动；VLC/PotPlayer 靠码流 POC 容错无感。**病在帧级合成时间轴（含 DTS 缺失）而非段级**——实测 `ffmpeg -c copy` 重整出的 TS 无 DTS、段头丢帧、PTS 锯齿，MSE 丢帧比直连更狠；故采用 **libx264 实时转码**分段（对齐 stash 默认 HLS 路线），编码器重建全新时间轴（含 DTS），播放全程经服务端转码，不动磁盘文件。

已定决策：

| 决策 | 结论 | 备注 |
|------|------|------|
| 流形态 | HLS（m3u8 + MPEG-TS 分段） | seek/缓冲由 hls.js 免费解决；fMP4 管道直出会丢 Range/seek，弃 |
| 会话状态机归属 | **`lib/hls-core.ts`（下沉共享）** | 键为任意字符串（raw 用 `raw-{id}`），入参 = 绝对路径 + 时长；raw 的 hls.ts 为薄适配层（查行/现探时长），ffmpeg 探测（ffmpegInfo/meta.ffmpeg_path）一并下沉 lib；状态机无表知识，属通用媒体服务设施而非业务 |
| 重整 vs 转码 | **libx264 转码**（veryfast/CRF 23） | copy 无法修复无 ctts 源的帧级时间轴（实测段头丢帧、无 DTS）；转码代价 = 轻微质量再损 + CPU（480p 约 1 核，可接受） |
| 切换策略 | 全部视频统一走 HLS | 单一路径可预期；`.ts` 透传文件一并救活；图片缩略图走 `/api/raw/file/:id/content` |
| remuxer 治本 | 不修 | 新文件继续带病落盘，库外 Chrome 直开仍抖（VLC/PotPlayer 无妨），已知已接受 |
| ffmpeg 定位 | 可选增强 + 自动降级 | 缺失 → HLS 端点 503 → 前端禁播/降级直连（原生格式），维持可用 |
| 分段参数 | 2s 段、gap>5 判 seek 重启、预生成上限 15 段、段等待 15s 超时、空闲 30s 清理 | 对齐 stash 实测参数 |

### 7.2 ffmpeg 探测

- 优先 `meta.ffmpeg_path`（管理页设置页可配），其次 PATH 上的 `ffmpeg`。
- 探测结果进程内缓存（避免 ping 轮询反复 spawn）；保存配置后失效重探。
- `ffmpegInfo()` 暴露 `{ available, path, source: 'config' | 'path' | null }`，供 `/api/config` 与 `/api/ping` 聚合。
- 时长兜底：manifest 需要总时长——raw 侧每次建会话 spawn `ffmpeg -i` 解析 stderr `Duration:` 行现探（`raw_files.duration` 列已存在但仅归档行回填，HLS 建会话暂维持现探，后续可切换读列省一次 spawn）。

### 7.3 清单与分段

- **清单服务端自生成**（不用 ffmpeg 写的）：段数 = `floor(duration / 2)`（宁可少承诺尾段 ≤2s，不超额承诺引发尾部段超时）；`#EXT-X-VERSION:3`、`TARGETDURATION:2`、`PLAYLIST-TYPE:VOD`、段 URL 用相对路径 `seg/{n}.ts`（对 Vite dev 代理天然友好）。
- **ffmpeg 参数**（每会话一个进程，按需起）：

  ```
  ffmpeg -hide_banner -loglevel error [-ss <n*2>] -i <file> \
    -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -sc_threshold 0 \
    -force_key_frames expr:gte(t,n_forced*2) \
    -c:a aac -b:a 128k -ac 2 \
    -sn -dn -copyts -avoid_negative_ts disabled -muxdelay 0 -muxpreload 0 \
    -f hls -start_number <n> -hls_time 2 -hls_flags split_by_time \
    -hls_segment_type mpegts -hls_playlist_type vod \
    -hls_segment_filename <dir>/.%d.ts <dir>/manifest.m3u8
  ```

  - **libx264 重建时间轴**：源 MP4 无 ctts/DTS，copy 无法修复；编码器输出全新 DTS/PTS（B 帧重排正确）。
  - `-copyts`：保持原始时间轴，seek 重启后段 PTS 与全局 2s 网格对齐，hls.js 时间线连续。
  - `force_key_frames` 每 2s 全局网格强关键帧：段起始必为关键帧（MSE 干净 append）。
  - `-muxdelay 0 -muxpreload 0`：mpegts muxer 默认初始 DTS 偏移（实测 ≈1.4s）会吃掉段头内容，必须归零。
  - 音频转 AAC：编码器输出完整 ADTS 帧，避免 copy 模式跨段切割 AAC 帧产生破音。
  - 临时段名 `.{n}.ts`（前置点）→ 下一段出现才改名为 `{n}.ts`，即「完整性确认」信号。

### 7.4 会话状态机（lib/hls-core.ts）

- 会话键 = 调用方传入的字符串（raw 用 `raw-{raw_files.id}`，键内非法路径字符统一替换 `-`），缓存根 `os.tmpdir()/rou-hls/<key>/`（服务启动时清空缓存根，残留自杀清理；同时清理旧版 `rou-media-hls` 遗留目录）；每次建会话 `ffmpeg -i` 现探时长。
- 全局 200ms monitor tick（有会话才运行）：
  1. **段确认**：从 `procSegment` 起向上扫 `.{i}.ts`，存在则将上一段改名转正（重复生成不覆盖已有段）；进程退出时按退出码决定末段转正（成功）或删除（失败，可能不完整）。
  2. **等待段派发**：文件已出现 → 回流该段（`video/mp2t`，`createReadStream` 管道）；超时 15s → 500。
  3. **按需起进程**：无进程 → 从最早等待段起；`idx < procSegment || procSegment + 5 < idx`（seek 跳变）→ 杀进程（下一 tick 待退出后再起新进程于目标段）。
  4. **回收**：无等待段且 30s 未访问 → 杀进程 + 删会话目录；`lastSegment..+15` 段全部就绪 → 杀进程（预生成封顶，保留文件与会话）。
- 同文件多播放页共享会话/进程；不同文件各自独立。

## 8. 扩展侧改动（已实施 v1.9.0；files 登记链路于 v1.14.0 移除）

1. **判定接入**：`background.js fileExists()` 先 `fetch http://127.0.0.1:17321/api/exists`（超时 ~300ms），失败/超时回退现有 `chrome.downloads.search` 逻辑；命中时 `matches` 路径带回面板 toast 展示。
2. **生命周期上报**：`main.js` 下载开始/最终失败/取消/跳过/完成各上报一次账本（fire-and-forget）。（v1.14.0 起：落盘成功后 `POST /api/files` 物理文件登记已随 files 表退役移除，站内判定全靠账本 vid 精确 + filename 匹配。）
3. **SW 中转消息**：内容脚本不能直连 127.0.0.1（MV3 内容脚本 fetch 受 CORS 约束，host_permissions 豁免仅限 SW），新增 `rv-ledger-report` / `rv-ledger-query` 经 SW 转发（`src/net/ledger.js`）。
4. **逃生门**：跳过状态面板显示「仍然下载」，`download-force` 命令绕过判定强制重下。
5. **失败重试持久化**：批次失败列表从内存态升级为本地服务账本，面板「重试历史失败」拉 `status=failed` 复用 worker 标签页机制重跑；浏览器重启后失败列表不丢。
6. **manifest**：`host_permissions` 增加 `http://127.0.0.1:17321/*`。

## 9. 已知弱点与边界

- **同名 stem 误报**（不同视频同名）：靠 matches 路径展示 + 逃生门缓解，不做匹配收紧。
- **上报窗口期**：服务未运行时下载生命周期上报丢失（fire-and-forget），账本不落行；判定回退 chrome.downloads 历史 + overwrite 自愈。
- **收藏区不参与判定（2026-09-23 已知取舍）**：raw_files 只盘点各盘 `RawFiles/`，移出 RawFiles 的策展文件（归档至 Archives 树等）随 raw 行跟随仍可匹配（stem=最初名/最新名）；但从未进过 RawFiles 的目录（若有）不在判定覆盖内。
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
5. **P5 HLS 流播放**：ffmpeg 探测与配置、m3u8/分段端点与会话状态机、管理页 hls.js 播放 + 降级链。
6. **P6 原始资料库**（本次）：前置独立 commit——hls-core 下沉重构 + 测试迁移；随后 features/raw（表/抽样 hash/扫描任务/SSE/全部接口）+ 管理页「原始资料」页（磁盘选择/进度/卡片浏览/播放/消失决策）。
7. **P7 归档与变更日志**：raw_files 加 archived（旧行迁移）、raw_archive/raw_events 两表、扫描收尾配对合并（移动/改名自动判定，四条件宁缺毋错）、`GET /api/raw/events`、前端「变更记录」区块与卡片最初名展示。
8. **P8 files 表退役（2026-09-23）**：DROP files 表 + 清 scan_dirs；删 features/media（/api/videos、POST /api/files、/api/scan、/stream/:id 全家）；/api/exists 与 /api/config 移入 features/system（exists 收敛两层：账本→raw_files；config 仅 ffmpeg_path）；ping 统计改 raw_files 口径；管理页删「视频库」页（八标签）、设置页收缩、默认 tab 改「原始资料」；扩展移除落盘登记（v1.14.0）。

## 11. 待确认项

- 无（全部决策已定稿；新决策先改本文档再动代码）。
