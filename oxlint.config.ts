import { defineHopeConfig } from "oxc-config-hope/oxlint";
import type { OxlintConfig } from "oxc-config-hope/oxlint";

const oxlintConfig: OxlintConfig = defineHopeConfig(
  {
    ignore: ["**/dist/**", "**/coverage/**", "**/.agents/**", "**/node_modules/**"],
    options: {
      // 类型检查交给 `pnpm typecheck`（core/io/cli 用 tsc，web 用 vue-tsc）。
      // oxlint 的 typeCheck 走的是原生 TS 编译器，认不出 `.vue` 导入，
      // 会在 web 包里报一堆 TS2307 假阳性，所以这里关掉、只保留 typeAware 的规则。
      typeCheck: false,
      // 预设默认 denyWarnings + maxWarnings:10。本仓的风格与预设不同，
      // 存量 warning 有几十条，让它们阻断 CI 没有意义：error 阻断，warning 只提示。
      denyWarnings: false,
      maxWarnings: 100_000,
    },
    rules: {
      complexity: "off",
      "max-depth": ["warn", 5],
      // 求解器里不少函数就是参数多、语句长，拆开反而更难读
      "max-params": ["warn", 6],
      "max-statements": "off",
      "max-lines-per-function": "off",
      "no-plusplus": "off",
      "require-unicode-regexp": "off",

      // —— 下面这些是「本项目的既定风格」与预设的冲突，逐条说明理由 ——
      // 预设会强制把 catch 参数改名为 err，`oxlint --fix` 曾因此把
      // `catch (error) { const err = error }` 改成 `catch (err) { const err = err }`，
      // 制造出 TDZ 运行时错误。这条规则纯风格，关掉。
      "unicorn/catch-error-name": "off",
      // core 刻意用函数声明（提升 + V8 内联友好），不用箭头函数
      "func-style": "off",
      // 求解器热循环里大量 i/j/s/a/b 这类短名
      "id-length": "off",
      // 开了 noUncheckedIndexedAccess，取值后必须断言；`!` 是这里最清晰的写法
      "typescript/no-non-null-assertion": "off",
      "typescript/explicit-function-return-type": "off",
      // 只给公开 API 写 jsdoc，不要求每个函数都补 @param/@returns
      "jsdoc/require-param": "off",
      "jsdoc/require-returns": "off",
      // 单行 guard 是热路径里的常规写法
      curly: "off",
      // undefined 在本项目里是有意使用的（例如「不限考场」）
      "no-undefined": "off",
      // 求解器用 `>> 1` 做快速折半、用位运算判奇偶
      "no-bitwise": "off",
      // 求解器里的工具函数互相递归，声明顺序不等于使用顺序
      "no-use-before-define": "off",
      "no-shadow": "off",
      // 对原始值用 toBe 是刻意的
      "vitest/prefer-strict-equal": "off",
      "vitest/no-conditional-in-test": "off",
      "unicorn/prefer-single-call": "off",
      // core 保证零 Node 依赖，但 scripts/ 和 io 的 node 子路径本来就要用
      "import/no-nodejs-modules": "off",
    },
  },
  {
    // 算法内核是密集的数值循环，性能优先：关掉一批「写起来更优雅但更慢」的风格规则
    files: ["packages/core/src/**", "packages/io/src/**"],
    rules: {
      "prefer-destructuring": "off",
      "prefer-object-spread": "off",
      "prefer-spread": "off",
      "typescript/prefer-for-of": "off",
      "unicorn/prefer-array-flat": "off",
      "unicorn/prefer-code-point": "off",
      "unicorn/prefer-spread": "off",
    },
  },
  {
    // 脚本、示例与构建配置：允许直接 process.exit / console
    files: ["scripts/**/*.ts", "examples/**/*.mjs", "*.config.ts"],
    rules: {
      "no-console": "off",
      "unicorn/no-process-exit": "off",
    },
  },
  {
    files: ["**/test/**/*.ts"],
    rules: {
      "vitest/max-expects": ["warn", { max: 16 }],
    },
  },
);

export default oxlintConfig;
