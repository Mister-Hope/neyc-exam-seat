import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { applyAbsentKeys, readAbsentKeys, readWorkbook } from "../src/index";
import { readRosterFile } from "../src/node";

/** 主名单：同班两个完全同名 + 一个独特名字（合成数据）。 */
const STUDENTS = [
  { id: "SYN001", name: "学生同名", className: "合成1班" },
  { id: "SYN002", name: "学生同名", className: "合成1班" },
  { id: "SYN003", name: "学生独特", className: "合成1班" },
];

function makeXlsx(rows: (string | number)[][]): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer);
}

describe("缺考名单：重名歧义不得静默排除", () => {
  it("同班两个同名 + 只写「班级+姓名」→ 两人都不排除，1 条歧义诊断，candidates 带两个学号", () => {
    const { keys, issues } = readAbsentKeys(
      {
        name: "Sheet1",
        headers: ["班级", "姓名"],
        rows: [["合成1班", "学生同名"]],
      },
      {},
    );
    expect(issues).toEqual([]);
    expect(keys).toEqual([{ row: 2, name: "学生同名", className: "合成1班" }]);

    const applied = applyAbsentKeys(STUDENTS, keys);
    expect(applied.matched).toEqual([]);
    expect(applied.unmatched).toEqual([]);
    expect(applied.ambiguous).toEqual([
      { row: 2, name: "学生同名", className: "合成1班", candidates: ["SYN001", "SYN002"] },
    ]);
    // 一个都不许被排除
    expect(applied.students.filter((s) => s.included === false)).toEqual([]);
    expect(applied.issues).toHaveLength(1);
    expect(applied.issues[0]!.level).toBe("warning");
    expect(applied.issues[0]!.message).toMatch(/歧义/);
    expect(applied.issues[0]!.message).toMatch(/匹配到 2 名/);
    expect(applied.issues[0]!.message).toContain("SYN001");
    expect(applied.issues[0]!.message).toContain("SYN002");
  });

  it("补上学号后精确排除那一个", () => {
    const applied = applyAbsentKeys(STUDENTS, [{ row: 2, id: "SYN002" }]);
    expect(applied.matched).toEqual(["SYN002"]);
    expect(applied.ambiguous).toEqual([]);
    expect(applied.students.map((s) => s.included === false)).toEqual([false, true, false]);
  });

  it("唯一匹配仍照旧自动排除（防回归）", () => {
    const applied = applyAbsentKeys(STUDENTS, [{ row: 2, name: "学生独特", className: "合成1班" }]);
    expect(applied.matched).toEqual(["SYN003"]);
    expect(applied.ambiguous).toEqual([]);
    expect(applied.issues).toEqual([]);
    expect(applied.students[2]!.included).toBe(false);
  });

  it("学号归一化碰撞（全角数字）也走歧义分支，不再静默取第一个", () => {
    const collision = [
      { id: "001", name: "学生甲", className: "合成2班" },
      { id: "００１", name: "学生乙", className: "合成2班" },
    ];
    const applied = applyAbsentKeys(collision, [{ row: 2, id: "001" }]);
    expect(applied.matched).toEqual([]);
    expect(applied.ambiguous).toEqual([{ row: 2, candidates: ["001", "００１"] }]);
    expect(applied.students.some((s) => s.included === false)).toBe(false);
    expect(applied.issues[0]!.message).toMatch(/歧义/);
  });

  it("没匹配上仍报原来的 warning（防回归）", () => {
    const applied = applyAbsentKeys(STUDENTS, [{ row: 2, name: "查无此人", className: "合成9班" }]);
    expect(applied.matched).toEqual([]);
    expect(applied.ambiguous).toEqual([]);
    expect(applied.unmatched).toEqual([{ row: 2, name: "查无此人", className: "合成9班" }]);
    expect(applied.issues[0]!.message).toContain("在主名单里没找到");
  });

  it("readRosterFile 把 ambiguous 挂到 absent 上，且学生一个都不排除", () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "exam-seat-absent-"));
    try {
      const mainPath = nodePath.join(dir, "main.xlsx");
      const absentPath = nodePath.join(dir, "absent.xlsx");
      writeFileSync(
        mainPath,
        makeXlsx([
          ["学号", "姓名", "班级"],
          ["SYN001", "学生同名", "合成1班"],
          ["SYN002", "学生同名", "合成1班"],
          ["SYN003", "学生独特", "合成1班"],
        ]),
      );
      writeFileSync(
        absentPath,
        makeXlsx([
          ["班级", "姓名"],
          ["合成1班", "学生同名"],
        ]),
      );

      const result = readRosterFile(mainPath, { absentFile: absentPath });
      expect(result.absent!.matched).toEqual([]);
      expect(result.absent!.unmatched).toEqual([]);
      expect(result.absent!.ambiguous).toEqual([
        { row: 2, name: "学生同名", className: "合成1班", candidates: ["SYN001", "SYN002"] },
      ]);
      expect(result.students.filter((s) => s.included === false)).toEqual([]);
      expect(result.absent!.issues.some((issue) => issue.message.includes("歧义"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readWorkbook 读回的缺考名单同样按多值索引处理（端到端）", () => {
    const sheet = readWorkbook(
      makeXlsx([
        ["班级", "姓名"],
        ["合成1班", "学生同名"],
      ]),
    )[0]!;
    const { keys } = readAbsentKeys(sheet, {});
    expect(applyAbsentKeys(STUDENTS, keys).ambiguous).toHaveLength(1);
  });
});
