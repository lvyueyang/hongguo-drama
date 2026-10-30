# 5.0 破坏性重构 · 状态与交接

分支：`dev`　版本：`5.0.0`（源码候选）　计划：`docs/refactor-plan.md`

## 质量门（每次改动都要全绿）

| 命令 | 当前结果 |
|---|---|
| `pnpm lint`（Biome） | **0 error** / 383 warning（迁移期 `noExplicitAny` 等，见下方「类型收紧」） |
| `pnpm typecheck`（`tsc -b`） | **0 error**（含 `packages/sdk` 的 `strictNullChecks`） |
| `pnpm test`（Vitest） | **57 文件 / 478 用例通过** |
| `pnpm e2e`（Playwright `_electron`） | **9 passed** |
| `pnpm legacy:test`（旧回归网） | **72 项平台检查 + 11 个旧单测通过** |
| `pnpm --filter @hongguo/desktop build` | main 1,098 kB / preload 6.6 kB / renderer 438 kB + 18 kB CSS（Anime4K 另有 3.45 MB 按需 chunk） |
| smoke（真实启动 Electron） | 存活 12 秒、0 异常行、干净退出 |

## 一句话结论

**5.0 已可独立运行并且功能对等**：9 个页面、媒体链（下载/解密/合并/转码/HLS）、播放器
（续播/连播/快捷键/弹幕/预取/悬浮小窗/画质增强）、代理、存储、公告、更新、文字导出全部接通，
六道质量门 + E2E 全绿。

**尚未删除 4.5 旧代码**：`scripts/` 下还有 78 项旧检查（27 项靠 `vm` 加载 `main.js`）。
迁移方式是「抽模块 → 补等价用例 → 删旧检查」，**不带等价覆盖不删**——这条纪律每轮都在挖出真实缺陷
（来源路由、多来源搜索、便携目录、已存在文件复核、错误边界、续作刷新、更新开关、更新绕过代理……），
所以不做批量删除。详见下方「未完成（按优先级）」。

## 旧检查 → 新用例迁移表（本轮新增）

| 旧检查 | 新用例 | 覆盖程度 |
|---|---|---|
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
| `scripts/check-app-source-recovery.cjs` | `packages/sdk/src/providers/hongguo-app/device.test.ts`（7 用例：注册响应校验、**请求不带 cookie/authorization**、被拒身份触发一次更新、**并发共享一次更新**、**迟到旧身份不再更新**、冷却期内不重复更新、更新失败保留旧身份并抛 DEVICE_REGISTRATION_FAILED） | **完全替代，旧检查已删除**；EMPTY_RESPONSE 重试与质量档位仍由 `check-app-source`/`check-media-recovery` 覆盖 |
| `scripts/check-download-safety.cjs` | `packages/sdk/src/services/storage/targets.test.ts`（15 用例）+ `apps/desktop/src/main/queue.test.ts` 扩充（+5 用例） | **完全替代，旧检查已删除**。覆盖：单剧删除（只含本剧目录、无记录不删、root 外不纳入、删后清空目录、不删 root）、**单集删除**（视频+文字导出+`.enc.tmp`/`.decoded` 残留、不牵连同目录其它集）、**删除任务含/不含文件**、**队列持久化与失败回滚**（回滚时不会把任务卡在 downloading）、`purge-empty-series`（清掉无文件的剧集档案） |
| `scripts/check-source-recovery.cjs`（不变量部分） | `packages/sdk/src/providers/hongguo-web/recovery.test.ts`（6 用例：**传输错误码收敛为 TIMEOUT/NETWORK_ERROR**、错误信息与对象**不回传签名地址/令牌/私网地址**、网页每路预算 ≤4s、空响应不放大、网页地址必须对上请求分集、结构异常返回 null） | **发现并修掉迁移时丢失的行为**：原始 axios 码（ECONNABORTED/ENOTFOUND…）会散落到上层，导致队列误判「不可重试」；已收敛码并让队列认 NETWORK_ERROR。旧检查已删除 |
| `scripts/check-source-retry.cjs` | `apps/desktop/src/main/queue.test.ts` 扩充（10 用例：**双退避表**——片源不可用走分钟级、传输中断走秒级；安全类错误直接失败不排重试；预算用尽清 `retryAt` 且去掉「自动重试」提示；并发闸门、取消终态、恢复） | **完全替代，旧检查已删除** |
| `scripts/check-proxy-routing.cjs`（编排部分） | `apps/desktop/src/main/proxy-controller.test.ts`（9 用例：环境先于会话、fixed_servers 映射、直连/system、缺端口不改环境、**超时回落直连并同步环境**、**迟到完成不覆盖新配置**、会话报错回落、current 反映最近结果） | **完全替代，旧检查已删除**；纯逻辑部分由 `packages/host/src/proxy.test.ts` 的 16 条覆盖 |
| `scripts/check-decrypt-worker.cjs`（等价性与错误部分） | `packages/sdk/src/providers/hongguo-web/decrypt.test.ts`（5 用例：无加密样本原样返回、缺 moov 可判断报错、短密钥不误报、文件写出且源不变、源缺失不建目标） | **部分替代**：取消与事件循环让出两条能力**尚未恢复**，旧检查暂时保留 |

