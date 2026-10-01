import type { PlanAllResult } from "./plan-all";
import type { RoomSpec, ValidationIssue } from "./types";

/** `validateAll()` 的时段一致性检查用到的输入（都是最终结果里的只读数据）。 */
export interface ScheduleConsistencyInput {
  /** `result.slots`：本次考试的合法时段 */
  slots: PlanAllResult["slots"];
  /** `result.seatings`：各套座位方案（谁在哪间考场有固定座位） */
  seatings: PlanAllResult["seatings"];
  /** `result.byStudent`：每个学生的时段表 */
  byStudent: PlanAllResult["byStudent"];
  roomById: Map<string, RoomSpec>;
  roomLabel: (room: RoomSpec | undefined, fallbackId: string) => string;
}

/**
 * `validateAll()` 的「时段一致性」独立复核（`docs/design.md` §8.2，task-58 收紧）。
 *
 * 三件事，都只依赖最终结果自身的自洽性（**不读** `job.students[].subjects`，所以不会变成 「必须每个应考科目都有座位」——那条会与将来的
 * planningOnly（§17 议题 7）冲突）：
 *
 * 1. `ENTRY_UNKNOWN_SLOT`：assignment 引用的时段必须真实存在于 `result.slots`；
 * 2. `ENTRY_MISSING_SLOT`：座位方案里在某个考场有座位的人，他的时段表里必须真的有一条安排到那间考场；
 * 3. `ENTRY_MISSING_SLOT`：学生自己声明的 `rooms`（哪间考场、考哪些科）必须与 `slots` 一致 —— 只删掉一条
 *    assignment（例如删一科、或把某个时段置空）时，`rooms` 还留着，这里就会报出来。
 */
export function scheduleConsistencyIssues(input: ScheduleConsistencyInput): ValidationIssue[] {
  const { slots, seatings, byStudent, roomById, roomLabel } = input;
  const issues: ValidationIssue[] = [];

  /* 1) 时段必须真实存在 */
  const knownSlots = new Set(slots.map((slot) => slot.id));
  for (const item of byStudent) {
    const student = item as (typeof byStudent)[number] | null;
    if (student == null) continue;
    for (const [slotId, assignment] of Object.entries(student.slots ?? {})) {
      if (!assignment) continue;
      if (knownSlots.has(slotId)) continue;
      issues.push({
        code: "ENTRY_UNKNOWN_SLOT",
        severity: "error",
        message: `${student.name || student.studentId} 被安排在时段的 ${slotId}，但这个时段不存在`,
        refs: { studentId: student.studentId, slot: slotId },
      });
    }
  }

  /* 2) 座位方案 → 时段表 */
  for (const seating of seatings) {
    const borrowed = seating.borrowedSubjects ?? {};
    for (const studentId of seating.studentIds ?? []) {
      if (borrowed[studentId] !== undefined) continue; // 借考生不占固定座位，另由 validateAll 第 4b 步复核
      const student = byStudent.find((item) => item?.studentId === studentId);
      if (!student) continue; // 缺整条记录由 validateAll 第 5 步报 ENTRY_MISSING_STUDENT
      const used = Object.values(student.slots ?? {}).some(
        (assignment) => assignment?.roomId === seating.roomId,
      );
      if (used) continue;
      issues.push({
        code: "ENTRY_MISSING_SLOT",
        severity: "error",
        message: `${student.name || studentId} 在${roomLabel(
          roomById.get(seating.roomId),
          seating.roomId,
        )}有座位，但时段表里没有任何一条安排到该考场`,
        refs: { studentId, roomId: seating.roomId },
      });
    }
  }

  /* 3) 学生自己的 `rooms` ↔ `slots` */
  for (const item of byStudent) {
    const student = item as (typeof byStudent)[number] | null;
    if (student == null) continue;
    const assignedSubjects = new Map<string, Set<string>>();
    for (const assignment of Object.values(student.slots ?? {})) {
      if (!assignment) continue;
      const set = assignedSubjects.get(assignment.roomId) ?? new Set<string>();
      set.add(assignment.subject);
      assignedSubjects.set(assignment.roomId, set);
    }
    for (const usage of student.rooms ?? []) {
      const assigned = assignedSubjects.get(usage.roomId);
      const missing = (usage.subjects ?? []).filter((subject) => !assigned?.has(subject));
      if (assigned !== undefined && missing.length === 0) continue;
      issues.push({
        code: "ENTRY_MISSING_SLOT",
        severity: "error",
        message: `${student.name || student.studentId} 的时段表与考场清单对不上：${roomLabel(
          roomById.get(usage.roomId),
          usage.roomId,
        )}${missing.length > 0 ? ` 少了 ${missing.join("、")}` : " 一个时段都没有"}`,
        refs: { studentId: student.studentId, roomId: usage.roomId, subjects: missing },
      });
    }
  }

  return issues;
}
