import { describe, expect, it } from "vitest";

import { plan } from "../src/index";
import type { Job, PlanResult } from "../src/index";

/** 结构性无解实例：国王图色数 4，9/9/9/3 的多重集排不满（SA 会一直跑到预算用尽） */
function hardJob(timeLimitMs: number): Job {
  const students: Job["students"] = [];
  [9, 9, 9, 3].forEach((count, cls) => {
    for (let i = 0; i < count; i += 1) {
      students.push({ id: `C${cls}-${i}`, name: `n${cls}`, className: `C${cls}` });
    }
  });
  return {
    jobVersion: 2,
    options: { forceKing: true, relax: "minConflicts", timeLimitMs },
    students,
    rooms: [{ id: "R1", name: "第一考场", rows: 6, cols: 5 }],
  };
}

/** 座位表指纹：同 seed 必须逐字节一致 */
function seatSignature(result: PlanResult): string {
  return result.entries
    .map((entry) => `${entry.studentId}@${entry.roomId}:${entry.seatNo}`)
    .sort()
    .join("|");
}

describe("求解预算按迭代次数计算：同 seed 必须可复现（task-60 / 铁律 2）", () => {
  it("① 难实例 + 小预算，同一 seed 连跑 3 次 → 座位表逐字节相同（修复前 5 次 5 个不同哈希）", () => {
    const job = hardJob(300);
    const runs = [plan(job), plan(job), plan(job)];
    const signatures = runs.map((result) => seatSignature(result));

    expect(signatures[0]).toBe(signatures[1]);
    expect(signatures[1]).toBe(signatures[2]);
    expect(signatures[0]!.length).toBeGreaterThan(0);
    // 迭代数也必须是同一个值（预算只由输入决定）
    const iterations = runs.map((result) => result.stats.iterations);
    expect(iterations[0]).toBe(iterations[1]);
    expect(iterations[1]).toBe(iterations[2]);
  });

  it("② 换预算（200 / 1000 / 3000ms）各自内部一致", () => {
    for (const timeLimitMs of [200, 1000, 3000]) {
      const a = plan(hardJob(timeLimitMs));
      const b = plan(hardJob(timeLimitMs));
      expect(seatSignature(a)).toBe(seatSignature(b));
      expect(a.stats.iterations).toBe(b.stats.iterations);
    }
  });

  it("③ `stats.iterations` 存在、是正数、且不超过预算", () => {
    const result = plan(hardJob(1000));
    const iterations = result.stats.iterations!;

    expect(Number.isInteger(iterations)).toBe(true);
    expect(iterations).toBeGreaterThan(0);
    // 预算 = min(4_000_000, max(1000, timeLimitMs × 400))
    expect(iterations).toBeLessThanOrEqual(1000 * 400);
  });

  it("④ 正常实例：预算用尽也会给出确定结果，且正常路径不会触发墙钟兜底", () => {
    const feasible: Job = {
      jobVersion: 2,
      options: { relax: "minConflicts" },
      students: Array.from({ length: 12 }, (_, index) => ({
        id: `S${index}`,
        name: `n${index}`,
        className: `C${index % 6}`,
      })),
      rooms: [
        { id: "R1", name: "第一考场", rows: 6, cols: 5 },
        { id: "R2", name: "第二考场", rows: 6, cols: 5 },
      ],
    };
    const a = plan(feasible);
    const b = plan(feasible);

    expect(seatSignature(a)).toBe(seatSignature(b));
    // 时间是「兜底」信号：正常路径恒不触发（预算按迭代算，与墙钟无关）
    expect(a.diagnostics.some((d) => d.code === "TIME_LIMIT_REACHED")).toBe(false);
    expect(b.diagnostics.some((d) => d.code === "TIME_LIMIT_REACHED")).toBe(false);
  });

  it("⑤ 迭代数与时间无关：同一实例 + 极短预算仍确定（不会因机器快慢分叉）", () => {
    const job = hardJob(1);
    const a = plan(job);
    const b = plan(job);

    // 预算下限 1000 次迭代，仍然确定性完成
    expect(a.stats.iterations).toBe(1000);
    expect(seatSignature(a)).toBe(seatSignature(b));
  });
});
