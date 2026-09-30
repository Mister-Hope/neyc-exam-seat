import { compileModel } from "./model";
import { roomCapacity } from "./numbering";
import { normalizeOptions, plan } from "./plan";
import { resolveAdjacency } from "./precheck";
import { deriveTimeSlots } from "./schedule";
import type { TimeSlot } from "./schedule";
import {
  CORE_SUBJECTS,
  isRegularCombination,
  normalizeCombination,
  subjectLabel,
  subjectListLabel,
} from "./subjects";
import type { Diagnostic, Job, PlanOptions, PlanResult, RoomSpec } from "./types";

/** 一套座位方案：一个考场里的一批固定学生 + 一套固定座位 */
export interface SeatingPlan {
  /** 这套座位服务的科目 */
  subjects: string[];
  roomId: string;
  roomName: string;
  location?: string;
  /** 监考老师 */
  note?: string;
  /** 属于这套座位的学生 id */
  studentIds: string[];
  /** 学生 id → 座位号 */
  seatNoById: Record<string, number>;
  /** 座位号 → 学生 id，监考表要用 */
  studentBySeatNo: Record<number, string>;
  /** 求解结果（含冲突、统计、诊断） */
  result: PlanResult;
}

export interface StudentSlotAssignment {
  subject: string;
  subjectLabel: string;
  roomId: string;
  roomName: string;
  location?: string;
  seatNo: number;
}

export interface StudentRoomUsage {
  roomId: string;
  roomName: string;
  location?: string;
  /** 这个学生在这个考场考的科目 */
  subjects: string[];
}

export interface StudentSchedule {
  studentId: string;
  name: string;
  className: string;
  combination: string | null;
  /** SlotId → 坐在哪；null = 这个时段他没考试 */
  slots: Record<string, StudentSlotAssignment | null>;
  /** 用到的考场，按首次出现顺序 */
  rooms: StudentRoomUsage[];
  /** 一共用了几个不同考场 */
  distinctRooms: number;
}

export interface PlanAllResult {
  ok: boolean;
  /** 应届的时段划分 */
  slots: TimeSlot[];
  seatings: SeatingPlan[];
  byStudent: StudentSchedule[];
  /** 一个学生都没安排的考场 → 可以取消 */
  emptyRooms: string[];
  /** 考场数超过上限的学生（正常应为空） */
  overRoomLimit: { studentId: string; name: string; count: number }[];
  diagnostics: Diagnostic[];
}

interface SeatingGroup {
  kind: "regular" | "irregular-main" | "dedicated";
  key: string;
  /** Model.students 的下标 */
  students: number[];
  /** 这套座位覆盖的科目 */
  subjects: string[];
  room: RoomSpec;
}

/** 一组需要占普通考场的学生 */
interface SeatingDemand {
  kind: SeatingGroup["kind"];
  key: string;
  students: number[];
  subjects: string[];
}

/**
 * 把若干「需求组」铺到普通考场里。
 *
 * - `allowShare = false`（优先）：每个组都从新考场开始，同考场只有一个组合，监考表最干净。
 * - `allowShare = true`（考场不够时的退让）：把当前考场填满再换下一个， 代价是尾房可能混两个组合，那个考场会拆成多张监考表。
 */
function allocateDemands(
  demands: SeatingDemand[],
  rooms: RoomSpec[],
  allowShare: boolean,
): { groups: SeatingGroup[]; ok: boolean; missingSeats: number; sharedRooms: number } {
  const out: SeatingGroup[] = [];
  const roomTakers = new Map<string, number>();
  let roomIndex = 0;
  let used = 0;
  let missingSeats = 0;

  for (const demand of demands) {
    let remaining = demand.students;
    while (remaining.length > 0) {
      if (roomIndex >= rooms.length) {
        missingSeats += remaining.length;
        break;
      }
      const room = rooms[roomIndex]!;
      const capacity = roomCapacity(room);
      const free = allowShare ? capacity - used : capacity;
      if (free <= 0) {
        roomIndex += 1;
        used = 0;
        continue;
      }
      const take = remaining.slice(0, free);
      remaining = remaining.slice(take.length);
      out.push({
        kind: demand.kind,
        key: demand.key,
        students: take,
        subjects: demand.subjects,
        room,
      });
      roomTakers.set(room.id, (roomTakers.get(room.id) ?? 0) + 1);

      if (allowShare) {
        used += take.length;
        if (used >= capacity) {
          roomIndex += 1;
          used = 0;
        }
      } else {
        used = 0;
        roomIndex += 1;
      }
    }
  }

  const sharedRooms = [...roomTakers.values()].filter((n) => n > 1).length;
  return { groups: out, ok: missingSeats === 0, missingSeats, sharedRooms };
}

