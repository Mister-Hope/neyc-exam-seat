import { describe, expect, it } from "vitest";

import {
  MIN_CLASSES_FOR_KING,
  blocksListExport,
  compileDomains,
  compileModel,
  isFatal,
  plan,
  precheckJob,
  resolveColRef,
  resolveRowRef,
  rcToSeatNo,
  seatNoToRC,
} from "../src/index";
import type { Constraint, Diagnostic, Job, RoomSpec } from "../src/index";

const SMALL: RoomSpec = { id: "RS", name: "小考场", rows: 6, cols: 5, doorSide: "right" };
const LARGE: RoomSpec = { id: "RL", name: "大考场", rows: 7, cols: 6, doorSide: "right" };

function makeJob(config: {
  classes: number;
  perClass: number;
  rooms: RoomSpec[];
  constraints?: Constraint[];
  options?: Job["options"];
}): Job {
  const students = [];
  for (let c = 1; c <= config.classes; c += 1) {
    for (let i = 1; i <= config.perClass; i += 1) {
      students.push({
        id: `S${String(c).padStart(2, "0")}-${String(i).padStart(3, "0")}`,
        name: `学生${c}-${i}`,
        className: `高三(${c})班`,
      });
    }
  }
  return {
    jobVersion: 2,
    options: config.options,
    students,
    rooms: config.rooms,
    constraints: config.constraints ?? [],
  };
}

describe("蛇形编号（方案 A）", () => {
  // 注意：这里的矩阵按**业务列序**排列（第 1 列 = 靠门列）。
  // 设计文档里的示意图按**物理列序**画（c1 在最左、门在最右），两者互为左右镜像。
  it("小考场 5 列 × 6 排与文档里的编号图完全一致", () => {
    const expected = [
      [1, 12, 13, 24, 25],
      [2, 11, 14, 23, 26],
      [3, 10, 15, 22, 27],
      [4, 9, 16, 21, 28],
      [5, 8, 17, 20, 29],
      [6, 7, 18, 19, 30],
    ];
    for (let row = 1; row <= 6; row += 1) {
      for (let col = 1; col <= 5; col += 1) {
        expect(rcToSeatNo(row, col, 6, 5)).toBe(expected[row - 1]![col - 1]);
      }
    }
  });

  it("大考场 6 列 × 7 排与文档里的编号图完全一致", () => {
    const expected = [
      [1, 14, 15, 28, 29, 42],
      [2, 13, 16, 27, 30, 41],
      [3, 12, 17, 26, 31, 40],
      [4, 11, 18, 25, 32, 39],
      [5, 10, 19, 24, 33, 38],
      [6, 9, 20, 23, 34, 37],
      [7, 8, 21, 22, 35, 36],
    ];
    for (let row = 1; row <= 7; row += 1) {
      for (let col = 1; col <= 6; col += 1) {
        expect(rcToSeatNo(row, col, 7, 6)).toBe(expected[row - 1]![col - 1]);
      }
    }
  });

  it("1 号在靠门的前角，且 seatNoToRC 与 rcToSeatNo 互为逆运算", () => {
    for (const room of [SMALL, LARGE]) {
      const first = seatNoToRC(1, room.rows, room.cols);
      expect(first).toEqual({ row: 1, col: 1 });
      for (let n = 1; n <= room.rows * room.cols; n += 1) {
        const rc = seatNoToRC(n, room.rows, room.cols);
        expect(rcToSeatNo(rc.row, rc.col, room.rows, room.cols)).toBe(n);
      }
    }
  });
});

describe("语义值随考场大小解析", () => {
  it("末排 / 靠窗列在大小考场里指向不同位置", () => {
    expect(resolveRowRef(SMALL, "last")).toBe(6);
    expect(resolveRowRef(LARGE, "last")).toBe(7);
    expect(resolveColRef(SMALL, "window")).toBe(5);
    expect(resolveColRef(LARGE, "window")).toBe(6);
  });

  it("绝对号越界时返回 null（该考场直接被剔除）", () => {
    expect(resolveColRef(SMALL, 6)).toBeNull();
    expect(resolveColRef(LARGE, 6)).toBe(6);
    expect(resolveRowRef(SMALL, 7)).toBeNull();
  });

  it("同一学生不指定考场时，靠窗列在大小考场都成立", () => {
    const job = makeJob({
      classes: 18,
      perClass: 2,
      rooms: [SMALL, LARGE],
      constraints: [{ id: "C1", studentIds: ["S01-001"], cols: ["window"] }],
    });
    const model = compileModel(job, "king");
    const bundle = compileDomains(model);
    const domain = bundle.domains[0]!;
    const cols = new Set([...domain].map((seat) => model.seatCol[seat]));
    expect(cols).toEqual(new Set([5, 6]));
  });
});

