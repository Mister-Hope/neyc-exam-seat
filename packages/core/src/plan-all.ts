import { hasAnySelector, resolveConstraintStudents } from "./domain";
import { compileModel } from "./model";
import type { CompiledModel } from "./model";
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
} from "./subjects";
import type {
  Constraint,
  Diagnostic,
  GroupPreference,
  Job,
  PlanOptions,
  PlanResult,
  RoomSpec,
  UnmetConstraint,
} from "./types";

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
  /** 各套座位没满足的限定汇总（形状与单场一致，额外带上是哪个考场） */
  unmetConstraints: PlanAllUnmetConstraint[];
  diagnostics: Diagnostic[];
}

/** 多场次里某条限定没被满足：单场的形状 + 发生在哪个考场。 */
export interface PlanAllUnmetConstraint extends UnmetConstraint {
  roomId: string;
  roomName: string;
}

/** 一处「同一考场、同一时段出现多门科目」的硬规则违规（`docs/design.md` §5.1）。 */
export interface RoomSubjectClash {
  roomId: string;
  roomName: string;
  slotId: string;
  slotName: string;
  /** 该考场该时段同时出现的科目 id（已排序） */
  subjects: string[];
  /** 涉及的学生 id（该考场该时段在考这些科目的学生，已去重） */
  studentIds: string[];
}

/**
 * 逐「考场 × 时段」核对硬规则：同一考场同一时段最多只能有一门科目。
 *
 * 与求解器分开实现的独立校验：只看分房结果的 `seatings`（每套座位覆盖哪些科目）与 `slots` （每个时段并行开考哪些科目），一个座位方案在某时段实际就在考它 subjects 与
 * slot.subjects 的交集。
 *
 * 正常分房（`sameCombination`，或 `fillRooms` 且只合并逐时段不冲突的批次）下返回空数组； 返回非空说明分房结果违反 §5.1，该结果不得导出。
 *
 * CLI / Web / 验收脚本都可以直接拿 `planAll` 的返回值调它。
 */
export function findRoomSubjectClashes(
  result: Pick<PlanAllResult, "slots" | "seatings">,
): RoomSubjectClash[] {
  const seatingsByRoom = new Map<string, SeatingPlan[]>();
  for (const seating of result.seatings) {
    // 没有选科信息的退化模式：整个考试只有一个时段、座位方案不绑定科目，与硬规则无关
    if (seating.subjects.length === 0) continue;
    const list = seatingsByRoom.get(seating.roomId);
    if (list) list.push(seating);
    else seatingsByRoom.set(seating.roomId, [seating]);
  }

  const clashes: RoomSubjectClash[] = [];
  for (const seatings of seatingsByRoom.values()) {
    for (const slot of result.slots) {
      const subjects = new Set<string>();
      const studentIds = new Set<string>();
      for (const seating of seatings) {
        const hit = slot.subjects.filter((subject) => seating.subjects.includes(subject));
        if (hit.length === 0) continue;
        for (const subject of hit) subjects.add(subject);
        for (const id of seating.studentIds) studentIds.add(id);
      }
      if (subjects.size > 1) {
        clashes.push({
          roomId: seatings[0]!.roomId,
          roomName: seatings[0]!.roomName,
          slotId: slot.id,
          slotName: slot.name,
          subjects: [...subjects].sort(),
          studentIds: [...studentIds],
        });
      }
    }
  }
  return clashes;
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
  /** 被 `roomId` 限定到某个考场：只能放进它，放不下要明确诊断（绝不改成「不限考场」） */
  requiredRoomId?: string;
}

/** 一套座位在每个时段的科目签名：`null` = 这个时段这批学生没有考试。 */
function slotSignature(subjects: readonly string[], slots: readonly TimeSlot[]): (string | null)[] {
  return slots.map((slot) => {
    const hit = slot.subjects.filter((subject) => subjects.includes(subject));
    return hit.length === 0 ? null : [...hit].sort().join("+");
  });
}

/**
 * 两个批次能否共用一个考场：**逐时段不冲突**。
 *
 * 对每个时段，两批考生在该时段要考的科目合起来最多一门 —— 要么只有一批有考试（另一批缺考、 人不在这个考场），要么两批考同一门。只要出现「同一时段两门不同科目」就不允许共用，
 * 这正是「一个考场一个时段只能考一科」这条硬规则（`docs/design.md` §5.1）。
 */
