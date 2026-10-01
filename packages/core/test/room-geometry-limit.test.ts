import { describe, expect, it } from "vitest";

import {
  blocksListExport,
  MAX_ROOM_SEATS,
  MAX_ROOM_SIDE,
  MAX_TOTAL_SEATS,
  plan,
  precheckJob,
  validateRoomGeometry,
} from "../src/index";
import type { Job, RoomSpec, Student } from "../src/index";

function students(count: number): Student[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `S${String(index).padStart(3, "0")}`,
    name: `学生${index}`,
    className: `班${(index % 5) + 1}`,
  }));
}

function job(rooms: RoomSpec[], count = 20): Job {
  return { jobVersion: 2, students: students(count), rooms };
}

describe("考场尺寸上限：畸形 job 不许把进程/标签页打死（task-67）", () => {
  it(
    "① OOM 回归：`rows: 999999` 在分配之前就报 INVALID_ROOM_SIZE（纯函数 + 端到端都不崩）",
    { timeout: 10_000 },
    () => {
      const huge: RoomSpec = { id: "R1", name: "第1考场", rows: 999_999, cols: 5 };

      // 纯函数：不分配任何内存，最稳的回归断言
      const diagnostics = validateRoomGeometry(job([huge]));
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.code).toBe("INVALID_ROOM_SIZE");
      expect(diagnostics[0]!.message).toContain("999999 排 × 5 列");
      expect(diagnostics[0]!.message).toContain(`单边超过上限 ${MAX_ROOM_SIDE}`);
      expect(diagnostics[0]!.message).toContain("多写了几个零");

      // 端到端：`compileModel` 里的防线保证不会 OOM（否则这条断言跑不到）
      const pre = precheckJob(job([huge]));
      expect(pre.fatal).toBe(true);
      expect(pre.diagnostics.some((d) => d.code === "INVALID_ROOM_SIZE")).toBe(true);

      const result = plan(job([huge]));
      expect(result.delivery).toBe("blocked");
      expect(blocksListExport(result)).toBe(true);
      expect(result.entries).toHaveLength(0);
    },
  );

  it("② 边界：100 × 100（正好 10000 座）允许，101 × 100 报错", () => {
    const atLimit = validateRoomGeometry(job([{ id: "R1", rows: 100, cols: 100 }]));
    expect(atLimit).toHaveLength(0);

    const over = validateRoomGeometry(job([{ id: "R1", name: "第1考场", rows: 101, cols: 100 }]));
    expect(over).toHaveLength(1);
    expect(over[0]!.message).toContain(`超过单考场上限 ${MAX_ROOM_SEATS} 座`);

    // 单边上限：列数超限但「座位数」看起来不大（1 × 1001）
    const wide = validateRoomGeometry(job([{ id: "R1", name: "第1考场", rows: 1, cols: 1001 }]));
    expect(wide).toHaveLength(1);
    expect(wide[0]!.message).toContain("单边超过上限");
  });

  it("③ 全部考场总座位数超限也拦住（避免「每间都合法、加起来爆内存」）", () => {
    const rooms: RoomSpec[] = Array.from({ length: 11 }, (_, index) => ({
      id: `R${index + 1}`,
      name: `第${index + 1}考场`,
      rows: 100,
      cols: 100,
    }));
    const diagnostics = validateRoomGeometry(job(rooms));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain(`超过全部考场上限 ${MAX_TOTAL_SEATS} 座`);
  });

  it("④ 既有非法尺寸判据不变（字符串 / 0 / 负数）", () => {
    for (const room of [
      { id: "R1", rows: "7", cols: 5 },
      { id: "R1", rows: 0, cols: 5 },
      { id: "R1", rows: 7, cols: 0 },
      { id: "R1", rows: -1, cols: 5 },
    ] as unknown as RoomSpec[]) {
      const diagnostics = validateRoomGeometry(job([room]));
      expect(diagnostics.map((d) => d.code)).toEqual(["INVALID_ROOM_SIZE"]);
      expect(diagnostics[0]!.message).toContain("行列数不合法");
    }
  });

  it("⑤ 正常尺寸不受影响：7×6 / 7×5 / 带加座 / 30×40 大礼堂", () => {
    for (const room of [
      { id: "R1", name: "第一考场", rows: 7, cols: 6 },
      { id: "R1", name: "第一考场", rows: 7, cols: 5 },
      { id: "R1", name: "第一考场", rows: 7, cols: 5, extraFrontSeats: [2, 4] },
      { id: "R1", name: "大礼堂", rows: 30, cols: 40 },
    ] as RoomSpec[]) {
      expect(
        validateRoomGeometry({ jobVersion: 2, students: students(12), rooms: [room] }),
      ).toHaveLength(0);
    }
  });
});

describe("学生必须有学号（task-67 第 2 条）", () => {
  const room: RoomSpec = { id: "R1", name: "第一考场", rows: 6, cols: 5 };

  it("① 单个学生缺 `id`（缺失 / 空串 / 全空格）都要明确报错，不再静默接受", () => {
    for (const broken of [
      { name: "甲", className: "A" },
      { id: "", name: "乙", className: "A" },
      { id: "   ", name: "丙", className: "A" },
    ] as unknown as Student[]) {
      const list: Student[] = [...students(4), broken];
      const pre = precheckJob({ jobVersion: 2, students: list, rooms: [room] });

      expect(pre.diagnostics.some((d) => d.code === "STUDENT_MISSING_ID")).toBe(true);
      expect(pre.fatal).toBe(true);
      expect(plan({ jobVersion: 2, students: list, rooms: [room] }).delivery).toBe("blocked");
    }
  });

  it("② 两个学生缺 `id` → 只报一条 STUDENT_MISSING_ID（不混进「重复学号」）", () => {
    // job.json 是外部数据：缺 id 只能从「没有类型保护」的 JSON 进来，所以这里用 unknown 断言
    const list = [
      { id: "S0", name: "甲", className: "A" },
      { name: "乙", className: "A" },
      { name: "丙", className: "A" },
    ] as unknown as Student[];
    const codes = precheckJob({ jobVersion: 2, students: list, rooms: [room] }).diagnostics.map(
      (d) => d.code,
    );

    expect(codes.filter((code) => code === "STUDENT_MISSING_ID")).toHaveLength(1);
    expect(codes).not.toContain("STUDENT_DUPLICATE_ID");
  });

  it("③ 真正重复的学号仍然报 STUDENT_DUPLICATE_ID", () => {
    const list: Student[] = [
      { id: "S0", name: "甲", className: "A" },
      { id: "S0", name: "乙", className: "A" },
    ];
    const codes = precheckJob({ jobVersion: 2, students: list, rooms: [room] }).diagnostics.map(
      (d) => d.code,
    );

    expect(codes).toContain("STUDENT_DUPLICATE_ID");
    expect(codes).not.toContain("STUDENT_MISSING_ID");
  });

  it("④ 学号齐全的正常名单不受影响", () => {
    const pre = precheckJob({ jobVersion: 2, students: students(12), rooms: [room] });
    expect(pre.diagnostics.some((d) => d.code === "STUDENT_MISSING_ID")).toBe(false);
    expect(pre.fatal).toBe(false);
  });
});
