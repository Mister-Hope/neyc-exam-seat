import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import vue from "@vitejs/plugin-vue";

const resolvePath = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/** 让测试直接跑 src，不必先构建 */
const sharedAlias = {
  "@exam-seat/core": resolvePath("./packages/core/src/index.ts"),
  "@exam-seat/io/node": resolvePath("./packages/io/src/node.ts"),
  "@exam-seat/io": resolvePath("./packages/io/src/index.ts"),
};

/**
 * Web 源码里用 `@/lib/...` 指代 `packages/web/src`，这个别名必须和 `packages/web/vite.config.ts`
 * 保持一致，否则从仓库根跑测试会解析失败。 （`@` 不会误吞 `@exam-seat/*`：别名匹配要求命中后紧跟 `/`。）
 */
const webAlias = {
  ...sharedAlias,
  "@": resolvePath("./packages/web/src"),
};

export default defineConfig({
  test: {
    projects: [
      {
        // 算法与命令行：纯 Node，零 DOM
        resolve: { alias: sharedAlias },
        test: {
          name: "node",
          include: ["packages/{core,io,cli}/test/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
        },
      },
      {
        // 网页：需要 DOM 与 Vue 单文件组件编译
        plugins: [vue()],
        resolve: { alias: webAlias },
        test: {
          name: "web",
          include: ["packages/web/test/**/*.test.ts"],
          environment: "jsdom",
        },
      },
    ],
  },
});
