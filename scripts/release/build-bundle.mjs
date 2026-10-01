import { createHash } from "node:crypto";
/**
 * 打「AI 客户端技能包」zip：白名单拷贝 + 隐私扫描 + 零依赖打包。
 *
 * 用法： node scripts/release/build-bundle.mjs --mac-bin <path> --win-bin <path> [--version x.y.z]
 * [--out-dir <dir>]
 *
 * ⚠️ 隐私红线（本脚本的核心职责）：
 *
 * 1. **只**从白名单路径拷贝（docs / skills / examples / 两个 bin），绝不 `cp -r .`；
 * 2. 打包前做一次内容扫描：把 `inputs/`（真实名单）与 `out/`（真实结果）里的姓名 / 准考证号抽出来， 在**暂存目录**里全量搜索；命中且不在仓库既有文档里的，直接构建失败。 ——
 *    目标是「即使将来有人手滑把真实名单拷进 examples，这个包也发不出去」。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import * as XLSX from "xlsx";

import { createZip } from "./lib/zip.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const OUT_DIR = path.resolve(REPO_ROOT, option("out-dir") ?? "scripts/release/out");
const VERSION =
  option("version") ??
  JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version;
const MAC_BIN = option("mac-bin");
const WIN_BIN = option("win-bin");
/** 姓名占位（README / 文档里的示例），允许出现在成品包里 */
const PLACEHOLDER_TOKENS = new Set(["张三", "李四", "王五", "赵六", "同学", "张伟", "李娜"]);

function option(name) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

const log = (message) => process.stdout.write(`${message}\n`);
const BUNDLE_NAME = "exam-seat-agent-bundle";
const STAGE_ROOT = path.join(OUT_DIR, "bundle");
const STAGE_DIR = path.join(STAGE_ROOT, BUNDLE_NAME);
const ZIP_PATH = path.join(OUT_DIR, `${BUNDLE_NAME}-${VERSION}.zip`);

if (!MAC_BIN || !WIN_BIN) {
  throw new Error(
    "用法：node scripts/release/build-bundle.mjs --mac-bin <macOS 可执行文件> --win-bin <Windows .exe>",
  );
}
for (const [label, file] of [
  ["--mac-bin", MAC_BIN],
  ["--win-bin", WIN_BIN],
]) {
  if (!existsSync(path.resolve(file))) throw new Error(`${label} 不存在：${file}`);
}

/* ------------------------------------------------------------------ */
/* 1. 白名单拷贝                                                        */
/* ------------------------------------------------------------------ */

/** 白名单：[源文件, 包内相对路径] */
const WHITELIST = [
  ["scripts/release/bundle/README.md", "README.md"],
  [".agents/skills/exam-seating/SKILL.md", "skills/exam-seating/SKILL.md"],
  [".agents/skills/exam-seating/reference.md", "skills/exam-seating/reference.md"],
  [
    ".agents/skills/exam-seating/examples/job.sample.json",
    "skills/exam-seating/examples/job.sample.json",
  ],
  ["examples/job.sample.json", "examples/job.sample.json"],
  ["examples/make-roster.mjs", "examples/make-roster.mjs"],
  [path.resolve(MAC_BIN), "bin/exam-seat-macos-arm64"],
  [path.resolve(WIN_BIN), "bin/exam-seat-windows-x64.exe"],
];

function stage() {
  rmSync(STAGE_DIR, { recursive: true, force: true });
  mkdirSync(STAGE_DIR, { recursive: true });
  for (const [source, target] of WHITELIST) {
    const from = path.resolve(REPO_ROOT, source);
    if (!existsSync(from)) throw new Error(`白名单里的文件不存在：${source}`);
    const to = path.join(STAGE_DIR, target);
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(from));
    log(`  + ${target}  (${(statSync(to).size / 1024).toFixed(0)} KB)`);
  }
}

/* ------------------------------------------------------------------ */
/* 2. 隐私扫描                                                          */
/* ------------------------------------------------------------------ */

function listFiles(dir, extensions) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, extensions));
    else if (extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) out.push(full);
  }
  return out;
}

/** 名单类表头：姓名列 / 准考证号（学号）列。只认这两类列，避免把「选科组合」这种词当成姓名。 */
const NAME_HEADER = /(姓名|名字|考生姓名|学生姓名|name)/i;
const ID_HEADER = /(准考证|考号|考籍号|学籍号|学号|studentid|examid|examno|studentno)/i;
/** 姓名形如「何静」「欧阳娜娜」；准考证号是 6 位以上数字（超过这个范围的多半是考场号 / 组合，不算敏感）。 */
const NAME_SHAPE = /^[\u4E00-\u9FA5·]{2,6}$/;
const ID_SHAPE = /^\d{6,}$/;

function normalizeHeader(value) {
  return String(value ?? "")
    .replaceAll(/\s/g, "")
    .toLowerCase();
}

/** 在表头行里找出命中 `pattern` 的列下标。 */
function columnsMatching(headerRow, pattern) {
  return (headerRow ?? [])
    .map((header, index) => (pattern.test(normalizeHeader(header)) ? index : -1))
    .filter((index) => index >= 0);
}

/** 在一张表里找表头行（前 10 行里第一行含姓名列的）。 */
function findHeaderRow(rows) {
  for (let index = 0; index < Math.min(rows.length, 10); index += 1) {
    if (columnsMatching(rows[index], NAME_HEADER).length > 0) return index;
  }
  return -1;
}