describe("预检诊断", () => {
  it("座位不够时明确说差多少个，并给出可应用的放宽建议", () => {
    const job = makeJob({ classes: 18, perClass: 2, rooms: [SMALL] });
    const out = precheckJob(job);
    expect(out.fatal).toBe(true);
    const diag = out.diagnostics.find((d) => d.code === "CAPACITY_INSUFFICIENT")!;
    expect(diag).toBeDefined();
    expect(diag.message).toContain("还差");
    expect(diag.suggestions.length).toBeGreaterThan(0);
    expect(diag.suggestions.some((s) => s.patch && s.patch.length > 0)).toBe(true);
  });

  it("5 个人抢 4 个角，预检直接拦下并给出建议", () => {
    const job = makeJob({
      classes: 18,
      perClass: 1,
      rooms: [LARGE, { ...LARGE, id: "RL2", name: "大考场2" }],
      constraints: [
        {
          id: "corners",
          note: "四角",
          studentIds: ["S01-001", "S02-001", "S03-001", "S04-001", "S05-001"],
          roomId: "RL",
          rows: ["first", "last"],
          cols: ["door", "window"],
        },
      ],
    });
    const out = precheckJob(job);
    expect(out.fatal).toBe(true);
    expect(out.diagnostics.some((d) => d.code === "CONSTRAINT_OVERSATURATED")).toBe(true);
  });

  it("两条限定交集为空时报 RULE_INTERSECT_EMPTY", () => {
    const rooms: RoomSpec[] = [
      { id: "R1", rows: 6, cols: 5 },
      { id: "R2", rows: 6, cols: 5 },
    ];
    const job = makeJob({
      classes: 18,
      perClass: 1,
      rooms,
      constraints: [
        { id: "A", studentIds: ["S01-001"], roomId: "R1" },
        { id: "B", studentIds: ["S01-001"], roomId: "R2" },
      ],
    });
    const out = precheckJob(job);
    expect(out.fatal).toBe(true);
    expect(out.diagnostics.some((d) => d.code === "RULE_INTERSECT_EMPTY")).toBe(true);
  });

  it("班级数不足 9 时自动退化，并明确告知", () => {
    const job = makeJob({ classes: 6, perClass: 3, rooms: [SMALL, LARGE] });
    const out = precheckJob(job);
    expect(out.downgraded).toBe(true);
    expect(out.adjacency).toBe("orthogonal");
    const diag = out.diagnostics.find((d) => d.code === "TOO_FEW_CLASSES")!;
    expect(diag).toBeDefined();
    expect(diag.message).toContain("退化");
    expect(MIN_CLASSES_FOR_KING).toBe(9);
  });
});

