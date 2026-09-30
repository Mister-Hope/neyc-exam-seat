import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import type { Student } from "@exam-seat/core";

import {
  applyAbsentKeys,
  isAbsentMark,
  parseRoster,
  readAbsentKeys,
  readRoster,
  readWorkbook,
  suggestMapping,
} from "../src/index";
import { readRosterFile } from "../src/node";

function makeXlsx(rows: (string | number)[][]): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer);
}

function firstSheet(rows: (string | number)[][]) {
  return readWorkbook(makeXlsx(rows))[0]!;
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "exam-seat-roster-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("表头识别（宽松）", () => {
  it("「考证号」当成学号列", () => {
    const result = readRoster(
      makeXlsx([
        ["考证号", "姓名", "班级"],
        ["20240101", "张三", "高三(1)班"],
      ]),
    );
    expect(result.mapping).toMatchObject({ id: 0, name: 1, className: 2 });
    expect(result.students).toEqual([{ id: "20240101", name: "张三", className: "高三(1)班" }]);
  });

  it("带空格 / 全角空格的表头：班 级、姓　名、准 考 证 号", () => {
    const result = readRoster(
      makeXlsx([
        ["准 考 证 号", "姓　名", "班 级"],
        ["A001", "李四", "高三(2)班"],
      ]),
    );
    expect(result.mapping).toMatchObject({ id: 0, name: 1, className: 2 });
    expect(result.students).toEqual([{ id: "A001", name: "李四", className: "高三(2)班" }]);
  });

  it("全角 ASCII 也认得（ｓｔｕｄｅｎｔｉｄ / Ｃｌａｓｓ）", () => {
    const { mapping } = suggestMapping(["ｓｔｕｄｅｎｔｉｄ", "姓名", "Ｃｌａｓｓ"]);
    expect(mapping).toMatchObject({ id: 0, name: 1, className: 2 });
  });

  it("「班主任」不会被当成班级列，班级取真正的「班」列", () => {
    const { mapping, missing } = suggestMapping(["班主任", "班", "姓名", "学号"]);
    expect(missing).toEqual([]);
    expect(mapping).toMatchObject({ className: 1, name: 2, id: 3 });
    expect(mapping.className).not.toBe(0);
  });

  it("「班主任」+「班级」并存时，班级仍取「班级」列", () => {
    const { mapping } = suggestMapping(["班主任", "班级", "考证号", "姓 名"]);
    expect(mapping).toMatchObject({ className: 1, id: 2, name: 3 });
  });

  it("先全等再包含：「姓名（必填）」与「姓名」并存时取全等的「姓名」列", () => {
    const { mapping } = suggestMapping(["姓名（必填）", "姓名", "班级", "学号"]);
    expect(mapping.name).toBe(1);
  });

  it("同一列只能被一个字段占用（缺考列不抢学号列）", () => {
    const { mapping } = suggestMapping(["准考证号", "姓名", "班级", "缺考"]);
    expect(mapping).toEqual({ id: 0, name: 1, className: 2, absent: 3 });
    expect(new Set(Object.values(mapping)).size).toBe(4);
  });
});