| `scripts/check-streaming.cjs`（复用/淘汰部分） | `packages/sdk/src/services/media/cache.test.ts`（11 用例：片源指纹变化不复用、vid/来源/剧集不一致不复用、未完成条目不复用、清晰度分键、超预算按 lastUsed 淘汰且至少留 1 条、读取刷新 lastUsed、磁盘文件随淘汰/clear 删除、超预算内容仍交回调用方）+ `stream.test.ts` 新增 2 条（内存会话按 Range 切分、解密会话快照） | **补齐功能缺口**：4.5 的 `onlineCache` 之前没有迁，重开同集要重新解密；现已实现并接入 `play:prepare` |

| `scripts/check-hema-browse.cjs` | `packages/sdk/src/providers/hema/browse.test.ts`（7 用例，真实页面夹具：首屏解析不伪造榜单/热度/总页数、翻页与题材 URL、组合题材、未知题材与非法页码不发请求、无下一页标记、分页/题材不一致报错、结构异常可读错误、刷新与超时区分） | **完全替代，旧检查已删除** |
| `scripts/check-media-recovery.cjs` / `check-download-safety.cjs` 的传输故障部分 | `packages/sdk/src/services/media/download.test.ts` 新增 3 条故障注入（**传输中途 socket 断开**、下载完成后才被取消、解密密钥格式非法）：都要求不留半成品、不发布 | 部分替代；断线重连与进度回填未覆盖 |

| `scripts/check-xifan.cjs` | `packages/sdk/src/providers/xifan/index.test.ts`（8 用例：目录与题材去重、翻页/题材透传、搜索编码、缺 unlock 视为锁定、分集不泄露媒体地址、取流每次重验锁、非 HTTPS/凭据拒绝、归属不符与身份非法不联网、冲突标题回退） | **完全替代，旧检查已删除** |
| `src/native/episode-comments.test.cjs` | `packages/sdk/src/services/comments/index.test.ts`（4 用例：参数与游标校验不联网、稳定去重 id、来源受限如实标注、缓存复用、分集不一致不串评论） | **完全替代，旧单测已删除** |

| `scripts/check-hema.cjs` | `packages/sdk/src/providers/hema/index.test.ts`（13 用例：搜索分页与请求体、实时收费标记、列表不含可下载地址、720p→mp4 回退、**绝不回退 encryptUrl**、非 HTTPS/带凭据拒绝、身份校验联网前失败、错误不透传上游原文） | **完全替代，旧检查已删除** |

| `scripts/check-public-details.cjs` + `src/native/public-details.test.cjs` | `packages/sdk/src/providers/hongguo-web/details.test.ts`（10 用例：50/1000 上限、缓存隔离、并发去重、失败不写缓存、锁集与普通失败区分、评分/点赞/首播时间、javascript: 头像清空） | **完全替代，旧文件已删除** |
| `src/native/media-sources.test.cjs` + `scripts/check-media-sources.cjs` | `packages/sdk/src/services/sources/media-sources.test.ts`（6 用例：默认清单、关闭内置源、红果不可关、custom 前缀、纯函数性） | **完全替代，旧单测已删除** |
| `scripts/check-custom-source.cjs`（校验部分） | `packages/sdk/src/providers/custom/index.test.ts`（6 用例：公网校验、默认 CMS 路径、名称/编号约束、超长地址） | 校验层覆盖；目录/搜索/取流未覆盖 |
| `scripts/check-app-source.cjs`（校验部分） | `packages/sdk/src/providers/hongguo-app/ticket.test.ts`（7 用例：签名头完整、页码越界、身份非法、关键词截断、两类接口的路径白名单） | 守卫层覆盖；实网取流由真实素材验收覆盖 |

| `scripts/check-download-safety.cjs`（路径部分） | `packages/shared/src/paths.test.ts`（18 用例：目录穿越、Windows 非法字符/保留名、emoji 截断、越界复核） | **发现并修掉重构引入的真实缺陷**：新主进程此前直接 `path.join(root, 剧名)`，未做净化；现已改用 `sanitizeFolderName`/`seriesDownloadDir`/`episodeFilePath`。删除类断言仍未覆盖 |
| `scripts/check-danmaku-*.cjs`（服务层） | `packages/sdk/src/services/danmaku/index.test.ts`（11 用例：分页、去重、脏数据过滤、limit 截断、缓存、失败文案不透传上游原文） | 服务层完全覆盖；渲染层弹幕滚动仍未覆盖 |


