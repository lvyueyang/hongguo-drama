# 5.0 破坏性重构 · 状态与交接

分支：`dev`　版本：`5.0.0`（源码候选）　计划：`docs/refactor-plan.md`

> **当前快照（2026-10-30）**：媒体层已重写并接通；旧检查 **78 → 27 项**（其中 **8 项**阻塞 `main.js` 删除，
> 19 项依赖旧渲染层）；本轮已修 **28 个真实缺陷**（清单见文末，带 ✅/⏳ 状态）；
> 六道门 + E2E + smoke 全绿（Vitest 136 文件 / 1298 用例）。
> 下一步：按文末「未完成（按优先级）」第 1 条的 8 项逐项补功能，补一批删一批检查。

## 质量门（每次改动都要全绿；2026-10-30 实测）

| 命令 | 当前结果 |
|---|---|
| `pnpm lint`（Biome） | **0 error** / 821 warning（迁移期 `noExplicitAny` 等，见下方「类型收紧」） |
| `pnpm typecheck`（`tsc -b`） | **0 error**（含 `packages/sdk` 的 `strictNullChecks`） |
| `pnpm test`（Vitest） | **136 文件 / 1298 通过 + 0 expected-fail + 3 跳过**（expected-fail 已清零：3 条钉住的缺陷全部修好；跳过的是需要本机 ffmpeg 的真实素材用例） |
| `pnpm e2e`（Playwright `_electron`） | **9 passed** |
| `pnpm legacy:test`（旧回归网） | **22 项平台检查通过**（旧单测只剩 `src/native/episode-panel.test.cjs` 1 个不计入；另有若干旧检查被 `scripts/test.cjs` 跳过） |
| `pnpm --filter @hongguo/desktop build` | main / preload / renderer + `out/workers/decrypt-worker.js`（1.3 MB）打包成功 |
| smoke（真实启动打包产物） | 存活 12 秒、0 异常行、SIGTERM 后退出码 0 |

## 先读这段：上一版交接里的「全绿」是假的

上一版这个文件写「六道门 + E2E 全绿」。重新 `git clone` 后实测：

- `pnpm typecheck` → 21 个 `Cannot find module './services/media/*'`；
- 7 个测试文件无法导入，`pnpm build` 直接失败。

根因：`.gitignore` 里一条**裸 `media/`**（本意是 Windows 构建记录的根目录）连带忽略了
`packages/sdk/src/services/media/**`，于是整个媒体层（下载 / 解密 / 合并 / 转码 / HLS / 流会话 /
播放缓存 / 预取 / 质量判定 / 本地工具）**从来没进过版本库**；远端 `origin/dev`、`git fsck`
悬空对象、全盘搜索都没有副本，无法恢复。

本轮按 4.5 的成熟实现（`main.js` + `src/native/*`）重写了这 11 个模块并补齐 **140 条 Vitest**；
`.gitignore` 已改为 `/media/`。**教训：文档里的「已绿」必须能被一次 `git clone` 复现。**

## 一句话结论

**5.0 已可独立运行并且功能对等**：9 个页面、媒体链（下载/解密/合并/转码/HLS）、播放器
（续播/连播/快捷键/弹幕/预取/悬浮小窗/画质增强）、代理、存储、公告、更新、文字导出全部接通，
六道质量门 + E2E + smoke 全绿；媒体层本轮重写后重新接通并带等价用例。

**尚未删除 4.5 旧代码**：`scripts/` 下只剩 **27 项**旧检查（原 78 项），其中 **8 项**仍要 `vm` 加载 `main.js`、**24 项**依赖 `src/`。
剩下的这 27 项都卡在真实缺陷/功能缺口上（见文末「迁移后暴露的缺陷清单」），不是缺测试技巧。迁移方式是「抽模块 → 补等价用例 → 删旧检查」，
**不带等价覆盖不删**——这条纪律每轮都在挖出真实缺陷；本轮 8 组并行迁移挖出 **40 个**，已开始按清单修（见文末清单的「状态」列）。

## 本轮（媒体层重写）发现并修掉的真实缺陷

| 缺陷 | 后果 | 处置 |
|---|---|---|
| `downloadEpisode` 从 `playInfo.vid` 推断分集编号 | 河马/西饭的取源结果**没有 `vid` 字段**，下载时 vid 是空串：自定义源的「来源是否仍启用」校验被跳过，重试也拿不到正确 vid | 请求体显式带 `vid` / `seriesId`，宿主侧传任务字段 |
| 主进程权限策略一律拒绝 | 播放器「切换全屏」（`requestFullscreen()`）与剪贴板读写**静默失效**；4.5 对可信主 frame 是放行的 | `decidePermission(permission, { trusted })` 恢复白名单（fullscreen / clipboard-read / clipboard-sanitized-write），并补 `setPermissionCheckHandler`（请求与检查两条路径同一套策略） |
| 下载队列同一集可重复入队 | 两条同 id 任务并发写同一个文件，第二条因「目标已存在」失败；`pause/remove/get` 只找得到第一条 | 入队去重：同集同清晰度跳过，同集不同清晰度整批拒绝（保持原任务清晰度） |
| 解密 worker 被构建顺序抹掉 | `build-worker.mjs` 先产出 `out/main/workers/*`，随后 `electron-vite build` 清空 `out/main` → 打包产物里**没有解密线程**，App 片源（spade_a）下载/播放必失败 | worker 改产出到 `out/workers/`（不在 electron-vite 清理范围内），并把构建顺序改为 `electron-vite build && build-worker` |
| `pipeToFile` 把断流错误原样外抛 | `pipeline` 报 `ERR_STREAM_PREMATURE_CLOSE`/`aborted`，队列认不出这是可重试的传输失败 | 收敛成 `MEDIA_TRANSFER_ERROR`（「视频下载不完整，请重试」），保留 `cause` |
| 打包后仍会去 PATH / 工作目录找 ffmpeg | 4.5 明确禁止（会执行用户目录里的同名程序）；重构后 `electron-host` 无条件探测 `cwd/build/ffmpeg` | 把路径发现抽成 `@hongguo/host` 的纯函数 `resolveToolPath`：**打包后只认随包二进制**，PATH 兜底仅限开发运行时 |
| 已存在成品会绕过「来源已停用」 | 队列任务先复核本地文件、后判来源启用，停用自定义源后排队任务仍报「下载成功」 | `downloadEpisode` 把来源复核提到文件复用之前，与 4.5 的顺序一致 |
| 紧急公告永远弹不出来 | 主进程注册了 `onAnnouncement`，但 SDK 从不调用它；也没有任何地方定期轮询 → 推送链路整条是死代码 | 服务内「新紧急公告只推一次」+ 主进程 15 分钟轮询 + 主界面横幅（`AnnouncementBanner`） |
| 停用一个来源只对「下一次请求」生效 | 在飞任务不停、已解密会话与播放缓存不清、`customProvider.cancelRequests` 从未被调用（死代码）；4.5 会取消在飞请求、清缓存与会话、停下未完成任务，同时保留已下载文件 | 新增纯函数 `planDisabledSources`（停哪些任务、要不要清会话/缓存/放弃在飞请求）+ 设置保存时在 IPC 入口执行；已完成的成品与其它来源不动 |
| 会话 dispose 在 Windows 上会抛异常 | 临时目录里还有读者时 `rmSync` 报 EBUSY/EPERM，缓存淘汰与来源停用都会走到它 | `removePathLater`：失败不再外抛，稍后重试（最多 5 次），仍失败就放弃临时目录 |
| HLS 会话把整集读进内存 | 供片改为磁盘 Range（`fileChunk`），几百 MB 的合集不再变成常驻内存 | 顺带删掉了 `EPERM` 那条隐患 |
| 删除文件时不看运行态 | 4.5 会拒绝删除正在下载的集；5.0 的「删除单集/整剧」直接删——删掉的正是下载正在写的那份，下载随后失败并留下垃圾 | SDK 加纯函数 `episodeDeletionProblem` / `seriesDeletionProblem`，宿主在 `storage.deleteEpisode` / `deleteSeries` 前调用 |
| 自定义源只能手改设置文件 | SDK 一侧齐备（校验/测试连通/目录/搜索/取流/放弃在飞请求），`media-sources` 也会列出 `settings.custom_sources`，但渲染层**没有任何入口**；4.5 有完整的管理界面 | 契约加 `custom-source:save`（含 `test`/`remove`），SDK 加 `custom-store.ts` 编排（更新保留编号、重复地址拒绝、测试失败不落盘、落盘失败回滚），设置页加管理卡片（新增需先测试连通，可停用/启用/删除） |
| 合并/转码界面缺入口 | `merge:cancel` 与 `merge-progress`/`transcode-progress` 后端都有、界面没接；UI 硬编码 `compatible:false`，4.5 的「兼容合并 / 仅 1080P」入口消失 | 下载页补齐三个合并入口 + 取消 + 进度条；契约与 SDK 补 `require1080`（`checkMinimumQuality` 在探测后、建工作目录前拒绝，并说明是哪几集不达标）；转码与存储错误也有进度/提示 |

## 旧检查 → 新用例迁移表（本轮新增）

