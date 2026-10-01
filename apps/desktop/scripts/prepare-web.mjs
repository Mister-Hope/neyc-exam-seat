/**
 * 把 `packages/web` 的 Vite 产物同步到 `apps/desktop/web-dist`，供 Electron 主进程以 `app://bundle/` 提供。
 *
 * 用法：node scripts/prepare-web.mjs [--skip-build] 默认先跑一次 `pnpm --filter @exam-seat/web build`（CI
 * 里前面已经 `pnpm build` 过，可加 --skip-build）。
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(APP_DIR, "../..");
const WEB_DIST = path.join(REPO_ROOT, "packages/web/dist");
const TARGET = path.join(APP_DIR, "web-dist");

const log = (message) => process.stdout.write(`${message}\n`);
const skipBuild = process.argv.includes("--skip-build");

async function main() {
  if (!skipBuild) {
    log("[prepare-web] 构建 packages/web …");
    const result = spawnSync("pnpm", ["--filter", "@exam-seat/web", "build"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (result.status !== 0) throw new Error("网页构建失败");
  }

  if (!existsSync(path.join(WEB_DIST, "index.html"))) {
    throw new Error(`找不到 ${WEB_DIST}/index.html，先构建 packages/web`);
  }

  rmSync(TARGET, { recursive: true, force: true });
  mkdirSync(TARGET, { recursive: true });
  cpSync(WEB_DIST, TARGET, { recursive: true });

  // 把入口里的资源清单一并打出来，方便排查「worker 没被打进包」之类的问题
  const indexHtml = readFileSync(path.join(TARGET, "index.html"), "utf8");
  const assets = [...indexHtml.matchAll(/(?:src|href)="(?<url>[^"]+)"/g)].map(
    (match) => match.groups.url,
  );
  log(`[prepare-web] 已同步 → ${path.relative(REPO_ROOT, TARGET)}`);
  for (const asset of assets) log(`  · ${asset}`);
}

await main().catch((error) => {
  process.stderr.write(`[prepare-web] ${error.message}\n`);
  process.exitCode = 1;
});
