# 扩展文档 — 肉视频助手（Chrome MV3 扩展本体）

> 本文档维护扩展本体（`src/`、`manifest.json`）的架构与约定。跨组件全局约定见根 `AGENTS.md`；配套的本地媒体库服务见 `server/DESIGN.md`；管理页前端见 `server-web/DESIGN.md`。

## 定位

rou.video 的 Chrome MV3 扩展（由油猴脚本移植）：播放页解析 HLS（含 PNG 伪装）→ 分段流式下载（AES-128-CBC 解密）→ 流式 remux 封装 MP4（moov 置尾）→ OPFS 暂存 → chrome.downloads 落浏览器下载目录；附带连续下载（后台标签页）、清晰度选择、断点续传、长按方向键倍速/快退、画中画、复制地址、封面保存。

## 架构分层

| 层 | 文件 | 职责 |
|----|------|------|
| MAIN-world 钩子 | `src/page-hook.js` | 补丁页面 XHR/fetch 嗅探 m3u8；watch SPA 路由，经 `window.postMessage` 转发 |
| 内容脚本 | `src/content-loader.js` → `src/main.js` | 编排器，持有全部状态；侧边栏经 `rv-get-state`/`rv-state`/`rv-cmd` 遥控 |
| Service Worker | `src/background.js` | 侧边栏开关、offscreen 生命周期、downloads 中转（os-url/封面）、已下载判定（本地媒体库服务 → 下载历史回退）、本地库登记中转、批次后台标签页开/关/复用 |
| Offscreen | `src/offscreen.js` → `src/net/save-session.js` | 保存会话编排：模式判定（mp4/透传 ts）→ OPFS 流式写 `.part` → moov 置尾 → rename → objectURL 交 SW downloads |
| 侧边栏 | `src/panel/` | 纯遥控器 UI，不持有业务状态 |
| 下载核心 | `src/hls/`（playlist/downloader/ts-remux）、`src/net/`（http/save/fswriter/rou-png/ledger）、`src/features/`（boost/batch） | 纯逻辑，测试覆盖集中于此 |

## 保存链路（无自定义目录功能，已整体移除——Chrome 对扩展的 FS Access 授权过于短命，缠斗无益）

