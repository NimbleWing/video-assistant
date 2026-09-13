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
| Service Worker | `src/background.js` | 侧边栏开关、offscreen 生命周期、downloads 中转（os-url/封面）、已下载判定（下载历史校验）、批次后台标签页开/关/复用 |
| Offscreen | `src/offscreen.js` → `src/net/save-session.js` | 保存会话编排：模式判定（mp4/透传 ts）→ OPFS 流式写 `.part` → moov 置尾 → rename → objectURL 交 SW downloads |
| 侧边栏 | `src/panel/` | 纯遥控器 UI，不持有业务状态 |
| 下载核心 | `src/hls/`（playlist/downloader/ts-remux）、`src/net/`（http/save/fswriter/rou-png）、`src/features/`（boost/batch） | 纯逻辑，测试覆盖集中于此 |

**保存链路（无自定义目录功能，已整体移除——Chrome 对扩展的 FS Access 授权过于短命，缠斗无益）**：
- 页面侧：分段下载+解密（保持页面 Origin/Referer，CDN 要求）→ 按序 16MB base64 分块直传 offscreen（SW 不在数据路径上，仅 begin 经 SW 确保 offscreen）。
- offscreen 侧：`ts-remux.createStreamingRemux()` 增量 demux/mux → mdat 流式写 OPFS `<stem>.part`；每段 checkpoint（快照 = 游程时长/尺寸/偏移/关键帧）→ finalize 写 moov（置尾，stco 天然已知）→ 补丁 largesize → rename → objectURL → SW `chrome.downloads`（浏览器下载目录，子目录保留，`overwrite`）。非 H.264/非 TS 流自动透传存 `.ts`。
- 断点续传：`.part` + sidecar（`<stem>.part.json`：播放列表指纹 + segmentsDone + remux 快照），OPFS 内自洽；取消/失败保留半成品，重试时指纹一致即从断点续写（`.part` 大小校验防截断）。
- 已下载判定：chrome.downloads 历史精确校验（basename 匹配 + `exists` 检查）。
- 封面：SW data URL → chrome.downloads 直落。

**连续下载**：发起页收割 → SW 开后台标签页（`storage.session` 记 id，完成自动关闭，被关可一键恢复）跑流水线；认领制（`expectedPath`）保证用户浏览不干扰批次。

## 常用命令

```bash
npm run check   # lint + typecheck + test（提交前必跑，覆盖率棘轮只升不降；pre-commit 钩子已配置 tools/hooks）
npm run coverage
```

## 编码约定

- 无构建步骤：扩展本体为原生 ESM，`web_accessible_resources` 直引；不引入运行时依赖。
- JSDoc 类型注解 + `tsc --noEmit` 把关；新增代码必须过 typecheck。
- 注释与 UI 文案用中文；日志经 `core/logger.js` 分模块输出。
- 破坏性/竞态修复要在 `CHROMEWEBSTORE.md` 版本历史之外的地方记录时，写进 git commit message。
