import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Job, RoomSpec } from "@exam-seat/core";

import { EXIT_DEGRADED, EXIT_INFEASIBLE, EXIT_OK, EXIT_USAGE, main } from "../src/cli";

// 测试夹具：显式 6 排 × 5 列 = 30 座，与 CLI `small` 预设（5 列 × 7 排 = 35 座）无关
const ROOM_6X5: Omit<RoomSpec, "id" | "name"> = { rows: 6, cols: 5 };

function room(n: number): RoomSpec {
  return { id: `R${n}`, name: `第${n}考场`, ...ROOM_6X5 };
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

/**
 * 考场级放宽 + 借考：物化生 12 人占 R1（R1 放宽同班相邻）；政史地的某生多考一科生物， 显式时段把生物单独放 T6，生物借考到 R1（R1 在 T6
 * 本来就考生物），政治/历史/地理在主考场 R3。
 */
function relaxBorrowJob(): Job {
  const science = Array.from({ length: 12 }, (_, i) => ({
    id: `B${String(i + 1).padStart(2, "0")}`,
    name: `理科${i + 1}`,
    className: `高三(${(i % 6) + 1}班)`,
    combination: "物化生",
  }));
  return {
    jobVersion: 2,
    options: {
      slots: [
        { id: "T1", subjects: ["chinese"] },
        { id: "T2", subjects: ["math"] },
        { id: "T3", subjects: ["english"] },
        { id: "T4", subjects: ["physics"] },
        { id: "T5", subjects: ["chemistry"] },
        { id: "T6", subjects: ["biology"] },
        { id: "T7", subjects: ["politics"] },
        { id: "T8", subjects: ["geography"] },
        { id: "T9", subjects: ["history"] },
      ],
    },
    students: [
      ...science,
      {
        id: "W01",
        name: "某生",
        className: "高三(9)班",
        combination: "政史地",
        subjects: ["politics", "history", "geography", "biology"],
        subjectRoom: { biology: "R1" },
      },
      { id: "W02", name: "史地政二", className: "高三(9)班", combination: "政史地" },
      { id: "W03", name: "史地政三", className: "高三(9)班", combination: "政史地" },
    ],
    rooms: [{ ...room(1), relaxSameClass: true }, room(2), room(3)],
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

/** 3 个物化生都被要求坐「末排靠门」同一个座位 → 放宽模式下必然有人没满足。 */
function unmetConstraintJob(): Job {
  return {
    jobVersion: 2,
    options: { relax: "minConflicts" },
    students: Array.from({ length: 12 }, (_, i) => ({
      id: `U${String(i).padStart(2, "0")}`,
      name: `学生${i}`,
      className: `高三(${i + 1}班)`,
      combination: "物化生",
    })),
    rooms: [room(1)],
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

  it("多场次：每班 / 每考场各一个文件，日志只给「导出 N 个文件」+ 目录摘要", async () => {
    await withTempDir(async (dir) => {
      const jobPath = nodePath.join(dir, "job.json");
      const outDir = nodePath.join(dir, "out");
      writeFileSync(jobPath, JSON.stringify(multiJob()));

      const captured = captureOutput();
      const code = await main(["node", "exam-seat", "plan", "--job", jobPath, "--out-dir", outDir]);

      expect(code).toBe(EXIT_OK);
      const files = readdirSync(outDir);
      expect(files).toContain("按班级考场安排");
      expect(files).toContain("考场监考表");

      const classFiles = readdirSync(nodePath.join(outDir, "按班级考场安排"));
      const roomFiles = readdirSync(nodePath.join(outDir, "考场监考表"));
      expect(classFiles.length).toBeGreaterThan(0);
      expect(classFiles.every((name) => name.endsWith(".xlsx"))).toBe(true);
      expect(roomFiles.some((name) => /^第.+考场（(?:.+)）\.xlsx$/.test(name))).toBe(true);

      // 日志是摘要而不是几十行逐条路径
      const stderr = captured.stderr();
      expect(stderr).toMatch(/已导出 \d+ 个文件/);
      expect(stderr).toContain("按班级考场安排.xlsx（总表 + ");
      expect(stderr).toContain("考场监考表.xlsx（");
      expect(stderr).toContain("plan.json");
      expect(stderr).toContain("job.json");
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
      expect(files).not.toContain("按班级考场安排");
      expect(files).not.toContain("考场监考表");

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
      expect(files).not.toContain("按班级考场安排");
      expect(files).not.toContain("考场监考表");
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

  it("多场次未满足限定时，plan 摘要单列「未满足的限定」", async () => {
    await withTempDir(async (dir) => {
      const jobPath = nodePath.join(dir, "job.json");
      writeFileSync(jobPath, JSON.stringify(unmetConstraintJob()));

      const captured = captureOutput();
      const code = await main(["node", "exam-seat", "plan", "--job", jobPath]);

      // 限定过载是结构性 error（CONSTRAINT_OVERSATURATED）→ 退出码 3
      expect(code).toBe(EXIT_INFEASIBLE);
      const stdout = captured.stdout();
      expect(stdout).toContain("未满足的限定：");
      expect(stdout).toContain("C5 · 第1考场");
      expect(stdout).toMatch(/涉及 \d+ 人：/);
      expect(stdout).toContain("原因：");
    });
  });

  it("多场次没有未满足限定时，摘要里不出现该标题", async () => {
    await withTempDir(async (dir) => {
      const jobPath = nodePath.join(dir, "job.json");
      writeFileSync(jobPath, JSON.stringify(multiJob()));

      const captured = captureOutput();
      const code = await main(["node", "exam-seat", "plan", "--job", jobPath]);

      expect(code).toBe(EXIT_OK);
      expect(captured.stdout()).not.toContain("未满足的限定");
    });
  });

  it("考场级放宽 + 借考：plan.json 落盘新字段，摘要给人话，validate 仍通过", async () => {
    await withTempDir(async (dir) => {
      const jobPath = nodePath.join(dir, "job.json");
      const outDir = nodePath.join(dir, "out");
      writeFileSync(jobPath, JSON.stringify(relaxBorrowJob()));

      const captured = captureOutput();
      const code = await main(["node", "exam-seat", "plan", "--job", jobPath, "--out-dir", outDir]);

      expect(code).toBe(EXIT_OK);
      expect(captured.stdout()).toContain("放宽同班相邻：R1");
      expect(captured.stdout()).toContain("借考：1 人（某生 T6 生物 → 第1考场）");

      const plan = JSON.parse(readFileSync(nodePath.join(outDir, "plan.json"), "utf8")) as {
        relaxedRooms: string[];
        borrowings: { name: string; subject: string; subjectLabel: string; roomId: string }[];
      };
      expect(plan.relaxedRooms).toEqual(["R1"]);
      expect(plan.borrowings).toHaveLength(1);
      expect(plan.borrowings[0]).toMatchObject({
        name: "某生",
        subject: "biology",
        subjectLabel: "生物",
        roomId: "R1",
      });

      // 独立校验器（validateAll）也要认这两个新字段。
      // 注意：同一个测试里再 spyOn 一次会拿到同一个 spy，所以用「累计长度」切出 validate 的输出。
      const beforeValidate = captured.stdout().length;
      const validateCode = await main([
        "node",
        "exam-seat",
        "--json",
        "validate",
        "--job",
        nodePath.join(outDir, "job.json"),
        "--plan",
        nodePath.join(outDir, "plan.json"),
      ]);
      expect(validateCode).toBe(EXIT_OK);
      const report = JSON.parse(captured.stdout().slice(beforeValidate)) as { ok: boolean };
      expect(report.ok).toBe(true);
    });
  });

  it("两个同 id 考场：拒绝导出、一个文件都不写，并给出可操作提示", async () => {
    await withTempDir(async (dir) => {
      const jobPath = nodePath.join(dir, "job.json");
      const outDir = nodePath.join(dir, "out");
      const job: Job = {
        jobVersion: 2,
        students: Array.from({ length: 60 }, (_, i) => ({
          id: `SYN${String(i + 1).padStart(3, "0")}`,
          name: `学生${i + 1}`,
          className: `合成${(i % 6) + 1}班`,
        })),
        // 两个考场同 id、不同名：core 按数组下标当两间房（能排下 60 人），
        // 导出层按 roomId 归并 → 修好之前这里会并成一张表、60 人只剩 35 人
        rooms: [
          { id: "R1", name: "第1考场", rows: 7, cols: 5 },
          { id: "R1", name: "第2考场", rows: 7, cols: 5 },
        ],
      };
      writeFileSync(jobPath, JSON.stringify(job));

      const captured = captureOutput();
      const code = await main(["node", "exam-seat", "plan", "--job", jobPath, "--out-dir", outDir]);

      expect(code).toBe(EXIT_USAGE);
      expect(existsSync(outDir)).toBe(false); // 连目录都没建，绝不留下旧文件
      expect(captured.stderr()).toContain("考场 id 重复");
      expect(captured.stderr()).toContain("R1");
      expect(captured.stderr()).toContain("已取消导出");
    });
  });

  it("复用 --out-dir：成功 → 失败后不残留旧名单，且用户文件还在", async () => {
    await withTempDir(async (dir) => {
      const okJobPath = nodePath.join(dir, "ok.json");
      const failJobPath = nodePath.join(dir, "fail.json");
      const outDir = nodePath.join(dir, "out");
      writeFileSync(okJobPath, JSON.stringify(singleJob()));
      writeFileSync(failJobPath, JSON.stringify(tightSingleJob()));

      const first = captureOutput();
      await expect(
        main(["node", "exam-seat", "plan", "--job", okJobPath, "--out-dir", outDir]),
      ).resolves.toBe(EXIT_OK);
      expect(first.stderr()).toContain("已导出");
      expect(existsSync(nodePath.join(outDir, "考场安排名单.xlsx"))).toBe(true);

      // run.json：本次运行信息，成功时 exportedWorkbooks=true
      const firstRun = JSON.parse(readFileSync(nodePath.join(outDir, "run.json"), "utf8")) as {
        tool: string;
        delivery: string;
        exportedWorkbooks: boolean;
        artifacts: string[];
      };
      expect(firstRun.tool).toMatch(/^exam-seat \d/);
      expect(firstRun.exportedWorkbooks).toBe(true);
      expect(firstRun.artifacts).toContain("run.json");

      // 用户自己的文件必须活下来
      writeFileSync(nodePath.join(outDir, "我的笔记.txt"), "别删我");

      const second = captureOutput();
      const code = await main([
        "node",
        "exam-seat",
        "plan",
        "--job",
        failJobPath,
        "--out-dir",
        outDir,
      ]);
      expect(code).toBe(EXIT_INFEASIBLE);
      expect(existsSync(nodePath.join(outDir, "考场安排名单.xlsx"))).toBe(false);
      expect(existsSync(nodePath.join(outDir, "考场座位表.xlsx"))).toBe(false);
      expect(existsSync(nodePath.join(outDir, "plan.json"))).toBe(true);
      expect(existsSync(nodePath.join(outDir, "我的笔记.txt"))).toBe(true);
      expect(second.stderr()).toContain("已清掉本工具上一次生成的名单");
      expect(second.stderr()).toContain("请勿当作本次结果");
      expect(second.stderr()).toContain("本次运行信息见");

      const secondRun = JSON.parse(readFileSync(nodePath.join(outDir, "run.json"), "utf8")) as {
        delivery: string;
        exportedWorkbooks: boolean;
        artifacts: string[];
      };
      expect(secondRun.delivery).toBe("blocked");
      expect(secondRun.exportedWorkbooks).toBe(false);
    });
  });
});
