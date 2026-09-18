# AGENTS.md — 肉视频助手 RouVideo Assistant

## 项目定位

仓库由三个组件构成：

1. **扩展本体**（`src/`、`manifest.json`）：rou.video 播放页 HLS 解析 → 流式下载/解密 → remux MP4 → OPFS 暂存 → chrome.downloads 落盘；侧边栏面板、连续下载批次、断点续传等。
2. **本地媒体库服务**（`server/`）：Node 22+ 零依赖服务（`node:sqlite`，需 `--experimental-sqlite`），`127.0.0.1:17321`——磁盘扫描入 SQLite、去重判定、下载账本、Range 流播放、静态服务管理页产物。
3. **管理页前端**（`server-web/`）：React + TypeScript + Tailwind CSS + Vite + Vitest 独立 npm 包，构建产物直出 `server/public`。

## 重要约定

**本项目现阶段仅供本地使用，不发布到 Chrome Web Store。**
所有优化与功能工作均不考虑上架/审核相关事项（权限收窄、隐私政策 URL、截图、分类、内容政策等一律不管）。`CHROMEWEBSTORE.md` 仅保留为历史材料，不再维护。

## 文档地图（三组件各自维护独立文档）

| 组件 | 文档 | 内容 |
|------|------|------|
| 扩展本体 | `EXTENSION.md` | 架构分层、保存链路、连续下载、开发约定 |
| 本地媒体库服务 | `server/DESIGN.md` | 数据库/接口/扫描设计、启动方式、扩展侧集成 |
| 管理页前端 | `server-web/DESIGN.md` | 结构、构建/开发流程、测试策略、约定 |

本文件只保留跨组件全局约定与命令速查；组件内架构/实施细节变更**先改对应文档再动代码**。

## 常用命令

```bash
# 根目录（扩展本体）
npm run check   # lint + typecheck + test（提交前必跑，覆盖率棘轮只升不降；pre-commit 钩子已配置 tools/hooks）
npm run coverage

# 本地媒体库服务（server/ 内执行；TS + Node ≥22.18 原生 type stripping，独立 npm 包）
npm run check   # typecheck + vitest（运行时零依赖，npm install 仅开发期需要）

# 管理页前端（server-web/ 内执行）
npm run check   # typecheck + test + build（改动后必跑，产物直出 ../server/public 并随仓库提交）
npm run dev     # Vite 开发服（热更，/api、/stream 代理到 127.0.0.1:17321）
```

本地媒体库服务启动：双击 `server/start.bat`，或面板心跳指示灯一键操作（在线点击 = 新标签页打开管理页，离线点击 = native messaging 拉起服务），详见 `server/DESIGN.md` §3。服务未启动时扩展自动回退下载历史判定，仅影响判定精度。

## 全局编码约定

- **终端命令必须带超时**：执行任何 shell 命令都要设置 timeout（按预期时长给值），超时无反馈即中止退出并向用户回报；禁止无超时阻塞等待，避免会话挂起。常驻/交互式进程（dev server、守护进程等）不得前台等待——用 detached 方式启动后轮询验证。
- 扩展本体与服务端 JS 用 JSDoc 类型注解 + 根 `tsc --noEmit` 把关；`server-web/` 用 TypeScript strict。新增代码必须过对应 typecheck。
- 注释与 UI 文案用中文。
- **扩展本体的功能/修复变更必须同步升版本号**：`manifest.json` 与根 `package.json` 保持一致（补丁 1.8.0→1.8.1，新功能升次版本 1.9.0）；面板版本号读自 manifest，无需另改。server / server-web 单独变更不动扩展版本号。
- **扩展版本号/代码变更后必须经 chrome-devtools MCP 重载扩展**：`reload_extension`（扩展 id 用 `list_extensions` 查询，本机当前为 `fieogbjpjaiokpmfkokckebfaojncomm`；若重载失败先确认 id），确保浏览器内运行的是最新代码。
- **每次功能/结构性变更必须同步变更对应组件文档**（见文档地图；实施细节变化先改文档再动代码）。
- **每次实施完成并通过 check 校验后，必须询问用户是否提交**，未经确认不 commit。
- 破坏性/竞态修复要在 `CHROMEWEBSTORE.md` 版本历史之外的地方记录时，写进 git commit message。
