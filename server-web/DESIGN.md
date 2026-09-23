# 管理页前端设计（server-web/）

> 本文档维护本地媒体库管理页前端（`server-web/`）的设计与约定。跨组件全局约定见根 `AGENTS.md`；后端服务见 `../server/DESIGN.md`。后续变更先改本文档再动代码。

## 定位

本地媒体库服务（`127.0.0.1:17321`）的管理页前端，独立 npm 包。技术栈：React 19 + TypeScript（strict）+ Tailwind CSS v4 + Vite 7 + Vitest（happy-dom + Testing Library）。功能与旧版手写 `server/public/index.html` 对齐并持续演进：原始资料/归档资料/视频库/下载账本/国家/标签/片商/女优/设置九标签 + Range 流播放弹窗。「视频库」旧页曾随 files 表退役移除（2026-09-23），同日基于作品域（videos 表，kind=single）重建；将来剧集库页（kind=series）独立成 `features/Series`。

## 结构

目录组织参考 `D:\NimbleWing\tauri-react\src`：**components**（通用组件，目录化 `index.tsx` 入口）、**features**（页面功能域，每页一目录 + `index.ts` 桶导出 + 页面专属子组件）、**lib**（API 客户端与接口模型）、**utils**（纯函数）。别名 `@/` 指向 `src/`（tsconfig paths + vite resolve.alias，源码/测试统一用 `@/...` 导入）。参考项目中的 router/store/locales/hooks/constants 因本包规模小（无路由、无全局状态、无 i18n、无跨页 hooks、常量均页面内聚）暂不引入，规模增长时再按参考结构补。