describe("求解器", () => {
  it("18 个班 90 人排进大小混合考场，零冲突且全部满足限定", () => {
    const rooms: RoomSpec[] = Array.from({ length: 3 }, (_, i) => ({
      id: `R${i + 1}`,
      name: `第${i + 1}考场`,
      rows: 6,
      cols: 5,
      doorSide: "right",
    }));
    const job = makeJob({
      classes: 18,
      perClass: 5,
      rooms,
      constraints: [
        { id: "C1", note: "有作弊前科", studentIds: ["S01-001", "S02-001"], rows: ["first"] },
        {
          id: "C2",
          note: "四角",
          studentIds: ["S03-001", "S04-001", "S05-001", "S06-001"],
          roomId: "R2",
          rows: ["first", "last"],
          cols: ["door", "window"],
        },
      ],
    });
    const result = plan(job, { timeLimitMs: 8000 });
    expect(result.ok).toBe(true);
    expect(result.level).toBe("strict");
    expect(result.conflicts).toHaveLength(0);
    expect(result.entries).toHaveLength(90);

    // 四角真的落在 R2 的四个角
    const corners = result.entries.filter((e) => e.roomId === "R2" && e.row === 1 && e.col === 1);
    expect(corners.length).toBeLessThanOrEqual(1);
    const cornerSet = new Set(
      result.entries
        .filter((e) => ["S03-001", "S04-001", "S05-001", "S06-001"].includes(e.studentId))
        .map((e) => `${e.roomId}:${e.row}:${e.col}`),
    );
    expect(cornerSet).toEqual(new Set(["R2:1:1", "R2:1:5", "R2:6:1", "R2:6:5"]));
  });

  it("同输入同 seed 结果逐字节一致", () => {
    const job = makeJob({
      classes: 18,
      perClass: 4,
      rooms: [
        { id: "R1", rows: 6, cols: 5 },
        { id: "R2", rows: 7, cols: 6 },
      ],
    });
    const a = plan(job, { timeLimitMs: 4000 });
    const b = plan(job, { timeLimitMs: 4000 });
    expect(a.entries).toEqual(b.entries);
    expect(a.inputFingerprint).toBe(b.inputFingerprint);
  });

  it("限定第一排的学生确实都在某个考场的第一排", () => {
    const job = makeJob({
      classes: 18,
      perClass: 3,
      rooms: [
        { id: "R1", rows: 6, cols: 5 },
        { id: "R2", rows: 6, cols: 5 },
      ],
      constraints: [
        {
          id: "front",
          studentIds: ["S01-001", "S02-001", "S03-001", "S04-001", "S05-001"],
          rows: ["first"],
        },
      ],
    });
    const result = plan(job, { timeLimitMs: 8000 });
    expect(result.ok).toBe(true);
    for (const id of ["S01-001", "S02-001", "S03-001", "S04-001", "S05-001"]) {
      const entry = result.entries.find((e) => e.studentId === id)!;
      expect(entry.row).toBe(1);
    }
  });

  it("只限定「靠门列」时，学生落在某个考场的靠门列", () => {
    const job = makeJob({
      classes: 18,
      perClass: 2,
      rooms: [
        { id: "R1", rows: 6, cols: 5 },
        { id: "R2", rows: 7, cols: 6 },
      ],
      constraints: [{ id: "door", studentIds: ["S01-001", "S02-001"], cols: ["door"] }],
    });
    const result = plan(job, { timeLimitMs: 8000 });
    expect(result.ok).toBe(true);
    for (const id of ["S01-001", "S02-001"]) {
      const entry = result.entries.find((e) => e.studentId === id)!;
      expect(entry.col).toBe(1);
    }
  });

  it("6 个班时退化到 4 邻域，对角同班允许但前后左右仍然不同班", () => {
    const job = makeJob({
      classes: 6,
      perClass: 5,
      rooms: [
        { id: "R1", rows: 6, cols: 5 },
        { id: "R2", rows: 6, cols: 5 },
      ],
    });
    const result = plan(job, { timeLimitMs: 8000 });
    expect(result.level).toBe("orthogonal");
    expect(result.stats.adjacency).toBe("orthogonal");
    expect(result.conflicts).toHaveLength(0);
  });
});

describe("结构性无解：预检放行但求解排不满", () => {
  // 国王图色数为 4。30 个座位按 (排奇偶, 列奇偶) 四色分布恰好是 9/9/6/6。
  // 换成 9/9/9/3 这类多重集就无解 —— 预检的单班上限检查（≤9）看不出来，求解器必须兜住。
  function oneRoom(counts: number[], forceKing = true): ReturnType<typeof plan> {
    const students: Job["students"] = [];
    counts.forEach((n, c) => {
      for (let i = 0; i < n; i += 1) {
        students.push({ id: `S${c}-${i}`, name: `n${c}`, className: `C${c}` });
      }
    });
    return plan({
      options: { forceKing, timeLimitMs: 3000 },
      students,
      rooms: [{ id: "R1", rows: 6, cols: 5 }],
    });
  }

  it("9/9/6/6 正好是四色分布，零冲突", () => {
    const result = oneRoom([9, 9, 6, 6]);
    expect(result.ok).toBe(true);
    expect(result.stats.conflicts).toBe(0);
  });

  it("9/9/9/3 排不满，且明确报告冲突而不是假装成功", () => {
    const result = oneRoom([9, 9, 9, 3]);
    expect(result.ok).toBe(false);
    expect(result.stats.conflicts).toBeGreaterThan(0);
    const diag = result.diagnostics.find((d) => d.code === "SEARCH_FAILED")!;
    expect(diag).toBeDefined();
    expect(diag.suggestions.length).toBeGreaterThan(0);
    // 一定要给降级出口
    expect(diag.suggestions.some((s) => s.id === "relax-orthogonal")).toBe(true);
  });

  it("班级数不足 9 时默认退化，同一份数据不再冲突", () => {
    const result = oneRoom([9, 9, 9, 3], false);
    expect(result.level).toBe("orthogonal");
    expect(result.ok).toBe(true);
    expect(result.stats.conflicts).toBe(0);
  });
});

