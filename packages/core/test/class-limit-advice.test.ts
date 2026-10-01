import { describe, expect, it } from "vitest";

import { blocksListExport, plan, precheckJob } from "../src/index";
import type { Diagnostic, Job, JsonPatchOp, RoomSpec } from "../src/index";

/** 报告场景：1 班 60 人 + 8 班各 5 人 + 4 个 6×5 考场（同班名额上限 4 × 9 = 36） */
function reportJob(): Job {
  const students: Job["students"] = [];
  for (let i = 0; i < 60; i += 1) {
    students.push({ id: `A${i}`, name: `甲${i}`, className: "01班" });
  }
  for (let k = 1; k <= 8; k += 1) {
    for (let i = 0; i < 5; i += 1) {
      students.push({ id: `B${k}-${i}`, name: `乙${k}${i}`, className: `0${k + 1}班` });
    }
  }
  return {
    jobVersion: 2,
    students,
    rooms: [1, 2, 3, 4].map((n) => ({ id: `R${n}`, name: `第${n}考场`, rows: 6, cols: 5 })),
  };
}

const classLimitDiagnostics = (job: Job): Diagnostic[] =>
  precheckJob(job).diagnostics.filter((diagnostic) => diagnostic.code === "CLASS_LIMIT_EXCEEDED");

/** 只实现用得到的 op：往房间列表尾部加考场 */
function applyAddRooms(job: Job, patch: readonly JsonPatchOp[]): Job {
  const rooms = [...(job.rooms ?? [])];
  for (const op of patch) {
    if (op.op === "add" && op.path === "/rooms/-") rooms.push(op.value as RoomSpec);
  }
  return { ...job, rooms };
}

function excludedIndices(patch: readonly JsonPatchOp[]): number[] {
  return patch
    .filter((op) => op.op === "replace" && /^\/students\/\d+\/included$/.test(op.path))
    .map((op) => Number(op.path.split("/")[2]));
}

describe("`CLASS_LIMIT_EXCEEDED` 的一键建议（task-66）", () => {
  it("① 首条 `add-rooms` 建议**应用后真的够**：预检不再报 CLASS_LIMIT_EXCEEDED", () => {
    const job = reportJob();
    const diagnostics = classLimitDiagnostics(job);
    expect(diagnostics).toHaveLength(1);

    const first = diagnostics[0]!.suggestions[0]!;
    expect(first.id).toBe("add-rooms-for-class");
    // 文案要如实写明差多少、加完能容纳多少（不能只说「加 1 个考场」）
    expect(first.label).toContain("再加 3 个考场");
    expect(first.label).toContain("36 → 63");
    expect(first.label).toContain("60 人");
    expect(first.effect).toContain("差 24 人");

    const patched = applyAddRooms(job, first.patch ?? []);
    expect(patched.rooms).toHaveLength(7);
    expect(classLimitDiagnostics(patched)).toHaveLength(0);
  });

  it("② 对照组：只加 1 间（旧的座位缺口口径）仍然报错 —— 证明「够」不是静默通过", () => {
    const job = reportJob();
    const oneMore = applyAddRooms(job, [
      {
        op: "add",
        path: "/rooms/-",
        value: { id: "R5", name: "第5考场", rows: 6, cols: 5 },
      },
    ]);

    expect(classLimitDiagnostics(oneMore)).toHaveLength(1);
  });

  it("③ `exclude-students` 只能从触发诊断的那个班取人（不是名单末尾的小班）", () => {
    const job = reportJob();
    const diagnostic = classLimitDiagnostics(job)[0]!;
    const exclude = diagnostic.suggestions.find(
      (suggestion) => suggestion.id === "exclude-class-students",
    )!;

    expect(exclude.label).toContain("01班");
    const indices = excludedIndices(exclude.patch ?? []);
    const roster = job.students ?? [];
    expect(indices).toHaveLength(24);
    for (const index of indices) {
      expect(roster[index]!.className).toBe("01班");
    }
  });

  it("④ 建议去重：多个班超限时，同一条动作（id + patch）只出现一次", () => {
    // 10 个班各 60 人、4 个 6×5 考场（每个班都超限：36 < 60）
    const students: Job["students"] = [];
    for (let k = 1; k <= 10; k += 1) {
      for (let i = 0; i < 60; i += 1) {
        students.push({ id: `S${k}-${i}`, name: `n${k}${i}`, className: `0${k}班` });
      }
    }
    const job: Job = {
      jobVersion: 2,
      students,
      rooms: [1, 2, 3, 4].map((n) => ({ id: `R${n}`, name: `第${n}考场`, rows: 6, cols: 5 })),
    };
    const diagnostics = classLimitDiagnostics(job);
    expect(diagnostics).toHaveLength(10);

    const all = diagnostics.flatMap((diagnostic) => diagnostic.suggestions ?? []);
    const keys = all.map((suggestion) =>
      JSON.stringify({ id: suggestion.id, patch: suggestion.patch }),
    );
    // 去重后不能有重复动作（修复前是 10 条相同诊断 × 2 条相同建议 = 20 条重复）
    expect(new Set(keys).size).toBe(keys.length);
    // 「加考场」是同一个动作 → 全局只留一条；「少排人」每个班针对不同学生，是不同动作
    expect(all.filter((suggestion) => suggestion.id === "add-rooms-for-class")).toHaveLength(1);
    expect(all.length).toBeLessThanOrEqual(11);
  });

  it("⑤ 不新增硬阻断、不改严重级：`CLASS_LIMIT_EXCEEDED` 仍是 error 且阻断导出", () => {
    const job = reportJob();
    const pre = precheckJob(job);
    const diagnostic = pre.diagnostics.find((item) => item.code === "CLASS_LIMIT_EXCEEDED")!;

    expect(diagnostic.severity).toBe("error");
    expect(pre.fatal).toBe(true);
    const result = plan(job);
    expect(result.delivery).toBe("blocked");
    expect(blocksListExport(result.diagnostics)).toBe(true);
  });
});
