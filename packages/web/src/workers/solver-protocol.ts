import type { Diagnostic, Job, PlanAllResult, PlanOptions, PlanResult } from "@exam-seat/core";

/**
 * 求解模式。
 *
 * - `single`：单场 `plan()`，没有选科字段的名单走这条，行为与多场次上线前完全一致。
 * - `all`：多场次 `planAll()`，名单里带选科（`combination` / `subjects`）时走这条。
 */
export type SolverMode = "single" | "all";

/** 主线程 ↔ 求解 Worker 的消息契约。求解是纯同步计算，Worker 只负责别卡住界面。 */
export interface SolverRequest {
  id: number;
  job: Job;
  overrides?: PlanOptions;
  /** 缺省 `single`：老调用方不传时行为不变。 */
  mode?: SolverMode;
}

export type SolverStage = "precheck" | "plan";

export type SolverResponse =
  | { id: number; type: "stage"; stage: SolverStage }
  | { id: number; type: "precheck"; fatal: boolean; diagnostics: Diagnostic[] }
  | { id: number; type: "done"; mode: "single"; result: PlanResult }
  | { id: number; type: "done"; mode: "all"; result: PlanAllResult }
  | { id: number; type: "error"; message: string };
