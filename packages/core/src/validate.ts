import { compileDomains, hasAnySelector } from "./domain";
import { compileModel } from "./model";
import { roomCapacity, seatNoToRC, toPhysicalCol } from "./numbering";
import type { PlanAllResult, RoomSubjectClash } from "./plan-all";
import type { Job, PlanResult, Student, ValidationIssue, ValidationReport } from "./types";

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

/* ------------------------------------------------------------------ */
/* 多场次独立校验                                                       */
/* ------------------------------------------------------------------ */

export interface PlanAllSeatingValidation {
  roomId: string;
  roomName: string;
  subjects: string[];
  /** 这套座位实际排入的学生人数 */
  seats: number;
  ok: boolean;
  report: ValidationReport;
}

export interface PlanAllValidation {
  ok: boolean;
  seatings: PlanAllSeatingValidation[];
  /** 独立复核出的「同一考场同一时段多门科目」 */
  hardRuleClashes: RoomSubjectClash[];
  /** 汇总：逐 seating 的 issues（refs 带 roomId/roomName）+ validateAll 自己发现的违规 */
  issues: ValidationIssue[];
}

function roomLabel(room: { id: string; name?: string } | undefined, fallback: string): string {
  const name = room?.name?.trim();
  return name === undefined || name === "" ? (room?.id ?? fallback) : name;
}

/**
 * 多场次独立校验：逐 seating 重建单房子 job 调 {@link validate}，再独立复核
 * 「一个考场一个时段只能考一科」「座位唯一」「座位号与座位方案一致」「参加考试的人都有场次」。
 *
 * 不复用 `planAll` 的任何中间结论：硬规则从 `byStudent[].slots` 自己推导，限定由单房 `validate()` 重新编译定义域后核对。**任何 error
 * 级问题都会让 `ok = false`。**
 */
