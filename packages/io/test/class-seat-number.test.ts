import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import type {
  PlanAllResult,
  PlanResult,
  RoomSpec,
  SeatingPlan,
  StudentRoomUsage,
  StudentSchedule,
  StudentSlotAssignment,
  TimeSlot,
} from "@exam-seat/core";

import {
  buildClassScheduleRows,
  buildClassScheduleSheets,
  buildClassScheduleWorkbook,
  cleanLocationText,
  roomColumnValue,
  seatNumbersInRoom,
  seatNumberText,
} from "../src/index";
import { rowValues, toArrayBuffer, zipText } from "./helpers";

/* ------------------------------------------------------------------ */
/* 夹具（合成数据，不含任何真实名单）                                     */
/* ------------------------------------------------------------------ */

const SLOTS: TimeSlot[] = [
  { id: "T1", name: "第1时段", subjects: [] },
  { id: "T2", name: "第2时段", subjects: [] },
  { id: "T3", name: "第3时段", subjects: [] },
  { id: "T4", name: "第4时段", subjects: [] },
  { id: "T5", name: "第5时段", subjects: [] },
];

interface Seat {
  slotId: string;
  subject: string;
  roomId: string;
  seatNo: number;
}

const ROOM_NAMES: Record<string, string> = { R1: "第一考场", R2: "第二考场" };
const ROOM_LOCATIONS: Record<string, string> = { R1: "高一·四班", R2: "生物实验室" };

function schedule(
  studentId: string,
  name: string,
  className: string,
  seats: Seat[],
): StudentSchedule {
  const slots: Record<string, StudentSlotAssignment | null> = {};
  const rooms: StudentRoomUsage[] = [];
  for (const { slotId, subject, roomId, seatNo } of seats) {
    slots[slotId] = {
      subject,
      subjectLabel: subject,
      roomId,
      roomName: ROOM_NAMES[roomId] ?? roomId,
      location: ROOM_LOCATIONS[roomId],
      seatNo,
    };
    if (!rooms.some((room) => room.roomId === roomId)) {
      rooms.push({
        roomId,
        roomName: ROOM_NAMES[roomId] ?? roomId,
        location: ROOM_LOCATIONS[roomId],
        subjects: [],
      });
    }
  }
  for (const room of rooms) {
    room.subjects = seats.filter((seat) => seat.roomId === room.roomId).map((seat) => seat.subject);
  }
  return {
    studentId,
    name,
    className,
    combination: null,
    slots,
    rooms,
    distinctRooms: rooms.length,
  };
}

const ROOMS: RoomSpec[] = [
  { id: "R1", name: "第一考场", location: "高一·四班", rows: 6, cols: 5 },
  { id: "R2", name: "第二考场", location: "生物实验室", rows: 6, cols: 5 },
];

const HEADERS = ["班级", "姓名", "准考证号", "主考场", "主座位号", "单科考场1", "座位号1"];

/** 甲：主考场 R1 里有两个号（12/15，同考场两科两套方案）+ 政治借考去 R2（7 号）。 */
const STUDENT_A = schedule("STU-A", "同学甲", "2501", [
  { slotId: "T1", subject: "chinese", roomId: "R1", seatNo: 12 },
  { slotId: "T2", subject: "math", roomId: "R1", seatNo: 12 },
  { slotId: "T3", subject: "english", roomId: "R1", seatNo: 12 },
  // 同一间考场承担物理（另一套座位方案）→ 15 号
  { slotId: "T4", subject: "physics", roomId: "R1", seatNo: 15 },
  { slotId: "T5", subject: "politics", roomId: "R2", seatNo: 7 },
]);

/** 乙：只有主考场 R1，每个时段都是 3 号。 */
const STUDENT_B = schedule("STU-B", "同学乙", "2502", [
  { slotId: "T1", subject: "chinese", roomId: "R1", seatNo: 3 },
  { slotId: "T2", subject: "math", roomId: "R1", seatNo: 3 },
  { slotId: "T3", subject: "english", roomId: "R1", seatNo: 3 },
]);

function seating(roomId: string, subjects: string[], studentIds: string[]): SeatingPlan {
  const seatNoById: Record<string, number> = {};
  for (const [index, studentId] of studentIds.entries()) seatNoById[studentId] = index + 1;
  return {
    subjects,
    roomId,
    roomName: ROOM_NAMES[roomId]!,
    location: ROOM_LOCATIONS[roomId],
    studentIds,
    seatNoById,
    studentBySeatNo: {},
    result: { ok: true } as unknown as PlanResult,
  };
}

