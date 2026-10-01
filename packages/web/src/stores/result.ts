import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { loadState, saveState } from "@/lib/persist";
import { useRoomsStore } from "@/stores/rooms";
import { compareText, validate } from "@exam-seat/core";
import type {
  BorrowedSeat,
  Job,
  PlanAllResult,
  PlanEntry,
  PlanResult,
  SeatingPlan,
  StudentSchedule,
  TimeSlot,
  ValidationReport,
} from "@exam-seat/core";

const STORAGE_NAME = "result";

export type SolveStatus = "idle" | "running" | "done" | "failed";

/** 结果来自哪条求解路径：`single` = 单场 `plan`；`all` = 多场次 `planAll`。 */
export type SolveMode = "single" | "all";

interface PersistedResult {
  result: PlanResult | null;
  planAll: PlanAllResult | null;
  job: Job | null;
  ranAt: string | null;
  mode: SolveMode;
}

/**
 * 第 ⑤⑥ 步：求解结果。
 *
 * `job` 存的是求解那一刻的快照，用于跑独立校验器 `validate()`——校验器与求解器分开实现， 所以导出前必须拿同一份输入重验一次。
 *
 * 两条路径共用这一个 store：`setResult()` 写单场结果，`setAllResult()` 写多场次结果； 两者互斥（写一条会清掉另一条），`mode` 指明当前是哪种。
 */
