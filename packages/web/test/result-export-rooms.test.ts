import { describe, expect, it } from "vitest";

import type { PlanAllResult, PlanResult, RoomSpec, StudentSchedule } from "@exam-seat/core";
import { buildClassScheduleSheets, buildInvigilatorSheets } from "@exam-seat/io";
import type { XlsxCellInput, XlsxSheet } from "@exam-seat/io";

/**
 * 导出层「考场地点 / 监考老师」的 web 侧回归。
 *
 * 页面导出时把 **job 的 rooms** 一并交给 io（`buildInvigilatorSheets(result, job.rooms)` /
 * `buildClassScheduleSheets(result, job.rooms)`），所以这里用真实 io 断言：地点必须来自 job 的考场配置，
 * 且监考表里不再出现「监考：」这一列/文案。
 */

const cellText = (cell: XlsxCellInput): string => {
  if (cell == null) return "";
  return typeof cell === "object" ? String(cell.value) : String(cell);
};

const sheetText = (sheet: XlsxSheet): string =>
  sheet.rows.map((row) => row.map((value) => cellText(value)).join(" ")).join("\n");

const rowTexts = (sheet: XlsxSheet): string[][] =>
  sheet.rows.map((row) => row.map((value) => cellText(value)));

function planResult(): PlanResult {
  return {
    resultVersion: 2,
    ok: true,
    level: "strict",
    stats: {
      students: 1,
      participants: 1,
      excluded: 0,
      rooms: 1,
      roomsUsed: 1,
      emptyRooms: [],
      seatsTotal: 30,
      seatsUsed: 1,
      conflicts: 0,
      unmetConstraints: 0,
      classes: 1,
      elapsedMs: 1,
      seed: 1,
      adjacency: "king",
    },
    entries: [],
    conflicts: [],
    unmetConstraints: [],
    diagnostics: [],
    inputFingerprint: "fixture",
    generatedAt: "2026-09-30T00:00:00.000Z",
  };
}

/** 地点只在 job 的 rooms 里（`seating.location` 故意不给），这样才能验证页面确实把 rooms 传下去了。 */
const ROOMS: RoomSpec[] = [
  { id: "R1", name: "第一考场", rows: 6, cols: 5, location: "高二三班" },
  { id: "R2", name: "第二考场", rows: 6, cols: 5 },
];

const STUDENTS: StudentSchedule[] = [
  {
    studentId: "2026010001",
    name: "张三",
    className: "高三(1)班",
    combination: "物化生",
    slots: {
      T1: {
        subject: "chinese",
        subjectLabel: "语文",
        roomId: "R1",
        roomName: "第一考场",
        seatNo: 1,
      },
    },
    rooms: [{ roomId: "R1", roomName: "第一考场", subjects: ["chinese"] }],
    distinctRooms: 1,
  },
];

function fixture(): PlanAllResult {
  return {
    ok: true,
    slots: [{ id: "T1", name: "T1 语文", subjects: ["chinese"] }],
    seatings: [
      {
        subjects: ["chinese"],
        roomId: "R1",
        roomName: "第一考场",
        studentIds: ["2026010001"],
        seatNoById: { "2026010001": 1 },
        studentBySeatNo: { 1: "2026010001" },
        result: planResult(),
      },
    ],
    byStudent: STUDENTS,
    emptyRooms: ["R2"],
    overRoomLimit: [],
    relaxedRooms: [],
    borrowings: [],
    diagnostics: [],
    unmetConstraints: [],
  };
}

describe("导出：考场地点走 job.rooms，监考表不再有「监考：」", () => {
  it("监考表第二行小字是「地点：高二三班」，且全表没有「监考：」", () => {
    const sheets = buildInvigilatorSheets(fixture(), ROOMS);
    expect(sheets).toHaveLength(1);

    const text = sheetText(sheets[0]!);
    expect(text).toContain("地点：高二三班");
    expect(text).not.toContain("监考：");

    // 表头固定为 座位号 / 班级 / 姓名 / 准考证号 / 备注，正文有这位考生
    expect(text).toContain("座位号");
    expect(text).toContain("准考证号");
    expect(text).toContain("备注");
    expect(text).toContain("高三(1)班");
    expect(text).toContain("张三");
  });

  it("班级总表：考场列用「·」拼地点，地点同样取 job.rooms 的 location", () => {
    const sheets = buildClassScheduleSheets(fixture(), ROOMS);
    const overall = sheets[0]!;
    const rows = rowTexts(overall);

    const headers = rows.find((row) => row.includes("准考证号"));
    expect(headers).toBeDefined();
    // 考场与地点合并成一列，后面紧跟「主座位号」
    expect(headers![headers!.indexOf("主考场") + 1]).toBe("主座位号");

    const studentRow = rows.find((row) => row.includes("张三"));
    expect(studentRow).toBeDefined();
    // 地点里的中点会被清理后再拼上：高二·三班 → 高二三班
    expect(String(studentRow![headers!.indexOf("主考场")])).toBe("第一考场·高二三班");

    expect(sheetText(overall)).not.toContain("监考：");
  });

  it("没给 rooms 时地点退化成空/破折号，不会误报别人的地点", () => {
    const sheets = buildInvigilatorSheets(fixture(), undefined);
    expect(sheetText(sheets[0]!)).not.toContain("高二三班");
  });
});
