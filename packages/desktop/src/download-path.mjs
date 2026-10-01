/**
 * 下载落盘路径的纯逻辑。
 *
 * 单独成文件（而不是留在 `main.mjs`）的原因：`main.mjs` 顶层 `import { BrowserWindow } from "electron"`， 在 Electron
 * 之外**无法被 import**，于是那部分逻辑没法单测。这里不依赖 Electron，可以 `node --test` 直接跑。
 */
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * 给重复文件名找第一个空闲路径：`成绩.xlsx` → `成绩 (2).xlsx` → `成绩 (3).xlsx` …
 *
 * 之前是直接 `setSavePath(path.join(dir, filename))`：**同名文件会被静默覆盖**，老师上一次的导出
 * 就这么没了。这里改成自动加序号（不弹窗询问——批量导出时弹窗会打断流程，而且序号方案更可靠）。
 *
 * - `filename` 先做 `path.basename` 归一，避免 `../` 之类把文件写到目录外面；
 * - `exists` 可注入，方便单测（默认 `existsSync`）。
 *
 * @param {string} dir 目标目录
 * @param {string} filename 原始文件名（可能带路径分隔符）
 * @param {(candidate: string) => boolean} [exists] 判断路径是否已存在
 * @returns {string} 第一个可用的绝对路径
 */
export function nextAvailablePath(dir, filename, exists = existsSync) {
  // 归一：只取文件名部分，杜绝 `../../etc/passwd` 这类越界写入
  const safeName = path.basename(filename) || "download";
  const ext = path.extname(safeName);
  const stem = safeName.slice(0, safeName.length - ext.length);

  let candidate = path.join(dir, safeName);
  let index = 2;
  // 上限只是防御「exists 永远返回 true」的实现，正常情况第 1 轮就命中
  while (exists(candidate) && index < 10_000) {
    candidate = path.join(dir, `${stem} (${index})${ext}`);
    index += 1;
  }
  return candidate;
}
