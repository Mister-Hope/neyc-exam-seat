import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import nodePath from "node:path";

import { planDelivery } from "@exam-seat/core";
import type { Job, PlanAllResult, PlanDelivery, PlanResult, RoomSpec } from "@exam-seat/core";

import {
  applyAbsentKeys,
  buildClassScheduleSheets,
  buildClassScheduleWorkbook,
  buildInvigilatorSheets,
  buildInvigilatorWorkbook,
  buildPlanWorkbook,
  buildRoomSheets,
  buildXlsx,
  describeDuplicateRoomIds,
  pruneEmptyRooms,
  readAbsentKeys,
  readRoster,
  readWorkbook,
  usedRoomIds,
} from "./index";
import type { ReadRosterOptions, RosterReadResult, SheetData } from "./index";

/** 工作表名或下标 → 具体某张表；缺省取第一张。 */
function pickSheet(sheets: SheetData[], sheet?: string | number): SheetData | undefined {
  if (typeof sheet === "number") return sheets[sheet];
  if (typeof sheet === "string") return sheets.find((item) => item.name === sheet);
  return sheets[0];
}

/**
 * Node 侧：直接读一个 .xlsx 名单文件。
 *
 * 传了 `absentFile` 时会再读一份**缺考名单**并作用到主名单上（缺考名单有准考证号列就按准考证号匹配， 否则按「姓名 + 班级」成对匹配），结果放在
 * `RosterReadResult.absent` 里。
 */
export function readRosterFile(path: string, options: ReadRosterOptions = {}): RosterReadResult {
  const result = readRoster(readFileSync(nodePath.resolve(path)), options);
  if (options.absentFile === undefined) return result;

  const absentPath = nodePath.resolve(options.absentFile);
  const sheets = readWorkbook(readFileSync(absentPath));
  if (sheets.length === 0) throw new Error(`缺考名单文件里没有任何工作表：${options.absentFile}`);
  const sheet = pickSheet(sheets, options.absentSheet);
  if (!sheet) {
    throw new Error(
      `找不到缺考名单的工作表 ${String(options.absentSheet)}，可用的有：${sheets
        .map((item) => item.name)
        .join("、")}`,
    );
  }

  const { keys, issues } = readAbsentKeys(sheet, options.absentMapping);
  // 列都认不出来时不要去匹配（keys 必为空），把 error issue 原样交给调用方（CLI 会明确报错）
  if (issues.some((issue) => issue.level === "error")) {
    return {
      ...result,
      absent: { file: absentPath, keys, matched: [], unmatched: keys, ambiguous: [], issues },
    };
  }

  const applied = applyAbsentKeys(result.students, keys);
  return {
    ...result,
    students: applied.students,
    absent: {
      file: absentPath,
      keys,
      matched: applied.matched,
      unmatched: applied.unmatched,
      ambiguous: applied.ambiguous,
      issues: [...issues, ...applied.issues],
    },
  };
}

export function writeBinaryFile(path: string, bytes: Uint8Array): string {
  const target = nodePath.resolve(path);
  mkdirSync(nodePath.join(target, ".."), { recursive: true });
  writeFileSync(target, bytes);
  return target;
}

/** 落盘结果的目录摘要（多场次导出才有） */
export interface WriteDirectories {
  /** `按班级考场安排/` 目录绝对路径（一个班文件都没有时不写） */
  classDir?: string;
  /** `考场监考表/` 目录绝对路径（一个考场文件都没有时不写） */
  roomDir?: string;
  /** 写出的班级文件数 */
  classFiles: number;
  /** 写出的考场文件数 */
  roomFiles: number;
}

export interface WriteFilesResult {
  /** 写出的文件绝对路径，按写入顺序（含子目录里的分表） */
  files: string[];
  /** 写 job.json 时剔除的空置考场名（`name ?? id`），按原 `rooms` 顺序；没写 job.json 时为空 */
  removedRooms: string[];
  /** 分组信息：两个子目录与各自文件数 */
  directories: WriteDirectories;
}

/**
 * 本次运行的元数据（`run.json`）：让老师一眼看出「这份目录是哪次跑的、名单是不是本次的」。
 *
 * 与 `plan.json` 并列写在同一目录；`artifacts` 是相对 `--out-dir` 的路径清单。
 */
