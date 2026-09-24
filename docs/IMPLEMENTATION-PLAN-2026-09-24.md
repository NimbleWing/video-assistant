# 2026-09-24 全项目 Review 关联实施计划

> 状态：待实施
> 关联审查：[2026-09-24 全项目架构与逻辑审查](REVIEW-2026-09-24.md)
> 计划基线：`9269204`
> 范围：扩展本体、本地媒体库服务、管理页前端及三组件契约

本文把审查档案中的问题转换为可分批实施、可独立验证、可回滚的工程计划。本文只定义实施方案，不代表相关问题已经修复。

## 1. 目标与原则

### 1.1 目标

1. 优先消除数据丢失、误判文件消失、LAN 越权和测试破坏真实数据的风险。
2. 将扩展下载链路升级为具有明确操作代次、锁、顺序和恢复能力的状态机。
3. 建立扩展、服务端和管理页之间可版本化、可诊断的契约。
4. 保持现有三组件边界，不进行无必要的整体重构。
5. 每个里程碑都可以独立提交、验证和回滚。

### 1.2 实施原则

1. **文档先行**：每次实施先更新对应组件 DESIGN，再修改代码。
2. **安全优先**：测试隔离、LAN 权限、扫描与文件一致性先于新功能。
3. **不推倒重构**：暂不引入全局状态库或完整路由框架，不重写三组件。
4. **协议先行**：跨组件消息和 API 增加版本、attemptId、operationId。
5. **最小兼容变更**：协议升级需提供明确兼容窗口或迁移说明。
6. **扩展发布纪律**：扩展功能或修复同步升 `manifest.json` 与根 `package.json` 版本，并重载扩展验证。
7. **完成定义**：对应单测、跨组件契约测试、组件 check、生成产物同步和 review 状态回写全部完成。

## 2. 待确认的架构决策

### D1：LAN 权限方案

**推荐采用双端口：**

- `0.0.0.0:17321`：只允许 GET/HEAD 和管理页静态资源。
- `127.0.0.1:17322`：管理写接口、扩展账本、配置和服务重启。
- 管理页在本机访问时写 `17322`；手机继续只读访问 `17321`。
- CORS 仅允许扩展 Origin、`127.0.0.1:17321` 和 Vite 开发 Origin。

备选方案是恢复 `127.0.0.1:17321` 单端口，或为所有写接口引入 bearer token。双端口不依赖可伪造的 `Origin` 或 `Host`，边界最清晰。

### D2：字典删除策略

**推荐策略：**

- 标签删除：级联清理关系，作品保留。
- 已被作品引用的演员、片商、国家：RESTRICT，提示先解除作品关联。
- raw 头像和视频引用继续允许悬空，符合现有容错设计。

### D3：归档事务模型

文件系统和 SQLite 无法使用同一个数据库事务，推荐引入持久化 `archive_operations` journal，以可恢复 saga 处理文件移动、数据库写入、补偿和启动恢复，不尝试构造伪跨介质事务。

## 3. 里程碑总览

| 里程碑 | Review 关联 | 主要工作 | 依赖 |
|--------|--------------|----------|------|
| M0 测试安全基线 | §4.1、§6.1 | 隔离服务端测试 | 无 |
| M1 LAN 安全边界 | §4.2、§6.3 | 双端口、只读路由、SSRF 限制 | M0 |
| M2 数据基础设施 | §5.5、§6.2、§6.4 | 版本化迁移、外键、备份、版本握手 | M0 |
| M3 扫描正确性 | §4.3 | 作用域完整性、取消、root 边界 | M0 |
| M4 归档一致性 | §4.4 | no-clobber、头像唯一命名、journal | M2 |
| M5 Remux checkpoint | §4.5 | PES/NAL/AU 跨分段状态 | 无，可与 M0～M4 并行 |
| M6 扩展保存状态机 | §4.6、§5.1、§5.2 | finalize、最终文件恢复、锁、路由代次 | M5 |
| M7 账本协议 | §5.3、§5.4 | attemptId、outbox、exists 合并 | M6 |
| M8 服务生命周期 | §5.7 | 优雅关闭、HLS 配额、单实例 | M1、M2 |
| M9 管理页一致性 | §5.6、§6.5、§6.7 | 请求竞态、评分、封面、弹窗、错误边界 | M7 |
| M10 交付治理 | §6.1、§6.6、§6.8 | `check:all`、CI、版本、拆包、文档 | 全部 |