const PLAN: PlanAllResult = {
  ok: true,
  slots: SLOTS,
  seatings: [
    seating("R1", ["chinese", "math", "english", "physics"], ["STU-A", "STU-B"]),
    seating("R2", ["politics"], ["STU-A"]),
  ],
  byStudent: [STUDENT_A, STUDENT_B],
  emptyRooms: [],
  overRoomLimit: [],
  unmetConstraints: [],
  relaxedRooms: [],
  borrowings: [],
  diagnostics: [],
};

/* ------------------------------------------------------------------ */
/* 纯函数                                                              */
/* ------------------------------------------------------------------ */

describe("seatNumbersInRoom / seatNumberText", () => {
  it("同一个考场多个号 → 去重 + 升序，全都要（返回字符串）", () => {
    expect(seatNumbersInRoom(STUDENT_A, "R1")).toEqual([12, 15]);
    expect(seatNumberText(STUDENT_A, "R1")).toBe("12/15");
    expect(seatNumberText(STUDENT_A, "R1")).toBeTypeOf("string");
  });

  it("单号 → 返回 number（Excel 里能排序）；没去过这个考场 → 空数组 / 空串", () => {
    expect(seatNumbersInRoom(STUDENT_B, "R1")).toEqual([3]);
    expect(seatNumberText(STUDENT_B, "R1")).toBe(3);
    expect(seatNumberText(STUDENT_B, "R1")).toBeTypeOf("number");
    expect(seatNumberText(STUDENT_A, "R2")).toBe(7);
    expect(seatNumberText(STUDENT_A, "R2")).toBeTypeOf("number");
    expect(seatNumbersInRoom(STUDENT_B, "R2")).toEqual([]);
    expect(seatNumberText(STUDENT_B, "R2")).toBe("");
    expect(seatNumberText(STUDENT_A, "R9")).toBe("");
  });

  it("不改学生的 slots", () => {
    const before = JSON.stringify(STUDENT_A.slots);
    seatNumbersInRoom(STUDENT_A, "R1");
    expect(JSON.stringify(STUDENT_A.slots)).toBe(before);
  });
});

describe("cleanLocationText / roomColumnValue：考场·地点 拼接", () => {
  it("地点里的点去掉，其余原样", () => {
    expect(cleanLocationText("高二·5班")).toBe("高二5班");
    expect(cleanLocationText("高一 · 四班")).toBe("高一 四班");
    expect(cleanLocationText("生物·实验室·二")).toBe("生物实验室二");
    expect(cleanLocationText("录播教室")).toBe("录播教室");
  });

  it("拼接用「·」，地点为空时不出现「·」", () => {
    expect(roomColumnValue("第一考场", "高二5班")).toBe("第一考场·高二5班");
    expect(roomColumnValue("第十九考场（政治）", "录播教室")).toBe("第十九考场（政治）·录播教室");
    expect(roomColumnValue("第一考场", "")).toBe("第一考场");
    expect(roomColumnValue("第一考场", "  ")).toBe("第一考场");
  });

  it("不改输入：清理只是拼接时的一次性映射", () => {
    const location = "高二·5班";
    const room = { location };
    expect(roomColumnValue("第一考场", room.location)).toBe("第一考场·高二5班");
    expect(room.location).toBe("高二·5班"); // 原对象没被改写
  });
});

/* ------------------------------------------------------------------ */
/* 列结构                                                              */
/* ------------------------------------------------------------------ */

