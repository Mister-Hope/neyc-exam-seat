import { describe, expect, it } from "vitest";

import { BLOCKING_EXPORT_CODES, SOFTENABLE_CODES } from "../src/diagnostics-policy";
import { blocksListExport, evaluateDelivery, plan, precheckJob } from "../src/index";
import type { Job, PlanResult, RelaxMode } from "../src/index";

/**
 * F-1 主复现（`/tmp/verify-p1-fixes.md` §11）：12 人 / 9 班 / 37 座加座房，
 * 三条限定让**同一个学生**的行列交集为空（`RULE_INTERSECT_EMPTY` + `CONSTRAINT_OVERSATURATED`）。
 */
function f1Job(relax?: RelaxMode): Job {
  return {
    jobVersion: 2,
    ...(relax ? { options: { relax } } : {}),
    students: Array.from({ length: 12 }, (_, index) => ({
      id: `S${String(index).padStart(2, "0")}`,
      name: `学生${index}`,
      className: `合成班${String((index % 9) + 1).padStart(2, "0")}`,
    })),
    rooms: [{ id: "R1", name: "第一考场", rows: 7, cols: 5, extraFrontSeats: [1, 2] }],
    constraints: [
      { id: "C1", studentIds: ["S00"], rows: [1] },
      { id: "C2", studentIds: ["S00"], cols: [2] },
      { id: "C3", studentIds: ["S00"], rows: [1], cols: [1] },
    ],
  };
}

const clone = (result: PlanResult): PlanResult => JSON.parse(JSON.stringify(result)) as PlanResult;

describe("`--relax` 的降级交付（task-62 / F-1）", () => {
  it("① 限定过紧 + 显式 relax → ready-with-warnings 且可交付（softConstraints / minConflicts 都行）", () => {
    for (const relax of ["softConstraints", "minConflicts"] as const) {
      const job = f1Job(relax);
      const result = plan(job);

      expect(result.delivery).toBe("ready-with-warnings");
      expect(blocksListExport(result)).toBe(false);
      expect(blocksListExport(result.diagnostics)).toBe(false);
      // 软化只改严重级，不改 code
      const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
      expect(codes).toContain("RULE_INTERSECT_EMPTY");
      expect(codes).toContain("CONSTRAINT_OVERSATURATED");
      expect(result.entries).toHaveLength(12); // 所有人都排上（违反最少并交付）
    }
  });

  it("② 严格模式一个字不变：同一 job 不带 relax → 仍 blocked", () => {
    const result = plan(f1Job());
    const pre = precheckJob(f1Job());

    expect(result.delivery).toBe("blocked");
    expect(blocksListExport(result)).toBe(true);
    expect(pre.fatal).toBe(true);
    // 严格模式下这几条仍是 error（软化只发生在 relax !== "none"）
    expect(
      pre.diagnostics.some(
        (diagnostic) =>
          diagnostic.severity === "error" && diagnostic.code === "RULE_INTERSECT_EMPTY",
      ),
    ).toBe(true);
    expect(pre.softened).toHaveLength(0);
  });

  it("③ 放宽也不能交付结构错误：relax 结果被篡改 → 仍然 blocked", () => {
    const job = f1Job("minConflicts");
    const result = plan(job);
    expect(result.delivery).toBe("ready-with-warnings");

    // 3a 重复占座
    const duplicated = clone(result);
    duplicated.entries[1] = {
      ...duplicated.entries[1]!,
      roomId: duplicated.entries[0]!.roomId,
      seatNo: duplicated.entries[0]!.seatNo,
      row: duplicated.entries[0]!.row,
      col: duplicated.entries[0]!.col,
    };
    expect(evaluateDelivery(job, duplicated)).toBe("blocked");

    // 3b 名单外学生
    const unknown = clone(result);
    unknown.entries[0] = { ...unknown.entries[0]!, studentId: "查无此人", name: "查无此人" };
    expect(evaluateDelivery(job, unknown)).toBe("blocked");

    // 3c 漏排
    const missing = clone(result);
    missing.entries = missing.entries.slice(1);
    expect(evaluateDelivery(job, missing)).toBe("blocked");
  });

  it("④ 源码级断言：软化码与阻断码不再重叠（谁往两边都塞就会红）", () => {
    const overlap = [...SOFTENABLE_CODES].filter((code) =>
      BLOCKING_EXPORT_CODES.has(code as never),
    );

    expect(overlap).toEqual([]);
    // `SEARCH_FAILED` 是「违反最少并交付」的降级码，不能进阻断表
    expect(BLOCKING_EXPORT_CODES.has("SEARCH_FAILED")).toBe(false);
    // 结构性错误必须仍在阻断表里
    for (const code of [
      "CAPACITY_INSUFFICIENT",
      "NO_STUDENTS",
      "INVALID_ROOM_SIZE",
      "STUDENT_DUPLICATE_ID",
      "ROOM_SUBJECT_CLASH",
      "SLOTS_CONFLICT",
    ] as const) {
      expect(BLOCKING_EXPORT_CODES.has(code)).toBe(true);
    }
  });

  it("⑤ 软化留痕：原 code 保留 + evidence 标注 downgradedFrom", () => {
    const pre = precheckJob(f1Job("softConstraints"));
    const softened = pre.diagnostics.filter(
      (diagnostic) => diagnostic.evidence?.downgradedFrom === "error",
    );

    expect(softened.length).toBeGreaterThan(0);
    for (const diagnostic of softened) {
      expect(diagnostic.severity).toBe("warning");
      expect(SOFTENABLE_CODES.has(diagnostic.code)).toBe(true);
    }
    // 降级前的快照同样保留（供 plan 里的 SEARCH_FAILED 汇总诊断使用）
    expect(pre.softened.some((diagnostic) => diagnostic.code === "RULE_INTERSECT_EMPTY")).toBe(
      true,
    );
  });
});
