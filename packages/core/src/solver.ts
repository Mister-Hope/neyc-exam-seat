import type { StudentDomain } from "./domain";
import type { CompiledModel } from "./model";
import type { Adjacency, Conflict, RelaxMode } from "./types";
import { mulberry32 } from "./util";

export interface SolveInput {
  model: CompiledModel;
  domains: StudentDomain[];
  adjacency: Adjacency;
  seed: number;
  timeLimitMs: number;
  relax: RelaxMode;
}

export interface SolveOutput {
  /** 学生 → 座位下标；-1 = 未安排 */
  seatOfStudent: Int32Array;
  /** 座位下标 → 学生下标；-1 = 空 */
  studentAtSeat: Int32Array;
  /** 未满足限定的学生下标 */
  violatedStudents: number[];
  /** 未安排的学生下标 */
  unplacedStudents: number[];
  conflicts: Conflict[];
  conflictCount: number;
  iterations: number;
  elapsedMs: number;
  completed: boolean;
}

const W_CONFLICT = 1000;
const W_PIN_SOFT = 400;
const W_PIN_HARD_PRIORITY = 50;

/** 模拟退火 + 贪心初始化。纯函数：同输入同 seed 必得同结果。 */
export function solve(input: SolveInput): SolveOutput {
  const { model, domains, seed, timeLimitMs, relax } = input;
  const started = Date.now();
  const nStudents = model.students.length;
  const seatCount = model.seatCount;

  const studentAtSeat = new Int32Array(seatCount).fill(-1);
  const seatOfStudent = new Int32Array(nStudents).fill(-1);

  const rng = mulberry32(seed);
  const strict = relax === "none";
  const W_PIN = relax === "minConflicts" ? W_PIN_HARD_PRIORITY : W_PIN_SOFT;

  const allowed = (student: number, seat: number): boolean => {
    const d = domains[student];
    return d == null || d.has(seat);
  };

  if (nStudents === 0 || seatCount === 0) {
    return {
      seatOfStudent,
      studentAtSeat,
      violatedStudents: [],
      unplacedStudents: Array.from({ length: nStudents }, (_, index) => index),
      conflicts: [],
      conflictCount: 0,
      iterations: 0,
      elapsedMs: Date.now() - started,
      completed: nStudents === 0,
    };
  }

  /* ---------------- 贪心初始化 ---------------- */

  const constrained: number[] = [];
  const free: number[] = [];
  for (let i = 0; i < nStudents; i += 1) {
    if (domains[i] == null) free.push(i);
    else constrained.push(i);
  }
  constrained.sort((a, b) => {
    const diff = domains[a]!.size - domains[b]!.size;
    if (diff !== 0) return diff;
    return model.students[a]!.id < model.students[b]!.id ? -1 : 1;
  });

  const place = (student: number, seat: number): void => {
    studentAtSeat[seat] = student;
    seatOfStudent[student] = seat;
  };

  const sameClassNeighborCount = (student: number, seat: number): number => {
    const cls = model.classOfStudent[student]!;
    let count = 0;
    const end = model.neighborStart[seat + 1]!;
    for (let k = model.neighborStart[seat]!; k < end; k += 1) {
      const other = studentAtSeat[model.neighborList[k]!]!;
      if (other >= 0 && model.classOfStudent[other] === cls) count += 1;
    }
    return count;
  };

  // 1) 受限学生先坐：在可用集合里挑同班邻居最少的座位
  for (const student of constrained) {
    const domain = domains[student]!;
    let bestSeat = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const seat of domain) {
      if (studentAtSeat[seat]! >= 0) continue;
      const cost = sameClassNeighborCount(student, seat);
      if (cost < bestCost) {
        bestCost = cost;
        bestSeat = seat;
      }
      if (bestCost === 0) break;
    }
    if (bestSeat >= 0) place(student, bestSeat);
  }

  // 2) 其余学生按「考场顺序、座位号顺序」填满，顺手避开同班邻居
  let cursor = 0;
  for (const student of free) {
    while (cursor < seatCount && studentAtSeat[cursor]! >= 0) cursor += 1;
    if (cursor >= seatCount) break;
    let chosen = cursor;
    if (sameClassNeighborCount(student, cursor) > 0) {
      let scanned = 0;
      for (let s = cursor + 1; s < seatCount && scanned < 64; s += 1) {
        if (studentAtSeat[s]! >= 0) continue;
        scanned += 1;
        if (sameClassNeighborCount(student, s) === 0) {
          chosen = s;
          break;
        }
      }
    }
    place(student, chosen);
    if (chosen === cursor) cursor += 1;
  }

  // 3) 兜底：贪心没安排下的学生，塞进任意空位（必要时违反限定，由报告说明）
  for (let i = 0; i < nStudents; i += 1) {
    if (seatOfStudent[i]! >= 0) continue;
    let target = -1;
    const domain = domains[i];
    if (domain) {
      for (const seat of domain)
        if (studentAtSeat[seat]! < 0) {
          target = seat;
          break;
        }
    }
    if (target < 0) {
      for (let s = 0; s < seatCount; s += 1)
        if (studentAtSeat[s]! < 0) {
          target = s;
          break;
        }
    }
    if (target < 0) break;
    place(i, target);
  }

  /* ---------------- 舞台结构 ---------------- */

  const occupied: number[] = [];
  const occupiedPos = new Int32Array(seatCount).fill(-1);
  const rebuildOccupied = (): void => {
    occupied.length = 0;
    occupiedPos.fill(-1);
    for (let s = 0; s < seatCount; s += 1) {
      if (studentAtSeat[s]! >= 0) {
        occupiedPos[s] = occupied.length;
        occupied.push(s);
      }
    }
  };
  rebuildOccupied();

  const swapSeats = (s1: number, s2: number): void => {
    const u = studentAtSeat[s1]!;
    const v = studentAtSeat[s2]!;
    studentAtSeat[s1] = v;
    studentAtSeat[s2] = u;
    if (u >= 0) seatOfStudent[u] = s2;
    if (v >= 0) seatOfStudent[v] = s1;
    // 空位与有人位的互换会改变「哪些座位有人」，同步维护
    const p1 = occupiedPos[s1]!;
    const p2 = occupiedPos[s2]!;
    if (p1 >= 0 && p2 < 0) {
      occupied[p1] = s2;
      occupiedPos[s2] = p1;
      occupiedPos[s1] = -1;
    } else if (p1 < 0 && p2 >= 0) {
      occupied[p2] = s1;
      occupiedPos[s1] = p2;
      occupiedPos[s2] = -1;
    }
  };

  /* ---------------- 增量冲突统计 ---------------- */

  const mark = new Int32Array(seatCount).fill(-1);
  const affected = new Int32Array(24);
  let affectedLen = 0;
  let generation = 0;

  const buildAffected = (s1: number, s2: number): void => {
    generation += 1;
    affectedLen = 0;
    const push = (seat: number): void => {
      if (mark[seat] === generation) return;
      mark[seat] = generation;
      affected[affectedLen] = seat;
      affectedLen += 1;
    };
    push(s1);
    push(s2);
    for (const s of [s1, s2]) {
      const end = model.neighborStart[s + 1]!;
      for (let k = model.neighborStart[s]!; k < end; k += 1) push(model.neighborList[k]!);
    }
  };

  const pairsInAffected = (): number => {
    let pairs = 0;
    for (let i = 0; i < affectedLen; i += 1) {
      const a = affected[i]!;
      const ua = studentAtSeat[a]!;
      if (ua < 0) continue;
      const ca = model.classOfStudent[ua]!;
      const end = model.neighborStart[a + 1]!;
      for (let k = model.neighborStart[a]!; k < end; k += 1) {
        const b = model.neighborList[k]!;
        if (mark[b] !== generation) continue;
        const ub = studentAtSeat[b]!;
        if (ub < 0) continue;
        if (model.classOfStudent[ub] === ca) pairs += 1;
      }
    }
    return pairs >> 1;
  };

  const seatConflictCount = (seat: number): number => {
    const u = studentAtSeat[seat]!;
    if (u < 0) return 0;
    const cls = model.classOfStudent[u]!;
    let count = 0;
    const end = model.neighborStart[seat + 1]!;
    for (let k = model.neighborStart[seat]!; k < end; k += 1) {
      const v = studentAtSeat[model.neighborList[k]!]!;
      if (v >= 0 && model.classOfStudent[v] === cls) count += 1;
    }
    return count;
  };

  const countAllConflicts = (): number => {
    let pairs = 0;
    for (let s = 0; s < seatCount; s += 1) {
      const u = studentAtSeat[s]!;
      if (u < 0) continue;
      const cls = model.classOfStudent[u]!;
      const end = model.neighborStart[s + 1]!;
      for (let k = model.neighborStart[s]!; k < end; k += 1) {
        const v = studentAtSeat[model.neighborList[k]!]!;
        if (v >= 0 && model.classOfStudent[v] === cls) pairs += 1;
      }
    }
    return pairs >> 1;
  };

  let violations = 0;
  for (let i = 0; i < nStudents; i += 1) {
    const seat = seatOfStudent[i]!;
    if (seat >= 0 && !allowed(i, seat)) violations += 1;
  }

  let conflicts = countAllConflicts();
  let bestConflicts = conflicts;
  let bestViolations = violations;
  let bestSeatOf = Int32Array.from(seatOfStudent);

  const restoreBest = (): void => {
    studentAtSeat.fill(-1);
    for (let i = 0; i < nStudents; i += 1) {
      const seat = bestSeatOf[i]!;
      seatOfStudent[i] = seat;
      if (seat >= 0) studentAtSeat[seat] = i;
    }
    rebuildOccupied();
    conflicts = bestConflicts;
    violations = bestViolations;
  };

  // 初始状态只有在「零冲突且零违反」时才算完成；软约束模式下也要继续优化违反数
  let completed = conflicts === 0 && violations === 0;

  /* ---------------- 模拟退火 ---------------- */

  const pickSeat = (): number => {
    if (occupied.length === 0) return -1;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      // rng() ∈ [0,1)，乘出来必为非负且远小于 2^31，Math.trunc 与原来的 `| 0` 完全等价
      const s = occupied[Math.trunc(rng() * occupied.length)]!;
      if (seatConflictCount(s) > 0) return s;
    }
    return occupied[Math.trunc(rng() * occupied.length)]!;
  };

  const pickPartner = (s1: number): number => {
    const roll = rng();
    if (roll < 0.55) {
      const start = model.neighborStart[s1]!;
      const end = model.neighborStart[s1 + 1]!;
      const u = studentAtSeat[s1]!;
      const cls = u >= 0 ? model.classOfStudent[u]! : -1;
      const conflicting: number[] = [];
      const others: number[] = [];
      for (let k = start; k < end; k += 1) {
        const n = model.neighborList[k]!;
        const v = studentAtSeat[n]!;
        if (v >= 0 && cls >= 0 && model.classOfStudent[v] === cls) conflicting.push(n);
        else others.push(n);
      }
      if (conflicting.length > 0) return conflicting[Math.trunc(rng() * conflicting.length)]!;
      if (others.length > 0) return others[Math.trunc(rng() * others.length)]!;
    }
    if (roll < 0.9) {
      const room = model.rooms[model.seatRoom[s1]!]!;
      return room.firstSeat + Math.trunc(rng() * room.seatCount);
    }
    return occupied[Math.trunc(rng() * occupied.length)]!;
  };

  const maxIterations = 4_000_000;
  let temperature = 1.6;
  const cooling = 0.999995;
  const minTemperature = 0.02;
  let iterations = 0;
  let stale = 0;

  while (!completed && iterations < maxIterations) {
    if ((iterations & 1023) === 0 && Date.now() - started > timeLimitMs) break;
    iterations += 1;

    const s1 = pickSeat();
    if (s1 < 0) break;
    const s2 = pickPartner(s1);
    if (s2 < 0 || s2 === s1) continue;

    const u = studentAtSeat[s1]!;
    const v = studentAtSeat[s2]!;
    if (u < 0 && v < 0) continue;
    // 空位只能在同考场内交换，保证各考场的占用结构不被破坏
    if ((u < 0 || v < 0) && model.seatRoom[s1] !== model.seatRoom[s2]) continue;

    const uToS2 = u < 0 ? true : allowed(u, s2);
    const vToS1 = v < 0 ? true : allowed(v, s1);
    if (strict && (!uToS2 || !vToS1)) continue;

    let pinDelta = 0;
    if (!strict) {
      if (u >= 0) pinDelta += (uToS2 ? 0 : 1) - (allowed(u, s1) ? 0 : 1);
      if (v >= 0) pinDelta += (vToS1 ? 0 : 1) - (allowed(v, s2) ? 0 : 1);
    }

    buildAffected(s1, s2);
    const before = pairsInAffected();
    swapSeats(s1, s2);
    const after = pairsInAffected();
    const delta = W_CONFLICT * (after - before) + W_PIN * pinDelta;

    if (delta <= 0 || rng() < Math.exp(-delta / temperature)) {
      conflicts += after - before;
      violations += pinDelta;
      if (
        conflicts < bestConflicts ||
        (conflicts === bestConflicts && violations < bestViolations)
      ) {
        bestConflicts = conflicts;
        bestViolations = violations;
        bestSeatOf = Int32Array.from(seatOfStudent);
        stale = 0;
        if (conflicts === 0 && violations === 0) {
          completed = true;
          break;
        }
      } else {
        stale += 1;
      }
    } else {
      swapSeats(s1, s2);
      stale += 1;
    }

    temperature *= cooling;
    if (temperature < minTemperature) {
      temperature = 1.2;
      if (stale > 150_000) {
        restoreBest();
        stale = 0;
      }
    }
  }

  if (bestConflicts < conflicts || (bestConflicts === conflicts && bestViolations < violations)) {
    restoreBest();
  }

  /* ---------------- 结果整理 ---------------- */

  const conflictList = collectConflicts(model, studentAtSeat);
  const violatedStudents: number[] = [];
  const unplacedStudents: number[] = [];
  for (let i = 0; i < nStudents; i += 1) {
    const seat = seatOfStudent[i]!;
    if (seat < 0) {
      unplacedStudents.push(i);
      continue;
    }
    if (!allowed(i, seat)) violatedStudents.push(i);
  }

  return {
    seatOfStudent,
    studentAtSeat,
    violatedStudents,
    unplacedStudents,
    conflicts: conflictList,
    conflictCount: conflictList.length,
    iterations,
    elapsedMs: Date.now() - started,
    completed:
      conflictList.length === 0 && violatedStudents.length === 0 && unplacedStudents.length === 0,
  };
}

/** 枚举所有相邻同班座位对。 */
export function collectConflicts(model: CompiledModel, studentAtSeat: Int32Array): Conflict[] {
  const out: Conflict[] = [];
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
      out.push({
        roomId: room.spec.id,
        seatA: model.seatNo[s]!,
        seatB: model.seatNo[t]!,
        studentA: model.students[u]!.id,
        studentB: model.students[v]!.id,
        className: model.classNames[cls]!,
      });
    }
  }
  return out;
}
