import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Job, PlanAllResult, RoomSpec } from "@exam-seat/core";

import { EXIT_INFEASIBLE, EXIT_OK, main } from "../src/cli";
import type { PlanAllValidationView } from "../src/render";
import { renderPlanAllValidation } from "../src/render";

// 测试夹具：显式 6 排 × 5 列 = 30 座，与 CLI `small` 预设（5 列 × 7 排 = 35 座）无关
const ROOM_6X5: Omit<RoomSpec, "id" | "name"> = { rows: 6, cols: 5 };

function room(n: number): RoomSpec {
  return { id: `R${n}`, name: `第${n}考场`, ...ROOM_6X5 };
}

/** 4 种组合、36 人：严格路径下 5 套座位（3 普通 + 政治/地理专用各 1）。 */
function multiJob(): Job {
  const perCombo: Record<string, number> = { 物化生: 12, 政史地: 12, 物化政: 6, 物化地: 6 };
  const students: Job["students"] = [];
  let cursor = 0;
  for (const [combination, count] of Object.entries(perCombo)) {
    for (let i = 0; i < count; i += 1) {
      cursor += 1;
      students.push({
        id: `${combination}-${String(i).padStart(2, "0")}`,
        name: `${combination}${i}`,
        className: `高三(${(cursor % 12) + 1}班)`,
        combination,
      });
    }
  }
  return {
    jobVersion: 2,
    students,
    rooms: [
      room(1),
      room(2),
      room(3),
      { ...room(20), dedicatedSubjects: ["politics"] },
      { ...room(21), dedicatedSubjects: ["geography"] },
    ],
  };
}

/** 全部考生缺考：planAll 产出 seatings 为空 + NO_STUDENTS(error)。 */
function zeroJob(): Job {
  return {
    jobVersion: 2,
    students: Array.from({ length: 6 }, (_, i) => ({
      id: `X${i + 1}`,
      name: `缺考${i + 1}`,
      className: "高三(1)班",
      combination: "物化生",
      subjects: ["physics", "chemistry", "biology"],
      included: false,
    })),
    rooms: [room(1), room(2), room(3)],
  };
}

/** 跑一次 CLI，拿 code / stdout / stderr；每次用完立刻还原 spy，避免调用累积。 */
async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const code = await main(["node", "exam-seat", ...args]);
    return {
      code,
      stdout: outSpy.mock.calls.map((call) => String(call[0])).join(""),
      stderr: errSpy.mock.calls.map((call) => String(call[0])).join(""),
    };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "exam-seat-validate-multi-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 生成一份多场次 plan.json，返回 job/plan 路径与解析后的结果。 */
async function makeMultiPlan(dir: string): Promise<{
  jobPath: string;
  planPath: string;
  plan: PlanAllResult;
}> {
  const jobPath = nodePath.join(dir, "job.json");
  const outDir = nodePath.join(dir, "out");
  writeFileSync(jobPath, JSON.stringify(multiJob()));
  const run = await runCli(["--json", "plan", "--job", jobPath, "--out-dir", outDir]);
  expect(run.code).toBe(EXIT_OK);
  const planPath = nodePath.join(outDir, "plan.json");
  return { jobPath, planPath, plan: JSON.parse(readFileSync(planPath, "utf8")) as PlanAllResult };
}

/* ------------------------------------------------------------------ */
/* 纯渲染：人话摘要（不依赖 core 的 validateAll，可先行验证）            */
/* ------------------------------------------------------------------ */

const OK_VIEW: PlanAllValidationView = {
  ok: true,
  seatings: [
    {
      roomId: "R1",
      roomName: "第一考场",
      subjects: ["chinese", "math", "english", "physics", "chemistry", "biology"],
      seats: 12,
      ok: true,
      report: { ok: true, issues: [] },
    },
    {
      roomId: "R20",
      roomName: "第二十考场",
      subjects: ["politics"],
      seats: 6,
      ok: true,
      report: { ok: true, issues: [] },
    },
  ],
  hardRuleClashes: [],
  issues: [],
};