function canShareRoom(a: readonly (string | null)[], b: readonly (string | null)[]): boolean {
  return a.every((subject, index) => subject == null || b[index] == null || subject === b[index]);
}

/**
 * 把非常规学生按「主考场里逐时段的科目签名」分批，再贪心合并成若干批次。
 *
 * 同一批次内部必须逐时段只考一门，否则整套座位在某个时段会同时考两门科目 —— 例如只考理科的 学校（没有政史地把政治/地理拆开）会把政治与地理推成同一个时段，此时物化政与物化地**不能**
 * 合进同一批座位（`docs/design.md` §5.1）。签名（逐时段）是分批的依据，`canShareRoom` 是合并
 * 的依据：只有两批在每个时段都不冲突（同一门，或只有一方有考试）才能并成一批。
 */
function groupIrregularDemands(
  irregular: readonly number[],
  model: CompiledModel,
  dedicatedSubjects: ReadonlySet<string>,
  slots: readonly TimeSlot[],
  core: readonly string[],
): SeatingDemand[] {
  // 1) 每个学生的「主考场科目」= 语数外 + 没被专用考场接走的选考科目；同签名的归为一类
  const classes = new Map<string, { subjects: string[]; members: number[] }>();
  for (const index of irregular) {
    const subjects = new Set<string>(core);
    for (const subject of model.subjectOfStudent[index] ?? []) {
      if (!dedicatedSubjects.has(subject)) subjects.add(subject);
    }
    const list = [...subjects];
    const key = slotSignature(list, slots)
      .map((subject) => subject ?? "-")
      .join("|");
    const bucket = classes.get(key);
    if (bucket) {
      bucket.members.push(index);
      for (const subject of list)
        if (!bucket.subjects.includes(subject)) bucket.subjects.push(subject);
    } else {
      classes.set(key, { subjects: list, members: [index] });
    }
  }

  // 2) 逐时段不冲突的类贪心合并成一批（兼容关系两两成立才合并，保证批内每个时段只有一门）
  const batches: { signatures: (string | null)[][]; subjects: string[]; members: number[] }[] = [];
  for (const bucket of classes.values()) {
    const signature = slotSignature(bucket.subjects, slots);
    const target = batches.find((batch) =>
      batch.signatures.every((other) => canShareRoom(other, signature)),
    );
    if (target) {
      target.signatures.push(signature);
      target.members.push(...bucket.members);
      for (const subject of bucket.subjects) {
        if (!target.subjects.includes(subject)) target.subjects.push(subject);
      }
    } else {
      batches.push({
        signatures: [signature],
        subjects: [...bucket.subjects],
        members: [...bucket.members],
      });
    }
  }

  return batches.map((batch) => ({
    kind: "irregular-main",
    key: "irregular-main",
    students: interleaveByClass(batch.members, model.classOfStudent),
    subjects: batch.subjects,
  }));
}

/** 一条能真正应用的限定 + 它命中的学生下标 */
interface ApplicableConstraint {
  constraint: Constraint;
  hits: Set<number>;
}

/** 取某个学生在给定考场集合里被 roomId 限定到的考场；没有就 undefined。 */
function requiredRoomIn(
  required: readonly string[] | undefined,
  allowed: ReadonlySet<string>,
): string | undefined {
  if (!required) return undefined;
  return required.find((roomId) => allowed.has(roomId));
}

/**
 * 按「被 roomId 限定到的考场」把一批学生拆开。
 *
 * 同一批次里不同学生可能被限定到不同考场（也可能没被限定）。拆开之后每个批次至多只有一个
 * `requiredRoomId`，分房时才能真正把它们放进各自被要求的考场；没被限定的学生单独成批，正常按分房倾向铺。
 */