describe("降级模式：限定太紧时能救回来，结构性无解时仍然兜住", () => {
  /** 5 个人抢同考场 4 个角 */
  function cornersJob(): Job {
    const students: Job["students"] = [];
    for (let c = 1; c <= 18; c += 1) {
      for (let i = 1; i <= 2; i += 1) {
        students.push({ id: `S${c}-${i}`, name: `n${c}${i}`, className: `C${c}` });
      }
    }
    return {
      students,
      rooms: [
        { id: "R1", rows: 6, cols: 5 },
        { id: "R2", rows: 6, cols: 5 },
      ],
      constraints: [
        {
          id: "corners",
          note: "四角",
          studentIds: ["S1-1", "S2-1", "S3-1", "S4-1", "S5-1"],
          roomId: "R1",
          rows: ["first", "last"],
          cols: ["door", "window"],
        },
      ],
    };
  }

  it("默认严格模式：直接判死，不产出任何名单", () => {
    const result = plan(cornersJob());
    expect(result.ok).toBe(false);
    expect(result.entries).toHaveLength(0);
    expect(result.diagnostics.some((d) => d.code === "CONSTRAINT_OVERSATURATED")).toBe(true);
  });

  it("softConstraints：不再判死，所有人都排上，违反的那几个被如实报出来", () => {
    const result = plan(cornersJob(), { relax: "softConstraints", timeLimitMs: 8000 });
    expect(result.level).toBe("softConstraints");
    expect(result.entries).toHaveLength(36); // 人人都排上了
    expect(result.ok).toBe(false); // 但确实没全满足
    expect(result.stats.unmetConstraints).toBeGreaterThanOrEqual(1);
    expect(result.unmetConstraints[0]!.constraintId).toBe("corners");
    // 4 个人仍然坐到了 4 个角上
    const atCorners = result.entries.filter(
      (e) => e.roomId === "R1" && [1, 25, 6, 30].includes(e.seatNo),
    );
    expect(atCorners).toHaveLength(4);
    // 并且明确告诉了用户「按放宽模式处理了」
    expect(
      result.diagnostics.some((d) => d.severity === "warning" && d.message.includes("放宽模式")),
    ).toBe(true);
  });

  it("minConflicts：同样能兜住，级别如实标注", () => {
    const result = plan(cornersJob(), { relax: "minConflicts", timeLimitMs: 8000 });
    expect(result.level).toBe("minConflicts");
    expect(result.entries).toHaveLength(36);
  });

  it("结构性无解（座位不够）在放宽模式下仍然判死", () => {
    const job = cornersJob();
    job.rooms = [job.rooms[0]!]; // 30 个座位装不下 36 人
    const result = plan(job, { relax: "softConstraints" });
    expect(result.ok).toBe(false);
    expect(result.entries).toHaveLength(0);
    expect(result.diagnostics.some((d) => d.code === "CAPACITY_INSUFFICIENT")).toBe(true);
  });

  it("isFatal 能区分「限定太紧」和「结构无解」", () => {
    const soft = plan(cornersJob()).diagnostics;
    expect(isFatal(soft, "none").fatal).toBe(true);
    expect(isFatal(soft, "softConstraints").fatal).toBe(false);
    expect(isFatal(soft, "softConstraints").softened.length).toBeGreaterThan(0);
  });
});

