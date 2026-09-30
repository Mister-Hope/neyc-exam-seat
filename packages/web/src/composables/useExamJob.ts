import { computed } from "vue";

import { buildJob, draftFromJob } from "@/lib/job";
import type { JobDraft } from "@/lib/job";
import { applyJsonPatch } from "@/lib/json-patch";
import { useConstraintsStore } from "@/stores/constraints";
import { useOptionsStore } from "@/stores/options";
import { useRoomsStore } from "@/stores/rooms";
import { useRosterStore } from "@/stores/roster";
import { compileModel, precheckJob, resolveConstraintStudents } from "@exam-seat/core";
import type { Constraint, Diagnostic, Job, JsonPatchOp, Suggestion } from "@exam-seat/core";

/**
 * 把四个 store 拼成一份 job.json（唯一契约），并提供「应用 patch → 回灌到各个 store」的能力。 预检建议、AI 生成的 job 都靠这条回灌通道生效，保证网页与
 * CLI 看到的是同一份数据。
 */
export function useExamJob() {
  const roster = useRosterStore();
  const rooms = useRoomsStore();
  const constraints = useConstraintsStore();
  const options = useOptionsStore();

  const draft = computed<JobDraft>(() => ({
    title: options.title,
    createdAt: options.createdAt,
    students: roster.students,
    rooms: rooms.rooms,
    constraints: constraints.constraints,
    options: options.options,
  }));

  const job = computed<Job>(() => buildJob(draft.value));

  function loadJob(next: Job): void {
    const nextDraft = draftFromJob(next);
    roster.replaceStudents(nextDraft.students);
    rooms.replaceRooms(nextDraft.rooms);
    constraints.replaceConstraints(nextDraft.constraints);
    options.replace({
      title: nextDraft.title,
      createdAt: nextDraft.createdAt,
      options: nextDraft.options,
    });
  }

  /** 应用 core 给出的 JSON Patch。失败时返回中文原因，交由界面提示。 */
  function applyPatch(patch: readonly JsonPatchOp[]): { ok: boolean; error?: string } {
    try {
      loadJob(applyJsonPatch(job.value, patch));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  function applySuggestion(suggestion: Suggestion): { ok: boolean; error?: string } {
    if (!suggestion.patch || suggestion.patch.length === 0) {
      return { ok: false, error: "这条建议没有可自动应用的修改，请手动调整" };
    }
    return applyPatch(suggestion.patch);
  }

  return { draft, job, loadJob, applyPatch, applySuggestion };
}

export interface PrecheckView {
  diagnostics: Diagnostic[];
  fatal: boolean;
  downgraded: boolean;
  adjacency: string;
}

/** 实时预检：限定页的冲突检测、求解页的预检页都读它。 */
export function usePrecheck() {
  const { job } = useExamJob();
  return computed<PrecheckView>(() => {
    const result = precheckJob(job.value);
    return {
      diagnostics: result.diagnostics,
      fatal: result.fatal,
      downgraded: result.downgraded,
      adjacency: result.adjacency,
    };
  });
}

/** 按诊断里的 constraintId 索引冲突，限定列表用它红字标出问题规则。 */
export function indexDiagnosticsByConstraint(
  diagnostics: readonly Diagnostic[],
): Map<string, Diagnostic[]> {
  const map = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const id = diagnostic.evidence?.constraintId;
    if (typeof id !== "string") continue;
    const list = map.get(id) ?? [];
    list.push(diagnostic);
    map.set(id, list);
  }
  return map;
}

/**
 * 用 core 的选择器语义（点名 / 班级 / 组合 / 科目）解析一条限定到底命中哪些学生。
 *
 * 刻意不在这里重新实现一遍选择器规则——预检、求解、网页必须共用同一套语义， 否则老师看到的「命中 12 人」和求解器眼里的 12 人可能不是同一批人。
 */
export function useConstraintResolver() {
  const { job } = useExamJob();
  const model = computed(() => compileModel(job.value));

  function resolveStudentIds(constraint: Constraint): string[] {
    const current = model.value;
    return resolveConstraintStudents(current, constraint).map(
      (index) => current.students[index]!.id,
    );
  }

  function resolveCount(constraint: Constraint): number {
    return resolveConstraintStudents(model.value, constraint).length;
  }

  return { resolveStudentIds, resolveCount };
}
