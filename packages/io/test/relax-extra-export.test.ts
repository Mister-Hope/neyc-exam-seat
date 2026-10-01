import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import type {
  PlanAllResult,
  PlanResult,
  RoomSpec,
  SeatingPlan,
  StudentSchedule,
} from "@exam-seat/core";

import {
  buildInvigilatorSheets,
  buildInvigilatorWorkbook,
  buildRoomSheets,
  readWorkbook,
} from "../src/index";
import { writePlanFiles } from "../src/node";
import { readAoa, rowValues, sheetValues } from "./helpers";

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

const BASE_RESULT: PlanResult = {
  resultVersion: 1,
  ok: true,
  level: "strict",
  stats: {
    students: 0,
    participants: 0,
    excluded: 0,
    rooms: 1,
    roomsUsed: 1,
    emptyRooms: [],
    seatsTotal: 37,
    seatsUsed: 0,
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
  inputFingerprint: "fnv1a:test",
  generatedAt: "2026-09-30T00:00:00.000Z",
};

/** 5 列 × 7 排 + 第 2、4 业务列各 1 个讲台侧加座 = 37 座。 */
const EXTRA_ROOM: RoomSpec = {
  id: "R1",
  name: "第一考场",
  rows: 7,
  cols: 5,
  extraFrontSeats: [2, 4],
};

const PLAIN_ROOM: RoomSpec = { id: "R1", name: "第一考场", rows: 6, cols: 5 };

function entry(room: RoomSpec, seatNo: number, name: string): PlanResult["entries"][number] {
  // 这里只做夹具；行列由 core 的编号规则决定，37 座时 15 / 30 是加座（行号 0）
  const extra = new Set(room.extraFrontSeats);
  let base = 0;
  for (let col = 1; col <= (room.cols ?? 1); col += 1) {
    const count = room.rows + (extra.has(col) ? 1 : 0);
    if (seatNo <= base + count) {
      const offset = seatNo - base;
      if (offset > room.rows) {
        return {
          studentId: `S${seatNo}`,
          name,
          className: "高三(1)班",
          roomId: room.id,
          roomName: room.name ?? room.id,
          seatNo,
          row: 0,
          col,
          physicalCol: room.cols - col + 1,
        };
      }
      const forward = (col - 1) % 2 === 0;
      const row = forward ? offset : room.rows - offset + 1;
      return {
        studentId: `S${seatNo}`,
        name,
        className: "高三(1)班",
        roomId: room.id,
        roomName: room.name ?? room.id,
        seatNo,
        row,
        col,
        physicalCol: room.cols - col + 1,
      };
    }
    base += count;
  }
  throw new Error(`座位号 ${seatNo} 超出 ${room.id} 容量`);
}

function planResult(room: RoomSpec, seats: { seatNo: number; name: string }[]): PlanResult {
  return {
    ...BASE_RESULT,
    stats: { ...BASE_RESULT.stats, seatsUsed: seats.length, seatsTotal: room.rows * room.cols },
    entries: seats.map(({ seatNo, name }) => entry(room, seatNo, name)),
  };
}

/* ------------------------------------------------------------------ */
/* 座位表：加座                                                        */
/* ------------------------------------------------------------------ */

describe("座位表：讲台侧加座", () => {
  const result = planResult(EXTRA_ROOM, [
    { seatNo: 1, name: "甲" },
    { seatNo: 15, name: "丙" },
    { seatNo: 30, name: "丁" },
    { seatNo: 37, name: "戊" },
  ]);

  it("有加座时在网格最上面多画一行「加座」，加座落在对应业务列", () => {
    const sheets = readWorkbook(
      buildRoomSheets(result, () => ({
        rows: EXTRA_ROOM.rows,
        cols: EXTRA_ROOM.cols,
        name: "第一考场",
        extraFrontSeats: EXTRA_ROOM.extraFrontSeats,
      })),
    );
    expect(sheets).toHaveLength(1);
    const sheet = sheets[0]!;
    expect(sheet.name).toBe("第一考场");
    // 第 0 行 = 加座行；加座 15 在第 2 列、30 在第 4 列
    expect(sheet.rows[0]![0]).toBe("加座");
    expect(sheet.rows[0]![2]).toContain("丙");
    expect(sheet.rows[0]![4]).toContain("丁");
    // 加座行不画在普通排里
    expect(sheet.rows[0]![1]).toBe("");
    expect(sheet.rows[0]![3]).toBe("");

    // 第 1 排紧跟在加座行之后；1 号在第 1 列
    expect(sheet.rows[1]![0]).toBe("第1排");
    expect(sheet.rows[1]![1]).toContain("甲");
    // 第 5 列 31–37 从前排到后排：37 号在第 7 排
    expect(sheet.rows[7]![0]).toBe("第7排");
    expect(sheet.rows[7]![5]).toContain("戊");
    expect(sheet.rows[1]![5]).toBe("");
  });

  it("没有加座时行为不变：第一行就是「第1排」，不出现「加座」", () => {
    const plain = planResult(PLAIN_ROOM, [{ seatNo: 2, name: "乙" }]);
    const sheets = readWorkbook(
      buildRoomSheets(plain, () => ({
        rows: PLAIN_ROOM.rows,
        cols: PLAIN_ROOM.cols,
        name: "第一考场",
      })),
    );
    const sheet = sheets[0]!;
    expect(sheet.rows[0]![0]).toBe("第1排");
    expect(sheet.rows.some((row) => row[0] === "加座")).toBe(false);
    expect(sheet.rows[0]![1]).toBe(""); // 座位 2 在第 1 列第 2 排
    expect(sheet.rows[1]![1]).toContain("乙");
  });

  it("writePlanFiles 把 room.extraFrontSeats 传给座位表", () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "exam-seat-extra-"));
    try {
      const written = writePlanFiles(result, { outDir: dir, rooms: [EXTRA_ROOM] });
      expect(written.files.some((file) => file.endsWith("考场座位表.xlsx"))).toBe(true);
      expect(readdirSync(dir)).toContain("考场座位表.xlsx");
      const sheets = readWorkbook(readFileSync(nodePath.join(dir, "考场座位表.xlsx")));
      expect(sheets[0]!.rows[0]![0]).toBe("加座");
      expect(sheets[0]!.rows[0]![2]).toContain("丙");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* 监考表：放宽标注 + 备注（判定本身在 attendance-remark.test.ts）        */
/* ------------------------------------------------------------------ */

const SEATING_RELAXED: SeatingPlan = {
  subjects: ["biology"],
  roomId: "R18",
  roomName: "第十八考场",
  location: "生物实验室",
  note: "王老师",
  studentIds: ["B01", "B02"],
  seatNoById: { B01: 1, B02: 2 },
  studentBySeatNo: { 1: "B01", 2: "B02" },
  result: planResult(PLAIN_ROOM, [
    { seatNo: 1, name: "李雷" },
    { seatNo: 2, name: "某生" },
  ]),
  relaxedSameClass: true,
  borrowedSubjects: { B02: ["biology"] },
};

function schedule(
  studentId: string,
  name: string,
  className: string,
  seatNo: number,
): StudentSchedule {
  return {
    studentId,
    name,
    className,
    combination: "物化政",
    slots: {
      T6: {
        subject: "biology",
        subjectLabel: "生物",
        roomId: "R18",
        roomName: "第十八考场",
        seatNo,
      },
    },
    rooms: [{ roomId: "R18", roomName: "第十八考场", subjects: ["biology"] }],
    distinctRooms: 1,
  };
}

const PLAN_ALL: PlanAllResult = {
  ok: true,
  slots: [{ id: "T6", name: "第6时段", subjects: ["biology"] }],
  seatings: [SEATING_RELAXED],
  byStudent: [schedule("B01", "李雷", "高三(1)班", 1), schedule("B02", "某生", "高三(2)班", 2)],
  emptyRooms: [],
  overRoomLimit: [],
  unmetConstraints: [],
  relaxedRooms: ["R18"],
  borrowings: [
    {
      studentId: "B02",
      name: "某生",
      className: "高三(2)班",
      subject: "biology",
      subjectLabel: "生物",
      roomId: "R18",
      roomName: "第十八考场",
      seatNo: 2,
    },
  ],
  diagnostics: [],
};

describe("监考表：放宽同班相邻 + 备注列", () => {
  it("第二行是「地点：… ｜ 考场人数：N」，放宽的考场补标注；第三行是具名表头", () => {
    const [sheet] = buildInvigilatorSheets(PLAN_ALL, undefined);
    expect(rowValues(sheet!.rows[0]!)[0]).toBe("第十八考场（生物）");
    expect(String(rowValues(sheet!.rows[1]!)[0])).toBe(
      "地点：生物实验室 ｜ 考场人数：2 ｜ 本考场已放宽同班相邻",
    );
    expect(rowValues(sheet!.rows[2]!)).toEqual(["座位号", "班级", "姓名", "准考证号", "备注"]);
  });

  it("不再出现「监考：…」那一行", () => {
    const [sheet] = buildInvigilatorSheets(PLAN_ALL, undefined);
    expect(JSON.stringify(sheetValues(sheet!))).not.toContain("监考");
  });

  it("单科房间里考满全场 → 备注留空（借考字样也不再出现，v3 只留科目）", () => {
    const [sheet] = buildInvigilatorSheets(PLAN_ALL, undefined);
    expect(sheet!.rows.slice(3).map((row) => rowValues(row))).toEqual([
      [1, "高三(1)班", "李雷", "B01", ""],
      [2, "高三(2)班", "某生", "B02", ""],
    ]);
    expect(JSON.stringify(sheetValues(sheet!))).not.toContain("借考");
  });

  it("拿不到该生时刻表时不写备注，也不输出 undefined", () => {
    const noSchedule: PlanAllResult = { ...PLAN_ALL, byStudent: [] };
    const [sheet] = buildInvigilatorSheets(noSchedule, undefined);
    expect(rowValues(sheet!.rows.slice(3)[1]!)[4]).toBe("");
    expect(JSON.stringify(sheetValues(sheet!))).not.toContain("undefined");
  });

  it("没放宽、没借考时第二行不带标注，正文仍带空的备注列", () => {
    const plain: PlanAllResult = {
      ...PLAN_ALL,
      seatings: [{ ...SEATING_RELAXED, relaxedSameClass: undefined, borrowedSubjects: undefined }],
      relaxedRooms: [],
      borrowings: [],
    };
    const [sheet] = buildInvigilatorSheets(plain, undefined);
    expect(String(rowValues(sheet!.rows[1]!)[0])).toBe("地点：生物实验室 ｜ 考场人数：2");
    expect(sheet!.rows.slice(3).map((row) => rowValues(row))).toEqual([
      [1, "高三(1)班", "李雷", "B01", ""],
      [2, "高三(2)班", "某生", "B02", ""],
    ]);
  });

  it("rooms 里给了 location 时优先用 job 的（seating 没带 location）", () => {
    const noLocation: PlanAllResult = {
      ...PLAN_ALL,
      seatings: [{ ...SEATING_RELAXED, location: undefined }],
    };
    const [sheet] = buildInvigilatorSheets(noLocation, [
      { id: "R18", name: "第十八考场（生物）", rows: 6, cols: 5, location: "生物实验室二" },
    ]);
    expect(String(rowValues(sheet!.rows[1]!)[0])).toBe(
      "地点：生物实验室二 ｜ 考场人数：2 ｜ 本考场已放宽同班相邻",
    );
  });

  it("导出成工作簿后仍能读回标注（这张表没有备注）", () => {
    const bytes = buildInvigilatorWorkbook(PLAN_ALL, undefined);
    expect(readWorkbook(bytes).map((sheet) => sheet.name)).toContain("第十八考场（生物）");
    const aoa = readAoa(bytes, "第十八考场（生物）");
    expect(aoa[2]).toEqual(["座位号", "班级", "姓名", "准考证号", "备注"]);
    expect(aoa[4]![4]).toBe("");
    expect(aoa[0]![0]).toBe("第十八考场（生物）");
  });
});
