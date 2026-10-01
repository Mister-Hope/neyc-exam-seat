import { readFile } from "node:fs/promises";
import nodePath from "node:path";

import { Command } from "commander";

import {
  blocksListExport,
  plan,
  planAll,
  precheckJob,
  validate,
  validateAll,
} from "@exam-seat/core";
import type {
  Adjacency,
  Job,
  PlanAllResult,
  PlanOptions,
  PlanResult,
  RelaxMode,
  RoomSpec,
} from "@exam-seat/core";
import { describeDuplicateRoomIds } from "@exam-seat/io";
import { readRosterFile, writeMultiPlanFiles, writePlanFiles } from "@exam-seat/io/node";

import {
  renderDiagnostics,
  renderNumbering,
  renderPlan,
  renderPlanAll,
  renderPlanAllValidation,
} from "./render";

export const EXIT_OK = 0;
export const EXIT_USAGE = 1;
export const EXIT_DEGRADED = 2;
export const EXIT_INFEASIBLE = 3;

const VERSION = "0.0.2";

/**
 * CLI 失败的稳定错误码（写进 `--json` 输出的 `error.code`）。
 *
 * - `USAGE`：参数/用法错误（未知命令、缺必填参数、非法取值）
 * - `FILE_NOT_FOUND`：读不到 job / 名单文件
 * - `INVALID_JSON`：job 文件不是合法 JSON 或缺少 students / rooms
 * - `ABSENT_LIST_INVALID`：缺考名单的列认不出来，无法匹配
 * - `INTERNAL`：非预期内部错误
 */
export type CliErrorCode =
  | "USAGE"
  | "FILE_NOT_FOUND"
  | "INVALID_JSON"
  | "ABSENT_LIST_INVALID"
  | "INTERNAL";

/** 可预期的 CLI 失败：由 `main()` 统一转成「stderr 人话 + `--json` 时 stdout 一个 JSON 对象」。 */
export class CliFailureError extends Error {
  readonly code: CliErrorCode;

  constructor(message: string, code: CliErrorCode = "USAGE") {
    super(message);
    this.name = "CliFailureError";
    this.code = code;
  }
}

/** 当前正在解析/执行的 program（`fail()` 要按它判断是否 `--json`）。 */
let activeProgram: Command | undefined;

function jsonEnabled(): boolean {
  return Boolean(activeProgram?.opts<{ json?: boolean }>().json);
}

function fail(message: string, code: CliErrorCode = "USAGE"): never {
  throw new CliFailureError(message, code);
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
      text = await readFile(nodePath.resolve(path), "utf8");
    } catch {
      fail(`读不到 job 文件：${path}`, "FILE_NOT_FOUND");
    }
  }
  let parsed: Job | null;
  try {
    parsed = JSON.parse(text) as Job | null;
  } catch (err) {
    fail(`job 文件不是合法 JSON：${(err as Error).message}`, "INVALID_JSON");
  }
  if (parsed == null || !Array.isArray(parsed.rooms) || !Array.isArray(parsed.students)) {
    fail("job 文件里必须同时有 students 和 rooms 两个数组", "INVALID_JSON");
  }
  return parsed;
}

function writeJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * `plan --out-dir` 在多场次模式下写的 `plan.json` 是 `PlanAllResult`（有 `seatings`）， 单场的 `validate(job,
 * result)` 读不了它 —— 入口必须先判别，别掉进内部错误。
 */
function isMultiPlanJson(value: unknown): boolean {
  if (typeof value !== "object" || value == null) return false;
  const record = value as { seatings?: unknown; entries?: unknown };
  return Array.isArray(record.seatings) && !Array.isArray(record.entries);
}

function log(message = ""): void {
  process.stderr.write(`${message}\n`);
}

/**
 * `1-20:small,21-25:large,26:6x4` → RoomSpec[]。`NxM` 表示 N 排 × M 列。
 *
 * `small` = 5 列 × 7 排 = 35 座，与网页预设 `ROOM_PRESETS.small` 完全一致（同一本考务表两端必须同义）； `large` = 6 列 × 7 排 =
 * 42 座。
 *
 * 严格校验：区间**不允许重叠**（否则会生成重复的 `R15` 这类 id），`NxM` 的 N、M 必须是 ≥ 1 的整数； 生成后再自查一次 id 唯一，宁可报错也不产出会被下游并表的配置。
 */
