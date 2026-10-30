# tooling

- 迁移期脚本已删除：`src/native/*.js` → `packages/sdk/src/**/*.ts` 的转换由一次性 codemod 完成，
  过程与策略记录在 `docs/refactor-plan.md` 第 15 节；需要追溯时看 git 历史。
- 旧 4.5 回归网仍在 `scripts/`（`pnpm legacy:test`），M4 完成后按域替换为 Vitest 用例。
