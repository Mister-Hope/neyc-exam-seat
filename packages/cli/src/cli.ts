import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Command } from "commander";

import { plan, planAll, precheckJob, validate } from "@exam-seat/core";
import type { Adjacency, Job, PlanOptions, PlanResult, RelaxMode, RoomSpec } from "@exam-seat/core";
import { readRosterFile, writeMultiPlanFiles, writePlanFiles } from "@exam-seat/io/node";

import { renderDiagnostics, renderNumbering, renderPlan, renderPlanAll } from "./render";

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_DEGRADED = 2;
export const EXIT_INFEASIBLE = 3;

const VERSION = "0.1.0";

function fail(message: string): never {
  process.stderr.write(`exam-seat: ${message}\n`);
  process.exit(EXIT_USAGE);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

async function loadJob(path: string): Promise<Job> {
  let text: string;
  if (path === "-") {
    text = await readStdin();
  } else {
    try {
      text = await readFile(resolve(path), "utf8");
    } catch {
      fail(`读不到 job 文件：${path}`);
    }
  }
  try {
    const parsed = JSON.parse(text) as Job;
    if (!parsed || !Array.isArray(parsed.rooms) || !Array.isArray(parsed.students)) {
      fail("job 文件里必须同时有 students 和 rooms 两个数组");
    }
    return parsed;
  } catch (err) {
    fail(`job 文件不是合法 JSON：${(err as Error).message}`);
  }
}

function writeJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function log(message = ""): void {
  process.stderr.write(`${message}\n`);
}

/** `1-20:small,21-25:large,26:6x4` → RoomSpec[]。`NxM` 表示 N 排 × M 列。 */
export function parseRoomSpec(spec: string): RoomSpec[] {
  const rooms: RoomSpec[] = [];
  const segments = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const segment of segments) {
    const [rangePart, kindPart] = segment.split(":").map((s) => s.trim());
    if (!rangePart || !kindPart) {
      throw new Error(`看不懂的考场规格「${segment}」，应该像 1-20:small 或 26:6x4`);
    }
    let from: number, to: number;
    const dash = rangePart.indexOf("-");
    if (dash > 0) {
      from = Number(rangePart.slice(0, dash));
      to = Number(rangePart.slice(dash + 1));
    } else {
      from = Number(rangePart);
      to = from;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
      throw new Error(`看不懂的考场范围「${rangePart}」`);
    }

    let cols: number, rows: number;
    const kind = kindPart.toLowerCase();
    if (kind === "small" || kind === "小") {
      rows = 6;
      cols = 5;
    } else if (kind === "large" || kind === "大") {
      rows = 7;
      cols = 6;
    } else {
      const m = /^(\d+)\s*[x×*]\s*(\d+)$/.exec(kind);
      if (!m)
        throw new Error(`看不懂的考场类型「${kindPart}」，可用 small / large / 6x4（6 排 × 4 列）`);
      rows = Number(m[1]);
      cols = Number(m[2]);
    }

    for (let n = from; n <= to; n += 1) {
      rooms.push({ id: `R${n}`, name: `第${n}考场`, rows, cols, doorSide: "right" });
    }
  }
  return rooms;
}

function buildTemplate(): Job {
  return {
    jobVersion: 2,
    meta: { title: "2026届高三一模" },
    options: { seed: 20260930, adjacency: "king", relax: "none", timeLimitMs: 10000 },
    students: [
      { id: "20240101", name: "张三", className: "高三(1)班" },
      { id: "20240102", name: "李四", className: "高三(1)班" },
      { id: "20240201", name: "王五", className: "高三(2)班" },
    ],
    rooms: [
      { id: "R1", name: "第1考场", rows: 6, cols: 5, doorSide: "right", note: "张老师" },
      { id: "R2", name: "第2考场", rows: 7, cols: 6, doorSide: "right", note: "李老师" },
    ],
    constraints: [
      { id: "C1", note: "有作弊前科，坐首排", studentIds: ["20240101"], rows: ["first"] },
      { id: "C2", note: "班主任监考的考场", studentIds: ["20240201"], roomId: "R2" },
    ],
  };
}