export function validateAll(job: Job, result: PlanAllResult): PlanAllValidation {
  const issues: ValidationIssue[] = [];
  const slots = result?.slots ?? [];
  const seatings = result?.seatings ?? [];
  const byStudent = result?.byStudent ?? [];
  const rooms = job.rooms ?? [];
  const roomById = new Map(rooms.map((room) => [room.id, room]));
  const studentById = new Map((job.students ?? []).map((student) => [student.id, student]));
  const constraints = job.constraints ?? [];

  /* 1) 限定本身是否可用（与求解无关的独立判断） */
  for (const constraint of constraints) {
    if (!hasAnySelector(constraint)) {
      issues.push({
        code: "CONSTRAINT_NO_SELECTOR",
        severity: "error",
        message: `限定「${constraint.id}」没有写任何选择器`,
        refs: { constraintId: constraint.id },
      });
    } else if (constraint.roomId && !roomById.has(constraint.roomId)) {
      issues.push({
        code: "UNKNOWN_ROOM_ID",
        severity: "error",
        message: `限定「${constraint.id}」引用了不存在的考场 ${constraint.roomId}`,
        refs: { constraintId: constraint.id, roomId: constraint.roomId },
      });
    }
  }

  /* 2) 逐 seating 重建子 job 跑 validate() */
  const seatingValidations: PlanAllSeatingValidation[] = seatings.map((seating) => {
    const room = roomById.get(seating.roomId);
    const roomName = roomLabel(room, seating.roomId);
    const subConstraints = constraints.filter(
      (constraint) =>
        hasAnySelector(constraint) && (!constraint.roomId || constraint.roomId === seating.roomId),
    );
    let report: ValidationReport;
    if (!room) {
      report = {
        ok: false,
        issues: [
          {
            code: "ENTRY_UNKNOWN_ROOM",
            severity: "error",
            message: `座位方案引用了不存在的考场 ${seating.roomId}`,
            refs: { roomId: seating.roomId },
          },
        ],
      };
    } else if (
      seating.result == null ||
      seating.result.stats == null ||
      !Array.isArray(seating.result.entries)
    ) {
      report = {
        ok: false,
        issues: [
          {
            code: "ENTRY_MISSING_STUDENT",
            severity: "error",
            message: `${roomName} 的座位方案缺少求解结果，无法校验`,
            refs: { roomId: seating.roomId },
          },
        ],
      };
    } else {
      const subStudents: Student[] = [];
      for (const id of seating.studentIds ?? []) {
        const student = studentById.get(id);
        if (student != null) subStudents.push({ ...student });
      }
      const subJob: Job = {
        jobVersion: job.jobVersion,
        students: subStudents,
        rooms: [room],
        constraints: subConstraints,
      };
      report = validate(subJob, seating.result);
    }
    return {
      roomId: seating.roomId,
      roomName,
      subjects: seating.subjects ?? [],
      seats: (seating.studentIds ?? []).length,
      ok: report.ok,
      report,
    };
  });

  for (const seating of seatingValidations) {
    for (const issue of seating.report.issues) {
      issues.push({
        ...issue,
        refs: { roomId: seating.roomId, roomName: seating.roomName, ...issue.refs },
      });
    }
  }

  /* 3) 独立复核：考场 × 时段最多一门科目 + 同一时段同一座位号只能一个人 */
  interface SlotBucket {
    roomId: string;
    slotId: string;
    slotName: string;
    subjects: Set<string>;
    studentIds: Set<string>;
    seats: Map<number, string[]>;
  }
  const buckets = new Map<string, SlotBucket>();
  for (const item of byStudent) {
    // plan.json 是用户可手改的，防御一下缺项/空项
    const student = item as (typeof byStudent)[number] | null;
    if (student == null) continue;
    for (const [slotId, assignment] of Object.entries(student.slots ?? {})) {
      if (!assignment) continue;
      const key = `${assignment.roomId}|${slotId}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          roomId: assignment.roomId,
          slotId,
          slotName: slots.find((slot) => slot.id === slotId)?.name ?? slotId,
          subjects: new Set<string>(),
          studentIds: new Set<string>(),
          seats: new Map<number, string[]>(),
        };
        buckets.set(key, bucket);
      }
      bucket.subjects.add(assignment.subject);
      bucket.studentIds.add(student.studentId);
      const seatUsers = bucket.seats.get(assignment.seatNo) ?? [];
      seatUsers.push(student.studentId);
      bucket.seats.set(assignment.seatNo, seatUsers);
    }
  }

  const hardRuleClashes: RoomSubjectClash[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.subjects.size > 1) {
      hardRuleClashes.push({
        roomId: bucket.roomId,
        roomName: roomLabel(roomById.get(bucket.roomId), bucket.roomId),
        slotId: bucket.slotId,
        slotName: bucket.slotName,
        subjects: [...bucket.subjects].sort(),
        studentIds: [...bucket.studentIds].sort(),
      });
    }
    for (const [seatNo, users] of bucket.seats) {
      if (users.length > 1) {
        issues.push({
          code: "ENTRY_DUPLICATE_SEAT",
          severity: "error",
          message: `${roomLabel(roomById.get(bucket.roomId), bucket.roomId)} 的 ${seatNo} 号在${bucket.slotName}被安排了 ${users.length} 个人`,
          refs: { roomId: bucket.roomId, slot: bucket.slotId, seatNo, studentIds: users },
        });
      }
    }
  }
  for (const clash of hardRuleClashes) {
    issues.push({
      code: "ROOM_SUBJECT_CLASH",
      severity: "error",
      message: `${clash.roomName} 在${clash.slotName}同时安排了 ${clash.subjects.join(" / ")}`,
      refs: {
        roomId: clash.roomId,
        slot: clash.slotId,
        subjects: clash.subjects,
        studentIds: clash.studentIds,
      },
    });
  }

  /* 4) 座位号必须与对应座位方案一致（防手改 plan.json 后两边对不上） */
  const seatingByRoomSubject = new Map<string, PlanAllResult["seatings"][number]>();
  for (const seating of seatings) {
    const keys = (seating.subjects ?? []).length > 0 ? seating.subjects : [""];
    for (const subject of keys) seatingByRoomSubject.set(`${seating.roomId}|${subject}`, seating);
  }
  for (const item of byStudent) {
    const student = item as (typeof byStudent)[number] | null;
    if (student == null) continue;
    for (const [slotId, assignment] of Object.entries(student.slots ?? {})) {
      if (!assignment) continue;
      const seating =
        seatingByRoomSubject.get(`${assignment.roomId}|${assignment.subject}`) ??
        seatingByRoomSubject.get(`${assignment.roomId}|`);
      if (!seating) {
        issues.push({
          code: "ENTRY_UNKNOWN_ROOM",
          severity: "error",
          message: `${student.studentId} 在${slotId}被安排到 ${assignment.roomId}，但那里没有对应的座位方案`,
          refs: { studentId: student.studentId, roomId: assignment.roomId },
        });
        continue;
      }
      const expectedSeat = (seating.seatNoById ?? {})[student.studentId];
      if (expectedSeat !== assignment.seatNo) {
        issues.push({
          code: "ENTRY_NUMBERING_MISMATCH",
          severity: "error",
          message: `${student.studentId} 在${slotId}的座位号（${assignment.seatNo}）与${seating.roomName}座位方案里的（${expectedSeat ?? "无"}）对不上`,
          refs: { studentId: student.studentId, roomId: assignment.roomId, slot: slotId },
        });
      }
    }
  }

  /* 5) 参加考试的人必须至少有一个场次 */
  const scheduled = new Set(byStudent.map((student) => student.studentId));
  const allStudents = job.students ?? [];
  const participants = allStudents.filter((student) => student.included !== false);
  // 「一套座位都没有」不能算通过（空数组上的 every 会真空为真，与 planAll 的 C1 同理）
  if (seatings.length === 0) {
    issues.push({
      code: "NO_STUDENTS",
      severity: "error",
      message: "多场次结果里没有任何座位方案，不能视为通过",
      refs: { participants: participants.length },
    });
  }
  const multiSession = allStudents.some(
    (student) => student.included !== false && (student.subjects?.length ?? 0) > 0,
  );
  for (const student of allStudents) {
    if (student.included === false) continue;
    if (multiSession && (student.subjects?.length ?? 0) === 0) continue;
    if (!scheduled.has(student.id)) {
      issues.push({
        code: "ENTRY_MISSING_STUDENT",
        severity: "error",
        message: `${student.name || student.id} 没有出现在任何场次里`,
        refs: { studentId: student.id },
      });
    }
  }

  const ok =
    seatingValidations.every((seating) => seating.ok) &&
    hardRuleClashes.length === 0 &&
    !issues.some((issue) => issue.severity === "error");

  return { ok, seatings: seatingValidations, hardRuleClashes, issues };
}
