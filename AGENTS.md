# exam-seat · Agent 工作须知

> 网络代理等**本机环境事实**写在用户级 `$DSH_HOME/AGENTS.md` 里，不在本项目内重复。

## 技术栈版本约定

| 项         | 版本                                      | 说明                                                 |
| ---------- | ----------------------------------------- | ---------------------------------------------------- |
| Node       | ≥ 22.12                                   | 本机 v24                                             |
| pnpm       | 12.x                                      | 本机 12.7.0                                          |
| TypeScript | **6.0.x**                                 | **不要升到 7**，Vue 工具链目前只支持到 6             |
| 构建       | tsdown                                    | **不要用 tsup**                                      |
| 测试       | Vitest 5                                  |                                                      |
| Web        | Vue 3.5 + Vite 8 + Pinia 4 + Element Plus |                                                      |
| Excel      | SheetJS 0.20.3（vendored）                | **不要用 npm 上的 `xlsx`**，那个停在 0.18.5 且有漏洞 |

## SheetJS 特别说明

npm registry 上的 `xlsx` 停留在 0.18.5，有已知漏洞。官方最新版（0.20.3）只在自己的 CDN 发布。

本项目采用官方推荐的 **vendoring**：tarball 已放在 `vendor/xlsx-0.20.3.tgz`（sha256 `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`），依赖写 `file:../../vendor/xlsx-0.20.3.tgz`。

**不要**改成从 CDN URL 直接依赖，也不要改成 npm 版本。

## 项目结构

```
packages/core   @exam-seat/core   零依赖算法包（浏览器/Node 通用）
packages/io     @exam-seat/io     Excel 读写
packages/cli    @exam-seat/cli    命令行 exam-seat
packages/web    @exam-seat/web    Vue 3 单页应用
.agents/skills/exam-seating/      AI 用的项目级 skill
docs/design.md                    设计方案
vendor/                           SheetJS tarball
```

## 测试

从仓库根跑 `pnpm test`（= `vitest run`）。根 `vitest.config.ts` 用 **vitest projects** 分成两个 project：

| project | 覆盖                                       | 环境                           |
| ------- | ------------------------------------------ | ------------------------------ |
| `node`  | `packages/{core,io,cli}/test/**/*.test.ts` | `node`                         |
| `web`   | `packages/web/test/**/*.test.ts`           | `jsdom` + `@vitejs/plugin-vue` |

测试直接跑 `src`（靠 alias 把 `@exam-seat/core` 指到 `packages/core/src/index.ts`），**不需要先构建**。

`jsdom` 与 `@vitejs/plugin-vue` 声明在**仓库根**：pnpm 是隔离模式的，根配置 import 不到 `packages/web` 里的依赖。**不要在 web 包里再建 vitest 配置**，从根跑不会用到。

## 代码风格与提交

| 用途     | 命令 / 文件                                                          |
| -------- | -------------------------------------------------------------------- |
| 检查     | `pnpm lint:check`（= `oxlint && oxfmt --check`）                     |
| 自动修   | `pnpm lint`（= `oxlint --fix && oxfmt`）                             |
| 配置     | `oxlint.config.ts`、`oxfmt.config.ts`，都基于 `oxc-config-hope` 预设 |
| 提交信息 | `scripts/verifyCommit.ts`，由 husky 的 `.husky/commit-msg` 调用      |
| 提交前   | `.husky/pre-commit` → `nano-staged`（只处理改动文件）                |

**commit message 格式**：`<type>(<scope>): <subject>`
`type` ∈ feat/fix/docs/style/refactor/perf/test/workflow/build/ci/chore/types/release；
`scope` 可选，给了必须是 `core`/`io`/`cli`/`web`/`deps`/`release`；subject 1–50 字。

### 关于 oxlint 配置的两条经验（别踩回去）

1. **`options.typeCheck` 是关掉的。** 类型检查走 `pnpm typecheck`（web 用 `vue-tsc`）。
   oxlint 的 typeCheck 用原生 TS 编译器，认不出 `.vue` 导入，会在 web 包报一堆 TS2307 假阳性。
2. **`unicorn/catch-error-name` 是关掉的。** 预设会强制把 catch 参数改名成 `err`，
   `oxlint --fix` 曾因此把 `catch (error) { const err = error }` 改成 `catch (err) { const err = err }`，
   制造出 TDZ 运行时错误。**改动 oxlint 配置后务必跑一次 `pnpm verify`**。

## 铁律

1. `packages/core` **保持零运行时依赖**，不 import `node:*`、不碰 DOM。
2. 求解结果**同输入同 seed 必须完全一致**，这是可复现性的底线。
3. 求解器只用 `PlanResult.diagnostics` 表达业务失败，**不用抛异常**。
4. 导出前必须跑 `validate()`——校验器与求解器分开实现，不许自证。