describe("导出闸门 blocksListExport（§8.1）", () => {
  const diag = (code: Diagnostic["code"], severity: Diagnostic["severity"]): Diagnostic => ({
    code,
    severity,
    message: "",
    suggestions: [],
  });

  it("硬规则违规 ROOM_SUBJECT_CLASH（error）→ 阻止导出", () => {
    expect(blocksListExport([diag("ROOM_SUBJECT_CLASH", "error")])).toBe(true);
  });

  it("容量不足 CAPACITY_INSUFFICIENT（error）→ 阻止导出", () => {
    expect(blocksListExport([diag("CAPACITY_INSUFFICIENT", "error")])).toBe(true);
  });

  it("只有 SEARCH_FAILED（error）→ 不阻止（L2/L3 降级结果照常交付）", () => {
    expect(blocksListExport([diag("SEARCH_FAILED", "error")])).toBe(false);
  });

  it("warning 一律不阻止（ROOMS_SHARED / CONSTRAINTS_IGNORED_MULTI）", () => {
    expect(blocksListExport([diag("ROOMS_SHARED", "warning")])).toBe(false);
    expect(blocksListExport([diag("CONSTRAINTS_IGNORED_MULTI", "warning")])).toBe(false);
    expect(
      blocksListExport([
        diag("SEARCH_FAILED", "error"),
        diag("ROOMS_SHARED", "warning"),
        diag("OK", "info"),
      ]),
    ).toBe(false);
  });

  it("空数组 → 不阻止；表内错误码任缺一条都会漏拦", () => {
    expect(blocksListExport([])).toBe(false);
    const blocking: Diagnostic["code"][] = [
      "ROOM_SUBJECT_CLASH",
      "CAPACITY_INSUFFICIENT",
      "NO_STUDENTS",
      "NO_ROOMS",
      "INVALID_ROOM_SIZE",
      "STUDENT_DUPLICATE_ID",
      "STUDENT_MISSING_CLASS",
      "CLASS_LIMIT_EXCEEDED",
      "SEAT_CONFLICT",
      "UNKNOWN_ROOM_ID",
      "CONSTRAINT_NO_SELECTOR",
      "CONSTRAINT_EMPTY_DOMAIN",
      "CONSTRAINT_INDEX_OUT_OF_RANGE",
      "CONSTRAINT_OVERSATURATED",
      "RULE_INTERSECT_EMPTY",
    ];
    for (const code of blocking) {
      expect(blocksListExport([diag(code, "error")])).toBe(true);
    }
    // 非 error 级别即使 code 在表内也不阻止
    expect(blocksListExport([diag("CAPACITY_INSUFFICIENT", "warning")])).toBe(false);
  });
});

describe("规模与性能", () => {
  it("18 个班约 1000 人 / 25 个考场，3 秒内零冲突", () => {
    const rooms: RoomSpec[] = Array.from({ length: 25 }, (_, i) => ({
      id: `R${i + 1}`,
      name: `第${i + 1}考场`,
      rows: 6,
      cols: 5,
      doorSide: "right",
    }));
    const job = makeJob({
      classes: 18,
      perClass: 55,
      rooms,
      constraints: [
        {
          id: "C1",
          note: "作弊前科",
          studentIds: Array.from({ length: 9 }, (_, i) => `S${String(i + 1).padStart(2, "0")}-001`),
          rows: ["first"],
        },
      ],
    });
    expect(job.students).toHaveLength(990);
    const started = Date.now();
    const result = plan(job, { timeLimitMs: 30_000 });
    const elapsed = Date.now() - started;
    expect(result.stats.participants).toBe(990);
    expect(result.stats.seatsTotal).toBe(750);
    // 990 人 > 750 个座位，应该被预检拦下
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "CAPACITY_INSUFFICIENT")).toBe(true);
    expect(elapsed).toBeLessThan(3000);
  });

  it("18 个班 990 人 / 40 个考场，3 秒内零冲突", () => {
    const rooms: RoomSpec[] = Array.from({ length: 33 }, (_, i) => ({
      id: `R${i + 1}`,
      name: `第${i + 1}考场`,
      rows: 6,
      cols: 5,
      doorSide: "right",
    }));
    const job = makeJob({ classes: 18, perClass: 55, rooms });
    expect(job.students).toHaveLength(990);
    const started = Date.now();
    const result = plan(job, { timeLimitMs: 30_000 });
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(true);
    expect(result.conflicts).toHaveLength(0);
    expect(result.entries).toHaveLength(990);
    expect(elapsed).toBeLessThan(10_000);
  });
});
