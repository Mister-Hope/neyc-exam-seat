import {
  BLOCKING_EXPORT_CODES,
  DEGRADABLE_ERROR_CODES,
  SOFTENABLE_CODES,
  downgradeSoftenedDiagnostics,
} from "./diagnostics-policy";
import { compileDomains } from "./domain";
import type { DomainBundle } from "./domain";
import { compileModel } from "./model";
import type { CompiledModel } from "./model";
import { toPhysicalCol } from "./numbering";
import type { PlanAllResult } from "./plan-all";
import { describeRoomLoad, resolveAdjacency, runPrecheck, validateRoomGeometry } from "./precheck";
import { solve } from "./solver";
import type {
  Adjacency,
  Diagnostic,
  GroupPreference,
  Job,
  PlanDelivery,
  PlanEntry,
  PlanLevel,
  PlanOptions,
  PlanResult,
  PlanStats,
  RelaxMode,
  Suggestion,
  UnmetConstraint,
  ValidationIssue,
  ValidationReport,
} from "./types";
import { fingerprint, isSameClassRelaxed, roomCombination } from "./util";
import { validate } from "./validate";

export const DEFAULT_SEED = 20260930;
export const DEFAULT_TIME_LIMIT_MS = 10_000;
export const RESULT_VERSION = 1;

/**
 * 分房倾向只认两个合法取值。
 *
 * Job.json 是用户手写的，可能写错（例如 `fillroom`）。未知取值一律退回最严格的 `sameCombination` —— **绝不**因为拼写错误就静默启用混排；考场不够时报
 * `CAPACITY_INSUFFICIENT`，让老师看得见。
 */
export function normalizeGroupPreference(value: GroupPreference | undefined): GroupPreference {
  return value === "fillRooms" ? "fillRooms" : "sameCombination";
}

export function normalizeOptions(options?: PlanOptions): Required<PlanOptions> {
  return {
    seed: options?.seed ?? DEFAULT_SEED,
    adjacency: options?.adjacency ?? "king",
    forceKing: options?.forceKing ?? false,
    relax: options?.relax ?? "none",
    timeLimitMs: options?.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS,
    groupPreference: normalizeGroupPreference(options?.groupPreference),
    regularCombinations: options?.regularCombinations ?? [],
    maxRoomsPerStudent: options?.maxRoomsPerStudent ?? 3,
    slots: options?.slots ?? [],
    forbiddenSameSlot: options?.forbiddenSameSlot ?? [],
  };
}

export interface PrecheckOutput {
  diagnostics: Diagnostic[];
  fatal: boolean;
  /** 被 `relax` 软化（error → warning）的预检诊断；`relax === "none"` 时恒为空 */
  softened: Diagnostic[];
  adjacency: Adjacency;
  downgraded: boolean;
  options: Required<PlanOptions>;
  domains: DomainBundle;
  model: CompiledModel;
}

/**
 * 预检结果是否致命。放宽模式下，只有结构性错误才算致命（`SOFTENABLE_CODES` 那几条会软化成 warning）。
 *
 * `precheckJob()` 已经按这个规则把软化码降级并放进 `softened`；这个函数留给直接拿到**原始** 预检诊断的调用方（例如自定义流程 / 脚本）。
 */
export function isFatal(
  diagnostics: readonly Diagnostic[],
  relax: RelaxMode,
): { fatal: boolean; softened: Diagnostic[] } {
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length === 0) return { fatal: false, softened: [] };
  if (relax === "none") return { fatal: true, softened: [] };
  const softened = errors.filter((d) => SOFTENABLE_CODES.has(d.code));
  const hard = errors.filter((d) => !SOFTENABLE_CODES.has(d.code));
  return { fatal: hard.length > 0, softened };
}

