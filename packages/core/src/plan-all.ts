import { compileDomains, hasAnySelector, resolveConstraintStudents } from "./domain";
import { compileModel } from "./model";
import type { CompiledModel } from "./model";
import { roomCapacity } from "./numbering";
import { normalizeOptions, plan, planDelivery, validationIssueDiagnostics } from "./plan";
import { resolveAdjacency } from "./precheck";
import { deriveTimeSlots, findSlotConflicts, normalizeSlots } from "./schedule";
import type { TimeSlot } from "./schedule";
import {
  CORE_SUBJECTS,
  compareCombinationNames,
  isRegularCombination,
  normalizeCombination,
  subjectLabel,
} from "./subjects";
import type {
  Constraint,
  Diagnostic,
  GroupPreference,
  Job,
  PlanDelivery,
  PlanOptions,
  PlanResult,
  RoomSpec,
  UnmetConstraint,
} from "./types";
import {
  describeSameClassRelax,
  isSameClassRelaxed,
  relaxedClassLimit,
  roomCombination,
} from "./util";
import { validateAll } from "./validate";

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
  /**
   * 借考学生：学生 id → 他在**这套座位**里只考这些科目（其余时段在各自的主考场）。
   *
   * 例如某生 T6 生物在第十八考场借考：这套座位里 `borrowedSubjects[某生] = ["biology"]`， 他其它时段的座位不在这里。
   */
  borrowedSubjects?: Record<string, string[]>;
  /** 本考场已放宽「同班相邻」（`RoomSpec.relaxSameClass`），监考表表头要标注 */
  relaxedSameClass?: boolean;
}

/** 一处借考落位（某学生某科目在哪个考场的哪个座位）。 */
export interface BorrowedSeat {
  studentId: string;
  name: string;
  className: string;
  subject: string;
  subjectLabel: string;
  roomId: string;
  roomName: string;
  seatNo: number;
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
  /** 整体交付状态：任一套座位 `blocked` 或 `validateAll()` 出 error → 整体 `blocked`（见 {@link PlanDelivery}） */
  delivery?: PlanDelivery;
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
  /** 已放宽「同班相邻」的考场 id（`RoomSpec.relaxSameClass`），按 rooms 顺序 */
  relaxedRooms: string[];
  /** 借考落位明细（没有借考时是空数组） */
  borrowings: BorrowedSeat[];
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
  kind: "regular" | "irregular-main" | "dedicated" | "borrow";
  key: string;
  /** 同一次拆分的两段共享同一个 originKey：合并进同一套座位时靠它相认 */
  originKey?: string;
  /** Model.students 的下标 */
  students: number[];
  /** 这套座位覆盖的科目 */
  subjects: string[];
  room: RoomSpec;
  /** 借考落位：学生下标 → 在这套座位里只考这些科目（其余时段在各自的主考场） */
  borrowers?: Map<number, string[]>;
}