function roomName(room: RoomSpec): string {
  return room.name?.trim() || room.id;
}

/**
 * 按班级轮流交错学生。
 *
 * 名单通常是**按班级排**的，如果直接按下标顺序切分考场，第一个考场会被同一个班塞满 —— 而 30 座考场里同班上限只有 9 人，直接无解。所以分房前必须按班级轮流取人，
 * 让每个考场都拿到混合的班级。
 */
function interleaveByClass(members: readonly number[], classOfStudent: Int32Array): number[] {
  if (members.length <= 1) return [...members];
  const buckets = new Map<number, number[]>();
  for (const index of members) {
    const cls = classOfStudent[index]!;
    const list = buckets.get(cls) ?? [];
    list.push(index);
    buckets.set(cls, list);
  }
  if (buckets.size === 1) return [...members];

  // 班级大的先取，保证每轮都能取到最多的人
  const lists = [...buckets.values()].sort((a, b) => b.length - a.length);
  const out: number[] = [];
  for (let round = 0; out.length < members.length; round += 1) {
    for (const list of lists) {
      const item = list[round];
      if (item !== undefined) out.push(item);
    }
  }
  return out;
}

/** 把一批学生按考场容量依次填满给定考场 */
function fillRooms(
  students: number[],
  rooms: RoomSpec[],
): { students: number[]; room: RoomSpec }[] {
  const out: { students: number[]; room: RoomSpec }[] = [];
  let cursor = 0;
  for (const room of rooms) {
    if (cursor >= students.length) break;
    const capacity = roomCapacity(room);
    const chunk = students.slice(cursor, cursor + capacity);
    cursor += chunk.length;
    if (chunk.length > 0) out.push({ students: chunk, room });
  }
  return out;
}

