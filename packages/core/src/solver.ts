import type { StudentDomain } from "./domain";
import type { CompiledModel } from "./model";
import { RoomClassCaps } from "./room-cap";
import type { Adjacency, Conflict, RelaxMode } from "./types";
import { isSameClassRelaxed, mulberry32 } from "./util";

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
  /**
   * 「同班人数超过该考场上限」的超出量之和（`relaxSameClass` 为数字时才有意义；0 = 全部满足）。
   * 与相邻冲突一样是要最小化的违规量：数字形态下该考场不判同班相邻，但同班人数不得超过 `n`。
   */
  capViolationCount: number;
  iterations: number;
  /** 本次的迭代预算（`min(4_000_000, max(1000, timeLimitMs × 400))`）—— 同输入必得同预算 */
  iterationBudget: number;
  /** 是否被**墙钟兜底**提前掐断（正常路径恒为 false；true 表示结果不完整） */
  truncated: boolean;
  elapsedMs: number;
  completed: boolean;
}

const W_CONFLICT = 1000;
const W_PIN_SOFT = 400;
const W_PIN_HARD_PRIORITY = 50;

/** 迭代硬上限：`timeLimitMs` 换算出的迭代预算不会超过它（保持历史上限，避免超长跑） */
const MAX_ITERATIONS = 4_000_000;
/**
 * `timeLimitMs` → 迭代预算的**固定换算系数**。
 *
 * 系数是**常量**，所以预算只由输入决定（同输入同预算 → 同迭代数 → 同结果，铁律 2）； 实测本机约 1300 迭代/ms，取 400 留余量；默认 10s × 400 = 400 万 =
 * 历史上限。
 */
const ITERATIONS_PER_MS = 400;
const MIN_ITERATIONS = 1000;
/** 墙钟兜底的检查间隔（防「单次迭代极慢」把进程卡死，只在兜底路径上有意义） */
const TRUNCATION_CHECK_MASK = 8191;

