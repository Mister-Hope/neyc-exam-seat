import { defineConfig } from "vite";

import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";

/**
 * Web 应用构建配置。
 *
 * - 根目录就是 `packages/web`，产物落在 `packages/web/dist`。
 * - UI 用 shadcn-vue（源码进仓库）+ Tailwind v4（`@tailwindcss/vite`）。
 * - `@exam-seat/core` / `@exam-seat/io` 直接 alias 到源码：单仓开发时改核心包立刻热更新， 也不必先 `pnpm --filter
 *   @exam-seat/core build`。
 * - Solver 走 ES module worker（`src/workers/solver.worker.ts`）。
 */
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@": new URL("src", import.meta.url).pathname,
      "@exam-seat/core": new URL("../core/src/index.ts", import.meta.url).pathname,
      "@exam-seat/io": new URL("../io/src/index.ts", import.meta.url).pathname,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
  worker: {
    format: "es",
  },
});
