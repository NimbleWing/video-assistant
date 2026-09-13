# Chrome Web Store Listing — 肉视频助手 RouVideo Assistant

> Last Updated: 2026-09-13
>
> **状态：本项目现阶段仅供本地使用，不发布到商店（见 AGENTS.md）。本文档仅作历史材料保留，不再维护。**

## Store Listing

**Extension Name** [REQUIRED]
肉视频助手 RouVideo Assistant

**Short Description** [REQUIRED]
从 rou.video 播放页下载视频并保存为 MP4，支持长按方向键倍速播放、快退与画中画。

**Detailed Description** [REQUIRED]

肉视频助手帮你在 rou.video 播放页一键下载当前视频，自动合并所有分段并封装为 MP4 保存到浏览器下载目录。

主要功能：
工作区位于浏览器侧边栏：打开视频播放页后点击工具栏图标（或在页面上按 Alt+D）即可打开。侧边栏中显示当前视频的标题、时长与分段信息，点击即可开始下载，下载过程中实时显示进度、速度与剩余时间，随时可以取消。
连续下载：在剧集库、视频库、首页、搜索页等列表根页，侧边栏会自动识别当前是剧集列表还是单片列表，显示本页条目数与总页数。选择"剧集"或"单片"模式后，可按"仅本页"或"全部页"批量收割并依次自动下载——剧集会先进入汇总页逐集下载，单片则逐个进入播放页下载；某一项失败会自动跳过并继续，面板中实时显示已完成、失败与待处理数量，随时可以停止。属于同一剧集的各集会自动保存到以剧名命名的子文件夹中，便于整理。
支持复制当前视频的播放地址，方便在其他播放器中使用。
封面随视频一起保存：剧集保存一张与文件夹同名的封面图（在资源管理器中直接作为文件夹缩略图显示），单片保存与视频同名的封面图。
下载前自动检测本地是否已有同名文件：已下载过的视频会立即跳过（连续下载重跑时同样生效），不会产生重复文件，中断后重新开始任务也会自动续齐缺失的部分。
支持画中画模式，让视频悬浮在其他窗口之上。
长按方向右键可以 2×、3× 或 4× 倍速播放，松开即恢复原速；长按方向左键按相同倍速快退；轻点左右方向键仍然是前进或后退 5 秒。倍速档位可在侧边栏中切换并自动记住。

使用方法：
1. 打开 rou.video 上任意视频的播放页（/v/ 开头的页面）。
2. 点击浏览器工具栏中的扩展图标（或按 Alt+D）打开侧边栏。
3. 可在侧边栏顶部"选择目录"更改保存位置（不选则使用浏览器默认下载目录）。
4. 点击"下载视频"，等待进度完成后文件会自动保存。
5. 需要批量下载时，打开剧集库（/series）或视频库（/v）等列表页，在侧边栏选择类型与范围后点击"开始连续下载"。

隐私说明：本扩展不收集、不上传任何个人信息或浏览数据。所有解析与下载都在你的浏览器本地完成，设置项仅保存在浏览器本地存储中。扩展只在 rou.video 页面上运行。

支持与反馈：如遇到无法解析或下载失败的情况，请在项目主页提交反馈。

**Category** [REQUIRED]
Fun

**Single Purpose** [REQUIRED]
从 rou.video 播放页下载视频并提供播放增强快捷键

**Primary Language** [REQUIRED]
中文（简体）

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | icons/icon-128.png |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 2 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Screenshot 3 [RECOMMENDED] | 1280×800 or 640×400 | ⬜ Not created | |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Not created | |
| Marquee Promo Tile | 1400×560 | ⬜ Not created | |

### Screenshot Notes
- Screenshot 1: 视频播放页 + 打开的扩展侧边栏（显示标题、时长、分段数与下载按钮）。
- Screenshot 2: 下载进行中的侧边栏状态（进度百分比、速度、剩余时间）。
- Screenshot 3: 长按倍速开启状态与屏幕中央的倍速提示。

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| storage | permissions | 保存用户的倍速开关与倍速档位等偏好设置，以及连续下载任务的进度状态。 |
| sidePanel | permissions | 扩展的工作区（视频信息、下载按钮与进度、倍速设置、连续下载）展示在浏览器侧边栏中，需要此权限才能打开侧边栏。 |
| contentSettings | permissions | 连续下载会为每个视频自动保存一个文件，需要允许 rou.video 的自动多文件下载，否则 Chrome 会静默拦截后续的自动下载。 |
| downloads | permissions | 视频保存统一走浏览器下载通道，并利用其子目录能力把同一剧集的各集保存到以剧名命名的子文件夹中。 |
| offscreen | permissions | 下载完成的视频数据需要在扩展后台组装成文件再交给浏览器保存，需要一个离屏页面来完成这项工作，不显示任何界面。 |
| https://rou.video/* | host_permissions | 扩展只在 rou.video 页面上运行，需要读取播放页、列表页与剧集汇总页的视频信息才能提供下载与连续下载功能。 |
| https://*.rou.video/* | host_permissions | 兼容 rou.video 的子域名页面（如 www），保证扩展在其所有入口可用。 |
| https://*.xyz/* | host_permissions | rou.video 的视频分段托管在 .xyz 域名的 CDN 上，下载视频必须能直接请求这些分段。 |
| http://*.xyz/* | host_permissions | 同上，兼容少数仍使用 http 的 CDN 节点，避免下载失败。 |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

