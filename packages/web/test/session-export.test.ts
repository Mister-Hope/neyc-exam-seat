import { describe, expect, it } from "vitest";

import {
  assignmentText,
  buildScheduleTable,
  buildSeatingChecks,
  buildSeatingOverview,
  changedByClass,
  collectMultiDiagnostics,
  collectSeatingConflicts,
  collectSeatingUnmet,
  countChangedStudents,
  filterScheduleRows,
  makeRoomLookup,
} from "@/lib/session-export";
import type {
  PlanAllResult,
  PlanResult,
  RoomSpec,
  SeatingPlan,
  StudentSchedule,
  TimeSlot,
} from "@exam-seat/core";

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

function slot(id: string, name: string, subjects: string[] = ["chinese"]): TimeSlot {
  return { id, name, subjects };
}

function schedule(
  partial: Partial<StudentSchedule> & Pick<StudentSchedule, "studentId">,
): StudentSchedule {
  return {
    name: partial.name ?? partial.studentId,
    className: partial.className ?? "高三(1)班",
    combination: partial.combination ?? null,
    slots: partial.slots ?? {},
    rooms: partial.rooms ?? [],
    distinctRooms: partial.distinctRooms ?? 1,
    ...partial,
  };
}

function planResult(partial: Partial<PlanResult> = {}): PlanResult {
  return {
    resultVersion: 2,
    ok: true,
    level: "strict",
    stats: {
      students: 0,
      participants: 0,
      excluded: 0,
      classes: 0,
      rooms: 0,
      roomsUsed: 0,
      emptyRooms: [],
      seatsTotal: 0,
      seatsUsed: 0,
      conflicts: 0,
      unmetConstraints: 0,
      seed: 1,
      elapsedMs: 1,
      adjacency: "king",
    },
    entries: [],
    conflicts: [],
    unmetConstraints: [],
    diagnostics: [],
    inputFingerprint: "fp",
    generatedAt: "2026-09-30T00:00:00.000Z",
    ...partial,
  };
}

function seating(partial: Partial<SeatingPlan> & Pick<SeatingPlan, "roomId">): SeatingPlan {
  return {
    subjects: partial.subjects ?? ["chinese"],
    roomName: partial.roomName ?? partial.roomId,
    studentIds: partial.studentIds ?? [],
    seatNoById: partial.seatNoById ?? {},
    studentBySeatNo: partial.studentBySeatNo ?? {},
    result: partial.result ?? planResult(),
    ...partial,
  };
}

const SLOTS = [
  slot("T1", "T1 语文"),
  slot("T2", "T2 数学"),
  slot("T6", "T6 生物/政治", ["biology", "politics"]),
];

/* ------------------------------------------------------------------ */
/* assignmentText / buildScheduleTable                                  */
/* ------------------------------------------------------------------ */

describe("assignmentText 纯函数", () => {
  it("把座位安排拼成「考场 · 座位号」", () => {
    expect(
      assignmentText({
        subject: "politics",
        subjectLabel: "政治",
        roomId: "R20",
        roomName: "第二十考场",
        seatNo: 12,
      }),
    ).toBe("第二十考场 · 12号");
  });

  it("没考试（null）写破折号", () => {
    expect(assignmentText(null)).toBe("—");
    expect(assignmentText(undefined)).toBe("—");
  });
});

describe("buildScheduleTable 纯函数", () => {
  const students: StudentSchedule[] = [
    schedule({
      studentId: "S2",
      name: "李娜",
      className: "高三(7)班",
      combination: "物化政",
      distinctRooms: 2,
      slots: {
        T1: {
          subject: "chinese",
          subjectLabel: "语文",
          roomId: "R3",
          roomName: "第三考场",
          seatNo: 5,
        },
        T2: {
          subject: "math",
          subjectLabel: "数学",
          roomId: "R3",
          roomName: "第三考场",
          seatNo: 5,
        },
        T6: {
          subject: "politics",
          subjectLabel: "政治",
          roomId: "R20",
          roomName: "第二十考场",
          seatNo: 12,
        },
      },
    }),
    schedule({ studentId: "S1", name: "张伟", className: "高三(1)班", combination: "物化生" }),
    schedule({ studentId: "S3", name: "王强", className: "高三(1)班" }),
  ];

  it("列 = 学生信息列 + 每个时段一列", () => {
    const { columns } = buildScheduleTable(students, SLOTS);
    expect(columns.map((column) => column.key)).toEqual([
      "className",
      "name",
      "studentId",
      "combination",
      "T1",
      "T2",
      "T6",
    ]);
    expect(columns[4]).toMatchObject({ title: "T1 语文", width: 170 });
  });

  it("行按班级 → 学号排序，单元格按时段填「考场 · 座位」或破折号", () => {
    const { rows } = buildScheduleTable(students, SLOTS);
    expect(rows.map((row) => row.studentId)).toEqual(["S1", "S3", "S2"]);
    expect(rows[0]!.cells).toEqual({ T1: "—", T2: "—", T6: "—" });
    expect(rows[2]!.cells).toEqual({
      T1: "第三考场 · 5号",
      T2: "第三考场 · 5号",
      T6: "第二十考场 · 12号",
    });
  });

  it("标出需要换考场的人，组合为空时显示「常规」", () => {
    const { rows } = buildScheduleTable(students, SLOTS);
    expect(rows[0]!).toMatchObject({
      changed: false,
      combinationLabel: "物化生",
      combination: "物化生",
    });
    expect(rows[1]!).toMatchObject({ changed: false, combinationLabel: "常规", combination: null });
    expect(rows[2]!).toMatchObject({ changed: true, combinationLabel: "物化政", distinctRooms: 2 });
  });
});

