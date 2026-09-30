import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import picocolors from "picocolors";

/**
 * 校验 commit message 的格式。由 `.husky/commit-msg` 调用。
 *
 * <type>(<scope>): <subject>
 *
 * - `type` 必须是下面 types 之一
 * - `scope` 可选；给了就必须是 packages/ 下的包名，或 deps / release
 * - `subject` 长度 1–50，只校验第一行，正文随意
 */
const here = import.meta.dirname;

const getSubDirectories = async (dir: string): Promise<string[]> => {
  const items = await readdir(dir);
  const stats = await Promise.all(items.map((item) => stat(path.join(dir, item))));
  return items.filter((_, index) => stats[index]!.isDirectory());
};

const packageDirectories = await getSubDirectories(path.join(here, "../packages"));

const msgPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(".git/COMMIT_EDITMSG");

let msg: string;
try {
  msg = (await readFile(msgPath, "utf8")).trim();
} catch {
  console.error(`找不到提交信息文件：${msgPath}`);
  process.exit(1);
}

// 只校验第一行（标题），正文格式随意
const subject = msg.split("\n", 1)[0]!.trim();

const types = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "workflow",
  "build",
  "ci",
  "chore",
  "types",
  "release",
];

const scopes = [...packageDirectories, "deps", "release"];

const commitRE = /^(?:revert: )?(?<type>[^(]*?)(?:\((?<scope>[^)]*?)\))?!?: .{1,50}$/u;

const bail = (reason: string): never => {
  console.error(`${picocolors.white(picocolors.bgRed(" ERROR "))} ${picocolors.red(reason)}`);
  console.error(
    picocolors.gray(`\n  正确格式：<type>(<scope>): <subject>\n`) +
      picocolors.gray(`  可用 type：${types.join(" / ")}\n`) +
      picocolors.gray(`  可用 scope：${scopes.join(" / ")}\n`),
  );
  process.exit(1);
};

const match = commitRE.exec(subject);

if (!match) {
  bail(`提交信息格式不对：「${subject}」`);
}

if (!types.includes(match.groups?.type ?? "")) {
  bail(`type 不合法：「${match.groups?.type}」`);
}

if (match.groups?.scope && !scopes.includes(match.groups.scope)) {
  bail(`scope 不合法：「${match.groups.scope}」`);
}

console.log(`${picocolors.green("✓")} 提交信息格式正确`);