/** 只做预检：判断有没有解、为什么没解、怎么放宽。不进求解器。 */
export function precheckJob(job: Job, overrides?: PlanOptions): PrecheckOutput {
  const options = normalizeOptions({ ...job.options, ...overrides });
  const { adjacency, downgraded } = resolveAdjacency(job, options.adjacency, options.forceKing);
  // 房间几何校验必须在 compileModel 之前：非法/超大尺寸要在建模型时就被拦住，
  // 不能等到几何函数里抛异常（铁律 3：业务失败只用诊断表达）。
  const geometry = validateRoomGeometry(job);
  const geometryFatal = geometry.some((diagnostic) => diagnostic.severity === "error");
  const model = compileModel(job, adjacency);
  // 几何已经非法（含超出尺寸上限）时不再跑后续预检：模型里的这些考场已被安全钳制为空，
  // 再往下跑只会产出「座位不够 / 建议加考场」之类的噪音诊断（甚至生成海量建议）。**必须在
  // `compileModel` 之前判定并钳制**，否则畸形尺寸会直接 OOM（见 room-limits.ts）。
  const pre = geometryFatal
    ? { diagnostics: [] as Diagnostic[], fatal: true, domains: compileDomains(model) }
    : runPrecheck(model, { adjacency, downgraded, relax: options.relax });
  const diagnostics = [...geometry, ...pre.diagnostics];
  // 用户显式放宽：把「限定过紧」的预检 error 降级为 warning（保留 code/evidence），
  // 这样 `planDelivery()` 才会给 `ready-with-warnings` 而不是 fail-closed 的 `blocked`（F-1）。
  const softened =
    options.relax === "none"
      ? []
      : diagnostics.filter(
          (diagnostic) => diagnostic.severity === "error" && SOFTENABLE_CODES.has(diagnostic.code),
        );
  if (softened.length > 0) downgradeSoftenedDiagnostics(diagnostics);
  return {
    diagnostics,
    fatal: pre.fatal || geometryFatal,
    softened,
    adjacency,
    downgraded,
    options,
    domains: pre.domains,
    model,
  };
}

/**
 * 由诊断列表判定交付状态 —— core 的**唯一判据**（`PlanResult.delivery` / `PlanAllResult.delivery` 都出自它）。
 *
 * Fail-closed：除 {@link DEGRADABLE_ERROR_CODES} 之外的任何 error 都 `blocked`。
 */
export function planDelivery(diagnostics: readonly Diagnostic[]): PlanDelivery {
  let degraded = false;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") {
      if (!DEGRADABLE_ERROR_CODES.has(diagnostic.code)) return "blocked";
      degraded = true;
    } else if (diagnostic.severity === "warning") {
      degraded = true;
    }
  }
  return degraded ? "ready-with-warnings" : "ready";
}

/** 校验器的 issue → 顶层诊断：**保留原始码**（不再统一泛化成 `SEARCH_FAILED`），结构性错误才能被门禁看见。 */
export function validationIssueDiagnostics(issues: readonly ValidationIssue[]): Diagnostic[] {
  return issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => ({
      code: issue.code as Diagnostic["code"],
      severity: "error" as const,
      message: issue.message,
      evidence: issue.refs ?? {},
      suggestions: [],
    }));
}

function validationDiagnostics(report: ValidationReport): Diagnostic[] {
  return validationIssueDiagnostics(report.issues);
}

/**
 * 导出前要不要阻止导出名单 / 监考表 —— 导出闸门的**唯一判据**（铁律 4）。
 *
 * 既能吃完整结果（`plan()` / `planAll()` 的产物，优先看 `result.delivery`，core 已按独立校验判定）， 也能吃诊断数组（老签名）。 结果没写
 * `delivery` 时按码兜底：{@link BLOCKING_EXPORT_CODES} ∪ 「不可降级的 error」。
 */
export function blocksListExport(
  source: PlanResult | PlanAllResult | readonly Diagnostic[],
): boolean {
  if (isDiagnosticList(source)) return blocksListExportByCodes(source);
  if (source.delivery === "blocked") return true;
  if (source.delivery === "ready" || source.delivery === "ready-with-warnings") return false;
  return blocksListExportByCodes(source.diagnostics);
}

/** 类型守卫：`Array.isArray` 会把联合类型收窄成 `any[]`，单独包一层拿回精确元素类型。 */
function isDiagnosticList(
  value: PlanResult | PlanAllResult | readonly Diagnostic[],
): value is readonly Diagnostic[] {
  return Array.isArray(value);
}

/**
 * 按诊断码兜底判定（不依赖 `delivery`）。
 *
 * 两道网：`BLOCKING_EXPORT_CODES`（设计文档 §8.1 的结构性错误清单）+ 任何**不可降级**的 error （含校验器原始码
 * `ENTRY_*`、专属组合不符等新码，防止将来漏登记）。
 */