export async function main(argv: string[]): Promise<number> {
  let exitCode: number = EXIT_OK;

  const program = new Command();
  program
    .name("exam-seat")
    .description(
      "排考场工具。核心约定：\n" +
        "  · 列号从靠门侧起算（第 1 列 = 靠门列）\n" +
        "  · 不指定考场时，行/列只能用 first / last / door / window 这类语义值\n" +
        "  · 考场限定是单选；同一学生多条限定取交集\n" +
        "  · 输出是名单（考场 + 座位号），不是座位图",
    )
    .version(VERSION)
    .option("--json", "输出机器可读的 JSON（stdout 只放一个 JSON 对象，日志走 stderr）")
    .exitOverride();

  program.configureOutput({
    writeErr: (str) => process.stderr.write(str),
    writeOut: (str) => process.stdout.write(str),
  });

  const globalJson = (): boolean => Boolean(program.opts<{ json?: boolean }>().json);

  /* ---------------- roster ---------------- */
  program
    .command("roster")
    .description("读一个 Excel 名单，输出学生数组（给 agent 拼 job.json 用）")
    .requiredOption("--file <xlsx>", "名单文件路径")
    .option("--sheet <name>", "工作表名或下标")
    .option("--out <file>", "把结果写到文件（否则打印到 stdout）")
    .action(async (options: { file: string; sheet?: string; out?: string }) => {
      const sheet =
        options.sheet === undefined
          ? undefined
          : /^\d+$/.test(options.sheet)
            ? Number(options.sheet)
            : options.sheet;
      let result: ReturnType<typeof readRosterFile>;
      try {
        result = readRosterFile(options.file, { sheet });
      } catch (err) {
        fail((err as Error).message);
      }
      const payload = {
        file: resolve(options.file),
        sheetName: result.sheetName,
        sheetNames: result.sheetNames,
        headers: result.headers,
        mapping: result.mapping,
        classCount: new Set(result.students.map((s) => s.className)).size,
        studentCount: result.students.length,
        issues: result.issues,
        students: result.students,
      };
      if (options.out) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(resolve(options.out), JSON.stringify(payload, null, 2));
        log(`已写入 ${resolve(options.out)}（${result.students.length} 名学生）`);
      } else if (globalJson()) {
        writeJson(payload);
      } else {
        log(`工作表「${result.sheetName}」  表头：${result.headers.join(" / ")}`);
        log(`共 ${result.students.length} 名学生，${payload.classCount} 个班`);
        if (result.issues.length > 0) {
          log(`\n有 ${result.issues.length} 处需要留意：`);
          for (const issue of result.issues.slice(0, 20)) {
            log(`  [${issue.level}] 第 ${issue.row} 行：${issue.message}`);
          }
        }
        log("\n（加 --json 可拿到完整学生数组，用来拼 job.json）");
      }
      exitCode = EXIT_OK;
    });

  /* ---------------- rooms ---------------- */
  program
    .command("rooms")
    .description(
      '按紧凑语法生成考场配置，例如 "1-20:small,21-25:large,26:6x4"（NxM = N 排 × M 列）',
    )
    .requiredOption("--spec <spec>", "考场规格")
    .action((options: { spec: string }) => {
      let rooms: RoomSpec[];
      try {
        rooms = parseRoomSpec(options.spec);
      } catch (err) {
        fail((err as Error).message);
      }
      const total = rooms.reduce((sum, r) => sum + r.rows * r.cols, 0);
      if (globalJson()) {
        writeJson({ rooms, count: rooms.length, seatsTotal: total });
      } else {
        for (const r of rooms) {
          log(`${(r.name ?? r.id).padEnd(8)} ${r.rows} 排 × ${r.cols} 列 = ${r.rows * r.cols} 人`);
        }
        log(`\n共 ${rooms.length} 个考场，${total} 个座位`);
      }
      exitCode = EXIT_OK;
    });

  /* ---------------- numbering ---------------- */
  program
    .command("numbering")
    .description("打印座位编号图（按物理列序，跟老师看到的一致）")
    .option("--rows <n>", "排数", "6")
    .option("--cols <n>", "列数", "5")
    .option("--door <side>", "门在左还是右：left | right", "right")
    .action((options: { rows: string; cols: string; door: string }) => {
      const rows = Number(options.rows);
      const cols = Number(options.cols);
      if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) {
        fail("--rows 和 --cols 必须是正整数");
      }
      if (options.door !== "left" && options.door !== "right") fail("--door 只能是 left 或 right");
      const { door } = options;
      const text = renderNumbering(rows, cols, door);
      if (globalJson()) {
        const seats: { row: number; physicalCol: number; businessCol: number }[] = [];
        for (let row = 1; row <= rows; row += 1) {
          for (let pc = 1; pc <= cols; pc += 1) {
            seats.push({
              row,
              physicalCol: pc,
              businessCol: door === "right" ? cols - pc + 1 : pc,
            });
          }
        }
        writeJson({ rows, cols, doorSide: door, preview: text, seats });
      } else {
        process.stdout.write(`${text}\n`);
      }
      exitCode = EXIT_OK;
    });

  /* ---------------- template ---------------- */
  program
    .command("template")
    .description("输出一份 job.json 模板")
    .option("--out <file>", "写到文件")
    .action(async (options: { out?: string }) => {
      const text = JSON.stringify(buildTemplate(), null, 2);
      if (options.out) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(resolve(options.out), `${text}\n`);
        log(`已写入 ${resolve(options.out)}`);
      } else {
        process.stdout.write(`${text}\n`);
      }
      exitCode = EXIT_OK;
    });

  /* ---------------- precheck ---------------- */
  program
    .command("precheck")
    .description("只判定有没有解、为什么没解、怎么放宽，不进求解器")
    .requiredOption("--job <file>", "job.json 路径，- 表示从 stdin 读")
    .action(async (options: { job: string }) => {
      const job = await loadJob(options.job);
      const out = precheckJob(job);
      if (globalJson()) {
        writeJson({
          fatal: out.fatal,
          adjacency: out.adjacency,
          downgraded: out.downgraded,
          diagnostics: out.diagnostics,
        });
      } else {
        log(out.fatal ? "❌ 这样排不出来" : "✅ 预检通过，可以排");
        if (out.downgraded) log("⚠️  班级数不足 9，已自动退化为「前后左右不同班」");
        log("");
        process.stdout.write(`${renderDiagnostics(out.diagnostics)}\n`);
      }
      exitCode = out.fatal ? EXIT_INFEASIBLE : EXIT_OK;
    });

  /* ---------------- plan ---------------- */
  program
    .command("plan")
    .description("正式排考场")
    .requiredOption("--job <file>", "job.json 路径，- 表示从 stdin 读")
    .option("--out-dir <dir>", "导出目录（写 xlsx 与 plan.json）")
    .option("--seed <n>", "随机种子（覆盖 job 里的设置）")
    .option("--relax <mode>", "降级模式：none | softConstraints | minConflicts")
    .option("--adjacency <mode>", "相邻规则：king（8 邻域）| orthogonal（前后左右）")
    .option("--force-king", "即使班级数不足 9 个也坚持 8 邻域，不自动退化")
    .option("--time-limit <ms>", "求解时间上限（毫秒）")
    .option("--show <n>", "终端里最多打印多少条名单", "20")
    .option("--single", "强制单场模式（忽略名单里的选科列）")
    .action(
      async (options: {
        job: string;
        outDir?: string;
        seed?: string;
        relax?: string;
        adjacency?: string;
        forceKing?: boolean;
        timeLimit?: string;
        show: string;
        single?: boolean;
      }) => {
        const job = await loadJob(options.job);
        const overrides: PlanOptions = {};
        if (options.seed !== undefined) {
          const seed = Number(options.seed);
          if (!Number.isInteger(seed)) fail(`--seed 必须是整数，收到「${options.seed}」`);
          overrides.seed = seed;
        }
        if (options.relax) {
          if (!["none", "softConstraints", "minConflicts"].includes(options.relax)) {
            fail("--relax 只能是 none / softConstraints / minConflicts");
          }
          overrides.relax = options.relax as RelaxMode;
        }
        if (options.adjacency) {
          if (!["king", "orthogonal"].includes(options.adjacency)) {
            fail("--adjacency 只能是 king 或 orthogonal");
          }
          overrides.adjacency = options.adjacency as Adjacency;
        }
        if (options.forceKing) overrides.forceKing = true;
        if (options.timeLimit) {
          const ms = Number(options.timeLimit);
          if (!Number.isInteger(ms) || ms < 0) fail("--time-limit 必须是非负整数");
          overrides.timeLimitMs = ms;
        }

        // 名单里带选科就走多场次；否则就是普通单场
        const multi =
          !options.single && (job.students ?? []).some((s) => s.subjects?.length || s.combination);

        if (multi) {
          const multiResult = planAll(job, overrides);
          if (options.outDir) {
            const written = writeMultiPlanFiles(multiResult, {
              outDir: options.outDir,
              rooms: job.rooms,
            });
            log(`已导出 ${written.length} 个文件：`);
            for (const path of written) log(`  ${path}`);
          }
          if (globalJson()) {
            writeJson(multiResult);
          } else {
            process.stdout.write(`${renderPlanAll(multiResult)}\n`);
          }
          exitCode =
            multiResult.seatings.length === 0
              ? EXIT_INFEASIBLE
              : multiResult.ok
                ? EXIT_OK
                : EXIT_DEGRADED;
          return;
        }

        const result: PlanResult = plan(job, overrides);

        if (options.outDir) {
          const written = writePlanFiles(result, {
            outDir: options.outDir,
            rooms: job.rooms,
            writeJson: true,
            job,
          });
          log(`已导出 ${written.length} 个文件：`);
          for (const path of written) log(`  ${path}`);
        }

        if (globalJson()) {
          writeJson(result);
        } else {
          process.stdout.write(`${renderPlan(result, Number(options.show) || 0)}\n`);
        }

        exitCode =
          result.entries.length === 0 ? EXIT_INFEASIBLE : result.ok ? EXIT_OK : EXIT_DEGRADED;
      },
    );

  /* ---------------- validate ---------------- */
  program
    .command("validate")
    .description("用独立校验器重验一份结果（校验器与求解器分开实现）")
    .requiredOption("--job <file>", "job.json 路径，- 表示从 stdin 读")
    .requiredOption("--plan <file>", "plan.json 路径，- 表示从 stdin 读")
    .action(async (options: { job: string; plan: string }) => {
      const job = await loadJob(options.job);
      const planText =
        options.plan === "-" ? await readStdin() : await readFile(resolve(options.plan), "utf8");
      const result = JSON.parse(planText) as PlanResult;
      const report = validate(job, result);
      if (globalJson()) {
        writeJson(report);
      } else if (report.ok) {
        log("✅ 校验通过：容量、邻接、限定、编号全部一致");
      } else {
        log("❌ 校验未通过：");
        for (const issue of report.issues)
          log(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
      }
      exitCode = report.ok ? EXIT_OK : EXIT_INFEASIBLE;
    });

  /* ---------------- 解析 ---------------- */

  program.showSuggestionAfterError(false);
  try {
    await program.parseAsync(argv);
  } catch (error) {
    const err = error as { code?: string; exitCode?: number; message?: string; stack?: string };
    if (err.code === "commander.helpDisplayed" || err.code === "commander.version") return EXIT_OK;
    if (err.code?.startsWith("commander.")) {
      process.stderr.write(`exam-seat: ${err.message}\n`);
      return err.exitCode ?? EXIT_USAGE;
    }
    // 非预期错误：给一句人话，别把堆栈糊到 agent 脸上
    process.stderr.write(`exam-seat: 内部错误：${err.message ?? String(error)}\n`);
    if (process.env.EXAM_SEAT_DEBUG) {
      process.stderr.write(`${err.stack ?? ""}\n`);
    }
    return EXIT_USAGE;
  }

  return exitCode;
}