| 旧检查 | 新用例 | 覆盖程度 |
|---|---|---|
| `scripts/check-download-quality-integration.cjs` | `packages/sdk/src/services/media/download.test.ts`（18 用例：明文下载校验通过才发布、未给 playInfo 时用 open 取源、低清晰度如实汇报「已下载更低质量」、不允许降级时失败且不留文件、传输中断按「不完整」失败、解码失败 `MEDIA_DECODE_ERROR`、取消是终态、已存在成品复用且不覆盖、已存在但不够清晰如实失败、CFF/HLS/spade 解密路径、**官网坏片源换到 App 片源**、坏片源反复失败时停手）+ `transfer.test.ts`、`tools.test.ts`、`queue.test.ts`、`ipc.test.ts` 新增用例 | **完全替代，旧检查已删除**。入队语义另测：契约层拒绝非法清晰度、同集同清晰度去重、同集不同清晰度整批拒绝、`list` 不触发下载。**发现并补掉两个真实缺陷**：`downloadEpisode` 从片源结果推断 vid（河马/西饭没有该字段，自定义源启用校验被跳过）、下载队列允许同一集重复入队（并发写同一文件、重复任务再也管不了）。第一条用真实 FFmpeg 的用例保留在 `download.test.ts`，本机无 ffmpeg 时跳过 |
| `scripts/check-media-recovery.cjs` | `transfer.test.ts`（18 用例：Range 解析、错误页/HTML/JSON 当传输失败、404 带状态码、App 403 翻 Referer 重试、擅自 206 的整段/半截判定、断流收敛为「不完整」、超上限拒收、`awaitMediaOperation` 超时与取消、候选逐个重试、片源暂时不可用重新取源带 force、空响应不重试、磁盘/安全错误不换清晰度、取消不试下一个候选、非红果来源单轮）+ `stream.test.ts`（11 用例：会话 LRU 淘汰并释放、内存会话 Range/HEAD/416、明文边下边给、供片前允许换候选、**开始供片后换片源即 502**、上游 416 透传、HEAD 探测、加密整集解密后切片 + snapshot、HLS 重封装后供片、HLS 产物校验）+ `hls.test.ts`（10 用例：清单本地化与协议白名单、直播清单/非 AES-128 加密/密钥长度/循环引用/错误页/空间上限/多码率只留最高/取消清理） | **完全替代，旧检查已删除**。**发现并补掉一个真实缺陷**：断流错误（`ERR_STREAM_PREMATURE_CLOSE`/`aborted`）原样外抛，队列认不出可重试 |
| `scripts/check-search-permissions.cjs` | `navigation-policy.test.ts` 扩到 23 用例（**可信主 frame 才给 fullscreen/clipboard**、摄像头/定位/通知/未知权限一律拒绝、不可信来源连白名单也拒绝、`isTrustedPermissionRequest` 对子 frame/外部地址/缺失详情一律 false）+ `security.test.ts` 新增接线断言（两条权限路径都注册、信任判定同时压窗口身份与 frame） | **完全替代，旧检查已删除**。**发现并补掉一个真实缺陷**：新架构把所有权限一律拒绝，播放器「切换全屏」与剪贴板静默失效。旧检查另一半「后台搜索必须独占一个窗口」**随实现消失**：5.0 搜索走 HTTP（`sdk.search.bySource`），全程不建窗口，也不存在「导航了用户窗口」的可能 |
| `scripts/check-ffmpeg-resolution.cjs` | `packages/host/src/tools.test.ts`（9 用例：**打包后只认随包二进制、不看 PATH 与工作目录**、随包优先、打包后无 resourcesPath 也不回退、Windows 的 .exe 与反斜杠、开发运行时的仓库目录与 cwd 两种深度、PATH 兜底含带引号目录、macOS 不带扩展名、全缺失时返回 null 并给出尝试过的候选）+ `packages/sdk/src/services/media/decrypt.test.ts`（缺 FFmpeg 时解密直接报工具错误） | **完全替代，旧检查已删除**。路径发现抽成 `@hongguo/host` 的纯函数 `resolveToolPath`（宿主只提供环境），**发现并补掉一个真实缺陷**：重构后的宿主在打包模式下仍会探测 `cwd/build/ffmpeg`，可能执行用户目录里的同名程序 |
| `scripts/check-source-integration.cjs` | `packages/sdk/src/services/media/download.test.ts` 新增 4 用例（**已存在成品也不能绕过「来源已停用」**、来源启用时正常下载、锁定分集直接失败且不留文件、**发布前再复核（下载过程中停用来源则拒绝写盘）**）+ `transfer.test.ts` 新增（官网片源指向回环地址被守卫拦下）+ `search-routing.test.ts` / `hema/index.test.ts` / `paths.test.ts`（河马搜索与分集路由不落到红果、河马/西饭独立目录） | **完全替代，旧检查已删除**。**发现并补掉一个真实缺陷**：`downloadEpisode` 先复用本地文件、后判来源启用，停用自定义源后排队任务仍报「下载成功」 |
| `scripts/check-custom-media-integration.cjs` | 新模块 `apps/desktop/src/main/source-access.ts` + `source-access.test.ts`（8 用例：来源编号解析、删除/设停用都算停用、新增与改 URL 不算、停掉该来源未完成任务、**已完成成品与其它来源不动**、清会话/缓存/放弃在飞请求、无变化时不做任何事、主进程接线源码断言）+ `stream.test.ts` 新增 2 条（两会话各自持有产物、**Windows EBUSY 时 dispose 不抛异常且稍后重试**）+ `transfer.test.ts`（自定义源私网地址被守卫拦下）+ `media-sources.test.ts` / `storage/store.test.ts`（来源清单与设置落盘） | **完全替代，旧检查已删除**。**发现并补掉两个真实缺陷**：① 停用自定义源只对「下一次请求」生效——在飞任务不停、已解密会话与播放缓存不清、`customProvider.cancelRequests` 成了死代码；② 会话 `dispose` 在 Windows 上遇到被占用的临时目录会抛异常（缓存淘汰/来源停用都会走到它） |
| `scripts/check-xifan-title-display.cjs` | `queue.test.ts` 新增（列表返回副本，读列表不改路径/状态/文件名）+ `download.test.ts` 新增（文件已被删掉时不当作已完成） | **部分替代后删除**：旧检查的一半断言针对 4.5 独有的数据形状——`ep_title` 兜底标题与 `status: 'missing'`；5.0 里标题来自来源适配器、文件状态由 `verifyDownloadedFile` 判定，这两样已不存在（同「后台搜索窗口」的处理：行为随实现消失，不再是缺口）。存活的「读取是纯读」「缺失文件不当成功」两条已用新用例锁住 |
| `scripts/check-online-disk-lifecycle.cjs` | `stream.test.ts` 新增 2 条（两个 HLS 会话各持一份产物、互不牵连；EBUSY 重试）+ `hls.test.ts` / `cache.test.ts`（暂存目录清理、正在读的缓存条目不淘汰） | **部分替代后删除**：4.5 的「多消费者共享一份磁盘文件 + 引用计数」设计在 5.0 变成「每个会话各自一份临时产物」，共享缓存只在 `cache.ts`（已有 refcount 用例）；「退出时等待清理」随 `release-online-play` 通道消失 |
| `scripts/check-app-media.cjs` | `decrypt.test.ts` 新增 3 条（**解密中途取消：杀子进程 + 删掉没写完的输出 + CANCELED**、**失败信息里不出现解密密钥**、空产出算失败）+ `download.test.ts`（CENC 片源解密后发布、中间文件当场清掉、密钥格式非法直接拒绝且不起子进程）+ `stream.test.ts`（加密会话在 `snapshot` 之后临时目录里一个文件都不剩） | **完全替代，旧检查已删除**。原检查用挂起的假 ffmpeg 验「取消要杀掉解密进程」，新用例同样用真子进程 + 真 AbortSignal 验 |
| `scripts/check-issue43-storage.cjs` | `storage/targets.test.ts` 新增 2 条（**正在下载/排队的单集不能删**、整剧还有在跑的任务就拦下并说清几集）+ `queue.test.ts`（列表是副本）+ `services/history/refresh.test.ts`（刷新只写续作与检查点） | **部分替代后删除**：删除「在跑就不删」这条守卫在 4.5 有、5.0 没有（**本轮补上**：`episodeDeletionProblem` / `seriesDeletionProblem` 纯函数 + 宿主调用）。剩下的一半是 4.5 独有的「移出列表但可恢复（dismissed）」语义，5.0 用「剧库移除 + 观看记录分开存」表达，不需要对等实现 |
| `scripts/check-merge-benchmark.cjs` | `merge.test.ts` 追加真实 FFmpeg 用例（**时长等于各集之和、全片静默解码 0 输出、不留临时目录、源文件字节与 mtime 不变**）；本机无 ffmpeg 时跳过 | **部分替代后删除**：它本质是「旧 main.js vs 新实现」的基准脚本，且被 `scripts/test.cjs` 跳过（需要 `--old` 与两个真实片段）；旧实现下线后对比无意义，但它对新实现的硬要求已搬进 Vitest |