describe("名单里的「缺考」列", () => {
  const absentValues = [
    "是",
    "否",
    "病假",
    "",
    "N",
    "no",
    "FALSE",
    "0",
    "正常",
    "参加",
    "参加考试",
    "不缺考",
    "无",
    "-",
    "—",
    "/",
    "０",
    "ＮＯ",
    "　否　",
  ];

  it("是 / 病假 → included:false；空与否定值 → 不缺席", () => {
    const rows: (string | number)[][] = [["学号", "姓名", "班级", "缺考"]];
    absentValues.forEach((value, index) => {
      rows.push([`S${index + 1}`, `学生${index + 1}`, "高三(1)班", value]);
    });

    const result = readRoster(makeXlsx(rows));
    expect(result.mapping.absent).toBe(3);
    expect(result.stats).toMatchObject({ total: absentValues.length, absent: 2 });
    for (const [index, value] of absentValues.entries()) {
      const student = result.students[index]!;
      const shouldBeAbsent = value === "是" || value === "病假";
      expect(student.included === false, `「${value}」应${shouldBeAbsent ? "" : "不"}缺席`).toBe(
        shouldBeAbsent,
      );
    }
  });

  it.each([
    "",
    "否",
    "N",
    "no",
    "false",
    "0",
    "正常",
    "参加",
    "参加考试",
    "不缺考",
    "无",
    "-",
    "—",
    "/",
    "０",
    " ＦＡＬＳＥ ",
  ])("「%s」不算缺席", (value) => {
    expect(isAbsentMark(value)).toBe(false);
  });

  it.each(["是", "病假", "请假", "1", "true", "Y", "缺考"])("「%s」算缺席", (value) => {
    expect(isAbsentMark(value)).toBe(true);
  });

  it("parseRoster 没有缺考列时不产出 included", () => {
    const { students, stats } = parseRoster(
      firstSheet([
        ["学号", "姓名", "班级"],
        ["A1", "张三", "高三(1)班"],
      ]),
      {
        id: 0,
        name: 1,
        className: 2,
      },
    );
    expect(stats).toEqual({ total: 1, absent: 0 });
    expect(students).toEqual([{ id: "A1", name: "张三", className: "高三(1)班" }]);
  });
});