/** 一组需要占普通考场的学生 */
interface SeatingDemand {
  kind: SeatingGroup["kind"];
  key: string;
  students: number[];
  subjects: string[];
  /** 被 `roomId` 限定到某个考场：只能放进它，放不下要明确诊断（绝不改成「不限考场」） */
  requiredRoomId?: string;
  /** 被「专属组合考场」（`RoomSpec.combination`）钉住的批次：按顺序依次吃下这些考场的座位， 装不下就走既有缺座路径（绝不偷偷混排到别的考场）。 */
  requiredRoomIds?: string[];
  /** 本批次的选科组合：`RoomSpec.combination` 只收对应组合的批次 */
  combination?: string;
  /**
   * 同一次 `splitByRequiredRoom` 拆出的几段共享同一个 originKey。
   *
   * `sameCombination` 下不同批次绝不共用一个考场，但**同一个原始批次**被 roomId 拆开的 「钉住的 +
   * 未钉住的」两段必须能回到同一套座位，否则未钉住的人会被误判成缺座。
   */
  originKey?: string;
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
  mainSubjectsOfStudent: readonly ReadonlySet<string>[],
  model: CompiledModel,
  slots: readonly TimeSlot[],
): SeatingDemand[] {
  // 1) 每个学生的「主考场科目」= 语数外 + 没被借考/专用考场接走的选考科目（3c 已经算好）；同签名的归为一类
  const classes = new Map<string, { subjects: string[]; members: number[] }>();
  for (const index of irregular) {
    const list = [...(mainSubjectsOfStudent[index] ?? [])];
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
  nextOriginKey: () => string,
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

  // 拆出来的每一段都记同一个 originKey：sameCombination 下它们可以（也只允许它们）回到同一考场
  const originKey = demand.originKey ?? nextOriginKey();
  const out: SeatingDemand[] = [];
  for (const [roomId, students] of buckets) {
    out.push({ ...demand, students, requiredRoomId: roomId, originKey });
  }
  if (unpinned.length > 0) out.push({ ...demand, students: unpinned, originKey });
  return out;
}

/**
 * 把一批学生里「组合有专属考场」的那部分挑出来，单独成批并指定必选考场（`requiredRoomIds`）。
 *
 * 典型的 4a 批次整批就是一个组合；4b 的混合批次也会按组合拆开，保证专属考场真的只收自己人。 没有被组合钉住的学生保持原批不动（继续走 roomId 限定 / 自动分房）。
 */
function splitByCombinationRooms(
  demand: SeatingDemand,
  pickCombination: (studentIndex: number) => string | undefined,
  roomsOfCombination: (combination: string) => readonly RoomSpec[],
  subjectsOf: (studentIndices: readonly number[]) => string[],
): SeatingDemand[] {
  const buckets = new Map<string, number[]>();
  const rest: number[] = [];
  for (const index of demand.students) {
    const combination = pickCombination(index);
    if (combination === undefined) {
      rest.push(index);
      continue;
    }
    const list = buckets.get(combination) ?? [];
    list.push(index);
    buckets.set(combination, list);
  }
  if (buckets.size === 0) return [demand];

  const out: SeatingDemand[] = [];
  for (const [combination, students] of buckets) {
    out.push({
      kind: demand.kind,
      key: combination,
      combination,
      students,
      subjects: subjectsOf(students),
      requiredRoomIds: roomsOfCombination(combination).map((room) => room.id),
      originKey: demand.originKey,
    });
  }
  if (rest.length > 0) out.push({ ...demand, students: rest, subjects: subjectsOf(rest) });
  return out;
}

/**
 * 某套座位适用的限定：命中这套座位里的学生，且 roomId 为空或就是这套座位的考场。
 *
 * 不带 roomId 的行/列限定（如「17 班靠墙」）在子 job 里按本考场自己的行列数解析 —— 借考生的借考座位 也一样吃这类限定（他借考到的考场就是个普通候选考场）。
 */
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

/** 某个「被 roomId / 专属组合限定」的批次没能放进指定考场的原因 */
interface UnsatisfiedDemand {
  key: string;
  roomId: string;
  students: number;
  reason: "unknown-room" | "capacity" | "conflict" | "combination-capacity";
  /** `combination-capacity` 时：专属组合与它钉住的全部考场 */
  combination?: string;
  roomIds?: string[];
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

/** 这批学生是不是被钉死在某个/某些考场上（`roomId` 限定或专属组合考场） */
function isPinnedDemand(demand: SeatingDemand): boolean {
  return demand.requiredRoomId != null || (demand.requiredRoomIds?.length ?? 0) > 0;
}

/**
 * 自动分房时这个考场能不能收这批学生。
 *
 * 设了 `combination`（专属组合）的考场只收同组合的批次；没设的考场照旧谁都收。 被 `roomId` 显式限定钉进来的批次不走这个检查（老师说了算）。
 */
function roomAdmitsDemand(room: RoomSpec, demand: SeatingDemand): boolean {
  const pinned = roomCombination(room);
  return pinned === undefined || pinned === demand.combination;
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

    // 能并进已有座位组的两种情况：
    //   fillRooms —— 逐时段不冲突的批次共用一个考场（座位号只排一次）；
    //   同一次拆分的两段（originKey 相同）—— sameCombination 下也必须并进同一套座位。
    const open = openGroups.get(roomIndex);
    if (
      open &&
      (preference === "fillRooms" ||
        (demand.originKey !== undefined && open.originKey === demand.originKey))
    ) {
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
      originKey: demand.originKey,
    };
    groups.push(group);
    if (preference === "fillRooms" || demand.originKey !== undefined) {
      openGroups.set(roomIndex, group);
    }
  };

  const canEnter = (demandIndex: number, roomIndex: number): boolean => {
    const roomState = state[roomIndex]!;
    if (roomState.used === 0) return true;
    const demand = demands[demandIndex]!;
    // sameCombination：每个批次独占考场；只有同一次拆分的两段（同一个 originKey）例外
    if (preference === "sameCombination") {
      return (
        demand.originKey !== undefined &&
        roomState.occupants.every((other) => demands[other]!.originKey === demand.originKey)
      );
    }
    return roomState.occupants.every((other) =>
      canShareRoom(signatures[other]!, signatures[demandIndex]!),
    );
  };

  // 被 roomId / 专属组合限定的批次先分房，保证它先拿到指定考场的座位
  const order = demands
    .map((_, index) => index)
    .sort((a, b) => {
      const pinnedA = isPinnedDemand(demands[a]!) ? 0 : 1;
      const pinnedB = isPinnedDemand(demands[b]!) ? 0 : 1;
      return pinnedA - pinnedB || a - b;
    });

  for (const demandIndex of order) {
    const demand = demands[demandIndex]!;
    let remaining = demand.students;

    if (demand.requiredRoomIds != null && demand.requiredRoomIds.length > 0) {
      // 专属组合考场：按考场顺序依次吃下这批学生；装不下就报缺座，绝不改放到别的考场。
      let unknownRoomId: string | undefined;
      for (const roomId of demand.requiredRoomIds) {
        if (remaining.length === 0) break;
        const roomIndex = roomIndexOf.get(roomId);
        if (roomIndex === undefined) {
          unknownRoomId = roomId;
          break;
        }
        if (!canEnter(demandIndex, roomIndex)) continue;
        const free = roomCapacity(rooms[roomIndex]!) - state[roomIndex]!.used;
        if (free <= 0) continue;
        const chunk = remaining.slice(0, free);
        remaining = remaining.slice(chunk.length);
        place(demandIndex, roomIndex, chunk);
      }
      if (unknownRoomId !== undefined) {
        unsatisfied.push({
          key: demand.key,
          roomId: unknownRoomId,
          students: remaining.length,
          reason: "unknown-room",
        });
        missingSeats += remaining.length;
      } else if (remaining.length > 0) {
        unsatisfied.push({
          key: demand.key,
          roomId: demand.requiredRoomIds[demand.requiredRoomIds.length - 1]!,
          students: remaining.length,
          reason: "combination-capacity",
          combination: demand.combination,
          roomIds: [...demand.requiredRoomIds],
        });
        missingSeats += remaining.length;
      }
      continue;
    }

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

    // 游标扫到 rooms 末尾时回卷到 0 再扫一遍：被 roomId 拆开的批次不会因为「前面已经走过」
    // 而把空着的考场误判成缺座。同一次回卷内仍找不到才记 missingSeats。
    let wrapped = false;
    while (remaining.length > 0) {
      if (cursor >= rooms.length) {
        if (wrapped) {
          missingSeats += remaining.length;
          break;
        }
        wrapped = true;
        cursor = 0;
        continue;
      }
      const roomIndex = cursor;
      const capacity = roomCapacity(rooms[roomIndex]!);

      // 专属组合考场：自动分房只认它自己的组合，别的批次一律跳过
      if (!roomAdmitsDemand(rooms[roomIndex]!, demand)) {
        cursor += 1;
        continue;
      }

      if (preference === "sameCombination") {
        // 每批次独占考场：一个考场只装同一个批次。例外：同一次拆分的两段（originKey 相同）
        // 必须能回到同一套座位，否则「钉住的 + 未钉住的」会被拆成两个考场甚至误报缺座。
        if (capacity <= 0) {
          cursor += 1;
          continue;
        }
        if (state[roomIndex]!.used > 0) {
          if (!canEnter(demandIndex, roomIndex)) {
            cursor += 1;
            continue;
          }
          const free = capacity - state[roomIndex]!.used;
          if (free <= 0) {
            cursor += 1;
            continue;
          }
          const chunk = remaining.slice(0, free);
          remaining = remaining.slice(chunk.length);
          place(demandIndex, roomIndex, chunk);
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
    .filter(([, takers]) => {
      // 同一次拆分出来的两段共用一个考场不是「考场紧张合并」，不该报 ROOMS_SHARED
      const indices = [...takers];
      const origin = demands[indices[0]!]!.originKey;
      return !(
        origin !== undefined && indices.every((index) => demands[index]!.originKey === origin)
      );
    })
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
  const explicitSlots = options.slots;
  const slots: TimeSlot[] =
    explicitSlots.length > 0
      ? normalizeSlots(explicitSlots)
      : hasSelection
        ? deriveTimeSlots(distinctCombos, core, options.forbiddenSameSlot)
        : [{ id: "T1", name: "第1时段", subjects: [] }];
  if (explicitSlots.length > 0) {
    diagnostics.push({
      code: "SLOTS_PROVIDED",
      severity: "info",
      message: `按老师给定的 ${slots.length} 个时段排考，不再自动推导`,
      evidence: { slots: slots.length, ids: slots.map((slot) => slot.id) },
      suggestions: [],
    });
  }
  // 同一学生同一时段被排了两科 = 时段表本身自相矛盾，不能靠后面「挑第一科」蒙混过去
  const slotConflicts = findSlotConflicts(
    slots,
    students.map((_, index) => {
      const own = model.subjectOfStudent[index];
      return own ? [...core, ...own] : [...core];
    }),
  );
  if (slotConflicts.length > 0) {
    diagnostics.push({
      code: "SLOTS_CONFLICT",
      severity: "error",
      message: `时段表把同一学生的两门科目排进了同一时段（共 ${slotConflicts.length} 处），这份时段表不可用`,
      evidence: {
        conflicts: slotConflicts.slice(0, 20).map((conflict) => ({
          studentId: students[conflict.studentIndex]?.id,
          slotId: conflict.slotId,
          subjects: conflict.subjects,
        })),
      },
      suggestions: [],
    });
  }

  /* ---------- 2. 考场分组：专属组合 / 专用科目 / 普通 ---------- */
  const combinationRooms = new Map<string, RoomSpec[]>();
  const dedicatedRooms = new Map<string, RoomSpec[]>();
  const generalRooms: RoomSpec[] = [];
  for (const room of model.rooms.map((r) => r.spec)) {
    const combination = roomCombination(room);
    if (combination !== undefined) {
      const list = combinationRooms.get(combination) ?? [];
      list.push(room);
      combinationRooms.set(combination, list);
    }
    const dedicated = [...new Set(room.dedicatedSubjects)];
    if (combination !== undefined) {
      // combination 优先：设了专属组合的考场不再进专用科目池
      if (dedicated.length > 0) {
        const raw = room.combination?.trim() ?? "";
        diagnostics.push({
          code: "ROOM_COMBINATION_IGNORED_DEDICATED",
          severity: "warning",
          message: `${roomName(room)} 同时设了专属组合「${raw === "" ? combination : raw}」与专用科目（${dedicated
            .map((subject) => subjectLabel(subject))
            .join("、")}），按专属组合处理`,
          evidence: {
            roomId: room.id,
            combination,
            dedicatedSubjects: dedicated,
          },
          suggestions: [],
        });
      }
      // 仍留在普通考场池里：roomId 限定可以显式把人钉进来，自动分房则由 roomAdmitsDemand 拦
      generalRooms.push(room);
      continue;
    }
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

  // 每个专属组合的参考人数（名单里有没有这个组合的人，用来报 APPLIED / UNKNOWN）
  const combinationCounts = new Map<string, number>();
  for (const [key, list] of model.combinationGroups) {
    const combination = normalizeCombination(key) || key;
    combinationCounts.set(combination, (combinationCounts.get(combination) ?? 0) + list.length);
  }
  for (const [combination, rooms] of combinationRooms) {
    const count = combinationCounts.get(combination) ?? 0;
    for (const room of rooms) {
      const raw = room.combination?.trim() ?? "";
      const label = raw === "" ? combination : raw;
      if (count === 0) {
        diagnostics.push({
          code: "ROOM_COMBINATION_UNKNOWN",
          severity: "warning",
          message: `${roomName(room)} 指定了专属组合「${label}」，但名单里没有这个组合的学生`,
          evidence: { roomId: room.id, combination },
          suggestions: [],
        });
        continue;
      }
      diagnostics.push({
        code: "ROOM_COMBINATION_APPLIED",
        severity: "info",
        message: `${roomName(room)} 专属组合：${combination}（${count} 人）`,
        evidence: {
          roomId: room.id,
          combination,
          students: count,
          roomIds: rooms.map((r) => r.id),
        },
        suggestions: [],
      });
    }
  }

  /* ---------- 2b. 考场级放宽「同班相邻」 ---------- */
  const relaxedRooms: string[] = [];
  for (const room of model.rooms) {
    if (!isSameClassRelaxed(room.spec)) continue;
    relaxedRooms.push(room.spec.id);
    diagnostics.push({
      code: "ROOM_SAME_CLASS_RELAXED",
      severity: "warning",
      message: `${roomName(room.spec)} 已放宽「同班相邻」：${describeSameClassRelax(
        room.spec,
        room.maxSameClass,
        roomCapacity(room.spec),
      )}（原 ${room.maxSameClass}），本考场内同班相邻不再算冲突`,
      evidence: {
        roomId: room.spec.id,
        relaxSameClass: room.spec.relaxSameClass,
        limit: relaxedClassLimit(room.spec, room.maxSameClass, roomCapacity(room.spec)),
        defaultLimit: room.maxSameClass,
      },
      suggestions: [],
    });
  }

  /* ---------- 3. 分学生 ---------- */
  const regularOverrides = options.regularCombinations?.map((c) => normalizeCombination(c));
  const useOverride = (regularOverrides?.length ?? 0) > 0;

  const regularByCombination = new Map<string, number[]>();
  const irregular: number[] = [];
  const unselected: number[] = [];
  /** 每个学生是否按「常规组合」处理（整个考试只在一个考场） */
  const regularOfStudent: boolean[] = Array.from({ length: students.length }, () => false);

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
    regularOfStudent[i] = regular;
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

  // 专属组合考场在子 job 里补一条等价限定：让「rooms[].combination」与「用 constraints 把该组合钉到
  // 同一考场」两种写法给求解器完全一样的输入（否则求解器初始化顺序不同，座位号会跟着漂）。
  for (const [combination, rooms] of combinationRooms) {
    const members: number[] = [];
    for (let i = 0; i < students.length; i += 1) {
      const own = model.combinationOfStudent[i];
      if (own != null && (normalizeCombination(own) || own) === combination) members.push(i);
    }
    if (members.length === 0) continue;
    for (const room of rooms) {
      const raw = room.combination?.trim() ?? "";
      if (normalizeCombination(raw) === "") continue;
      applicableConstraints.push({
        constraint: {
          id: `room-combination:${room.id}`,
          note: `${roomName(room)} 的专属组合`,
          roomId: room.id,
          combinations: [raw],
        },
        hits: new Set(members),
      });
    }
  }

  /* ---------- 3c. 借考：subjectRoom 校验 + 逐生逐科路由（§5.8.2） ---------- */
  /** 学生被 roomId 钉住的普通考场（主考场）；没钉住就是 undefined */
  const mainRoomOfStudent = (index: number): string | undefined =>
    requiredRoomIn(requiredRoomsByStudent.get(index), generalRoomIds);

  // 1) subjectRoom 逐条校验：科目没选 / 考场不存在 / 科目不在任何时段 → 明确报错并丢弃这条
  const subjectRoomEntries = new Map<number, { subject: string; roomId: string }[]>();
  for (let i = 0; i < students.length; i += 1) {
    const map = students[i]!.subjectRoom;
    if (map == null) continue;
    const own = model.subjectOfStudent[i];
    const accepted: { subject: string; roomId: string }[] = [];
    for (const [subject, roomId] of Object.entries(map)) {
      if (!own || !own.includes(subject)) {
        diagnostics.push({
          code: "SUBJECT_ROOM_UNKNOWN_SUBJECT",
          severity: "error",
          message: `${students[i]!.name || students[i]!.id} 没有选 ${subjectLabel(subject)}，这条借考不生效`,
          evidence: { studentId: students[i]!.id, subject, roomId },
          suggestions: [],
        });
        continue;
      }
      if (!roomIdSet.has(roomId)) {
        diagnostics.push({
          code: "SUBJECT_ROOM_UNKNOWN_ROOM",
          severity: "error",
          message: `${students[i]!.name || students[i]!.id} 的${subjectLabel(subject)}借考目标考场 ${roomId} 不存在`,
          evidence: { studentId: students[i]!.id, subject, roomId },
          suggestions: [],
        });
        continue;
      }
      if (!slots.some((slot) => slot.subjects.includes(subject))) {
        diagnostics.push({
          code: "SUBJECT_ROOM_NO_SLOT",
          severity: "error",
          message: `${subjectLabel(subject)}不在任何时段里，${students[i]!.name || students[i]!.id} 的这条借考没有对应场次`,
          evidence: { studentId: students[i]!.id, subject, roomId },
          suggestions: [],
        });
        continue;
      }
      accepted.push({ subject, roomId });
    }
    if (accepted.length > 0) subjectRoomEntries.set(i, accepted);
  }

  // 2) 「钉住批次开考哪些科目」：被 roomId 钉到普通考场 R 的学生（或 R 是某组合的专属考场），
  //    合起来会让 R 开考哪些科目。用于「自动优待」：R 本来就开考这一科时，钉在 R 的学生不必专门
  //    跑去专用考场。
  const pinnedBatchSubjects = new Map<string, Set<string>>();
  const addToPinnedBatch = (roomId: string, index: number): void => {
    const subjects = pinnedBatchSubjects.get(roomId) ?? new Set<string>();
    pinnedBatchSubjects.set(roomId, subjects);
    for (const subject of core) subjects.add(subject);
    const own = model.subjectOfStudent[index] ?? [];
    if (!hasSelection || regularOfStudent[index]) {
      // 常规组合：整批一起考，core + 全部选科
      for (const subject of own) subjects.add(subject);
      return;
    }
    // 非常规组合：core + 非专用选科 + 显式 subjectRoom 指向该考场的那几科
    for (const subject of own) {
      if (!dedicatedSubjects.has(subject)) subjects.add(subject);
    }
    for (const entry of subjectRoomEntries.get(index) ?? []) {
      if (entry.roomId === roomId) subjects.add(entry.subject);
    }
  };
  for (let i = 0; i < students.length; i += 1) {
    const roomId = mainRoomOfStudent(i);
    if (roomId !== undefined) addToPinnedBatch(roomId, i);
  }
  // 专属组合考场：这个组合的整批学生也是「钉在」这些考场上的（自动优待要看得见他们开考哪些科）
  for (const [combination, rooms] of combinationRooms) {
    for (let i = 0; i < students.length; i += 1) {
      const own = model.combinationOfStudent[i];
      if (own == null || (normalizeCombination(own) || own) !== combination) continue;
      for (const room of rooms) addToPinnedBatch(room.id, i);
    }
  }

  /** 一处借考请求（校验通过、路由判定为「借考」的科目） */
  interface BorrowRequest {
    studentIndex: number;
    subject: string;
    roomId: string;
  }
  const borrowRequests: BorrowRequest[] = [];
  /** 每个学生的「主考场科目」= 留在主考场考的科目 */
  const mainSubjectsOfStudent: Set<string>[] = [];
  /** 专用考场真正要接收的非常规学生：科目 → 学生下标 */
  const dedicatedTakers = new Map<string, number[]>();

  for (let i = 0; i < students.length; i += 1) {
    const main = new Set<string>(core);
    const own = model.subjectOfStudent[i];
    if (!own) {
      mainSubjectsOfStudent.push(main);
      continue;
    }
    const mainRoomId = mainRoomOfStudent(i);
    const regular = !hasSelection || regularOfStudent[i];
    for (const subject of own) {
      const explicit = subjectRoomEntries.get(i)?.find((entry) => entry.subject === subject);
      if (explicit) {
        // 显式 subjectRoom 优先：指向主考场 = 留在主考场；指向别处 = 借考
        if (mainRoomId !== undefined && explicit.roomId === mainRoomId) main.add(subject);
        else borrowRequests.push({ studentIndex: i, subject, roomId: explicit.roomId });
        continue;
      }
      if (!regular && dedicatedSubjects.has(subject)) {
        // 自动优待：钉在普通考场 R、且 R 的钉住批次本来就开考这一科 → 留在 R
        const pinned = mainRoomId === undefined ? undefined : pinnedBatchSubjects.get(mainRoomId);
        if (pinned?.has(subject)) {
          main.add(subject);
        } else {
          const list = dedicatedTakers.get(subject) ?? [];
          list.push(i);
          dedicatedTakers.set(subject, list);
        }
        continue;
      }
      main.add(subject);
    }
    mainSubjectsOfStudent.push(main);
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
      if (item.reason === "combination-capacity") {
        const capacity = (item.roomIds ?? []).reduce(
          (sum, roomId) => sum + (model.rooms.find((r) => r.spec.id === roomId)?.capacity ?? 0),
          0,
        );
        diagnostics.push({
          code: "CAPACITY_INSUFFICIENT",
          severity: "error",
          message: `专属组合「${item.combination ?? item.key}」被钉在 ${
            (item.roomIds ?? []).join("、") || name
          }，但这些考场只有 ${capacity} 个座位，还差 ${item.students} 个`,
          evidence: {
            combination: item.combination,
            roomIds: item.roomIds,
            capacity,
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

  // 每次「按 roomId 拆批」给一个唯一的 originKey，标记「这几段来自同一个原始批次」
  let originSeq = 0;
  const nextOriginKey = (): string => `batch-${originSeq++}`;

  if (hasSelection) {
    const demands: SeatingDemand[] = [];

    /** 学生 → 他所属组合的专属考场组合名（`RoomSpec.combination`）；没有就是 undefined */
    const pinnedCombinationOf = (index: number): string | undefined => {
      const own = model.combinationOfStudent[index];
      if (own == null) return undefined;
      const combination = normalizeCombination(own) || own;
      return combinationRooms.has(combination) ? combination : undefined;
    };
    /** 这批学生的「主考场科目」并集 */
    const subjectsOf = (indices: readonly number[]): string[] => {
      const set = new Set<string>();
      for (const index of indices) {
        for (const subject of mainSubjectsOfStudent[index] ?? []) set.add(subject);
      }
      return [...set];
    };
    // 先按 roomId 限定拆（显式限定优先），再把「组合有专属考场」的部分单独成批钉到那些考场
    const pushDemand = (segment: SeatingDemand): void => {
      if (segment.requiredRoomId !== undefined) {
        demands.push(segment);
        return;
      }
      demands.push(
        ...splitByCombinationRooms(
          segment,
          pinnedCombinationOf,
          (combination) => combinationRooms.get(combination) ?? [],
          subjectsOf,
        ),
      );
    };

    // 4a. 常规组合：各自占一批普通考场（人数多的先分，减少碎片）。
    // 科目取每生「主考场科目」的并集 —— 显式借考出去的科目不会从主考场消失（除非全班都借走了）。
    // 并列人数时按冻结的拼音序排序：core 里不许依赖 ICU（`localeCompare` 随 Node/ICU 版本可能给出
    // 不同顺序，会直接破坏「同输入同 seed 必得同结果」）。
    const regularEntries = [...regularByCombination.entries()].sort(
      (a, b) => b[1].length - a[1].length || compareCombinationNames(a[0], b[0]),
    );
    for (const [combo, members] of regularEntries) {
      for (const segment of splitByRequiredRoom(
        {
          kind: "regular",
          key: combo,
          students: interleaveByClass(members, model.classOfStudent),
          subjects: subjectsOf(members),
        },
        (index) => requiredRoomIn(requiredRoomsByStudent.get(index), generalRoomIds),
        nextOriginKey,
      )) {
        pushDemand(segment);
      }
    }

    // 4b. 非常规主考场：语数外 + 选考科目里「没被专用考场 / 借考接走」的那些（3c 已经算好）。
    // 按逐时段科目签名分批 —— 签名冲突（同一时段两门科目）的批次不能并进同一套座位，
    // 签名不冲突的批次（例如有政史地把政治/地理拆到两个时段时的物化政 + 物化地）继续共用主考场。
    for (const base of groupIrregularDemands(irregular, mainSubjectsOfStudent, model, slots)) {
      for (const segment of splitByRequiredRoom(
        base,
        (index) => requiredRoomIn(requiredRoomsByStudent.get(index), generalRoomIds),
        nextOriginKey,
      )) {
        pushDemand(segment);
      }
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

    // 4c. 专用考场：只接收「按 3c 规则确实要去专用考场」的非常规学生
    // （被显式借考接走的、被自动优待留在主考场的都不在这里）。
    for (const [subject, rooms] of dedicatedRooms) {
      const takers = dedicatedTakers.get(subject) ?? [];
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
        nextOriginKey,
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
      nextOriginKey,
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

  /* ---------- 4d. 借考落位（分房完成后、求解前，§5.8.2） ---------- */
  /** 学生下标 → 在这套座位里只考这些科目 */
  interface PlacedBorrow {
    groupIndex: number;
    studentIndex: number;
    subject: string;
    roomId: string;
  }
  const placedBorrows: PlacedBorrow[] = [];
  /**
   * 目标考场已经有座位方案：借考生只来这一个时段，**不**在求解器里占一个「全程固定座位」。
   *
   * 把他塞进求解器会让他和其它同班学生一起被「靠门列」这类限定钉在同一列，凭空造出一个排不下的 局面（真实 job：R18 里 2517 会变成 5
   * 人挤一列）。所以先记下来，等座位排完后挑一个「该时段空着」 的座位（5a）——挑位时照常吃 roomId-less 的行列限定，排不下就明确报错。
   */
  interface PendingBorrow {
    groupIndex: number;
    studentIndex: number;
    subject: string;
    roomId: string;
  }
  const pendingBorrows: PendingBorrow[] = [];

  for (const request of borrowRequests) {
    const student = students[request.studentIndex]!;
    const room = model.rooms.find((entry) => entry.spec.id === request.roomId)?.spec;
    // 3c 已经校验过考场存在；这里再防御一次，绝不静默丢诊断
    if (!room) continue;

    const roomGroups = groups
      .map((group, index) => ({ group, index }))
      .filter((entry) => entry.group.room.id === request.roomId);

    // 硬规则：该科目所在时段里，目标考场所有座位组在该时段开考的都必须是这一科
    const slot = slots.find((entry) => entry.subjects.includes(request.subject))!;
    const subjectsInSlot = new Set<string>();
    for (const { group } of roomGroups) {
      for (const subject of group.subjects) {
        if (slot.subjects.includes(subject)) subjectsInSlot.add(subject);
      }
    }
    const sortedSubjects = [...subjectsInSlot].sort();
    if (sortedSubjects.some((subject) => subject !== request.subject)) {
      const clashLabels = sortedSubjects.map((subject) => subjectLabel(subject)).join("、");
      diagnostics.push({
        code: "SUBJECT_ROOM_CLASH",
        severity: "error",
        message: `${roomName(room)} 在${slot.name}已经安排了 ${clashLabels}，${student.name || student.id} 的${subjectLabel(request.subject)}不能再借考到这里：一个考场一个时段只能考一科`,
        evidence: {
          studentId: student.id,
          subject: request.subject,
          roomId: request.roomId,
          slot: slot.id,
          subjects: sortedSubjects,
        },
        suggestions: [],
      });
      continue;
    }

    if (roomGroups.length === 0) {
      // 目标考场完全没用上 → 新建一套只含借考生的座位组，交给求解器正常排：
      // 他一个人吃自己的行列限定，座位号也从这套方案里出。
      const group: SeatingGroup = {
        kind: "borrow",
        key: `borrow:${request.roomId}`,
        students: [request.studentIndex],
        subjects: [request.subject],
        room,
        borrowers: new Map([[request.studentIndex, [request.subject]]]),
      };
      groups.push(group);
      placedBorrows.push({
        groupIndex: groups.length - 1,
        studentIndex: request.studentIndex,
        subject: request.subject,
        roomId: request.roomId,
      });
      continue;
    }

    // 目标考场已有座位方案：先把这一科并进这套座位（findRoomSubjectClashes 才看得见），座位等 5a 挑
    const target = roomGroups[0]!;
    if (!target.group.subjects.includes(request.subject)) {
      target.group.subjects.push(request.subject);
    }
    pendingBorrows.push({
      groupIndex: target.index,
      studentIndex: request.studentIndex,
      subject: request.subject,
      roomId: request.roomId,
    });
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
    const result = plan(
      subJob,
      {
        seed: options.seed,
        adjacency: options.adjacency,
        forceKing: options.forceKing,
        relax: options.relax,
        timeLimitMs: options.timeLimitMs,
      },
      // 每套房座位不是用户意义上的「单场」：单场专属诊断（如专属组合被忽略）不要混进来
      { fromPlanAll: true },
    );

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
    // 借考登记：学生 id → 在这套座位里只考这些科目
    const borrowedSubjects: Record<string, string[]> = {};
    for (const [index, subjects] of group.borrowers ?? []) {
      borrowedSubjects[students[index]!.id] = [...subjects];
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
      borrowedSubjects: Object.keys(borrowedSubjects).length > 0 ? borrowedSubjects : undefined,
      relaxedSameClass: isSameClassRelaxed(group.room) ? true : undefined,
    });
  }

  /* ---------- 5a. 借考落位：给借考生挑一个「该时段空着」的座位（挑位照常吃行列限定） ---------- */
  // 候选座位 = 该生在本考场能坐的座位（rows/cols 等 roomId-less 限定按目标考场自己的行列数解析、
  // 多条取交集）；排除「这个时段会来本考场考试的其它人」已经占掉的座位号 —— 不同时段可以复用同一个
  // 座号，所以借考生可以坐一个「别的人这个时段不在」的座位。排不下就明确报错，绝不静默放宽。
  const borrowedSeatUsed = new Map<string, Set<number>>();

  for (const pending of pendingBorrows) {
    const student = students[pending.studentIndex]!;
    const room = model.rooms.find((entry) => entry.spec.id === pending.roomId)!.spec;
    const seating = seatings[pending.groupIndex]!;
    const group = groups[pending.groupIndex]!;
    const slot = slots.find((entry) => entry.subjects.includes(pending.subject))!;

    const subJob: Job = {
      jobVersion: job.jobVersion,
      students: [{ ...student }],
      rooms: [room],
      constraints: constraintsForGroup(applicableConstraints, [pending.studentIndex], room.id),
    };
    const subModel = compileModel(subJob);
    const domain = compileDomains(subModel).domains[0] ?? null;

    // 这个时段「会来本考场考试」的人占掉的座位号
    const slotSubjects = group.subjects.filter((subject) => slot.subjects.includes(subject));
    const taken = new Set<number>();
    for (const index of group.students) {
      const ownAll = new Set([...core, ...(model.subjectOfStudent[index] ?? [])]);
      if (!slotSubjects.some((subject) => ownAll.has(subject))) continue;
      const seatNo = seating.seatNoById[students[index]!.id];
      if (seatNo !== undefined) taken.add(seatNo);
    }
    for (const seatNo of borrowedSeatUsed.get(`${pending.groupIndex}|${slot.id}`) ?? []) {
      taken.add(seatNo);
    }

    const occupiedAnywhere = new Set(Object.values(seating.seatNoById));
    const candidates: number[] = [];
    for (let seatNo = 1; seatNo <= roomCapacity(room); seatNo += 1) {
      const seatIndex = subModel.rooms[0]!.firstSeat + seatNo - 1;
      if (domain != null && !domain.has(seatIndex)) continue;
      if (taken.has(seatNo)) continue;
      candidates.push(seatNo);
    }
    // 优先用完全没人用的座位号，免得监考表里同一个号出现两行
    const seatNo =
      candidates.find((candidate) => !occupiedAnywhere.has(candidate)) ?? candidates[0];

    if (seatNo === undefined) {
      if (domain != null && domain.size === 0) {
        diagnostics.push({
          code: "CONSTRAINT_EMPTY_DOMAIN",
          severity: "error",
          message: `${roomName(room)} 里没有一个座位满足这条行列限定，${student.name || student.id} 的${subjectLabel(pending.subject)}无法借考到这里`,
          evidence: { studentId: student.id, subject: pending.subject, roomId: pending.roomId },
          suggestions: [],
        });
      } else {
        diagnostics.push({
          code: "SUBJECT_ROOM_NO_SEAT",
          severity: "error",
          message: `${roomName(room)} 在${slot.name}已经没有空位了，${student.name || student.id} 的${subjectLabel(pending.subject)}无法借考`,
          evidence: {
            studentId: student.id,
            subject: pending.subject,
            roomId: pending.roomId,
            slot: slot.id,
          },
          suggestions: [],
        });
      }
      continue;
    }

    if (!seating.studentIds.includes(student.id)) seating.studentIds.push(student.id);
    seating.seatNoById[student.id] = seatNo;
    // 借考生坐的是「这个时段空着」的座位号：那个号原来没人用才登记，避免盖掉主座位组的人
    seating.studentBySeatNo[seatNo] ??= student.id;
    const borrowers = seating.borrowedSubjects ?? {};
    borrowers[student.id] = [...(borrowers[student.id] ?? []), pending.subject];
    seating.borrowedSubjects = borrowers;
    if (!seating.subjects.includes(pending.subject)) seating.subjects.push(pending.subject);
    const usedSeats = borrowedSeatUsed.get(`${pending.groupIndex}|${slot.id}`) ?? new Set<number>();
    usedSeats.add(seatNo);
    borrowedSeatUsed.set(`${pending.groupIndex}|${slot.id}`, usedSeats);
    placedBorrows.push({
      groupIndex: pending.groupIndex,
      studentIndex: pending.studentIndex,
      subject: pending.subject,
      roomId: pending.roomId,
    });
  }

  /* ---------- 5c. 借考结果：落位明细 + 独立记号 + 逐条留痕 ---------- */
  const borrowings: BorrowedSeat[] = [];
  /** 学生下标 → 借考科目 → 目标考场的座位方案（byStudent 里借考优先于主座位组） */
  const borrowSeatingOf = new Map<number, Map<string, SeatingPlan>>();
  for (const placed of placedBorrows) {
    const seating = seatings[placed.groupIndex];
    const student = students[placed.studentIndex]!;
    if (!seating) continue;
    const seatingsForStudent =
      borrowSeatingOf.get(placed.studentIndex) ?? new Map<string, SeatingPlan>();
    seatingsForStudent.set(placed.subject, seating);
    borrowSeatingOf.set(placed.studentIndex, seatingsForStudent);

    const seatNo = seating.seatNoById[student.id];
    if (seatNo === undefined) continue;
    borrowings.push({
      studentId: student.id,
      name: student.name,
      className: student.className,
      subject: placed.subject,
      subjectLabel: subjectLabel(placed.subject),
      roomId: seating.roomId,
      roomName: seating.roomName,
      seatNo,
    });
    diagnostics.push({
      code: "SUBJECT_ROOM_APPLIED",
      severity: "info",
      message: `${student.name || student.id} 的${subjectLabel(placed.subject)}到${seating.roomName}借考（${seatNo} 号）`,
      evidence: {
        studentId: student.id,
        subject: placed.subject,
        roomId: seating.roomId,
        seatNo,
      },
      suggestions: [],
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
      const borrowed = seating.borrowedSubjects?.[id];
      for (const subject of keys) {
        // 借考生在这套座位里只考借考的那几科：别的科目仍然由主座位组说话
        // （借考生同时出现在主座位组与目标座位组的 studentIds 里，不能让目标组把它们盖掉）
        if (borrowed !== undefined && subject !== "" && !borrowed.includes(subject)) continue;
        map.set(subject, seating);
      }
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
      // 借考优先：这个时段考的正好是他借考出去的科目时，去目标考场的座位方案
      // （主座位组的 subjects 里可能因为别的同学也有这一科而命中，必须用借考覆盖它）
      const seating = subject
        ? (borrowSeatingOf.get(i)?.get(subject) ?? seatingFor.get(subject))
        : seatingFor.get(subject);
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

  const result: PlanAllResult = {
    ok,
    slots,
    seatings,
    byStudent,
    emptyRooms,
    overRoomLimit,
    unmetConstraints,
    relaxedRooms,
    borrowings,
    diagnostics,
  };

  // 交付判定：导出层不必记得自己跑校验 —— 这里就把 `validateAll()` 的 error 与逐套房座位的
  // `delivery` 一起汇入（任一套 blocked → 整体 blocked）。
  result.delivery = evaluateDeliveryAll(job, result);

  return result;
}

/**
 * 多场次的**独立复算**：重跑 `validateAll()` 并结合逐套房座位的 `delivery` 判定整体交付状态。
 *
 * 导出层写文件前应当调它（结果可能已被改动过）；`planAll()` 内部也用它保证只有一处判据。
 */
export function evaluateDeliveryAll(job: Job, result: PlanAllResult): PlanDelivery {
  if (result.seatings.some((seating) => seating.result.delivery === "blocked")) return "blocked";
  const validationErrors = validationIssueDiagnostics(validateAll(job, result).issues);
  return planDelivery([...result.diagnostics, ...validationErrors]);
}

// 保持既有公共 API：core 的入口一直从这里取 subjectListLabel
export { subjectListLabel } from "./subjects";
