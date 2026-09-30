import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import type { PlanResult } from "@exam-seat/core";

import {
  buildPlanWorkbook,
  buildRoomSheets,
  parseRoster,
  readRoster,
  readWorkbook,
  suggestMapping,
} from "../src/index";
import { writePlanFiles } from "../src/node";

function makeXlsx(rows: (string | number)[][], sheetName = "Sheet1"): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer);
}

const ROSTER = [
  ["学号", "姓名", "班级", "性别"],
  ["20240101", "张三", "高三(1)班", "男"],
  ["20240102", "李四", "高三(1)班", "女"],
  ["20240201", "王五", "高三(2)班", "男"],
];

describe("名单导入", () => {
  it("自动认出 学号 / 姓名 / 班级 三列", () => {
    const sheets = readWorkbook(makeXlsx(ROSTER));
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.headers).toEqual(["学号", "姓名", "班级", "性别"]);
    const { mapping, missing } = suggestMapping(sheets[0]!.headers);
    expect(missing).toEqual([]);
    expect(mapping).toMatchObject({ id: 0, name: 1, className: 2, gender: 3 });
  });

  it("一站式读出学生名单", () => {
    const result = readRoster(makeXlsx(ROSTER));
    expect(result.sheetName).toBe("Sheet1");
    expect(result.students).toHaveLength(3);
    expect(result.students[0]).toMatchObject({
      id: "20240101",
      name: "张三",
      className: "高三(1)班",
      gender: "男",
    });
    expect(result.issues).toHaveLength(0);
  });

  it("表头用了别名也能认出来", () => {
    const bytes = makeXlsx([
      ["考号", "考生姓名", "行政班"],
      ["A001", "赵六", "高三(3)班"],
    ]);
    const result = readRoster(bytes);
    expect(result.students).toEqual([{ id: "A001", name: "赵六", className: "高三(3)班" }]);
  });

  it("认不出必要列时给出可操作的报错", () => {
    const bytes = makeXlsx([
      ["甲", "乙", "丙"],
      ["1", "2", "3"],
    ]);
    expect(() => readRoster(bytes)).toThrow(/认不出这些列/);
  });

  it("重复学号只保留第一条并报告", () => {
    const sheet = readWorkbook(
      makeXlsx([
        ["学号", "姓名", "班级"],
        ["A1", "张三", "高三(1)班"],
        ["A1", "张三丰", "高三(1)班"],
      ]),
    )[0]!;
    const { students, issues } = parseRoster(sheet, { id: 0, name: 1, className: 2 });
    expect(students).toHaveLength(1);
    expect(issues.some((i) => i.level === "error" && i.row === 3)).toBe(true);
  });

  it("数字学号不会被科学计数法搞坏", () => {
    const bytes = makeXlsx([
      ["学号", "姓名", "班级"],
      [20240101, "张三", "高三(1)班"],
    ]);
    const result = readRoster(bytes);
    expect(result.students[0]!.id).toBe("20240101");
  });
});

const FAKE_RESULT: PlanResult = {
  resultVersion: 1,
  ok: true,
  level: "strict",
  stats: {
    students: 2,
    participants: 2,
    excluded: 0,
    rooms: 1,
    roomsUsed: 1,
    emptyRooms: [],
    seatsTotal: 30,
    seatsUsed: 2,
    conflicts: 0,
    unmetConstraints: 0,
    classes: 2,
    elapsedMs: 12,
    seed: 1,
    adjacency: "king",
  },
  entries: [
    {
      studentId: "20240101",
      name: "张三",
      className: "高三(1)班",
      roomId: "R1",
      roomName: "第1考场",
      seatNo: 1,
      row: 1,
      col: 1,
      physicalCol: 5,
    },
    {
      studentId: "20240201",
      name: "王五",
      className: "高三(2)班",
      roomId: "R1",
      roomName: "第1考场",
      seatNo: 2,
      row: 2,
      col: 1,
      physicalCol: 5,
    },
  ],
  conflicts: [],
  unmetConstraints: [],
  diagnostics: [{ code: "OK", severity: "info", message: "预检通过", suggestions: [] }],
  inputFingerprint: "fnv1a:test",
  generatedAt: "2026-09-30T00:00:00.000Z",
};

describe("结果导出", () => {
  it("导出的工作簿有三张表，且名单内容能读回来", () => {
    const bytes = buildPlanWorkbook(FAKE_RESULT);
    const sheets = readWorkbook(bytes);
    expect(sheets.map((s) => s.name)).toEqual(["考场安排名单", "按班级", "校验报告"]);

    const main = sheets[0]!;
    expect(main.headers).toEqual(["考场", "座位号", "学号", "姓名", "班级"]);
    expect(main.rows[0]).toEqual(["第1考场", "1", "20240101", "张三", "高三(1)班"]);
    expect(main.rows[1]).toEqual(["第1考场", "2", "20240201", "王五", "高三(2)班"]);

    const report = sheets[2]!;
    expect(report.rows.some((r) => r[0] === "是否完美" && r[1] === "是")).toBe(true);
  });
});

describe("空结果导出（预检没过、一个座位都没排时）", () => {
  const empty: PlanResult = {
    ...FAKE_RESULT,
    ok: false,
    entries: [],
    stats: { ...FAKE_RESULT.stats, seatsUsed: 0, roomsUsed: 0 },
  };

  it("名单工作簿照常出三张表，不抛异常", () => {
    const sheets = readWorkbook(buildPlanWorkbook(empty));
    expect(sheets.map((s) => s.name)).toEqual(["考场安排名单", "按班级", "校验报告"]);
    expect(sheets[0]!.rows).toHaveLength(0);
  });

  it("座位表在零安排时给一张占位表，而不是让 SheetJS 抛「Workbook is empty」", () => {
    const bytes = buildRoomSheets(empty, () => ({ rows: 6, cols: 5, name: "第1考场" }));
    const sheets = readWorkbook(bytes);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.name).toBe("无安排");
  });

  it("有安排时仍然逐考场出表", () => {
    const bytes = buildRoomSheets(FAKE_RESULT, () => ({ rows: 6, cols: 5, name: "第1考场" }));
    const sheets = readWorkbook(bytes);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.name).toBe("第1考场");
  });

  it("writePlanFiles 在零安排时也不崩，且不产出无意义的座位表", () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "exam-seat-"));
    try {
      const written = writePlanFiles(empty, {
        outDir: dir,
        rooms: [{ id: "R1", rows: 6, cols: 5 }],
      });
      const files = readdirSync(dir);
      expect(written.files.length).toBeGreaterThan(0);
      expect(files).toContain("考场安排名单.xlsx");
      expect(files).toContain("plan.json");
      expect(files).not.toContain("考场座位表.xlsx");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