export interface RunInfo {
  /** 本次落盘时间（ISO） */
  generatedAt: string;
  /** 工具名 + 版本（CLI 传 `exam-seat 0.0.2` 这类字符串） */
  tool: string;
  /** 交付状态，与 core 的 `PlanDelivery` 同义 */
  delivery: PlanDelivery;
  /** 本次是否真的写出了名单 / 监考表（失败路径为 false） */
  exportedWorkbooks: boolean;
  /** 本次实际写出的文件（相对 `--out-dir`，含 `run.json` 自己） */
  artifacts: string[];
}

export interface WritePlanOptions {
  outDir: string;
  /** 主文件名，默认「考场安排名单.xlsx」 */
  fileName?: string;
  /** 给了考场规格就额外生成「考场座位表.xlsx」 */
  rooms?: RoomSpec[];
  /** 是否额外写出 plan.json */
  writeJson?: boolean;
  /** 给了 job 且 `writeJson` 为真时，写出剔除空置考场后的 job.json */
  job?: Job;
  /**
   * 是否写名单工作簿（`考场安排名单.xlsx` / `考场座位表.xlsx`），默认 true；结果被判定为结构性 error 时调用方传 false，只留 plan.json /
   * job.json 作证
   */
  writeWorkbooks?: boolean;
  /** `run.json` 里的工具名 + 版本，缺省 `exam-seat` */
  tool?: string;
  /** 是否写 `run.json`，默认 true */
  writeRunInfo?: boolean;
}

/** 考场对外展示名：有名字用名字（去空白），否则退回 id。与 core 的 roomName 口径一致。 */
function roomLabel(room: RoomSpec): string {
  const name = room.name?.trim();
  return name === undefined || name === "" ? room.id : name;
}

/** 导出层按 roomId 归并；重复 id 会并表丢人，宁可直接报错。 */
function assertUniqueRoomIds(rooms: readonly RoomSpec[] | undefined): void {
  const message = describeDuplicateRoomIds(rooms ?? []);
  if (message) throw new Error(message);
}

/**
 * 写 `run.json`：本次运行的时间、工具、交付状态、是否导出名单、产物清单。
 *
 * **在所有产物都写完之后**调用，这样 `artifacts` 就是本目录里真实的本次产物清单（含 `run.json` 自己）。
 */
function writeRunInfo(
  outDir: string,
  written: readonly string[],
  info: { tool: string; delivery: PlanDelivery; exportedWorkbooks: boolean },
): string {
  const runPath = nodePath.join(outDir, "run.json");
  const payload: RunInfo = {
    generatedAt: new Date().toISOString(),
    tool: info.tool,
    delivery: info.delivery,
    exportedWorkbooks: info.exportedWorkbooks,
    artifacts: [...written.map((file) => nodePath.relative(outDir, file)), "run.json"],
  };
  writeFileSync(runPath, JSON.stringify(payload, null, 2));
  return runPath;
}

/**
 * 本工具在 `--out-dir` 下**拥有**的名单产物（清单清理只动这些，绝不清空整个目录）。
 *
 * `plan.json` / `job.json` 是留证据用的，不在这里 —— 每次运行都会覆盖它们，不需要「清理」。
 */
export const OWNED_ARTIFACT_FILES = [
  "考场安排名单.xlsx",
  "考场座位表.xlsx",
  "按班级考场安排.xlsx",
  "考场监考表.xlsx",
  "run.json",
] as const;

/** 本工具拥有的「分份目录」（每班 / 每考场一个文件）。 */
export const OWNED_ARTIFACT_DIRS = ["按班级考场安排", "考场监考表"] as const;

/**
 * 清掉上一次运行留下的名单产物（复用 `--out-dir` 时必须先做，否则会把旧名单当成本次结果发出去）。
 *
 * 只删**清单里列出的文件**与两个分份目录里的 `*.xlsx`； 目录里若有别的东西（老师自己放的笔记 / 表格），原样保留；分份目录只有在**空了**之后才删除。
 */
export function cleanOwnedArtifacts(
  outDir: string,
  extraFileNames: readonly string[] = [],
): string[] {
  const removed: string[] = [];

  for (const name of [...OWNED_ARTIFACT_FILES, ...extraFileNames]) {
    const filePath = nodePath.join(outDir, name);
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      rmSync(filePath, { force: true });
      removed.push(filePath);
    }
  }

  for (const name of OWNED_ARTIFACT_DIRS) {
    const dirPath = nodePath.join(outDir, name);
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) continue;
    for (const entry of readdirSync(dirPath)) {
      if (!entry.endsWith(".xlsx")) continue; // 用户放进去的别的东西不动
      const entryPath = nodePath.join(dirPath, entry);
      if (statSync(entryPath).isFile()) {
        rmSync(entryPath, { force: true });
        removed.push(entryPath);
      }
    }
    if (readdirSync(dirPath).length === 0) {
      rmSync(dirPath, { recursive: true, force: true });
      removed.push(dirPath);
    }
  }

  return removed;
}

