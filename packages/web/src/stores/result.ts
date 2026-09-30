import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { loadState, saveState } from "@/lib/persist";
import { validate } from "@exam-seat/core";
import type { Job, PlanEntry, PlanResult, ValidationReport } from "@exam-seat/core";

const STORAGE_NAME = "result";

export type SolveStatus = "idle" | "running" | "done" | "failed";

interface PersistedResult {
  result: PlanResult | null;
  job: Job | null;
  ranAt: string | null;
}

/**
 * 第 ⑤⑥ 步：求解结果。
 *
 * `job` 存的是求解那一刻的快照，用于跑独立校验器 `validate()`——校验器与求解器分开实现， 所以导出前必须拿同一份输入重验一次。
 */
export const useResultStore = defineStore("result", () => {
  const saved = loadState<PersistedResult>(STORAGE_NAME, { result: null, job: null, ranAt: null });

  const result = ref<PlanResult | null>(saved.result ?? null);
  const job = ref<Job | null>(saved.job ?? null);
  const ranAt = ref<string | null>(saved.ranAt ?? null);
  const report = ref<ValidationReport | null>(null);
  const status = ref<SolveStatus>(saved.result ? "done" : "idle");
  const errorMessage = ref("");
  const elapsedMs = ref(0);

  const hasResult = computed(() => result.value != null);
  const isDegraded = computed(() => result.value != null && result.value.level !== "strict");
  const entries = computed<PlanEntry[]>(() => result.value?.entries ?? []);

  /** 按考场顺序 + 座位号排序（core 已排好，这里再兜一层，防止手改 job.json 后顺序变了）。 */
  const sortedEntries = computed<PlanEntry[]>(() => {
    const order = new Map<string, number>();
    for (const [index, room] of (job.value?.rooms ?? []).entries()) order.set(room.id, index);
    return [...entries.value].sort((a, b) => {
      const ra = order.get(a.roomId) ?? 0;
      const rb = order.get(b.roomId) ?? 0;
      if (ra !== rb) return ra - rb;
      return a.seatNo - b.seatNo;
    });
  });

  const entryBySeat = computed(() => {
    const map = new Map<string, PlanEntry>();
    for (const entry of sortedEntries.value) map.set(`${entry.roomId}:${entry.seatNo}`, entry);
    return map;
  });

  const classNames = computed(() =>
    [...new Set(sortedEntries.value.map((e) => e.className))].sort((a, b) =>
      a.localeCompare(b, "zh"),
    ),
  );

  const roomList = computed(() => {
    const seen = new Map<string, string>();
    for (const room of job.value?.rooms ?? []) seen.set(room.id, room.name ?? room.id);
    for (const entry of sortedEntries.value)
      if (!seen.has(entry.roomId)) seen.set(entry.roomId, entry.roomName);
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  });

  function validateCurrent(): ValidationReport | null {
    if (!result.value || !job.value) return null;
    return validate(job.value, result.value);
  }

  function setRunning(): void {
    status.value = "running";
    errorMessage.value = "";
    elapsedMs.value = 0;
  }

  function setResult(next: PlanResult, sourceJob: Job): void {
    result.value = next;
    job.value = sourceJob;
    ranAt.value = new Date().toISOString();
    status.value = next.ok ? "done" : "failed";
    elapsedMs.value = next.stats.elapsedMs;
    report.value = validate(sourceJob, next);
  }

  function setError(message: string): void {
    status.value = "failed";
    errorMessage.value = message;
  }

  /** 求解被取消（Worker 被终止）：回到上一次结果对应的状态。 */
  function cancelRun(): void {
    status.value = result.value ? (result.value.ok ? "done" : "failed") : "idle";
  }

  function clear(): void {
    result.value = null;
    job.value = null;
    report.value = null;
    ranAt.value = null;
    status.value = "idle";
    errorMessage.value = "";
    elapsedMs.value = 0;
  }

  watch(
    [result, job, ranAt],
    () =>
      saveState(STORAGE_NAME, {
        result: result.value,
        job: job.value,
        ranAt: ranAt.value,
      } satisfies PersistedResult),
    { deep: true },
  );

  return {
    result,
    job,
    ranAt,
    report,
    status,
    errorMessage,
    elapsedMs,
    hasResult,
    isDegraded,
    entries,
    sortedEntries,
    entryBySeat,
    classNames,
    roomList,
    validateCurrent,
    setRunning,
    setResult,
    setError,
    cancelRun,
    clear,
  };
});