## 4. 详细实施内容

### M0：服务端测试安全基线

**Review 关联：** §4.1、§6.1

**涉及文件：**

- `server/src/test/setup.ts`
- `server/vitest.config.ts`
- `server/src/app.test.ts`
- `server/src/lib/paths.ts`
- actress、video、raw 路由及其测试目录构造

**实施方案：**

1. 测试环境无条件使用 `:memory:`，不再接受外部 `ROU_MEDIA_DB`。
2. 每个测试 worker 创建独立 `mkdtemp()` 文件系统根目录。
3. 抽取统一的 `volumePath()`；测试环境映射到临时根，生产环境仍映射真实盘符。
4. 清理逻辑只允许操作当前测试根。
5. 增加“外部设置生产 DB 环境变量时仍使用内存库”的保护测试。
6. 将所有固定 `D:\archives\...` 路径迁入测试配置。

**验收标准：**

- 测试不创建或删除固定 D 盘目录。
- 外部 `ROU_MEDIA_DB` 指向真实文件时仍不会打开该文件。
- `server/npm run check` 可在无 D 盘环境运行。
- 测试失败时只清理本次随机目录。

### M1：LAN 双端口安全边界

**Review 关联：** §4.2、§6.3

**涉及文件：**

- `server/src/app.ts`
- `server/src/server.ts`
- `server/src/features/system/*`
- `server-web/src/lib/api.ts`
- Vite 代理配置
- `manifest.json`
- `server/DESIGN.md`
- `server-web/DESIGN.md`
- `server/FIREWALL.md`

**实施方案：**

1. 17321 只注册 GET/HEAD 与静态资源；写方法直接返回 405/403。
2. 新增仅绑定 `127.0.0.1` 的 17322 管理服务。
3. 提取统一路由注册，支持只读路由和完整路由两种模式。
4. 扩展 ledger、config、shutdown 改连 17322。
5. 管理页根据当前 hostname 选择本机管理端口。
6. 增加 CORS OPTIONS，并仅允许扩展、本机管理页和开发服 Origin。
7. Logo URL 抓取拒绝 loopback、私网、链路本地和每次重定向目标。
8. URL 抓取改为流式读取，累计超过 512KB 立即中止。

**验收标准：**

- 手机 LAN 页面可浏览、搜索和播放。
- LAN 客户端的 POST、PUT、DELETE 全部失败。
- 本机管理页、扩展账本和服务重启正常。
- SSRF、重定向和无 Content-Length 大响应测试通过。

### M2：数据库迁移与关系完整性

**Review 关联：** §5.5、§6.2、§6.4

**涉及文件：**

- `server/src/lib/db.ts`
- 新增统一 migration runner
- 各 feature 的建表与 ALTER 代码
- downloads 和关系表类型
- system ping DTO
- `server/DESIGN.md`

**实施方案：**

1. 用单调 `schema_version` 替代启动时散落 DDL。
2. 每个迁移使用独立事务，不再吞掉所有 ALTER 异常。
3. 启用 `PRAGMA foreign_keys = ON` 和合理 `busy_timeout`。
4. 破坏性迁移前通过 SQLite backup 或 `VACUUM INTO` 生成一致性快照。
5. 先执行孤儿数据审计，再重建关系表外键。
6. 归档接口在事务内验证全部演员、标签、片商和国家 ID。
7. 为 `/api/ping` 增加 `serviceVersion`、`apiVersion`、`schemaVersion` 和 `buildId`。
8. 修复 lockfile 版本与 package 版本不一致。

**验收标准：**

- 旧数据库可重复迁移，中途失败可回滚。
- `PRAGMA foreign_key_check` 无孤儿关系。
- 重复启动不再执行 DROP/ALTER 探测。
- 扩展和管理页能识别不兼容服务版本。

### M3：raw 扫描完整性

**Review 关联：** §4.3

**涉及文件：**