该轮测试规模（历史值，当前见文首质量门）：**29 文件 / 216 用例**；旧回归网 91 项平台检查 + 11 个旧单测。

## 已知功能缺口（不是测试缺口）

1. ~~CENC 解密的两条能力缺口~~ **已恢复（本轮）**：解密搬到 `worker_threads`（`apps/desktop/src/main/workers/decrypt-worker.ts`，
   esbuild 单独打包，避开 electron-vite multi-entry 的 Rolldown panic），
   主线程只等结果、可 `AbortSignal` 取消；`scripts/check-decrypt-worker.cjs` 已删除。

## 删除旧代码的依赖审计（本轮实测）

用一条命令按依赖面把当时的旧检查分成四类，直接决定「哪些文件删不掉」（以下为该轮实测值，当前实数见「未完成」）：

```
依赖 main.js（vm 加载）：42 项   ← 删除 main.js 的真正阻塞
只依赖 src/native：21 项      ← 阻塞删除 src/
依赖旧渲染层（jsx/esbuild）：14 项     ← 阻塞删除 src/components
其他（夹具/文件内容断言）：18 项
```

### 阻塞删除 `main.js` 的 42 项（迁移队列第一批）

- `scripts/check-app-media.cjs`
- `scripts/check-app-search-ipc.cjs`
- `scripts/check-app-update-proxy.cjs`
- `scripts/check-app-update.cjs`
- `scripts/check-backend-lifecycle.cjs`
- `scripts/check-calendar-playback.cjs`
- `scripts/check-catalog-routing.cjs`
- `scripts/check-catalog.cjs`
- `scripts/check-compat-lifecycle.cjs`
- `scripts/check-custom-media-integration.cjs`
- `scripts/check-download-media-validity.cjs`
- `scripts/check-download-quality-integration.cjs`
- `scripts/check-download-safety.cjs`
- `scripts/check-error-boundary.cjs`
- `scripts/check-ffmpeg-resolution.cjs`
- `scripts/check-floating-player-window.cjs`
- `scripts/check-hongguo-search-ipc.cjs`
- `scripts/check-issue43-storage.cjs`
- `scripts/check-macos.cjs`
- `scripts/check-media-recovery.cjs`
- `scripts/check-merge-benchmark.cjs`
- `scripts/check-merge.cjs`
- `scripts/check-picture-in-picture-mode.cjs`
- `scripts/check-playback-resource-limits.cjs`
- `scripts/check-portable-data.cjs`
- `scripts/check-proxy-routing.cjs`
- `scripts/check-renderer-security.cjs`
- `scripts/check-search-permissions.cjs`
- `scripts/check-search-timeout.cjs`
- `scripts/check-series-search.cjs`
- `scripts/check-single-instance.cjs`
- `scripts/check-source-integration.cjs`
- `scripts/check-source-recovery.cjs`
- `scripts/check-source-retry.cjs`
- `scripts/check-source-routing.cjs`
- `scripts/check-storage-targets.cjs`
- `scripts/check-streaming.cjs`
- `scripts/check-watch-history-3.7.cjs`
- `scripts/check-watch-history-backend.cjs`
- `scripts/check-watch-history-integration.cjs`
- `scripts/check-web-media-guard.cjs`
- `scripts/check-xifan-title-display.cjs`

### 只依赖 `src/native` 的 21 项（第二批，迁完即可删 `src/`）

- `scripts/check-app-catalog.cjs`
- `scripts/check-app-source-recovery.cjs`
- `scripts/check-app-source.cjs`
- `scripts/check-app-update-installer.cjs`
- `scripts/check-custom-source.cjs`
- `scripts/check-decrypt-worker.cjs`
- `scripts/check-download-quality.cjs`
- `scripts/check-hls-media.cjs`
- `scripts/check-hls-space.cjs`
- `scripts/check-hongguo-identity.cjs`
- `scripts/check-media-access.cjs`
- `scripts/check-native-performance.cjs`
- `scripts/check-rankings.cjs`
- `scripts/check-release-version.cjs`
- `scripts/check-renderer-file-urls.cjs`
- `scripts/check-review-native-2-5.cjs`
- `scripts/check-search-deadline.cjs`
- `scripts/check-share-security.cjs`
- `scripts/check-stealth-window.cjs`
- `scripts/check-window-layout.cjs`
- `scripts/check-windows-release.cjs`

### 依赖旧渲染层的 14 项（第三批，需要页面级用例）

