# 本地媒体库服务设计（server/）

> 状态：设计定稿，未实施。本文档是讨论结论的固化，实施前如有变更先改此处。

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
┌─────────────┐  GET /stream/:id（Range 流播放）     │  · 磁盘扫描        │
│ 浏览器页面    │ ────────────────────────────────▶ │  · 管理页（同源）   │
└─────────────┘                                     └──────────────────┘
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

- **零 npm 依赖**：Node 22+ 内置 `node:sqlite` + `node:http`，单目录脚本。
- 监听 `127.0.0.1:17321`。
- **启动方式**（二选一）：
  - 手动：`server/start.bat`
  - 面板一键：离线指示灯点击 → `chrome.runtime.sendNativeMessage('com.rouvideo.media', {cmd:'start'})` → native host（`native-host.js`，经 `native-host.cmd` 包装）以 detached 方式 spawn server.js 后即退出，服务独立存活；面板轮询 ping 确认上线。需先运行 `server/install-native.bat` 注册（HKCU 注册表 + host manifest，`allowed_origins` 锁扩展 ID；卸载用 `uninstall-native.bat`）。依赖 node 在 PATH。
- 数据库文件 `server/media.db`，脚本目录下。

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
-- scan_dirs（JSON 数组）、每目录 mtime 游标、页面偏好
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
- **files upsert（扫描）**：按 path 唯一。文件在 → 更新 `size/mtime/last_seen`，**不触碰 `video_id/source`**（保护登记数据）；文件消失 → 删行（判定自然回到未下载，正是期望行为）。全量重扫幂等。
- **downloads upsert（登记）**：按 `(site, video_id)`。开始 → `downloading`（attempts+1）；终态 → `complete/failed/canceled/skipped`。
- **两表不做硬外键**，靠 filename/stem 宽松关联——手动移动文件后 files.path 变，任务记录不失效。
- **去重判定只查 files**：downloads 有 complete 记录但文件已被删时，仍应判「未下载」。

## 5. 接口设计

| 接口 | 方向 | 说明 |
|------|------|------|
| `GET /api/ping` | 扩展面板 | 心跳：`{ok, uptime, videos, covers, downloads:{status:count}}`；面板打开期间 30s 轮询，显示在线/离线与库存数 |
| `GET /api/exists?rel=剧名/xx.mp4` | 扩展 | 路径后缀优先、stem 回退；返回 `{exists, matches:[{path,type,size}]}`；仅 `type='video'` 计为已下载 |
| `POST /api/downloads` | 扩展 | 账本 upsert（一行一视频）：开始（downloading）/最终失败（failed+error）/取消/跳过/完成（complete，带 size/duration） |
| `POST /api/files` | 扩展 | 落盘成功后登记物理文件（`{absPath, size}`，封面与视频统一经此入库，`source='recorded'`）；与账本分离、无竞态 |
| `POST /api/scan` | 页面/手动 | 触发扫描（幂等） |
| `GET /api/config` / `POST /api/config` | 页面 | 读取/保存 scan_dirs（POST 校验目录存在性，警告不阻断） |
| `GET /api/videos?page=&size=&q=&volume=&type=` | 页面 | 分页 + 搜索 + 盘符/类型筛选，附盘符统计 |
| `GET /api/downloads?status=&site=&q=` | 页面/扩展 | 账本查询（含各 status 计数）；扩展拉 `status=failed` 驱动重试 |
| `GET /stream/:id` | 页面 | files.id 的 Range 流式播放（`<video>` 直接用） |
| `GET /` | 页面 | 管理页：配置、视频分页浏览、播放、账本 |

安全：仅监听 127.0.0.1；校验 `Origin`/`Referer` 头，放行扩展 origin（`chrome-extension://fieogbjpjaiokpmfkokckebfaojncomm`）与自身页面，其余 403。无鉴权 token（本地个人使用，接受）。

## 6. 扫描机制

- **范围**：`meta.scan_dirs` 配置的目录列表（页面可改，默认引导用户配置而非全盘乱扫，系统盘排除靠不配置）。
- **首次**：全量遍历，收集 `mp4/ts` → `type='video'`，`jpg/png/webp` → `type='cover'`。
- **之后**：每目录 mtime 游标增量扫描；启动时自动增量一次 + 页面手动触发（定时任务暂不做，留配置项余地）。
- 增量与全量同一 upsert 路径，幂等。

## 7. 扩展侧改动（已实施 v1.9.0）

1. **判定接入**：`background.js fileExists()` 先 `fetch http://127.0.0.1:17321/api/exists`（超时 ~300ms），失败/超时回退现有 `chrome.downloads.search` 逻辑；命中时 `matches` 路径带回面板 toast 展示。
2. **生命周期上报**：`main.js` 下载开始/最终失败/取消/跳过各上报一次（fire-and-forget）；`background.js downloadToDisk` 成功后（取 `DownloadItem.filename` 绝对路径）`POST /api/files` 登记物理文件（视频与封面统一）。
3. **SW 中转消息**：内容脚本不能直连 127.0.0.1（MV3 内容脚本 fetch 受 CORS 约束，host_permissions 豁免仅限 SW），新增 `rv-ledger-report` / `rv-ledger-query` 经 SW 转发（`src/net/ledger.js`）。
4. **逃生门**：跳过状态面板显示「仍然下载」，`download-force` 命令绕过判定强制重下。
5. **失败重试持久化**：批次失败列表从内存态升级为本地服务账本，面板「重试历史失败」拉 `status=failed` 复用 worker 标签页机制重跑；浏览器重启后失败列表不丢。
6. **manifest**：`host_permissions` 增加 `http://127.0.0.1:17321/*`。

## 8. 已知弱点与边界

- **同名 stem 误报**（不同视频同名）：靠 matches 路径展示 + 逃生门缓解，不做匹配收紧。
- **登记窗口期**：服务未运行时下载成功不落账，靠下次扫描补齐；判定侧有 downloads 回退层，无实质影响。
- **服务需手动启动**：不启动仅降级为现有行为，不影响功能。
- **「未下载清单」语义**：仅覆盖批次实际跑到过的视频（未做全集上报）。

## 9. 实施阶段

1. **P1 服务本体**：建表、扫描（全量+增量）、`/api/exists`、`/api/scan`、start.bat。
2. **P2 管理页**：配置、视频分页浏览、播放（Range 流）、账本页。
3. **P3 扩展接入**：判定接入 + 回退、生命周期上报、manifest 权限。
4. **P4 增强**：逃生门、失败重试持久化拉取。

## 10. 待确认项

- 无（全部决策已定稿；新决策先改本文档再动代码）。