export const useResultStore = defineStore("result", () => {
  const saved = loadState<PersistedResult>(STORAGE_NAME, {
    result: null,
    planAll: null,
    job: null,
    ranAt: null,
    mode: "single",
  });

  const result = ref<PlanResult | null>(saved.result ?? null);
  const planAll = ref<PlanAllResult | null>(saved.planAll ?? null);
  const job = ref<Job | null>(saved.job ?? null);
  const ranAt = ref<string | null>(saved.ranAt ?? null);
  const mode = ref<SolveMode>(
    saved.mode === "all" || (saved.mode == null && saved.planAll != null) ? "all" : "single",
  );
  const report = ref<ValidationReport | null>(null);
  const status = ref<SolveStatus>(saved.result || saved.planAll ? "done" : "idle");
  const errorMessage = ref("");
  const elapsedMs = ref(0);

  const hasResult = computed(() => result.value != null || planAll.value != null);
  const hasMultiResult = computed(() => planAll.value != null);
  /**
   * 是否「主动放宽了考场级同班相邻」（`PlanLevel = roomRelaxed` / `PlanAllResult.relaxedRooms` 非空）。
   *
   * 与「降级」（orthogonal / softConstraints / minConflicts）区分开：放宽是老师自己的选择， 结果仍然可用，只是要在监考表上标注。
   */
  const isRoomRelaxed = computed(() => {
    if (planAll.value != null) return (planAll.value.relaxedRooms ?? []).length > 0;
    return result.value?.level === "roomRelaxed";
  });
  /** 真·降级（算法被迫让步），`roomRelaxed` 不算。 */
  const isDegraded = computed(() => {
    if (planAll.value != null) {
      return planAll.value.seatings.some(
        (seating) => seating.result.level !== "strict" && seating.result.level !== "roomRelaxed",
      );
    }
    return (
      result.value != null &&
      result.value.level !== "strict" &&
      result.value.level !== "roomRelaxed"
    );
  });
  const entries = computed<PlanEntry[]>(() => result.value?.entries ?? []);

  /* ---------- 多场次视图 ---------- */

  const slots = computed<TimeSlot[]>(() => planAll.value?.slots ?? []);
  const seatings = computed<SeatingPlan[]>(() => planAll.value?.seatings ?? []);
  const scheduleByStudent = computed<StudentSchedule[]>(() => planAll.value?.byStudent ?? []);
  /** 已放宽「同班相邻」的考场 id（`RoomSpec.relaxSameClass`），按 rooms 顺序。 */
  const relaxedRoomIds = computed<string[]>(() => planAll.value?.relaxedRooms ?? []);
  /** 借考落位明细（借考人 + 科目 + 目标考场 / 座位）；没有借考时是空数组。 */
  const borrowings = computed<BorrowedSeat[]>(() => planAll.value?.borrowings ?? []);
  /** 放宽了同班相邻的考场名称（结果页展示用，找不到名字时退回 id）。 */
  const relaxedRoomNames = computed<string[]>(() =>
    relaxedRoomIds.value.map((id) => roomNameOf(id)),
  );

  function roomNameOf(roomId: string): string {
    return (
      seatings.value.find((seating) => seating.roomId === roomId)?.roomName ??
      job.value?.rooms.find((room) => room.id === roomId)?.name ??
      roomId
    );
  }

  /**
   * 空置考场：**按真正的求解结果判定**——`seatings` 里出现过的 `roomId` 才算用上， 不用容量预测。多场次取 `planAll.seatings`，单场沿用
   * `result.stats.emptyRooms`（同样来自求解结果）。
   */
  const emptyRoomIds = computed<string[]>(() => {
    if (planAll.value != null) {
      const used = new Set(seatings.value.map((seating) => seating.roomId));
      return (job.value?.rooms ?? []).filter((room) => !used.has(room.id)).map((room) => room.id);
    }
    return result.value?.stats.emptyRooms ?? [];
  });

  const emptyRoomNames = computed<string[]>(() =>
    emptyRoomIds.value.map((id) => job.value?.rooms.find((room) => room.id === id)?.name ?? id),
  );

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
    [...new Set(sortedEntries.value.map((e) => e.className))].sort(compareText),
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

  /** 写单场结果。`mode` 默认 `single`，老调用方不传时行为不变。 */
  function setResult(next: PlanResult, sourceJob: Job, nextMode: SolveMode = "single"): void {
    result.value = next;
    planAll.value = null;
    mode.value = nextMode;
    job.value = sourceJob;
    ranAt.value = new Date().toISOString();
    status.value = next.ok ? "done" : "failed";
    elapsedMs.value = next.stats.elapsedMs;
    report.value = validate(sourceJob, next);
  }

  /** 写多场次结果：清掉单场结果，多场次没有 `validate()` 的整份输入，`report` 一并清空。 */
  function setAllResult(next: PlanAllResult, sourceJob: Job): void {
    planAll.value = next;
    result.value = null;
    mode.value = "all";
    job.value = sourceJob;
    ranAt.value = new Date().toISOString();
    status.value = next.ok ? "done" : "failed";
    elapsedMs.value = next.seatings.reduce(
      (sum, seating) => sum + seating.result.stats.elapsedMs,
      0,
    );
    report.value = null;
  }

  function setError(message: string): void {
    status.value = "failed";
    errorMessage.value = message;
  }

  /** 求解被取消（Worker 被终止）：回到上一次结果对应的状态。 */
  function cancelRun(): void {
    if (result.value) status.value = result.value.ok ? "done" : "failed";
    else if (planAll.value) status.value = planAll.value.ok ? "done" : "failed";
    else status.value = "idle";
  }

  /**
   * 一键移除空置考场：同时作用到 `rooms` store 与结果快照里的 job。
   *
   * 移除后旧结果已不对应新配置，这里直接清掉（保留减去空置考场后的 job 快照）， 调用方提示「配置已变，建议重排」。
   */
  function removeEmptyRooms(): { removed: string[] } {
    const ids = emptyRoomIds.value;
    if (ids.length === 0) return { removed: [] };

    const idSet = new Set(ids);
    const roomsStore = useRoomsStore();
    const removed = ids.map(
      (id) =>
        roomsStore.roomById(id)?.name ??
        job.value?.rooms.find((room) => room.id === id)?.name ??
        id,
    );
    roomsStore.removeRooms(ids);
    if (job.value != null) {
      job.value = {
        ...job.value,
        rooms: job.value.rooms.filter((room) => !idSet.has(room.id)),
      };
    }

    result.value = null;
    planAll.value = null;
    report.value = null;
    ranAt.value = null;
    status.value = "idle";
    errorMessage.value = "";
    elapsedMs.value = 0;
    return { removed };
  }

  function clear(): void {
    result.value = null;
    planAll.value = null;
    mode.value = "single";
    job.value = null;
    report.value = null;
    ranAt.value = null;
    status.value = "idle";
    errorMessage.value = "";
    elapsedMs.value = 0;
  }

  watch(
    [result, planAll, job, ranAt, mode],
    () =>
      saveState(STORAGE_NAME, {
        result: result.value,
        planAll: planAll.value,
        job: job.value,
        ranAt: ranAt.value,
        mode: mode.value,
      } satisfies PersistedResult),
    { deep: true },
  );

  return {
    result,
    planAll,
    job,
    ranAt,
    mode,
    report,
    status,
    errorMessage,
    elapsedMs,
    hasResult,
    hasMultiResult,
    isDegraded,
    isRoomRelaxed,
    entries,
    slots,
    seatings,
    scheduleByStudent,
    relaxedRoomIds,
    relaxedRoomNames,
    borrowings,
    emptyRoomIds,
    emptyRoomNames,
    sortedEntries,
    entryBySeat,
    classNames,
    roomList,
    validateCurrent,
    setRunning,
    setResult,
    setAllResult,
    setError,
    cancelRun,
    removeEmptyRooms,
    clear,
  };
});
