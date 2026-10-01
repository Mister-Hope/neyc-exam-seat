import { describe, expect, it } from "vitest";

import {
  blocksListExport,
  evaluateDelivery,
  evaluateDeliveryAll,
  maxSameClass,
  plan,
  planAll,
  precheckJob,
  validate,
  validateAll,
} from "../src/index";
import type { Job, PlanResult, RoomSpec } from "../src/index";

/** 名单里全是没有选科的普通学生（走单场求解） */
function plainJob(rooms: RoomSpec[], count = 8): Job {
  return {
    jobVersion: 2,
    students: Array.from({ length: count }, (_, index) => ({
      id: `S${String(index).padStart(2, "0")}`,
      name: `学生${index}`,
      className: `合成班${(index % 2) + 1}`,
    })),
    rooms,
  };
}

/** 两个常规组合各 6 人的多场次 job（两个 30 座考场，排得下、无警告） */
function multiSessionJob(): Job {
  const students: Job["students"] = [];
  const combos: [string, string[]][] = [
    ["物化生", ["physics", "chemistry", "biology"]],
    ["政史地", ["politics", "history", "geography"]],
  ];
  combos.forEach(([combination, subjects], cls) => {
    for (let i = 0; i < 6; i += 1) {
      students.push({
        id: `${combination}-${i}`,
        name: `n${cls}${i}`,
        className: `C${cls}`,
        combination,
        subjects: [...subjects],
      });
    }
  });
  return {
    jobVersion: 2,
    students,
    rooms: [
      { id: "R1", name: "第一考场", rows: 6, cols: 5 },
      { id: "R2", name: "第二考场", rows: 6, cols: 5 },
    ],
  };
}

/** Task-43 的最小复现：两个**同 id** 考场、加座列不同 → 座位编号规则互相矛盾 */
function sameIdRoomJob(): Job {
  return plainJob([
    { id: "R1", name: "第一考场", rows: 7, cols: 5, extraFrontSeats: [1] },
    { id: "R1", name: "第一考场", rows: 7, cols: 5, extraFrontSeats: [2] },
  ]);
}

