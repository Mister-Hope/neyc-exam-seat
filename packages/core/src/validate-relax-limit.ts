import type { CompiledModel } from "./model";
import type { PlanResult, ValidationIssue } from "./types";
import { sameClassLimit } from "./util";

/**
 * 独立复核「`relaxSameClass` 为数字时，该考场同班人数不得超过 n」（`docs/design.md` §5.8.1，task-59）。
 *
 * 只按最终 `entries` 重新计数，**不复用求解器的任何计数**：把 4 个同班学生手写进「上限 2」的同一间考场 必须报
 * `ROOM_SAME_CLASS_LIMIT_EXCEEDED`。
 */
export function sameClassLimitIssues(
  model: CompiledModel,
  result: PlanResult,
  studentIndexOf: Map<string, number>,
  roomLabel: (roomId: string) => string,
): ValidationIssue[] {
  const limits = new Map<number, number>();
  model.rooms.forEach((room, index) => {
    const limit = sameClassLimit(room.spec, room.maxSameClass, room.capacity);
    if (limit !== undefined) limits.set(index, limit);
  });
  if (limits.size === 0) return [];

  const roomIndexById = new Map(model.rooms.map((room, index) => [room.spec.id, index]));
  const counts = new Map<number, Map<number, number>>();
  for (const entry of result.entries) {
    const roomIndex = roomIndexById.get(entry.roomId);
    if (roomIndex === undefined || !limits.has(roomIndex)) continue;
    const studentIndex = studentIndexOf.get(entry.studentId);
    if (studentIndex === undefined) continue;
    const cls = model.classOfStudent[studentIndex]!;
    const byClass = counts.get(roomIndex) ?? new Map<number, number>();
    byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
    counts.set(roomIndex, byClass);
  }

  const issues: ValidationIssue[] = [];
  for (const [roomIndex, byClass] of counts) {
    const limit = limits.get(roomIndex)!;
    const room = model.rooms[roomIndex]!;
    for (const [cls, count] of byClass) {
      if (count <= limit) continue;
      issues.push({
        code: "ROOM_SAME_CLASS_LIMIT_EXCEEDED",
        severity: "error",
        message: `${roomLabel(room.spec.id)} 的同班上限是 ${limit} 人，实际坐了 ${count} 人（${model.classNames[cls]}）`,
        refs: { roomId: room.spec.id, className: model.classNames[cls], count, limit },
      });
    }
  }
  return issues;
}