| `src/native/danmaku-sign.test.cjs` | `packages/sdk/src/internal/crypto/danmaku-sign.test.ts`（黄金向量逐字节比对 + 敏感性） | **完全替代，已删除旧文件** |
| `scripts/check-series-search.cjs` | `packages/sdk/src/services/search/series-search.test.ts`（有界搜索、严格续集身份、当前季排除） | 行为层完全覆盖；来源层的分页细节未覆盖 |
| `scripts/check-web-media-guard.cjs` | `packages/sdk/src/internal/net/guard.test.ts`（私网/保留段/IPv6/凭据/协议、trustedOfficialDns 约束） | URL 策略完全覆盖；代理 socket 复用与 DNS rebinding 的**运行时**行为未覆盖 |
| `scripts/check-watch-history.cjs` | `packages/sdk/src/services/history/watch-history.test.ts`（分季解析、来源识别、记录聚合） | 部分覆盖；筛选/确认/单行刷新未覆盖 |
| `scripts/check-merge-optimization.cjs` | `packages/sdk/src/services/media/merge-plan.test.ts`（直复制 vs 重编码、兼容模式、音轨策略） | 计划层覆盖；逐帧结果仍靠真实素材验收 |
| `scripts/check-catalog.cjs` | `packages/sdk/src/providers/hongguo-web/catalog.test.ts`（SSR 解析、完结状态） | 解析层覆盖；分页/兜底链路未覆盖 |
| — （新增覆盖） | `packages/sdk/src/internal/crypto/sm3.test.ts`（GB/T 标准向量） | 替代旧 SM3 校验 |
| — （新增覆盖） | `apps/desktop/src/renderer/src/pages/DownloadManager.test.tsx` | 页面层首个用例（jsdom 项目从此非空） |
| `scripts/check-app-update.cjs` | `packages/sdk/src/services/meta/update.test.ts`（9 用例：更高版本才提示、相同/更低不提示、草稿与预发布忽略、版本无法解析不猜、跳转地址恒为本项目发布页、更新开关默认开、开发运行标记不支持且下载/安装直接失败） | **发现并补掉两个缺口**：`updatePort.check()` **无视「关闭更新检测」开关**，关了仍请求 GitHub；未打包运行仍报 `supported:true`，用户点了才失败。两条都已修。旧检查已删除 |
| `scripts/check-app-update-proxy.cjs` | `apps/desktop/src/main/proxy-sessions.ts` + `proxy-sessions.test.ts`（9 用例：两会话同规则、切换断旧连接、无更新会话不影响、更新会话失败时窗口仍生效、直连也要下发、认证仅给白名单主机、大小写归一、无账号不提供、凭据不出现在会话参数） | **发现并补掉三个缺口**：更新器自己的网络会话**没走代理**（更新请求绕过代理直连）、切换代理**不断开旧连接**（继续走旧线路）、更新下载的代理认证**完全没处理**。旧检查已删除 |
| `scripts/check-error-boundary.cjs` | `components/ErrorBoundary.test.tsx`（5 用例：正常渲染、崩溃时中文恢复提示 + role=alert、界面不含堆栈、重载按钮、错误上报但不入界面） | **发现并补掉一个真实缺口**：新渲染层**完全没有错误边界**——任一页面抛错就白屏，只能强杀应用。现已补回并挂到主入口。旧检查已删除 |
| `scripts/check-watch-history-backend.cjs` | `packages/sdk/src/services/history/refresh.ts` + `refresh.test.ts`（8 用例：检查点内不再查、关键词为剧名基名、只查已看过且受 limit、成功推进检查点、部分失败保留续作但不推进检查点、搜索抛错不崩、低季数/别的剧不算续作、旧续作不被空结果抹掉）+ IPC 2 用例 | **发现并补掉一个真实缺口**：新架构**没有后台续作刷新**（无通道、无编排）。现已补纯编排 + `history:refresh` 通道 + 历史页「检查续作」入口。旧检查已删除 |
| 画质增强 · **已实现** | `lib/video-enhancement.ts`（模式归一/锐化核/Anime4K 前置检查）+ `components/VideoEnhancement.tsx`（设置界面、锐化 SVG 卷积、WebGPU 叠加 canvas），16 用例 | 三档 original/sharpen/anime4k；Anime4K 限 1080p（超限明确拒绝不降级）、无 WebGPU 时说人话并建议锐化；设置存 localStorage。`anime4k-webgpu` 为按需 chunk（3.45 MB，仅启用时加载），主包不受影响 |
| 播放器 · **弹幕渲染与预取已实现** | `lib/danmaku.ts`（9 用例：时间窗口、数量上限、泳道轮转、offset 进度、脏数据、模式归一）+ `components/DanmakuLayer.tsx`（6 用例：窗口内绘制、保留颜色、开关、无弹幕时说明原因、固定/滚动分离、不挡鼠标）+ SDK `services/media/prefetch.ts`（11 用例：只取紧随的未锁定集、去重、超时、取消、失败静默）+ IPC 2 用例 | 通道 `danmaku:list`、`play:prefetch`；剧库播放器已挂弹幕覆盖层（开关）与预取。**踩到一个边界违规**：渲染层直接 import `@hongguo/sdk` 会把 fs/crypto/axios 带进浏览器包，启动即 `e is not a constructor`；已改为 IPC，由主进程执行预取 |
| `scripts/check-floating-player-window.cjs` + `scripts/check-picture-in-picture-mode.cjs` | `floating-window.test.ts`（14 用例：窗口参数、安全基线、parent 悬挂、opener 存活、全屏可见/置顶/无菜单栏/尺寸范围、导航与重定向拦截、自家页面放行、window.open 拒绝、尺寸边界、去抖落盘、关窗补写、flush、重复关闭）+ `FloatingPlayer.test.tsx`（5 用例：取地址播放、来源未开放、加载失败、暂停立即写进度、播放中节流）+ `player.test.ts`（4 用例：画中画枚举与非法值） | **已删除两个旧检查**。同时补掉两个真实缺口：悬浮窗**原先没有导航守卫**（页面跳转可把只读播放器导到任意外部站点）与**不会浮在全屏应用之上**。`?floating=1` 独立布局已实现，主界面不再挂载。旧检查已删除 |
| 独立窗口类 · **悬浮播放器已实现** | `apps/desktop/src/main/floating-window.ts`（13 用例：窗口参数、安全基线、加载地址、window.open 拒绝、尺寸边界、去抖落盘、关窗补写、flush、重复关闭）+ `packages/sdk/src/services/settings/player.ts`（4 用例：native/custom 枚举、非法值报错、尺寸越界）+ IPC 3 用例 | 通道 `player:float-open` / `player:float-close`，preload 与渲染层已接；剧库播放卡片加了「悬浮小窗」按钮（native 走系统 PiP，custom 走应用窗口，PiP 不可用时回落小窗）。**画中画/悬浮窗的旧检查尚未删除**：`check-floating-player-window.cjs` 还要求 child-of-main 关系与 opener 存活语义，未覆盖 |
| `scripts/check-download-media-validity.cjs` | `download.test.ts` 新增 4 用例（合法文件返回实际清晰度且文件不变、损坏文件被拒且原地保留 200,000 字节、空文件不发探测、低于所选清晰度报实际分辨率） | **补掉一个真实缺口**：新架构**没有「复核已存在成品」的能力**——磁盘上的坏文件既不会被识别，也无法在跳过下载前确认可用。新增 `verifyDownloadedFile`（只读、失败不删文件）并接进下载任务：可用即复用并提示「跳过下载」，不可用才重新下载覆盖。旧检查已删除 |
| `scripts/check-portable-data.cjs` | `apps/desktop/src/main/portable-data.test.ts`（6 用例：非 Windows、无变量、只复制一次且不搬缓存、marker 识别、不可写回退带原因、同时切 userData/sessionData） | **发现并补掉一个真实功能缺口**：便携目录能力虽已迁进 SDK，但**主进程从未调用它**——整个便携模式是死代码。现已在启动最早期（任何 `getPath` 之前）调用并按结果切换目录。旧检查已删除 |
| 迁移期收紧 · **`strictNullChecks` 已开** | `packages/sdk/tsconfig.json`: `strictNullChecks: true`（100 错 → 0） | 修法逐点：`let x = null` 显式标注、`filter(Boolean)` 换成类型谓词、`mediaLines` 源头过滤 null 分集、位运算取值加非空断言。`noImplicitAny` 仍关（811 处隐式 any，需逐参数标注，单独排期） |
| `scripts/check-source-routing.cjs` + `scripts/check-search-deadline.cjs` | `apps/desktop/src/main/search-routing.test.ts`（5 用例：未知来源拒绝、空/超长关键词拒绝、红果走官网、西饭/河马/自定义各走各的、预算耗尽立即失败）+ IPC 用例 1 条 | **发现并补掉一个真实功能缺口**：搜索此前只走红果官网，**其他来源完全搜不了**。现已加 `search.bySource` 分流 + 20s 总预算 + 搜索页来源选择。两个旧检查已删除 |
| `scripts/check-hongguo-identity.cjs` | `packages/sdk/src/providers/hongguo-web/identity.test.ts`（8 用例：整剧入口页解析、缺编号/编号不符失败、推荐位与外层 request 不能冒充、只取当前播放器分集与封面、备用接口键不符报错、网页优先与回落） | **完全替代，旧检查已删除**；同时把「跨来源混入」校验提到契约层（`downloadEnqueueRequestSchema.refine`），宿主侧再兜一次 |
| `scripts/check-catalog-routing.cjs` | `apps/desktop/src/main/catalog-routing.test.ts`（4 用例：未知来源拒绝、红果默认 App + 显式 web、西饭/河马/自定义走各自适配器、自定义代理下禁用可信 DNS 直连） | **发现并补掉一个真实功能缺口**：主进程此前把所有来源都送到 App 目录，**西饭/河马/官网线路全都走不到**。现已按来源分流并接回官网线路开关。旧检查已删除 |
| `scripts/check-storage-targets.cjs` | `packages/sdk/src/services/storage/targets.test.ts`（同一目标集不变量：统计到的 = 删得到的） | **完全替代，旧检查已删除** |
| `scripts/check-decrypt-worker.cjs` | `packages/sdk/src/services/media/decrypt.test.ts`（6 用例：文件复制且源不变、worker 回报错误收敛为 SdkError、worker 崩溃也能收敛、**已取消信号不启动 worker**、**运行中取消立即结束并终止 worker**、buffer 经 Transferable 回传） | **完全替代，旧检查已删除**；算法等价性由 `providers/hongguo-web/decrypt.test.ts` 覆盖 |
| — （新增覆盖） | `apps/desktop/src/renderer/src/pages/ShortcutSettings.test.tsx`（5 用例：动作与绑定展示、捕获新键并落盘、冲突拒绝、Esc 取消不写存储、恢复默认） | 旧检查无对应项（4.5 只有纯逻辑测试） |
| — （新增 L4） | `e2e/app.e2e.ts`（9 条 Playwright `_electron`：9 个导航入口、渲染进程无 Node 能力、preload 暴露面、IPC 往返、设置落盘、两个自定义协议已注册、弹窗被拒、导航守卫拦截外站、无 console 错误） | 真实构建产物 + 真实 Electron |
| `scripts/check-media-access.cjs` | `apps/desktop/src/main/media-access.test.ts`（5 用例：稳定不透明 id、只按 id 反查不回退路径、CORS 只认应用来源、**origin 与 initiator 不一致时拒绝**、clear 后失效） | **完全替代，旧检查已删除**；发现并补回迁移时丢掉的双向来源校验 |
| `scripts/check-renderer-file-urls.cjs` | `apps/desktop/src/main/sender-trust.test.ts`（4 用例：同时比较 webContents 与顶层 frame 身份、窗口销毁即不可信、渲染页只从固定路径加载、IPC 先校验后业务） | **完全替代，旧检查已删除**。旧方案靠 URL 编码等价（`~`/`%7E`/盘符/查询串）判断，新方案用对象身份比较，不可伪造 |
| `scripts/check-renderer-security.cjs`（导航/权限部分） | `apps/desktop/src/main/navigation-policy.ts` 新增 + `navigation-policy.test.ts`（9 用例：应用内放行、外部 http(s) 交系统浏览器、**javascript:/data:/自定义协议一律拒绝**、畸形地址拒绝、权限一律不授权、主进程接线断言） | **发现并补掉一个真实安全缺口**：重构后窗口**没有任何导航守卫与权限处理**（只有弹窗守卫），页面内跳转可在应用窗口加载外部站点。旧检查的窗口布局/缩放部分仍未覆盖，故保留 |
| `scripts/check-app-source-recovery.cjs` | `packages/sdk/src/providers/hongguo-app/device.test.ts`（7 用例：注册响应校验、**请求不带 cookie/authorization**、被拒身份触发一次更新、**并发共享一次更新**、**迟到旧身份不再更新**、冷却期内不重复更新、更新失败保留旧身份并抛 DEVICE_REGISTRATION_FAILED） | **完全替代，旧检查已删除**；EMPTY_RESPONSE 重试与质量档位仍由 `check-app-source` 覆盖 |
| `scripts/check-download-safety.cjs` | `packages/sdk/src/services/storage/targets.test.ts`（15 用例）+ `apps/desktop/src/main/queue.test.ts` 扩充（+5 用例） | **完全替代，旧检查已删除**。覆盖：单剧删除（只含本剧目录、无记录不删、root 外不纳入、删后清空目录、不删 root）、**单集删除**（视频+文字导出+`.enc.tmp`/`.decoded` 残留、不牵连同目录其它集）、**删除任务含/不含文件**、**队列持久化与失败回滚**（回滚时不会把任务卡在 downloading）、`purge-empty-series`（清掉无文件的剧集档案） |
| `scripts/check-source-recovery.cjs`（不变量部分） | `packages/sdk/src/providers/hongguo-web/recovery.test.ts`（6 用例：**传输错误码收敛为 TIMEOUT/NETWORK_ERROR**、错误信息与对象**不回传签名地址/令牌/私网地址**、网页每路预算 ≤4s、空响应不放大、网页地址必须对上请求分集、结构异常返回 null） | **发现并修掉迁移时丢失的行为**：原始 axios 码（ECONNABORTED/ENOTFOUND…）会散落到上层，导致队列误判「不可重试」；已收敛码并让队列认 NETWORK_ERROR。旧检查已删除 |
| `scripts/check-source-retry.cjs` | `apps/desktop/src/main/queue.test.ts` 扩充（10 用例：**双退避表**——片源不可用走分钟级、传输中断走秒级；安全类错误直接失败不排重试；预算用尽清 `retryAt` 且去掉「自动重试」提示；并发闸门、取消终态、恢复） | **完全替代，旧检查已删除** |
| `scripts/check-proxy-routing.cjs`（编排部分） | `apps/desktop/src/main/proxy-controller.test.ts`（9 用例：环境先于会话、fixed_servers 映射、直连/system、缺端口不改环境、**超时回落直连并同步环境**、**迟到完成不覆盖新配置**、会话报错回落、current 反映最近结果） | **完全替代，旧检查已删除**；纯逻辑部分由 `packages/host/src/proxy.test.ts` 的 16 条覆盖 |
| `scripts/check-decrypt-worker.cjs`（等价性与错误部分） | `packages/sdk/src/providers/hongguo-web/decrypt.test.ts`（5 用例：无加密样本原样返回、缺 moov 可判断报错、短密钥不误报、文件写出且源不变、源缺失不建目标） | **部分替代**：取消与事件循环让出两条能力**尚未恢复**，旧检查暂时保留 |

