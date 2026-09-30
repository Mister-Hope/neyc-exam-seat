import { plan, precheckJob } from "@exam-seat/core";

import type { SolverRequest, SolverResponse } from "./solver-protocol";

/**
 * 求解 Worker：主线程只负责进度与取消，`plan()` 全程在这里跑，界面不卡。
 *
 * 取消 = 主线程 `worker.terminate()`：`plan()` 是同步纯函数，没法中途打断， 所以用整个 Worker 的生命周期来表达取消，这也是最干净的做法。
 */
interface WorkerScope {
  postMessage(message: SolverResponse): void;
  onmessage: ((event: MessageEvent<SolverRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent<SolverRequest>) => {
  const { id, job, overrides } = event.data;
  try {
    scope.postMessage({ id, type: "stage", stage: "precheck" });
    const pre = precheckJob(job, overrides);
    scope.postMessage({ id, type: "precheck", fatal: pre.fatal, diagnostics: pre.diagnostics });

    scope.postMessage({ id, type: "stage", stage: "plan" });
    const result = plan(job, overrides);
    scope.postMessage({ id, type: "done", result });
  } catch (err) {
    scope.postMessage({
      id,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