describe("多场次校验摘要", () => {
  it("全部通过时逐套列出结论并给通过总结论", () => {
    const text = renderPlanAllValidation(OK_VIEW);
    expect(text).toContain("多场次校验通过");
    expect(text).toContain("第一考场（语数外物化生）：12 人");
    expect(text).toContain("第二十考场（政治）：6 人");
    expect(text).toContain("总结论：通过");
    expect(text).not.toContain("❌");
  });

  it("不通过时列出座位级问题与汇总问题", () => {
    const bad: PlanAllValidationView = {
      ok: false,
      seatings: [
        {
          ...OK_VIEW.seatings[0]!,
          ok: false,
          report: {
            ok: false,
            issues: [
              {
                code: "ENTRY_DUPLICATE_SEAT",
                severity: "error",
                message: "第一考场座位 3 坐了两名考生",
              },
            ],
          },
        },
      ],
      hardRuleClashes: [
        {
          roomId: "R1",
          roomName: "第一考场",
          slotId: "T4",
          slotName: "T4 物理/历史",
          subjects: ["physics", "history"],
          studentIds: ["a", "b"],
        },
      ],
      issues: [
        {
          code: "ENTRY_NUMBERING_MISMATCH",
          severity: "error",
          message: "第一考场 张三 的座位号与座位方案不一致",
        },
      ],
    };
    const text = renderPlanAllValidation(bad);
    expect(text).toContain("多场次校验未通过");
    expect(text).toContain("ENTRY_DUPLICATE_SEAT");
    expect(text).toContain("第一考场座位 3 坐了两名考生");
    expect(text).toContain("硬规则冲突 1 处");
    expect(text).toContain("汇总问题");
    expect(text).toContain("ENTRY_NUMBERING_MISMATCH");
    expect(text).toContain("总结论：不通过");
  });

  it("没有任何座位方案时明确说明，而不是泛泛的「结果不能用」", () => {
    const text = renderPlanAllValidation({
      ok: false,
      seatings: [],
      hardRuleClashes: [],
      issues: [{ code: "NO_STUDENTS", severity: "error", message: "没有需要安排的考生" }],
    });
    expect(text).toContain("没有生成任何座位方案");
    expect(text).toContain("NO_STUDENTS");
    expect(text).toContain("总结论：不通过");
  });
});

/* ------------------------------------------------------------------ */
/* CLI e2e：validate 多场次 plan.json                                  */
/* ------------------------------------------------------------------ */

