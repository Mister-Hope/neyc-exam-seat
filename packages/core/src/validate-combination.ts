/**
 * 专属组合考场（`RoomSpec.combination`）的独立校验。
 *
 * 单独成文件只是为了 `validate.ts` 不超长；这里**不复用 `planAll` 的任何中间结论**： 只吃 `job` + 最终结果（单房看 `entries`，多场次看
 * `byStudent`），自己重算「谁属于哪个组合」。
 */

import { resolveConstraintStudents } from "./domain";
import { compileModel } from "./model";
import type { CompiledModel } from "./model";
import type { PlanAllResult } from "./plan-all";
import { CORE_SUBJECTS, normalizeCombination } from "./subjects";
import type { Job, ValidationIssue } from "./types";
import { roomCombination } from "./util";

function roomLabel(room: { id: string; name?: string } | undefined, fallback: string): string {
  const name = room?.name?.trim();
  return name === undefined || name === "" ? (room?.id ?? fallback) : name;
}

/** Job 里有没有考场设了专属组合（没有就不必再编译模型做检查） */
function hasCombinationRoom(job: Job): boolean {
  return (job.rooms ?? []).some((room) => roomCombination(room) !== undefined);
}

/** RoomId → 规范化组合 */
function combinationRoomIds(job: Job): Map<string, string> {
  const out = new Map<string, string>();
  for (const room of job.rooms ?? []) {
    const combination = roomCombination(room);
    if (combination !== undefined) out.set(room.id, combination);
  }
  return out;
}

/** 被 roomId 限定显式钉进专属组合考场的学生：专属组合之外只允许他们（显式限定优先） */
function pinnedByRoom(model: CompiledModel, combinationIds: ReadonlyMap<string, string>) {
  const out = new Map<string, Set<string>>();
  for (const constraint of model.job.constraints ?? []) {
    if (!constraint.roomId || !combinationIds.has(constraint.roomId)) continue;
    const set = out.get(constraint.roomId) ?? new Set<string>();
    for (const index of resolveConstraintStudents(model, constraint)) {
      set.add(model.students[index]!.id);
    }
    out.set(constraint.roomId, set);
  }
  return out;
}

function normalizedCombination(combination: string | null | undefined): string | undefined {
  if (combination == null) return undefined;
  return normalizeCombination(combination) || combination;
}

/**
 * 多场次校验（`validateAll()` 用）：byStudent 这一层独立复算。
 *
 * ① 专属考场里不该出现别的组合的人（被 roomId 显式钉进来的除外）； ② 属于该组合的学生必须落在钉住的考场里（看语数外的主考场，借考 / 专用考场不算）。
 *
 * 单场（所有人同一份卷子）下这个字段会被忽略，调用方不要调它——`validateAll()` 只在名单带选科时调。
 */
export function combinationIssuesForAssignments(
  job: Job,
  result: PlanAllResult,
): ValidationIssue[] {
  if (!hasCombinationRoom(job)) return [];
  const issues: ValidationIssue[] = [];
  const combinationIds = combinationRoomIds(job);
  const model = compileModel(job);
  const pinned = pinnedByRoom(model, combinationIds);
  const roomById = new Map((job.rooms ?? []).map((room) => [room.id, room]));

  for (const item of result.byStudent ?? []) {
    const student = item as (typeof result.byStudent)[number] | null;
    if (student == null) continue;
    const own = normalizedCombination(student.combination);

    // ① 专属考场里不该有别的组合的人
    for (const assignment of Object.values(student.slots ?? {})) {
      if (!assignment) continue;
      const combination = combinationIds.get(assignment.roomId);
      if (combination === undefined || own === combination) continue;
      if (pinned.get(assignment.roomId)?.has(student.studentId)) continue;
      issues.push({
        code: "ROOM_COMBINATION_MISMATCH",
        severity: "error",
        message: `${student.name || student.studentId}（${own ?? "未选科"}）被安排在「${combination}」专属考场 ${roomLabel(roomById.get(assignment.roomId), assignment.roomId)}`,
        refs: { roomId: assignment.roomId, combination, studentId: student.studentId },
      });
      break;
    }

    // ② 组合的学生必须落在钉住的考场里
    if (own === undefined) continue;
    const pinnedRoomIds = [...combinationIds.entries()]
      .filter(([, value]) => value === own)
      .map(([roomId]) => roomId);
    if (pinnedRoomIds.length === 0) continue;
    const coreAssignments = Object.values(student.slots ?? {}).filter(
      (assignment): assignment is NonNullable<typeof assignment> =>
        assignment != null && (CORE_SUBJECTS as readonly string[]).includes(assignment.subject),
    );
    if (coreAssignments.length === 0) continue;
    if (coreAssignments.some((assignment) => pinnedRoomIds.includes(assignment.roomId))) continue;
    issues.push({
      code: "ROOM_COMBINATION_UNMET",
      severity: "error",
      message: `${student.name || student.studentId}（${own}）没有落在专属组合考场 ${pinnedRoomIds.join("、")}，而是在 ${coreAssignments[0]!.roomId}`,
      refs: {
        studentId: student.studentId,
        combination: own,
        roomId: coreAssignments[0]!.roomId,
        pinnedRoomIds,
      },
    });
  }
  return issues;
}