- 页面侧：分段下载+解密（保持页面 Origin/Referer，CDN 要求）→ 按序 16MB base64 分块直传 offscreen（SW 不在数据路径上，仅 begin 经 SW 确保 offscreen）。
- offscreen 侧：`ts-remux.createStreamingRemux()` 增量 demux/mux → mdat 流式写 OPFS `<stem>.part`；每段 checkpoint（快照 = 游程时长/尺寸/偏移/关键帧/**逐样本 PTS**）→ finalize 写 moov（置尾，stco 天然已知）→ 补丁 largesize → rename → objectURL → SW `chrome.downloads`（浏览器下载目录，子目录保留，`overwrite`）。非 H.264/非 TS 流自动透传存 `.ts`。
- **视频时间轴构造（v1.11.4，B 帧流正确性修复）**：TS PES 只带 PTS，样本按解码序到达；H.264 含 B 帧时解码序 PTS 出现负差，旧实现把负差钳成 1 tick 且不写 ctts → MP4 合成时间轴错乱，Chrome 直连播周期丢帧（VLC/PotPlayer 靠码流 POC 容错无感）。现 finalize/mux 检出负差（B 帧）即重构视频轨时间轴：**后向 min 构造 DTS**（`rawDts[i] = min(pts[i], rawDts[i+1] − tick)`，tick 取**呈现序**（PTS 升序）相邻差中位数——解码序正差是帧距的 k 倍、中位数会偏大 3×，实测踩过）→ 前向钳位（≥0、严格递增、≤pts）→ **stts 写 DTS 差分、ctts 写 `pts − dts` 合成偏移**（全 0 时省 box），PTS 保持原值（音画同步零改动），音频轨与无 B 帧流完全不走新逻辑（行为不变）。快照新增 `vPts` 逐样本 PTS 持久化；**旧版快照无 `vPts` 时回退旧时间轴逻辑**（断点续传跨版本降级，不中断）。
- 断点续传：`.part` + sidecar（`<stem>.part.json`：播放列表指纹 + segmentsDone + remux 快照），OPFS 内自洽；取消/失败保留半成品，重试时指纹一致即从断点续写（`.part` 大小校验防截断）。
- 已下载判定（三层链）：本地媒体库服务（判定边界=**本地物理存在**，与来源站点无关；服务端顺序：**账本优先**——`complete/skipped` 即已在本地，`vid`（video_id）精确命中不受站点改名影响、filename 相等回退不限 site；未命中查 files 磁盘扫描实况；再查 raw_files 原始资料库 stem 匹配；SW `fetch /api/exists`，300ms 超时）→ chrome.downloads 历史校验回退（basename 匹配 + 封面代理，服务未启动时兜底）→ `conflictAction:'overwrite'` 落盘自愈。已知取舍：账本命中但文件事后被删仍判已下载（逃生门补录），换来扫描滞后/文件移动改名场景不重复下载。命中时面板 toast 显示本地完整路径，跳过状态提供「仍然下载」逃生门（`download-force` 命令）。
- **播放页已下载探测（v1.12.0）**：`bootVideo` 拿到 `PageInfo` 后即用 `downloadFilename()`（与下载落盘同一目标名，单一来源防口径漂移）走上述判定链探测，结果经 `state.downloaded`（checking/exists/path）反映到页面 HUD 右上角常驻徽标（已下载=绿/未下载=灰）与面板 meta 行 chip（title 提示本地路径）。探测为 fire-and-forget，序号守卫丢弃路由切换/重解析后的过期响应；`resetForRoute` 重置；下载完成或跳过后即时置为已下载。页面信息缺失（`PageInfo=null`）不探测、不显示。
- 下载账本：生命周期（downloading/complete/failed/canceled/skipped）经 `src/net/ledger.js` → SW 中转（`rv-ledger-report`/`rv-ledger-query`，内容脚本不能直连 127.0.0.1）上报本地服务；落盘成功后 SW 自动 `POST /api/files` 登记物理文件；跨会话失败重试 = 面板「重试历史失败」拉账本 `status=failed` 复用批次 worker 标签页。
- 封面：SW data URL → chrome.downloads 直落。

## 连续下载

发起页收割 → SW 开后台标签页（`storage.session` 记 id，完成自动关闭，被关可一键恢复）跑流水线；认领制（`expectedPath`）保证用户浏览不干扰批次。「继续剩余」带 `reprime` 标记：worker 标签页已停在目标页时不重导航，改发 `batch-continue` 命令踢闲置页面续跑（内容脚本失联则强制重导航兜底）——否则停止后被中止项回队首、继续后 expectedPath 与标签页 URL 相同，页面不刷新导致批次无人推进。

**content_scripts matches 必须用通配结尾**（`/series*` 而非 `/series` 精确 + `/*`）：Chrome match pattern 的精确路径**不匹配带 query string 的 URL**（`/series?page=2` 不命中 `/series`）——连续下载翻页 URL（`?page=N`）将无内容脚本注入，`maybeContinueBatch` 不执行、批次卡死。`/v*`、`/home*`、`/search*`、`/t*`、`/series*` 通配同时覆盖无 query、带 query 与子路径三种形态。

## 开发与发布约定

- 无构建步骤：扩展本体为原生 ESM，`web_accessible_resources` 直引；不引入运行时依赖（`server-web/` 是仓库内唯一例外，不影响扩展本体）。
- JSDoc 类型注解 + 根 `tsc --noEmit` 把关；新增代码必须过 typecheck。
- 注释与 UI 文案用中文；日志经 `core/logger.js` 分模块输出。
- 提交前根目录 `npm run check`（lint + typecheck + test；覆盖率棘轮只升不降，pre-commit 钩子已配置 tools/hooks）。
- 版本号与扩展重载规则见根 `AGENTS.md` 全局约定。