/** 多场次排考。按「常规组合全程不换考场」的原则把学生分成若干套座位， 每套座位调一次现有求解器 —— 求解器本身一行没改。 */
export function planAll(job: Job, overrides?: PlanOptions): PlanAllResult {
  const options = normalizeOptions({ ...job.options, ...overrides });
  const { adjacency } = resolveAdjacency(job, options.adjacency, options.forceKing);
  const model = compileModel(job, adjacency);
  const diagnostics: Diagnostic[] = [];

  const students = model.students;
  const core = [...CORE_SUBJECTS];

  /* ---------- 1. 时段 ---------- */
  const distinctCombos: string[][] = [];
  for (const indices of model.combinationGroups.values()) {
    const subjects = model.subjectOfStudent[indices[0]!];
    if (subjects) distinctCombos.push([...subjects]);
  }
  const hasSelection = distinctCombos.length > 0;
  const slots: TimeSlot[] = hasSelection
    ? deriveTimeSlots(distinctCombos, core)
    : [{ id: "T1", name: "第1时段", subjects: [] }];

  /* ---------- 2. 考场分组：专用 vs 普通 ---------- */
  const dedicatedRooms = new Map<string, RoomSpec[]>();
  const generalRooms: RoomSpec[] = [];
  for (const room of model.rooms.map((r) => r.spec)) {
    const dedicated = [...new Set(room.dedicatedSubjects ?? [])];
    if (dedicated.length === 0) {
      generalRooms.push(room);
      continue;
    }
    for (const subject of dedicated) {
      const list = dedicatedRooms.get(subject) ?? [];
      list.push(room);
      dedicatedRooms.set(subject, list);
    }
  }
  const dedicatedSubjects = new Set(dedicatedRooms.keys());

  /* ---------- 3. 分学生 ---------- */
  const regularOverrides = options.regularCombinations?.map((c) => normalizeCombination(c));
  const useOverride = (regularOverrides?.length ?? 0) > 0;

  const regularByCombination = new Map<string, number[]>();
  const irregular: number[] = [];
  const unselected: number[] = [];

  for (let i = 0; i < students.length; i += 1) {
    const subjects = model.subjectOfStudent[i];
    if (!subjects) {
      unselected.push(i);
      continue;
    }
    if (!hasSelection) break;
    const combo = model.combinationOfStudent[i];
    const regular = useOverride
      ? combo != null && regularOverrides.includes(normalizeCombination(combo))
      : isRegularCombination(subjects);
    if (regular) {
      const key = combo ?? "";
      const list = regularByCombination.get(key) ?? [];
      list.push(i);
      regularByCombination.set(key, list);
    } else {
      irregular.push(i);
    }
  }

  if (unselected.length > 0) {
    diagnostics.push({
      code: "STUDENT_MISSING_SUBJECTS",
      severity: "warning",
      message: `有 ${unselected.length} 名学生没有选科信息，他们没有进入任何时段`,
      evidence: { studentIds: unselected.slice(0, 10).map((i) => students[i]!.id) },
      suggestions: [],
    });
  }

  /* ---------- 4. 组装座位组 ---------- */
  const groups: SeatingGroup[] = [];

  if (hasSelection) {
    const demands: SeatingDemand[] = [];

    // 4a. 常规组合：各自占一批普通考场（人数多的先分，减少碎片）
    const regularEntries = [...regularByCombination.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "zh"),
    );
    for (const [combo, members] of regularEntries) {
      const subjects = new Set<string>(core);
      for (const i of members) for (const s of model.subjectOfStudent[i] ?? []) subjects.add(s);
      demands.push({
        kind: "regular",
        key: combo,
        students: interleaveByClass(members, model.classOfStudent),
        subjects: [...subjects],
      });
    }

    // 4b. 非常规主考场：语数外 + 选考科目里「没被专用考场接走」的那些
    if (irregular.length > 0) {
      const subjects = new Set<string>(core);
      for (const i of irregular) {
        for (const s of model.subjectOfStudent[i] ?? []) {
          if (!dedicatedSubjects.has(s)) subjects.add(s);
        }
      }
      if (subjects.size > core.length) {
        demands.push({
          kind: "irregular-main",
          key: "irregular-main",
          students: interleaveByClass(irregular, model.classOfStudent),
          subjects: [...subjects],
        });
      }
    }

    // 先试「每种组合独占若干考场」；考场不够时退让成「允许共用尾房」，
    // 代价是该考场会拆成多张监考表 —— 这正是「尽量」二字的边界。
    const strict = allocateDemands(demands, generalRooms, false);
    if (strict.ok) {
      groups.push(...strict.groups);
    } else {
      const shared = allocateDemands(demands, generalRooms, true);
      groups.push(...shared.groups);
      diagnostics.push(
        shared.ok
          ? {
              code: "ROOMS_SHARED",
              severity: "warning",
              message:
                "普通考场数量不足以让每种组合独占考场，已把部分组合放进同一个考场（那个考场会拆成多张监考表）",
              evidence: { sharedRooms: shared.sharedRooms },
              suggestions: [],
            }
          : {
              code: "CAPACITY_INSUFFICIENT",
              severity: "error",
              message: `普通考场不够：还缺 ${shared.missingSeats} 个座位`,
              evidence: { missingSeats: shared.missingSeats },
              suggestions: [],
            },
      );
    }

    // 4c. 专用考场：只接收「非常规组合 + 选了该科目」的学生
    for (const [subject, rooms] of dedicatedRooms) {
      const takers = irregular.filter((i) => (model.subjectOfStudent[i] ?? []).includes(subject));
      if (takers.length === 0) continue;
      const capacity = rooms.reduce((sum, r) => sum + roomCapacity(r), 0);
      if (capacity < takers.length) {
        diagnostics.push({
          code: "CONSTRAINT_OVERSATURATED",
          severity: "error",
          message: `${subjectLabel(subject)}专用考场只有 ${capacity} 个座位，但有 ${takers.length} 名非常规组合学生要考`,
          evidence: { subject, capacity, students: takers.length },
          suggestions: [],
        });
      }
      for (const chunk of fillRooms(interleaveByClass(takers, model.classOfStudent), rooms)) {
        groups.push({
          kind: "dedicated",
          key: subject,
          students: chunk.students,
          subjects: [subject],
          room: chunk.room,
        });
      }
    }
  } else {
    // 没有选科信息：退化成普通单场，全体按容量铺开
    const all = students.map((_, i) => i);
    for (const chunk of fillRooms(all, generalRooms)) {
      groups.push({
        kind: "regular",
        key: "all",
        students: chunk.students,
        subjects: [],
        room: chunk.room,
      });
    }
  }

  /* ---------- 5. 每个座位组排一次座位 ---------- */
  const seatings: SeatingPlan[] = [];
  for (const group of groups) {
    const subJob: Job = {
      jobVersion: job.jobVersion,
      students: group.students.map((i) => ({ ...students[i]! })),
      rooms: [group.room],
      constraints: [],
    };
    const result = plan(subJob, {
      seed: options.seed,
      adjacency: options.adjacency,
      forceKing: options.forceKing,
      relax: options.relax,
      timeLimitMs: options.timeLimitMs,
    });

    const seatNoById: Record<string, number> = {};
    const studentBySeatNo: Record<number, string> = {};
    for (const entry of result.entries) {
      seatNoById[entry.studentId] = entry.seatNo;
      studentBySeatNo[entry.seatNo] = entry.studentId;
    }
    for (const d of result.diagnostics) {
      if (d.severity === "error") {
        diagnostics.push({
          ...d,
          message: `${roomName(group.room)}：${d.message}`,
        });
      }
    }
    seatings.push({
      subjects: group.subjects,
      roomId: group.room.id,
      roomName: roomName(group.room),
      location: group.room.location,
      note: group.room.note,
      studentIds: group.students.map((i) => students[i]!.id),
      seatNoById,
      studentBySeatNo,
      result,
    });
  }

  /* ---------- 6. 组装每人一张表 ---------- */
  const byStudent: StudentSchedule[] = [];
  const usedRoomIds = new Set<string>();

  // 学生下标 → 科目 → 座位方案
  const subjectSeating = new Map<number, Map<string, SeatingPlan>>();
  for (const seating of seatings) {
    usedRoomIds.add(seating.roomId);
    for (const id of seating.studentIds) {
      const index = model.studentIndexById.get(id);
      if (index === undefined) continue;
      let map = subjectSeating.get(index);
      if (!map) {
        map = new Map();
        subjectSeating.set(index, map);
      }
      // 退化模式（没有选科信息）下座位方案不绑定科目，用一个空串做键
      const keys = seating.subjects.length > 0 ? seating.subjects : [""];
      for (const subject of keys) map.set(subject, seating);
    }
  }

  for (let i = 0; i < students.length; i += 1) {
    const own = model.subjectOfStudent[i];
    const seatingFor = subjectSeating.get(i);
    if (!seatingFor) continue;

    // 语数外不在选科列里，但每个学生都考——拼时段的时候必须带上
    const ownAll = own ? [...core, ...own] : [];

    const slotAssignments: Record<string, StudentSlotAssignment | null> = {};
    const roomOrder: string[] = [];
    const roomSubjects = new Map<string, Set<string>>();
    const roomInfo = new Map<string, { roomName: string; location?: string }>();

    for (const slot of slots) {
      // 空 subjects 表示退化模式：整个考试就一个时段，座位方案已经安排好了
      const subject =
        slot.subjects.length === 0 ? "" : (slot.subjects.find((s) => ownAll.includes(s)) ?? null);
      if (subject == null) {
        slotAssignments[slot.id] = null;
        continue;
      }
      const seating = seatingFor.get(subject);
      if (!seating) {
        slotAssignments[slot.id] = null;
        continue;
      }
      const seatNo = seating.seatNoById[students[i]!.id];
      if (seatNo === undefined) {
        slotAssignments[slot.id] = null;
        continue;
      }
      slotAssignments[slot.id] = {
        subject,
        subjectLabel: subject ? subjectLabel(subject) : "",
        roomId: seating.roomId,
        roomName: seating.roomName,
        location: seating.location,
        seatNo,
      };
      if (!roomSubjects.has(seating.roomId)) {
        roomSubjects.set(seating.roomId, new Set());
        roomOrder.push(seating.roomId);
        roomInfo.set(seating.roomId, { roomName: seating.roomName, location: seating.location });
      }
      if (subject) roomSubjects.get(seating.roomId)!.add(subject);
    }

    const rooms: StudentRoomUsage[] = roomOrder.map((roomId) => ({
      roomId,
      roomName: roomInfo.get(roomId)!.roomName,
      location: roomInfo.get(roomId)!.location,
      subjects: [...roomSubjects.get(roomId)!],
    }));

    byStudent.push({
      studentId: students[i]!.id,
      name: students[i]!.name,
      className: students[i]!.className,
      combination: model.combinationOfStudent[i] ?? null,
      slots: slotAssignments,
      rooms,
      distinctRooms: rooms.length,
    });
  }

  const maxRooms = options.maxRoomsPerStudent;
  const overRoomLimit = byStudent
    .filter((s) => s.distinctRooms > maxRooms)
    .map((s) => ({ studentId: s.studentId, name: s.name, count: s.distinctRooms }));

  const emptyRooms = model.rooms
    .map((r) => r.spec)
    .filter((room) => !usedRoomIds.has(room.id))
    .map((room) => roomName(room));

  const ok =
    diagnostics.every((d) => d.severity !== "error") &&
    overRoomLimit.length === 0 &&
    seatings.every((s) => s.result.ok);

  return { ok, slots, seatings, byStudent, emptyRooms, overRoomLimit, diagnostics };
}

export { subjectListLabel };