扩展不收集任何用户数据。视频地址解析、分段下载、封装保存全部在用户浏览器本地完成；仅有的设置项（倍速开关、倍速档位）保存在浏览器本地存储，不会离开用户设备。

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL** [REQUIRED]
（待补充：发布前需提供公开可访问的隐私政策链接，内容说明本扩展不收集、不传输任何用户数据。）

## Distribution

**Visibility**: Public
**Regions**: All regions

## Developer Info

**Publisher Name** [REQUIRED]
BExhei

**Contact Email** [REQUIRED]
（待补充）

**Support URL / Email** [RECOMMENDED]
（待补充）

**Homepage URL** [RECOMMENDED]
https://sleazyfork.org/scripts/593379（原油猴脚本页面）

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.7.1 | 2026-09-13 | 侧边栏面板标题/状态行显示当前版本号（读自 manifest，所见即安装版本） | Draft |
| 1.7.0 | 2026-09-13 | 健壮性强化：修复保存阶段 ReferenceError 致下载全败（P0）；超 1.5GB 跳过封装存 TS 防 OOM；换路由自动中止下载（不再僵尸落盘）；保存通道 ACK 校验，offscreen 死亡即时回退不再假死 20 分钟；磁盘探测超时取消，杜绝 0 字节残留误判"已存在"；连续下载改认领制（用户浏览不再被劫持、队列不被污染）；停止批次竞态修复（取消项不再误入失败列表、停止后不再跳页）；保存阶段可取消并显示落盘进度；下载入口防双击并发；remux 33 位 PTS 溢出修复；match pattern 收窄；自定义目录完成文案与错误 toast 时长修正；连续下载失败项处理 | Draft |
| 1.6.1 | 2026-09-12 | 大文件保存管线优化：SW 不在数据路径上（内容脚本与 offscreen 直传 16MB 分块），FileReader 原生 base64 | Draft |
| 1.6.0 | 2026-09-12 | 新增自定义下载目录：侧边栏选择任意文件夹，视频/封面/剧集子目录直接写入该处，已下载判断改为磁盘直查；浏览器重启后需在面板一键重新授权 | Draft |
| 1.5.1 | 2026-09-12 | 已下载判断新增磁盘探测兜底（0 字节占位 + uniquify 改名检测），下载历史被清空后依然可靠；未命中时按 overwrite 落盘自愈 | Draft |
| 1.5.0 | 2026-09-12 | 已下载检测：下载前查询下载历史（basename 精确匹配 + 文件存在校验，账本加速），已存在即秒级跳过，连续下载重跑不再产生重复文件 | Draft |
| 1.4.0 | 2026-09-12 | 封面随视频保存：剧集存为"剧名/剧名.jpg"（每集覆盖写、可作文件夹缩略图），单片存为"视频名.jpg" | Draft |
| 1.3.0 | 2026-09-12 | 剧集各集自动归入以剧名命名的子文件夹（下载目录/剧名/第N集.mp4）；保存链路改为 offscreen + chrome.downloads（支持子目录） | Draft |
| 1.2.1 | 2026-09-12 | 修复移植时 TS→MP4 封装器两处单字节笔误（hdlr 轨道类型缺第 4 字节、单位矩阵缺一个零），导致 Windows 无法读取时长等媒体属性 | Draft |
| 1.2.0 | 2026-09-12 | 新增连续下载：列表根页自动识别剧集/单片、检测条目数与分页，批量收割并依次自动下载，失败自动跳过，支持仅本页/全部页与项数上限 | Draft |
| 1.1.0 | 2026-09-12 | 由油猴脚本 1.1.0 移植为 Manifest V3 扩展；工作区改为浏览器侧边栏，功能保持一致：视频下载、长按倍速、画中画、复制地址 | Draft |

## Review Notes

### Known Issues / Limitations
- 扩展仅支持 rou.video；其他站点不会注入任何代码。
- 下载大视频时需要保持标签页打开，关闭标签页会中断下载。
- 连续下载采用"认领制"（只推进自己导航出的页面），用户手动浏览站点不会干扰批次；但同一 URL 开成两个标签页仍可能导致该项被重复下载并跳过队列项（极低频场景，不加锁）。
- 超过约 1.5GB 的视频会跳过 MP4 封装直接保存为 TS（防止标签页内存溢出崩溃），可用 VLC 等播放器正常播放。
- 站点为成人内容站点，上架分类与审核需注意内容政策。

### Rejection History
（暂无）
