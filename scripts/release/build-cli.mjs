/**
 * 把 CLI 打成 **Node SEA 单文件可执行程序**。
 *
 * 流程（Node 官方 SEA）：
 *
 * 1. Tsdown（rolldown）把 `packages/cli` + commander + vendored xlsx + core/io **全部内联**成一个 CJS 文件；
 * 2. `node --experimental-sea-config` 生成 SEA blob；
 * 3. 复制当前 node 二进制，macOS 先 `codesign --remove-signature`；
 * 4. `postject` 注入 blob（哨兵 fuse `NODE_SEA_FUSE_…`）；
 * 5. MacOS ad-hoc 重签（`codesign --sign -`），否则注入后必崩；最后 chmod +x。
 *
 * 用法： node scripts/release/build-cli.mjs --platform mac|win [--version x.y.z] [--out-dir <dir>]
 * [--skip-bundle]
 *
 * 说明：Windows 产物请在 windows runner 上构建（直接用本机的 node.exe，不需要下载 Node 发行版）。 受限沙箱里 `pnpm dlx` 会往
 * `~/Library/Caches/pnpm/dlx` 写，遇到 EPERM 就设 `XDG_CACHE_HOME=<工作区内目录>`。
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { build } from "tsdown";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const BUNDLE_DIR = path.join(REPO_ROOT, "scripts/release/sea/dist");
const BUNDLE_FILE = path.join(BUNDLE_DIR, "exam-seat-cli.cjs");
const SEA_CONFIG = path.join(BUNDLE_DIR, "sea-config.json");
const SEA_BLOB = path.join(BUNDLE_DIR, "sea-prep.blob");
const POSTJECT_VERSION = process.env["EXAM_SEAT_POSTJECT_VERSION"] ?? "1.0.0-alpha.6";
const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const log = (message) => process.stdout.write(`${message}\n`);

function optionValue(name) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

const platform = optionValue("platform");
const version =
  optionValue("version") ??
  JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version;
const outDir = path.resolve(REPO_ROOT, optionValue("out-dir") ?? "scripts/release/out");
const skipBundle = process.argv.includes("--skip-bundle");
/** 跨平台构建时可指定要复制的 node 二进制（默认用当前运行的 node）。 */
const nodeBinary = path.resolve(optionValue("node-binary") ?? process.execPath);

if (platform !== "mac" && platform !== "win") {
  throw new Error("用法：node scripts/release/build-cli.mjs --platform mac|win [--version x.y.z]");
}

/** 产物名里的架构标签：默认跟当前运行的 node 一致；跨平台构建时用 `--arch` 指定。 */
const arch = optionValue("arch") ?? process.arch;
const ARCH_LABEL = { arm64: "arm64", x64: "x64" }[arch] ?? arch;
const fileName = `exam-seat-${version}-${platform}-${ARCH_LABEL}${platform === "win" ? ".exe" : ""}`;
const binaryPath = path.join(outDir, fileName);

function run(command, args, options = {}) {
  log(`[cli-sea] $ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: "inherit", ...options });
  if (result.status !== 0)
    throw new Error(`命令失败（${result.status}）：${command} ${args.join(" ")}`);
}

/* ---------- 1. 打成 CJS 单文件（SEA 里没有 node_modules，必须全部内联） ---------- */
async function bundle() {
  log("[cli-sea] 打包 CJS 单文件 …");
  await build({
    entry: ["scripts/release/sea/entry.ts"],
    format: ["cjs"],
    platform: "node",
    target: `node${process.versions.node.split(".")[0]}`,
    outDir: "scripts/release/sea/dist",
    clean: true,
    dts: false,
    sourcemap: false,
    minify: false,
    noExternal: [/.*/],
    alias: {
      "@exam-seat/io/node": "packages/io/src/node.ts",
      "@exam-seat/io": "packages/io/src/index.ts",
      "@exam-seat/core": "packages/core/src/index.ts",
    },
    outputOptions: { entryFileNames: "exam-seat-cli.cjs" },
    // 打包时把 tag 版本号注入 SEA 入口：`exam-seat --version` 与产物文件名一致，且不改源码
    define: { EXAM_SEA_VERSION: JSON.stringify(version) },
    report: false,
  });
  if (!existsSync(BUNDLE_FILE)) throw new Error(`没有生成 ${BUNDLE_FILE}`);
  log(`[cli-sea] 单文件 ${(statSync(BUNDLE_FILE).size / 1024 / 1024).toFixed(2)} MB`);
}

/* ---------- 2/3/4/5. SEA blob + 注入 + 签名 ---------- */
function buildSeaBinary() {
  writeFileSync(
    SEA_CONFIG,
    `${JSON.stringify(
      {
        main: BUNDLE_FILE,
        output: SEA_BLOB,
        disableExperimentalSEAWarning: true,
        useSnapshot: false,
        useCodeCache: false,
      },
      null,
      2,
    )}\n`,
  );
  run(process.execPath, ["--experimental-sea-config", SEA_CONFIG]);

  mkdirSync(outDir, { recursive: true });
  rmSync(binaryPath, { force: true });
  copyFileSync(nodeBinary, binaryPath);
  log(
    `[cli-sea] 复制 node 二进制（${process.version} / ${process.arch}）→ ${path.relative(REPO_ROOT, binaryPath)}`,
  );

  if (platform === "mac") {
    // 注入会破坏原有签名；先去掉，注入后再 ad-hoc 重签，否则 macOS 直接杀进程
    spawnSync("codesign", ["--remove-signature", binaryPath], { stdio: "ignore" });
  }

  const postjectArgs = [
    "dlx",
    `postject@${POSTJECT_VERSION}`,
    binaryPath,
    "NODE_SEA_BLOB",
    SEA_BLOB,
    "--sentinel-fuse",
    SENTINEL_FUSE,
  ];
  if (platform === "mac") postjectArgs.push("--macho-segment-name", "NODE_SEA");
  run("pnpm", postjectArgs);

  if (platform === "mac") {
    run("codesign", ["--sign", "-", binaryPath]);
    run("codesign", ["--verify", "--verbose", binaryPath]);
  }
  chmodSync(binaryPath, 0o755);
  log(
    `[cli-sea] 产物 ${path.relative(REPO_ROOT, binaryPath)}（${(statSync(binaryPath).size / 1024 / 1024).toFixed(1)} MB）`,
  );
}

if (!skipBundle) await bundle();
buildSeaBinary();
