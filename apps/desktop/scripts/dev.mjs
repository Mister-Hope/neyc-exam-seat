/**
 * 本地开发：同步网页产物 → 用工作区里的 electron 二进制启动桌面外壳。
 *
 * 需要 `node_modules/electron` 里有真实二进制（默认 pnpm 不放行 electron 的 postinstall， 而是保持安装轻量）。缺二进制时这里会提示补装命令。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const ELECTRON_BIN = path.join(
  APP_DIR,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);
const log = (message) => process.stdout.write(`${message}\n`);

log("[dev] 同步网页产物 …");
const prepared = spawnSync(process.execPath, ["scripts/prepare-web.mjs"], {
  cwd: APP_DIR,
  stdio: "inherit",
});

if (prepared.status !== 0) {
  process.exitCode = prepared.status ?? 1;
} else if (process.platform === "darwin" && !existsSync(ELECTRON_BIN)) {
  log(
    [
      "[dev] 本地没有 Electron 二进制（pnpm 未放行 electron 的安装脚本）。三选一：",
      "  1) 直接跑打包产物：pnpm --filter @exam-seat/desktop build:mac --dir，再 open 产物里的 .app",
      "  2) 补装二进制：node node_modules/electron/install.js（在 apps/desktop 下）",
      "  3) 临时放行：pnpm approve-builds（勾 electron）后重新 install",
    ].join("\n"),
  );
  process.exitCode = 1;
} else {
  // 某些开发壳（含本机 harness）会带着 ELECTRON_RUN_AS_NODE=1：Electron 会退化成普通 Node，界面起不来
  const devEnv = { ...process.env };
  delete devEnv.ELECTRON_RUN_AS_NODE;

  const electron = spawnSync("pnpm", ["exec", "electron", "."], {
    cwd: APP_DIR,
    stdio: "inherit",
    env: devEnv,
  });
  process.exitCode = electron.status ?? 1;
}
