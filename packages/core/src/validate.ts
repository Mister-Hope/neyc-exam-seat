import { compileDomains } from "./domain";
import { compileModel } from "./model";
import { roomCapacity, seatNoToRC, toPhysicalCol } from "./numbering";
import type { Job, PlanResult, ValidationIssue, ValidationReport } from "./types";

/** 独立校验器：只依赖 job 与最终 entries，**不复用求解器的任何状态**。 任何一条硬约束不过，就拒绝导出。 */
export function validate(job: Job, result: PlanResult): ValidationReport {
  const issues: ValidationIssue[] = [];
  const adjacency = result.stats.adjacency;
  const model = compileModel(job, adjacency);

  const roomById = new Map(model.rooms.map((r) => [r.spec.id, r]));
  const studentById = new Map(model.students.map((s) => [s.id, s]));

  /* 1) entries 自身的一致性 */
  const seenStudents = new Set<string>();
  const seenSeats = new Set<string>();

  for (const entry of result.entries) {
    const room = roomById.get(entry.roomId);
    if (!room) {
      issues.push({
        code: "ENTRY_UNKNOWN_ROOM",
        severity: "error",
        message: `名单里出现了不存在的考场 ${entry.roomId}`,
        refs: { studentId: entry.studentId, roomId: entry.roomId },
      });
      continue;
    }
    const capacity = roomCapacity(room.spec);
    if (!Number.isInteger(entry.seatNo) || entry.seatNo < 1 || entry.seatNo > capacity) {
      issues.push({
        code: "ENTRY_SEAT_OUT_OF_RANGE",
        severity: "error",
        message: `${room.spec.name ?? room.spec.id} 只有 ${capacity} 个座位，名单里却出现 ${entry.seatNo} 号`,
        refs: { studentId: entry.studentId, seatNo: entry.seatNo },
      });
    }
    const expected = seatNoToRC(entry.seatNo, room.spec.rows, room.spec.cols);
    if (entry.row !== expected.row || entry.col !== expected.col) {
      issues.push({
        code: "ENTRY_NUMBERING_MISMATCH",
        severity: "error",
        message: `${room.spec.name ?? room.spec.id} ${entry.seatNo} 号按蛇形规则应为第 ${expected.row} 排第 ${expected.col} 列，名单里写的是第 ${entry.row} 排第 ${entry.col} 列`,
        refs: { studentId: entry.studentId, seatNo: entry.seatNo },
      });
    }
    if (entry.physicalCol !== toPhysicalCol(entry.col, room.spec.cols, room.doorSide)) {
      issues.push({
        code: "ENTRY_PHYSICAL_COL_MISMATCH",
        severity: "warning",
        message: `${entry.studentId} 的物理列号与业务列号对不上`,
        refs: { studentId: entry.studentId },
      });
    }

    if (seenStudents.has(entry.studentId)) {
      issues.push({
        code: "ENTRY_DUPLICATE_STUDENT",
        severity: "error",
        message: `${entry.studentId} 在名单里出现了不止一次`,
        refs: { studentId: entry.studentId },
      });
    }
    seenStudents.add(entry.studentId);

    const seatKey = `${entry.roomId}:${entry.seatNo}`;
    if (seenSeats.has(seatKey)) {
      issues.push({
        code: "ENTRY_DUPLICATE_SEAT",
        severity: "error",
        message: `${room.spec.name ?? room.spec.id} 的 ${entry.seatNo} 号被安排了不止一个人`,
        refs: { seatId: seatKey },
      });
    }
    seenSeats.add(seatKey);

    if (!studentById.has(entry.studentId)) {
      issues.push({
        code: "ENTRY_UNKNOWN_STUDENT",
        severity: "error",
        message: `名单里出现了不参加本次考试或不存在的学生 ${entry.studentId}`,
        refs: { studentId: entry.studentId },
      });
    }
  }

  /* 2) 参加考试的学生必须全部安排 */
  for (const student of model.students) {
    if (!seenStudents.has(student.id)) {
      issues.push({
        code: "ENTRY_MISSING_STUDENT",
        severity: "error",
        message: `${student.name || student.id} 没有出现在名单里`,
        refs: { studentId: student.id },
      });
    }
  }

  /* 3) 邻接约束（独立重算，不用求解器的计数） */
  const studentAtSeat = new Int32Array(model.seatCount).fill(-1);
  const studentIndexOf = new Map<string, number>();
  for (let i = 0; i < model.students.length; i += 1) studentIndexOf.set(model.students[i]!.id, i);

  for (const entry of result.entries) {
    const room = roomById.get(entry.roomId);
    if (!room) continue;
    const rc = seatNoToRC(entry.seatNo, room.spec.rows, room.spec.cols);
    const seat = room.grid[(rc.row - 1) * room.spec.cols + (rc.col - 1)];
    const si = studentIndexOf.get(entry.studentId);
    if (seat === undefined || seat < 0 || si === undefined) continue;
    studentAtSeat[seat] = si;
  }

  for (let s = 0; s < model.seatCount; s += 1) {
    const u = studentAtSeat[s]!;
    if (u < 0) continue;
    const cls = model.classOfStudent[u]!;
    const start = model.neighborStart[s]!;
    const end = model.neighborStart[s + 1]!;
    for (let k = start; k < end; k += 1) {
      const t = model.neighborList[k]!;
      if (t <= s) continue;
      const v = studentAtSeat[t]!;
      if (v < 0) continue;
      if (model.classOfStudent[v] !== cls) continue;
      const room = model.rooms[model.seatRoom[s]!]!;
      issues.push({
        code: "ADJACENCY_CONFLICT",
        severity: "error",
        message: `${room.spec.name ?? room.spec.id} 的 ${model.seatNo[s]} 号与 ${model.seatNo[t]} 号相邻，却都是${model.classNames[cls]}`,
        refs: {
          roomId: room.spec.id,
          seatA: model.seatNo[s],
          seatB: model.seatNo[t],
          studentA: model.students[u]!.id,
          studentB: model.students[v]!.id,
          className: model.classNames[cls],
        },
      });
    }
  }

  /* 4) 限定是否被满足 */
  const domains = compileDomains(model);
  for (const entry of result.entries) {
    const si = studentIndexOf.get(entry.studentId);
    if (si === undefined) continue;
    const domain = domains.domains[si];
    if (domain == null) continue;
    const room = roomById.get(entry.roomId);
    if (!room) continue;
    const rc = seatNoToRC(entry.seatNo, room.spec.rows, room.spec.cols);
    const seat = room.grid[(rc.row - 1) * room.spec.cols + (rc.col - 1)];
    if (seat === undefined || seat < 0) continue;
    if (!domain.has(seat)) {
      const hits = domains.studentConstraints[si]!;
      issues.push({
        code: "CONSTRAINT_UNMET",
        severity: "error",
        message: `${entry.name || entry.studentId} 没有坐在限定要求的范围内`,
        refs: {
          studentId: entry.studentId,
          constraintIds: hits.map((ci) => domains.constraintSets[ci]!.constraint.id),
        },
      });
    }
  }

  return { ok: !issues.some((i) => i.severity === "error"), issues };
}
