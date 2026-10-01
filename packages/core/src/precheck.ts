import type { DomainBundle } from "./domain";
import { checkSeatMatching, compileDomains } from "./domain";
import type { CompiledModel } from "./model";
import { describeCols, describeRows, seatId } from "./numbering";
import type { Adjacency, Diagnostic, Job, RelaxMode, RoomSpec, Suggestion } from "./types";
import { isSameClassRelaxed, relaxedClassLimit } from "./util";

/** 班级上限用的「本考场最多能容纳同一个班多少人」：放宽后按 `relaxSameClass` 取。 */
function effectiveSameClassLimit(room: RoomSpec, fallback: number, capacity: number): number {
  return relaxedClassLimit(room, fallback, capacity);
}

export interface PrecheckResult {
  diagnostics: Diagnostic[];
  /** 存在致命问题，不必进入求解 */
  fatal: boolean;
  adjacency: Adjacency;
  /** 是否因为班级数不足而自动退化到 4 邻域 */
  downgraded: boolean;
  domains: DomainBundle;
}

/** 班级数低于此值时自动退化到前后左右 4 邻域。 */
export const MIN_CLASSES_FOR_KING = 9;

/** 依据班级数决定实际使用的邻接规则。`forceKing` 由调用方从**合并后**的选项传入。 */
export function resolveAdjacency(
  job: Job,
  requested: Adjacency = "king",
  forceKing = false,
): { adjacency: Adjacency; downgraded: boolean } {
  if (requested === "orthogonal") return { adjacency: "orthogonal", downgraded: false };
  // 老师显式要求「就算班级少也按 8 邻域排」时，尊重这个选择
  if (forceKing || job.options?.forceKing === true) {
    return { adjacency: "king", downgraded: false };
  }
  const classes = new Set<string>();
  for (const s of job.students ?? []) {
    if (s.included === false) continue;
    classes.add(s.className ?? "");
  }
  if (classes.size < MIN_CLASSES_FOR_KING) return { adjacency: "orthogonal", downgraded: true };
  return { adjacency: "king", downgraded: false };
}

