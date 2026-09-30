import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Job, RoomSpec } from "@exam-seat/core";

import { EXIT_DEGRADED, EXIT_INFEASIBLE, EXIT_OK, EXIT_USAGE, main } from "../src/cli";

const SMALL: Omit<RoomSpec, "id" | "name"> = { rows: 6, cols: 5 };

function room(n: number): RoomSpec {
  return { id: `R${n}`, name: `第${n}考场`, ...SMALL };
}

/** 单场：9 个学生、12 个考场 → 必然有空置考场。 */
function singleJob(): Job {
  return {
    jobVersion: 2,
    students: Array.from({ length: 9 }, (_, i) => ({
      id: `S${String(i).padStart(2, "0")}`,
      name: `学生${i}`,
      className: `高三(${i + 1}班)`,
    })),
    rooms: Array.from({ length: 12 }, (_, i) => room(i + 1)),
  };
}

/** 多场次：36 个学生、3 个备用普通考场 → 必然有空置考场。 */
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
      room(4),
      { ...room(20), dedicatedSubjects: ["politics"] },
      { ...room(21), dedicatedSubjects: ["geography"] },
      room(98),
      room(99),
    ],
  };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "exam-seat-cli-plan-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 全部考生缺考：seatings 为空，但 ok 可能真空为真 —— 摘要不得谎报成功。 */
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
    rooms: [1, 2, 3].map((n) => room(n)),
  };
}

/** 考场不足：物化生 40 人自己就要 2 个考场，2 个考场装不下 → CAPACITY_INSUFFICIENT（error）。 */
function tightMultiJob(): Job {
  const students: Job["students"] = [];
  for (let i = 1; i <= 40; i += 1) {
    students.push({
      id: `T1${String(i).padStart(3, "0")}`,
      name: `理科${i}`,
      className: `高三(${(i % 6) + 1}班)`,
      combination: "物化生",
    });
  }
  for (let i = 1; i <= 20; i += 1) {
    students.push({
      id: `T2${String(i).padStart(3, "0")}`,
      name: `文科${i}`,
      className: `高三(${(i % 6) + 1}班)`,
      combination: "政史地",
    });
  }
  return { jobVersion: 2, students, rooms: [room(1), room(2)] };
}

/** 单场结构性 error：40 人只有 1 个 30 座考场 → CAPACITY_INSUFFICIENT（error，无 entries）。 */
function tightSingleJob(): Job {
  return {
    jobVersion: 2,
    students: Array.from({ length: 40 }, (_, i) => ({
      id: `S${String(i).padStart(3, "0")}`,
      name: `学生${i}`,
      className: `高三(${(i % 6) + 1}班)`,
    })),
    rooms: [room(1)],
  };
}

/**
 * 4 个班 9/9/9/3 挤满一个 6×5 考场 + 强制 8 邻域：每个班都不超上限（9）， 但国王图只有唯一的四色分法（9/6/9/6），必然排不出零冲突 → 放宽后 ok=false，
 * 诊断里只有 SEARCH_FAILED，没有结构性 error。
 */
function relaxJob(multi: boolean): Job {
  const sizes = [9, 9, 9, 3];
  const students: Job["students"] = [];
  sizes.forEach((size, cls) => {
    for (let i = 0; i < size; i += 1) {
      students.push({
        id: `L${cls}${String(i).padStart(2, "0")}`,
        name: `学生${cls}-${i}`,
        className: `高三(${cls + 1}班)`,
        ...(multi ? { combination: "物化生" } : {}),
      });
    }
  });
  return {
    jobVersion: 2,
    options: { relax: "minConflicts", forceKing: true },
    students,
    rooms: [room(1)],
  };
}

