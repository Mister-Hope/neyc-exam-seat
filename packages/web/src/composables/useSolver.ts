import { onScopeDispose, ref, shallowRef } from "vue";

import type { SolverResponse, SolverStage } from "@/workers/solver-protocol";
import type { Diagnostic, Job, PlanOptions, PlanResult } from "@exam-seat/core";

/**
 * 在主线程里驱动求解 Worker：进度、预检诊断、取消。
 *
 * 进度是「阶段 + 已用时间」推出来的：`plan()` 是同步的，没法上报细粒度百分比， 所以按 `timeLimitMs` 折算到 55% → 95%，到点了也不假装 100%，等真正的结果。
 */
export function useSolver() {
  const running = ref(false);
  const stage = ref<SolverStage | "idle">("idle");
  const progress = ref(0);
  const elapsedMs = ref(0);
  const error = ref("");
  const precheckDiagnostics = ref<Diagnostic[]>([]);
  const precheckFatal = ref(false);

  const worker = shallowRef<Worker | null>(null);
  let timer: ReturnType<typeof setInterval> | null = null;
  let sequence = 0;

  function stopTimer(): void {
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function teardown(): void {
    worker.value?.terminate();
    worker.value = null;
    stopTimer();
    running.value = false;
    stage.value = "idle";
  }

  /** 取消：直接终止 Worker（同步求解无法协作式中断）。 */
  function cancel(): void {
    if (!running.value && worker.value == null) return;
    teardown();
    progress.value = 0;
  }

  function reset(): void {
    cancel();
    progress.value = 0;
    elapsedMs.value = 0;
    error.value = "";
    precheckDiagnostics.value = [];
    precheckFatal.value = false;
  }

  async function run(job: Job, overrides?: PlanOptions): Promise<PlanResult | null> {
    teardown();
    sequence += 1;
    const id = sequence;
    running.value = true;
    error.value = "";
    elapsedMs.value = 0;
    progress.value = 5;
    stage.value = "precheck";
    precheckDiagnostics.value = [];
    precheckFatal.value = false;

    const startedAt = Date.now();
    const limit = Math.max(1000, overrides?.timeLimitMs ?? job.options?.timeLimitMs ?? 10_000);

    const instance = new Worker(new URL("../workers/solver.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.value = instance;

    timer = setInterval(() => {
      elapsedMs.value = Date.now() - startedAt;
      if (stage.value === "plan") {
        const ratio = Math.min(1, elapsedMs.value / limit);
        progress.value = Math.max(progress.value, 55 + ratio * 40);
      }
    }, 120);

    return new Promise<PlanResult | null>((resolve) => {
      const finish = (value: PlanResult | null): void => {
        if (id === sequence) teardown();
        resolve(value);
      };
      instance.addEventListener("message", (event: MessageEvent<SolverResponse>) => {
        const { data } = event;
        if (data.id !== id || id !== sequence) return;
        switch (data.type) {
          case "stage": {
            stage.value = data.stage;
            progress.value = Math.max(progress.value, data.stage === "precheck" ? 15 : 55);
            break;
          }
          case "precheck": {
            precheckDiagnostics.value = data.diagnostics;
            precheckFatal.value = data.fatal;
            break;
          }
          case "done": {
            progress.value = 100;
            finish(data.result);
            break;
          }
          case "error": {
            error.value = data.message;
            finish(null);
            break;
          }
          default: {
            break;
          }
        }
      });
      instance.addEventListener("error", (event) => {
        error.value = event.message || "求解线程出错";
        finish(null);
      });
      instance.addEventListener("messageerror", () => {
        error.value = "求解线程消息无法解析";
        finish(null);
      });
    });
  }

  onScopeDispose(cancel);

  return {
    running,
    stage,
    progress,
    elapsedMs,
    error,
    precheckDiagnostics,
    precheckFatal,
    run,
    cancel,
    reset,
  };
}
