import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import type {
  Job,
  PlanAllResult,
  PlanResult,
  RoomSpec,
  SeatingPlan,
  StudentSchedule,
  StudentSlotAssignment,
} from "@exam-seat/core";

import {
  buildInvigilatorSheets,
  buildInvigilatorWorkbook,
  chineseNumberToArabic,
  compareRoomOrder,
  readWorkbook,
  roomOrderKey,
  sortByRoomOrder,
} from "../src/index";
import { writeMultiPlanFiles } from "../src/node";
import { sheetValues } from "./helpers";

/* ------------------------------------------------------------------ */
/* 中文数字解析（表驱动）                                                */
/* ------------------------------------------------------------------ */

describe("chineseNumberToArabic：中文数字 → 阿拉伯数字", () => {
  it.each([
    ["一", 1],
    ["二", 2],
    ["两", 2],
    ["十", 10],
    ["十一", 11],
    ["十五", 15],
    ["十七", 17],
    ["十九", 19],
    ["二十", 20],
    ["二十三", 23],
    ["九十九", 99],
    ["一百", 100],
    ["一百零一", 101],
    ["一百一十", 110],
    ["一百二十三", 123],
    ["12", 12],
    ["017", 17],
    ["０７", 7],
    ["〇", 0],
    [" 十七 ", 17],
  ])("%s → %i", (text, expected) => {
    expect(chineseNumberToArabic(text)).toBe(expected);
  });

  it.each([
    [""],
    ["   "],
    ["考场"],
    ["第"],
    ["十七考场"],
    ["abc"],
    ["十十"],
    ["一七"],
    ["十二三"],
    ["零下"],
    ["万"],
  ])("%s → undefined（不抛异常）", (text) => {
    expect(chineseNumberToArabic(text)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 排序键                                                              */
/* ------------------------------------------------------------------ */

describe("roomOrderKey / compareRoomOrder", () => {
  it("从「第…考场」里取序号", () => {
    expect(roomOrderKey({ id: "R17", name: "第十七考场 （语史政数英地）" })).toBe(17);
    expect(roomOrderKey({ id: "R1", name: "第一考场" })).toBe(1);
    expect(roomOrderKey({ id: "R12", name: "第12考场" })).toBe(12);
    expect(roomOrderKey({ id: "R19", name: "第十九考场（政地）" })).toBe(19);
  });

  it("解析不出返回 undefined；名字为空时退回 id（也解析不出）", () => {
    expect(roomOrderKey({ id: "R1", name: "生物实验室" })).toBeUndefined();
    expect(roomOrderKey({ id: "R1" })).toBeUndefined();
    expect(roomOrderKey({ id: "后备考场", name: "" })).toBeUndefined();
  });

  it("比较器把解析不出的排最后，两边都解析不出算相等", () => {
    expect(
      compareRoomOrder({ id: "a", name: "第一考场" }, { id: "b", name: "第二考场" }),
    ).toBeLessThan(0);
    expect(
      compareRoomOrder({ id: "b", name: "第十一考场" }, { id: "a", name: "第三考场" }),
    ).toBeGreaterThan(0);
    expect(
      compareRoomOrder({ id: "a", name: "第一考场" }, { id: "b", name: "生物实验室" }),
    ).toBeLessThan(0);
    expect(
      compareRoomOrder({ id: "a", name: "生物实验室" }, { id: "b", name: "第一考场" }),
    ).toBeGreaterThan(0);
    expect(compareRoomOrder({ id: "a", name: "生物实验室" }, { id: "b", name: "待定" })).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 场景夹具                                                            */
/* ------------------------------------------------------------------ */

interface RoomScene {
  id: string;
  name: string;
  subjects: string[];
}

/** 每间考场一个学生，他的座位时段都在这间、且正好考这间的全部科目。 */
function sceneOf(rooms: RoomScene[]): { plan: PlanAllResult; rooms: RoomSpec[]; job: Job } {
  const seatings: SeatingPlan[] = [];
  const byStudent: StudentSchedule[] = [];
  const students: Job["students"] = [];

  // 学生身份由 roomId 决定（不按下标），这样「单间 sceneOf」与「整场 sceneOf」里同一间的内容可比
  for (const room of rooms) {
    const studentId = `STU-${room.id}`;
    const slots: Record<string, StudentSlotAssignment | null> = {};
    room.subjects.forEach((subject, slotIndex) => {
      slots[`T${slotIndex + 1}`] = {
        subject,
        subjectLabel: subject,
        roomId: room.id,
        roomName: room.name,
        seatNo: 1,
      };
    });
    byStudent.push({
      studentId,
      name: `学生-${room.id}`,
      className: `班-${room.id}`,
      combination: null,
      slots,
      rooms: [
        {
          roomId: room.id,
          roomName: room.name,
          location: `地点${room.id}`,
          subjects: room.subjects,
        },
      ],
      distinctRooms: 1,
    });
    students.push({ id: studentId, name: `学生-${room.id}`, className: `班-${room.id}` });
    seatings.push({
      subjects: room.subjects,
      roomId: room.id,
      roomName: room.name,
      location: `地点${room.id}`,
      studentIds: [studentId],
      seatNoById: { [studentId]: 1 },
      studentBySeatNo: { 1: studentId },
      result: { ok: true } as unknown as PlanResult,
    });
  }

  const roomsSpec: RoomSpec[] = rooms.map((room) => ({
    id: room.id,
    name: room.name,
    location: `地点${room.id}`,
    rows: 6,
    cols: 5,
  }));

  return {
    plan: {
      ok: true,
      slots: [],
      seatings,
      byStudent,
      emptyRooms: [],
      overRoomLimit: [],
      unmetConstraints: [],
      relaxedRooms: [],
      borrowings: [],
      diagnostics: [],
    },
    rooms: roomsSpec,
    job: { jobVersion: 2, meta: { title: "排序测试" }, students, rooms: roomsSpec },
  };
}

/** 乱序输入：第十七、第十八、第一、第二、第十一、第三。 */
const SCRAMBLED: RoomScene[] = [
  { id: "R17", name: "第十七考场 （语史政数英地）", subjects: ["politics"] },
  { id: "R18", name: "第十八考场 （语物化数英生）", subjects: ["biology"] },
  { id: "R1", name: "第一考场", subjects: ["chinese"] },
  { id: "R2", name: "第二考场", subjects: ["math"] },
  { id: "R11", name: "第十一考场", subjects: ["english"] },
  { id: "R3", name: "第三考场", subjects: ["physics"] },
];

const EXPECTED_ORDER = [
  "第一考场（语文）",
  "第二考场（数学）",
  "第三考场（物理）",
  "第十一考场（外语）",
  "第十七考场（政治）",
  "第十八考场（生物）",
];

/* ------------------------------------------------------------------ */
/* sheet 顺序                                                          */
/* ------------------------------------------------------------------ */

describe("监考表 sheet 按考场序号自然排序", () => {
  const { plan, rooms } = sceneOf(SCRAMBLED);

  it("乱序 seatings → 第一、第二、第三、第十一、第十七、第十八", () => {
    const sheets = buildInvigilatorSheets(plan, rooms);
    expect(sheets.map((sheet) => sheet.name)).toEqual(EXPECTED_ORDER);
  });

  it("排序不改数据：sheet 数量不变、每张表内容与乱序输入逐格一致", () => {
    const sheets = buildInvigilatorSheets(plan, rooms);
    expect(sheets).toHaveLength(SCRAMBLED.length);

    // 逐间单独出一张表当基线，再按名字比对
    const baseline = new Map<string, string>();
    for (const scene of SCRAMBLED) {
      const single = sceneOf([scene]);
      const [sheet] = buildInvigilatorSheets(single.plan, single.rooms);
      baseline.set(sheet!.name, JSON.stringify(sheetValues(sheet!)));
    }
    for (const sheet of sheets) {
      expect(JSON.stringify(sheetValues(sheet))).toBe(baseline.get(sheet.name));
    }
  });

  it("不动 plan.seatings 的顺序（只在展示/导出层排）", () => {
    const before = plan.seatings.map((seating) => seating.roomId);
    buildInvigilatorSheets(plan, rooms);
    buildInvigilatorWorkbook(plan, rooms);
    expect(plan.seatings.map((seating) => seating.roomId)).toEqual(before);
    expect(before).toEqual(["R17", "R18", "R1", "R2", "R11", "R3"]);
  });

  it("合并工作簿的 sheet 顺序同样有序", () => {
    const sheets = readWorkbook(buildInvigilatorWorkbook(plan, rooms));
    expect(sheets.map((sheet) => sheet.name)).toEqual(EXPECTED_ORDER);
  });
});

describe("排序：解析不出的考场名排最后且稳定", () => {
  const MIXED: RoomScene[] = [
    { id: "R3", name: "第三考场", subjects: ["physics"] },
    { id: "RX", name: "生物实验室", subjects: ["biology"] },
    { id: "R1", name: "第一考场", subjects: ["chinese"] },
    { id: "RY", name: "待定", subjects: ["math"] },
    { id: "R2", name: "第二考场", subjects: ["english"] },
  ];
  const { plan, rooms } = sceneOf(MIXED);

  it("有名字的按序号在前，解析不出的按输入顺序排在最后", () => {
    const sheets = buildInvigilatorSheets(plan, rooms);
    expect(sheets.map((sheet) => sheet.name)).toEqual([
      "第一考场（语文）",
      "第二考场（外语）",
      "第三考场（物理）",
      "生物实验室（生物）",
      "待定（数学）",
    ]);
  });

  it("sortByRoomOrder 是稳定排序（不丢元素、不改原数组）", () => {
    const items = [
      { id: "a", name: "第三考场" },
      { id: "b", name: "生物实验室" },
      { id: "c", name: "第一考场" },
      { id: "d", name: "待定" },
      { id: "e", name: "第二考场" },
    ];
    const sorted = sortByRoomOrder(items, (item) => item);
    expect(sorted.map((item) => item.id)).toEqual(["c", "e", "a", "b", "d"]);
    expect(items.map((item) => item.id)).toEqual(["a", "b", "c", "d", "e"]); // 原数组没动
    expect(sorted).toHaveLength(items.length);
  });
});

/* ------------------------------------------------------------------ */
/* 单独落盘的文件顺序                                                   */
/* ------------------------------------------------------------------ */

describe("每考场单独文件的顺序与合并工作簿一致", () => {
  it("writeMultiPlanFiles 的 考场监考表/ 文件顺序 = 合并工作簿 sheet 顺序", () => {
    const { plan, rooms, job } = sceneOf(SCRAMBLED);
    const dir = mkdtempSync(nodePath.join(tmpdir(), "exam-seat-order-"));
    try {
      const written = writeMultiPlanFiles(plan, { outDir: dir, rooms, job });
      const roomDir = nodePath.join(dir, "考场监考表");
      const fileNames = written.files
        .filter((file) => nodePath.dirname(file) === roomDir)
        .map((file) => nodePath.basename(file, ".xlsx"));
      expect(fileNames).toEqual(EXPECTED_ORDER);

      const merged = readWorkbook(buildInvigilatorWorkbook(plan, rooms)).map((sheet) => sheet.name);
      expect(merged).toEqual(fileNames);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