- `server/src/features/raw/scanner.ts`
- `server/src/features/raw/files.ts`
- `server/src/features/raw/types.ts`
- scanner 与 raw 路由测试

**实施方案：**

1. `walkRoot()` 返回 `complete/partial/canceled` 和结构化错误。
2. ENOENT 与 EACCES、IO、坏文件错误分开处理。
3. `completedScopes` 只接收完整遍历的 `(volume, root, type)`。
4. 取消标志在 `walkRoot()` 返回后立即传播。
5. 新建路径按作用域收集，partial scope 不参与移动配对。
6. `listScopeDisappeared()` 增加 root 路径条件。
7. 扫描结果增加 `partial`、错误计数和可诊断 warning。

**验收标准：**

- 末盘取消不会进入消失判定。
- 权限失败、坏文件或拔盘不会把未扫描文件误标为消失。
- 扫描根外同 hash 行不会参与当前作用域配对。
- 覆盖取消、权限拒绝、stat/hash 失败和根外同 hash 测试。

### M4：可恢复归档 saga

**Review 关联：** §4.4

**涉及文件：**

- `server/src/features/raw/files.ts`
- `server/src/features/video/routes.ts`
- `server/src/features/actress/routes.ts`
- 新增 archive operation repository 与 journal
- `server-web/src/features/Video/ArchiveDialog.tsx`
- `server/DESIGN.md`
- `server-web/DESIGN.md`

**实施方案：**

1. 客户端为每次归档生成 `operationId`，重复请求幂等。
2. 开始前验证全部源文件、目标文件和实体引用。
3. 目标创建采用排他语义，目标存在必须失败。
4. 跨盘复制先写临时文件，校验完成后再删除源文件。
5. 文件移动和 raw 行更新记录到 `archive_operations`。
6. 视频、封面、videos 和关系表全部成功后才标记 completed。
7. 中途失败执行逆序补偿；无法补偿时保留 pending operation。
8. 服务启动时恢复或回滚未完成操作。
9. 头像改为 `head-{rawFileId}.{ext}`，旧头像继续保留。
10. busy 弹窗在 operation 完成前禁止关闭。

**验收标准：**

- 目标已存在、第二文件失败、磁盘满、进程中断和重复请求均不产生半归档。
- 同扩展名头像替换不覆盖或丢失旧头像。
- 服务重启后能恢复或明确回滚未完成归档。

### M5：HLS 跨分段 checkpoint

**Review 关联：** §4.5

**涉及文件：**

- `src/hls/ts-remux.js`
- `src/net/save-session.js`
- `tests/hls/ts-remux-stream.test.js`
- `tests/net/save-session.test.js`
- `EXTENSION.md`

**实施方案：**

1. 拆分“输出已完成单元”和“finalize 强制冲刷未完成单元”。
2. 普通 checkpoint 保留 PES、ES buffer、NAL group 和 AAC carry。
3. `RemuxSnapshot` 增加 demux carry 序列化。
4. 恢复时重建 carry，不再把 segment 边界当作 PES/AU 结束边界。
5. 新增 PES、NAL、音频帧跨 2～3 段的 fixture。
6. 比较 checkpoint 输出与 one-shot remux 的字节和时间轴。

**验收标准：**

- 跨边界 fixture 与一次性 remux 结果一致。
- 任意合法位置 checkpoint/resume 不丢帧、不重置 PTS。
- 旧 sidecar 明确迁移或拒绝，不能静默损坏续传。

### M6：扩展保存状态机与并发锁

**Review 关联：** §4.6、§5.1、§5.2

**涉及文件：**

- `src/net/fswriter.js`
- `src/net/save-session.js`
- `src/offscreen.js`
- `src/net/save.js`
- `src/main.js`
- `src/page-hook.js`
- `src/net/sniffer.js`
- 对应测试
- `EXTENSION.md`

**实施方案：**

