import { describe, expect, it } from "vitest";

import { subjectLabel } from "@exam-seat/core";
import type {
  PlanAllResult,
  PlanResult,
  RoomSpec,
  SeatingPlan,
  StudentSchedule,
  StudentSlotAssignment,
  TimeSlot,
} from "@exam-seat/core";

import {
  absentSubjectsInSeating,
  buildClassScheduleRows,
  buildInvigilatorSheets,
  seatingAttendance,
  seatingRemark,
  studentMainRoomId,
} from "../src/index";
import { rowValues, sheetValues } from "./helpers";

/* ------------------------------------------------------------------ */
/* 夹具（合成数据，不含任何真实名单）                                     */
/* ------------------------------------------------------------------ */

const SIX_SUBJECTS = ["chinese", "math", "english", "physics", "chemistry", "biology"];

const SLOTS: TimeSlot[] = Array.from({ length: 7 }, (_, index) => ({
  id: `T${index + 1}`,
  name: `第${index + 1}时段`,
  subjects: [],
}));

interface Assignment {
  slotId: string;
  subject: string;
  roomId: string;
}

function schedule(
  studentId: string,
  name: string,
  className: string,
  assignments: Assignment[],
): StudentSchedule {
  const slots: Record<string, StudentSlotAssignment | null> = {};
  const rooms: StudentSchedule["rooms"] = [];
  for (const { slotId, subject, roomId } of assignments) {
    slots[slotId] = {
      subject,
      subjectLabel: subjectLabel(subject),
      roomId,
      roomName: roomId,
      seatNo: 1,
    };
    if (!rooms.some((room) => room.roomId === roomId)) {
      rooms.push({ roomId, roomName: roomId, location: "某个教室", subjects: [] });
    }
  }
  for (const room of rooms) {
    room.subjects = assignments
      .filter((item) => item.roomId === room.roomId)
      .map((item) => item.subject);
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

function makeSeating(
  subjects: string[],
  seatNoById: Record<string, number>,
  extra: Partial<SeatingPlan> = {},
): SeatingPlan {
  const studentBySeatNo: Record<number, string> = {};
  for (const [studentId, seatNo] of Object.entries(seatNoById)) studentBySeatNo[seatNo] = studentId;
  return {
    subjects,
    roomId: "R18",
    roomName: "第十八考场",
    location: "生物实验室",
    studentIds: Object.keys(seatNoById),
    seatNoById,
    studentBySeatNo,
    result: { ok: true } as unknown as PlanResult,
    ...extra,
  };
}

function makePlan(seatings: SeatingPlan[], byStudent: StudentSchedule[]): PlanAllResult {
  return {
    ok: true,
    slots: SLOTS,
    seatings,
    byStudent,
    emptyRooms: [],
    overRoomLimit: [],
    unmetConstraints: [],
    relaxedRooms: [],
    borrowings: [],
    diagnostics: [],
  };
}

/** 语数外物化（T1–T5）在 `roomId`；`last` 是之后某一科的安排。 */
function corePlus(roomId: string, last?: Assignment): Assignment[] {
  const assignments: Assignment[] = ["chinese", "math", "english", "physics", "chemistry"].map(
    (subject, index) => ({ slotId: `T${index + 1}`, subject, roomId }),
  );
  if (last) assignments.push(last);
  return assignments;
}

const sixAt = (roomId: string): Assignment[] =>
  SIX_SUBJECTS.map((subject, index) => ({ slotId: `T${index + 1}`, subject, roomId }));

/* ------------------------------------------------------------------ */
/* 主考场判定                                                          */
/* ------------------------------------------------------------------ */

describe("studentMainRoomId：语数外所在考场就是主考场", () => {
  it("语数外在一间、单科在另一间 → 取语数外那间", () => {
    const student = schedule(
      "S1",
      "同学甲",
      "2501",
      corePlus("R18", { slotId: "T6", subject: "biology", roomId: "R20" }),
    );
    expect(studentMainRoomId(student)).toBe("R18");
  });

  it("没有语数外信息时退回「座位时段最多」的考场", () => {
    const student = schedule("S2", "同学乙", "2502", [
      { slotId: "T1", subject: "biology", roomId: "R20" },
      { slotId: "T2", subject: "politics", roomId: "R20" },
      { slotId: "T3", subject: "geography", roomId: "R21" },
    ]);
    expect(studentMainRoomId(student)).toBe("R20");
  });

  it("语数外分散时取座位时段最多的那间", () => {
    const student = schedule("S3", "同学丙", "2503", [
      { slotId: "T1", subject: "chinese", roomId: "R20" },
      { slotId: "T2", subject: "math", roomId: "R21" },
      { slotId: "T3", subject: "english", roomId: "R20" },
    ]);
    expect(studentMainRoomId(student)).toBe("R20");
  });
});

/* ------------------------------------------------------------------ */
/* 应到情况 + 不考科目（纯函数）                                        */
/* ------------------------------------------------------------------ */

describe("seatingAttendance：实际考的科目", () => {
  it("主考场里缺一科：只列他实际考的", () => {
    const student = schedule(
      "S4",
      "同学丁",
      "2504",
      corePlus("R18", { slotId: "T7", subject: "politics", roomId: "R19" }),
    );
    expect(seatingAttendance(student, makeSeating(SIX_SUBJECTS, { S4: 1 }))).toEqual({
      subjects: ["chinese", "math", "english", "physics", "chemistry"],
      isMainRoom: true,
    });
  });

  it("外来借考：只看得到生物", () => {
    const student = schedule(
      "S5",
      "同学戊",
      "2505",
      corePlus("R21", { slotId: "T6", subject: "biology", roomId: "R18" }),
    );
    expect(seatingAttendance(student, makeSeating(SIX_SUBJECTS, { S5: 1 }))).toEqual({
      subjects: ["biology"],
      isMainRoom: false,
    });
  });

  it("拿不到该生时刻表 → undefined（数据不全不猜）", () => {
    expect(seatingAttendance(undefined, makeSeating(SIX_SUBJECTS, {}))).toBeUndefined();
  });
});

describe("absentSubjectsInSeating：主考场才算「不考」", () => {
  it("主考场缺生物 → 返回生物", () => {
    const student = schedule(
      "S6",
      "同学己",
      "2506",
      corePlus("R18", { slotId: "T7", subject: "politics", roomId: "R19" }),
    );
    expect(absentSubjectsInSeating(student, makeSeating(SIX_SUBJECTS, { S6: 1 }))).toEqual([
      "biology",
    ]);
  });

  it("外来学生（本考场不是主考场）→ 空数组（走「只考」分支）", () => {
    const student = schedule(
      "S7",
      "同学庚",
      "2507",
      corePlus("R21", { slotId: "T6", subject: "biology", roomId: "R18" }),
    );
    expect(absentSubjectsInSeating(student, makeSeating(SIX_SUBJECTS, { S7: 1 }))).toEqual([]);
  });

  it("没时刻表 → 空数组", () => {
    expect(absentSubjectsInSeating(undefined, makeSeating(SIX_SUBJECTS, {}))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 备注文案（v3：只有科目）                                             */
/* ------------------------------------------------------------------ */

/** V3 硬要求：备注里不许出现时段 / 「借考」/ 括号。 */
function expectShortRemark(remark: string): void {
  expect(remark).not.toContain("时段");
  expect(remark).not.toContain("借考");
  expect(remark).not.toContain("（");
  expect(remark).not.toContain("(");
}

describe("seatingRemark：文案与防噪音", () => {
  it("主考场全考 → 空字符串", () => {
    const student = schedule("S8", "同学辛", "2508", sixAt("R18"));
    expect(seatingRemark(student, makeSeating(SIX_SUBJECTS, { S8: 1 }))).toBe("");
  });

  it("主考场缺生物 → 不考：生物", () => {
    const student = schedule(
      "S9",
      "同学壬",
      "2509",
      corePlus("R18", { slotId: "T7", subject: "politics", roomId: "R19" }),
    );
    const remark = seatingRemark(student, makeSeating(SIX_SUBJECTS, { S9: 1 }));
    expect(remark).toBe("不考：生物");
    expectShortRemark(remark);
  });

  it("主考场缺 3 科 → 固定顺序，且语数外不会被误判", () => {
    // 该生（选科只有 3 门）在这间只考语数外：缺的是物化生，不是语数外
    const student = schedule("S10", "同学癸", "2510", [
      { slotId: "T1", subject: "chinese", roomId: "R18" },
      { slotId: "T2", subject: "math", roomId: "R18" },
      { slotId: "T3", subject: "english", roomId: "R18" },
    ]);
    const remark = seatingRemark(student, makeSeating(SIX_SUBJECTS, { S10: 1 }));
    expect(remark).toBe("不考：物理、化学、生物");
    expect(remark).not.toContain("语文");
    expect(remark).not.toContain("数学");
    expect(remark).not.toContain("外语");
  });

  it("外来单科借考 → 只考：生物（无时段 / 无「借考」/无括号）", () => {
    const student = schedule(
      "S11",
      "外来的",
      "2511",
      corePlus("R21", { slotId: "T6", subject: "biology", roomId: "R18" }),
    );
    const seating = makeSeating(
      SIX_SUBJECTS,
      { S11: 1 },
      {
        borrowedSubjects: { S11: ["biology"] },
      },
    );
    const remark = seatingRemark(student, seating);
    expect(remark).toBe("只考：生物");
    expectShortRemark(remark);
  });

  it("外来多科 → 只考：生物、地理（顺序稳定）", () => {
    const student = schedule("S12", "外来的", "2512", [
      ...corePlus("R21"),
      // 故意先给地理、再给生物，断言按固定顺序输出
      { slotId: "T7", subject: "geography", roomId: "R18" },
      { slotId: "T6", subject: "biology", roomId: "R18" },
    ]);
    const seating = makeSeating([...SIX_SUBJECTS, "geography"], { S12: 1 });
    const remark = seatingRemark(student, seating);
    expect(remark).toBe("只考：生物、地理");
    expectShortRemark(remark);
  });

  it("外来但正好考满全场 → 不写（防噪音，第十九考场（政治）那种）", () => {
    const student = schedule(
      "S13",
      "外来的",
      "2513",
      corePlus("R21", { slotId: "T7", subject: "politics", roomId: "R19" }),
    );
    const seating = makeSeating(
      ["politics"],
      { S13: 1 },
      {
        roomId: "R19",
        roomName: "第十九考场",
      },
    );
    expect(seatingRemark(student, seating)).toBe("");
  });

  it("没时刻表 → 空字符串", () => {
    expect(seatingRemark(undefined, makeSeating(SIX_SUBJECTS, {}))).toBe("");
  });
});

/* ------------------------------------------------------------------ */
/* 监考表：真实形态（合成）                                              */
/* ------------------------------------------------------------------ */

/** 11 物化生（全考）+ 13 物化政 + 9 物化地（不考生物）+ 1 借考（只考生物）。 */
function r18Plan(): { plan: PlanAllResult; seating: SeatingPlan } {
  const byStudent: StudentSchedule[] = [];
  const seatNoById: Record<string, number> = {};
  let seatNo = 0;
  const enroll = (student: StudentSchedule): void => {
    seatNo += 1;
    seatNoById[student.studentId] = seatNo;
    byStudent.push(student);
  };

  for (let index = 0; index < 11; index += 1) {
    enroll(schedule(`A${String(index).padStart(2, "0")}`, `理科生${index}`, "2501", sixAt("R18")));
  }
  for (let index = 0; index < 13; index += 1) {
    enroll(
      schedule(
        `B${String(index).padStart(2, "0")}`,
        `政治生${index}`,
        "2502",
        corePlus("R18", { slotId: "T7", subject: "politics", roomId: "R19" }),
      ),
    );
  }
  for (let index = 0; index < 9; index += 1) {
    enroll(
      schedule(
        `C${String(index).padStart(2, "0")}`,
        `地理生${index}`,
        "2503",
        corePlus("R18", { slotId: "T6", subject: "geography", roomId: "R19" }),
      ),
    );
  }
  const borrowedId = "BRW";
  enroll(
    schedule(
      borrowedId,
      "借考生",
      "2504",
      corePlus("R21", { slotId: "T6", subject: "biology", roomId: "R18" }),
    ),
  );

  const seating = makeSeating(SIX_SUBJECTS, seatNoById, {
    borrowedSubjects: { [borrowedId]: ["biology"] },
  });
  return { plan: makePlan([seating], byStudent), seating };
}

describe("监考表备注：R18（语数外物化生）真实形态", () => {
  const { plan, seating } = r18Plan();
  const [sheet] = buildInvigilatorSheets(plan, []);
  const body = sheetValues(sheet!).slice(3);

  it("34 行里恰好 22 行「不考：生物」、11 行空、1 行「只考：生物」", () => {
    expect(body).toHaveLength(34);
    expect(body.filter((row) => row[4] === "不考：生物")).toHaveLength(22);
    expect(body.filter((row) => row[4] === "")).toHaveLength(11);
    expect(body.filter((row) => row[4] === "只考：生物")).toHaveLength(1);
    // 借考生那行不许再出现时段 / 「借考」/ 括号
    const borrowed = body.filter((row) => String(row[4]).startsWith("只考"));
    expect(borrowed).toHaveLength(1);
    expectShortRemark(String(borrowed[0]![4]));
  });

  it("只考的是最后一行（座位号 34），只考的 11 行全考行是前 11 个座位", () => {
    expect(body[33]![4]).toBe("只考：生物");
    expect(Number(body[33]![0])).toBe(34);
    expect(body.filter((row) => row[4] === "").map((row) => Number(row[0]))).toEqual(
      Array.from({ length: 11 }, (_, index) => index + 1),
    );
  });

  it("判定可单独断言：物化政 = 主考场缺生物；借考 = 外来只考生物", () => {
    const politicsStudent = plan.byStudent.find((student) => student.studentId === "B00")!;
    expect(studentMainRoomId(politicsStudent)).toBe("R18");
    expect(absentSubjectsInSeating(politicsStudent, seating)).toEqual(["biology"]);
    const borrowedStudent = plan.byStudent.find((student) => student.studentId === "BRW")!;
    expect(studentMainRoomId(borrowedStudent)).toBe("R21");
    expect(absentSubjectsInSeating(borrowedStudent, seating)).toEqual([]);
    expect(seatingRemark(borrowedStudent, seating)).toBe("只考：生物");
  });
});

describe("监考表备注：防噪音与回归", () => {
  it("政治单科房间里的 13 个物化政学生 → 全部不写", () => {
    const byStudent: StudentSchedule[] = [];
    const seatNoById: Record<string, number> = {};
    for (let index = 0; index < 13; index += 1) {
      const studentId = `P${index}`;
      seatNoById[studentId] = index + 1;
      byStudent.push(
        schedule(
          studentId,
          `政治生${index}`,
          "2502",
          corePlus("R18", { slotId: "T7", subject: "politics", roomId: "R19" }),
        ),
      );
    }
    const seating = makeSeating(["politics"], seatNoById, {
      roomId: "R19",
      roomName: "第十九考场",
    });
    const [sheet] = buildInvigilatorSheets(makePlan([seating], byStudent), []);
    const body = sheetValues(sheet!).slice(3);
    expect(body).toHaveLength(13);
    expect(body.every((row) => row[4] === "")).toBe(true);
  });

  it("全是物化生的普通房间 → 所有备注为空", () => {
    const byStudent: StudentSchedule[] = [];
    const seatNoById: Record<string, number> = {};
    for (let index = 0; index < 5; index += 1) {
      const studentId = `A${index}`;
      seatNoById[studentId] = index + 1;
      byStudent.push(schedule(studentId, `理科生${index}`, "2501", sixAt("R1")));
    }
    const seating = makeSeating(SIX_SUBJECTS, seatNoById, { roomId: "R1", roomName: "第一考场" });
    const [sheet] = buildInvigilatorSheets(makePlan([seating], byStudent), []);
    expect(
      sheetValues(sheet!)
        .slice(3)
        .every((row) => row[4] === ""),
    ).toBe(true);
  });

  it("备注列宽自适应，整表仍 ≤ 27.8cm", () => {
    const { plan } = r18Plan();
    const [sheet] = buildInvigilatorSheets(plan, []);
    const widths = sheet!.colWidths!;
    expect(widths.reduce((sum, width) => sum + width, 0) * 0.185).toBeLessThanOrEqual(27.8 + 1e-9);
    expect(widths.at(-1)!).toBeGreaterThan(6); // 备注列不再是空列的宽度
  });
});

/* ------------------------------------------------------------------ */
/* 反例：主考场 = 语数外所在考场，而不是座位时段最多的那间               */
/* ------------------------------------------------------------------ */

/**
 * 语文 T1 + 数学 T2 在 R1（2 个座位时段）、英语 T3 + 物理 T4 + 化学 T5 + 生物 T6 在 R2（4 个）。
 *
 * "时段最多的那间" 会选 R2；正确实现（语数外所在考场）必须选 R1。 现有 fixture 里没有这种「非主考场时段数 > 语数外所在考场」的形态。
 */
const SPLIT_CORE: Assignment[] = [
  { slotId: "T1", subject: "chinese", roomId: "R1" },
  { slotId: "T2", subject: "math", roomId: "R1" },
  { slotId: "T3", subject: "english", roomId: "R2" },
  { slotId: "T4", subject: "physics", roomId: "R2" },
  { slotId: "T5", subject: "chemistry", roomId: "R2" },
  { slotId: "T6", subject: "biology", roomId: "R2" },
];

const ROOM_SPECS: RoomSpec[] = [
  { id: "R1", name: "第一考场", rows: 6, cols: 5, location: "高二一班" },
  { id: "R2", name: "第二考场", rows: 6, cols: 5, location: "高二二班" },
];

const splitStudent = (): StudentSchedule => schedule("MIX", "同学甲", "2501", SPLIT_CORE);

const seatingOf = (roomId: string, studentId: string, subjects: string[]): SeatingPlan =>
  makeSeating(
    subjects,
    { [studentId]: 1 },
    {
      roomId,
      roomName: roomId === "R1" ? "第一考场" : "第二考场",
    },
  );

describe("主考场必须取「语数外所在考场」，不是座位时段最多的那间", () => {
  it("① 反例形态：语数外拆开时取 R1（2 个时段），不是更忙的 R2（4 个时段）", () => {
    const student = splitStudent();
    // 先证明这个 fixture 确实是「R2 时段更多」的反例形态
    const slotsIn = (roomId: string): number =>
      Object.values(student.slots).filter((assignment) => assignment?.roomId === roomId).length;
    expect(slotsIn("R1")).toBe(2);
    expect(slotsIn("R2")).toBe(4);
    expect(slotsIn("R2")).toBeGreaterThan(slotsIn("R1"));

    expect(studentMainRoomId(student)).toBe("R1");
    expect(studentMainRoomId(student)).not.toBe("R2");
    // 语数外里 2 门在 R1、1 门在 R2 → 主考场是 R1
    expect(seatingAttendance(student, seatingOf("R1", "MIX", SIX_SUBJECTS))!.isMainRoom).toBe(true);
    expect(seatingAttendance(student, seatingOf("R2", "MIX", SIX_SUBJECTS))!.isMainRoom).toBe(
      false,
    );
  });

  it("② 两张监考表的备注都跟着这个判定走：R1 里「不考」、R2 里「只考」", () => {
    const student = splitStudent();
    const r1 = seatingOf("R1", "MIX", SIX_SUBJECTS);
    const r2 = seatingOf("R2", "MIX", SIX_SUBJECTS);

    // 直接断言纯函数。注意 core 的科目全名是「外语」（不是「英语」），备注一律走 subjectLabel
    expect(seatingRemark(student, r1)).toBe("不考：外语、物理、化学、生物");
    expect(seatingRemark(student, r2)).toBe("只考：外语、物理、化学、生物");

    // 再断言两张监考表的可见输出（表 1 = R1、表 2 = R2）
    const plan = makePlan([r1, r2], [student]);
    const [mainSheet, singleSheet] = buildInvigilatorSheets(plan, ROOM_SPECS);
    expect(mainSheet!.name).toBe("第一考场（语数外物化生）");
    expect(singleSheet!.name).toBe("第二考场（语数外物化生）");
    expect(sheetValues(mainSheet!)[3]![4]).toBe("不考：外语、物理、化学、生物");
    expect(sheetValues(singleSheet!)[3]![4]).toBe("只考：外语、物理、化学、生物");
  });

  it("③ 班级表的主考场列同样取 R1，另一间进「单科考场1」", () => {
    const plan = makePlan(
      [seatingOf("R1", "MIX", SIX_SUBJECTS), seatingOf("R2", "MIX", SIX_SUBJECTS)],
      [splitStudent()],
    );
    const { rows, headers } = buildClassScheduleRows(plan, ROOM_SPECS);
    const values = rowValues(rows[0]!);
    expect(String(values[headers.indexOf("主考场")])).toBe("第一考场");
    expect(String(values[headers.indexOf("单科考场1")])).toBe("第二考场（外语、物理、化学、生物）");
  });
});

describe("回归对照：语数外都在同一间（普通形态）", () => {
  it("主考场就是语数外那间；主考场里缺物化生、外来单科房间考满整间不写", () => {
    const student = schedule("NORMAL", "同学乙", "2501", [
      { slotId: "T1", subject: "chinese", roomId: "R1" },
      { slotId: "T2", subject: "math", roomId: "R1" },
      { slotId: "T3", subject: "english", roomId: "R1" },
      { slotId: "T4", subject: "physics", roomId: "R2" },
      { slotId: "T5", subject: "chemistry", roomId: "R2" },
      { slotId: "T6", subject: "biology", roomId: "R2" },
    ]);
    expect(studentMainRoomId(student)).toBe("R1");

    const main = seatingOf("R1", "NORMAL", SIX_SUBJECTS);
    const single = seatingOf("R2", "NORMAL", ["physics", "chemistry", "biology"]);
    expect(seatingRemark(student, main)).toBe("不考：物理、化学、生物");
    expect(seatingRemark(student, single)).toBe("");

    const plan = makePlan([main, single], [student]);
    const [mainSheet, singleSheet] = buildInvigilatorSheets(plan, ROOM_SPECS);
    expect(sheetValues(mainSheet!)[3]![4]).toBe("不考：物理、化学、生物");
    expect(sheetValues(singleSheet!)[3]![4]).toBe("");

    const { rows, headers } = buildClassScheduleRows(plan, ROOM_SPECS);
    const values = rowValues(rows[0]!);
    expect(String(values[headers.indexOf("主考场")])).toBe("第一考场");
    expect(String(values[headers.indexOf("单科考场1")])).toBe("第二考场（物理、化学、生物）");
  });
});