| `scripts/check-streaming.cjs`（复用/淘汰部分） | `packages/sdk/src/services/media/cache.test.ts`（11 用例：片源指纹变化不复用、vid/来源/剧集不一致不复用、未完成条目不复用、清晰度分键、超预算按 lastUsed 淘汰且至少留 1 条、读取刷新 lastUsed、磁盘文件随淘汰/clear 删除、超预算内容仍交回调用方）+ `stream.test.ts` 新增 2 条（内存会话按 Range 切分、解密会话快照） | **补齐功能缺口**：4.5 的 `onlineCache` 之前没有迁，重开同集要重新解密；现已实现并接入 `play:prepare` |

| `scripts/check-hema-browse.cjs` | `packages/sdk/src/providers/hema/browse.test.ts`（7 用例，真实页面夹具：首屏解析不伪造榜单/热度/总页数、翻页与题材 URL、组合题材、未知题材与非法页码不发请求、无下一页标记、分页/题材不一致报错、结构异常可读错误、刷新与超时区分） | **完全替代，旧检查已删除** |
| （已由上表 `check-media-recovery` 一行取代） | ~~`packages/sdk/src/services/media/download.test.ts` 的部分故障注入~~ | 见上方本轮新增行：断流、解码失败、取消、半截文件都已覆盖 |

| `scripts/check-xifan.cjs` | `packages/sdk/src/providers/xifan/index.test.ts`（8 用例：目录与题材去重、翻页/题材透传、搜索编码、缺 unlock 视为锁定、分集不泄露媒体地址、取流每次重验锁、非 HTTPS/凭据拒绝、归属不符与身份非法不联网、冲突标题回退） | **完全替代，旧检查已删除** |
| `src/native/episode-comments.test.cjs` | `packages/sdk/src/services/comments/index.test.ts`（4 用例：参数与游标校验不联网、稳定去重 id、来源受限如实标注、缓存复用、分集不一致不串评论） | **完全替代，旧单测已删除** |

| `scripts/check-hema.cjs` | `packages/sdk/src/providers/hema/index.test.ts`（13 用例：搜索分页与请求体、实时收费标记、列表不含可下载地址、720p→mp4 回退、**绝不回退 encryptUrl**、非 HTTPS/带凭据拒绝、身份校验联网前失败、错误不透传上游原文） | **完全替代，旧检查已删除** |

| `scripts/check-public-details.cjs` + `src/native/public-details.test.cjs` | `packages/sdk/src/providers/hongguo-web/details.test.ts`（10 用例：50/1000 上限、缓存隔离、并发去重、失败不写缓存、锁集与普通失败区分、评分/点赞/首播时间、javascript: 头像清空） | **完全替代，旧文件已删除** |
| `src/native/media-sources.test.cjs` + `scripts/check-media-sources.cjs` | `packages/sdk/src/services/sources/media-sources.test.ts`（6 用例：默认清单、关闭内置源、红果不可关、custom 前缀、纯函数性） | **完全替代，旧单测已删除** |
| `scripts/check-custom-source.cjs`（校验部分） | `packages/sdk/src/providers/custom/index.test.ts`（6 用例：公网校验、默认 CMS 路径、名称/编号约束、超长地址） | 校验层覆盖；目录/搜索/取流未覆盖 |
| `scripts/check-app-source.cjs`（校验部分） | `packages/sdk/src/providers/hongguo-app/ticket.test.ts`（7 用例：签名头完整、页码越界、身份非法、关键词截断、两类接口的路径白名单） | 守卫层覆盖；实网取流由真实素材验收覆盖 |

| `scripts/check-download-safety.cjs`（路径部分） | `packages/shared/src/paths.test.ts`（18 用例：目录穿越、Windows 非法字符/保留名、emoji 截断、越界复核） | **发现并修掉重构引入的真实缺陷**：新主进程此前直接 `path.join(root, 剧名)`，未做净化；现已改用 `sanitizeFolderName`/`seriesDownloadDir`/`episodeFilePath`。删除类断言仍未覆盖 |
| `scripts/check-danmaku-*.cjs`（服务层） | `packages/sdk/src/services/danmaku/index.test.ts`（11 用例：分页、去重、脏数据过滤、limit 截断、缓存、失败文案不透传上游原文） | 服务层完全覆盖；渲染层弹幕滚动仍未覆盖 |


该轮测试规模（历史值，当前见文首质量门）：**62 文件 / 571 通过 + 1 跳过**；旧回归网 69 项平台检查 + 11 个旧单测。

## 已知功能缺口（不是测试缺口）

1. ~~CENC 解密的两条能力缺口~~ **已恢复（本轮）**：解密搬到 `worker_threads`（`apps/desktop/src/main/workers/decrypt-worker.ts`，
   esbuild 单独打包，避开 electron-vite multi-entry 的 Rolldown panic），
   主线程只等结果、可 `AbortSignal` 取消；`scripts/check-decrypt-worker.cjs` 已删除。

## 环境事实（写进新对话省时间）

- **装依赖**：`pnpm install`。Electron 二进制不在 npm 包里，得单独取一次：
  `node node_modules/.pnpm/electron@45.1.0_supports-color@7.2.0/node_modules/electron/install.js`
  （之后 `node_modules/.pnpm/electron@45*/node_modules/electron/dist/` 里才有 `Electron.app`；
  e2e 与 smoke 都靠它）。
- **跑测试**：`NODE_ENV=test pnpm test`；`legacy:test` 不要和 vitest 串在同一条 `&&` 链里。
  vitest 与 `tsc -b` 也不要并行跑（并行时出现过 5 个测试文件同时失败的假红）。
  `node` 项目的 `testTimeout` 已调到 20s：媒体用例会起真子进程，默认 5s 在满负荷并行时会误报超时。
