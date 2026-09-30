import type { Diagnostic, Job, PlanOptions, PlanResult } from "@exam-seat/core";

/** 主线程 ↔ 求解 Worker 的消息契约。求解是纯同步计算，Worker 只负责别卡住界面。 */
export interface SolverRequest {
  id: number;
  job: Job;
  overrides?: PlanOptions;
}

export type SolverStage = "precheck" | "plan";

export type SolverResponse =
  | { id: number; type: "stage"; stage: SolverStage }
  | { id: number; type: "precheck"; fatal: boolean; diagnostics: Diagnostic[] }
  | { id: number; type: "done"; result: PlanResult }
  | { id: number; type: "error"; message: string };
