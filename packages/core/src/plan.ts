import type { DomainBundle } from "./domain";
import { compileModel } from "./model";
import type { CompiledModel } from "./model";
import { toPhysicalCol } from "./numbering";
import { describeRoomLoad, resolveAdjacency, runPrecheck } from "./precheck";
import { solve } from "./solver";
import type {
  Adjacency,
  Diagnostic,
  Job,
  PlanEntry,
  PlanLevel,
  PlanOptions,
  PlanResult,
  PlanStats,
  RelaxMode,
  Suggestion,
  UnmetConstraint,
} from "./types";
import { fingerprint } from "./util";
import { validate } from "./validate";

export const DEFAULT_SEED = 20260930;
export const DEFAULT_TIME_LIMIT_MS = 10_000;
export const RESULT_VERSION = 1;

export function normalizeOptions(options?: PlanOptions): Required<PlanOptions> {
  return {
    seed: options?.seed ?? DEFAULT_SEED,
    adjacency: options?.adjacency ?? "king",
    forceKing: options?.forceKing ?? false,
    relax: options?.relax ?? "none",
    timeLimitMs: options?.timeLimitMs ?? DEFAULT_TIME_LIMIT_MS,
  };
}

export interface PrecheckOutput {
  diagnostics: Diagnostic[];
  fatal: boolean;
  adjacency: Adjacency;
  downgraded: boolean;
  options: Required<PlanOptions>;
  domains: DomainBundle;
  model: CompiledModel;
}

/** 只做预检：判断有没有解、为什么没解、怎么放宽。不进求解器。 */
export function precheckJob(job: Job, overrides?: PlanOptions): PrecheckOutput {
  const options = normalizeOptions({ ...job.options, ...overrides });
  const { adjacency, downgraded } = resolveAdjacency(job, options.adjacency, options.forceKing);
  const model = compileModel(job, adjacency);
  const pre = runPrecheck(model, { adjacency, downgraded, relax: options.relax });
  return {
    diagnostics: pre.diagnostics,
    fatal: pre.fatal,
    adjacency,
    downgraded,
    options,
    domains: pre.domains,
    model,
  };
}

/**
 * 这些诊断在 `relax != 'none'` 时**不应该**直接判死： 它们描述的是「限定太紧」，而软约束模式的价值恰恰是把限定降级为惩罚、求出违反最少的方案。
 * 结构性错误（没考场、座位不够、名单有重复学号……）无论怎么放宽都救不了，仍然致命。
 */
const SOFTENABLE_CODES: ReadonlySet<string> = new Set([
  "CONSTRAINT_EMPTY_DOMAIN",
  "CONSTRAINT_INDEX_OUT_OF_RANGE",
  "CONSTRAINT_OVERSATURATED",
  "RULE_INTERSECT_EMPTY",
  "SEAT_CONFLICT",
]);

/** 预检结果是否致命。放宽模式下，只有结构性错误才算致命。 */
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

/** 主入口：预检 → 求解 → 自校验 → 出结果。同输入同 seed 必得同结果。 */
export function plan(job: Job, overrides?: PlanOptions): PlanResult {
  const started = Date.now();
  const pre = precheckJob(job, overrides);
  const { model, options, adjacency, downgraded } = pre;
  const diagnostics: Diagnostic[] = [...pre.diagnostics];

  const level: PlanLevel =
    options.relax === "minConflicts"
      ? "minConflicts"
      : options.relax === "softConstraints"
        ? "softConstraints"
        : downgraded
          ? "orthogonal"
          : "strict";

  const { fatal, softened } = isFatal(pre.diagnostics, options.relax);

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
  if (solved.violatedStudents.length > 0) {
    const byConstraint = new Map<string, string[]>();
    for (const si of solved.violatedStudents) {
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
        reason: "座位不够或与其它限定冲突，已按「违反最少」安排",
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
    unmetConstraints: solved.violatedStudents.length,
    classes: model.classNames.length,
    elapsedMs: Date.now() - started,
    seed: options.seed,
    adjacency,
  };

  const ok =
    solved.conflictCount === 0 &&
    solved.violatedStudents.length === 0 &&
    solved.unplacedStudents.length === 0;

  if (!ok) {
    diagnostics.push(
      buildFailureDiagnostic(model, solved.studentAtSeat, stats, options, downgraded),
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

  // 自校验：校验器与求解器分开实现，不通过就拒绝交付
  const report = validate(job, result);
  if (!report.ok) {
    for (const issue of report.issues.filter((i) => i.severity === "error").slice(0, 20)) {
      result.diagnostics.push({
        code: "SEARCH_FAILED",
        severity: "error",
        message: `自校验未通过：${issue.message}`,
        evidence: { validatorCode: issue.code, ...issue.refs },
        suggestions: [],
      });
    }
    result.ok = false;
  }

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
): Diagnostic {
  const load = describeRoomLoad(model, studentAtSeat);
  const parts: string[] = [];
  if (stats.conflicts > 0) parts.push(`${stats.conflicts} 处相邻同班`);
  if (stats.unmetConstraints > 0) parts.push(`${stats.unmetConstraints} 个人没坐上限定位置`);
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
    },
    suggestions,
  };
}
