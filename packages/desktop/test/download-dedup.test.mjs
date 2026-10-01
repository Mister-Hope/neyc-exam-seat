import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { nextAvailablePath } from "../src/download-path.mjs";

/** 用「已存在的路径集合」构造一个假的 exists 判断，避免碰真实文件系统。 */
const existsIn = (paths) => {
  const set = new Set(paths);
  return (candidate) => set.has(candidate);
};

const DIR = "/tmp/exam-seat-downloads";

describe("nextAvailablePath（下载去重）", () => {
  it("目标不存在 → 用原文件名", () => {
    const target = nextAvailablePath(DIR, "成绩.xlsx", existsIn([]));
    assert.equal(target, path.join(DIR, "成绩.xlsx"));
  });

  it("已存在 → 加 (2)", () => {
    const target = nextAvailablePath(DIR, "成绩.xlsx", existsIn([path.join(DIR, "成绩.xlsx")]));
    assert.equal(target, path.join(DIR, "成绩 (2).xlsx"));
  });

  it("(2) 也存在 → 一路找到 (3)", () => {
    const target = nextAvailablePath(
      DIR,
      "成绩.xlsx",
      existsIn([path.join(DIR, "成绩.xlsx"), path.join(DIR, "成绩 (2).xlsx")]),
    );
    assert.equal(target, path.join(DIR, "成绩 (3).xlsx"));
  });

  it("(2)(3)(4) 都在 → 找到 (5)", () => {
    const target = nextAvailablePath(
      DIR,
      "考场安排.zip",
      existsIn([
        path.join(DIR, "考场安排.zip"),
        path.join(DIR, "考场安排 (2).zip"),
        path.join(DIR, "考场安排 (3).zip"),
        path.join(DIR, "考场安排 (4).zip"),
      ]),
    );
    assert.equal(target, path.join(DIR, "考场安排 (5).zip"));
  });

  it("文件名带路径分隔符 → 被 basename 归一（不允许写到目录外）", () => {
    const target = nextAvailablePath(DIR, "../../etc/passwd", existsIn([]));
    assert.equal(target, path.join(DIR, "passwd"));
  });

  it("多个扩展名只保留最后一个（xx.tar.gz → xx.tar (2).gz）", () => {
    const target = nextAvailablePath(DIR, "a.tar.gz", existsIn([path.join(DIR, "a.tar.gz")]));
    assert.equal(target, path.join(DIR, "a.tar (2).gz"));
  });

  it("没有扩展名也能加序号", () => {
    const target = nextAvailablePath(DIR, "README", existsIn([path.join(DIR, "README")]));
    assert.equal(target, path.join(DIR, "README (2)"));
  });

  it("归一后为空（例如只给了分隔符）→ 退回 download", () => {
    const target = nextAvailablePath(DIR, "///", existsIn([]));
    assert.equal(target, path.join(DIR, "download"));
  });
});