export function runPrecheck(
  model: CompiledModel,
  ctx: { adjacency: Adjacency; downgraded: boolean; relax: RelaxMode },
): PrecheckResult {
  const diagnostics: Diagnostic[] = [];
  const push = (d: Diagnostic): void => {
    diagnostics.push(d);
  };

  const job = model.job;
  const rooms = model.rooms;
  const students = model.students;
  const constraints = job.constraints ?? [];

  /* ---------------- 数据完整性 ---------------- */

  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const s of job.students ?? []) {
    if (seenIds.has(s.id)) duplicateIds.add(s.id);
    seenIds.add(s.id);
  }
  if (duplicateIds.size > 0) {
    push({
      code: "STUDENT_DUPLICATE_ID",
      severity: "error",
      message: `名单里有 ${duplicateIds.size} 个重复学号：${[...duplicateIds].slice(0, 5).join("、")}`,
      evidence: { ids: [...duplicateIds] },
      suggestions: [],
    });
  }

  const missingClass = students.filter((s) => !s.className).map((s) => s.id);
  if (missingClass.length > 0) {
    push({
      code: "STUDENT_MISSING_CLASS",
      severity: "error",
      message: `有 ${missingClass.length} 名学生没有班级：${missingClass.slice(0, 5).join("、")}`,
      evidence: { studentIds: missingClass },
      suggestions: [],
    });
  }

  const missingName = students.filter((s) => !s.name).map((s) => s.id);
  if (missingName.length > 0) {
    push({
      code: "STUDENT_MISSING_NAME",
      severity: "warning",
      message: `有 ${missingName.length} 名学生没有姓名，名单里会显示为空`,
      evidence: { studentIds: missingName },
      suggestions: [],
    });
  }

  const invalidRooms = rooms.filter((r) => r.spec.rows < 1 || r.spec.cols < 1);
  if (invalidRooms.length > 0) {
    push({
      code: "INVALID_ROOM_SIZE",
      severity: "error",
      message: `有 ${invalidRooms.length} 个考场的行列数不合法：${invalidRooms
        .map((r) => r.spec.id)
        .join("、")}`,
      evidence: { roomIds: invalidRooms.map((r) => r.spec.id) },
      suggestions: [],
    });
  }

  // 加座列必须落在 [1, cols] 内（`docs/design.md` §5.8.4）：越界会被几何函数静默丢弃，
  // 而老师以为多了座位 —— 这里明确报错，别让容量悄悄变小。
  const invalidExtraSeats = rooms
    .map((r) => ({
      roomId: r.spec.id,
      cols: r.spec.cols,
      extraFrontSeats: (r.spec.extraFrontSeats ?? []).filter(
        (col) => !Number.isInteger(col) || col < 1 || col > r.spec.cols,
      ),
    }))
    .filter((item) => item.extraFrontSeats.length > 0);
  if (invalidExtraSeats.length > 0) {
    push({
      code: "INVALID_ROOM_SIZE",
      severity: "error",
      message: `有 ${invalidExtraSeats.length} 个考场的加座列越界（必须在第 1 到第 ${
        invalidExtraSeats[0]!.cols
      } 列之间）：${invalidExtraSeats.map((item) => item.roomId).join("、")}`,
      evidence: { rooms: invalidExtraSeats },
      suggestions: [],
    });
  }

  for (const c of constraints) {
    if (c.roomId && !rooms.some((r) => r.spec.id === c.roomId)) {
      push({
        code: "UNKNOWN_ROOM_ID",
        severity: "error",
        message: `限定「${c.note ?? c.id}」指定了不存在的考场 ${c.roomId}`,
        evidence: { constraintId: c.id, roomId: c.roomId },
        suggestions: [
          {
            id: `clear-room-${c.id}`,
            label: "把这条限定改为「不限考场」",
            patch: [{ op: "remove", path: `/constraints/${indexOfConstraint(job, c.id)}/roomId` }],
          },
        ],
      });
    }
    const unknown = (c.studentIds ?? []).filter((id) => !model.students.some((s) => s.id === id));
    const unknownExisting = unknown.filter((id) => (job.students ?? []).some((s) => s.id === id));
    if (unknownExisting.length > 0) {
      push({
        code: "UNKNOWN_STUDENT_ID",
        severity: "warning",
        message: `限定「${c.note ?? c.id}」里点名了不存在的学生：${unknownExisting
          .slice(0, 5)
          .join("、")}`,
        evidence: { constraintId: c.id, studentIds: unknownExisting },
        suggestions: [],
      });
    }
  }

  /* ---------------- 容量 ---------------- */

  const seatsTotal = model.seatCount;
  const participants = students.length;

  if (rooms.length === 0) {
    push({
      code: "NO_ROOMS",
      severity: "error",
      message: "还没有配置任何考场",
      suggestions: [
        {
          id: "add-room",
          label: "加一个 6 列 × 7 排的考场",
          patch: [
            {
              op: "add",
              path: "/rooms/-",
              value: { id: "R1", name: "第1考场", rows: 7, cols: 6, doorSide: "right" },
            },
          ],
        },
      ],
    });
  }
  if (participants === 0) {
    push({
      code: "NO_STUDENTS",
      severity: "error",
      message: "参加考试的学生为 0 人",
      suggestions: [],
    });
  }

  if (seatsTotal < participants && rooms.length > 0) {
    const deficit = participants - seatsTotal;
    const suggestions = capacitySuggestions(job, deficit);
    push({
      code: "CAPACITY_INSUFFICIENT",
      severity: "error",
      message: `座位不够：${participants} 人要考，只有 ${seatsTotal} 个座位，还差 ${deficit} 个`,
      evidence: { participants, seatsTotal, deficit },
      suggestions,
    });
  } else if (
    seatsTotal - participants >= rooms.reduce((a, r) => a + r.capacity, 0) / 2 &&
    seatsTotal > 0
  ) {
    const spare = seatsTotal - participants;
    push({
      code: "ROOMS_OVERPROVISIONED",
      severity: "info",
      message: `座位比考生多 ${spare} 个，按顺序填满后排在最后的考场会空置`,
      evidence: { participants, seatsTotal, spare },
      suggestions: [],
    });
  }

  /* ---------------- 班级数 ---------------- */

  const classCount = model.classNames.length;
  if (ctx.downgraded) {
    push({
      code: "TOO_FEW_CLASSES",
      severity: "warning",
      message: `只有 ${classCount} 个班（不足 ${MIN_CLASSES_FOR_KING} 个），已自动退化为「前后左右不同班」，对角允许同班`,
      evidence: { classCount, threshold: MIN_CLASSES_FOR_KING },
      suggestions: [
        {
          id: "force-king",
          label: "仍然按 8 邻域严格排（可能排不出来）",
          effect: "恢复为周围 8 人都不能同班",
          patch: [{ op: "add", path: "/options/forceKing", value: true }],
        },
      ],
    });
  }

  for (let cls = 0; cls < classCount; cls += 1) {
    const size = model.classSizes[cls]!;
    const limit = rooms.reduce(
      (sum, r) => sum + effectiveSameClassLimit(r.spec, r.maxSameClass, r.capacity),
      0,
    );
    if (size > limit) {
      push({
        code: "CLASS_LIMIT_EXCEEDED",
        severity: "error",
        message: `${model.classNames[cls]} 有 ${size} 人，但所有考场加起来最多只能容纳该班 ${limit} 人`,
        evidence: { className: model.classNames[cls], size, limit },
        suggestions: capacitySuggestions(job, size - limit),
      });
    }
  }

  // 考场级放宽「同班相邻」必须留痕（docs/design.md §5.8.1）：每条放宽一个 warning
  for (const room of rooms) {
    if (!isSameClassRelaxed(room.spec)) continue;
    const limit = effectiveSameClassLimit(room.spec, room.maxSameClass, room.capacity);
    push({
      code: "ROOM_SAME_CLASS_RELAXED",
      severity: "warning",
      message: `${room.spec.name ?? room.spec.id} 已放宽「同班相邻」：本考场同班人数上限 ${limit}（正常上限 ${room.maxSameClass}），该考场内同班相邻不再算冲突`,
      evidence: {
        roomId: room.spec.id,
        relaxSameClass: room.spec.relaxSameClass === true ? true : room.spec.relaxSameClass,
        limit,
        defaultLimit: room.maxSameClass,
        capacity: room.capacity,
      },
      suggestions: [],
    });
  }

  /* ---------------- 限定 ---------------- */

  const domains = compileDomains(model);

  for (let ci = 0; ci < domains.constraintSets.length; ci += 1) {
    const cs = domains.constraintSets[ci]!;
    const c = cs.constraint;
    const label = c.note ? `「${c.note}」` : `第 ${ci + 1} 条限定`;
    const description = `考场=${c.roomId ?? "不限"}，排=${describeRows(c.rows)}，列=${describeCols(c.cols)}`;

    if (cs.absoluteWithoutRoom) {
      push({
        code: "ABSOLUTE_ROWCOL_WITHOUT_ROOM",
        severity: "warning",
        message: `${label} 用了绝对行列号但没指定考场，会按每个考场各自的行列数分别解析`,
        evidence: { constraintId: c.id, description },
        suggestions: [
          {
            id: `semantic-${c.id}`,
            label: "改用「首排/末排/靠门列/靠窗列」这类语义值",
            patch: [
              {
                op: "replace",
                path: `/constraints/${indexOfConstraint(job, c.id)}/cols`,
                value: (c.cols ?? []).map((x) => (typeof x === "number" ? "window" : x)),
              },
            ],
          },
        ],
      });
    }

    if (cs.unknownRoomId) {
      continue;
    }

    if (cs.seats.size === 0) {
      const dropped = cs.droppedRooms;
      const outOfRange = dropped.length > 0;
      push({
        code: outOfRange ? "CONSTRAINT_INDEX_OUT_OF_RANGE" : "CONSTRAINT_EMPTY_DOMAIN",
        severity: "error",
        message: outOfRange
          ? `${label} 的绝对行列号在候选考场里都不存在（${description}），没有任何座位可用`
          : `${label} 没有匹配到任何座位（${description}）`,
        evidence: { constraintId: c.id, description, droppedRooms: dropped },
        suggestions: outOfRangeSuggestions(job, ci, c),
      });
      continue;
    }

    if (cs.noSelector) {
      push({
        code: "CONSTRAINT_NO_SELECTOR",
        severity: "error",
        message: `${label} 没有指定任何学生（既没点名，也没限定班级 / 选科组合 / 科目），这条限定不会生效`,
        evidence: { constraintId: c.id },
        suggestions: [
          {
            id: `drop-${c.id}`,
            label: "删掉这条空限定",
            patch: [{ op: "remove", path: `/constraints/${indexOfConstraint(job, c.id)}` }],
          },
        ],
      });
      continue;
    }

    if (cs.seats.size < cs.studentIndices.length) {
      push({
        code: "CONSTRAINT_OVERSATURATED",
        severity: "error",
        message: `${label} 只有 ${cs.seats.size} 个可用座位，却命中了 ${cs.studentIndices.length} 名学生`,
        evidence: {
          constraintId: c.id,
          availableSeats: cs.seats.size,
          students: cs.studentIndices.length,
        },
        suggestions: oversaturatedSuggestions(
          job,
          ci,
          c,
          cs.seats.size,
          cs.studentIndices.map((si) => students[si]!.id),
        ),
      });
    }
  }

  // 学生级：交集为空 / 座位数冲突
  for (let si = 0; si < students.length; si += 1) {
    const hits = domains.studentConstraints[si]!;
    if (hits.length === 0) continue;
    const domain = domains.domains[si]!;
    if (domain == null || domain.size > 0) continue;
    const conflicted = hits.map((ci) => domains.constraintSets[ci]!);
    push({
      code: "RULE_INTERSECT_EMPTY",
      severity: "error",
      message: `${students[si]!.name || students[si]!.id} 的多条限定互相冲突，交集为空：${conflicted
        .map((cs) => (cs.constraint.note ? `「${cs.constraint.note}」` : cs.constraint.id))
        .join(" 与 ")}`,
      evidence: {
        studentId: students[si]!.id,
        constraintIds: conflicted.map((cs) => cs.constraint.id),
      },
      suggestions: conflicted.slice(0, 2).map((cs) => ({
        id: `drop-${cs.constraint.id}-${students[si]!.id}`,
        label: `删掉限定「${cs.constraint.note ?? cs.constraint.id}」`,
        patch: [{ op: "remove", path: `/constraints/${indexOfConstraint(job, cs.constraint.id)}` }],
      })),
    });
  }

  // 两个人被钉到同一个座位
  const singletonOwners = new Map<number, number[]>();
  for (let si = 0; si < students.length; si += 1) {
    const d = domains.domains[si]!;
    if (d == null || d.size !== 1) continue;
    const seat = [...d][0]!;
    const list = singletonOwners.get(seat) ?? [];
    list.push(si);
    singletonOwners.set(seat, list);
  }
  for (const [seat, owners] of singletonOwners) {
    if (owners.length < 2) continue;
    const room = rooms[model.seatRoom[seat]!]!;
    push({
      code: "SEAT_CONFLICT",
      severity: "error",
      message: `${owners.map((s) => students[s]!.name || students[s]!.id).join("、")} 都被指定到 ${room.spec.name ?? room.spec.id} 的 ${model.seatNo[seat]} 号`,
      evidence: {
        roomId: room.spec.id,
        seatNo: model.seatNo[seat],
        seatId: seatId(room.spec.id, model.seatNo[seat]!),
        studentIds: owners.map((s) => students[s]!.id),
      },
      suggestions: owners.slice(1).map((si) => ({
        id: `unpin-${students[si]!.id}`,
        label: `放宽 ${students[si]!.name || students[si]!.id} 的限定`,
        patch: [
          {
            op: "remove",
            path: `/constraints/${indexOfConstraint(
              job,
              domains.constraintSets[domains.studentConstraints[si]![0]!]!.constraint.id,
            )}`,
          },
        ],
      })),
    });
  }

  // 座位唯一性匹配（比逐条检查更强）
  const matching = checkSeatMatching(domains.domains, model.seatCount);
  if (!matching.ok) {
    const names = matching.unmatched
      .slice(0, 5)
      .map((si) => students[si]!.name || students[si]!.id);
    diagnostics.push({
      code: "CONSTRAINT_OVERSATURATED",
      severity: "error",
      message: `把所有人的限定放在一起看已经排不开了，至少这 ${matching.unmatched.length} 个人抢不到座位：${names.join("、")}`,
      evidence: { unmatched: matching.unmatched.map((si) => students[si]!.id) },
      suggestions: [],
    });
  }

  const fatal = diagnostics.some((d) => d.severity === "error");
  if (!fatal && diagnostics.length === 0) {
    diagnostics.push({
      code: "OK",
      severity: "info",
      message: `预检通过：${participants} 名考生、${classCount} 个班、${rooms.length} 个考场`,
      suggestions: [],
    });
  }

  return { diagnostics, fatal, adjacency: ctx.adjacency, downgraded: ctx.downgraded, domains };
}

