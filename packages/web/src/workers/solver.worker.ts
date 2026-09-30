import { plan, planAll, precheckJob } from "@exam-seat/core";

import type { SolverRequest, SolverResponse } from "./solver-protocol";

/**
 * 求解 Worker：主线程只负责进度与取消，`plan()` / `planAll()` 全程在这里跑，界面不卡。
 *
 * 取消 = 主线程 `worker.terminate()`：求解是同步纯函数，没法中途打断， 所以用整个 Worker 的生命周期来表达取消，这也是最干净的做法。
 *
 * `mode` 缺省 `single`：单场路径与多场次上线前完全一致；`all` 时调 core 的 `planAll`， `done` 携带 `PlanAllResult`。
 */
interface WorkerScope {
  postMessage: (message: SolverResponse) => void;
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<SolverRequest>) => void,
  ) => void;
}

// Worker 里 globalThis 就是 worker 的全局作用域（没有 window），与 self 等价
const scope = globalThis as unknown as WorkerScope;

scope.addEventListener("message", (event: MessageEvent<SolverRequest>) => {
  const { id, job, overrides, mode = "single" } = event.data;
  try {
    scope.postMessage({ id, type: "stage", stage: "precheck" });
    const pre = precheckJob(job, overrides);
    scope.postMessage({ id, type: "precheck", fatal: pre.fatal, diagnostics: pre.diagnostics });

    scope.postMessage({ id, type: "stage", stage: "plan" });
    if (mode === "all") {
      scope.postMessage({ id, type: "done", mode: "all", result: planAll(job, overrides) });
    } else {
      scope.postMessage({ id, type: "done", mode: "single", result: plan(job, overrides) });
    }
  } catch (err) {
    scope.postMessage({
      id,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
