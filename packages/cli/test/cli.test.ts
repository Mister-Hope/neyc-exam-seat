import { describe, expect, it, vi } from "vitest";

import { planAll } from "@exam-seat/core";
import type { Job, PlanAllResult, PlanResult } from "@exam-seat/core";

import { EXIT_OK, main, parseRoomSpec } from "../src/cli";
import { renderNumbering, renderPlanAll } from "../src/render";

describe("考场规格解析", () => {
  it("small / large 展开成 30 人与 42 人的考场", () => {
    const rooms = parseRoomSpec("1-3:small,4:large");
    expect(rooms).toHaveLength(4);
    expect(rooms[0]).toMatchObject({ id: "R1", rows: 6, cols: 5 });
    expect(rooms[2]).toMatchObject({ id: "R3", rows: 6, cols: 5 });
    expect(rooms[3]).toMatchObject({ id: "R4", rows: 7, cols: 6 });
  });

  it("自定义 NxM 按「N 排 × M 列」解析", () => {
    const rooms = parseRoomSpec("26:6x4");
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ rows: 6, cols: 4 });
    expect(rooms[0]!.rows * rooms[0]!.cols).toBe(24);
  });

  it("中文别名和别的乘号也能认", () => {
    expect(parseRoomSpec("1:小")[0]).toMatchObject({ rows: 6, cols: 5 });
    expect(parseRoomSpec("1:大")[0]).toMatchObject({ rows: 7, cols: 6 });
    expect(parseRoomSpec("1:6×4")[0]).toMatchObject({ rows: 6, cols: 4 });
    expect(parseRoomSpec("1:6*4")[0]).toMatchObject({ rows: 6, cols: 4 });
  });

  it("默认名是「第N考场」，id 是 R N", () => {
    expect(parseRoomSpec("7:small")[0]).toMatchObject({ id: "R7", name: "第7考场" });
  });

  it("写错了会明确报错，而不是静默产出空列表", () => {
    expect(() => parseRoomSpec("abc")).toThrow(/看不懂/);
    expect(() => parseRoomSpec("1-3")).toThrow(/看不懂/);
    expect(() => parseRoomSpec("3-1:small")).toThrow(/看不懂/);
    expect(() => parseRoomSpec("1:5x")).toThrow(/看不懂/);
  });

  it("混合规格的总容量算得对", () => {
    const rooms = parseRoomSpec("1-20:small,21-25:large,26:6x4");
    const total = rooms.reduce((sum, r) => sum + r.rows * r.cols, 0);
    expect(rooms).toHaveLength(26);
    expect(total).toBe(20 * 30 + 5 * 42 + 24);
  });
});

describe("多场次终端摘要", () => {
  it("一套座位方案都没有时不得出现「排考完成」这类成功话术", () => {
    const job: Job = {
      jobVersion: 2,
      students: Array.from({ length: 6 }, (_, i) => ({
        id: `X${i + 1}`,
        name: `缺考${i + 1}`,
        className: "高三(1)班",
        combination: "物化生",
        subjects: ["physics", "chemistry", "biology"],
        included: false,
      })),
      rooms: [1, 2, 3].map((n) => ({ id: `R${n}`, name: `第${n}考场`, rows: 6, cols: 5 })),
    };
    const result = planAll(job);
    expect(result.seatings).toHaveLength(0);

    const text = renderPlanAll(result);
    expect(text).toMatch(/没有任何考场安排/);
    expect(text).not.toMatch(/排考完成|全部时段已安排|✅/);
  });

  it("有未满足限定时单列一段，写明限定 / 考场 / 人数 / 原因", () => {
    const job: Job = {
      jobVersion: 2,
      options: { relax: "minConflicts" },
      students: Array.from({ length: 12 }, (_, i) => ({
        id: `U${String(i).padStart(2, "0")}`,
        name: `学生${i}`,
        className: `高三(${i + 1}班)`,
        combination: "物化生",
      })),
      rooms: [{ id: "R1", name: "第1考场", rows: 6, cols: 5 }],
      // 3 个人都要坐「末排靠门」这同一个座位 → 必然有人坐不上
      constraints: [
        {
          id: "C5",
          note: "物化生全体末排靠门",
          studentIds: ["U00", "U01", "U02"],
          rows: ["last"],
          cols: ["door"],
        },
      ],
    };
    const result = planAll(job);
    expect(result.unmetConstraints.length).toBeGreaterThan(0);

    const text = renderPlanAll(result);
    expect(text).toContain("未满足的限定：");
    expect(text).toContain("C5 · 第1考场");
    expect(text).toMatch(/涉及 \d+ 人：/);
    expect(text).toContain("原因：");
  });

  it("没有未满足限定时不打「未满足的限定」标题", () => {
    const job: Job = {
      jobVersion: 2,
      students: Array.from({ length: 12 }, (_, i) => ({
        id: `V${String(i).padStart(2, "0")}`,
        name: `学生${i}`,
        className: `高三(${i + 1}班)`,
        combination: "物化生",
      })),
      rooms: [{ id: "R1", name: "第1考场", rows: 6, cols: 5 }],
    };
    const result = planAll(job);
    expect(result.unmetConstraints).toEqual([]);

    const text = renderPlanAll(result);
    expect(text).not.toContain("未满足的限定");
  });
});