/** 模拟退火 + 贪心初始化。纯函数：同输入同 seed 必得同结果。 */
export function solve(input: SolveInput): SolveOutput {
  const { model, domains, seed, timeLimitMs, relax } = input;
  const started = Date.now();
  const nStudents = model.students.length;
  const seatCount = model.seatCount;

  const studentAtSeat = new Int32Array(seatCount).fill(-1);
  const seatOfStudent = new Int32Array(nStudents).fill(-1);

  // 放宽了「同班相邻」的考场：这些座位上的同班相邻不算冲突（`docs/design.md` §5.8.1）
  const seatRelaxed = new Uint8Array(seatCount);
  for (const room of model.rooms) {
    if (!isSameClassRelaxed(room.spec)) continue;
    for (let s = room.firstSeat; s < room.firstSeat + room.seatCount; s += 1) seatRelaxed[s] = 1;
  }

  // `relaxSameClass` 为**数字**的考场：不判同班相邻，但同班人数不得超过 n（0 = 不限人数）
  const caps = new RoomClassCaps(model);

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
      capViolationCount: 0,
      iterations: 0,
      iterationBudget: 0,
      truncated: false,
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
    caps.add(student, seat);
  };

  const sameClassNeighborCount = (student: number, seat: number): number => {
    if (seatRelaxed[seat] === 1) return 0;
    const cls = model.classOfStudent[student]!;
    let count = 0;
    const end = model.neighborStart[seat + 1]!;
    for (let k = model.neighborStart[seat]!; k < end; k += 1) {
      const other = studentAtSeat[model.neighborList[k]!]!;
      if (other >= 0 && model.classOfStudent[other] === cls) count += 1;
    }
    return count;
  };

  // 1) 受限学生先坐：在可用集合里挑同班邻居最少、且不超同班上限的座位
  for (const student of constrained) {
    const domain = domains[student]!;
    let bestSeat = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (const seat of domain) {
      if (studentAtSeat[seat]! >= 0) continue;
      const cost = sameClassNeighborCount(student, seat) + caps.penalty(student, seat) * 2;
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
    if (sameClassNeighborCount(student, cursor) > 0 || caps.penalty(student, cursor) > 0) {
      let scanned = 0;
      for (let s = cursor + 1; s < seatCount && scanned < 64; s += 1) {
        if (studentAtSeat[s]! >= 0) continue;
        scanned += 1;
        if (sameClassNeighborCount(student, s) === 0 && caps.penalty(student, s) === 0) {
          chosen = s;
          break;
        }
      }
    }
    place(student, chosen);
    if (chosen === cursor) cursor += 1;
  }

  // 3) 兜底：**严格模式（用户没 relax）下只允许域内空位**。域内确实没空位就不硬塞 —— 该生保持「未安排」，
  //    由 `unplacedStudents` → `SEARCH_FAILED` → 独立校验的 `ENTRY_MISSING_STUDENT` 走不可交付路径。
  //    ⚠️ 绝不能无条件退回「任意空位」：那会**自然产出违反用户限定的名单**（docs/design.md §18 R-6）。
  //    用户显式 `--relax` 时要的是「违反最少并交付」，这时才允许越域（由 `violatedStudents` 如实标注）。
  for (let i = 0; i < nStudents; i += 1) {
    if (seatOfStudent[i]! >= 0) continue;
    const domain = domains[i];
    if (domain == null) {
      // 无任何限定的学生：任何空位都在他的「域」里
      for (let s = 0; s < seatCount; s += 1) {
        if (studentAtSeat[s]! >= 0) continue;
        place(i, s);
        break;
      }
      continue;
    }
    let placed = false;
    for (const seat of domain) {
      if (studentAtSeat[seat]! >= 0) continue;
      place(i, seat);
      placed = true;
      break;
    }
    if (placed || strict) continue;
    // 显式放宽：允许「尽量排」（越域），由 `violatedStudents` / `CONSTRAINT_UNMET` 如实报出
    for (let s = 0; s < seatCount; s += 1) {
      if (studentAtSeat[s]! >= 0) continue;
      place(i, s);
      break;
    }
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
      if (seatRelaxed[a] === 1) continue;
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
    if (seatRelaxed[seat] === 1) return 0;
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
      if (seatRelaxed[s] === 1) continue;
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
  let capViolations = caps.debtTotal();
  let bestConflicts = conflicts;
  let bestCap = capViolations;
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
    caps.rebuild(studentAtSeat);
    conflicts = bestConflicts;
    capViolations = bestCap;
    violations = bestViolations;
  };

  // 初始状态只有在「零冲突、零超上限、零违反」时才算完成；软约束模式下也要继续优化违反数
  let completed = conflicts === 0 && capViolations === 0 && violations === 0;

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

  // 预算是**迭代次数**（确定性）；时间只用来换算预算，不进循环条件
  const iterationBudget = Math.min(
    MAX_ITERATIONS,
    Math.max(MIN_ITERATIONS, Math.round(timeLimitMs * ITERATIONS_PER_MS)),
  );
  // 墙钟**兜底**：只在「单次迭代极慢」导致远超预算耗时时才触发，命中即标记结果不完整（truncated），
  // 并且**绝不**参与正常轨迹 —— 正常路径完全由 iterationBudget 决定。
  const hardDeadline = started + Math.max(timeLimitMs * 4, 30_000);
  let truncated = false;
  let temperature = 1.6;
  const cooling = 0.999995;
  const minTemperature = 0.02;
  let iterations = 0;
  let stale = 0;

  while (!completed && iterations < iterationBudget) {
    if ((iterations & TRUNCATION_CHECK_MASK) === 0 && Date.now() > hardDeadline) {
      truncated = true;
      break;
    }
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
    // 同班人数上限：先把「两人换考场」的计数变更落账，再量超出量的变化（被拒时回滚）
    const capDelta = caps.apply(s1, s2, u, v);
    swapSeats(s1, s2);
    const after = pairsInAffected();
    const delta = W_CONFLICT * (after - before) + W_CONFLICT * capDelta + W_PIN * pinDelta;

    if (delta <= 0 || rng() < Math.exp(-delta / temperature)) {
      conflicts += after - before;
      capViolations += capDelta;
      violations += pinDelta;
      if (
        conflicts < bestConflicts ||
        (conflicts === bestConflicts && capViolations < bestCap) ||
        (conflicts === bestConflicts && capViolations === bestCap && violations < bestViolations)
      ) {
        bestConflicts = conflicts;
        bestCap = capViolations;
        bestViolations = violations;
        bestSeatOf = Int32Array.from(seatOfStudent);
        stale = 0;
        if (conflicts === 0 && capViolations === 0 && violations === 0) {
          completed = true;
          break;
        }
      } else {
        stale += 1;
      }
    } else {
      swapSeats(s1, s2);
      caps.revert(s1, s2, u, v);
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

  if (
    bestConflicts < conflicts ||
    (bestConflicts === conflicts && bestCap < capViolations) ||
    (bestConflicts === conflicts && bestCap === capViolations && bestViolations < violations)
  ) {
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
    capViolationCount: caps.debtTotal(),
    iterations,
    iterationBudget,
    truncated,
    elapsedMs: Date.now() - started,
    completed:
      conflictList.length === 0 &&
      violatedStudents.length === 0 &&
      unplacedStudents.length === 0 &&
      caps.debtTotal() === 0,
  };
}

/** 枚举所有相邻同班座位对。放宽了「同班相邻」的考场跳过（那边本来就允许同班相邻）。 */
export function collectConflicts(model: CompiledModel, studentAtSeat: Int32Array): Conflict[] {
  const out: Conflict[] = [];
  for (let s = 0; s < model.seatCount; s += 1) {
    const room = model.rooms[model.seatRoom[s]!]!;
    if (isSameClassRelaxed(room.spec)) continue;
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