1. `moveTo()` 只保留一个调用点，并维护当前 entry 名称、显式幂等。
2. sidecar 增加 `remuxed/finalizing` 状态和最终文件名。
3. `chrome.downloads` 成功后才删除 OPFS 完成文件。
4. 下次重试优先重试 finalizing 文件，不重新下载分段。
5. offscreen 增加 per-save Promise queue。
6. abort 先设置取消标记，再等待当前写操作退出。
7. 以 canonical stem 建立全局 target lease，拒绝同目标并发。
8. 消息增加 `protocolVersion/requestId/sequence/owner`。
9. `main.js` 引入 routeId 和 operationId，每个 await 后校验操作归属。
10. 路由 key 统一为 `pathname + search`。
11. 页面权威 HLS 地址优先，嗅探只作为 hint 并绑定当前 video id。
12. 每个 segment 携带独立 key、IV 和加密方式；拒绝不支持的 KEYFORMAT。

**验收标准：**

- 真实 Chrome OPFS 下，落盘失败后再次重试不重新下载。
- 两个标签页不能并发写同一目标。
- chunk 与 abort 交错不会破坏 sidecar。
- SPA 切换后旧任务不能污染新页面。
- key 轮换 fixture 可正确解密。

### M7：账本可靠投递

**Review 关联：** §5.3、§5.4

**涉及文件：**

- `src/net/ledger.js`
- `src/background.js`
- `src/main.js`
- server ledger types、routes、repository
- server-web 账本查询

**实施方案：**

1. 每次尝试生成 `attemptId`，事件携带 `eventId` 和 `sequence`。
2. 扩展 `chrome.storage.local` 维护持久 outbox。
3. Service Worker 按 videoId 串行发送，失败后退避并重放。
4. 服务端以事件幂等和 sequence 拒绝迟到状态。
5. complete 上报真实 `result.filename` 和最终文件大小。
6. 服务 exists=true 时短路；false 或未知时继续 legacy 判定。
7. `matches` 增加 `source` 和 `pathKind`。
8. 失败重试按 site 分页，不再只取前 50 条。

**验收标准：**

- complete 先于 downloading 到达时，账本最终仍为 complete。
- 服务离线后恢复能重放事件。
- 重复事件和两个标签页同视频不会破坏 attempts 或终态。

### M8：服务优雅生命周期与 HLS 配额

**Review 关联：** §5.7

**涉及文件：**

- `server/src/server.ts`
- system shutdown 路由
- `server/src/lib/hls-core.ts`
- native host
- `server/DESIGN.md`

**实施方案：**

1. 启动先取得单实例锁，再初始化数据库和缓存。
2. 缓存清理改为 await，并为实例使用独立缓存根。
3. shutdown 进入 maintenance，停止新写和扫描。
4. 等待活动归档、HTTP 请求和 ffmpeg 进程退出。
5. 超时后才强制退出。
6. HLS 增加最大 session、ffmpeg 进程、waiter 和缓存配额。
7. 请求关闭时立即移除 waiter。
8. ffmpeg 探测缓存 Promise，失败增加退避。
9. session key 纳入文件 id、mtime 和 size。
10. native host 等待服务 ready 后才返回成功。

**验收标准：**

- 重复启动不会执行迁移或清理活动实例缓存。
- 归档或 HLS 播放中重启不会留下半完成文件或孤儿进程。
- 恶意或异常并发请求不能无限创建 ffmpeg 进程和临时文件。

### M9：管理页一致性

**Review 关联：** §5.6、§6.5、§6.7

**涉及文件：**

- `server-web/src/components/VideoPlayer/*`
- `server-web/src/features/Video/ArchiveDialog.tsx`
- `server-web/src/components/RatingInput.tsx`
- `server-web/src/components/RatingRing.tsx`
- `server-web/src/features/Video/Video.tsx`
- `server-web/src/features/Actress/*`
- `server-web/src/lib/api.ts`
- `server-web/src/main.tsx`
- `server-web/src/components/Layout/index.tsx`
- 对应测试
- `server-web/DESIGN.md`

**实施方案：**

1. API 客户端支持 AbortSignal、超时和结构化错误。
2. 页面请求统一 latest-request-wins。
3. VideoPlayer effect 依赖稳定原始字段，不依赖对象引用。
4. 评分使用本地 draft，在 pointerup 或 blur 后串行提交。
5. 为女优增加专用 rating 端点，避免全量覆盖别名和标签。
6. 新增服务端精确封面匹配端点，不再取前 50 条猜测。
7. `coverTouched` 防止迟到自动结果覆盖用户选择。
8. busy dialog 禁止 Esc、遮罩和取消按钮关闭。
9. 增加根级和页面级 Error Boundary。
10. 修复移动侧栏焦点和 VideoCard 覆盖点击。
11. 拆分 Raw 巨型组件，拆出扫描、查重、文件浏览 hooks。

