import type { Diagnostic } from "./types";

/**
 * 「限定过紧」类的预检 error：`relax !== "none"` 时**不判死**，并降级为 warning 后交付。
 *
 * 它们描述的是「限定太紧，硬排排不出来」，而 `--relax` 的价值恰恰是把限定降级为惩罚、求出违反最少的方案。
 * 结构性错误（没考场、座位不够、名单有重复学号……）无论怎么放宽都救不了，**不在**这里。
 */
export const SOFTENABLE_CODES: ReadonlySet<string> = new Set([
  "CONSTRAINT_EMPTY_DOMAIN",
  "CONSTRAINT_INDEX_OUT_OF_RANGE",
  "CONSTRAINT_OVERSATURATED",
  "RULE_INTERSECT_EMPTY",
  "SEAT_CONFLICT",
]);

/**
 * 允许「带 error 仍可交付」的诊断码：只有这些 error 不阻断导出，其余 error 一律视为不可交付。
 *
 * - `SEARCH_FAILED`：求解没排满（严格模式下也是 error），沿用旧语义照常导出（退出码 2 = 主动降级）；
 * - `CONSTRAINT_UNMET` / `ADJACENCY_CONFLICT`：`--relax`（softConstraints / minConflicts）**有意设计**的
 *   「违反最少并交付」，是校验器报的规则类问题，不是结构性损坏。
 *
 * 除此之外的任何 error（含校验器的 `ENTRY_*`、专属组合不符、以及 {@link BLOCKING_EXPORT_CODES} 里的全部码） 都判定为 `blocked` ——
 * 宁可多拦，也不能把错误名单交给老师。
 */
export const DEGRADABLE_ERROR_CODES: ReadonlySet<Diagnostic["code"]> = new Set<Diagnostic["code"]>([
  "SEARCH_FAILED",
  "CONSTRAINT_UNMET",
  "ADJACENCY_CONFLICT",
]);

/**
 * 会阻止「导出名单 / 监考表」的错误码（`docs/design.md` §8.1）。
 *
 * 只收**结构性**错误与硬规则违规：这些错误下座位表本身是错的，导出只会误导老师。
 *
 * ⚠️ 与 {@link SOFTENABLE_CODES} **必须保持不相交**（有一条源码级断言在测）：软化码在 relax 下会被 降级成
 * warning，若它们同时又在阻断表里，就会出现「严重级说可交付、码表说不可交付」的矛盾 —— 那正是 R-6/F-1 的温床。`SEARCH_FAILED` 也不在表里：`--relax`
 * 本来就是「违反最少并交付」， 拦下来会打断 L2/L3 这条路；降级结果照常导出，靠黄色横幅 + 校验报告 + 退出码 2 表达。
 */
export const BLOCKING_EXPORT_CODES: ReadonlySet<Diagnostic["code"]> = new Set<Diagnostic["code"]>([
  "ROOM_SUBJECT_CLASH",
  "CAPACITY_INSUFFICIENT",
  "NO_STUDENTS",
  "NO_ROOMS",
  "INVALID_ROOM_SIZE",
  "STUDENT_DUPLICATE_ID",
  "STUDENT_MISSING_CLASS",
  "CLASS_LIMIT_EXCEEDED",
  "UNKNOWN_ROOM_ID",
  "CONSTRAINT_NO_SELECTOR",
  // 借考/显式时段的硬性失败都必须拦住导出
  "SUBJECT_ROOM_UNKNOWN_ROOM",
  "SUBJECT_ROOM_UNKNOWN_SUBJECT",
  "SUBJECT_ROOM_CLASH",
  "SUBJECT_ROOM_NO_SEAT",
  "SUBJECT_ROOM_NO_SLOT",
  "SLOTS_CONFLICT",
]);

/**
 * 用户显式放宽（`relax !== "none"`）时，把 {@link SOFTENABLE_CODES} 的预检 error **原地降级为 warning**。
 *
 * 为什么可以降级：**预检只是「求解前的建议」，真正的大门是独立校验器** —— relax 场景下用户已明确授权 「违反最少并交付」，而真正的结构性错误（重复占座 / 未知学生 / 漏排 /
 * 编号不符）仍会被 `validate()` 抓成 `ENTRY_*`，fail-closed 判 `blocked`。所以软化预检码**不会**让错误名单被导出。
 *
 * 保留原 code 与 evidence（新增 `downgradedFrom: "error"` 留痕），报告里仍能看见发生了什么。
 */
export function downgradeSoftenedDiagnostics(diagnostics: Diagnostic[]): void {
  for (let i = 0; i < diagnostics.length; i += 1) {
    const diagnostic = diagnostics[i]!;
    if (diagnostic.severity !== "error") continue;
    if (!SOFTENABLE_CODES.has(diagnostic.code)) continue;
    diagnostics[i] = {
      ...diagnostic,
      severity: "warning",
      evidence: { ...diagnostic.evidence, downgradedFrom: "error" },
    };
  }
}
