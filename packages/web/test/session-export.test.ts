import { inflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  assignmentText,
  buildBorrowingRows,
  buildClassFilesZip,
  buildInvigilatorFilesZip,
  buildScheduleTable,
  buildSeatingChecks,
  buildSeatingOverview,
  changedByClass,
  collectMultiDiagnostics,
  collectSeatingConflicts,
  collectSeatingUnmet,
  countChangedStudents,
  filterScheduleRows,
  makeRoomLayout,
  relaxedRoomLabels,
  safeExportFileName,
} from "@/lib/session-export";
import type {
  PlanAllResult,
  PlanResult,
  RoomSpec,
  SeatingPlan,
  StudentSchedule,
  TimeSlot,
} from "@exam-seat/core";
import { buildClassScheduleSheets, buildInvigilatorSheets, readWorkbook } from "@exam-seat/io";

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
      relaxedRooms: [],
      borrowings: [],
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
/* 借考 / 放宽 / 座位表 layout                                          */
/* ------------------------------------------------------------------ */

describe("借考与放宽（本轮新增）", () => {
  const s2 = schedule({
    studentId: "S2",
    name: "李娜",
    className: "高三(7)班",
    slots: {
      T1: {
        subject: "chinese",
        subjectLabel: "语文",
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
    distinctRooms: 2,
  });

  function planAll(): PlanAllResult {
    return {
      ok: true,
      slots: SLOTS,
      seatings: [
        seating({
          roomId: "R3",
          roomName: "第三考场",
          subjects: ["chinese", "math"],
          studentIds: ["S2"],
          relaxedSameClass: true,
        }),
        seating({
          roomId: "R20",
          roomName: "第二十考场",
          subjects: ["politics"],
          studentIds: ["S2"],
          borrowedSubjects: { S2: ["politics"] },
        }),
      ],
      byStudent: [s2],
      emptyRooms: [],
      overRoomLimit: [],
      relaxedRooms: ["R3"],
      borrowings: [
        {
          studentId: "S2",
          name: "李娜",
          className: "高三(7)班",
          subject: "biology",
          subjectLabel: "生物",
          roomId: "R99",
          roomName: "第九十九考场",
          seatNo: 3,
        },
        {
          studentId: "S2",
          name: "李娜",
          className: "高三(7)班",
          subject: "politics",
          subjectLabel: "",
          roomId: "R20",
          roomName: "第二十考场",
          seatNo: 12,
        },
      ],
      diagnostics: [],
      unmetConstraints: [],
    };
  }

  it("座位方案概览带出「已放宽」与借考人数", () => {
    const rows = buildSeatingOverview(planAll().seatings);
    expect(rows[0]).toMatchObject({ relaxed: true, borrowedCount: 0 });
    expect(rows[1]).toMatchObject({ relaxed: false, borrowedCount: 1 });
  });

  it("借考明细按考场顺序排序，并从时刻表补出时段名", () => {
    const rows = buildBorrowingRows(planAll());
    expect(rows).toHaveLength(2);
    // R20 在 seatings 里的顺序在前 → 排在前面（R99 不在 seatings 里，排最后）
    expect(rows.map((row) => row.roomName)).toEqual(["第二十考场", "第九十九考场"]);
    expect(rows[0]).toMatchObject({
      slotId: "T6",
      slotName: "T6 生物/政治",
      subject: "politics",
      subjectLabel: "政治",
      seatNo: 12,
    });
    // 冷门科目名兜底 + 找不到时段时给破折号
    expect(rows[1]).toMatchObject({ slotId: "", slotName: "—", subjectLabel: "生物" });
    expect(buildBorrowingRows(null)).toEqual([]);
  });

  it("放宽考场标签按 relaxedRooms 顺序并用考场名", () => {
    expect(relaxedRoomLabels(planAll())).toEqual([{ roomId: "R3", roomName: "第三考场" }]);
    expect(relaxedRoomLabels(planAll(), new Map([["R3", "备用名"]]))).toEqual([
      { roomId: "R3", roomName: "第三考场" },
    ]);
    expect(relaxedRoomLabels(null)).toEqual([]);
  });

  it("makeRoomLayout 带上加座列，缺省时不加 extraFrontSeats 字段", () => {
    const rooms: RoomSpec[] = [
      { id: "R1", name: "第一考场", rows: 7, cols: 5, extraFrontSeats: [2, 4] },
      { id: "R2", rows: 6, cols: 5 },
    ];
    const layout = makeRoomLayout(rooms);
    expect(layout("R1")).toEqual({ rows: 7, cols: 5, name: "第一考场", extraFrontSeats: [2, 4] });
    // 缺省 name 用 id；纯矩形不写 extraFrontSeats（io 侧行为与旧版一致）
    expect(layout("R2")).toEqual({ rows: 6, cols: 5, name: "R2" });
    expect(layout("R404")).toEqual({ rows: 0, cols: 0, name: "R404" });
  });
});

/* ------------------------------------------------------------------ */
/* 人数统计                                                             */
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

/* ------------------------------------------------------------------ */
/* 分班 / 分考场整包（ZIP）                                             */
/* ------------------------------------------------------------------ */

interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/**
 * 极简 ZIP 读取器：中央目录 + 压缩方式 0（stored）/ 8（deflate）。
 *
 * 只给测试用——验证 io 的 `buildZip` 产物真能被解开、条目名和内容都对。
 */
function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06_05_4b_50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是合法的 ZIP：找不到中央目录结束记录");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== 0x02_01_4b_50) throw new Error("ZIP 中央目录损坏");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    const content = method === 0 ? raw : new Uint8Array(inflateRawSync(raw));
    entries.push({ name, bytes: new Uint8Array(content) });

    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const EXPORT_ROOMS: RoomSpec[] = [
  { id: "R1", name: "第一考场", rows: 6, cols: 5, location: "高二一班", note: "张老师" },
  { id: "R20", name: "第二十考场", rows: 5, cols: 5, location: "生物实验室", note: "王老师" },
];

/** 两个班、两套座位方案（含一次借考）的多场次结果。 */
function exportPlanAll(): PlanAllResult {
  const zhang: StudentSchedule = schedule({
    studentId: "S1",
    name: "张伟",
    className: "高三(1)班",
    combination: "物化生",
    distinctRooms: 1,
    slots: {
      T1: {
        subject: "chinese",
        subjectLabel: "语文",
        roomId: "R1",
        roomName: "第一考场",
        seatNo: 1,
      },
      T2: {
        subject: "math",
        subjectLabel: "数学",
        roomId: "R1",
        roomName: "第一考场",
        seatNo: 1,
      },
      T6: {
        subject: "biology",
        subjectLabel: "生物",
        roomId: "R1",
        roomName: "第一考场",
        seatNo: 1,
      },
    },
    rooms: [{ roomId: "R1", roomName: "第一考场", subjects: ["chinese", "math", "biology"] }],
  });
  const li: StudentSchedule = schedule({
    studentId: "S2",
    name: "李娜",
    className: "高三(7)班",
    combination: "物化政",
    distinctRooms: 2,
    slots: {
      T1: {
        subject: "chinese",
        subjectLabel: "语文",
        roomId: "R1",
        roomName: "第一考场",
        seatNo: 2,
      },
      T2: {
        subject: "math",
        subjectLabel: "数学",
        roomId: "R1",
        roomName: "第一考场",
        seatNo: 2,
      },
      T6: {
        subject: "politics",
        subjectLabel: "政治",
        roomId: "R20",
        roomName: "第二十考场",
        seatNo: 3,
      },
    },
    rooms: [
      { roomId: "R1", roomName: "第一考场", subjects: ["chinese", "math"] },
      { roomId: "R20", roomName: "第二十考场", subjects: ["politics"] },
    ],
  });

  return {
    ok: true,
    slots: SLOTS,
    seatings: [
      seating({
        roomId: "R1",
        roomName: "第一考场",
        subjects: ["chinese", "math", "biology"],
        studentIds: ["S1", "S2"],
        seatNoById: { S1: 1, S2: 2 },
        studentBySeatNo: { 1: "S1", 2: "S2" },
        location: "高二一班",
        note: "张老师",
      }),
      seating({
        roomId: "R20",
        roomName: "第二十考场",
        subjects: ["politics"],
        studentIds: ["S2"],
        seatNoById: { S2: 3 },
        studentBySeatNo: { 3: "S2" },
        location: "生物实验室",
        note: "王老师",
        borrowedSubjects: { S2: ["politics"] },
      }),
    ],
    byStudent: [zhang, li],
    emptyRooms: [],
    overRoomLimit: [],
    relaxedRooms: [],
    borrowings: [],
    diagnostics: [],
    unmetConstraints: [],
  };
}

describe("safeExportFileName 纯函数", () => {
  it("路径分隔符与 Windows 禁用字符换成 -", () => {
    expect(safeExportFileName("高三(1)班/第一考场")).toBe("高三(1)班-第一考场");
    expect(safeExportFileName(String.raw`a\b:c*d?e"f<g>h|i`)).toBe("a-b-c-d-e-f-g-h-i");
  });

  it("正常名原样保留，空名退回 fallback", () => {
    expect(safeExportFileName("第一考场（语数外物化生）")).toBe("第一考场（语数外物化生）");
    expect(safeExportFileName("   ")).toBe("sheet");
    expect(safeExportFileName("", "班")).toBe("班");
  });
});

describe("分班 / 分考场整包（真实 io 往返）", () => {
  it("buildClassFilesZip：总表 + 每班一张，各自一个 xlsx，ZIP 能解开", () => {
    const result = exportPlanAll();
    const sheets = buildClassScheduleSheets(result, EXPORT_ROOMS);
    const entries = readZip(buildClassFilesZip(result, EXPORT_ROOMS));

    expect(sheets.length).toBeGreaterThan(1); // 总表 + 至少一个班
    // 文件名就是 sheet 名 + .xlsx：总表 + 每个班一个
    expect(entries.map((entry) => entry.name)).toEqual([
      "总表.xlsx",
      "高三(1)班.xlsx",
      "高三(7)班.xlsx",
    ]);
    expect(entries.map((entry) => entry.name)).toEqual(
      sheets.map((sheet) => `${safeExportFileName(sheet.name)}.xlsx`),
    );

    // 每个文件都是一个单表工作簿，且能被 SheetJS 读回来
    for (const entry of entries) {
      const back = readWorkbook(entry.bytes);
      expect(back).toHaveLength(1);
      expect(back[0]!.name.length).toBeGreaterThan(0);
    }
    // 单班文件里带着本轮新增的准考证号列（表头在第 3 行，前面是标题与汇总行）
    const classOne = readWorkbook(entries[1]!.bytes)[0]!;
    const classOneRows = [classOne.headers, ...classOne.rows];
    expect(classOneRows.some((row) => row.includes("准考证号"))).toBe(true);
    expect(classOne.rows.some((row) => row.includes("S1"))).toBe(true);
  });

  it("buildInvigilatorFilesZip：每个考场一套座位一个文件", () => {
    const result = exportPlanAll();
    const sheets = buildInvigilatorSheets(result, EXPORT_ROOMS);
    const entries = readZip(buildInvigilatorFilesZip(result, EXPORT_ROOMS));

    expect(entries.map((entry) => entry.name)).toEqual([
      "第一考场（语数生）.xlsx",
      "第二十考场（政治）.xlsx",
    ]);
    expect(entries.map((entry) => entry.name)).toEqual(
      sheets.map((sheet) => `${safeExportFileName(sheet.name)}.xlsx`),
    );

    for (const entry of entries) {
      const back = readWorkbook(entry.bytes);
      expect(back).toHaveLength(1);
      expect(back[0]!.name.length).toBeLessThanOrEqual(31);
    }
    // v3 备注规则：主考场缺科写「不考：X」，外来单科写「只考：X」，外来考满整间不写；
    // 一律不带时段、不带「借考」字样、不带括号。
    const politics = readWorkbook(entries[1]!.bytes)[0]!;
    const politicsRows = [politics.headers, ...politics.rows];
    expect(
      politicsRows.some((row) => row.join("|").includes("座位号|班级|姓名|准考证号|备注")),
    ).toBe(true);
    // 政治单科房间里的物化政学生 = 外来但考满该间全部科目 → 该行备注必须为空
    const politicsStudent = politics.rows.find((row) => row.includes("S2"));
    expect(politicsStudent).toBeDefined();
    expect(politicsStudent![4] ?? "").toBe("");
    // 整张表的备注只有两种合法形状，且不许出现时段 / 借考 / 括号
    const politicsDataRows = politics.rows.filter((row) => /^S\d+$/.test(row[3] ?? ""));
    expect(politicsDataRows.length).toBeGreaterThan(0);
    const remarks = politicsDataRows.map((row) => row[4] ?? "");
    // 只允许空，或「只考：X」/「不考：X」
    expect(
      remarks.filter((remark) => remark !== "" && !/^(?:只考|不考)：.+$/.test(remark)),
    ).toEqual([]);
    for (const remark of remarks) {
      expect(remark).not.toContain("时段");
      expect(remark).not.toContain("借考");
      expect(remark).not.toContain("（");
    }

    // 第一考场（语数生）是物化政学生的主考场：他在这里缺生物 → 「不考：生物」；物化生考生全考 → 空
    const mainRoom = readWorkbook(entries[0]!.bytes)[0]!;
    const mainByStudent = new Map(mainRoom.rows.map((row) => [row[3] ?? "", row]));
    expect(mainByStudent.get("S2")?.[4]).toBe("不考：生物");
    expect(mainByStudent.get("S1")?.[4] ?? "").toBe("");
  });

  it("工作表名里的禁用字符不会漏进 ZIP 条目名", () => {
    const result = exportPlanAll();
    const entries = readZip(buildClassFilesZip(result, EXPORT_ROOMS));
    for (const entry of entries) {
      expect(entry.name).not.toMatch(/[/\\:*?"<>|]/);
    }
  });
});
