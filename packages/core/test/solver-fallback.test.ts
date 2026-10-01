import { describe, expect, it } from "vitest";

import { blocksListExport, evaluateDelivery, plan, precheckJob } from "../src/index";
import type { Job, RoomSpec } from "../src/index";

/**
 * 对抗性验证报告的主复现（`/tmp/adversarial-consolidated.mjs`，task-61）。
 *
 * 三个受限学生的域互相重叠（`rows: ["first"]` ∩ `cols`），贪心按域大小升序安排后，第三个人
 * **域内已无空位**：修复前兜底会把他塞进「任意空位」（例如加座），自然产出违反限定的名单。
 */
function trapJob(extraFrontSeats?: number[]): Job {
  const students: Job["students"] = [];
  for (const cls of ["A", "B", "C"]) {
    for (let i = 0; i < 12; i += 1) {
      students.push({
        id: `${cls}-${String(i).padStart(3, "0")}`,
        name: `${cls}生${i}`,
        className: `${cls}班`,
      });
    }
  }
  const room: RoomSpec = {
    id: "R1",
    name: "第一考场",
    rows: 7,
    cols: 5,
    ...(extraFrontSeats ? { extraFrontSeats } : {}),
  };
  return {
    jobVersion: 2,
    options: { seed: 20260930 },
    students,
    rooms: [room],
    constraints: [
      { id: "C1", studentIds: ["A-000", "B-000", "C-000"], roomId: "R1", rows: ["first"] },
      { id: "C2", studentIds: ["A-000", "C-000"], roomId: "R1", cols: [1, 2] },
      { id: "C3", studentIds: ["B-000"], roomId: "R1", cols: [2, 3] },
      { id: "C4", studentIds: ["C-001"], roomId: "R1", rows: ["first"], cols: [5] },
    ],
  };
}

describe("求解兜底不得静默越域（task-61 / 违反限定的名单不可交付）", () => {
  it("① 主复现（加座考场）：不再出现 CONSTRAINT_UNMET / ADJACENCY_CONFLICT，且 blocked 不可导出", () => {
    const job = trapJob([5]);
    const pre = precheckJob(job);
    expect(pre.fatal).toBe(false); // 预检仍然放行（它只保证"存在完美匹配"）

    const result = plan(job);
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);

    // 关键：求解器不再把学生塞到域外
    expect(codes).not.toContain("CONSTRAINT_UNMET");
    expect(codes).not.toContain("ADJACENCY_CONFLICT");
    // 少数学生域内没空位 → 明确走「没座位」路径（独立校验也会报）
    expect(result.ok).toBe(false);
    expect(result.delivery).toBe("blocked");
    expect(blocksListExport(result.diagnostics)).toBe(true);
    expect(evaluateDelivery(job, result)).toBe("blocked");
  });

  it("② 无加座对照组：同样不许越域（说明这不是加座专属问题）", () => {
    const job = trapJob();
    const result = plan(job);
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);

    expect(codes).not.toContain("CONSTRAINT_UNMET");
    expect(codes).not.toContain("ADJACENCY_CONFLICT");
    expect(result.delivery).toBe("blocked");
    expect(blocksListExport(result.diagnostics)).toBe(true);
  });

  it("③ 兜底新语义：域内没空位的学生保持「未安排」，别的学生照样有座", () => {
    const job = trapJob([5]);
    const result = plan(job);

    // 29 号（无限制学生）仍应安排上；被卡住的那个学生不在名单里
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.length).toBeLessThan(36);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "SEARCH_FAILED")).toBe(true);
    // 独立校验给出的结构性证据（导出门禁据此拦下）
    const missing = result.diagnostics.filter(
      (diagnostic) => diagnostic.code === "ENTRY_MISSING_STUDENT",
    );
    expect(missing.length).toBeGreaterThan(0);
  });

  it("④ 不能过度收紧：`minConflicts` 下的合法降级仍可交付", () => {
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
    expect(blocksListExport(result.diagnostics)).toBe(false);
    expect(result.entries).toHaveLength(30); // 所有人都排上，违规如实标注
  });

  it("⑤ 不误伤：正常可排的 job 不该出现任何 error，也不该有未安排学生", () => {
    const job: Job = {
      jobVersion: 2,
      students: Array.from({ length: 8 }, (_, index) => ({
        id: `S${index}`,
        name: `n${index}`,
        className: `C${index % 2}`,
      })),
      rooms: [{ id: "R1", name: "第一考场", rows: 6, cols: 5 }],
      constraints: [{ id: "C1", studentIds: ["S0"], rows: ["first"] }],
    };
    const result = plan(job);

    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(8);
    expect(result.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(false);
  });

  it("⑥ 语义对照：同一条装不下的限定 —— 严格模式「不排也不越域」，显式 relax 才「尽量排」", () => {
    // 3 个学生被要求坐同一个座位：域内只装得下 1 个
    const students: Job["students"] = Array.from({ length: 6 }, (_, index) => ({
      id: `S${index}`,
      name: `n${index}`,
      className: `C${index % 2}`,
    }));
    const job = (relax: "none" | "minConflicts"): Job => ({
      jobVersion: 2,
      options: { relax },
      students,
      rooms: [{ id: "R1", name: "第一考场", rows: 6, cols: 5 }],
      constraints: [{ id: "C1", studentIds: ["S0", "S1", "S2"], rows: ["first"], cols: ["door"] }],
    });

    // 严格：宁可不排也不越域 → 独立校验报缺人 → 不可交付
    const strictResult = plan(job("none"));
    expect(strictResult.entries.length).toBeLessThan(6);
    expect(strictResult.diagnostics.map((d) => d.code)).not.toContain("CONSTRAINT_UNMET");
    expect(strictResult.delivery).toBe("blocked");

    // 显式 relax：用户要的是「违反最少并交付」→ 所有人都排上、违规如实标注
    const relaxed = plan(job("minConflicts"));
    expect(relaxed.entries).toHaveLength(6);
    expect(relaxed.diagnostics.map((d) => d.code)).toContain("CONSTRAINT_UNMET");
    // 注意：这条 fixture 是「3 个人被要求坐同一个座位」，预检本身就会报结构性 error
    // （`CONSTRAINT_OVERSATURATED` / `SEAT_CONFLICT`，在不可降级清单里），所以即便 relax 也不可交付 ——
    // 这是 task-51 的既有语义。真正「合法降级仍可交付」的回归见上一条（minConflicts + 9/9/9/3）。
    expect(relaxed.entries.length).toBeGreaterThan(strictResult.entries.length);
    expect(blocksListExport(relaxed.diagnostics)).toBe(true);
  });
});