function splitByRequiredRoom(
  demand: SeatingDemand,
  pickRoom: (studentIndex: number) => string | undefined,
): SeatingDemand[] {
  const buckets = new Map<string, number[]>();
  const unpinned: number[] = [];
  for (const index of demand.students) {
    const roomId = pickRoom(index);
    if (roomId == null) {
      unpinned.push(index);
      continue;
    }
    const list = buckets.get(roomId) ?? [];
    list.push(index);
    buckets.set(roomId, list);
  }
  if (buckets.size === 0) return [demand];

  const out: SeatingDemand[] = [];
  for (const [roomId, students] of buckets) {
    out.push({ ...demand, students, requiredRoomId: roomId });
  }
  if (unpinned.length > 0) out.push({ ...demand, students: unpinned });
  return out;
}

/** 某套座位适用的限定：命中这套座位里的学生，且 roomId 为空或就是这套座位的考场。 */
function constraintsForGroup(
  applicable: readonly ApplicableConstraint[],
  groupStudents: readonly number[],
  roomId: string,
): Constraint[] {
  const members = new Set(groupStudents);
  const out: Constraint[] = [];
  for (const { constraint, hits } of applicable) {
    if (constraint.roomId && constraint.roomId !== roomId) continue;
    for (const index of hits) {
      if (members.has(index)) {
        out.push(constraint);
        break;
      }
    }
  }
  return out;
}

/** 某个「被 roomId 限定」的批次没能放进指定考场的原因 */
interface UnsatisfiedDemand {
  key: string;
  roomId: string;
  students: number;
  reason: "unknown-room" | "capacity" | "conflict";
}

interface Allocation {
  groups: SeatingGroup[];
  ok: boolean;
  missingSeats: number;
  /** 被多个批次共用的考场 id（按出现顺序） */
  sharedRooms: string[];
  /** 被 roomId 限定、却没能进指定考场的批次（要变成明确诊断，绝不静默改成「不限考场」） */
  unsatisfied: UnsatisfiedDemand[];
}

/**
 * 把若干「需求组」铺到给定考场里。
 *
 * - `demand.requiredRoomId` 有值 = 这批学生被 `roomId` 限定：**只能**放进那个考场，放不下就记进 `unsatisfied`
 *   由上层报错，绝不改放到别的考场（那等于把限定悄悄丢掉）。
 * - `sameCombination`：每个批次独占考场，绝不与别的批次同房；不够就报缺座，不偷偷混排。
 * - `fillRooms`：先把当前考场填满再换下一个；只允许与**逐时段不冲突**的批次共用， 共用时把那批学生**并进同一个座位方案**（并集、subjects 取并集、只排一次座位），
 *   这样同一考场同时段不会出现两套各自从 1 号开始的座位号。
 */