export function parseRoomSpec(spec: string): RoomSpec[] {
  const rooms: RoomSpec[] = [];
  const ranges: { from: number; to: number }[] = [];
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
    // 区间重叠会生成重复 id（例如 1-20 与 15-25 → R15–R20 各两份），必须在这里挡住
    for (const prev of ranges) {
      const overlapFrom = Math.max(from, prev.from);
      const overlapTo = Math.min(to, prev.to);
      if (overlapFrom <= overlapTo) {
        const label =
          overlapFrom === overlapTo ? `R${overlapFrom}` : `R${overlapFrom}–R${overlapTo}`;
        throw new Error(
          `考场范围重叠：${label} 在两个区间里重复（${prev.from}-${prev.to} 与 ${from}-${to}），请改成不重叠的区间`,
        );
      }
    }
    ranges.push({ from, to });

    let cols: number, rows: number;
    const kind = kindPart.toLowerCase();
    if (kind === "small" || kind === "小") {
      rows = 7;
      cols = 5;
    } else if (kind === "large" || kind === "大") {
      rows = 7;
      cols = 6;
    } else {
      const m = /^(?<rows>\d+)\s*[x×*]\s*(?<cols>\d+)$/.exec(kind);
      if (!m)
        throw new Error(
          `看不懂的考场类型「${kindPart}」，可用 small（5 列 × 7 排）/ large（6 列 × 7 排）/ 6x4（6 排 × 4 列）`,
        );
      rows = Number(m.groups?.rows);
      cols = Number(m.groups?.cols);
      if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) {
        throw new Error(
          `考场类型「${kindPart}」的行列数必须是 ≥ 1 的整数，例如 6x4（6 排 × 4 列）`,
        );
      }
    }

    for (let n = from; n <= to; n += 1) {
      rooms.push({ id: `R${n}`, name: `第${n}考场`, rows, cols, doorSide: "right" });
    }
  }

  // 防御性自查：正常路径到不了这里，但绝不允许把重复 id 放出去
  const ids = rooms.map((room) => room.id);
  if (new Set(ids).size !== ids.length) {
    const duplicated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    throw new Error(`生成了重复的考场 id：${duplicated.join("、")}，请检查 --spec 的区间`);
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
      // R1 跟 CLI `small` / 网页小考场预设一致：5 列 × 7 排 = 35 座；R2 = large 6 列 × 7 排 = 42 座
      { id: "R1", name: "第1考场", rows: 7, cols: 5, doorSide: "right", note: "张老师" },
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
  activeProgram = program;
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

  // commander 自己也会写错误行；记下来，避免 `--json` 时同一条错误在 stderr 打两遍
  let commanderErrorWritten = false;
  program.configureOutput({
    writeErr: (str) => {
      commanderErrorWritten = true;
      process.stderr.write(str);
    },
    writeOut: (str) => {
      process.stdout.write(str);
    },
  });

  const globalJson = (): boolean => Boolean(program.opts<{ json?: boolean }>().json);

  /* ---------------- roster ---------------- */
  program
    .command("roster")
    .description("读一个 Excel 名单，输出学生数组（给 agent 拼 job.json 用）")
    .requiredOption("--file <xlsx>", "名单文件路径")
    .option("--sheet <name>", "工作表名或下标")
    .option(
      "--absent <xlsx>",
      "单独的缺考名单文件（有准考证号列按准考证号匹配，否则按 姓名 + 班级）",
    )
    .option("--absent-sheet <name>", "缺考名单的工作表名或下标")
    .option("--out <file>", "把结果写到文件（否则打印到 stdout）")
    .action(
      async (options: {
        file: string;
        sheet?: string;
        absent?: string;
        absentSheet?: string;
        out?: string;
      }) => {
        const sheet =
          options.sheet === undefined
            ? undefined
            : /^\d+$/.test(options.sheet)
              ? Number(options.sheet)
              : options.sheet;
        const absentSheet =
          options.absentSheet === undefined
            ? undefined
            : /^\d+$/.test(options.absentSheet)
              ? Number(options.absentSheet)
              : options.absentSheet;
        let result: ReturnType<typeof readRosterFile>;
        try {
          result = readRosterFile(options.file, {
            sheet,
            absentFile: options.absent,
            absentSheet,
          });
        } catch (err) {
          fail((err as Error).message);
        }

        const absentIssues = result.absent?.issues ?? [];
        const fatalAbsent = absentIssues.filter((issue) => issue.level === "error");
        if (fatalAbsent.length > 0) {
          // 缺考名单的列都认不出来：明确报错，别让它静默变成「一个人都没缺考」
          const message = fatalAbsent.map((issue) => issue.message).join("；");
          if (globalJson()) {
            writeJson({
              ok: false,
              error: { code: "ABSENT_LIST_INVALID", message },
              issues: fatalAbsent,
            });
          } else {
            log(`exam-seat: 缺考名单用不了：${message}`);
          }
          exitCode = EXIT_USAGE;
          return;
        }

        const { absent } = result;
        const payload = {
          file: nodePath.resolve(options.file),
          sheetName: result.sheetName,
          sheetNames: result.sheetNames,
          headers: result.headers,
          mapping: result.mapping,
          classCount: new Set(result.students.map((s) => s.className)).size,
          studentCount: result.students.length,
          absentCount: result.students.filter((s) => s.included === false).length,
          issues: [...result.issues, ...absentIssues],
          students: result.students,
          ...(absent === undefined
            ? {}
            : {
                absent: {
                  file: absent.file,
                  keyCount: absent.keys.length,
                  matchedCount: absent.matched.length,
                  unmatchedCount: absent.unmatched.length,
                  unmatched: absent.unmatched,
                  ambiguousCount: absent.ambiguous.length,
                  ambiguous: absent.ambiguous,
                },
              }),
        };
        const ambiguousSuffix =
          absent !== undefined && absent.ambiguous.length > 0
            ? ` / 歧义 ${absent.ambiguous.length} 行`
            : "";
        const absentSummary =
          absent === undefined
            ? null
            : `缺考名单命中 ${absent.matched.length} 人 / 未匹配 ${absent.unmatched.length} 行${ambiguousSuffix}`;

        if (options.out) {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(nodePath.resolve(options.out), JSON.stringify(payload, null, 2));
          log(`已写入 ${nodePath.resolve(options.out)}（${result.students.length} 名学生）`);
        } else if (globalJson()) {
          writeJson(payload);
        } else {
          log(`工作表「${result.sheetName}」  表头：${result.headers.join(" / ")}`);
          log(`共 ${result.students.length} 名学生，${payload.classCount} 个班`);
        }

        if (absentSummary) {
          log(absentSummary);
          // 未匹配的缺考行逐条走 stderr（issue.message 里已写明「缺考名单第 N 行」）
          for (const issue of absentIssues) log(`  [${issue.level}] ${issue.message}`);
        }
        if (!options.out && !globalJson()) {
          if (result.issues.length > 0) {
            log(`\n有 ${result.issues.length} 处需要留意：`);
            for (const issue of result.issues.slice(0, 20)) {
              log(`  [${issue.level}] 第 ${issue.row} 行：${issue.message}`);
            }
          }
          log("\n（加 --json 可拿到完整学生数组，用来拼 job.json）");
        }
        exitCode = EXIT_OK;
      },
    );

  /* ---------------- rooms ---------------- */
  program
    .command("rooms")
    .description(
      '按紧凑语法生成考场配置，例如 "1-20:small,21-25:large,26:6x4"（NxM = N 排 × M 列；small = 5 列 × 7 排 = 35 座，large = 6 列 × 7 排 = 42 座）',
    )
    .requiredOption(
      "--spec <spec>",
      "考场规格，例如 1-20:small 或 26:6x4（small = 5 列 7 排，large = 6 列 7 排）",
    )
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
    .option("--extra <cols>", "讲台侧加座所在业务列，例如 2,4")
    .action((options: { rows: string; cols: string; door: string; extra?: string }) => {
      const rows = Number(options.rows);
      const cols = Number(options.cols);
      if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) {
        fail("--rows 和 --cols 必须是正整数");
      }
      if (options.door !== "left" && options.door !== "right") fail("--door 只能是 left 或 right");
      const { door } = options;
      const extraFrontSeats = (options.extra ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "")
        .map(Number);
      if (extraFrontSeats.some((col) => !Number.isInteger(col) || col < 1 || col > cols)) {
        fail(`--extra 只能是 1..${cols} 的列号，用逗号分隔，例如 --extra 2,4`);
      }
      const text = renderNumbering(rows, cols, door, extraFrontSeats);
      if (globalJson()) {
        const seats: { row: number; physicalCol: number; businessCol: number }[] = [];
        for (let row = 0; row <= rows; row += 1) {
          if (row === 0 && extraFrontSeats.length === 0) continue;
          for (let pc = 1; pc <= cols; pc += 1) {
            const businessCol = door === "right" ? cols - pc + 1 : pc;
            if (row === 0 && !extraFrontSeats.includes(businessCol)) continue;
            seats.push({ row, physicalCol: pc, businessCol });
          }
        }
        writeJson({
          rows,
          cols,
          doorSide: door,
          ...(extraFrontSeats.length > 0 ? { extraFrontSeats } : {}),
          preview: text,
          seats,
        });
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
        await writeFile(nodePath.resolve(options.out), `${text}\n`);
        log(`已写入 ${nodePath.resolve(options.out)}`);
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
        // 导出层只能按 roomId 归并：重复 id 会把两间考场并成一张表并丢人，这里直接挡住、不写任何文件
        if (options.outDir) {
          const duplicated = describeDuplicateRoomIds(job.rooms);
          if (duplicated) {
            log(`exam-seat: ${duplicated}`);
            log("exam-seat: 已取消导出，未写出任何文件。");
            exitCode = EXIT_USAGE;
            return;
          }
        }
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
          !options.single &&
          (job.students ?? []).some((s) => (s.subjects?.length ?? 0) > 0 || Boolean(s.combination));

        if (multi) {
          const multiResult = planAll(job, overrides);
          // 导出闸门**只看 core 算好的 `delivery`**（铁律 4）：blocked 时不导出名单与监考表；
          // 放宽模式的主动降级是 ready-with-warnings，照常导出
          const blocked = blocksListExport(multiResult);
          if (options.outDir) {
            const written = writeMultiPlanFiles(multiResult, {
              outDir: options.outDir,
              rooms: job.rooms,
              job,
              writeWorkbooks: !blocked,
              tool: `exam-seat ${VERSION}`,
            });
            if (blocked) {
              log("结果未通过校验，已只导出 plan.json / job.json，未导出名单与监考表。");
              log(
                "⚠️ 已清掉本工具上一次生成的名单；本目录里若仍有同名文件，那是别处复制进来的，请勿当作本次结果。",
              );
              log(`本次运行信息见 ${nodePath.resolve(options.outDir)}/run.json`);
              for (const d of multiResult.diagnostics) {
                if (d.severity === "error") log(`  [error] ${d.code}: ${d.message}`);
              }
            }
            log(`已导出 ${written.files.length} 个文件：`);
            // 多场次会写出「合并版 + 每班/每考场一个文件」，逐条刷 40+ 行很吵，这里只给目录摘要
            const dirs = written.directories;
            if (dirs.classFiles > 0) {
              log(`  按班级考场安排.xlsx（总表 + ${dirs.classFiles} 个班）`);
              if (dirs.classDir) log(`  ${dirs.classDir}/（${dirs.classFiles} 个班级文件）`);
            }
            if (dirs.roomFiles > 0) {
              log(`  考场监考表.xlsx（${dirs.roomFiles} 个考场）`);
              if (dirs.roomDir) log(`  ${dirs.roomDir}/（${dirs.roomFiles} 个考场文件）`);
            }
            const jsonPaths = written.files.filter(
              (file) => file.endsWith("plan.json") || file.endsWith("job.json"),
            );
            if (jsonPaths.length > 0) log(`  ${jsonPaths.join(" ｜ ")}`);
            if (written.removedRooms.length > 0) {
              log(
                `已剔除空置考场：${written.removedRooms.join("、")}（导出的 job.json 里不再包含）`,
              );
            }
          }
          if (globalJson()) {
            writeJson(multiResult);
          } else {
            process.stdout.write(`${renderPlanAll(multiResult)}\n`);
          }
          // 退出码契约（design §9）：3 = 名单不成立（没有座位方案，或结构性 error）；
          // 2 = 主动降级（例如 --relax 只留下 SEARCH_FAILED），结果仍可用
          exitCode =
            multiResult.seatings.length === 0 || blocked
              ? EXIT_INFEASIBLE
              : multiResult.ok
                ? EXIT_OK
                : EXIT_DEGRADED;
          return;
        }

        const result: PlanResult = plan(job, overrides);
        // 与多场次同一判据：只看 core 算好的 `delivery`（铁律 4）
        const blocked = blocksListExport(result);

        if (options.outDir) {
          const written = writePlanFiles(result, {
            outDir: options.outDir,
            rooms: job.rooms,
            writeJson: true,
            job,
            writeWorkbooks: !blocked,
            tool: `exam-seat ${VERSION}`,
          });
          if (blocked) {
            log("结果未通过校验，已只导出 plan.json / job.json，未导出名单与监考表。");
            log(
              "⚠️ 已清掉本工具上一次生成的名单；本目录里若仍有同名文件，那是别处复制进来的，请勿当作本次结果。",
            );
            log(`本次运行信息见 ${nodePath.resolve(options.outDir)}/run.json`);
            for (const d of result.diagnostics) {
              if (d.severity === "error") log(`  [error] ${d.code}: ${d.message}`);
            }
          }
          log(`已导出 ${written.files.length} 个文件：`);
          for (const path of written.files) log(`  ${path}`);
          if (written.removedRooms.length > 0) {
            log(`已剔除空置考场：${written.removedRooms.join("、")}（导出的 job.json 里不再包含）`);
          }
        }

        if (globalJson()) {
          writeJson(result);
        } else {
          process.stdout.write(`${renderPlan(result, Number(options.show) || 0)}\n`);
        }

        exitCode =
          result.entries.length === 0 || blocked
            ? EXIT_INFEASIBLE
            : result.ok
              ? EXIT_OK
              : EXIT_DEGRADED;
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
        options.plan === "-"
          ? await readStdin()
          : await readFile(nodePath.resolve(options.plan), "utf8");
      const parsed = JSON.parse(planText) as unknown;
      if (isMultiPlanJson(parsed)) {
        // 多场次：逐 seating 重建子 job 独立校验（core 的 validateAll）
        const validation = validateAll(job, parsed as PlanAllResult);
        if (globalJson()) writeJson(validation);
        else log(renderPlanAllValidation(validation));
        exitCode = validation.ok ? EXIT_OK : EXIT_INFEASIBLE;
        return;
      }
      const result = parsed as PlanResult;
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
    // 可预期的 CLI 失败（参数校验 / 文件读写 / job 非法）：人话走 stderr，`--json` 时 stdout 给一个 JSON
    if (error instanceof CliFailureError) {
      if (jsonEnabled()) {
        writeJson({ ok: false, error: { code: error.code, message: error.message } });
      }
      process.stderr.write(`exam-seat: ${error.message}\n`);
      return EXIT_USAGE;
    }
    const err = error as { code?: string; exitCode?: number; message?: string; stack?: string };
    if (err.code === "commander.helpDisplayed" || err.code === "commander.version") return EXIT_OK;
    if (err.code?.startsWith("commander.")) {
      const message = err.message ?? String(error);
      if (jsonEnabled()) {
        // JSON 里的 message 去掉 commander 的 "error: " 前缀，给 agent 一句干净的说明
        writeJson({
          ok: false,
          error: { code: "USAGE", message: message.replace(/^error: /u, "") },
        });
        // commander 已经写过一遍就不再重复；没有写过（例如别处抛出的 commander 错误）补一句人话
        if (!commanderErrorWritten) process.stderr.write(`exam-seat: ${message}\n`);
      } else {
        process.stderr.write(`exam-seat: ${message}\n`);
      }
      return err.exitCode ?? EXIT_USAGE;
    }
    // 非预期错误：给一句人话，别把堆栈糊到 agent 脸上
    const message = err.message ?? String(error);
    if (jsonEnabled()) {
      writeJson({ ok: false, error: { code: "INTERNAL", message } });
    }
    process.stderr.write(`exam-seat: 内部错误：${message}\n`);
    if (process.env.EXAM_SEAT_DEBUG) {
      process.stderr.write(`${err.stack ?? ""}\n`);
    }
    return EXIT_USAGE;
  }

  return exitCode;
}
