import type { CompiledModel } from "./model";
import { resolveColRef, resolveRowRef } from "./numbering";
import { normalizeCombination } from "./subjects";
import type { Constraint } from "./types";

export interface ConstraintSeatSet {
  constraint: Constraint;
  /** 这条限定实际命中的学生下标（选择器解析结果） */
  studentIndices: number[];
  /** 全局座位下标 */
  seats: Set<number>;
  /** 考场下标 → 该考场贡献的座位数 */
  perRoom: Map<number, number>;
  /** 因为绝对号越界而被整体剔除的考场 */
  droppedRooms: string[];
  /** 用了绝对号但没指定考场 */
  absoluteWithoutRoom: boolean;
  /** 引用了不存在的考场 */
  unknownRoomId?: string;
  /** 一个选择器都没写 */
  noSelector: boolean;
}

/**
 * 把一条限定的「选择器」解析成学生下标。
 *
 * 多个选择器之间取**并集**（被任意一个命中就算命中）； 同一个选择器内部多个值也取并集。
 */
export function hasAnySelector(constraint: Constraint): boolean {
  return (
    (constraint.studentIds?.length ?? 0) > 0 ||
    (constraint.classes?.length ?? 0) > 0 ||
    (constraint.combinations?.length ?? 0) > 0 ||
    (constraint.subjects?.length ?? 0) > 0
  );
}

export function resolveConstraintStudents(model: CompiledModel, constraint: Constraint): number[] {
  const hasSelector =
    (constraint.studentIds?.length ?? 0) > 0 ||
    (constraint.classes?.length ?? 0) > 0 ||
    (constraint.combinations?.length ?? 0) > 0 ||
    (constraint.subjects?.length ?? 0) > 0;
  if (!hasSelector) return [];

  const out = new Set<number>();

  if ((constraint.studentIds?.length ?? 0) > 0) {
    for (const id of constraint.studentIds) {
      const index = model.studentIndexById.get(id);
      if (index !== undefined) out.add(index);
    }
  }

  if ((constraint.classes?.length ?? 0) > 0) {
    const wanted = new Set(constraint.classes.map((c) => c.trim()));
    for (let i = 0; i < model.students.length; i += 1) {
      if (wanted.has(model.students[i]!.className)) out.add(i);
    }
  }

  if ((constraint.combinations?.length ?? 0) > 0) {
    const wanted = new Set(constraint.combinations.map((c) => normalizeCombination(c)));
    for (let i = 0; i < model.students.length; i += 1) {
      const combo = model.combinationOfStudent[i];
      if (combo && wanted.has(normalizeCombination(combo))) out.add(i);
    }
  }

  if ((constraint.subjects?.length ?? 0) > 0) {
    const wanted = new Set(constraint.subjects);
    for (let i = 0; i < model.students.length; i += 1) {
      const subjects = model.subjectOfStudent[i];
      if (subjects?.some((s) => wanted.has(s))) out.add(i);
    }
  }

  return [...out].sort((a, b) => a - b);
}

/** 把一条限定编译成可用座位集合。语义值按每个候选考场自身的行列数解析。 */
export function compileConstraintSeats(
  model: CompiledModel,
  constraint: Constraint,
): ConstraintSeatSet {
  const absoluteWithoutRoom =
    !constraint.roomId &&
    ((constraint.rows ?? []).some((r) => typeof r === "number") ||
      (constraint.cols ?? []).some((c) => typeof c === "number"));

  const targetRooms = constraint.roomId
    ? model.rooms.filter((r) => r.spec.id === constraint.roomId)
    : model.rooms;

  const studentIndices = resolveConstraintStudents(model, constraint);
  const result: ConstraintSeatSet = {
    constraint,
    studentIndices,
    seats: new Set<number>(),
    perRoom: new Map<number, number>(),
    droppedRooms: [],
    absoluteWithoutRoom,
    noSelector: studentIndices.length === 0 && !hasAnySelector(constraint),
  };

  if (constraint.roomId && targetRooms.length === 0) {
    result.unknownRoomId = constraint.roomId;
    return result;
  }

  for (const room of targetRooms) {
    const rowList = resolveAxis(constraint.rows, (ref) => resolveRowRef(room.spec, ref));
    const colList = resolveAxis(constraint.cols, (ref) => resolveColRef(room.spec, ref));

    // 某个轴写了限定，但该考场一个都解析不出来 → 整个考场不贡献座位
    if (rowList === "none" || colList === "none") {
      result.droppedRooms.push(room.spec.id);
      continue;
    }

    const rows = rowList === "all" ? range(1, room.spec.rows) : rowList;
    const cols = colList === "all" ? range(1, room.spec.cols) : colList;

    let added = 0;
    for (const row of rows) {
      for (const col of cols) {
        const seat = room.grid[(row - 1) * room.spec.cols + (col - 1)];
        if (seat === undefined || seat < 0) continue;
        result.seats.add(seat);
        added += 1;
      }
    }
    result.perRoom.set(room.index, added);
  }

  return result;
}