describe("交付状态 delivery（task-51 / R-1：结构错误不得可交付）", () => {
  it("① 最小复现：同 id 考场 + 加座不一致 → blocked，且顶层是**原始码**而不是 SEARCH_FAILED", () => {
    const job = sameIdRoomJob();
    const result = plan(job);

    expect(result.delivery).toBe("blocked");
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("ENTRY_NUMBERING_MISMATCH");
    expect(codes).not.toContain("SEARCH_FAILED");
    // 导出闸门（结果版 & 诊断数组版）都必须拦
    expect(blocksListExport(result)).toBe(true);
    expect(blocksListExport(result.diagnostics)).toBe(true);
    expect(evaluateDelivery(job, result)).toBe("blocked");
  });

  it("① 正常 job：delivery 是 ready / ready-with-warnings（不是 blocked）", () => {
    const job = plainJob([
      { id: "R1", name: "第一考场", rows: 6, cols: 5 },
      { id: "R2", name: "第二考场", rows: 6, cols: 5 },
    ]);
    const result = plan(job);

    expect(result.ok).toBe(true);
    expect(result.delivery).toBe("ready-with-warnings"); // 空置考场会有 info/ warning
    expect(blocksListExport(result)).toBe(false);
    expect(evaluateDelivery(job, result)).toBe(result.delivery);
  });

  it("② 降级可交付：放宽模式下的软化 → ready-with-warnings，闸门仍放行", () => {
    // 国王图色数为 4，9/9/9/3 无可避免地会留下相邻同班：`--relax` 的「违反最少并交付」
    const students: Job["students"] = [];
    [9, 9, 9, 3].forEach((count, cls) => {
      for (let i = 0; i < count; i += 1) {
        students.push({ id: `C${cls}-${i}`, name: `n${cls}`, className: `C${cls}` });
      }
    });
    const job: Job = {
      jobVersion: 2,
      options: { forceKing: true, relax: "minConflicts" },
      students,
      rooms: [{ id: "R1", name: "第一考场", rows: 6, cols: 5 }],
    };
    const result = plan(job);

    expect(result.ok).toBe(false);
    expect(result.delivery).toBe("ready-with-warnings");
    expect(blocksListExport(result)).toBe(false);
    // 顶层留下的是「可降级」的 error（求解没排满 / 相邻同班），不是结构性错误
    expect(result.diagnostics.some((d) => d.code === "SEARCH_FAILED")).toBe(true);
    expect(
      result.diagnostics.some((d) => d.severity === "error" && d.code === "ADJACENCY_CONFLICT"),
    ).toBe(true);
  });

  it("③ 篡改类错误：重复占座 / 未知学生 / 漏排 → evaluateDelivery 全部 blocked", () => {
    const job = plainJob(
      [
        { id: "R1", name: "第一考场", rows: 6, cols: 5 },
        { id: "R2", name: "第二考场", rows: 6, cols: 5 },
      ],
      8,
    );
    const result = plan(job);
    const clone = (): PlanResult => JSON.parse(JSON.stringify(result)) as PlanResult;

    const duplicated = clone();
    duplicated.entries[1] = {
      ...duplicated.entries[1]!,
      roomId: duplicated.entries[0]!.roomId,
      seatNo: duplicated.entries[0]!.seatNo,
      row: duplicated.entries[0]!.row,
      col: duplicated.entries[0]!.col,
    };
    expect(validate(job, duplicated).issues.some((i) => i.code === "ENTRY_DUPLICATE_SEAT")).toBe(
      true,
    );
    expect(evaluateDelivery(job, duplicated)).toBe("blocked");

    const unknown = clone();
    unknown.entries[0] = { ...unknown.entries[0]!, studentId: "查无此人", name: "查无此人" };
    expect(validate(job, unknown).issues.some((i) => i.code === "ENTRY_UNKNOWN_STUDENT")).toBe(
      true,
    );
    expect(evaluateDelivery(job, unknown)).toBe("blocked");

    const missing = clone();
    missing.entries = missing.entries.slice(1);
    expect(validate(job, missing).issues.some((i) => i.code === "ENTRY_MISSING_STUDENT")).toBe(
      true,
    );
    expect(evaluateDelivery(job, missing)).toBe("blocked");
  });

  it("④ 多场次：validateAll 抓到结构性错误 → 整体 blocked（哪怕逐套房座位自己没发现）", () => {
    // 名单没有选科时 planAll 会退化成「一套座位」；同 id 考场的矛盾由 validateAll 独立复算抓出来
    const job = sameIdRoomJob();
    const result = planAll(job);

    expect(result.seatings.length).toBeGreaterThan(0);
    expect(result.delivery).toBe("blocked");
    expect(evaluateDeliveryAll(job, result)).toBe("blocked");
    expect(
      validateAll(job, result).issues.some((issue) => issue.code === "ENTRY_NUMBERING_MISMATCH"),
    ).toBe(true);
  });

  it("④ 多场次：任一套座位的 delivery 是 blocked → 整体 blocked", () => {
    const job = multiSessionJob();
    const result = planAll(job);
    expect(result.delivery).toBe("ready");

    const tampered = JSON.parse(JSON.stringify(result)) as typeof result;
    if (tampered.seatings[0]) tampered.seatings[0].result.delivery = "blocked";
    expect(evaluateDeliveryAll(job, tampered)).toBe("blocked");
  });

  it("④ 多场次正常：delivery 与逐套房座位一致（不会误判 blocked）", () => {
    const job = multiSessionJob();
    const result = planAll(job);

    expect(result.ok).toBe(true);
    expect(result.delivery).toBe("ready");
    expect(result.seatings.every((seating) => seating.result.delivery !== "blocked")).toBe(true);
    expect(blocksListExport(result.diagnostics)).toBe(false);
    expect(evaluateDeliveryAll(job, result)).toBe("ready");
  });
});