**验收标准：**

- 编辑归档表单时视频不会反复重载。
- 评分连续拖动只提交一次最终值，响应乱序不会覆盖最终选择。
- 封面精确匹配不受分页和请求乱序影响。
- busy 操作无法被 UI 误认为已取消。

### M10：交付与性能治理

**Review 关联：** §6.1、§6.6、§6.8

**实施方案：**

1. 根 `check:all` 串行执行三组件检查。
2. 增加 CI 和 `server/public` 生成产物一致性检查。
3. 标签页面和重型弹窗使用 `React.lazy`。
4. hls.js、PhotoSwipe 和二维码逻辑按需加载。
5. 增加结构化滚动日志、requestId 和 attemptId。
6. README 补充 Quick Start、版本要求、备份恢复和 LAN 安全说明。
7. review 文档增加每项状态及实施提交链接。
8. 修复 package、manifest 和 lockfile 版本同步。

**验收标准：**

- 单次 `check:all` 可验证三组件。
- `server/public` 与 server-web 源码一致。
- 首屏不再同步加载所有页面和重型媒体依赖。
- 新克隆仓库后文档足以完成安装、启动、升级和恢复。

## 5. 测试与发布顺序

每个里程碑必须按以下顺序收尾：

1. 更新对应组件 DESIGN。
2. 先补失败测试，再实现代码。
3. 执行对应组件 `npm run check`。
4. 跨组件变更执行端到端场景。
5. 扩展代码变更同步升版本，并通过 Chrome DevTools MCP 重载扩展。
6. `server-web` 变更执行 build，更新 `server/public`。
7. 在 `docs/REVIEW-2026-09-24.md` 标记已修复、部分修复或接受风险。
8. 检查 Git status、diff 和最近提交后，再决定是否提交。

M0 完成前禁止执行现有服务端完整测试；M1 完成后才能开放 LAN 写操作；M4 完成后才能继续扩展归档入口；M7 完成前账本只能视为非关键统计信息。

## 6. 建议提交拆分

1. `test(server): 隔离测试数据库与文件系统根目录`
2. `feat(server): 拆分 LAN 只读端口与本机管理端口`
3. `refactor(server): 引入版本化迁移与关系完整性约束`
4. `fix(server): 修复扫描取消、局部失败与作用域边界`
5. `fix(server): 归档操作改为可恢复 saga`
6. `fix(extension): 保留跨 HLS 分段的 remux 状态`
7. `fix(extension): 重构保存收尾、目标锁与路由代次`
8. `feat(extension,server): 账本 attemptId 与可靠 outbox`
9. `fix(server): 优雅关闭并限制 HLS 资源`
10. `fix(server-web): 消除播放器、评分和封面请求竞态`
11. `chore: 建立跨组件质量门与版本握手`

## 7. 进度跟踪

| 里程碑 | 状态 | Review 处理状态 | 实施提交 |
|--------|------|-----------------|----------|
| M0 测试安全基线 | 待实施 | 待处理 | — |
| M1 LAN 安全边界 | 待确认 D1 | 待处理 | — |
| M2 数据基础设施 | 待实施 | 待处理 | — |
| M3 扫描正确性 | 待实施 | 待处理 | — |
| M4 归档一致性 | 待确认 D2/D3 | 待处理 | — |
| M5 Remux checkpoint | 待实施 | 待处理 | — |
| M6 扩展保存状态机 | 待实施 | 待处理 | — |
| M7 账本协议 | 待实施 | 待处理 | — |
| M8 服务生命周期 | 待实施 | 待处理 | — |
| M9 管理页一致性 | 待实施 | 待处理 | — |
| M10 交付治理 | 待实施 | 待处理 | — |

实施过程中应保持本表状态与 [Review 档案](REVIEW-2026-09-24.md) 同步，避免计划、代码和审查结论形成三个互相漂移的事实源。