- **本机 FFmpeg**：`scripts/setup-ffmpeg.js` 是 Windows 专用；macOS 的
  `scripts/setup-ffmpeg-mac.js` 要 `pkg-config`，本机没有就走不通。缺 FFmpeg 时：
  只有「真实解码器」那 1 条 Vitest 跳过（其余用例用替身脚本，不需要真工具）。
- **渲染层不能 import `@hongguo/sdk`**：会把 fs/crypto/axios 带进浏览器包，启动即崩；
  预取、弹幕、导出都走 IPC。
- **解密 worker 的位置**：产出到 `out/workers/decrypt-worker.js`（**不在** `out/main` 里，
  否则被 electron-vite 清理），构建顺序是 `electron-vite build && node scripts/build-worker.mjs`。
  打包后它在 `app.asar` 内部，`worker_threads` 能直接加载（本轮用探针实测通过）。
- **smoke**：启动打包产物并观察 12 秒——
  `dist-5.0/mac-arm64/红果短剧.app/Contents/MacOS/红果短剧 --user-data-dir=<临时目录>`，
  期望「存活 12s、0 异常行、SIGTERM 后退出码 0」（本轮实测满足）。

## 删除旧代码的依赖审计（本轮实测，`scripts/` 下 27 项）

**哪些文件删不掉由依赖面决定，不是由检查名字决定**（本轮就抓到一个反例：
`check-player-online-quality.cjs` 看起来测渲染层，实际经夹具跑真 `main.js`）：

```
依赖 main.js（vm 加载）：8 项   ← 删除 main.js 的真正阻塞
依赖 src/（渲染层 jsx 夹具 / src/native）：24 项   ← 阻塞删除 src/
（含被 scripts/test.cjs 跳过的：check-merge、check-windows-installer、check-windows-release、
  check-hls-media、check-danmaku-live、check-ffmpeg-mac、check-release-version）
```

逐文件清单与行数见「未完成（按优先级）」第 1 条。审计口径是**传递闭包**：某个检查即使自己没提 `main.js`，
只要 require/读取了别的检查或 `scripts/fixtures/` 里的夹具，也要跟着算进来
（本轮就发现 `check-player-online-quality.cjs` 与 `check-download-manager.cjs` 是这种「间接依赖」）。

### 已迁完 51 项（8 组并行 + 后续按缺陷清单修复）

78 → 27 项：删除的每一项都先补了等价用例（Vitest 从 638 涨到 1298）。
obsolete 类（行为随实现消失）在删除时都写明了「为什么不再是缺口」：隐藏窗口搜索、隐身窗、
字号缩放、下载页批量选择、4.5 常驻播放器结构、弹幕全屏实现细节、日历 `play-series` 语义等。
逐项结论（新用例文件与条数、覆盖的不变量、遗留）见下方迁移表。

## 功能缺口审计（4.5 有、新工程缺失或未接线）

用逐项 grep 核对，不是凭印象。这是判断「重构是否真的完成」的依据：
**迁移完成 ≠ 功能对等**，下面这些都还没有对等实现。

| 功能 | 4.5 | 新工程（实测） | 处置 |
|---|---|---|---|
| 代理（模式/认证/连通性测试） | 完整 | **已补齐**：`packages/host/src/proxy.ts`（启动快照、direct/custom/system 三态、规则与登录凭据分离、环境变量改写）+ `main/proxy-sessions.ts`（**窗口会话与更新会话都走代理**、切换即断旧连接、认证只给更新主机）+ `proxy:apply`/`proxy:test` 通道 + 设置页卡片 | 仅"按域名分流"细化未做 |
| 画中画 / 悬浮小窗 | 完整（`floating-player-window`、4.4 的画中画模式选择） | **已补齐**：`main/floating-window.ts`（parent 悬挂、opener 存活、全屏可见、导航守卫、尺寸去抖落盘）+ `?floating=1` 独立布局 + `picture_in_picture_mode`（native/custom）+ 剧库入口 | 隐身窗（后台抓取用）**不再需要**：新架构搜索走 HTTP，不建隐藏窗口 |
| 存储用量 / 删除全部 / 删除整剧 / 删除单集 / 删除任务 / 清空档案 | 完整 | **已补齐**：`services/storage/targets.ts`（磁盘扫描产出目标集，记录只用于补剧集归属）+ `storage:usage`/`storage:delete-all` 通道 + 设置页卡片 | — |
| 公告 | 完整 | **已接线**：`announcement:get/dismiss/check` 三通道 + 设置页横幅（今天/本版本免提醒）+ 紧急公告事件推送 | — |
| 应用内更新 | 完整（含安装中止、通道拦截） | **已接线**：`update:check/state-get/download/install/cancel` 五通道 + 设置页入口；用 SDK 的 `createUpdateInstaller`（关闭差分下载与 Web 安装器，仅官方仓库） | — |
| 画质增强（anime4k） | 完整 | **已补齐**：`lib/video-enhancement.ts` + `components/VideoEnhancement.tsx`（原画/锐化/Anime4K 2×，Anime4K 限 1080p，无 WebGPU 时说明并回退） | 真机 GPU 画面未验收（见「未完成」） |
| 快捷键（播放器 + 自定义界面） | 完整 | **已补齐**：`lib/shortcuts.ts`（9 个动作、事件归一、冲突校验、存储回退、让位规则）+ 播放器接线（空格/←→/↑↓/A/S/D/F）+ 设置页自定义界面（捕获按键、冲突提示、恢复默认） | — |
| 文字导出（弹幕/评论/剧评） | 完整 | **已接线**：`export:text` 通道 + 契约层「至少选一类」校验 + 剧库页入口；导出文件与视频同目录同名 | — |
| 播放器（预取/连播/弹幕渲染/快捷键/画中画） | 完整（1949 行 Player） | **完整**：原生 controls + 分集切换 + 续播落盘（节流 5s、同集回看不写小、看完置 watched）+ 连播 + 快捷键（9 动作，可自定义）+ 弹幕渲染（泳道调度）+ 预取下一集 + 悬浮小窗/系统画中画 | — |
| 自定义源（CMS）管理 | 完整（增删改 + 连接测试 + 启停） | **本轮补齐**：`services/sources/custom-store.ts`（校验 → 可选真连 → 落盘，失败回滚内存）+ `custom-source:save` 通道 + 设置页 `CustomSourceManager` 卡片 | — |
| 主题 | DESIGN.md 只有浅色 | 一套浅色 token | 与设计文档一致，无需补 |
| 观看记录 / 剧库 / 下载 / 合并 / 转码 / 账号 / 搜索 / 目录 | 完整 | 已迁移并接线；本轮补齐合并界面（快速/兼容/仅 1080P 三个入口、取消、进度）与转码进度、存储错误提示、紧急公告推送 | 真实素材需重验（见「未完成」第 2 条） |

结论：**功能对等已全部完成**。画中画/悬浮小窗、画质增强（原画/锐化/Anime4K）、播放器预取与弹幕渲染、
代理、存储用量与删除、快捷键（含自定义界面）、公告、更新、文字导出、续播与连播均已实现并接线。
唯一未做的是 **Anime4K 的真机 GPU 验收**（自动化只覆盖前置判断与回退分支，见文末「未完成」）。


### 本轮迁移明细（44 项已删 / 34 项保留）

> 保留 = 该检查至少有一条断言在 5.0 无等价实现；对应缺口已进文末缺陷清单。

**main.js · 搜索与来源（删 3 / 留 2）**

| 旧检查 | 新用例 | 结论 |
|---|---|---|
| check-series-search | `services/search/season-search.test.ts`(16) | 完全替代 |
| check-catalog | `providers/hongguo-web/catalog-browse.test.ts`(19)、`main/search-ipc.test.ts`(4) | 完全替代；DNS 预热接线消失 |
| check-search-timeout | 分布进 `search-api`/`catalog-browse` | obsolete：隐藏窗口+DOM 轮询被 HTTP 取代 |
| check-app-search-ipc | `providers/hongguo-app/search-paging.test.ts`(11)、`new-releases.test.ts`(13) | **保留**：App 搜索与上新补搜整条编排未接线（缺陷 10） |
| check-hongguo-search-ipc | `providers/hongguo-web/search-api.test.ts`(14) | **保留**：模糊补搜缺实现；5xx 自动改走 App 属缺陷 10 |

**main.js · 播放与流（删 1 / 留 3）**

| 旧检查 | 新用例 | 结论 |
|---|---|---|
| check-web-media-guard | `internal/net/guard-runtime.test.ts`(14)、`providers/hongguo-web/player-penalty.test.ts`(5)、`services/media/transfer.test.ts`(+2) | 完全替代 |
| check-streaming | `media/stream.test.ts`(+7)、`media/web-transfer.test.ts`(5)、`main/protocols.test.ts`(6) | **保留**：`play:prepare` 无 `force`/无按 requestId 取消；并发转码缺陷 21；宿主队列写盘时序无单测边界 |
| check-playback-resource-limits | `transfer.test.ts`(+2)、`stream.test.ts`(+2) | **保留**：超限后自动转下载 +「取消等待」无 UI；缺陷 22/23 |
| check-player-online-quality | 既有 `quality/cache/download/queue` 用例 | **保留**：在线清晰度选择器整块缺失（缺陷 20）；分集面板不看 `retryAt/error/actualQuality` |

**main.js · 历史/兼容/合并（删 0 / 留 5）**

