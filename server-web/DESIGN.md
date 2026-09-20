# 管理页前端设计（server-web/）

> 本文档维护本地媒体库管理页前端（`server-web/`）的设计与约定。跨组件全局约定见根 `AGENTS.md`；后端服务见 `../server/DESIGN.md`。后续变更先改本文档再动代码。

## 定位

本地媒体库服务（`127.0.0.1:17321`）的管理页前端，独立 npm 包。技术栈：React 19 + TypeScript（strict）+ Tailwind CSS v4 + Vite 7 + Vitest（happy-dom + Testing Library）。功能与旧版手写 `server/public/index.html` 完全对齐并持续演进：视频库/原始资料/归档资料/下载账本/国家/设置六标签 + Range 流播放弹窗。

## 结构

目录组织参考 `D:\NimbleWing\tauri-react\src`：**components**（通用组件，目录化 `index.tsx` 入口）、**features**（页面功能域，每页一目录 + `index.ts` 桶导出 + 页面专属子组件）、**lib**（API 客户端与接口模型）、**utils**（纯函数）。别名 `@/` 指向 `src/`（tsconfig paths + vite resolve.alias，源码/测试统一用 `@/...` 导入）。参考项目中的 router/store/locales/hooks/constants 因本包规模小（无路由、无全局状态、无 i18n、无跨页 hooks、常量均页面内聚）暂不引入，规模增长时再按参考结构补。

| 文件 | 职责 |
|------|------|
| `src/App.tsx` | 组合 Layout 与六页面（视频库/原始资料/归档资料/下载账本/国家/设置）、头部统计、播放弹窗状态（视频 tab 卸载重挂即刷新，替代旧版 scan 后手动 loadVideos）；tab 配置（key/label/icon）定义于此 |
| `src/components/Layout/index.tsx` | 页面骨架抽象：顶栏（标题 + 补充信息 + 移动端汉堡）+ 左侧侧边栏导航（icon + 文字，可选）+ 内容区；泛型 `K extends string` 支撑标签 key 收窄 |
| `src/components/Pager/index.tsx` | 共享分页条：上一页/下一页 + 页码（可选跳页输入框：回车/失焦提交、钳位 1..pages）+ 右侧可选「每页 N 条」选择器 |
| `src/components/PlayerDialog/index.tsx` | 共享播放弹窗（自 Videos 泛化）：原生 `<dialog>` + `closedby="any"`，双源 `{direct, hls, preferDirect}`——默认 hls.js 主路径 + 降级链（见下）；`preferDirect` 时直连优先、`<video>` error 事件回退 hls；关闭/换源时停流清理，复制路径；由 App 持有状态全局挂载（tab 切换不卸载） |
| `src/components/ConfirmDialog/index.tsx` | 共享确认弹窗：原生 `<dialog>` + `closedby="any"`（Esc/遮罩点击即取消），挂载式受控（父组件条件渲染，onConfirm 后卸载即关闭）；`danger` 红系确认按钮（`.act-danger`）；Raw 页查重删除使用 |
| `src/components/RawCard/index.tsx` | 原始资料卡片（Raw/Archive 两页共享）：标题=当前名（path basename）；archived=1 时副行「最初：xx」；可选 `onHistory` 时信息区渲染「变更记录」入口（归档页用）；可选 `onDelete` 时元信息行尾渲染删除图标按钮（原始资料页用：删磁盘文件 + 库记录）；导出共用 `TrashButton`；图片条目头图 = `/api/raw/file/:id/content`；视频条目 = 类型图标 + ext 大字占位；hover 播放遮罩仅视频；missing 灰化 + 角标 |
| `src/features/Videos/index.ts` | 桶导出：`Videos`、`VideoCard` |
| `src/features/Videos/Videos.tsx` | **视频库页面**：搜索防抖 300ms、盘符/类型筛选（选中盘符消失自动回退全部）、分页可调每页条数（20/50/100）与跳页 |
| `src/features/Videos/VideoCard.tsx` | 单卡（参考 tauri-react VideoProbeCard：封面/占位 + 时长/大小/盘符角标 + hover 播放遮罩与封面缩放 + 信息区；无封面用 art 渐变占位） |
| `src/features/Raw/index.ts` | 桶导出：`Raw` |
| `src/features/Raw/Raw.tsx` | **原始资料页面**（顶部扫描面板 + 下方卡片浏览）：磁盘卡片多选（`/api/raw/volumes`，容量条）+ 类型勾选（视频/图片，记忆自 meta）+ 开始扫描/进度条/取消（EventSource 订阅 `/api/raw/scan/events`：snapshot/progress/done）；待决策消失横幅（done 的 missingCount → 拉清单 + 批量删除/标记）；查重面板（工具栏「查重」按钮开合，`/api/raw/duplicates` 分组分页：组头类型徽标/份数/单份大小/冗余空间/hash 短码 + 文件行路径/盘符/日期、视频可播；**删除**：行级 🗑 与组级「删除多余副本」（保留组内第一个），`ConfirmDialog` 二次确认（列路径清单，超 10 条截断）后逐个 `POST /api/raw/file/:id/delete`，完成后刷新查重与文件列表；扫描 done 后随 refreshKey 自动刷新）；文件卡片分页浏览（搜索防抖 + 类型/盘符/missing 筛选；卡片删除入口 → 同一 ConfirmDialog/删除链路，失败汇总页面级横幅） |
| `src/features/Archive/index.ts` | 桶导出：`Archive`、`EventsDialog` |
| `src/features/Archive/Archive.tsx` | **归档资料页面**：archived=1 逻辑文件的卡片分页浏览（`/api/raw/archived`：搜索防抖 + 类型/盘符筛选 + 每页条数/跳页）；卡片「变更记录」入口弹出 `EventsDialog`（该文件全部事件，时间正序） |
| `src/features/Archive/EventsDialog.tsx` | 单文件变更记录弹窗：当前名 + 最初名 + 事件时间线（kind 徽标 + result + 时间），`fetchRawEvents({ fileId })` |
| `src/features/Ledger/index.ts` | 桶导出：`Ledger` |
| `src/features/Ledger/Ledger.tsx` | 下载账本页面：状态 chips（全部 + failed/complete/downloading/canceled/skipped 计数，默认 failed）、分页 |
| `src/features/Country/index.ts` | 桶导出：`Country` |
| `src/features/Country/Country.tsx` | **国家页面**（字典 CRUD，演员体系基石）：全量列表（id 正序、不分页）+ 顶部添加行（输入框回车/按钮，重名 409 → toast）+ 行内改名（编辑态输入框，Enter 提交 / Esc 取消）+ 删除（ConfirmDialog 二次确认）；将来被演员引用后的删除保护随演员页落地 |
| `src/features/Settings/index.ts` | 桶导出：`Settings` |
| `src/features/Settings/Settings.tsx` | 设置页面：扫描目录保存、ffmpeg 路径配置与状态显示（POST /api/config）、立即扫描、日志尾部查看 |
| `src/lib/api.ts` | 类型化 API 客户端（fetch 包装：`ok:false` / HTTP 错误统一抛 `Error`，带服务端 error 信息；raw 系列 + SSE 由组件直连 EventSource） |
| `src/lib/types.ts` | 接口模型（字段名对齐 server 各 feature types.ts，相对路径 re-export） |
| `src/utils/format.ts` | 纯函数：`fmtSize` / `fmtDur` / `fmtTime` / `fmtDate` |
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

