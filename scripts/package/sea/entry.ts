/* oxlint-disable promise/prefer-await-to-callbacks, unicorn/prefer-top-level-await -- SEA 主脚本必须是 CJS 单文件，不能用顶层 await，也不该让 promise 悬着 */
/**
 * Node SEA（single executable application）的入口。
 *
 * 只是把 CLI 的 `main()` 拿 `process.argv` 跑一遍，并把退出码写回 `process.exitCode`。 SEA 的主脚本必须是 **CJS 单文件**，所以这里用
 * `.then()` 而不是顶层 await。
 */
import { main } from "../../../packages/cli/src/cli";

main(process.argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`exam-seat: 内部错误：${String(error)}\n`);
    process.exitCode = 1;
  });