/** 把结果落盘，返回写出的文件与被剔除的空置考场。 */
export function writePlanFiles(result: PlanResult, options: WritePlanOptions): WriteFilesResult {
  // 先校验再建目录：重复 id 的 job 一个文件都不写
  if (options.writeWorkbooks ?? true) assertUniqueRoomIds(options.rooms);
  const outDir = nodePath.resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  // 复用同一个 --out-dir 时，先按清单清掉上一次的名单产物（用户自己的文件不动）
  cleanOwnedArtifacts(outDir, options.fileName === undefined ? [] : [options.fileName]);
  const written: string[] = [];
  let removedRooms: string[] = [];

  if (options.writeWorkbooks ?? true) {
    const mainName = options.fileName ?? "考场安排名单.xlsx";
    const mainPath = nodePath.join(outDir, mainName);
    writeFileSync(mainPath, buildPlanWorkbook(result));
    written.push(mainPath);

    if (options.rooms && options.rooms.length > 0 && result.entries.length > 0) {
      const byId = new Map(options.rooms.map((r) => [r.id, r]));
      const sheetsPath = nodePath.join(outDir, "考场座位表.xlsx");
      writeFileSync(
        sheetsPath,
        buildRoomSheets(result, (roomId) => {
          const room = byId.get(roomId);
          return room
            ? {
                rows: room.rows,
                cols: room.cols,
                name: room.name ?? room.id,
                extraFrontSeats: room.extraFrontSeats,
              }
            : { rows: 1, cols: 1, name: roomId };
        }),
      );
      written.push(sheetsPath);
    }
  }

  // plan.json 保持原样：emptyRooms 等诊断留痕，方便回溯
  const planPath = nodePath.join(outDir, "plan.json");
  writeFileSync(planPath, JSON.stringify(result, null, 2));
  written.push(planPath);

  if (options.writeJson && options.job != null) {
    // 一个考场都没用到 = 这次压根没排出来，不能把 job 掏成空配置；原样落盘留证据
    const used = usedRoomIds(result);
    const pruned = used.length > 0 ? pruneEmptyRooms(options.job, used) : null;
    if (pruned) removedRooms = pruned.removed.map(roomLabel);
    const jobPath = nodePath.join(outDir, "job.json");
    writeFileSync(jobPath, JSON.stringify(pruned?.job ?? options.job, null, 2));
    written.push(jobPath);
  }

  if (options.writeRunInfo ?? true) {
    written.push(
      writeRunInfo(outDir, written, {
        tool: options.tool ?? "exam-seat",
        delivery: result.delivery ?? planDelivery(result.diagnostics),
        exportedWorkbooks: written.some((file) => file.endsWith(".xlsx")),
      }),
    );
  }

  return { files: written, removedRooms, directories: { classFiles: 0, roomFiles: 0 } };
}

/** 去掉控制字符（Windows 文件名不允许）。 */
function stripControlChars(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20) out += char;
  }
  return out;
}

