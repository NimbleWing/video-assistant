# 管理页前端设计（server-web/）

> 本文档维护本地媒体库管理页前端（`server-web/`）的设计与约定。跨组件全局约定见根 `AGENTS.md`；后端服务见 `../server/DESIGN.md`。后续变更先改本文档再动代码。

## 定位

本地媒体库服务（`127.0.0.1:17321`）的管理页前端，独立 npm 包。技术栈：React 19 + TypeScript（strict）+ Tailwind CSS v4 + Vite 7 + Vitest（happy-dom + Testing Library）。功能与旧版手写 `server/public/index.html` 完全对齐：视频库/下载账本/设置三标签 + Range 流播放弹窗。

## 结构

| 文件 | 职责 |
|------|------|
| `src/App.tsx` | 组合 Layout 与三标签内容、头部统计、播放弹窗状态（视频 tab 卸载重挂即刷新，替代旧版 scan 后手动 loadVideos） |
| `src/components/Layout.tsx` | 页面骨架抽象：顶栏（标题 + 补充信息 + 移动端汉堡）+ 左侧侧边栏导航（icon + 文字，可选）+ 内容区；泛型 `K extends string` 支撑标签 key 收窄 |
| `src/api.ts` | 类型化 API 客户端（fetch 包装：`ok:false` / HTTP 错误统一抛 `Error`，带服务端 error 信息） |
| `src/types.ts` | 接口模型（字段名对齐 `server/db.js` 的列名，如 `video_id`、`updated_at`） |
| `src/format.ts` | 纯函数：`fmtSize` / `fmtDur` / `fmtTime` |
| `src/components/VideosSection.tsx` | **卡片网格**（参考 tauri-react VideoProbeCard：封面/占位 + 时长/大小/盘符角标 + hover 播放遮罩与封面缩放；无封面用 art 渐变占位）、搜索防抖 300ms、盘符/类型筛选（选中盘符消失自动回退全部）、分页 50/页 |
| `src/components/LedgerSection.tsx` | 状态 chips（全部 + failed/complete/downloading/canceled/skipped 计数，默认 failed）、分页 |
| `src/components/SettingsSection.tsx` | 扫描目录保存（POST /api/config）、立即扫描、日志尾部查看 |
| `src/components/PlayerDialog.tsx` | 原生 `<dialog>` + `closedby="any"`，`/stream/:id` 播放，关闭/换源时停流清理，复制路径 |
| `src/components/Pager.tsx` | 共享分页条 |
| `src/styles.css` | Tailwind `@theme` 主题色（沿用旧版暗色调色板）+ `@layer components`（act/badge/chip/table/dialog） |

## 视觉规范（对齐 rou.video 站点暗色主题）

从站点提取的设计令牌（`@theme`）：

| 令牌 | 值 | 用途 |
|------|----|------|
| `bg` | `#101216` | 页面底色 |
| `surface` | `#191c22` | 卡片/头部面板 |
| `raised` | `#242932` | 输入框/次级按钮/分段容器 |
| `line` | `#303640` | 描边（表格行用 55% 混合弱化） |
| `ink` / `dim` | `#f0f1f4` / `#9aa1ac` | 主文/次要文 |
| `brand` / `brand-hover` / `brand-soft` / `on-brand` | `#f07759` / `#ff8d75` / `#372420` / `#241009` | 主操作、选中态、悬停 tint、品牌色上文字 |
| `art` / `art-ink` | `#18333d` / `#58c9b4` | 视频徽标（站点青绿点缀） |
| `ok/warn/err` + `*-soft` | 亮色 + 暗底 tint | 状态徽标/chip |

模式与组件：

- **布局（app-shell，整页不滚动）**：根容器 `h-screen overflow-hidden`；sticky 毛玻璃顶栏（h-14：左侧收合按钮/汉堡 → 品牌圆点 + 标题 + 头部统计）+ 左侧侧边栏（216px、视口高度固定**不可滚动**、`surface` 底、右侧描边；导航项 icon + 文字，`rounded-lg` 8px、选中 `brand-soft` tint，底部 border-t 服务信息）+ 内容列（`flex-1 min-h-0 flex-col`）。**滚动只发生在内容区内部**：列表页 = 工具栏/分页 `shrink-0` + 列表区 `flex-1 overflow-y-auto`；设置页整卡内部滚动。**收合**（桌面端）：顶栏最左 36px「收合/展开侧边栏」图标按钮，216px→76px rail 模式，只留图标（label 隐藏、项居中、footer 隐藏、`title` 提示），宽度动画过渡，状态持久化 `localStorage('side-nav-collapsed')`。移动端侧边栏为 off-canvas 抽屉（顶栏左侧汉堡 + 遮罩点击关闭，`lg:` 起常驻）。
- **卡片**：内容一律包 `.card`（`surface` + `line` 描边 + `rounded-2xl(16px)` + `0 16px 50px #15202e0c` 投影 + `p-5`）。
- **按钮** `.act`：`raised` 圆角 9px，悬停 `brand-soft + brand-hover` 文字；`.act-primary`：`brand` 底 + `on-brand` 文字。
- **表格**：表头 `dim` 12px；行分隔线 55% 弱化，行悬停 `raised` 45% 混合；末行无底线；容器 `overflow-x-auto`。
- **徽标/chip**：暗底 tint + 亮色文字（7-8px 圆角）；chip 选中 `brand-soft + brand-hover`。
- **输入**：`raised` 底透明边，聚焦描边 `brand`；空态用虚线框（`border-dashed`）。
- 字体栈含 `Noto Sans TC / PingFang TC / Microsoft JhengHei`。
- **视频卡片网格**：`grid grid-cols-2 md:3 xl:4 gap-4`；卡片 = 封面区（`aspect-video`、`object-cover`、hover `scale-105`；角标毛玻璃 `bg-black/65`：左上 ext 徽标、右上时长 `font-mono`、左下大小、右下盘符）+ 信息区（stem `line-clamp-2`、path 单行截断带 `title`、mtime 日期）。视频 hover 出品牌色圆形播放按钮遮罩，点击整卡触发 `onPlay`；封面条目无遮罩不可点。封面走 `/stream/{cover_id}`（服务端 stem 同名/目录名关联），无封面渲染 art 渐变 + 胶片图标占位。

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