type AxisResolution = number[] | "all" | "none";

function resolveAxis<T>(refs: T[] | undefined, resolve: (ref: T) => number | null): AxisResolution {
  if (!refs || refs.length === 0) return "all";
  const out: number[] = [];
  const seen = new Set<number>();
  for (const ref of refs) {
    const value = resolve(ref);
    if (value == null) continue;
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out.length === 0 ? "none" : out;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i += 1) out.push(i);
  return out;
}

export type StudentDomain = Set<number> | null;

export interface DomainBundle {
  /** 每条限定编译出的座位集合，与 model.job.constraints 顺序一致 */
  constraintSets: ConstraintSeatSet[];
  /** 每个学生的可用座位集合；null = 全部座位 */
  domains: StudentDomain[];
  /** 该学生命中的限定下标 */
  studentConstraints: number[][];
  /** 学生 → 由模型下标指向 */
  studentIndexOf: Map<string, number>;
  constraintIndexOf: Map<string, number>;
}

/** 为所有参加考试的学生编译可用座位集合。 */
export function compileDomains(model: CompiledModel): DomainBundle {
  const constraints = model.job.constraints ?? [];
  const constraintSets = constraints.map((c) => compileConstraintSeats(model, c));

  const pragmatic = new Map<string, number>();
  for (let i = 0; i < model.students.length; i += 1) {
    const id = model.students[i]!.id;
    if (!pragmatic.has(id)) pragmatic.set(id, i);
  }

  const constraintIndexOf = new Map<string, number>();
  for (let i = 0; i < constraints.length; i += 1) constraintIndexOf.set(constraints[i]!.id, i);

  const studentConstraints: number[][] = Array.from({ length: model.students.length }, () => []);
  for (let ci = 0; ci < constraints.length; ci += 1) {
    for (const si of constraintSets[ci]!.studentIndices) {
      studentConstraints[si]!.push(ci);
    }
  }

  const domains: StudentDomain[] = Array.from(
    { length: model.students.length },
    () => null as StudentDomain,
  );
  for (let si = 0; si < model.students.length; si += 1) {
    const hits = studentConstraints[si]!;
    if (hits.length === 0) continue;
    // 从最小的集合开始求交，减少比较次数
    const ordered = [...hits].sort(
      (a, b) => (constraintSets[a]!.seats.size ?? 0) - (constraintSets[b]!.seats.size ?? 0),
    );
    let acc: Set<number> | null = null;
    for (const ci of ordered) {
      const set = constraintSets[ci]!.seats;
      if (acc == null) {
        acc = new Set(set);
      } else {
        const next = new Set<number>();
        for (const seat of acc) if (set.has(seat)) next.add(seat);
        acc = next;
      }
      if (acc.size === 0) break;
    }
    domains[si] = acc;
  }

  return {
    constraintSets,
    domains,
    studentConstraints,
    studentIndexOf: pragmatic,
    constraintIndexOf,
  };
}

export function domainSize(domain: StudentDomain, model: CompiledModel): number {
  return domain == null ? model.seatCount : domain.size;
}

/** 用匈牙利算法（Kuhn）检查「所有受限学生能否各自拿到一个互不相同的座位」。 只做座位唯一性检查，不考虑邻班约束——那是求解器的事。 */
export function checkSeatMatching(
  domains: StudentDomain[],
  seatCount: number,
  limit = 400_000,
): { ok: boolean; unmatched: number[] } {
  const constrained: number[] = [];
  let edgeBudget = 0;
  for (let i = 0; i < domains.length; i += 1) {
    const d = domains[i];
    if (d == null) continue;
    constrained.push(i);
    edgeBudget += d.size;
  }
  if (constrained.length === 0) return { ok: true, unmatched: [] };
  if (edgeBudget > limit) return { ok: true, unmatched: [] };

  const seatOwner = new Int32Array(seatCount).fill(-1);

  const tryAssign = (student: number, visited: Uint8Array): boolean => {
    const domain = domains[student]!;
    for (const seat of domain) {
      if (visited[seat] === 1) continue;
      visited[seat] = 1;
      const owner = seatOwner[seat]!;
      if (owner === -1 || tryAssign(owner, visited)) {
        seatOwner[seat] = student;
        return true;
      }
    }
    return false;
  };

  const unmatched: number[] = [];
  for (const student of constrained) {
    const visited = new Uint8Array(seatCount);
    if (!tryAssign(student, visited)) unmatched.push(student);
  }
  return { ok: unmatched.length === 0, unmatched };
}