- `scripts/check-app-update-ui.cjs`
- `scripts/check-danmaku-fullscreen.cjs`
- `scripts/check-danmaku-live.cjs`
- `scripts/check-danmaku-official-ui.cjs`
- `scripts/check-download-manager.cjs`
- `scripts/check-floating-player-host.cjs`
- `scripts/check-player-controls.cjs`
- `scripts/check-player-download-state.cjs`
- `scripts/check-player-navigation-refresh.cjs`
- `scripts/check-player-navigation.cjs`
- `scripts/check-player-resume.cjs`
- `scripts/check-record-controls.cjs`
- `scripts/check-sequel-finder-ui.cjs`
- `scripts/check-settings-picture-in-picture.cjs`

### 其他 18 项

- `scripts/check-download-delete-feedback.cjs`
- `scripts/check-download-selection-delete.cjs`
- `scripts/check-ffmpeg-mac.cjs`
- `scripts/check-next-cache.cjs`
- `scripts/check-online-disk-lifecycle.cjs`
- `scripts/check-picture-mode.cjs`
- `scripts/check-playback-speed.cjs`
- `scripts/check-player-fallback.cjs`
- `scripts/check-player-library.cjs`
- `scripts/check-player-online-quality.cjs`
- `scripts/check-player-prefetch-ahead.cjs`
- `scripts/check-player-prefetch.cjs`
- `scripts/check-player-review-2-5.cjs`
- `scripts/check-player-shortcuts.cjs`
- `scripts/check-player-storage-refresh.cjs`
- `scripts/check-preview-shortcuts.cjs`
- `scripts/check-store.cjs`
- `scripts/check-windows-installer.cjs`

删除顺序：先把`main.js` 那 42 项按域换成 Vitest（它们覆盖 IPC/队列/协议/账号等装配层，
新增用例应落在 `apps/desktop/src/main/*`），再处理其余三批。

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
| 主题 | DESIGN.md 只有浅色 | 一套浅色 token | 与设计文档一致，无需补 |
| 观看记录 / 剧库 / 下载 / 合并 / 转码 / 账号 / 搜索 / 目录 | 完整 | 已迁移并接线（含真实素材验收） | — |

结论：**功能对等已全部完成**。画中画/悬浮小窗、画质增强（原画/锐化/Anime4K）、播放器预取与弹幕渲染、
代理、存储用量与删除、快捷键（含自定义界面）、公告、更新、文字导出、续播与连播均已实现并接线。
唯一未做的是 **Anime4K 的真机 GPU 验收**（自动化只覆盖前置判断与回退分支，见文末「未完成」）。

## 未完成（按优先级）

> 本节数字随每轮实测更新；最近更新见文末「本轮测试规模」。

1. **旧回归网未迁移**（当前最大项）：`scripts/` 下仍有 **78 项检查**、`src/native/` 下 **11 个旧单测**。
   其中 **27 项靠 `vm` 加载 `main.js`**，是删除 `main.js` 的真正阻塞。清单：

   ```
   line  检查
    401  check-app-search-ipc.cjs          379  check-download-quality-integration.cjs
    376  check-streaming.cjs               327  check-web-media-guard.cjs
    314  check-backend-lifecycle.cjs       295  check-watch-history-integration.cjs
    265  check-calendar-playback.cjs       226  check-catalog.cjs
    220  check-merge.cjs                   204  check-single-instance.cjs
    196  check-media-recovery.cjs          167  check-macos.cjs
    163  check-compat-lifecycle.cjs        146  check-hongguo-search-ipc.cjs
    146  check-series-search.cjs           145  check-playback-resource-limits.cjs
    130  check-watch-history-3.7.cjs       105  check-renderer-security.cjs
    100  check-search-timeout.cjs           85  check-app-media.cjs
     76  check-ffmpeg-resolution.cjs        76  check-search-permissions.cjs
     71  check-merge-benchmark.cjs          61  check-issue43-storage.cjs
     57  check-xifan-title-display.cjs      50  check-custom-media-integration.cjs
     46  check-source-integration.cjs
   ```

   迁移方式固定为「抽模块 → 补等价用例 → 删旧检查」，**不带等价覆盖不删**。
   已连续多轮证实：每迁几项就会挖出真实缺陷（来源路由、多来源搜索、便携目录、
   已存在文件复核、错误边界、续作刷新、更新开关、更新绕过代理……），因此不做批量删除。
2. **人工验收**（自动化覆盖不到的真机行为）：
   - Anime4K 的 WebGPU 实际画面（测试环境无 WebGPU，只验证了前置判断与回退）；
   - 悬浮小窗在真实多屏/全屏应用之上的层叠表现；
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