describe("plan --out-dir 导出", () => {
  const spies: { mockRestore: () => void }[] = [];

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
  });

  function captureOutput(): { stdout: () => string; stderr: () => string } {
    const outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    spies.push(outSpy, errSpy);
    return {
      stdout: () => outSpy.mock.calls.map((call) => String(call[0])).join(""),
      stderr: () => errSpy.mock.calls.map((call) => String(call[0])).join(""),
    };
  }

  it("单场：job.json 不含空置考场，并打印剔除提示", async () => {
    await withTempDir(async (dir) => {
      const jobPath = nodePath.join(dir, "job.json");
      const outDir = nodePath.join(dir, "out");
      const job = singleJob();
      writeFileSync(jobPath, JSON.stringify(job));

      const captured = captureOutput();
      const code = await main([
        "node",
        "exam-seat",
        "--json",
        "plan",
        "--job",
        jobPath,
        "--out-dir",
        outDir,
      ]);

      expect(code).toBe(EXIT_OK);
      const exportedJob = JSON.parse(
        readFileSync(nodePath.join(outDir, "job.json"), "utf8"),
      ) as Job;
      expect(exportedJob.rooms.length).toBeGreaterThan(0);
      expect(exportedJob.rooms.length).toBeLessThan(job.rooms.length);
      expect(exportedJob.students).toEqual(job.students);

      const exportedPlan = JSON.parse(readFileSync(nodePath.join(outDir, "plan.json"), "utf8")) as {
        stats: { emptyRooms: string[] };
      };
      expect(exportedPlan.stats.emptyRooms.length).toBeGreaterThan(0);

      expect(captured.stderr()).toContain("已剔除空置考场：");
      expect(captured.stderr()).toContain("（导出的 job.json 里不再包含）");
      expect(captured.stdout()).toContain('"resultVersion"'); // stdout 仍是结果 JSON
    });
  });

  it("多场次：同样写出剔除空置的 job.json 并打印剔除提示", async () => {
    await withTempDir(async (dir) => {
      const jobPath = nodePath.join(dir, "job.json");
      const outDir = nodePath.join(dir, "out");
      const job = multiJob();
      writeFileSync(jobPath, JSON.stringify(job));

      const captured = captureOutput();
      const code = await main([
        "node",
        "exam-seat",
        "--json",
        "plan",
        "--job",
        jobPath,
        "--out-dir",
        outDir,
      ]);

      expect(code).toBe(EXIT_OK);
      // 正常（ok）路径必须照常导出两份工作簿
      const files = readdirSync(outDir);
      expect(files).toContain("按班级考场安排.xlsx");
      expect(files).toContain("考场监考表.xlsx");

      const exportedJob = JSON.parse(
        readFileSync(nodePath.join(outDir, "job.json"), "utf8"),
      ) as Job;
      expect(exportedJob.rooms.length).toBeGreaterThan(0);
      expect(exportedJob.rooms.length).toBeLessThan(job.rooms.length);
      expect(exportedJob.students).toEqual(job.students);

      const exportedPlan = JSON.parse(readFileSync(nodePath.join(outDir, "plan.json"), "utf8")) as {
        emptyRooms: string[];
      };
      expect(exportedPlan.emptyRooms.length).toBeGreaterThan(0);

      expect(captured.stderr()).toContain("已剔除空置考场：");
      expect(captured.stderr()).toContain("（导出的 job.json 里不再包含）");
      expect(captured.stdout()).toContain('"seatings"'); // stdout 仍是结果 JSON
    });
  });

  it("多场次结果未通过校验时只导出 plan.json / job.json，不写工作簿", async () => {
    await withTempDir(async (dir) => {
      const jobPath = nodePath.join(dir, "job.json");
      const outDir = nodePath.join(dir, "out");
      writeFileSync(jobPath, JSON.stringify(tightMultiJob()));

      const captured = captureOutput();
      const code = await main([
        "node",
        "exam-seat",
        "--json",
        "plan",
        "--job",
        jobPath,
        "--out-dir",
        outDir,
      ]);

      expect(code).toBe(EXIT_INFEASIBLE); // 结构性 error → 3（不是「已降级」2）
      const files = readdirSync(outDir);
      expect(files).toContain("plan.json");
      expect(files).toContain("job.json");
      expect(files).not.toContain("按班级考场安排.xlsx");
      expect(files).not.toContain("考场监考表.xlsx");

      expect(captured.stderr()).toContain("结果未通过校验");
      expect(captured.stderr()).toContain("CAPACITY_INSUFFICIENT");
      expect(captured.stdout()).toContain('"seatings"'); // --json 仍把结果送达 stdout
    });
  });

  it("一套座位方案都没有时 stdout 不得出现成功话术", async () => {
    await withTempDir(async (dir) => {
      const jobPath = nodePath.join(dir, "job.json");
      const outDir = nodePath.join(dir, "out");
      writeFileSync(jobPath, JSON.stringify(zeroJob()));

      const captured = captureOutput();
      const code = await main(["node", "exam-seat", "plan", "--job", jobPath, "--out-dir", outDir]);

      expect(code).toBe(EXIT_INFEASIBLE);
      const stdout = captured.stdout();
      expect(stdout).toContain("没有任何考场安排");
      expect(stdout).not.toMatch(/排考完成|全部时段已安排|✅/);
      // 一套座位都没有 = NO_STUDENTS（结构性 error）→ 不导出工作簿
      const files = readdirSync(outDir);
      expect(files).toContain("plan.json");
      expect(files).toContain("job.json");
      expect(files).not.toContain("按班级考场安排.xlsx");
      expect(files).not.toContain("考场监考表.xlsx");
    });
  });

  it("单场结构性 error 时也不写名单工作簿", async () => {
    await withTempDir(async (dir) => {
      const jobPath = nodePath.join(dir, "job.json");
      const outDir = nodePath.join(dir, "out");
      writeFileSync(jobPath, JSON.stringify(tightSingleJob()));

      const captured = captureOutput();
      const code = await main([
        "node",
        "exam-seat",
        "--json",
        "plan",
        "--job",
        jobPath,
        "--out-dir",
        outDir,
      ]);

      expect(code).toBe(EXIT_INFEASIBLE);
      const files = readdirSync(outDir);
      expect(files).toContain("plan.json");
      expect(files).toContain("job.json");
      expect(files).not.toContain("考场安排名单.xlsx");
      expect(files).not.toContain("考场座位表.xlsx");
      expect(captured.stderr()).toContain("结果未通过校验");
      expect(captured.stderr()).toContain("CAPACITY_INSUFFICIENT");
    });
  });

  it("单场放宽模式 ok=false 但无结构性 error 时，名单工作簿照常导出", async () => {
    await withTempDir(async (dir) => {
      const jobPath = nodePath.join(dir, "job.json");
      const outDir = nodePath.join(dir, "out");
      writeFileSync(jobPath, JSON.stringify(relaxJob(false)));

      const captured = captureOutput();
      const code = await main([
        "node",
        "exam-seat",
        "--json",
        "plan",
        "--job",
        jobPath,
        "--out-dir",
        outDir,
      ]);

      expect(code).toBe(EXIT_DEGRADED); // ok=false（放宽后仍有冲突），但不是结构性 error
      const files = readdirSync(outDir);
      expect(files).toContain("考场安排名单.xlsx");
      expect(captured.stderr()).not.toContain("结果未通过校验");
      const exportedPlan = JSON.parse(readFileSync(nodePath.join(outDir, "plan.json"), "utf8")) as {
        ok: boolean;
        level: string;
        diagnostics: { code: string }[];
      };
      expect(exportedPlan.ok).toBe(false);
      expect(exportedPlan.diagnostics.some((d) => d.code === "SEARCH_FAILED")).toBe(true);
      expect(exportedPlan.diagnostics.some((d) => d.code === "ROOM_SUBJECT_CLASH")).toBe(false);
    });
  });

  it("多场次放宽模式 ok=false 但无结构性 error 时，两份工作簿照常导出", async () => {
    await withTempDir(async (dir) => {
      const jobPath = nodePath.join(dir, "job.json");
      const outDir = nodePath.join(dir, "out");
      writeFileSync(jobPath, JSON.stringify(relaxJob(true)));

      const captured = captureOutput();
      const code = await main([
        "node",
        "exam-seat",
        "--json",
        "plan",
        "--job",
        jobPath,
        "--out-dir",
        outDir,
      ]);

      expect(code).toBe(EXIT_DEGRADED);
      const files = readdirSync(outDir);
      expect(files).toContain("按班级考场安排.xlsx");
      expect(files).toContain("考场监考表.xlsx");
      expect(captured.stderr()).not.toContain("结果未通过校验");
    });
  });

  it("validate 拿到多场次 plan.json 时给出明确提示而不是内部错误", async () => {
    await withTempDir(async (dir) => {
      const jobPath = nodePath.join(dir, "job.json");
      const outDir = nodePath.join(dir, "out");
      writeFileSync(jobPath, JSON.stringify(multiJob()));

      captureOutput();
      await main(["node", "exam-seat", "--json", "plan", "--job", jobPath, "--out-dir", outDir]);

      // vi.spyOn 在同一方法上返回同一个 mock，多次 capture 会累积调用；断言前先清掉
      for (const spy of spies) spy.mockRestore();
      spies.length = 0;

      const captured = captureOutput();
      const code = await main([
        "node",
        "exam-seat",
        "validate",
        "--job",
        jobPath,
        "--plan",
        nodePath.join(outDir, "plan.json"),
      ]);
      expect(code).toBe(EXIT_USAGE);
      expect(captured.stderr()).toContain("多场次");
      expect(captured.stderr()).not.toContain("内部错误");

      for (const spy of spies) spy.mockRestore();
      spies.length = 0;

      const jsonCaptured = captureOutput();
      const jsonCode = await main([
        "node",
        "exam-seat",
        "--json",
        "validate",
        "--job",
        jobPath,
        "--plan",
        nodePath.join(outDir, "plan.json"),
      ]);
      expect(jsonCode).toBe(EXIT_USAGE);
      expect(JSON.parse(jsonCaptured.stdout())).toMatchObject({
        ok: false,
        error: "MULTI_PLAN_NOT_SUPPORTED",
      });
    });
  });
});
