/**
 * 打包桌面版：`node scripts/build.mjs mac|win [--dir] [--target dmg|zip|nsis] [--version x.y.z]`
 *
 * - 先同步网页产物（web-dist），再交给 electron-builder；
 * - 不签名：`CSC_IDENTITY_AUTO_DISCOVERY=false`（没有证书，签名会直接失败）；
 * - 版本号可用 `--version` / `EXAM_SEAT_VERSION` 注入（release workflow 从 tag 取）。 electron-builder 自己下
 *   Electron 发行版，所以 pnpm 侧不用装 electron 二进制；
 * - `--target` 覆盖默认产物类型（例如受限环境里没法做 dmg，就只出 zip；`--dir` 只出解包目录）。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const log = (message) => process.stdout.write(`${message}\n`);

const argv = process.argv.slice(2);
const [platform] = argv;
/** 本脚本自己的开关，其余参数原样转给 electron-builder。 */
const OWN_FLAGS = new Set(["--version", "--target"]);

function optionValue(name) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

const version = optionValue("version") ?? process.env["EXAM_SEAT_VERSION"];
const target = optionValue("target");
const passthrough = argv.slice(1).filter((arg) => {
  if (OWN_FLAGS.has(arg)) return false;
  return arg !== version && arg !== target;
});

if (platform !== "mac" && platform !== "win") {
  throw new Error(
    "用法：node scripts/build.mjs mac|win [--dir] [--target dmg|zip|nsis] [--version x.y.z]",
  );
}

log("[build] 同步网页产物 …");
const prepared = spawnSync(process.execPath, ["scripts/prepare-web.mjs", "--skip-build"], {
  cwd: APP_DIR,
  stdio: "inherit",
});
if (prepared.status === 0) {
  const args = [
    "exec",
    "electron-builder",
    "--config",
    "electron-builder.yml",
    `--${platform}`,
    platform === "mac" ? "--arm64" : "--x64",
    ...(version ? [`--config.extraMetadata.version=${version}`] : []),
    ...(target ? [`--config.${platform}.target=${target}`] : []),
    ...passthrough,
  ];

  log(`[build] electron-builder ${args.join(" ")}`);
  const built = spawnSync("pnpm", args, {
    cwd: APP_DIR,
    stdio: "inherit",
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
  });
  process.exitCode = built.status ?? 1;
} else {
  process.exitCode = 1;
}
