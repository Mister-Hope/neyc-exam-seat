import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { loadState, saveState } from "@/lib/persist";
import type { Constraint } from "@exam-seat/core";

const STORAGE_NAME = "constraints";

/** 第 ④ 步：限定规则。多条规则命中同一学生时由 core 取交集，这里只负责收集与编辑。 */
export const useConstraintsStore = defineStore("constraints", () => {
  const saved = loadState<{ constraints: Constraint[] }>(STORAGE_NAME, { constraints: [] });
  const constraints = ref<Constraint[]>(saved.constraints ?? []);

  const count = computed(() => constraints.value.length);
  const constrainedStudentCount = computed(
    () => new Set(constraints.value.flatMap((c) => c.studentIds)).size,
  );

  function nextId(): string {
    const used = new Set(constraints.value.map((c) => c.id));
    let n = constraints.value.length + 1;
    while (used.has(`C${n}`)) n += 1;
    return `C${n}`;
  }

  function addConstraint(input: Omit<Constraint, "id"> & { id?: string }): Constraint {
    const constraint: Constraint = { ...input, id: input.id ?? nextId() };
    constraints.value = [...constraints.value, constraint];
    return constraint;
  }

  function updateConstraint(id: string, patch: Omit<Constraint, "id">): void {
    constraints.value = constraints.value.map((c) => (c.id === id ? { ...patch, id } : c));
  }

  function removeConstraint(id: string): void {
    constraints.value = constraints.value.filter((c) => c.id !== id);
  }

  function constraintLabel(id: string): string {
    const constraint = constraints.value.find((c) => c.id === id);
    if (!constraint) return id;
    return constraint.note?.trim() ? constraint.note : id;
  }

  function constraintsOfStudent(studentId: string): Constraint[] {
    return constraints.value.filter((c) => c.studentIds.includes(studentId));
  }

  function replaceConstraints(next: readonly Constraint[]): void {
    constraints.value = next.map((c) => ({
      ...c,
      studentIds: [...c.studentIds],
      ...(c.rows ? { rows: [...c.rows] } : {}),
      ...(c.cols ? { cols: [...c.cols] } : {}),
    }));
  }

  function reset(): void {
    constraints.value = [];
  }

  watch(
    constraints,
    () =>
      saveState(STORAGE_NAME, { constraints: constraints.value } satisfies {
        constraints: Constraint[];
      }),
    { deep: true },
  );

  return {
    constraints,
    count,
    constrainedStudentCount,
    addConstraint,
    updateConstraint,
    removeConstraint,
    constraintLabel,
    constraintsOfStudent,
    replaceConstraints,
    reset,
  };
});