function blocksListExportByCodes(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some(
    (diagnostic) =>
      diagnostic.severity === "error" &&
      (BLOCKING_EXPORT_CODES.has(diagnostic.code) || !DEGRADABLE_ERROR_CODES.has(diagnostic.code)),
  );
}

/**
 * 对**可能被改动过的**结果做独立复算（导出前的最后一道闸门）。
 *
 * 篡改类错误（重复占座 / 未知学生 / 漏排……）发生在 `plan()` 之后，结果自带的 `delivery` 已经过时； 这个函数重跑一遍 `validate()`
 * 再判定，导出层应当在写文件前调用它。
 */
export function evaluateDelivery(job: Job, result: PlanResult): PlanDelivery {
  return planDelivery([...result.diagnostics, ...validationDiagnostics(validate(job, result))]);
}

/** `plan` 的内部开关（不是用户选项）：`planAll` 逐套座位求解时用它说明「这不是用户意义上的单场」， 免得单场专属的诊断（如专属组合被忽略）混进多场次的每套房结果里。 */
export interface PlanRunFlags {
  fromPlanAll?: boolean;
}

/** 主入口：预检 → 求解 → 自校验 → 出结果。同输入同 seed 必得同结果。 */
export function plan(job: Job, overrides?: PlanOptions, flags?: PlanRunFlags): PlanResult {
  const started = Date.now();
  const pre = precheckJob(job, overrides);
  const { model, options, adjacency, downgraded } = pre;
  const diagnostics: Diagnostic[] = [...pre.diagnostics];

  // 单场模式只有一场考试（所有人同一份卷子）：「专属组合」是多场次概念，这里忽略它但绝不静默
  // （planAll 的每套房求解会传 fromPlanAll，避免把这条诊断带进多场次结果）
  if (flags?.fromPlanAll !== true) {
    for (const room of model.rooms) {
      const combination = roomCombination(room.spec);
      if (combination === undefined) continue;
      const raw = room.spec.name?.trim() ?? "";
      const label = raw === "" ? room.spec.id : raw;
      diagnostics.push({
        code: "ROOM_COMBINATION_IGNORED_SINGLE",
        severity: "warning",
        message: `单场模式下所有考生考同一份卷子，${label}的专属组合「${combination}」不生效（按普通考场处理）`,
        evidence: { roomId: room.spec.id, combination },
        suggestions: [],
      });
    }
  }

  // 考场级放宽（`RoomSpec.relaxSameClass`）是一次真实放宽，级别高于「班级数不足自动退化」
  const hasRelaxedRoom = model.rooms.some((room) => isSameClassRelaxed(room.spec));
  const level: PlanLevel =
    options.relax === "minConflicts"
      ? "minConflicts"
      : options.relax === "softConstraints"
        ? "softConstraints"
        : hasRelaxedRoom
          ? "roomRelaxed"
          : downgraded
            ? "orthogonal"
            : "strict";

  // 预检诊断已经按 relax 软化过（`pre.softened` 是降级前的快照）：剩下还是 error 的才是真致命
  const { fatal, softened } = {
    fatal: diagnostics.some((d) => d.severity === "error"),
    softened: pre.softened,
  };

  if (softened.length > 0) {
    diagnostics.push({
      code: "SEARCH_FAILED",
      severity: "warning",
      message: `已按放宽模式处理：${softened.length} 条限定过紧，改为「尽量满足」而不是直接判死`,
      evidence: { softened: softened.map((d) => d.code) },
      suggestions: [],
    });
  }

  if (fatal) {
    return {
      resultVersion: RESULT_VERSION,
      ok: false,
      delivery: planDelivery(diagnostics),
      level,
      stats: emptyStats(model, options, started),
      entries: [],
      conflicts: [],
      unmetConstraints: [],
      diagnostics,
      inputFingerprint: fingerprint(job),
      generatedAt: new Date().toISOString(),
    };
  }

  const solved = solve({
    model,
    domains: pre.domains.domains,
    adjacency,
    seed: options.seed,
    timeLimitMs: options.timeLimitMs,
    relax: options.relax,
  });

  const roomIndexOf = new Map(model.rooms.map((r, i) => [r.spec.id, i]));
  const entries: PlanEntry[] = [];
  for (let i = 0; i < model.students.length; i += 1) {
    const seat = solved.seatOfStudent[i]!;
    if (seat < 0) continue;
    const room = model.rooms[model.seatRoom[seat]!]!;
    const col = model.seatCol[seat]!;
    entries.push({
      studentId: model.students[i]!.id,
      name: model.students[i]!.name,
      className: model.students[i]!.className,
      roomId: room.spec.id,
      roomName: room.spec.name ?? room.spec.id,
      seatNo: model.seatNo[seat]!,
      row: model.seatRow[seat]!,
      col,
      physicalCol: toPhysicalCol(col, room.spec.cols, room.doorSide),
    });
  }
  entries.sort((a, b) => {
    const ra = roomIndexOf.get(a.roomId) ?? 0;
    const rb = roomIndexOf.get(b.roomId) ?? 0;
    if (ra !== rb) return ra - rb;
    return a.seatNo - b.seatNo;
  });

  const usedRooms = new Set(entries.map((e) => e.roomId));
  const emptyRooms = model.rooms.filter((r) => !usedRooms.has(r.spec.id)).map((r) => r.spec.id);

  const unmetConstraints: UnmetConstraint[] = [];
  // 违反限定的两类人：**坐下了但不在域内**（用户显式 relax 时才会出现）、以及**域内没空位而没座位**的
  const unmetIndices = [
    ...solved.violatedStudents,
    ...solved.unplacedStudents.filter(
      (index) => (pre.domains.studentConstraints[index] ?? []).length > 0,
    ),
  ];
  if (unmetIndices.length > 0) {
    const byConstraint = new Map<string, string[]>();
    for (const si of unmetIndices) {
      const hits = pre.domains.studentConstraints[si] ?? [];
      for (const ci of hits) {
        const c = pre.domains.constraintSets[ci]!.constraint;
        const list = byConstraint.get(c.id) ?? [];
        list.push(model.students[si]!.id);
        byConstraint.set(c.id, list);
      }
    }
    for (const [constraintId, studentIds] of byConstraint) {
      unmetConstraints.push({
        constraintId,
        studentIds,
        reason:
          solved.violatedStudents.length > 0
            ? "座位不够或与其它限定冲突，已按「违反最少」安排"
            : "限定范围内的座位被占满，该生没有安排座位（宁可不排也不越域）",
      });
    }
  }

  const stats: PlanStats = {
    students: (job.students ?? []).length,
    participants: model.students.length,
    excluded: model.excluded.length,
    rooms: model.rooms.length,
    roomsUsed: usedRooms.size,
    emptyRooms,
    seatsTotal: model.seatCount,
    seatsUsed: entries.length,
    conflicts: solved.conflictCount,
    unmetConstraints: unmetIndices.length,
    classes: model.classNames.length,
    elapsedMs: Date.now() - started,
    seed: options.seed,
    adjacency,
    iterations: solved.iterations,
  };

  // 墙钟兜底命中：结果不完整，如实报一条 warning（正常路径恒不触发；预算是迭代次数，与时间无关）
  if (solved.truncated) {
    diagnostics.push({
      code: "TIME_LIMIT_REACHED",
      severity: "warning",
      message: `求解耗时远超时间预算，已被兜底掐断（迭代 ${solved.iterations} / 预算 ${solved.iterationBudget}），结果可能不完整`,
      evidence: {
        iterations: solved.iterations,
        iterationBudget: solved.iterationBudget,
        elapsedMs: Date.now() - started,
        timeLimitMs: options.timeLimitMs,
      },
      suggestions: [],
    });
  }

  const ok =
    solved.conflictCount === 0 &&
    solved.violatedStudents.length === 0 &&
    solved.unplacedStudents.length === 0 &&
    solved.capViolationCount === 0;

  if (!ok) {
    diagnostics.push(
      buildFailureDiagnostic(model, solved.studentAtSeat, stats, options, downgraded, {
        capViolations: solved.capViolationCount,
        unplaced: solved.unplacedStudents.length,
        iterations: solved.iterations,
        iterationBudget: solved.iterationBudget,
      }),
    );
  }

  const result: PlanResult = {
    resultVersion: RESULT_VERSION,
    ok,
    level,
    stats,
    entries,
    conflicts: solved.conflicts,
    unmetConstraints,
    diagnostics,
    inputFingerprint: fingerprint(job),
    generatedAt: new Date().toISOString(),
  };

  // 自校验：校验器与求解器分开实现，不通过就拒绝交付。
  // 原始 issue 码直接作为顶层诊断（结构性错误必须被导出门禁看见），不再统一泛化成 SEARCH_FAILED。
  const report = validate(job, result);
  if (!report.ok) {
    result.diagnostics.push(...validationDiagnostics(report).slice(0, 20));
    result.ok = false;
  }
  result.delivery = planDelivery(result.diagnostics);

  return result;
}