function allocateDemands(
  demands: SeatingDemand[],
  rooms: RoomSpec[],
  slots: readonly TimeSlot[],
  preference: GroupPreference,
): Allocation {
  const groups: SeatingGroup[] = [];
  const signatures = demands.map((demand) => slotSignature(demand.subjects, slots));
  const roomTakers = new Map<string, Set<number>>();
  const roomIndexOf = new Map(rooms.map((room, index) => [room.id, index]));
  const state = rooms.map(() => ({ used: 0, occupants: [] as number[] }));
  // fillRooms 下每个考场「还没填满」的那套座位；兼容批次都并进它
  const openGroups = new Map<number, SeatingGroup>();
  const unsatisfied: UnsatisfiedDemand[] = [];
  let cursor = 0;
  let missingSeats = 0;

  const place = (demandIndex: number, roomIndex: number, chunk: number[]): void => {
    if (chunk.length === 0) return;
    const demand = demands[demandIndex]!;
    const room = rooms[roomIndex]!;
    const roomState = state[roomIndex]!;
    const takers = roomTakers.get(room.id) ?? new Set<number>();
    takers.add(demandIndex);
    roomTakers.set(room.id, takers);
    roomState.used += chunk.length;
    if (!roomState.occupants.includes(demandIndex)) roomState.occupants.push(demandIndex);

    const open = preference === "fillRooms" ? openGroups.get(roomIndex) : undefined;
    if (open) {
      open.students.push(...chunk);
      for (const subject of demand.subjects) {
        if (!open.subjects.includes(subject)) open.subjects.push(subject);
      }
      return;
    }
    const group: SeatingGroup = {
      kind: demand.kind,
      key: demand.key,
      students: [...chunk],
      subjects: [...demand.subjects],
      room,
    };
    groups.push(group);
    if (preference === "fillRooms") openGroups.set(roomIndex, group);
  };

  const canEnter = (demandIndex: number, roomIndex: number): boolean => {
    const roomState = state[roomIndex]!;
    if (roomState.used === 0) return true;
    // sameCombination：考场已被别的批次占用 → 不能进
    if (preference === "sameCombination") return false;
    return roomState.occupants.every((other) =>
      canShareRoom(signatures[other]!, signatures[demandIndex]!),
    );
  };

  // 被 roomId 限定的批次先分房，保证它先拿到指定考场的座位
  const order = demands
    .map((_, index) => index)
    .sort((a, b) => {
      const pinnedA = demands[a]!.requiredRoomId == null ? 1 : 0;
      const pinnedB = demands[b]!.requiredRoomId == null ? 1 : 0;
      return pinnedA - pinnedB || a - b;
    });

  for (const demandIndex of order) {
    const demand = demands[demandIndex]!;
    let remaining = demand.students;

    if (demand.requiredRoomId != null) {
      const roomIndex = roomIndexOf.get(demand.requiredRoomId);
      if (roomIndex === undefined) {
        unsatisfied.push({
          key: demand.key,
          roomId: demand.requiredRoomId,
          students: remaining.length,
          reason: "unknown-room",
        });
        missingSeats += remaining.length;
        continue;
      }
      if (!canEnter(demandIndex, roomIndex)) {
        unsatisfied.push({
          key: demand.key,
          roomId: demand.requiredRoomId,
          students: remaining.length,
          reason: "conflict",
        });
        missingSeats += remaining.length;
        continue;
      }
      const free = roomCapacity(rooms[roomIndex]!) - state[roomIndex]!.used;
      const chunk = remaining.slice(0, free);
      remaining = remaining.slice(chunk.length);
      place(demandIndex, roomIndex, chunk);
      if (remaining.length > 0) {
        unsatisfied.push({
          key: demand.key,
          roomId: demand.requiredRoomId,
          students: remaining.length,
          reason: "capacity",
        });
        missingSeats += remaining.length;
      }
      continue;
    }

    while (remaining.length > 0) {
      if (cursor >= rooms.length) {
        missingSeats += remaining.length;
        break;
      }
      const roomIndex = cursor;
      const capacity = roomCapacity(rooms[roomIndex]!);

      if (preference === "sameCombination") {
        // 每批次独占考场：一个考场只装同一个批次，同一个批次的后续学生另起考场
        if (state[roomIndex]!.used > 0 || capacity <= 0) {
          cursor += 1;
          continue;
        }
        const chunk = remaining.slice(0, capacity);
        remaining = remaining.slice(chunk.length);
        place(demandIndex, roomIndex, chunk);
        cursor += 1;
        continue;
      }

      // fillRooms：先把这个考场填满
      if (state[roomIndex]!.used >= capacity || !canEnter(demandIndex, roomIndex)) {
        cursor += 1;
        continue;
      }
      const chunk = remaining.slice(0, capacity - state[roomIndex]!.used);
      remaining = remaining.slice(chunk.length);
      place(demandIndex, roomIndex, chunk);
    }
  }

  const sharedRooms = [...roomTakers.entries()]
    .filter(([, takers]) => takers.size > 1)
    .map(([roomId]) => roomId);
  return { groups, ok: missingSeats === 0, missingSeats, sharedRooms, unsatisfied };
}