describe("validate 多场次 plan.json", () => {
  it("多场次结果校验通过 → exit 0，逐套座位都打印", async () => {
    await withTempDir(async (dir) => {
      const made = await makeMultiPlan(dir);
      const run = await runCli(["validate", "--job", made.jobPath, "--plan", made.planPath]);
      expect(run.code).toBe(EXIT_OK);
      const text = `${run.stdout}${run.stderr}`;
      expect(text).toContain("多场次校验通过");
      expect(text).toContain("第1考场（语数外物化生）：12 人");
      expect(text).toContain("第2考场（语数外政史地）：12 人");
      expect(text).toContain("第20考场（政治）：6 人");
      expect(text).toContain("第21考场（地理）：6 人");
      expect(text).not.toContain("内部错误");
    });
  });

  it("--json 输出可解析且字段齐全（ok / seatings / issues / hardRuleClashes）", async () => {
    await withTempDir(async (dir) => {
      const made = await makeMultiPlan(dir);
      const run = await runCli([
        "--json",
        "validate",
        "--job",
        made.jobPath,
        "--plan",
        made.planPath,
      ]);
      expect(run.code).toBe(EXIT_OK);
      const validation = JSON.parse(run.stdout) as PlanAllValidationView;
      expect(validation.ok).toBe(true);
      expect(validation.seatings).toHaveLength(made.plan.seatings.length);
      expect(validation.issues).toEqual([]);
      expect(validation.hardRuleClashes).toEqual([]);
      for (const seating of validation.seatings) {
        expect(seating.report.ok).toBe(true);
        expect(seating.roomName).toBeTypeOf("string");
        expect(seating.seats).toBeTypeOf("number");
      }
    });
  });

  it("人为改坏座位号 → exit 3，且原因可读", async () => {
    await withTempDir(async (dir) => {
      const made = await makeMultiPlan(dir);
      const corrupted = JSON.parse(JSON.stringify(made.plan)) as PlanAllResult;
      const student = corrupted.byStudent.find((s) =>
        Object.values(s.slots).some((assignment) => assignment != null),
      )!;
      for (const assignment of Object.values(student.slots)) {
        if (assignment != null) assignment.seatNo = 999;
      }
      writeFileSync(made.planPath, JSON.stringify(corrupted, null, 2));

      const run = await runCli(["validate", "--job", made.jobPath, "--plan", made.planPath]);
      expect(run.code).toBe(EXIT_INFEASIBLE);
      const text = `${run.stdout}${run.stderr}`;
      expect(text).toContain("不通过");
      expect(text).not.toContain("内部错误");

      const jsonRun = await runCli([
        "--json",
        "validate",
        "--job",
        made.jobPath,
        "--plan",
        made.planPath,
      ]);
      expect(jsonRun.code).toBe(EXIT_INFEASIBLE);
      const validation = JSON.parse(jsonRun.stdout) as PlanAllValidationView;
      expect(validation.ok).toBe(false);
      expect(validation.issues.length).toBeGreaterThan(0);
      expect(validation.issues.some((issue) => issue.severity === "error")).toBe(true);
    });
  });

  it("人为造「同址两人」→ exit 3", async () => {
    await withTempDir(async (dir) => {
      const made = await makeMultiPlan(dir);
      const corrupted = JSON.parse(JSON.stringify(made.plan)) as PlanAllResult;
      const seating = corrupted.seatings.find((item) => item.result.entries.length >= 2)!;
      const [first, second] = seating.result.entries;
      second!.seatNo = first!.seatNo;
      writeFileSync(made.planPath, JSON.stringify(corrupted, null, 2));

      const jsonRun = await runCli([
        "--json",
        "validate",
        "--job",
        made.jobPath,
        "--plan",
        made.planPath,
      ]);
      expect(jsonRun.code).toBe(EXIT_INFEASIBLE);
      const validation = JSON.parse(jsonRun.stdout) as PlanAllValidationView;
      expect(validation.ok).toBe(false);
      expect(validation.issues.length).toBeGreaterThan(0);

      const textRun = await runCli(["validate", "--job", made.jobPath, "--plan", made.planPath]);
      expect(textRun.code).toBe(EXIT_INFEASIBLE);
      expect(`${textRun.stdout}${textRun.stderr}`).not.toContain("内部错误");
    });
  });

  it("空结果 plan.json（seatings 为空）→ validate 也不通过（exit 3，NO_STUDENTS）", async () => {
    await withTempDir(async (dir) => {
      const jobPath = nodePath.join(dir, "zero.json");
      const outDir = nodePath.join(dir, "zero-out");
      writeFileSync(jobPath, JSON.stringify(zeroJob()));

      const planRun = await runCli(["--json", "plan", "--job", jobPath, "--out-dir", outDir]);
      expect(planRun.code).toBe(EXIT_INFEASIBLE);
      const planPath = nodePath.join(outDir, "plan.json");

      const jsonRun = await runCli(["--json", "validate", "--job", jobPath, "--plan", planPath]);
      expect(jsonRun.code).toBe(EXIT_INFEASIBLE);
      const validation = JSON.parse(jsonRun.stdout) as PlanAllValidationView;
      expect(validation.ok).toBe(false);
      expect(validation.seatings).toHaveLength(0);
      expect(
        validation.issues.some(
          (issue) => issue.code === "NO_STUDENTS" && issue.severity === "error",
        ),
      ).toBe(true);

      const textRun = await runCli(["validate", "--job", jobPath, "--plan", planPath]);
      expect(textRun.code).toBe(EXIT_INFEASIBLE);
      const text = `${textRun.stdout}${textRun.stderr}`;
      expect(text).toContain("没有生成任何座位方案");
      expect(text).toContain("总结论：不通过");
      expect(text).not.toContain("内部错误");
    });
  });

  it("单场 plan.json 的 validate 行为不变（回归）", async () => {
    await withTempDir(async (dir) => {
      const jobPath = nodePath.join(dir, "single-job.json");
      const outDir = nodePath.join(dir, "single-out");
      writeFileSync(
        jobPath,
        JSON.stringify({
          jobVersion: 2,
          students: Array.from({ length: 9 }, (_, i) => ({
            id: `S${String(i).padStart(2, "0")}`,
            name: `学生${i}`,
            className: `高三(${i + 1}班)`,
          })),
          rooms: Array.from({ length: 12 }, (_, i) => room(i + 1)),
        }),
      );
      const planRun = await runCli(["--json", "plan", "--job", jobPath, "--out-dir", outDir]);
      expect(planRun.code).toBe(EXIT_OK);

      const run = await runCli([
        "--json",
        "validate",
        "--job",
        jobPath,
        "--plan",
        nodePath.join(outDir, "plan.json"),
      ]);
      expect(run.code).toBe(EXIT_OK);
      const report = JSON.parse(run.stdout) as { ok: boolean; issues: unknown[] };
      expect(report.ok).toBe(true);
      expect(Array.isArray(report.issues)).toBe(true);
    });
  });
});