/** 文件名 sanitize：Windows 不允许的字符换 `_`，去首尾空白与结尾的点。 */
function sanitizeFileName(name: string): string {
  const cleaned = stripControlChars(name)
    .replaceAll(/[/\\:*?"<>|]/g, "_")
    .replaceAll(/\s+/g, " ")
    .trim()
    .replaceAll(/[. ]+$/g, "");
  const safe = cleaned === "" ? "未命名" : cleaned;
  return safe.length > 80 ? safe.slice(0, 80).trim() : safe;
}

/** 同名文件自动加 `-2`、`-3`，避免互相覆盖。 */
function uniquePath(dir: string, base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return nodePath.join(dir, `${candidate}.xlsx`);
}

/**
 * 多场次（选科）结果的落盘。
 *
 * 在 `outDir` 下写四样东西：
 *
 * - 合并工作簿 `按班级考场安排.xlsx`（总表 + 每班一张 sheet）、`考场监考表.xlsx`（每套座位一张 sheet）；
 * - `按班级考场安排/` 下每个班一个文件（文件名 = 班级名）；
 * - `考场监考表/` 下每个考场一个文件（文件名 = sheet 名，如 `第一考场（语数外物化生）.xlsx`）；
 * - `plan.json`（原样留证）与剔除空置考场后的 `job.json`。
 */
export function writeMultiPlanFiles(
  result: PlanAllResult,
  options: {
    outDir: string;
    rooms?: RoomSpec[];
    job: Job;
    /** 是否写两份名单工作簿，默认 true；结果为 error（未通过校验）时调用方传 false，只留 plan.json / job.json 作证 */
    writeWorkbooks?: boolean;
    /** `run.json` 里的工具名 + 版本，缺省 `exam-seat` */
    tool?: string;
    /** 是否写 `run.json`，默认 true */
    writeRunInfo?: boolean;
  },
): WriteFilesResult {
  // 先校验再建目录：重复 id 的 job 一个文件都不写
  if (options.writeWorkbooks ?? true) assertUniqueRoomIds(options.rooms);
  const outDir = nodePath.resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  // 复用同一个 --out-dir 时，先按清单清掉上一次的名单产物（含班级变少后留下的旧班级文件）
  cleanOwnedArtifacts(outDir);
  const written: string[] = [];
  const rooms = options.rooms ?? [];
  const title = options.job.meta?.title;
  let directories: WriteDirectories = { classFiles: 0, roomFiles: 0 };

  if (options.writeWorkbooks ?? true) {
    // 合并版：按班级考场安排.xlsx（总表 + 每班一张）
    const classPath = nodePath.join(outDir, "按班级考场安排.xlsx");
    writeFileSync(classPath, buildClassScheduleWorkbook(result, rooms, { title }));
    written.push(classPath);

    // 单班文件：按班级考场安排/<班级>.xlsx
    const classSheets = buildClassScheduleSheets(result, rooms, { title });
    const classUsed = new Set<string>();
    const classPaths: string[] = [];
    if (classSheets.length > 1) {
      const classDir = nodePath.join(outDir, "按班级考场安排");
      mkdirSync(classDir, { recursive: true });
      // 第 0 张是「总表」，其余每张对应一个班
      for (const sheet of classSheets.slice(1)) {
        const filePath = uniquePath(classDir, sanitizeFileName(sheet.name), classUsed);
        writeFileSync(filePath, buildXlsx({ sheets: [sheet], title: sheet.name }));
        classPaths.push(filePath);
        written.push(filePath);
      }
      directories = {
        ...directories,
        classDir,
        classFiles: classPaths.length,
      };
    }

    // 合并版：考场监考表.xlsx（每套座位一张）
    const invigilatorPath = nodePath.join(outDir, "考场监考表.xlsx");
    writeFileSync(invigilatorPath, buildInvigilatorWorkbook(result, rooms));
    written.push(invigilatorPath);

    // 单考场文件：考场监考表/<sheet 名>.xlsx
    const roomSheets = buildInvigilatorSheets(result, rooms);
    if (roomSheets.length > 0) {
      const roomDir = nodePath.join(outDir, "考场监考表");
      mkdirSync(roomDir, { recursive: true });
      const roomUsed = new Set<string>();
      for (const sheet of roomSheets) {
        const filePath = uniquePath(roomDir, sanitizeFileName(sheet.name), roomUsed);
        writeFileSync(filePath, buildXlsx({ sheets: [sheet], title: sheet.name }));
        written.push(filePath);
      }
      directories = { ...directories, roomDir, roomFiles: roomSheets.length };
    }
  }

  // plan.json 保持原样：emptyRooms 等诊断留痕，方便回溯
  const planPath = nodePath.join(outDir, "plan.json");
  writeFileSync(planPath, JSON.stringify(result, null, 2));
  written.push(planPath);

  // 一个考场都没用到 = 这次压根没排出来，不能把 job 掏成空配置；原样落盘留证据
  const used = usedRoomIds(result);
  const pruned = used.length > 0 ? pruneEmptyRooms(options.job, used) : null;
  const jobPath = nodePath.join(outDir, "job.json");
  writeFileSync(jobPath, JSON.stringify(pruned?.job ?? options.job, null, 2));
  written.push(jobPath);

  if (options.writeRunInfo ?? true) {
    written.push(
      writeRunInfo(outDir, written, {
        tool: options.tool ?? "exam-seat",
        delivery: result.delivery ?? planDelivery(result.diagnostics),
        exportedWorkbooks: written.some((file) => file.endsWith(".xlsx")),
      }),
    );
  }

  return {
    files: written,
    removedRooms: pruned ? pruned.removed.map(roomLabel) : [],
    directories,
  };
}