## 播放链路（hls.js + 降级链）

PlayerDialog 双源入参 `{path, direct, hls?, preferDirect?}`：Videos 页传 `/stream/:id`（direct）+ `/stream/:id/index.m3u8`（hls）；Raw 页视频卡片——原生格式（mp4/webm/m4v/mov/mkv）传 `preferDirect`（直连 `/api/raw/file/:id/content`，省转码 CPU，`<video>` error 回退 hls），其余格式（ts/avi/wmv/flv/rm/rmvb/mpg）走 hls（`/api/raw/file/:id/index.m3u8`，服务端转码兜底；不支持的组合前端禁播提示）。

- **主路径**：`Hls.isSupported()` → `hls.js` 加载 m3u8（服务端 ffmpeg libx264 实时转码分段，设计见 `../server/DESIGN.md` §7）。remux 产出的 MP4 容器时基有缺陷（无 ctts/DTS，Chrome 直连播会抖动，copy 重整也救不了），转码重建时间轴后播放健康。
- **降级链**（逐级回退，保证任何环境可播）：
  1. hls.js fatal 网络错误且 manifest 未加载成功（典型：服务端 ffmpeg 缺失返回 503）→ 销毁 hls 实例，回退 `video.src = direct` 直连（画质=现状抖动水平）；
  2. `Hls.isSupported()` 为假（老 Safari 等）→ `canPlayType('application/vnd.apple.mpegurl')` 原生 HLS；
  3. 都不支持 → 直连 direct。
- `preferDirect` 时链反转：直连优先；`<video>` 触发 `error` 事件（编解码不支持，如带 HEVC 的 mkv）→ 切 hls 源重试。
- 换源/关闭清理：`hls.destroy()` + `video.pause()/load()`；封面/缩略图不走 HLS，固定 Range 直连。

## 构建与开发

- `npm run build` = `tsc --noEmit && vite build`，产物直出 `../server/public`（`emptyOutDir` 清旧版；**文件名不带哈希**，diff 稳定），随仓库提交——服务侧保持零依赖、`start.bat` 开箱即用，代价是构建产物入库。
- `npm run dev`：Vite 开发服（热更），`/api`、`/stream` 代理到 `127.0.0.1:17321`；服务端写操作 Origin 白名单已含 dev origin（`localhost:5173` / `127.0.0.1:5173`）。
- `npm run check` = typecheck + test + build，改动后必跑；**根目录 check 不覆盖本目录**（根 tsconfig/eslint 已排除）。

## 测试策略

- Vitest + happy-dom + Testing Library，`globals: true` + `src/test/setup.ts`（`IS_REACT_ACT_ENVIRONMENT`）。
- 组件测试统一 `vi.mock('@/lib/api')`（别名经 vite resolve.alias 解析，与源码导入同一模块）；纯逻辑（format/api）直接测。
- 已知坑：RTL `getByText` 默认只匹配元素的**直接文本节点**——混合内容（如 `<b>剧名</b> / 标题`）需 span 包裹或用 `selector` / `textContent` 断言。
- 覆盖：格式化边界、API 错误路径与参数拼接、各 Section 交互（筛选/分页/防抖/chips/保存/扫描/日志）、PlayerDialog 的 hls 建链与降级（`vi.mock('hls.js')`）、ConfirmDialog 确认/取消回调、Raw 页（磁盘卡渲染/勾选与启动参数、EventSource mock 驱动进度与 done 后的消失横幅、卡片类型分派与筛选、查重面板分组/分页/删除确认与部分失败展示）。
- 运行时依赖：react / react-dom / **hls.js**（播放链路唯一第三方运行时依赖）。

## 约定

- TypeScript strict，无 eslint（typecheck + 测试把关）；注释与 UI 文案中文。
- UI 行为保持与旧版一致：防抖 300ms、PAGE_SIZE 50、账本默认 status=failed、扫描结果摘要格式等。
- 依赖改动只在 `server-web/package.json` 内，不影响扩展本体与根工具链。
