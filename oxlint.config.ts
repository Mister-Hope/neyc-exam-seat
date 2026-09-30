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
      // SheetJS（vendor 的 xlsx）的官方用法就是命名空间导入，对 CJS 包改用具名导入
      // 互操作不可靠；io / examples 里全程 `XLSX.utils.*`，保持命名空间更稳
      "import/no-namespace": "off",
      // 项目里有两处**刻意**做 JSON 往返：job-contract 测试要证明 job 是纯 JSON 可序列化，
      // web 的 json-patch 只接受 JSON 值。structuredClone 语义更宽（保留 Date/Map 等
      // 非 JSON 形态），换过去等于改行为，所以保留 JSON 往返
      "unicorn/prefer-structured-clone": "off",
      // 与上面 `typescript/explicit-function-return-type` 同一个理由：返回值让 TS 推导。
      // Vue composable 的返回对象是一堆 ref + 方法，写全类型又长又容易和实现漂移
      "typescript/explicit-module-boundary-types": "off",
      // typeCheck 关掉时这条会误判：`a[k] = b[k]`（k 是 keyof 联合）必须靠泛型 K
      // 才能过类型检查，去掉 K 之后联合键写入会被推成 never
      "typescript/no-unnecessary-type-parameters": "off",
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
    plugins: ["eslint", "vitest"],
    rules: {
      "vitest/max-expects": ["warn", { max: 16 }],
      // beforeEach/afterEach 里清 localStorage、重置 pinia 是标准写法；
      // 这条规则要求把 setup 内联进每个用例，只会让测试更啰嗦
      "vitest/no-hooks": "off",
      // 测试里的 stub 类（例如 jsdom 缺的 ResizeObserver 最小实现）只是为了凑出接口形状，
      // 方法本来就不需要 this
      "class-methods-use-this": "off",
    },
  },
  {
    // CLI 的 fail() 必须立刻带退出码结束进程；EXAM_SEAT_DEBUG 是刻意的调试开关，
    // 这两件事在命令行工具里就是正常写法
    files: ["packages/cli/src/**"],
    plugins: ["unicorn", "node"],
    rules: {
      "unicorn/no-process-exit": "off",
      "node/no-process-env": "off",
    },
  },
  {
    // precheck 是「一份预检规则集」，526 行（不含空行/注释）超过预设 500 的阈值。
    // 拆文件会让预检规则散落两处，反而不利于和求解器对照阅读，这里只对这一个文件放开
    files: ["packages/core/src/precheck.ts"],
    rules: {
      "max-lines": "off",
    },
  },
  {
    // oxlint 认不出 `.vue` 的导出（见文件开头「两条经验」第 1 条），
    // 于是 main.ts 里的 App 在 oxlint 眼里是 error type，no-unsafe-argument 纯属误报；
    // web 的类型检查交给 vue-tsc
    files: ["packages/web/src/main.ts"],
    rules: {
      "typescript/no-unsafe-argument": "off",
    },
  },
);

export default oxlintConfig;