describe("大考场几何：不再抛异常、闭式解与旧 DP 逐值一致（task-39 修复）", () => {
  const sizes: [number, number, number, number][] = [
    // rows, cols, 8 邻域期望, 4 邻域期望
    [10, 10, 25, 50],
    [20, 20, 100, 200],
    [23, 23, 144, 265],
    [24, 24, 144, 288],
    [30, 40, 300, 600],
    [31, 40, 320, 620],
    [40, 40, 400, 800],
    [100, 100, 2500, 5000],
  ];

  it("⑤ 闭式解：8 邻域 ⌈rows/2⌉·⌈cols/2⌉、4 邻域 ⌈rows·cols/2⌉，且 30×40 起不再抛 RangeError", () => {
    for (const [rows, cols, king, orthogonal] of sizes) {
      const room: RoomSpec = { id: "R", rows, cols };
      expect(maxSameClass(room, "king")).toBe(king);
      expect(maxSameClass(room, "orthogonal")).toBe(orthogonal);
    }
  });

  it("⑤ 带加座仍走 DP（结果与设计文档一致），超宽时退回闭式解而不抛异常", () => {
    // 37 座（7×5 + 第 2、4 列加座）：4 邻域 20（docs/design.md §4.5 的 19 是错的）、8 邻域 12
    expect(maxSameClass({ id: "R", rows: 7, cols: 5, extraFrontSeats: [2, 4] }, "orthogonal")).toBe(
      20,
    );
    expect(maxSameClass({ id: "R", rows: 7, cols: 5, extraFrontSeats: [2, 4] }, "king")).toBe(12);
    expect(maxSameClass({ id: "R", rows: 5, cols: 7, extraFrontSeats: [2, 4] }, "king")).toBe(12);
    // width = 31：以前抛 RangeError；现在退回闭式解（加座只会让值更大，取矩形下界是安全的）
    const wide: RoomSpec = { id: "R", rows: 30, cols: 40, extraFrontSeats: [1, 2] };
    expect(maxSameClass(wide, "king")).toBe(300);
    expect(maxSameClass({ id: "R", rows: 40, cols: 40, extraFrontSeats: [1] }, "king")).toBe(400);
  });

  it("⑤ 非法尺寸只报 INVALID_ROOM_SIZE（在 compileModel 之前），不抛异常", () => {
    const job = plainJob([{ id: "R1", name: "第一考场", rows: 0, cols: 5 }], 4);
    const pre = precheckJob(job);
    expect(pre.diagnostics.some((d) => d.code === "INVALID_ROOM_SIZE")).toBe(true);
    expect(pre.fatal).toBe(true);
    expect(() => plan(job)).not.toThrow();
    expect(plan(job).delivery).toBe("blocked");
  });

  it("⑤ 30×40 的大礼堂（≥9 个班保持 8 邻域）不再把合法名单判死", () => {
    const students: Job["students"] = [];
    for (let cls = 0; cls < 10; cls += 1) {
      for (let i = 0; i < 20; i += 1) {
        students.push({
          id: `C${String(cls).padStart(2, "0")}-${String(i).padStart(3, "0")}`,
          name: `n${cls}`,
          className: `合成班${String(cls).padStart(2, "0")}`,
        });
      }
    }
    const job: Job = {
      jobVersion: 2,
      students,
      rooms: [{ id: "R1", name: "大礼堂", rows: 30, cols: 40 }],
    };
    const pre = precheckJob(job);

    expect(pre.diagnostics.some((d) => d.code === "CLASS_LIMIT_EXCEEDED")).toBe(false);
    expect(pre.model.rooms[0]!.maxSameClass).toBe(300);
    expect(() => planAll(job)).not.toThrow();
  });
});
