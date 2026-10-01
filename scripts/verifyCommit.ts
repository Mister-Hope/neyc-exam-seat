import { verifyCommitMessage } from "@mr-hope/verify-commit-message";

await verifyCommitMessage({
  importMeta: import.meta,
  process,
  packages: ["packages/*"],
  // scope 取 packages/ 下的目录名（@exam-seat/desktop 与 @exam-seat/web 是私有包，
  // 不会被自动推导出来，但仓库里确实会按目录名提交，例如 `feat(web): ...`）。
  extraScopes: ["deps", "release", "desktop", "web"],
});