function roomName(room: RoomSpec): string {
  const name = room.name?.trim();
  return name === undefined || name === "" ? room.id : name;
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
    const dedicated = [...new Set(room.dedicatedSubjects)];
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

  // 只有「部分人有选科、部分人没有」时才是「这些人不会进入任何时段」；
  // 全员都没有选科时走下面的单场退化分支，那句话并不成立（见 4b 的退化告警）。
  if (hasSelection && unselected.length > 0) {
    diagnostics.push({
      code: "STUDENT_MISSING_SUBJECTS",
      severity: "warning",
      message: `有 ${unselected.length} 名学生没有选科信息，他们没有进入任何时段`,
      evidence: { studentIds: unselected.slice(0, 10).map((i) => students[i]!.id) },
      suggestions: [],
    });
  }

  /* ---------- 3b. 限定：能应用的进求解，不能应用的明确报错（绝不静默） ---------- */
  const constraints = job.constraints ?? [];
  const roomIdSet = new Set(model.rooms.map((r) => r.spec.id));
  const applicableConstraints: ApplicableConstraint[] = [];

  for (const constraint of constraints) {
    if (!hasAnySelector(constraint)) {
      diagnostics.push({
        code: "CONSTRAINT_NO_SELECTOR",
        severity: "error",
        message: `限定「${constraint.id}」没有写任何选择器（studentIds / classes / combinations / subjects），它不会生效`,
        evidence: { constraintId: constraint.id },
        suggestions: [],
      });
      continue;
    }
    if (constraint.roomId && !roomIdSet.has(constraint.roomId)) {
      diagnostics.push({
        code: "UNKNOWN_ROOM_ID",
        severity: "error",
        message: `限定「${constraint.id}」引用了不存在的考场 ${constraint.roomId}`,
        evidence: { constraintId: constraint.id, roomId: constraint.roomId },
        suggestions: [],
      });
      continue;
    }
    applicableConstraints.push({
      constraint,
      hits: new Set(resolveConstraintStudents(model, constraint)),
    });
  }

  // 学生 → 被 roomId 限定到的考场（去重、按限定出现顺序）
  const requiredRoomsByStudent = new Map<number, string[]>();
  for (const entry of applicableConstraints) {
    const roomId = entry.constraint.roomId;
    if (!roomId) continue;
    for (const index of entry.hits) {
      const list = requiredRoomsByStudent.get(index) ?? [];
      if (!list.includes(roomId)) list.push(roomId);
      requiredRoomsByStudent.set(index, list);
    }
  }

  const generalRoomIds = new Set(generalRooms.map((room) => room.id));
  const dedicatedRoomsOfStudent = (index: number): Set<string> => {
    const out = new Set<string>();
    for (const subject of model.subjectOfStudent[index] ?? []) {
      for (const room of dedicatedRooms.get(subject) ?? []) out.add(room.id);
    }
    return out;
  };

  const conflictingStudents: string[] = [];
  const inapplicableRoomLimits: { studentId: string; roomId: string }[] = [];
  for (const [index, rooms] of requiredRoomsByStudent) {
    const generalRequired = rooms.filter((roomId) => generalRoomIds.has(roomId));
    if (generalRequired.length > 1 && conflictingStudents.length < 20) {
      conflictingStudents.push(`${students[index]!.id}（${generalRequired.join(" / ")}）`);
    }
    const usable = new Set([...generalRequired, ...dedicatedRoomsOfStudent(index)]);
    for (const roomId of rooms) {
      if (!usable.has(roomId) && inapplicableRoomLimits.length < 20) {
        inapplicableRoomLimits.push({ studentId: students[index]!.id, roomId });
      }
    }
  }
  if (conflictingStudents.length > 0) {
    diagnostics.push({
      code: "RULE_INTERSECT_EMPTY",
      severity: "error",
      message: `有 ${conflictingStudents.length} 名学生被多条限定要求去不同的普通考场，同一套座位不可能同时满足`,
      evidence: { students: conflictingStudents },
      suggestions: [],
    });
  }
  if (inapplicableRoomLimits.length > 0) {
    diagnostics.push({
      code: "CONSTRAINT_EMPTY_DOMAIN",
      severity: "error",
      message: `有 ${inapplicableRoomLimits.length} 名学生被 roomId 限定到他们不会去的考场（既不属于主考场，也不属于他们会考的专用考场）`,
      evidence: { students: inapplicableRoomLimits },
      suggestions: [],
    });
  }

  /**
   * 把「被 roomId 限定却没能进指定考场」的批次变成明确诊断。
   *
   * 绝不静默改成「不限考场」：要么进得去，要么报错且 `ok=false`（该结果不得导出）。
   */
  const reportUnsatisfiedRooms = (allocation: Allocation): void => {
    for (const item of allocation.unsatisfied) {
      const room = model.rooms.find((r) => r.spec.id === item.roomId)?.spec;
      const name = room ? roomName(room) : item.roomId;
      if (item.reason === "unknown-room") {
        diagnostics.push({
          code: "UNKNOWN_ROOM_ID",
          severity: "error",
          message: `限定要求的考场 ${item.roomId} 不可用，${item.students} 名学生（${item.key}）无法安排`,
          evidence: { roomId: item.roomId, students: item.students, batch: item.key },
          suggestions: [],
        });
        continue;
      }
      if (item.reason === "capacity") {
        diagnostics.push({
          code: "CONSTRAINT_OVERSATURATED",
          severity: "error",
          message: `限定把学生放进了${name}，但那里只有 ${room ? roomCapacity(room) : 0} 个座位，还差 ${item.students} 个（${item.key}）`,
          evidence: {
            roomId: item.roomId,
            capacity: room ? roomCapacity(room) : 0,
            missingSeats: item.students,
            batch: item.key,
          },
          suggestions: [],
        });
        continue;
      }
      diagnostics.push({
        code: "RULE_INTERSECT_EMPTY",
        severity: "error",
        message: `${name} 已被别的批次占用（${
          options.groupPreference === "sameCombination"
            ? "sameCombination 下每个批次独占考场"
            : "与已有批次逐时段冲突"
        }），被 roomId 限定到这里的学生（${item.key}）无法进入`,
        evidence: { roomId: item.roomId, students: item.students, batch: item.key },
        suggestions: [],
      });
    }
  };

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
      demands.push(
        ...splitByRequiredRoom(
          {
            kind: "regular",
            key: combo,
            students: interleaveByClass(members, model.classOfStudent),
            subjects: [...subjects],
          },
          (index) => requiredRoomIn(requiredRoomsByStudent.get(index), generalRoomIds),
        ),
      );
    }

    // 4b. 非常规主考场：语数外 + 选考科目里「没被专用考场接走」的那些。
    // 按逐时段科目签名分批 —— 签名冲突（同一时段两门科目）的批次不能并进同一套座位，
    // 签名不冲突的批次（例如有政史地把政治/地理拆到两个时段时的物化政 + 物化地）继续共用主考场。
    for (const base of groupIrregularDemands(irregular, model, dedicatedSubjects, slots, core)) {
      demands.push(
        ...splitByRequiredRoom(base, (index) =>
          requiredRoomIn(requiredRoomsByStudent.get(index), generalRoomIds),
        ),
      );
    }

    // 分房倾向（§5.4）：
    //   sameCombination（默认）= 每个批次独占考场，不够直接报 CAPACITY_INSUFFICIENT，不偷偷混排；
    //   fillRooms = 先填满当前考场，只允许把「逐时段不冲突」的批次合并进同一套座位。
    const allocation = allocateDemands(demands, generalRooms, slots, options.groupPreference);
    groups.push(...allocation.groups);
    if (allocation.sharedRooms.length > 0) {
      diagnostics.push({
        code: "ROOMS_SHARED",
        severity: "warning",
        message: `考场紧张：已把逐时段不冲突的批次合并进同一个考场（${allocation.sharedRooms.join("、")}），这些考场会有多个组合的学生`,
        evidence: {
          sharedRooms: allocation.sharedRooms.length,
          roomIds: allocation.sharedRooms,
        },
        suggestions: [],
      });
    }
    reportUnsatisfiedRooms(allocation);
    if (allocation.missingSeats > 0 && allocation.unsatisfied.length === 0) {
      diagnostics.push({
        code: "CAPACITY_INSUFFICIENT",
        severity: "error",
        message: `普通考场不够：还缺 ${allocation.missingSeats} 个座位`,
        evidence: {
          missingSeats: allocation.missingSeats,
          preference: options.groupPreference,
        },
        suggestions: [],
      });
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
      const roomIds = new Set(rooms.map((room) => room.id));
      const dedicatedDemands = splitByRequiredRoom(
        {
          kind: "dedicated",
          key: subject,
          students: interleaveByClass(takers, model.classOfStudent),
          subjects: [subject],
        },
        (index) => requiredRoomIn(requiredRoomsByStudent.get(index), roomIds),
      );
      const dedicated = allocateDemands(dedicatedDemands, rooms, slots, options.groupPreference);
      groups.push(...dedicated.groups);
      reportUnsatisfiedRooms(dedicated);
    }
  } else {
    // 没有选科信息：多场次没法按组合分组，退化成普通单场（`docs/design.md` §5）。
    // 但这**不是**一份多场次结果，`ok` 必须为 false，且要明确说明 —— 绝不静默把单场结果
    // 当成「多场次排考完成」。
    if (students.length > 0) {
      diagnostics.push({
        code: "STUDENT_MISSING_SUBJECTS",
        severity: "warning",
        message: `名单里没有任何选科信息（${students.length} 名考生）：已退化为普通单场排考（1 个时段），这不是多场次结果；无选科的名单请直接用单场 plan()`,
        evidence: { students: students.length, withSelection: 0 },
        suggestions: [],
      });
    }
    const all = students.map((_, i) => i);
    const degenerateDemands = splitByRequiredRoom(
      { kind: "regular", key: "all", students: all, subjects: [] },
      (index) => requiredRoomIn(requiredRoomsByStudent.get(index), generalRoomIds),
    );
    const allocation = allocateDemands(
      degenerateDemands,
      generalRooms,
      slots,
      options.groupPreference,
    );
    groups.push(...allocation.groups);
    reportUnsatisfiedRooms(allocation);
    // 考场/座位不够时不能静默丢人
    if (allocation.missingSeats > 0 && allocation.unsatisfied.length === 0) {
      diagnostics.push({
        code: "CAPACITY_INSUFFICIENT",
        severity: "error",
        message: `普通考场不够：还缺 ${allocation.missingSeats} 个座位`,
        evidence: { missingSeats: allocation.missingSeats },
        suggestions: [],
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
      // 只把「命中这套座位里的学生、且 roomId 为空或就是本考场」的限定交给求解器
      constraints: constraintsForGroup(applicableConstraints, group.students, group.room.id),
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

  /* ---------- 5b. 硬规则复核：一个考场一个时段只能考一科（§5.1） ---------- */
  // 分房时已经按「逐时段不冲突」把关，这里再独立跑一遍真实结果 —— 防御专用考场等其它入口，
  // 也让 CLI / Web / 验收能复用同一个校验函数。
  for (const clash of findRoomSubjectClashes({ slots, seatings })) {
    diagnostics.push({
      code: "ROOM_SUBJECT_CLASH",
      severity: "error",
      message: `${clash.roomName} 在${clash.slotName}同时安排了 ${clash.subjects
        .map((subject) => subjectLabel(subject))
        .join("、")}：一个考场一个时段只能考一科，该结果不得导出`,
      evidence: {
        roomId: clash.roomId,
        slot: clash.slotId,
        slotName: clash.slotName,
        subjects: clash.subjects,
        studentIds: clash.studentIds,
      },
      suggestions: [],
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

  // 「一套座位都没排出来」不是成功：空数组上的 every 会真空为真，必须显式排除并说清原因。
  if (seatings.length === 0 && diagnostics.every((d) => d.severity !== "error")) {
    diagnostics.push({
      code: "NO_STUDENTS",
      severity: "error",
      message:
        students.length === 0
          ? "没有需要安排的考生：所有学生都被排除（included: false），没有生成任何座位方案"
          : "没有生成任何座位方案：没有可用的考生与考场组合",
      evidence: { students: (job.students ?? []).length, participants: students.length },
      suggestions: [],
    });
  }

  // 各套座位没满足的限定汇总到多场次层（形状与单场一致，额外带上是哪个考场）
  const unmetConstraints: PlanAllUnmetConstraint[] = [];
  for (const seating of seatings) {
    for (const unmet of seating.result.unmetConstraints ?? []) {
      unmetConstraints.push({
        constraintId: unmet.constraintId,
        studentIds: [...unmet.studentIds],
        reason: unmet.reason,
        roomId: seating.roomId,
        roomName: seating.roomName,
      });
    }
  }

  const ok =
    hasSelection &&
    seatings.length > 0 &&
    unmetConstraints.length === 0 &&
    diagnostics.every((d) => d.severity !== "error") &&
    overRoomLimit.length === 0 &&
    seatings.every((s) => s.result.ok);

  return {
    ok,
    slots,
    seatings,
    byStudent,
    emptyRooms,
    overRoomLimit,
    unmetConstraints,
    diagnostics,
  };
}

// 保持既有公共 API：core 的入口一直从这里取 subjectListLabel
export { subjectListLabel } from "./subjects";
