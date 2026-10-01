/* oxlint-disable promise/prefer-await-to-callbacks, unicorn/prefer-top-level-await -- SEA 主脚本必须是 CJS 单文件，不能用顶层 await，也不该让 promise 悬着 */
/**
 * Node SEA（single executable application）的入口。
 *
 * 三件事：
 *
 * 1. `--version` / `-V` **由这一层直接回答**：版本号是打包时用 tsdown 的 `define` 注入的 （`EXAM_SEA_VERSION`），于是 tag
 *    `v0.2.0` → 二进制自报 0.2.0，**不需要改 `packages/cli` 源码** （源码里的 VERSION 常量只服务 `node
 *    packages/cli/bin/exam-seat.mjs` 这条路径）；
 * 2. 其余参数原样交给 CLI 的 `main()`；
 * 3. 退出码写回 `process.exitCode`（SEA 主脚本必须是 CJS 单文件，所以用 `.then()` 而不是顶层 await）。
 */
import { main } from "../../../packages/cli/src/cli";

declare const EXAM_SEA_VERSION: string;

const VERSION: string = typeof EXAM_SEA_VERSION === "string" ? EXAM_SEA_VERSION : "0.0.0-unknown";
const flags = new Set(process.argv.slice(2));

if (flags.has("--version") || flags.has("-V")) {
  process.stdout.write(`${VERSION}\n`);
  process.exitCode = 0;
} else {
  main(process.argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`exam-seat: 内部错误：${String(error)}\n`);
      process.exitCode = 1;
    });
}