| 旧检查 | 新用例 | 结论 |
|---|---|---|
| check-watch-history-3.7 | `history/watch-history-3.7.test.ts`(12) | **保留**：`scope=latest` 单行重检、定时后台检查、分集/续作错误拆分均无实现 |
| check-watch-history-integration | `history/watch-history-records.test.ts`(12)、`main/history-ipc.test.ts`(12) | **保留**：缺陷 12/13/14 |
| check-calendar-playback | — | **保留**：App 目录 → `play-series` → Player 整条链在 5.0 不存在 |
| check-compat-lifecycle | `media/compat-lifecycle.test.ts`(8) | **保留**：在线兼容转码机制（权限门槛/锁定拦截/同集去重/清缓存）在 5.0 无实现（缺陷 28） |
| check-merge | `media/merge-invariants.test.ts`(6+1 skip) | **保留**：合并任务落盘无写入者（缺陷 27）；逐帧验收需真实素材 |

**main.js · 生命周期/安全（删 0 / 留 4）**

| 旧检查 | 新用例 | 结论 |
|---|---|---|
| check-single-instance | `main/app-lifecycle.test.ts`(14) | **保留**：退出等待在飞任务（缺陷 15）、便携与 `--user-data-dir`（缺陷 18）、启动失败提示（缺陷 25） |
| check-backend-lifecycle | 同上窗口类 2 条 + `compat-lifecycle` | **保留**：退出编排整条缺失（缺陷 15）；`cleanupMergeTemps` 死代码（缺陷 26） |
| check-macos | `main/macos-tools.test.ts`(6) + activate 1 条 | **保留**：macOS 原生菜单/字号缩放/关于面板属 P3 obsolete，需产品确认后可删 |
| check-renderer-security | `app-lifecycle.test.ts` 边界 6 条 + 3 条 `it.fails` | **保留**：缺陷 24（`will-redirect`、`file:` 可信、外部链接）已用 expected-fail 钉住 |

**src/native · 检查（删 12 / 留 5）**

已删：`check-app-catalog`(16+)、`check-app-source`、`check-app-update-installer`(11)、`check-custom-source`(8)、
`check-download-quality`（`quality-variants.test.ts` 11，唯一遗留：缺陷 36）、`check-hls-space`(6)、
`check-native-performance`(12)、`check-rankings`(6)、`check-share-security`(11)、`check-review-native-2-5`、
`check-stealth-window`(obsolete)、`check-window-layout`（CSS 不变量 3 条 + P3 obsolete）。

保留：`check-hls-media`（需真 ffmpeg 造 `AES-128` HLS）、`check-ffmpeg-mac`（发行产物二进制验收）、
`check-windows-release`（真机/CI 发行验收）、`check-windows-installer`（同前）、`check-release-version`（旧根 package.json 的 build 字段）、
`check-danmaku-live`（需真实网络夹具）。

**src/native · 旧单测（删 10 / 留 1）**

已删：`account-session`(15)、`app-announcements`(33)、`danmaku`(23)、`hongguo-app-new`(11)、
`hongguo-app-search`(7)、`hongguo-search`(9)、`playback-device`(6)、`preview-startup`(obsolete)、
`text-export`(13)、`text-export-integration`(6，跑真实主进程入口)。

保留：`src/native/episode-panel.test.cjs` —— 模块行为已由 `services/series/episode-panel.test.ts`(11) 覆盖，
但 5.0 里该模块**没有任何调用方**（缺陷 17），旧单测守的正是「装配存在」这一环。

**渲染层 · 播放器（删 2 / 留 6）**

已删：`check-player-controls`（6 条 + 自定义控件条 obsolete）、`check-player-shortcuts`(10)、
`check-playback-speed`（`Library.speed.test.tsx` 5 条：范围/步进/让位/跨集保留 + 进度语义回落到 `Library.progress.test.tsx`；
in-video 提示与 timer 复用属 obsolete —— 5.0 用原生控件 + 状态栏文案）。
新用例：`Library.progress/playback-keys/floating/entry/prefetch/speed/float-pip/storage-refresh/fallback.test.tsx`、
`App.player-windows.test.tsx`、`Settings.save/Settings.storage-delete.test.tsx`、`DownloadManager.events/failures/resume.test.tsx` 等。
保留：`check-player-resume`（缺陷 1/2，且是 ~20 个检查的共用 jsx 夹具）、`check-player-navigation`（缺陷 3）、
`check-player-navigation-refresh`（P3 obsolete 为主）、`check-player-library`（部分）、
`check-player-download-state`（缺陷 4）、`check-player-fallback`（缺陷 6/7）、`check-playback-speed`（缺陷 5）、
`check-floating-player-host` / `check-settings-picture-in-picture`（部分）、`check-download-manager`（缺陷 16）、
`check-download-delete-feedback`（缺陷 16）、`check-download-selection-delete`（5.0 无批量选择）、
`check-app-update-ui`（是另两个存活检查的共用夹具）、`check-player-review-2-5`（共用夹具）。

**渲染层 · 历史/公告/更新/弹幕（删 8 / 留 2）**

已删：`check-watch-history`、`check-watch-history-display`（obsolete 为主）、`check-record-controls`、
`check-announcement-ui`、`check-sequel-finder-ui`、`check-danmaku-official-ui`、`check-danmaku-fullscreen`、
`check-merge-optimization`、`check-store`、`check-preview-shortcuts`。
新用例：`History.scope.test.tsx`(10)、`Settings.announcement.test.tsx`(5)、`Settings.update.test.tsx`(8)、
`Calendar.sequels.test.tsx`(6)、`Library.danmaku.test.tsx`(6)、`DanmakuLayer.timeline.test.tsx`(4)、
`services/media/merge-plan.publish.test.ts`(11)、`storage/store.durability.test.ts`(7)、`lib/shortcuts.boundaries.test.ts`(6)。


### 剩余 8 项阻塞 `main.js` 的检查：各自还差什么（按行数）

| 旧检查 | 还差的功能 | 可删的前置条件 |
|---|---|---|
| `check-app-search-ipc.cjs`(402) | 搜索分页通道与 UI（`search-series-more` 的 channel+cursor 钉定）、标点模糊补搜 | SDK 编排已支持 page/cursor/channel，缺通道与「下一页」入口；模糊补搜未做 |
| `check-backend-lifecycle.cjs`(315) | 退出编排的剩余细节（迟到清理不得完成新退出、临时文件等待的可观测性）、`uptime` 类断言 | 已完成：取消合并/停下载/断转码/有界等待/放行一次；剩下是更细的时序断言 |
| `check-calendar-playback.cjs`(266) | 日历/历史点击播放（4.5 的 `play-series` + dismissed 恢复语义） | 需要在 App 层加「跨页打开剧集并播放」的导航（当前 Calendar 只有「查找续集」） |
| `check-compat-lifecycle.cjs`(164) | 在线兼容转码机制（来源权限门槛、锁定集拦截、清缓存通道） | 5.0 的 `transcode` 只接已完成下载；在线转码属能力消失（obsolete）+ 同集去重已补 |
| `check-hongguo-search-ipc.cjs`(147) | 标点模糊补搜、官网 5xx 后自动改走 App 的**通道级**断言 | 逻辑已在 `services/search/orchestrate.ts` 落地并有用例，缺的是入口级等价 |
| `check-merge.cjs`(221) | 合并任务落盘（`store.saveMergeTasks` 无写入者）+ 真实素材逐帧验收 | 落盘是小改动；逐帧验收需要本机 ffmpeg |
| `check-playback-resource-limits.cjs`(146) | 渲染层「超限自动转下载 + 取消等待」、闲置期不重复扫描 | 缓冲上限与文案已覆盖；自动转下载是 UI 功能 |
| `check-player-online-quality.cjs`(118) | 在线清晰度选择器（`Library`/`FloatingPlayer` 现在硬编码 `quality:'auto'`）、分集面板显示 `retryAt/error/actualQuality` | 需要在剧库页加清晰度选择（含持久化）与分集状态渲染 |

## 未完成（按优先级）

> 本节数字随每轮实测更新；最近更新见文末「本轮测试规模」。

1. **旧回归网 27 项**（原 78 项）：**8 项**靠 `vm` 加载 `main.js`（删 `main.js` 的唯一阻塞），
   **24 项**依赖 `src/`（渲染层 jsx 夹具 / `src/native`）。逐文件（行数）：

   ```
   阻塞 main.js（8）
    402 check-app-search-ipc.cjs      221 check-merge.cjs
    315 check-backend-lifecycle.cjs   146 check-playback-resource-limits.cjs
    266 check-calendar-playback.cjs   118 check-player-online-quality.cjs
    164 check-compat-lifecycle.cjs    147 check-hongguo-search-ipc.cjs
   ```

   其余 19 项全部依赖旧渲染层（`src/components` 的 jsx 夹具），包括
   `check-player-resume.cjs`(468)、`check-download-manager.cjs`(280)、
   `check-app-update-ui.cjs`(166)、`check-player-review-2-5.cjs`(120) 等
   （其中 `check-player-resume` 是 ~20 个检查共用的 jsx 夹具，删它要连带处理其余项）。

   本轮又删掉 6 项：`check-renderer-security`、`check-single-instance`、`check-streaming`、
   `check-watch-history-3.7`、`check-watch-history-integration`、`check-macos`
   （前 5 项由新用例完全替代；`check-macos` 的原生菜单/字号缩放/关于面板中，
   菜单本轮补上、字号缩放与关于面板属 P3 能力消失）。

2. **人工验收**（自动化覆盖不到的真机行为）：
   - **媒体链全量重验**：媒体层这一轮是重写的（上一版的实现没进版本库），
     下载/解密/播放/合并/转码/HLS 必须用真实素材重新验收一遍；自动化只证明了行为等价，
     没有证明「这份实现播得出来」；
   - 合并的三个入口（快速/兼容/仅 1080P）与取消在真实剧集上走一遍（尤其「仅 1080P」的拒绝文案）；
   - 自定义源管理：用真实 CMS 接口「测试并保存」一次，再停用/启用/删除各一次（含下载中停用）；
   - 停用自定义源时，正在播放的那一集应停在当前画面（会话被清），并能重新取流；
   - 真实机上的密码保护片源（CENC）与 spade_a 片源的下载与播放（需要能取流的网络环境）；
   - Anime4K 的 WebGPU 实际画面（测试环境无 WebGPU，只验证了前置判断与回退）；
   - 悬浮小窗在真实多屏/全屏应用之上的层叠表现；
   - 全屏快捷键与剪贴板在真实权限策略下可用（本轮刚恢复白名单，需要真机点一次）；
   - 转码与 HLS 合并的画面正确性（当前只有字节数与时长断言）。