/* ------------------------------------------------------------------ */
/* 建议生成                                                            */
/* ------------------------------------------------------------------ */

function indexOfConstraint(job: Job, constraintId: string): number {
  const list = job.constraints ?? [];
  const at = list.findIndex((c) => c.id === constraintId);
  return at === -1 ? 0 : at;
}

function capacitySuggestions(job: Job, deficit: number): Suggestion[] {
  const out: Suggestion[] = [];
  if (deficit <= 0) return out;
  const rooms = job.rooms ?? [];

  // 1) 小考场改大考场
  const smallRooms = rooms.map((r, i) => ({ r, i })).filter(({ r }) => r.rows * r.cols === 30);
  const gainEach = 12;
  const needed = Math.ceil(deficit / gainEach);
  if (smallRooms.length >= needed && needed > 0) {
    const chosen = smallRooms.slice(0, needed);
    out.push({
      id: "upgrade-small-rooms",
      label:
        needed === 1
          ? `把 ${chosen[0]!.r.name ?? chosen[0]!.r.id} 从小考场改成大考场（30 → 42 人）`
          : `把 ${chosen.map((c) => c.r.name ?? c.r.id).join("、")} 改成大考场`,
      effect: `增加 ${needed * gainEach} 个座位`,
      patch: chosen.flatMap(({ i }) => [
        { op: "replace" as const, path: `/rooms/${i}/rows`, value: 7 },
        { op: "replace" as const, path: `/rooms/${i}/cols`, value: 6 },
      ]),
    });
  }

  // 2) 加考场
  const addCount = Math.max(1, Math.ceil(deficit / 42));
  const nextIndex = rooms.length + 1;
  out.push({
    id: "add-rooms",
    label: `加 ${addCount} 个大考场（6 列 × 7 排）`,
    effect: `增加 ${addCount * 42} 个座位`,
    patch: Array.from({ length: addCount }, (_, k) => ({
      op: "add" as const,
      path: "/rooms/-",
      value: {
        id: `R${nextIndex + k}`,
        name: `第${nextIndex + k}考场`,
        rows: 7,
        cols: 6,
        doorSide: "right",
      },
    })),
  });

  // 3) 少排几个人
  const includedIndices = (job.students ?? [])
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.included !== false);
  if (includedIndices.length >= deficit) {
    const chosen = includedIndices.slice(-deficit);
    out.push({
      id: "exclude-students",
      label: `让最后 ${deficit} 名学生不参加本次考试`,
      effect: `考生数减到 ${includedIndices.length - deficit} 人`,
      patch: chosen.map(({ i }) => ({
        op: "replace" as const,
        path: `/students/${i}/included`,
        value: false,
      })),
    });
  }

  return out;
}