function emptyStats(
  model: CompiledModel,
  options: Required<PlanOptions>,
  started: number,
): PlanStats {
  return {
    students: (model.job.students ?? []).length,
    participants: model.students.length,
    excluded: model.excluded.length,
    rooms: model.rooms.length,
    roomsUsed: 0,
    emptyRooms: model.rooms.map((r) => r.spec.id),
    seatsTotal: model.seatCount,
    seatsUsed: 0,
    conflicts: 0,
    unmetConstraints: 0,
    classes: model.classNames.length,
    elapsedMs: Date.now() - started,
    seed: options.seed,
    adjacency: options.adjacency,
  };
}

function buildFailureDiagnostic(
  model: CompiledModel,
  studentAtSeat: Int32Array,
  stats: PlanStats,
  options: Required<PlanOptions>,
  downgraded: boolean,
  extras: {
    capViolations?: number;
    unplaced?: number;
    iterations?: number;
    iterationBudget?: number;
  } = {},
): Diagnostic {
  const capViolations = extras.capViolations ?? 0;
  const load = describeRoomLoad(model, studentAtSeat);
  const parts: string[] = [];
  if (stats.conflicts > 0) parts.push(`${stats.conflicts} 处相邻同班`);
  if (stats.unmetConstraints > 0) parts.push(`${stats.unmetConstraints} 个人没坐上限定位置`);
  if (capViolations > 0) parts.push(`${capViolations} 人次超出考场同班上限`);
  if ((extras.unplaced ?? 0) > 0) parts.push(`${extras.unplaced} 个人在限定范围内没有空位`);
  const message = `在现有条件下排不满：还剩 ${parts.join("、")}`;

  const suggestions: Suggestion[] = [];

  if (stats.adjacency === "king") {
    suggestions.push({
      id: "relax-orthogonal",
      label: "降级：只要求前后左右不同班，对角允许同班",
      effect: "通常可以立刻排满，但严格程度下降",
      patch: [{ op: "add", path: "/options/adjacency", value: "orthogonal" }],
    });
  }
  if (options.relax === "none") {
    suggestions.push({
      id: "relax-soft",
      label: "降级：限定不再强制，改为「违反最少」",
      effect: "尽量满足限定，但不保证全部满足",
      patch: [{ op: "add", path: "/options/relax", value: "softConstraints" }],
    });
  }
  suggestions.push({
    id: "relax-min-conflicts",
    label: "降级：不求全满足，只求冲突最少",
    effect: "冲突会标红列出来，交由人工微调",
    patch: [{ op: "add", path: "/options/relax", value: "minConflicts" }],
  });
  if (!downgraded) {
    suggestions.push({
      id: "add-rooms",
      label: "增加考场数量",
      effect: "考场越多，同班学生越容易散开",
      patch: [
        {
          op: "add",
          path: "/rooms/-",
          value: {
            id: `R${model.rooms.length + 1}`,
            name: `第${model.rooms.length + 1}考场`,
            rows: 7,
            cols: 6,
            doorSide: "right",
          },
        },
      ],
    });
  }

  return {
    code: "SEARCH_FAILED",
    severity: "error",
    message,
    evidence: {
      conflicts: stats.conflicts,
      unmetConstraints: stats.unmetConstraints,
      bottleneck: load,
      emptyRooms: stats.emptyRooms,
      iterations: extras.iterations ?? 0,
      iterationBudget: extras.iterationBudget ?? 0,
    },
    suggestions,
  };
}
