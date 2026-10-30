# 红果短剧项目规则

## 视频测试素材与声音

- 用户于 2026-10-29 明确要求：测试视频须在红果短剧中随机选择并真实下载；禁止使用彩条视频测试。
- 播放、画中画、连播和自动删除验收必须使用上述真实下载素材，不得用彩条或测试图替代。
- 测试全程静音，不得让测试视频发出声音；开始播放前先确认静音状态。
- 使用独立测试资料和下载目录。自动删除只针对本轮测试下载，不影响正式应用的视频、账号或记录。
- 在项目内记录测试素材来源、步骤、结果和限制；不得记录登录凭据或带签名的媒体地址。

## 4.5 发行

- 发现页“换一批”沿当前来源和分类的真实分页；不打乱来源榜单。
- 真人剧、漫剧、AI剧及题材按钮重复点击也需换批；仅四个热播榜保持热度顺序。
- 本轮发行、验证及限制见 `docs/release-4.5.md`。

## 5.0 重构（dev 分支）

- 技术栈：pnpm workspace 多包 + TypeScript 7 + React 19 + Vite 8 + Biome + Tailwind v4 + shadcn 风格组件；只做 Electron 桌面端。
- 目录：`apps/desktop`（main / preload / renderer）、`packages/{shared,contract,host,host-fake,sdk,ui}`。
- 依赖铁律：`sdk` 与 `shared` 不得 import `electron`；`renderer` 不得 import `electron` 或 `host`；
  `contract/channels.ts` 不得引入 zod（preload 只依赖它）。
- 命令：`pnpm install` 装依赖；`pnpm typecheck`（`tsc -b`）、`pnpm lint`（Biome）、`pnpm test`（Vitest）三道门必须全绿。
  旧 4.5 检查脚本用 `pnpm legacy:test` 跑，M4 前保留。
- 新增能力必须带测试：纯逻辑 → L1（直接 import）；IPC/装配 → L2（注入 `host-fake`，不要在测试里起真窗口）。
- 迁移中的旧实现（`main.js` / `src/` / `scripts/`）在 M4 完成前不得删除；改动逻辑时优先迁进 SDK 再改。
- 协议：**MIT**（2026-10-29 由 GPL-3.0 变更，依据为仓库所有者确认拥有版权或已获全体权利人许可）。上游署名与来源说明保留在 `NOTICE`，第三方组件许可见 `THIRD-PARTY-NOTICES.md`。新增文件用 `SPDX-License-Identifier: MIT`。
- 进度与阻塞见 `docs/refactor-status.md`，执行依据见 `docs/refactor-plan.md`。