| 文件 | 职责 |
|------|------|
| `src/App.tsx` | 组合 Layout 与九页面（原始资料/归档资料/视频库/下载账本/国家/标签/片商/女优/设置；**默认 tab = 原始资料**）、头部统计、播放弹窗状态 + 图片查看器状态（tab 卸载重挂即刷新）；tab 配置（key/label/icon）定义于此 |
| `src/components/Layout/index.tsx` | 页面骨架抽象：顶栏（标题 + 补充信息 + 移动端汉堡）+ 左侧侧边栏导航（icon + 文字，可选）+ 内容区；泛型 `K extends string` 支撑标签 key 收窄 |
| `src/components/Pager/index.tsx` | 共享分页条：上一页/下一页 + 页码（可选跳页输入框：回车/失焦提交、钳位 1..pages）+ 右侧可选「每页 N 条」选择器 |
| `src/components/VideoPlayer/index.tsx` | **通用视频播放内核**：`PlaySource` `{path, direct, hls?, preferDirect?}`——默认 hls.js 主路径 + 降级链（见下）；`preferDirect` 时直连优先、`<video>` error 事件回退 hls；换源/卸载停流清理。PlayerDialog 与 ArchiveDialog 左播放区共用 |
| `src/components/PlayerDialog/index.tsx` | 共享播放弹窗：原生 `<dialog>` + `closedby="any"` 弹层壳 + VideoPlayer 内核，复制路径；`PlaySource` 自此 re-export；由 App 持有状态全局挂载（tab 切换不卸载）；Raw/Archive/Video 页消费 |
| `src/components/ImageViewer/index.tsx` | **通用图片查看器**（PhotoSwipe 封装，不渲染自身 DOM）：滚轮缩放（`wheelToZoom`）/拖拽平移/双击两级缩放/左右切图/Esc·下滑关闭；服务端图片尺寸未知——拦截 `contentLoad` 懒测量 naturalWidth/Height，回填 data/content/slide 宽高 + `calculateSize()` 重建缩放参数后 `content.load(isLazy, true)` 放行；**两处针对 5.4.4 异步尺寸的补偿**：回填后 `zoomAndPanToInitial()` + `applyCurrentZoomPan()` 重设居中（否则核心按 0×0 定位、图片钉在左上角），`loadComplete` 时显式 `content.append()`（否则 appendHeavy 先于 element 创建被消耗、切到的幻灯片空白）；`onClose` 经 ref 取最新避免内联回调重启实例；由 App 持有 `viewing` 状态全局挂载，Raw/Archive 页经 `onView(items, index)` 消费（gallery=当前页全部图片） |
| `src/components/ConfirmDialog/index.tsx` | 共享确认弹窗：原生 `<dialog>` + `closedby="any"`（Esc/遮罩点击即取消），挂载式受控（父组件条件渲染，onConfirm 后卸载即关闭）；`danger` 红系确认按钮（`.act-danger`）；Raw 页查重删除使用 |
| `src/components/TrashButton.tsx` | 删除图标按钮（卡片行/查重文件行等共用，Raw/Tag/Studio 消费） |
| `src/components/RatingInput.tsx` | 评分行（女优/作品共用）：slider 0-max（`max` prop 默认 100；作品加分配额场景传 100−基础分）+ 「未评分」展示 + 清除按钮；ActressDialog/ArchiveDialog 表单与 RatingRing 改分弹层消费 |
| `src/components/GlowCard.tsx` | 赛博风卡片外壳（VideoCard/ActressCard 共用）：gray-900 底 + cyan→purple→pink 双层渐变外发光（hover 浮现） |
| `src/components/MediaFallback.tsx` | 媒体占位（VideoCard 封面/ActressCard 头像三态的后两态共用）：无图 = 中性渐变 + cyan 图标；无法访问 = err 色调；`className` 控比例（aspect-video / aspect-square） |
| `src/components/RatingRing.tsx` | 评分渐变圆环（VideoCard/ActressCard 共用）：76+ 青绿 / 51+ 黄橙 / 其余红粉；未评分 = hover 浮现虚线环；点击开 RatingInput 改分弹层（score=展示分，value/max 透传 RatingInput） |
| `src/components/MetaSection.tsx` | 分区信息件（VideoCard/ActressCard 共用）：`ChipSection` = 图标 + 等宽大写标签头 + 渐变 chips（cyan=人物 / pink=标签，divided 加分隔线）；`MetaLine` = 图标 + 彩色大写标签 + 同行文本（purple=STUDIO / green=CODE / amber=COUNTRY） |
| `src/features/Raw/index.ts` | 桶导出：`Raw` |
| `src/features/Raw/RawCard.tsx` | 原始资料卡片（Raw 页独享）：标题=当前名（path basename）；archived=1 时副行「最初：xx」；图片条目头图 = `/api/raw/file/:id/content`（点击查看大图）+ 「设为头像」入口；视频条目 = 类型图标 + ext 大字占位 + hover 播放遮罩 + 「归档」入口；删除图标按钮（删磁盘文件 + 库记录）；missing 灰化 + 角标 |
| `src/features/Raw/Raw.tsx` | **原始资料页面**（顶部扫描面板 + 下方卡片浏览）：磁盘卡片多选（`/api/raw/volumes`，容量条）+ 类型勾选（视频/图片，记忆自 meta）+ 开始扫描/进度条/取消（EventSource 订阅 `/api/raw/scan/events`：snapshot/progress/done；进度行显示已处理计数 + 已探测元数据数——扫描收尾的存量补录阶段 scanned 不再增长、仅 probed 递增，2026-09-23）；待决策消失横幅（done 的 missingCount → 拉清单 + 批量删除/标记）；查重面板（工具栏「查重」按钮开合，`/api/raw/duplicates` 分组分页：组头类型徽标/份数/单份大小/冗余空间/hash 短码 + 文件行路径/盘符/日期、视频可播；**删除**：行级 🗑 与组级「删除多余副本」（保留组内第一个），`ConfirmDialog` 二次确认（列路径清单，超 10 条截断）后逐个 `POST /api/raw/file/:id/delete`，完成后刷新查重与文件列表；扫描 done 后随 refreshKey 自动刷新）；文件卡片分页浏览（搜索防抖 + 类型/盘符/missing/归档筛选——归档默认仅未归档，归档行在归档页有专属视图；卡片删除入口 → 同一 ConfirmDialog/删除链路，失败汇总页面级横幅；**图片卡片「设为头像」入口**（`RawCard onAvatar`）→ `AvatarPicker` 选女优 → `POST /api/actresses/:id/avatar`，成功 toast + 刷新） |
| `src/features/Archive/index.ts` | 桶导出：`Archive`、`EventsDialog` |
| `src/features/Archive/ArchiveCard.tsx` | 归档资料卡片（Archive 页独享，行类型 `ArchivedItem`）：标题=当前名 + 副行「最初：xx」；图片点击查看大图；视频 = 图标卡 + hover 播放遮罩；「变更记录 →」入口；无删除/设头像/归档操作；missing 灰化 + 角标 |
| `src/features/Archive/Archive.tsx` | **归档资料页面**：archived=1 逻辑文件的卡片分页浏览（`/api/raw/archived`：搜索防抖 + 类型/盘符筛选 + 每页条数/跳页）；卡片「变更记录」入口弹出 `EventsDialog`（该文件全部事件，时间正序） |
| `src/features/Archive/EventsDialog.tsx` | 单文件变更记录弹窗：当前名 + 最初名 + 事件时间线（kind 徽标 + result + 时间），`fetchRawEvents({ fileId })` |
| `src/features/Ledger/index.ts` | 桶导出：`Ledger` |
| `src/features/Ledger/Ledger.tsx` | 下载账本页面：状态 chips（全部 + failed/complete/downloading/canceled/skipped 计数，默认 failed）、分页 |
| `src/features/Country/index.ts` | 桶导出：`Country` |
| `src/features/Country/Country.tsx` | **国家页面**（字典 CRUD，演员体系基石）：全量列表（id 正序、不分页）+ 顶部添加行（输入框回车/按钮，重名 409 → toast）+ 行内改名（编辑态输入框，Enter 提交 / Esc 取消）+ 删除（ConfirmDialog 二次确认）；将来被演员引用后的删除保护随演员页落地 |
| `src/features/Tag/index.ts` | 桶导出：`Tag` |
| `src/features/Tag/Tag.tsx` | **标签页面**（字典 CRUD + 拖拽排序）：卡片式管理——卡片含拖拽把手 `⠿`（mousedown 激活 draggable，防误触）、名字（**点击即进入改名编辑**）、`视频 N · 演员 N`（预留恒 0，关联表落地后真实计算）；改名/删除为 **hover 右上角浮现的小图标**（✎/🗑，TrashButton 同款弱化风格，平时零视觉占位，删除走 ConfirmDialog）；**网格（默认）/行视图**切换（`localStorage` 记忆，同侧边栏收合惯例；行视图保留表格操作列文字按钮）；HTML5 原生 DnD 双视图可用：把手拖动、插入位反馈（网格缘指示条/行高亮）、松手乐观重排 + 立即 `reorder`（失败 toast + 重拉回滚）；顶部添加行、行内改名 Enter/Esc |
| `src/features/Studio/index.ts` | 桶导出：`Studio` |
| `src/features/Studio/Studio.tsx` | **片商页面**（字典 CRUD + logo 管理，仅网格视图）：卡片 = logo 展示区（`/api/studios/:id/logo?v=` contain 适配固定高度；无 logo 渲染名字首字占位）+ 名字（点击改名）+ `视频 N · 演员 N`（预留恒 0，actor_count = 片商视频关联演员去重数）；hover 操作区 `🖼 logo / ✎ 改名 / 🗑 删除`（同标签页视觉语言）；LogoDialog（原生 `<dialog>`）：上传文件（FileReader→base64，带预览）/ 粘贴 URL（带预览）二选一提交、已有 logo 附「清除」；设置成功后 `?v=` 版本号 bust 缓存；顶部添加行、行内改名 Enter/Esc、ConfirmDialog 删除（注明 logo 一并删除） |
| `src/features/Actress/index.ts` | 桶导出：`Actress` |
| `src/features/Actress/Actress.tsx` | **女优页面**（演员体系核心，仅网格视图）：卡片 = ActressCard；评分环改分复用全量编辑接口（其余字段原样回传，仅 rating 变化）；顶部搜索（防抖 300ms，q 匹配主名+别名）+ 添加按钮 |
| `src/features/Actress/ActressCard.tsx` | 女优卡片（2026-09-24 起与 VideoCard 同源赛博结构，共用 GlowCard/MediaFallback/RatingRing/ChipSection/MetaLine）：aspect-square 头像区三态（图 hover 缩放 / 「无头像」/ onError「头像无法访问」）+ hover 中央编辑/删除圆钮（删除走 ConfirmDialog）；评分渐变圆环（绝对分 0-100，点击改分）+ 渐变名字（点击开编辑弹窗）+ 别名斜体副标题 + COUNTRY 分区 + TAGS 区（divided）+ 底行 `视频 N` × 磁盘 |
| `src/features/Actress/ActressDialog.tsx` | 创建/编辑共用表单弹窗（原生 `<dialog>`）：名字、国家下拉（fetchCountries，空字典提示先建国家）、评分 slider（0-100 + 「未评分」清除）、标签多选 chips（按 sort 序）、磁盘单选（`/api/actresses/disks`）、别名动态列表（+ 添加 / ✕ 删除）；创建提交后服务端 mkdir `Archives/国家/女优/图集`；编辑时磁盘不可改 |
| `src/features/Actress/AvatarPicker.tsx` | 设为头像弹窗（原生 `<dialog>`）：搜索 + 女优列表选择 → `POST /api/actresses/:id/avatar {fileId}`（原始资料页图片卡片发起） |
| `src/features/Video/index.ts` | 桶导出：`Video`、`ArchiveDialog` |
| `src/features/Video/Video.tsx` | **视频库页面**（作品域 kind=single）：`/api/works?kind=single` 卡片分页浏览（搜索防抖 + 演员/标签/片商下拉筛选，字典全量拉取 + 每页条数/跳页）；**播放探活**——卡片点击先 HEAD `/api/raw/file/:id/content`，失败 → 页面级 err 横幅「文件无法访问或已丢失」（行状态过期：Archives 树不受扫描覆盖，手动删/移文件后库不知情），成功 → App 级 PlayerDialog（ext 原生格式 preferDirect，否则 hls）；封面看大图走 App 层 ImageViewer（onView 单条目）；评分修改 `PUT /api/videos/:id/rating` 后就地替换条目（不重拉列表） |
| `src/features/Video/VideoCard.tsx` | 视频库卡片（Video 页独享）：**tauri-react VideoProbeCard 视觉复刻**（2026-09-23；2026-09-24 结构件抽出与 ActressCard 共用 GlowCard/MediaFallback/RatingRing/ChipSection/MetaLine）——赛博外发光 + 封面 hover 缩放与毛玻璃 contain 放大预览（装饰图 `alt="" aria-hidden`）；**封面三态**保留——`cover_file_id=null` 中性「无封面」占位 / 图片正常（点击 onView 看大图）/ onError err 色调「封面无法访问」（useState 记 broken）；角标 = 右上时长 + 左下分辨率分档（4K/1080p/720p/WxH，源 `raw_files.duration/width/height`，无值隐藏）；中央 hover 播放钮 → onPlay 探活链路；**评分渐变圆环**（展示分 = min(100, base_rating + rating)，点击开 RatingInput 改分弹层——slider 上限 100−base_rating 的加分配额）；信息区 = 渐变标题 + 副标题 + Size 行 + PERFORMERS chips / STUDIO / CODE / COUNTRY 分区 + TAGS 区 + 底行分辨率 × 时长；图标用 lucide-react |
| `src/features/Video/ArchiveDialog.tsx` | **视频归档弹窗**（原始资料页视频卡片发起，单片流程；剧集切换仅占位禁用确认）：左播放区（VideoPlayer 内核：原生格式 preferDirect 直连 `/api/raw/file/:id/content`，ts/avi 等走 hls.js 主路径）+ 右表单——标题* /副标题/番号/**加分**（RatingInput slider，可选；加分制：基础分 = 所选演员最高评分（未评分按 0），滑块上限 100−基础分，演员选择变化时超出即收拢；下方实时展示「最终评分 = min(100, 基础分+加分)」）、演员多选（搜索+chips，**第一位演员决定归档目录**，变化即重置国家与标签）、国家单选（自动填充可改）、标签多选（自动填并集可改）、片商单选、封面区（**同名图片自动匹配**：同 stem 同目录优先→全库 path 升序；可清空、可搜索替换）→ `POST /api/videos/archive`；成功 toast + 刷新原始资料页 |
| `src/features/Settings/index.ts` | 桶导出：`Settings` |
| `src/features/Settings/Settings.tsx` | 设置页面：ffmpeg 路径配置与状态显示（POST /api/config）、日志尾部查看（扫描目录/立即扫描已随 files 表退役移除） |
| `src/lib/api.ts` | 类型化 API 客户端（fetch 包装：`ok:false` / HTTP 错误统一抛 `Error`，带服务端 error 信息；raw 系列 + SSE 由组件直连 EventSource） |
| `src/lib/types.ts` | 接口模型（字段名对齐 server 各 feature types.ts，相对路径 re-export） |
| `src/utils/format.ts` | 纯函数：`fmtSize` / `fmtDur` / `fmtTime` / `fmtDate` |
| `src/utils/media.ts` | `NATIVE_VIDEO_EXTS`（浏览器可原生解码的视频扩展名集合，各页播放/归档共用） |
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
- **卡片网格**：`grid grid-cols-2 md:3 xl:4 gap-4`（Raw/Archive 页卡片）。

## 播放链路（hls.js + 降级链）

VideoPlayer（PlayerDialog/ArchiveDialog 共用内核）双源入参 `{path, direct, hls?, preferDirect?}`：Raw 页视频卡片——原生格式（mp4/webm/m4v/mov/mkv）传 `preferDirect`（直连 `/api/raw/file/:id/content`，省转码 CPU，`<video>` error 回退 hls），其余格式（ts/avi/wmv/flv/rm/rmvb/mpg）走 hls（`/api/raw/file/:id/index.m3u8`，服务端转码兜底；不支持的组合前端禁播提示）。

- **主路径**：`Hls.isSupported()` → `hls.js` 加载 m3u8（服务端 ffmpeg libx264 实时转码分段，设计见 `../server/DESIGN.md` §7）。remux 产出的 MP4 容器时基有缺陷（无 ctts/DTS，Chrome 直连播会抖动，copy 重整也救不了），转码重建时间轴后播放健康。
- **降级链**（逐级回退，保证任何环境可播）：
  1. hls.js fatal 网络错误且 manifest 未加载成功（典型：服务端 ffmpeg 缺失返回 503）→ 销毁 hls 实例，回退 `video.src = direct` 直连（画质=现状抖动水平）；
  2. `Hls.isSupported()` 为假（老 Safari 等）→ `canPlayType('application/vnd.apple.mpegurl')` 原生 HLS；
  3. 都不支持 → 直连 direct。
- `preferDirect` 时链反转：直连优先；`<video>` 触发 `error` 事件（编解码不支持，如带 HEVC 的 mkv）→ 切 hls 源重试。
- 换源/关闭清理：`hls.destroy()` + `video.pause()/load()`；图片缩略图不走 HLS，固定 Range 直连。

## 构建与开发

- `npm run build` = `tsc --noEmit && vite build`，产物直出 `../server/public`（`emptyOutDir` 清旧版；**文件名不带哈希**，diff 稳定），随仓库提交——服务侧保持零依赖、`start.bat` 开箱即用，代价是构建产物入库。
- `npm run dev`：Vite 开发服（热更），`/api` 代理到 `127.0.0.1:17321`；服务端写操作 Origin 白名单已含 dev origin（`localhost:5173` / `127.0.0.1:5173`）。
- `npm run check` = typecheck + test + build，改动后必跑；**根目录 check 不覆盖本目录**（根 tsconfig/eslint 已排除）。

## 测试策略

- Vitest + happy-dom + Testing Library，`globals: true` + `src/test/setup.ts`（`IS_REACT_ACT_ENVIRONMENT`）。
- 组件测试统一 `vi.mock('@/lib/api')`（别名经 vite resolve.alias 解析，与源码导入同一模块）；纯逻辑（format/api）直接测。
- 已知坑：RTL `getByText` 默认只匹配元素的**直接文本节点**——混合内容（如 `<b>剧名</b> / 标题`）需 span 包裹或用 `selector` / `textContent` 断言。
- 覆盖：格式化边界、API 错误路径与参数拼接、各 Section 交互（筛选/分页/防抖/chips/保存/日志）、PlayerDialog 的 hls 建链与降级（`vi.mock('hls.js')`）、ConfirmDialog 确认/取消回调、Raw 页（磁盘卡渲染/勾选与启动参数、EventSource mock 驱动进度与 done 后的消失横幅、卡片类型分派与筛选、查重面板分组/分页/删除确认与部分失败展示）。
- 运行时依赖：react / react-dom / **hls.js**（视频播放）/ **photoswipe**（图片查看器，手势与缩放交互不做自实现，测试桩掉模块级行为只验封装层）。

## 约定

- TypeScript strict，无 eslint（typecheck + 测试把关）；注释与 UI 文案中文。
- UI 行为保持稳定：防抖 300ms、PAGE_SIZE 50、账本默认 status=failed 等。
- 依赖改动只在 `server-web/package.json` 内，不影响扩展本体与根工具链。