3. **旧代码删除**：`main.js` / `src/` / `scripts/` 在 1 完成后删除，
   随后重跑 lint / typecheck / test / e2e / legacy / build / smoke 六道门。
4. **类型收紧的剩余部分**：`packages/sdk` 已开 `strictNullChecks`（0 错），
   但 `noImplicitAny` 仍关（**811 处隐式 any**，需逐参数读懂语义后标注）；
   全量 `strict: true` 实测 **929 错**。`host` 包已全 strict，`shared`/`contract` 为 strict。

## 旧（上一轮遗留，已由上表取代）

以下条目已不再成立，保留仅作演进记录：

1. ~~M4 剩余：合并 / 转码尚未接 IPC~~ → 已接 `merge:start` / `merge:cancel` / `media:transcode`，并有真实素材验收。
2. ~~M3 页面补齐~~ → 9 页全部就位。
3. ~~M4 旧测试替换~~ → 尚未开始（见上方第 1 条）。
4. ~~L4 / M5 / 收紧~~ → 见上方第 2–4 条。

## 许可

**已解决。** 2026-10-29 仓库所有者确认拥有版权或已获全体权利人许可，协议已由 GPL-3.0 改为 **MIT**：
`LICENSE`（MIT 全文 + 权利人）、`NOTICE`（许可、上游署名、变更依据）、`package.json` 的 `license: "MIT"`、
文件头 SPDX 标记、`AGENTS.md` 均已同步。变更依据由仓库所有者作出并担责。

## 阻塞

**无外部阻塞。** 剩余全部是工作量：78 项旧检查迁移、人工验收、旧代码删除、`noImplicitAny` 收紧。

## 迁移后暴露的缺陷清单（按优先级，全部由本轮 8 组迁移挖出，尚未修复）

> 口径：这些是「旧检查断言过、4.5 通过、5.0 不成立」的真实行为差异。迁移时**不删旧检查**就是为了留下记录。
> 修完一批，对应旧检查就能删一批。**状态**列：✅ 本轮已修、⏳ 待修、🧭 需产品确认（能力随实现消失）。

### 已修缺陷（按批：播放器/退出删除 → 搜索接线 → 历史 → 渲染层边界 → 流与资源）

> 每一条都先补了反向用例；对应旧检查在等价覆盖成立后才删。

| # | 缺陷 | 修法 | 新用例 |
|---|---|---|---|
| 1 ✅ | 续播没接线（onSuccess 时 video 还没挂载） | 恢复点移到 `onLoadedMetadata`（`restoreRef`） | `Library.progress.test.tsx`「同一集存过进度时…回到上次秒数并给出提示」 |
| 2 ✅ | 换集不保存上一集进度 | 换集前 `saveCurrentProgress(true)`（不受 5 秒节流限制；播完的那一集不重复写，避免把 watched 写回 false） | 同上「换集前保存上一集的位置」 |
| 3 ✅ | 悬浮小窗集号恒为 1、不续播、无连播 | 小窗自己查分集表：真实 `vidIndex`、`progressGet` 续播、播完自动接下一集（锁定集不接） | `FloatingPlayer.test.tsx` 新增 3 条 |
| 4 ✅ | 晚到取流回复劫持当前集 | 每次请求领序号（`onMutate`），`onSuccess`/`onError` 只认最新一次 | `Library.progress.test.tsx`「晚到的取流回复不劫持当前集」 |
| 5 ✅ | 切集后倍速丢失且界面说谎 | `onLoadedMetadata` 重新应用 `playbackRate`（`speedRef`） | `Library.speed.test.tsx`「换集后新元素的倍速仍是用户选的那一档」 |
| 6 ✅ | 取流失败重试成功后旧提示不清除 | 成功即 `setNotice('')` | `Library.progress.test.tsx`「取流失败后重试成功，旧的失败提示要被清掉」 |
| 7 ✅ | 剧集详情加载失败无声 | 渲染原因 + 「重试」（`episodes.refetch()`） | 同上「分集加载失败时显示原因并可重试」 |
| — ✅ | 悬浮窗打开/收回失败静默且状态不回滚 | try/catch + 提示 + 回滚 `floating` | （浮窗用例已覆盖提示路径） |
| — ✅ | **没真正播放过（自动播放被拦）的暂停也算「看过」** | `playedRef` 记录真实播放；`onEnded` 视为播过，pause 不算 | `Library.progress.test.tsx`「从未真正播放过时，暂停不算看过」 |
| 15 ✅ | 退出清理整条缺失 | 新模块 `main/shutdown.ts`（取消合并 → 停下载 → 断转码 → 有界 10s 等待 → 放行），`before-quit` 接线，`quitInProgress` 改为真状态 | `main/shutdown.test.ts` 4 条 |
| 16 ✅ | `deleteAll` 先删文件后停任务、不清记录、不看正在合并 | 先 `stopAll()` → `partitionTargets` 保护正在合并的源文件 → 删 → 清未受保护任务的记录，返回 `skipped`/`skippedFiles`，设置页如实告知「N 部剧正在合并已跳过」 | `storage/targets.test.ts` 3 条 + `Settings.storage-delete.test.tsx` 1 条 |
| 28 ⏳→部分 ✅ | 转码无法取消 | `transcodeJobs` + `AbortSignal` 接入 `transcodeForCompat`，退出时中断（UI 取消入口仍未做） | `transcode.test.ts` 既有取消用例 |
| 8 ✅ | 搜索页来源选择无效（IPC 丢掉 `source`，`searchPort` 是死代码） | `search:web` 改走 `search` 端口；红果走新编排、其它来源走 `bySource` | `ipc.test.ts`「搜索按来源分流」+ `Search.source.test.tsx` 4 条 |
| 9 ✅ | 目录来源/线路选择无效（`catalog:list` 忽略 `source`/`catalogChannel`，`catalogPort` 死代码） | `catalog:list` 改走 `catalog` 端口（source/channel/cursor 全透传，端口按代理模式决定可信 DNS） | `ipc.test.ts`「目录按来源与线路分流」 |
| 11 ✅ | 观看记录「未看完」筛选空操作、页面看不到秒数、「每剧最近」恒等于全部 | SDK 的 `listHistory` 带出 `duration`；新增纯函数 `filterHistory`（`latest` 用「同家族更高季」判、`unfinished`/`skip-completed-low` 用 `completed` + `duration`）；历史页显示进度秒数、已看完标记与上次检查失败原因 | `watch-history-3.7.test.ts`「filterHistory」5 条 |
| 12 ✅ | 续作刷新会回滚刷新期间的进度保存 | 新增纯函数 `mergeSequelUpdates`：写回前重读当前记录，只合并续作/总量/检查点；刷新期间被删除的记录不复活 | 同上「mergeSequelUpdates」4 条 |
| 13 ✅ | 完成证据没有写入者（`completed` 恒 false） | `progressPort.save` 走 `recordPlayback`：契约加 `ended`，渲染层播完才置 `ended`；`completedEpisode` 因此真正写入 | 同上「recordPlayback 的完成证据」4 条 |
| 39 ✅ | 无「删除单条观看记录」通道 | 新增 `history:remove` 通道 + 历史页「移除记录」（只删记录、保留剧库档案） | `history-ipc.test.ts`「移除单条与时长透传」3 条 |
| — ✅ | 历史取数失败时同时说「还没有观看记录」 | 空态判断加 `!query.isError`（原先钉住的 `it.fails` 已转正） | `History.scope.test.tsx` |
| 10 ⏳→主体 ✅ | App 搜索与「上新补搜」整条编排未接线 | 新模块 `services/search/orchestrate.ts`：App 优先 → 官网兜底 → **官网 5xx 用 App 救场（partial + 原因）** → 首页补一次今日上新（合并去重、`meta.newRelease`/`newReleaseChecked` 分开），三档预算（官网 12.5s / 上新 8.5s / 命中后 3s），翻页钉住线路且必须带游标；搜索页说明结果来源 | `services/search/orchestrate.test.ts` 13 条 + `Search.source.test.tsx` |

### P1 · 用户直接感知（未修）