describe("班级表列结构：考场(含地点) / 座位号 两列一组", () => {
  it("表头逐列等于冻死的结构", () => {
    const { headers } = buildClassScheduleRows(PLAN, ROOMS);
    expect(headers).toEqual(HEADERS);
  });

  it("样例行：考场列合并地点（点已清理），多号 12/15、单号是数字", () => {
    const { rows } = buildClassScheduleRows(PLAN, ROOMS);
    const values = rowValues(rows[0]!);
    expect(values).toEqual([
      "2501",
      "同学甲",
      "STU-A",
      "第一考场·高一四班", // 地点里的「·」已去掉
      "12/15", // 同考场两套方案 → 多号（字符串）
      "第二考场（政治）·生物实验室",
      7, // 单科考场座位号（number）
    ]);
    expect(values[4]).toBeTypeOf("string");
    expect(values[6]).toBeTypeOf("number");

    const single = rowValues(rows[1]!);
    expect(single).toEqual(["2502", "同学乙", "STU-B", "第一考场·高一四班", 3, "", ""]);
    expect(single[4]).toBeTypeOf("number");
  });

  it("考场列 = 考场名·地点（只有一个分隔符、不带座位号）；座位号列只有号", () => {
    const { rows, headers } = buildClassScheduleRows(PLAN, ROOMS);
    for (const row of rows) {
      const values = rowValues(row);
      const rooms = headers
        .map((header, index) => ({ header, index }))
        .filter(({ header }) => header === "主考场" || /^单科考场\d+$/.test(header));
      for (const { index } of rooms) {
        const roomText = String(values[index] ?? "");
        if (roomText === "") continue;
        // 至多一个分隔符，且地点里的点已经被清掉
        expect(roomText.split("·")).toHaveLength(2);
        expect(roomText).not.toMatch(/\d+$/); // 不带座位号
      }
      const seats = headers
        .map((header, index) => ({ header, index }))
        .filter(({ header }) => header === "主座位号" || /^座位号\d+$/.test(header));
      for (const { index } of seats) {
        expect(String(values[index] ?? "")).toMatch(/^(?:\d+(?:\/\d+)*)?$/);
      }
    }
  });

  it("地点为空时不出现「·」", () => {
    const noLocation: PlanAllResult = {
      ...PLAN,
      byStudent: PLAN.byStudent.map((student) => ({
        ...student,
        rooms: student.rooms.map((room) => ({
          roomId: room.roomId,
          roomName: room.roomName,
          subjects: room.subjects,
        })),
      })),
    };
    const { rows } = buildClassScheduleRows(noLocation, [
      { id: "R1", name: "第一考场", rows: 6, cols: 5 },
      { id: "R2", name: "第二考场", rows: 6, cols: 5 },
    ]);
    expect(rowValues(rows[0]!)[3]).toBe("第一考场");
    expect(rowValues(rows[0]!)[5]).toBe("第二考场（政治）");
  });

  it("导出不改输入：plan / job 里的 location 原样保留", () => {
    const snapshot = JSON.stringify(PLAN);
    buildClassScheduleRows(PLAN, ROOMS);
    buildClassScheduleSheets(PLAN, ROOMS);
    expect(JSON.stringify(PLAN)).toBe(snapshot);
    // 原始 location 还是带点的
    expect(PLAN.byStudent[0]!.rooms[0]!.location).toBe("高一·四班");
  });

  it("每班单文件与总表同结构（表头一致）", () => {
    const sheets = buildClassScheduleSheets(PLAN, ROOMS);
    const [overall, classOne] = sheets;
    expect(overall!.name).toBe("总表");
    expect(rowValues(overall!.rows[2]!)).toEqual(HEADERS);
    expect(rowValues(classOne!.rows[2]!)).toEqual(HEADERS);
    // 单班文件（className 过滤）也一致
    const [single] = buildClassScheduleSheets(PLAN, ROOMS, { className: "2501" });
    expect(rowValues(single!.rows[2]!)).toEqual(HEADERS);
    expect(rowValues(single!.rows[3]!)[4]).toBe("12/15");
  });

  it("写进 xlsx 后：单号是数字单元格（t=n），多号是字符串单元格", () => {
    const bytes = buildClassScheduleWorkbook(PLAN, ROOMS, { generatedAt: "2026-10-01 09:00" });
    const sheet = XLSX.read(toArrayBuffer(bytes), { type: "array" }).Sheets["总表"]!;
    // 第 3 行是表头，第 4 行同学甲（主座位号多号 12/15）、第 5 行同学乙（单号 3）
    expect(sheet.E4!.v).toBe("12/15");
    expect(sheet.E4!.t).toBe("s");
    expect(sheet.E5!.v).toBe(3);
    expect(sheet.E5!.t).toBe("n");
    // 单科考场座位号（G 列）：同学甲 7 号
    expect(sheet.G4!.v).toBe(7);
    expect(sheet.G4!.t).toBe("n");
  });

  it("新增列后整表总宽仍 ≤ 27.8cm", () => {
    const bytes = buildClassScheduleWorkbook(PLAN, ROOMS, { generatedAt: "2026-10-01 09:00" });
    const xml = zipText(bytes, "xl/worksheets/sheet1.xml");
    const widths = [...xml.matchAll(/<col min="\d+" max="\d+" width="(?:[\d.]+)"/g)].map((match) =>
      Number(match[0].replace(/.*width="/, "").replace(/".*/, "")),
    );
    expect(widths).toHaveLength(HEADERS.length);
    expect(widths.reduce((sum, width) => sum + width, 0) * 0.185).toBeLessThanOrEqual(27.8 + 1e-9);
    // 座位号列的内容只有 1–5 个字符（`12` / `12/15`），列宽由表头文案决定（不超过 20 字符宽）
    const seatWidths = HEADERS.map((header, index) => ({ header, width: widths[index]! })).filter(
      ({ header }) => header === "主座位号" || /^座位号\d+$/.test(header),
    );
    expect(seatWidths).toHaveLength(2);
    expect(seatWidths.every(({ width }) => width >= 6 && width <= 20)).toBe(true);
  });
});
