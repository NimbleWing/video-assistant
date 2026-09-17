# AGENTS.md — 肉视频助手 RouVideo Assistant

## 项目定位

rou.video 的 Chrome MV3 扩展（由油猴脚本移植）：播放页解析 HLS（含 PNG 伪装）→ 分段流式下载（AES-128-CBC 解密）→ 流式 remux 封装 MP4（moov 置尾）→ OPFS 暂存 → chrome.downloads 落浏览器下载目录；附带连续下载（后台标签页）、清晰度选择、断点续传、长按方向键倍速/快退、画中画、复制地址、封面保存。

## 重要约定

**本项目现阶段仅供本地使用，不发布到 Chrome Web Store。**
所有优化与功能工作均不考虑上架/审核相关事项（权限收窄、隐私政策 URL、截图、分类、内容政策等一律不管）。`CHROMEWEBSTORE.md` 仅保留为历史材料，不再维护。

## 架构速览

| 层 | 文件 | 职责 |
|----|------|------|
| MAIN-world 钩子 | `src/page-hook.js` | 补丁页面 XHR/fetch 嗅探 m3u8；watch SPA 路由，经 `window.postMessage` 转发 |
| 内容脚本 | `src/content-loader.js` → `src/main.js` | 编排器，持有全部状态；侧边栏经 `rv-get-state`/`rv-state`/`rv-cmd` 遥控 |
| Service Worker | `src/background.js` | 侧边栏开关、offscreen 生命周期、downloads 中转（os-url/封面）、已下载判定（本地媒体库服务 → 下载历史回退）、本地库登记中转、批次后台标签页开/关/复用 |
| Offscreen | `src/offscreen.js` → `src/net/save-session.js` | 保存会话编排：模式判定（mp4/透传 ts）→ OPFS 流式写 `.part` → moov 置尾 → rename → objectURL 交 SW downloads |
| 侧边栏 | `src/panel/` | 纯遥控器 UI，不持有业务状态 |
| 下载核心 | `src/hls/`（playlist/downloader/ts-remux）、`src/net/`（http/save/fswriter/rou-png/ledger）、`src/features/`（boost/batch） | 纯逻辑，测试覆盖集中于此 |
| 本地媒体库 | `server/`（server.js/db.js/scanner.js/public/） | Node 22+ 零依赖服务（`node:sqlite`，需 `--experimental-sqlite`），`127.0.0.1:17321`：磁盘扫描入 SQLite（files/downloads/meta 三表）、去重判定 `/api/exists`、下载账本 `/api/downloads`、落盘登记 `/api/files`、Range 流播放、管理页；设计文档 `server/DESIGN.md` |

**保存链路（无自定义目录功能，已整体移除——Chrome 对扩展的 FS Access 授权过于短命，缠斗无益）**：
- 页面侧：分段下载+解密（保持页面 Origin/Referer，CDN 要求）→ 按序 16MB base64 分块直传 offscreen（SW 不在数据路径上，仅 begin 经 SW 确保 offscreen）。
- offscreen 侧：`ts-remux.createStreamingRemux()` 增量 demux/mux → mdat 流式写 OPFS `<stem>.part`；每段 checkpoint（快照 = 游程时长/尺寸/偏移/关键帧）→ finalize 写 moov（置尾，stco 天然已知）→ 补丁 largesize → rename → objectURL → SW `chrome.downloads`（浏览器下载目录，子目录保留，`overwrite`）。非 H.264/非 TS 流自动透传存 `.ts`。
- 断点续传：`.part` + sidecar（`<stem>.part.json`：播放列表指纹 + segmentsDone + remux 快照），OPFS 内自洽；取消/失败保留半成品，重试时指纹一致即从断点续写（`.part` 大小校验防截断）。
- 已下载判定（三层链）：本地媒体库服务（磁盘实况，权威；SW `fetch /api/exists`，300ms 超时）→ chrome.downloads 历史校验回退（basename 匹配 + 封面代理，服务未启动时兜底）→ `conflictAction:'overwrite'` 落盘自愈。命中时面板 toast 显示本地完整路径，跳过状态提供「仍然下载」逃生门（`download-force` 命令）。
- 下载账本：生命周期（downloading/complete/failed/canceled/skipped）经 `src/net/ledger.js` → SW 中转（`rv-ledger-report`/`rv-ledger-query`，内容脚本不能直连 127.0.0.1）上报本地服务；落盘成功后 SW 自动 `POST /api/files` 登记物理文件；跨会话失败重试 = 面板「重试历史失败」拉账本 `status=failed` 复用批次 worker 标签页。
- 封面：SW data URL → chrome.downloads 直落。

**连续下载**：发起页收割 → SW 开后台标签页（`storage.session` 记 id，完成自动关闭，被关可一键恢复）跑流水线；认领制（`expectedPath`）保证用户浏览不干扰批次。

## 常用命令

```bash
npm run check   # lint + typecheck + test（提交前必跑，覆盖率棘轮只升不降；pre-commit 钩子已配置 tools/hooks）
npm run coverage
```

本地媒体库服务：双击 `server/start.bat`（手动启动，不注册自启；不启动时扩展自动回退下载历史判定，仅影响判定精度）。

## 编码约定

- 无构建步骤：扩展本体为原生 ESM，`web_accessible_resources` 直引；不引入运行时依赖。
- JSDoc 类型注解 + `tsc --noEmit` 把关；新增代码必须过 typecheck。
- 注释与 UI 文案用中文；日志经 `core/logger.js` 分模块输出。
- **每次功能/修复变更必须同步升版本号**：`manifest.json` 与 `package.json` 保持一致（补丁 1.8.0→1.8.1，新功能升次版本 1.9.0）；面板版本号读自 manifest，无需另改。
- **版本号/代码变更后必须经 chrome-devtools MCP 重载扩展**：`reload_extension`（扩展 id 用 `list_extensions` 查询，本机当前为 `fieogbjpjaiokpmfkokckebfaojncomm`；若重载失败先确认 id），确保浏览器内运行的是最新代码。
- **每次功能/结构性变更必须同步变更文档**：架构/约定变化更新 `AGENTS.md`（本地媒体库另见 `server/DESIGN.md`，实施细节变化先改设计文档再动代码）。
- **每次实施完成并通过 `npm run check` 校验后，必须询问用户是否提交**，未经确认不 commit。
- 破坏性/竞态修复要在 `CHROMEWEBSTORE.md` 版本历史之外的地方记录时，写进 git commit message。