/* ------------------------------------------------------------------ */
/* filterScheduleRows                                                   */
/* ------------------------------------------------------------------ */

describe("filterScheduleRows 纯函数", () => {
  const table = buildScheduleTable(
    [
      schedule({
        studentId: "20240001",
        name: "张伟",
        className: "高三(1)班",
        slots: {
          T1: {
            subject: "chinese",
            subjectLabel: "语文",
            roomId: "R1",
            roomName: "第一考场",
            seatNo: 1,
          },
        },
      }),
      schedule({
        studentId: "20240002",
        name: "李娜",
        className: "高三(7)班",
        slots: {
          T1: {
            subject: "chinese",
            subjectLabel: "语文",
            roomId: "R3",
            roomName: "第三考场",
            seatNo: 9,
          },
        },
      }),
    ],
    SLOTS,
  );

  it("按姓名 / 学号 / 班级搜人", () => {
    expect(filterScheduleRows(table.rows, { text: "李娜" }).map((row) => row.studentId)).toEqual([
      "20240002",
    ]);
    expect(filterScheduleRows(table.rows, { text: "20240001" }).map((row) => row.name)).toEqual([
      "张伟",
    ]);
    expect(filterScheduleRows(table.rows, { text: "班级:高三(7)" }).map((row) => row.name)).toEqual(
      ["李娜"],
    );
  });

  it("裸词也能搜「某人坐哪」的考场与科目", () => {
    expect(filterScheduleRows(table.rows, { text: "第三考场" }).map((row) => row.name)).toEqual([
      "李娜",
    ]);
    expect(filterScheduleRows(table.rows, { text: "语文" })).toHaveLength(2);
  });

  it("多个条件是与关系，班级多选是或关系", () => {
    expect(filterScheduleRows(table.rows, { text: "张伟 李娜" })).toHaveLength(0);
    expect(
      filterScheduleRows(table.rows, { text: "高三", classNames: ["高三(7)班"] }).map(
        (row) => row.name,
      ),
    ).toEqual(["李娜"]);
  });

  it("字段限定不落到考场上（姓名:第三考场 应为空）", () => {
    expect(filterScheduleRows(table.rows, { text: "姓名:第三考场" })).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 概览 / 校验摘要                                                      */
/* ------------------------------------------------------------------ */

describe("buildSeatingOverview 纯函数", () => {
  it("考场 × 科目 × 人数，单科用全名、多科用简称", () => {
    const rows = buildSeatingOverview([
      seating({
        roomId: "R1",
        roomName: "第一考场",
        subjects: ["chinese", "math", "english", "physics", "chemistry", "biology"],
        studentIds: ["S1", "S2"],
        location: "高二一班",
        note: "张老师",
      }),
      seating({
        roomId: "R20",
        roomName: "第二十考场",
        subjects: ["politics"],
        studentIds: ["S2"],
      }),
    ]);

    expect(rows[0]).toMatchObject({
      roomName: "第一考场",
      subjectsLabel: "语数外物化生",
      studentCount: 2,
      location: "高二一班",
      note: "张老师",
    });
    expect(rows[1]).toMatchObject({
      subjectsLabel: "政治",
      studentCount: 1,
      location: "—",
      note: "—",
    });
    expect(rows[0]!.key).not.toBe(rows[1]!.key);
  });
});

describe("校验摘要聚合", () => {
  const seatings = [
    seating({
      roomId: "R1",
      roomName: "第一考场",
      subjects: ["chinese", "math"],
      result: planResult({
        ok: false,
        level: "softConstraints",
        conflicts: [
          {
            roomId: "R1",
            seatA: 1,
            seatB: 2,
            studentA: "S1",
            studentB: "S2",
            className: "高三(1)班",
          },
        ],
        unmetConstraints: [{ constraintId: "C1", studentIds: ["S1"], reason: "没满足" }],
        diagnostics: [
          { code: "SEARCH_FAILED", severity: "warning", message: "还剩冲突", suggestions: [] },
        ],
      }),
    }),
    seating({
      roomId: "R20",
      roomName: "第二十考场",
      subjects: ["politics"],
      result: planResult({
        conflicts: [
          {
            roomId: "R20",
            seatA: 3,
            seatB: 4,
            studentA: "S3",
            studentB: "S4",
            className: "高三(7)班",
          },
        ],
      }),
    }),
  ];

  it("buildSeatingChecks 逐套统计", () => {
    const rows = buildSeatingChecks(seatings);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      roomName: "第一考场",
      subjectsLabel: "语数",
      ok: false,
      level: "softConstraints",
      conflicts: 1,
      unmetConstraints: 1,
      diagnostics: 1,
    });
    expect(rows[1]).toMatchObject({ roomName: "第二十考场", ok: true, conflicts: 1 });
  });

  it("collectSeatingConflicts 汇总各套 result 并带上考场", () => {
    const rows = collectSeatingConflicts(seatings);
    expect(rows.map((row) => [row.roomName, row.seatA])).toEqual([
      ["第一考场", 1],
      ["第二十考场", 3],
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });

  it("collectSeatingUnmet 汇总未满足限定", () => {
    const rows = collectSeatingUnmet(seatings);
    expect(rows).toEqual([
      {
        key: "R1:0:C1",
        roomName: "第一考场",
        subjectsLabel: "语数",
        constraintId: "C1",
        studentCount: 1,
        reason: "没满足",
      },
    ]);
  });
});

describe("collectMultiDiagnostics 纯函数", () => {
  it("planAll 诊断在前，各套 result 诊断按 code+message 去重", () => {
    const duplicate = {
      code: "ROOMS_SHARED" as const,
      severity: "warning" as const,
      message: "共用考场",
      suggestions: [],
    };
    const extra = {
      code: "SEARCH_FAILED" as const,
      severity: "warning" as const,
      message: "还剩冲突",
      suggestions: [],
    };
    const result: PlanAllResult = {
      ok: true,
      slots: SLOTS,
      seatings: [
        seating({ roomId: "R1", result: planResult({ diagnostics: [duplicate, extra] }) }),
        seating({ roomId: "R2", result: planResult({ diagnostics: [duplicate] }) }),
      ],
      byStudent: [],
      emptyRooms: [],
      overRoomLimit: [],
      diagnostics: [duplicate],
      unmetConstraints: [],
    };
    expect(collectMultiDiagnostics(result).map((item) => item.message)).toEqual([
      "共用考场",
      "还剩冲突",
    ]);
    expect(collectMultiDiagnostics(null)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 人数统计 / roomLookup                                                */
/* ------------------------------------------------------------------ */

describe("换考场人数统计", () => {
  const students = [
    schedule({ studentId: "S1", className: "高三(1)班", distinctRooms: 1 }),
    schedule({ studentId: "S2", className: "高三(1)班", distinctRooms: 2 }),
    schedule({ studentId: "S3", className: "高三(7)班", distinctRooms: 2 }),
  ];

  it("countChangedStudents 只数用到 ≥2 个考场的人", () => {
    expect(countChangedStudents(students)).toBe(2);
  });

  it("changedByClass 按班级统计并排序", () => {
    expect(changedByClass(students)).toEqual([
      { className: "高三(1)班", count: 1 },
      { className: "高三(7)班", count: 1 },
    ]);
  });
});

describe("makeRoomLookup 纯函数", () => {
  const rooms: RoomSpec[] = [
    { id: "R1", name: "第一考场", rows: 6, cols: 7, location: "高二一班", note: "张老师" },
    { id: "R2", name: "第二考场", rows: 5, cols: 6 },
  ];

  it("按考场 id 取地点与监考", () => {
    const lookup = makeRoomLookup(rooms);
    expect(lookup("R1")).toEqual({ location: "高二一班", note: "张老师" });
    expect(lookup("R2")).toEqual({ location: undefined, note: undefined });
    expect(lookup("R404")).toBeUndefined();
  });

  it("空配置也不炸", () => {
    expect(makeRoomLookup([])("R1")).toBeUndefined();
  });
});