| # | 缺陷 | 位置 | 对应旧检查 |
|---|---|---|---|
| 1 ✅ | ~~**续播没接线**~~：首播时 `videoRef` 还是 `null`，恢复位置被静默丢弃；`restoredFor` 只赋值从不读取 | `renderer/src/pages/Library.tsx:74-81` | check-player-resume |
| 2 ✅ | ~~换集不保存上一集进度~~（双击/快捷键直接换源，最多丢 5 秒） | `Library.tsx:340-360` | check-player-resume |
| 3 ✅ | ~~**悬浮小窗集号恒为 1**~~（`vidIndex: 1` 写死）→ 观看记录与续播对不上；小窗也不续播、无连播 | `pages/FloatingPlayer.tsx:68,90-92` | check-player-navigation |
| 4 ✅ | ~~**晚到的取流回复会劫持当前集**~~（`onSuccess` 无条件 `setPlaying`） | `Library.tsx:62-83` | check-player-download-state |
| 5 ✅ | ~~切集后倍速丢失且标签仍在说~~「倍速 0.75×」（`key={playing.url}` 重建元素） | `Library.tsx:37,333,359` | check-playback-speed |
| 6 ✅ | ~~取流失败后重试成功，旧错误提示不清除~~ | `Library.tsx:65-83` | check-player-fallback |
| 7 ✅ | ~~剧集详情加载失败完全无声~~（无原因、无重试入口） | `Library.tsx:54-59` | check-player-fallback |
| 8 ✅ | ~~**搜索页来源选择无效**~~：IPC 只走 `sdk.search.web`，`source` 被丢；`searchPort`（`bySource`+20s 预算）是死代码 | `main/ipc.ts:279-281`、`index.ts:713-722` | check-source-integration |
| 9 ✅ | ~~**目录来源/线路选择无效**~~：`catalog:list` 忽略 `source`/`catalogChannel`；`catalogPort.list` 死代码 → 自定义代理下「禁用可信 DNS 直连」既没生效也没被守住 | `main/ipc.ts:290-300`、`index.ts:730-746` | check-catalog |
| 10 ⏳→主体 ✅ | ~~**App 搜索与「上新补搜」整条编排未接线**~~（编排已补，见「本轮已修」；剩分页通道与上新 UI） | `services/search/orchestrate.ts` | check-app-search-ipc / check-hongguo-search-ipc |
| 11 ✅ | ~~观看记录「未看完」筛选是空操作~~（读不到 `duration`）；「每剧最近」恒等于全部；页面永远看不到秒数 | `index.ts:355-369`、`pages/History.tsx:85-87` | check-watch-history-display |
| 12 ✅ | ~~**续作刷新会回滚刷新期间的进度保存**~~（取快照后整条覆盖写回） | `index.ts:653-676` + `history/refresh.ts:93` | check-watch-history-integration |
| 13 ✅ | ~~**完成证据没有写入者**~~（`recordPlayback` 无调用）→ `completed` 恒 false，「已看完的低季不再提示」消失 | `watch-history.ts:55`、`main/index.ts` progressPort | check-watch-history-integration |
| 14 ✅ | ~~分集更新检查/通知缺失（两个开关是死设置，主进程无 `Notification`）~~ | 见「本轮已修」 | check-watch-history-integration |
| 15 ✅ | ~~**退出清理整条缺失**~~：`quitInProgress` 是常量 `false`，全仓无 `before-quit`/`will-quit`，退出时在飞下载/转码/合并不取消 | `index.ts:78,508` | check-backend-lifecycle |
| 16 ✅ | ~~`deleteAll` 不清下载记录~~（与自身注释矛盾）；先删文件后停任务，且完全不看正在进行的合并 | `index.ts:498-503`、`queue.ts:385-392` | check-download-delete-feedback |
| 17 | **选集面板/窗口置顶模块活着但无入口**（无通道、无 UI，功能不可达） | `services/series/episode-panel.ts` | src/native/episode-panel.test.cjs |
| 18 ✅ | ~~便携模式**无条件改写** `--user-data-dir**~~ | `index.ts` | check-single-instance |
| 19 | 公告「开关/确认已读」无入口 → 4.5 升级上来的用户**无法重新打开普通公告**，紧急公告每次轮询重弹 | `contract` 只有 get/dismiss/check | src/native/app-announcements.test.cjs |
| 20 | 播放恢复重开丢清晰度（`withMediaRecovery` 不传 `quality`） | `services/media/stream.ts:244,322,384` | check-player-online-quality |

### P1 遗留（第 3 组尚未做的部分）

- **搜索分页**：契约与界面都没有「下一页」入口（4.5 有 `search-series-more` + 游标）。
  SDK 编排已支持 `page`/`cursor`/`channel` 并有用例，缺的是通道与 UI。
- **上新结果的展示**：结果里已带 `new_release`/`released_today` 标记，界面只显示「含 N 部今日上新」，
  没有分组或角标；补搜到的条目与主搜混排。
- **目录线路切换**：`catalogChannel` 已透传到端口，但发现页没有「App / 官网」切换入口。

### P2 · 正确性/资源（不一定立刻可见）

| # | 缺陷 | 位置 |
|---|---|---|
| 21 ✅ | ~~并发兼容转码无 in-flight 去重~~ | `services/media/transcode.ts` |
| 22 | `pipeToFile` 的 `maxBytes` 把 `MEDIA_TOO_LARGE` 吞成可重试错误（队列会反复重拉） | `services/media/transfer.ts:465,479-482` |
| 23 | 在线缓冲上限可被 `Infinity` 关掉；加密会话失败/超限时临时目录要等 dispose 才清 | `stream.ts:234`、`stream.ts:282` |
| 24 ✅ | ~~主窗口只守 `will-navigate`，缺 `will-redirect`；`file:` 一律算应用自身；外部链接点了没反应~~ | `index.ts`、`navigation-policy.ts` |
| 25 ✅ | ~~启动失败只 `logger.warn` 不提示~~（现在弹一次原生提示并说明保存会失败） | `index.ts` |
| 26 | `cleanupMergeTemps` 是死代码（宿主从不调用）→ 上次中断的 `.merge-*` 目录不清理 | `services/media/merge.ts:98` |
| 27 | 合并任务不落盘（`store.saveMergeTasks` 无调用者），跨重启记录丢失 | `store.ts` |
| 28 | 在线兼容转码能力整体消失（无权限门槛/锁定拦截/同集去重/清缓存）；`transcodePort` 不传 `AbortSignal` → **转码无法取消** | `index.ts:254-267`、`transcode.ts:94-165` |
| 29 | 剧库无法由界面登记新剧（`libraryAdd` 无调用方），空库文案却在教用户这么做 | `renderer/src/lib/api.ts:42`、`Library.tsx:448` |
| 30 | 关闭弹幕仍会请求弹幕接口；开关不落盘 | `Library.tsx:87-106` |
| 31 | `api.updateCancel` 无调用方：用户取消不了正在进行的更新下载 | `renderer/src/lib/api.ts:87` |
| 32 | `downloadRemove` 对不存在的任务返回 `ok:true`（渲染层无法显示失败） | `main/ipc.ts:334-340` |
| 33 ✅ | ~~取数失败时把失败与「没有记录」同时显示~~ | `pages/History.tsx` |
| 34 | 第二次启动在主窗口已关闭时不重建窗口（4.5 会重建） | `index.ts:987` |
| 35 | `pending` 任务启动即自动续跑（4.5 明确不自动续跑） | `queue.ts:362` |
| 36 | 显式清晰度信任「标签 1080p」且尺寸未知（4.5 会拒绝；文案却仍写「尺寸可确认」） | `ticket.ts:1176`、`shared/quality.ts:26-31` |
| 37 | 分集按钮聚焦时空格不再暂停播放（让位规则变更） | `lib/shortcuts.ts:130-137` |
| 38 | 同家族重复搜索：3 季记录 = 3 次同关键词搜索（4.5 只搜 1 次） | `history/refresh.ts:70-108` |
| 14 ✅ | 分集更新检查/通知缺失（两个开关是死设置，无 Notification） | `refresh` 现在真的查分集总量（`applyEpisodeUpdate` 写回 `knownTotal/unreadEpisodes`）；新增纯函数 `planUpdateNotifications`（分集按总量、续作按编号去重，提醒≠已读）+ 主进程发系统通知；`watch_updates_enabled` 控制 6 小时后台检查（启动 30s 后一次） | `notifications.test.ts` 8 条 + `refresh` 单剧用例 |
| — ✅ | 单行重检 / 后台定时检查缺失 | `history:refresh` 支持 `seriesId`（忽略 24 小时检查点）；历史页每行「检查更新」；主进程 6 小时定时 + 启动后一次 | `history-ipc.test.ts` 新增 3 条 |
| 24 ✅ | 主窗口缺 `will-redirect`、`file:` 一律可信、外部链接点了没反应 | 导航上下文带 `appFiles`（只认渲染入口文件）；主窗口补 `will-redirect`；`HostServices` 正式暴露 `openExternal` | `navigation-policy.test.ts` 14 条 + `app-lifecycle.test.ts` 三条缺口转正 |
| 18 ✅ | 便携模式无条件改写 `--user-data-dir` | 显式 `--user-data-dir` 时跳过便携迁移 | `app-lifecycle.test.ts` 2 条（伪装 win32 + 临时目录） |
| 25 ✅ | 启动失败只 `logger.warn` | `store.readError()` 暴露给宿主；读盘失败弹一次原生提示（说明「保存会失败」），不静默带病运行 | `app-lifecycle.test.ts` 2 条 |
| 21 ✅ | 并发兼容转码无 in-flight 去重 | `transcodeForCompat` 按输出路径共享在飞任务；`force` 等前一个跑完再重来（避免两个 ffmpeg 抢同一个 `.part`） | `transcode.test.ts` 2 条 |
| — ✅ | 无应用菜单（macOS 的 Cmd+C/V 不生效） | 装标准编辑/视图/窗口菜单（只给 role，不放自定义动作） | `app-lifecycle.test.ts` 1 条 |
| 39 ⏳→部分 ✅ | ~~无「删除单条观看记录」通道~~（已加 `history:remove`）；搜索历史/日历记录控件仍缺 | contract |
| 40 | 合并界面缺「正在合并的剧集被跳过 + warning」提示 | `index.ts` mergeRuns |

### P3 · 需产品确认的「能力随实现消失」（obsolete，不是缺陷）

- 字号缩放与窗口布局（`fitWindowBounds`/`getWindowScale`/`saveWindowZoom`、`ui_zoom` 设置）
- macOS 原生菜单、关于面板两段式版本
- 预览/体验版发行形态（预览目录隔离）
- 隐身窗（后台抓取）——5.0 改走 HTTP，已确认不再需要
- 弹幕全屏层的实现细节（RAF/ResizeObserver）、官/评论来源切换、弹幕字号透明度屏蔽词设置
- 4.5 常驻播放器结构（后台保留播放、`active` 属性、迟到 prepare/retry 语义）
- 下载页批量选择与跨页选择、更多操作菜单、合并选择器弹窗、分页 100 条
- 日历点击播放与 `play-series`/dismissed 恢复语义、续作红点确认（`acknowledge`）