function outOfRangeSuggestions(
  job: Job,
  ci: number,
  c: { id: string; cols?: unknown[]; rows?: unknown[] },
): Suggestion[] {
  const out: Suggestion[] = [];
  const at = indexOfConstraint(job, c.id);
  void ci;
  if (c.cols && c.cols.some((x) => typeof x === "number")) {
    out.push({
      id: `col-window-${c.id}`,
      label: "把列改成「靠窗列」（不管考场大小都指最后一列）",
      patch: [
        {
          op: "replace",
          path: `/constraints/${at}/cols`,
          value: c.cols.map((x) => (typeof x === "number" ? "window" : x)),
        },
      ],
    });
  }
  if (c.rows && c.rows.some((x) => typeof x === "number")) {
    out.push({
      id: `row-last-${c.id}`,
      label: "把排改成「末排」（不管考场大小都指最后一排）",
      patch: [
        {
          op: "replace",
          path: `/constraints/${at}/rows`,
          value: c.rows.map((x) => (typeof x === "number" ? "last" : x)),
        },
      ],
    });
  }
  out.push({
    id: `drop-${c.id}`,
    label: "删掉这条限定",
    patch: [{ op: "remove", path: `/constraints/${at}` }],
  });
  return out;
}

function oversaturatedSuggestions(
  job: Job,
  ci: number,
  c: { id: string; note?: string },
  available: number,
  resolvedStudentIds: string[],
): Suggestion[] {
  const at = indexOfConstraint(job, c.id);
  const keep = resolvedStudentIds.slice(0, available);
  const drop = resolvedStudentIds.slice(available);
  const out: Suggestion[] = [];

  // 只有「按学号点名」的限定才谈得上「保留前 N 人」。
  // 用选择器（班级 / 组合 / 科目）选出来的，移出个体学生没有意义，改为建议缩小选择范围。
  if (c.id && drop.length > 0) {
    out.push({
      id: `trim-${c.id}`,
      label: `只保留前 ${available} 人（在限定里点名这 ${available} 个学号，其余自然落回普通考场）`,
      effect: `${drop.length} 人改为普通安排`,
      patch: [{ op: "replace", path: `/constraints/${at}/studentIds`, value: keep }],
    });
  }
  out.push({
    id: `drop-${c.id}`,
    label: "删掉这条限定",
    patch: [{ op: "remove", path: `/constraints/${at}` }],
  });
  void ci;
  return out;
}

/** 供求解失败时复用：给出「哪些考场已经满到不能再塞同班」的定位信息。 */
export function describeRoomLoad(model: CompiledModel, seatOwner: Int32Array): string[] {
  const lines: string[] = [];
  for (const room of model.rooms) {
    const counts = new Map<number, number>();
    for (let s = room.firstSeat; s < room.firstSeat + room.seatCount; s += 1) {
      const student = seatOwner[s]!;
      if (student < 0) continue;
      const cls = model.classOfStudent[student]!;
      counts.set(cls, (counts.get(cls) ?? 0) + 1);
    }
    let worst = -1;
    let worstCount = 0;
    for (const [cls, n] of counts) {
      if (n > worstCount) {
        worstCount = n;
        worst = cls;
      }
    }
    const limit = effectiveSameClassLimit(room.spec, room.maxSameClass, room.capacity);
    if (worst >= 0 && worstCount > limit) {
      lines.push(
        `${room.spec.name ?? room.spec.id}：${room.seatCount} 个座位里有 ${worstCount} 名${model.classNames[worst]}学生，上限是 ${limit}`,
      );
    }
  }
  return lines;
}

// 保持既有公共 API：core 的入口一直从这里取 roomCapacity
export { roomCapacity } from "./numbering";