/** 从名单 / 结果类 Excel 里只抽「姓名列 + 准考证号列」的值。 */
function tokensFromXlsx(file) {
  const tokens = new Set();
  try {
    const book = XLSX.readFile(file);
    for (const sheetName of book.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(book.Sheets[sheetName], {
        header: 1,
        raw: false,
        defval: "",
      });
      const headerIndex = findHeaderRow(rows);
      if (headerIndex < 0) continue;
      const nameColumns = columnsMatching(rows[headerIndex], NAME_HEADER);
      const idColumns = columnsMatching(rows[headerIndex], ID_HEADER);
      for (const row of rows.slice(headerIndex + 1)) {
        for (const column of nameColumns) {
          const value = String(row[column] ?? "").trim();
          if (NAME_SHAPE.test(value)) tokens.add(value);
        }
        for (const column of idColumns) {
          const value = String(row[column] ?? "").trim();
          if (ID_SHAPE.test(value)) tokens.add(value);
        }
      }
    }
  } catch {
    // 读不动的（不是 xlsx）就跳过
  }
  return tokens;
}

/** 结果 JSON 里只抽「对象里 name / id / studentId 这类键」的值。 */
const SENSITIVE_JSON_KEY = /^(name|studentName|id|studentId|examId|examNo|准考证号|学号)$/;

function tokensFromJson(file) {
  const tokens = new Set();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const walk = (node) => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (typeof value === "string" && SENSITIVE_JSON_KEY.test(key)) {
            const text = value.trim();
            if (NAME_SHAPE.test(text) || ID_SHAPE.test(text)) tokens.add(text);
          } else {
            walk(value);
          }
        }
      }
    };
    walk(parsed);
  } catch {
    // 忽略
  }
  return tokens;
}

/** 收集 inputs/ 与 out/ 里的敏感 token（只在本机内存里比较，不落盘）。 */
function collectSensitiveTokens() {
  const tokens = new Set();
  for (const file of listFiles(path.join(REPO_ROOT, "inputs"), [".xlsx", ".xls"])) {
    for (const token of tokensFromXlsx(file)) tokens.add(token);
  }
  for (const file of listFiles(path.join(REPO_ROOT, "out"), [".json", ".xlsx"])) {
    for (const token of file.endsWith(".json") ? tokensFromJson(file) : tokensFromXlsx(file)) {
      tokens.add(token);
    }
  }
  return tokens;
}

function scanForLeaks() {
  const sensitive = collectSensitiveTokens();
  const hasRealData =
    existsSync(path.join(REPO_ROOT, "inputs")) || existsSync(path.join(REPO_ROOT, "out"));
  if (sensitive.size === 0) {
    if (hasRealData) {
      throw new Error(
        "inputs/ 或 out/ 存在，但一个姓名/学号 token 都没抽到——扫描逻辑可能失效，拒绝打包",
      );
    }
    log("  · 本机没有 inputs/ 与 out/（跳过内容扫描）");
    return;
  }
  // 仓库既有文档 / 示例里本来就有的词（例如 README 的占位示例），不算泄露
  const shippedSources = WHITELIST.filter(([, target]) => !target.startsWith("bin/"))
    .map(([source]) => readFileSync(path.resolve(REPO_ROOT, source), "utf8"))
    .join("\n");

  const staged = listFiles(STAGE_DIR, ["", ".md", ".json", ".mjs", ".exe", ".md"]);
  const leaks = [];
  for (const file of staged) {
    const content = readFileSync(file, "utf8");
    for (const token of sensitive) {
      if (!content.includes(token)) continue;
      if (shippedSources.includes(token) || PLACEHOLDER_TOKENS.has(token)) continue;
      leaks.push(`${path.relative(STAGE_DIR, file)} 命中「${token}」`);
    }
  }
  log(
    `  · 隐私扫描：inputs/out 里 ${sensitive.size} 个姓名/学号 token，命中 ${leaks.length} 个（命中即失败）`,
  );
  if (leaks.length > 0) {
    throw new Error(
      `包里出现了真实名单里的数据，已阻止打包：\n    ${leaks.slice(0, 10).join("\n    ")}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* 3. 打包                                                              */
/* ------------------------------------------------------------------ */

function stageFiles(dir = STAGE_DIR, prefix = "") {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...stageFiles(full, relative));
    else files.push({ name: relative, bytes: readFileSync(full) });
  }
  return files;
}

log(`▶ 打技能包 exam-seat-agent-bundle-${VERSION}.zip`);
log("[bundle] 白名单拷贝 →");
stage();
log("[bundle] 隐私扫描 →");
scanForLeaks();

const files = stageFiles().map((file) => ({
  name: `${BUNDLE_NAME}/${file.name}`,
  bytes: file.bytes,
}));
const zip = createZip(files);
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(ZIP_PATH, zip);

log(
  `[bundle] 产物 ${path.relative(REPO_ROOT, ZIP_PATH)}（${(zip.length / 1024 / 1024).toFixed(1)} MB）`,
);
log(`[bundle] sha256 ${createHash("sha256").update(zip).digest("hex")}`);
log("[bundle] 目录树：");
for (const file of files) log(`  ${file.name}  (${(file.bytes.length / 1024).toFixed(0)} KB)`);