/** 构造 PlanAllResult 夹具：一个放宽了同班相邻、且有 1 条借考的考场。 */
function relaxBorrowFixture(): PlanAllResult {
  const seatResult: PlanResult = {
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

  return {
    ok: true,
    slots: [{ id: "T6", name: "第6时段", subjects: ["biology"] }],
    seatings: [
      {
        subjects: ["biology"],
        roomId: "R18",
        roomName: "第十八考场",
        studentIds: ["B01", "B02"],
        seatNoById: { B01: 1, B02: 2 },
        studentBySeatNo: { 1: "B01", 2: "B02" },
        result: seatResult,
        relaxedSameClass: true,
        borrowedSubjects: { B02: ["biology"] },
      },
    ],
    byStudent: [
      {
        studentId: "B01",
        name: "李雷",
        className: "高三(1)班",
        combination: "物化生",
        slots: {
          T6: {
            subject: "biology",
            subjectLabel: "生物",
            roomId: "R18",
            roomName: "第十八考场",
            seatNo: 1,
          },
        },
        rooms: [{ roomId: "R18", roomName: "第十八考场", subjects: ["biology"] }],
        distinctRooms: 1,
      },
      {
        studentId: "B02",
        name: "某生",
        className: "高三(2)班",
        combination: "物化政",
        slots: {
          T6: {
            subject: "biology",
            subjectLabel: "生物",
            roomId: "R18",
            roomName: "第十八考场",
            seatNo: 2,
          },
        },
        rooms: [{ roomId: "R18", roomName: "第十八考场", subjects: ["biology"] }],
        distinctRooms: 1,
      },
    ],
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
}

describe("多场次终端摘要：放宽同班相邻 / 借考", () => {
  it("列出放宽考场，并把借考写成「姓名 时段 科目 → 考场」", () => {
    const text = renderPlanAll(relaxBorrowFixture());
    expect(text).toContain("放宽同班相邻：R18");
    expect(text).toContain("借考：1 人（某生 T6 生物 → 第十八考场）");
  });

  it("没有放宽、没有借考时不打这两行", () => {
    const plain = relaxBorrowFixture();
    plain.relaxedRooms = [];
    plain.borrowings = [];
    const text = renderPlanAll(plain);
    expect(text).not.toContain("放宽同班相邻");
    expect(text).not.toContain("借考：");
  });

  it("借考找不到对应时段时仍给出人话（退回不带时段）", () => {
    const result = relaxBorrowFixture();
    result.byStudent = [];
    const text = renderPlanAll(result);
    expect(text).toContain("借考：1 人（某生 生物 → 第十八考场）");
  });
});

describe("编号图：讲台侧加座", () => {
  it("不给加座时输出与旧版一致：没有 r0 行，也没有加座说明", () => {
    const text = renderNumbering(6, 5);
    expect(text).not.toContain("r0");
    expect(text).not.toContain("加座");
    expect(text.split("\n")[1]!.trim().split(/\s+/)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
  });

  it("5 列 × 7 排 + [2,4]：加座行是 30 / 15，第 3 列从 16 开始", () => {
    const text = renderNumbering(7, 5, "right", [2, 4]);
    const lines = text.split("\n");
    const r0 = lines.find((line) => line.trimStart().startsWith("r0"))!;
    expect(r0.trim().split(/\s+/)).toEqual(["r0", "30", "15"]);

    const r1 = lines.find((line) => line.trimStart().startsWith("r1"))!;
    expect(r1.trim().split(/\s+/)).toEqual(["r1", "31", "29", "16", "14", "1"]);

    expect(text).toContain("本考场含 2 个讲台侧加座（第 2、4 列）");
  });

  it("--extra 2,4 能把加座画进编号图", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const code = await main([
        "node",
        "exam-seat",
        "numbering",
        "--rows",
        "7",
        "--cols",
        "5",
        "--extra",
        "2,4",
      ]);
      expect(code).toBe(EXIT_OK);
      const out = spy.mock.calls.map((call) => String(call[0])).join("");
      expect(out).toContain("本考场含 2 个讲台侧加座（第 2、4 列）");
      expect(out).toContain("r0");
    } finally {
      spy.mockRestore();
    }
  });
});
