import { resolveConstraintStudents } from "./domain";
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
import type { Diagnostic, GroupPreference, Job, PlanOptions, PlanResult, RoomSpec } from "./types";

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

interface Allocation {
  groups: SeatingGroup[];
  ok: boolean;
  missingSeats: number;
  /** 被多个批次共用的考场 id（按出现顺序） */
  sharedRooms: string[];
}

/**
 * 把若干「需求组」铺到普通考场里。
 *
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
  let roomIndex = 0;
  let used = 0;
  // fillRooms 下当前这个「还没填满」的座位方案；同一考场的兼容批次都并进它
  let current: SeatingGroup | null = null;
  let occupants: number[] = [];
  let missingSeats = 0;

  const markTaker = (roomId: string, demandIndex: number): void => {
    const takers = roomTakers.get(roomId) ?? new Set<number>();
    takers.add(demandIndex);
    roomTakers.set(roomId, takers);
  };

  const openRoom = (): void => {
    roomIndex += 1;
    used = 0;
    current = null;
    occupants = [];
  };

  for (let di = 0; di < demands.length; di += 1) {
    const demand = demands[di]!;
    let remaining = demand.students;

    while (remaining.length > 0) {
      if (roomIndex >= rooms.length) {
        missingSeats += remaining.length;
        break;
      }
      const room = rooms[roomIndex]!;
      const capacity = roomCapacity(room);

      if (preference === "sameCombination") {
        // 每批次独占考场：一个考场只装同一个批次，同一个批次的后续学生另起考场
        const chunk = remaining.slice(0, capacity);
        remaining = remaining.slice(chunk.length);
        groups.push({
          kind: demand.kind,
          key: demand.key,
          students: chunk,
          subjects: [...demand.subjects],
          room,
        });
        markTaker(room.id, di);
        openRoom();
        continue;
      }

      // fillRooms：先把这个考场填满
      if (used >= capacity) {
        openRoom();
        continue;
      }
      if (
        current != null &&
        !occupants.every((other) => canShareRoom(signatures[other]!, signatures[di]!))
      ) {
        // 与当前考场里的批次逐时段冲突 → 不共用，换下一个考场
        openRoom();
        continue;
      }

      const chunk = remaining.slice(0, capacity - used);
      remaining = remaining.slice(chunk.length);
      if (current == null) {
        current = {
          kind: demand.kind,
          key: demand.key,
          students: [],
          subjects: [...demand.subjects],
          room,
        };
        groups.push(current);
      }
      current.students.push(...chunk);
      for (const subject of demand.subjects) {
        if (!current.subjects.includes(subject)) current.subjects.push(subject);
      }
      markTaker(room.id, di);
      occupants.push(di);
      used += chunk.length;
    }
  }

  const sharedRooms = [...roomTakers.entries()]
    .filter(([, takers]) => takers.size > 1)
    .map(([roomId]) => roomId);
  return { groups, ok: missingSeats === 0, missingSeats, sharedRooms };
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

  // 多场次是「按组合分组分房」，目前没有把限定纳入分房的算法（docs/design.md §5.4）。
  // 绝不静默：只要 job 带了限定就明确告诉老师「这次没应用」，需要限定请改走单场。
  const constraints = job.constraints ?? [];
  if (hasSelection && constraints.length > 0) {
    const affected = new Set<number>();
    for (const constraint of constraints) {
      for (const index of resolveConstraintStudents(model, constraint)) affected.add(index);
    }
    diagnostics.push({
      code: "CONSTRAINTS_IGNORED_MULTI",
      severity: "warning",
      message: `多场次排考暂不支持限定：本次没有应用 job 里的 ${constraints.length} 条限定（涉及 ${affected.size} 名学生）；需要限定请用 --single 单场排`,
      evidence: { constraints: constraints.length, students: affected.size },
      suggestions: [
        {
          id: "use-single-plan",
          label: "改用单场排考以应用限定：exam-seat plan --single",
          effect: "限定会作为硬约束生效；但不再按选科分时段、分考场",
        },
      ],
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

    // 4b. 非常规主考场：语数外 + 选考科目里「没被专用考场接走」的那些。
    // 按逐时段科目签名分批 —— 签名冲突（同一时段两门科目）的批次不能并进同一套座位，
    // 签名不冲突的批次（例如有政史地把政治/地理拆到两个时段时的物化政 + 物化地）继续共用主考场。
    demands.push(...groupIrregularDemands(irregular, model, dedicatedSubjects, slots, core));

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
    if (!allocation.ok) {
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
    let placed = 0;
    for (const chunk of fillRooms(all, generalRooms)) {
      placed += chunk.students.length;
      groups.push({
        kind: "regular",
        key: "all",
        students: chunk.students,
        subjects: [],
        room: chunk.room,
      });
    }
    // 考场/座位不够时不能静默丢人
    if (placed < all.length) {
      diagnostics.push({
        code: "CAPACITY_INSUFFICIENT",
        severity: "error",
        message: `普通考场不够：还缺 ${all.length - placed} 个座位`,
        evidence: { missingSeats: all.length - placed },
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

  const ok =
    hasSelection &&
    seatings.length > 0 &&
    diagnostics.every((d) => d.severity !== "error") &&
    overRoomLimit.length === 0 &&
    seatings.every((s) => s.result.ok);

  return { ok, slots, seatings, byStudent, emptyRooms, overRoomLimit, diagnostics };
}

// 保持既有公共 API：core 的入口一直从这里取 subjectListLabel
export { subjectListLabel } from "./subjects";