describe("readAbsentKeys：单独的缺考名单", () => {
  it("有准考证号列 → 按 id 出键", () => {
    const { keys, issues } = readAbsentKeys(firstSheet([["准考证号"], ["A1"], ["A2"]]));
    expect(issues).toEqual([]);
    expect(keys).toEqual([
      { row: 2, id: "A1" },
      { row: 3, id: "A2" },
    ]);
  });

  it("没有 id 列 → 必须 姓名 + 班级 成对出键", () => {
    const { keys, issues } = readAbsentKeys(
      firstSheet([
        ["姓名", "班级"],
        ["张三", "高三(1)班"],
        ["李四", "高三(2)班"],
      ]),
    );
    expect(issues).toEqual([]);
    expect(keys).toEqual([
      { row: 2, name: "张三", className: "高三(1)班" },
      { row: 3, name: "李四", className: "高三(2)班" },
    ]);
  });

  it("有 id 列但某行 id 为空、又有 姓名+班级 → 退回成对键", () => {
    const { keys } = readAbsentKeys(
      firstSheet([
        ["学号", "姓名", "班级"],
        ["", "张三", "高三(1)班"],
      ]),
    );
    expect(keys).toEqual([{ row: 2, name: "张三", className: "高三(1)班" }]);
  });

  it("缺「班级」列且没有 id 列 → error issue 说明缺哪列", () => {
    const { keys, issues } = readAbsentKeys(firstSheet([["姓名"], ["张三"]]));
    expect(keys).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe("error");
    expect(issues[0]!.message).toContain("准考证号");
    expect(issues[0]!.message).toContain("班级");
  });

  it("什么列都认不出 → error issue 提到 姓名 + 班级", () => {
    const { keys, issues } = readAbsentKeys(
      firstSheet([
        ["甲", "乙"],
        ["1", "2"],
      ]),
    );
    expect(keys).toEqual([]);
    expect(issues[0]!.level).toBe("error");
    expect(issues[0]!.message).toContain("姓名 + 班级");
  });

  it("自带「缺考」列 → 只取真正缺席的行（完整名单 + 标记）", () => {
    const { keys, issues } = readAbsentKeys(
      firstSheet([
        ["学号", "姓名", "班级", "缺考"],
        ["A1", "张三", "高三(1)班", "是"],
        ["A2", "李四", "高三(1)班", "否"],
        ["A3", "王五", "高三(1)班", ""],
        ["A4", "赵六", "高三(1)班", "病假"],
      ]),
    );
    expect(issues).toEqual([]);
    expect(keys).toEqual([
      { row: 2, id: "A1" },
      { row: 5, id: "A4" },
    ]);
  });

  it("有 id 列的缺考名单里，缺了另一半键值的行给 warning", () => {
    const { keys, issues } = readAbsentKeys(
      firstSheet([
        ["准考证号", "姓名"],
        ["", "张三"],
        ["A2", "李四"],
      ]),
    );
    expect(keys).toEqual([{ row: 3, id: "A2" }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe("warning");
    expect(issues[0]!.row).toBe(2);
    expect(issues[0]!.message).toContain("第 2 行");
  });
});

describe("applyAbsentKeys：匹配、未匹配与不可变性", () => {
  const students: Student[] = [
    { id: "A1", name: "张三", className: "高三(1)班" },
    { id: "A2", name: "李四", className: "高三(2)班" },
  ];

  it("id 精确匹配 + 姓名/班级成对匹配 + 归一化（全角、空格）", () => {
    const applied = applyAbsentKeys(students, [
      { row: 2, id: " Ａ１ " },
      { row: 3, name: " 李　四 ", className: "高三(2)班" },
    ]);
    expect(applied.matched).toEqual(["A1", "A2"]);
    expect(applied.unmatched).toEqual([]);
    expect(applied.issues).toEqual([]);
    expect(applied.students.every((student) => student.included === false)).toBe(true);
  });

  it("未匹配的行进 unmatched 并生成 warning（写明行号与键值）", () => {
    const applied = applyAbsentKeys(students, [
      { row: 5, id: "ZZZ" },
      { row: 6, name: "王五", className: "高三(9)班" },
    ]);
    expect(applied.matched).toEqual([]);
    expect(applied.unmatched).toHaveLength(2);
    expect(applied.issues).toHaveLength(2);
    expect(applied.students.every((student) => student.included === undefined)).toBe(true);

    const first = applied.issues[0]!;
    expect(first.level).toBe("warning");
    expect(first.row).toBe(5);
    expect(first.message).toContain("第 5 行");
    expect(first.message).toContain("ZZZ");
    expect(applied.issues[1]!.message).toContain("高三(9)班");
  });

  it("同一学生被多行命中只置一次 included:false", () => {
    const applied = applyAbsentKeys(students, [
      { row: 2, id: "A1" },
      { row: 3, id: " A1 " },
    ]);
    expect(applied.matched).toEqual(["A1"]);
    expect(applied.students[0]!.included).toBe(false);
  });

  it("不修改原数组与原对象", () => {
    const applied = applyAbsentKeys(students, [{ row: 2, id: "A1" }]);
    expect(applied.students).not.toBe(students);
    expect(applied.students[0]).not.toBe(students[0]);
    expect(students[0]!.included).toBeUndefined();
    expect(students[1]!.included).toBeUndefined();
    expect(students).toHaveLength(2);
  });

  it("主名单自己已由缺考列标为 false 的人，仍然只置一次且命中", () => {
    const withColumn: Student[] = [
      { id: "A1", name: "张三", className: "高三(1)班", included: false },
      { id: "A2", name: "李四", className: "高三(2)班" },
    ];
    const applied = applyAbsentKeys(withColumn, [{ row: 2, id: "A1" }]);
    expect(applied.matched).toEqual(["A1"]);
    expect(applied.students[0]!.included).toBe(false);
    expect(withColumn[0]!.included).toBe(false); // 原对象本来就 false
    expect(applied.students[1]!.included).toBeUndefined();
  });
});

describe("readRosterFile：主名单 + 缺考名单文件", () => {
  it("按准考证号命中，未匹配行报 warning，文件路径是绝对路径", () => {
    withTempDir((dir) => {
      const rosterPath = nodePath.join(dir, "全名单.xlsx");
      const absentPath = nodePath.join(dir, "缺考名单.xlsx");
      writeFileSync(
        rosterPath,
        makeXlsx([
          ["学号", "姓名", "班级"],
          ["A1", "张三", "高三(1)班"],
          ["A2", "李四", "高三(1)班"],
          ["A3", "王五", "高三(2)班"],
        ]),
      );
      writeFileSync(absentPath, makeXlsx([["准考证号"], ["A2"], ["A9"]]));

      const result = readRosterFile(rosterPath, { absentFile: absentPath });
      expect(result.students.map((s) => s.id)).toEqual(["A1", "A2", "A3"]);
      expect(result.students.find((s) => s.id === "A2")!.included).toBe(false);
      expect(result.students.find((s) => s.id === "A1")!.included).toBeUndefined();
      expect(result.absent).toMatchObject({
        file: absentPath,
        matched: ["A2"],
        unmatched: [{ row: 3, id: "A9" }],
      });
      expect(result.absent!.issues).toHaveLength(1);
      expect(result.absent!.issues[0]!.level).toBe("warning");
      expect(result.stats.absent).toBe(0);
    });
  });

  it("按 姓名 + 班级 命中", () => {
    withTempDir((dir) => {
      const rosterPath = nodePath.join(dir, "全名单.xlsx");
      const absentPath = nodePath.join(dir, "缺考名单.xlsx");
      writeFileSync(
        rosterPath,
        makeXlsx([
          ["学号", "姓名", "班级"],
          ["A1", "张三", "高三(1)班"],
          ["A2", "李四", "高三(2)班"],
        ]),
      );
      writeFileSync(
        absentPath,
        makeXlsx([
          ["姓名", "班级"],
          ["李四", "高三(2)班"],
        ]),
      );

      const result = readRosterFile(rosterPath, { absentFile: absentPath });
      expect(result.absent!.matched).toEqual(["A2"]);
      expect(result.absent!.unmatched).toEqual([]);
      expect(result.students.find((s) => s.id === "A2")!.included).toBe(false);
    });
  });

  it("缺考名单自带「缺考」列 → 只取真正缺席的行", () => {
    withTempDir((dir) => {
      const rosterPath = nodePath.join(dir, "全名单.xlsx");
      const absentPath = nodePath.join(dir, "缺考名单.xlsx");
      writeFileSync(
        rosterPath,
        makeXlsx([
          ["学号", "姓名", "班级"],
          ["A1", "张三", "高三(1)班"],
          ["A2", "李四", "高三(1)班"],
        ]),
      );
      writeFileSync(
        absentPath,
        makeXlsx([
          ["学号", "姓名", "班级", "缺考"],
          ["A1", "张三", "高三(1)班", "是"],
          ["A2", "李四", "高三(1)班", "否"],
        ]),
      );

      const result = readRosterFile(rosterPath, { absentFile: absentPath });
      expect(result.absent!.matched).toEqual(["A1"]);
      expect(result.students.find((s) => s.id === "A1")!.included).toBe(false);
      expect(result.students.find((s) => s.id === "A2")!.included).toBeUndefined();
    });
  });

  it("缺考名单缺列时返回 error issue，不动主名单", () => {
    withTempDir((dir) => {
      const rosterPath = nodePath.join(dir, "全名单.xlsx");
      const absentPath = nodePath.join(dir, "缺考名单.xlsx");
      writeFileSync(
        rosterPath,
        makeXlsx([
          ["学号", "姓名", "班级"],
          ["A1", "张三", "高三(1)班"],
        ]),
      );
      writeFileSync(absentPath, makeXlsx([["姓名"], ["张三"]]));

      const result = readRosterFile(rosterPath, { absentFile: absentPath });
      expect(result.absent!.issues[0]!.level).toBe("error");
      expect(result.absent!.matched).toEqual([]);
      expect(result.students[0]!.included).toBeUndefined();
    });
  });

  it("缺考列与缺考名单同时存在 → 取并集（同一学生只置一次）", () => {
    withTempDir((dir) => {
      const rosterPath = nodePath.join(dir, "全名单.xlsx");
      const absentPath = nodePath.join(dir, "缺考名单.xlsx");
      writeFileSync(
        rosterPath,
        makeXlsx([
          ["学号", "姓名", "班级", "缺考"],
          ["A1", "张三", "高三(1)班", "是"],
          ["A2", "李四", "高三(1)班", ""],
          ["A3", "王五", "高三(2)班", ""],
        ]),
      );
      writeFileSync(
        absentPath,
        makeXlsx([
          ["学号", "姓名", "班级"],
          ["A1", "张三", "高三(1)班"],
          ["A3", "王五", "高三(2)班"],
        ]),
      );

      const result = readRosterFile(rosterPath, { absentFile: absentPath });
      expect(result.students.map((s) => s.included === false)).toEqual([true, false, true]);
      expect(result.stats.absent).toBe(1);
      expect(result.absent!.matched).toEqual(["A1", "A3"]);
    });
  });
});
