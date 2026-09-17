# 管理页前端设计（server-web/）

> 本文档维护本地媒体库管理页前端（`server-web/`）的设计与约定。跨组件全局约定见根 `AGENTS.md`；后端服务见 `../server/DESIGN.md`。后续变更先改本文档再动代码。

## 定位

本地媒体库服务（`127.0.0.1:17321`）的管理页前端，独立 npm 包。技术栈：React 19 + TypeScript（strict）+ Tailwind CSS v4 + Vite 7 + Vitest（happy-dom + Testing Library）。功能与旧版手写 `server/public/index.html` 完全对齐：视频库/下载账本/设置三标签 + Range 流播放弹窗。

## 结构

| 文件 | 职责 |
|------|------|
| `src/App.tsx` | 三标签编排、头部统计、播放弹窗状态（视频 tab 卸载重挂即刷新，替代旧版 scan 后手动 loadVideos） |
| `src/api.ts` | 类型化 API 客户端（fetch 包装：`ok:false` / HTTP 错误统一抛 `Error`，带服务端 error 信息） |
| `src/types.ts` | 接口模型（字段名对齐 `server/db.js` 的列名，如 `video_id`、`updated_at`） |
| `src/format.ts` | 纯函数：`fmtSize` / `fmtDur` / `fmtTime` |
| `src/components/VideosSection.tsx` | 搜索防抖 300ms、盘符/类型筛选（选中盘符消失自动回退全部）、分页 50/页、播放入口 |
| `src/components/LedgerSection.tsx` | 状态 chips（全部 + failed/complete/downloading/canceled/skipped 计数，默认 failed）、分页 |
| `src/components/SettingsSection.tsx` | 扫描目录保存（POST /api/config）、立即扫描、日志尾部查看 |
| `src/components/PlayerDialog.tsx` | 原生 `<dialog>` + `closedby="any"`，`/stream/:id` 播放，关闭/换源时停流清理，复制路径 |
| `src/components/Pager.tsx` | 共享分页条 |
| `src/styles.css` | Tailwind `@theme` 主题色（沿用旧版暗色调色板）+ `@layer components`（act/badge/chip/table/dialog） |

## 构建与开发

- `npm run build` = `tsc --noEmit && vite build`，产物直出 `../server/public`（`emptyOutDir` 清旧版；**文件名不带哈希**，diff 稳定），随仓库提交——服务侧保持零依赖、`start.bat` 开箱即用，代价是构建产物入库。
- `npm run dev`：Vite 开发服（热更），`/api`、`/stream` 代理到 `127.0.0.1:17321`；服务端写操作 Origin 白名单已含 dev origin（`localhost:5173` / `127.0.0.1:5173`）。
- `npm run check` = typecheck + test + build，改动后必跑；**根目录 check 不覆盖本目录**（根 tsconfig/eslint 已排除）。

## 测试策略

- Vitest + happy-dom + Testing Library，`globals: true` + `src/test/setup.ts`（`IS_REACT_ACT_ENVIRONMENT`）。
- 组件测试统一 `vi.mock('../api')`；纯逻辑（format/api）直接测。
- 已知坑：RTL `getByText` 默认只匹配元素的**直接文本节点**——混合内容（如 `<b>剧名</b> / 标题`）需 span 包裹或用 `selector` / `textContent` 断言。
- 覆盖：格式化边界、API 错误路径与参数拼接、三 Section 交互（筛选/分页/防抖/chips/保存/扫描/日志）。

## 约定

- TypeScript strict，无 eslint（typecheck + 测试把关）；注释与 UI 文案中文。
- UI 行为保持与旧版一致：防抖 300ms、PAGE_SIZE 50、账本默认 status=failed、扫描结果摘要格式等。
- 依赖改动只在 `server-web/package.json` 内，不影响扩展本体与根工具链。
