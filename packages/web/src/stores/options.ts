import { defineStore } from "pinia";
import { ref, watch } from "vue";

import { DEFAULT_OPTIONS } from "@/lib/job";
import { loadState, saveState } from "@/lib/persist";
import type { Adjacency, PlanOptions, RelaxMode } from "@exam-seat/core";

const STORAGE_NAME = "options";

interface PersistedOptions {
  title: string;
  createdAt: string;
  options: Required<PlanOptions>;
}

/** Job 的 meta 与 options：种子、邻接规则、降级模式、时间上限。 */
export const useOptionsStore = defineStore("options", () => {
  const saved = loadState<PersistedOptions>(STORAGE_NAME, {
    title: "",
    createdAt: new Date().toISOString(),
    options: { ...DEFAULT_OPTIONS },
  });

  const title = ref(saved.title ?? "");
  const createdAt = ref(saved.createdAt ?? new Date().toISOString());
  const options = ref<Required<PlanOptions>>({ ...DEFAULT_OPTIONS, ...saved.options });

  function setSeed(seed: number | undefined): void {
    options.value = { ...options.value, seed: seed ?? DEFAULT_OPTIONS.seed };
  }

  function setAdjacency(adjacency: Adjacency): void {
    options.value = { ...options.value, adjacency };
  }

  function setRelax(relax: RelaxMode): void {
    options.value = { ...options.value, relax };
  }

  function setForceKing(forceKing: boolean): void {
    options.value = { ...options.value, forceKing };
  }

  function setTimeLimit(timeLimitMs: number): void {
    options.value = { ...options.value, timeLimitMs };
  }

  function replace(input: { title?: string; createdAt?: string; options?: PlanOptions }): void {
    if (input.title !== undefined) title.value = input.title;
    if (input.createdAt !== undefined) createdAt.value = input.createdAt;
    if (input.options !== undefined) {
      options.value = { ...DEFAULT_OPTIONS, ...input.options };
    }
  }

  function reset(): void {
    title.value = "";
    createdAt.value = new Date().toISOString();
    options.value = { ...DEFAULT_OPTIONS };
  }

  watch(
    [title, createdAt, options],
    () =>
      saveState(STORAGE_NAME, {
        title: title.value,
        createdAt: createdAt.value,
        options: options.value,
      } satisfies PersistedOptions),
    { deep: true },
  );

  return {
    title,
    createdAt,
    options,
    setSeed,
    setAdjacency,
    setRelax,
    setForceKing,
    setTimeLimit,
    replace,
    reset,
  };
});
