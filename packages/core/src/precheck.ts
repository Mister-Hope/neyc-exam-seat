import type { DomainBundle } from "./domain";
import { checkSeatMatching, compileDomains } from "./domain";
import type { CompiledModel, CompiledRoom } from "./model";
import { describeCols, describeRows, maxSameClass, roomCapacity, seatId } from "./numbering";
import {
  isAllocatableRoom,
  MAX_ROOM_SEATS,
  MAX_ROOM_SIDE,
  MAX_TOTAL_SEATS,
  oversizeReason,
  totalGridSeats,
} from "./room-limits";
import type {
  Adjacency,
  Diagnostic,
  Job,
  JsonPatchOp,
  RelaxMode,
  RoomSpec,
  Student,
  Suggestion,
} from "./types";
import {
  describeSameClassRelax,
  isSameClassRelaxed,
  relaxedClassLimit,
  sameClassLimit,
} from "./util";

/** 学生缺学号：`job.json` 是外部数据，`id` 可能是 undefined / 数字 / 空格串， 所以按「不是非空字符串」判（类型上 `id` 是必填，运行时不一定）。 */
function hasNoId(student: Student): boolean {
  return typeof student.id !== "string" || student.id.trim() === "";
}

/** 班级上限用的「本考场最多能容纳同一个班多少人」：放宽后按 `relaxSameClass` 取。 */
function effectiveSameClassLimit(room: RoomSpec, fallback: number, capacity: number): number {
  return relaxedClassLimit(room, fallback, capacity);
}

/** 考场显示名（没写 name 就用 id），诊断文案里用 */
function roomName(room: RoomSpec): string {
  const name = room.name?.trim() ?? "";
  return name === "" ? room.id : name;
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

/**
 * 建模型**之前**的房间几何校验（`precheckJob` 会先调它，再 `compileModel`）。
 *
 * 为什么必须在前面：`compileModel` 要为每个考场算「同班人数上限」，几何函数碰到非法/超大尺寸 以前会抛 `RangeError`（`1 << width` 溢出），CLI 就变成
 * exit 1「内部错误」——违反「core 不抛异常」铁律。 现在几何函数本身已经安全，这里仍把问题**在模型之前**如实报出来，让诊断顺序与消息都可预期。
 *
 * 只依赖原始 `job.rooms`，不需要 `CompiledModel`；与 `runPrecheck` 里的同类检查不重复（那边已删除）。
 */
export function validateRoomGeometry(job: Job): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const rooms = job.rooms ?? [];

  const invalid = rooms.filter(
    (room) =>
      !Number.isInteger(room.rows) ||
      !Number.isInteger(room.cols) ||
      room.rows < 1 ||
      room.cols < 1,
  );
  if (invalid.length > 0) {
    diagnostics.push({
      code: "INVALID_ROOM_SIZE",
      severity: "error",
      message: `有 ${invalid.length} 个考场的行列数不合法（必须是 ≥ 1 的整数）：${invalid
        .map((room) => room.id)
        .join("、")}`,
      evidence: { roomIds: invalid.map((room) => room.id) },
      suggestions: [],
    });
  }

  // 尺寸**上限**：`job.json` 可能是 AI 生成的，「多写几个零」绝不能变成 OOM
  // （`rows: 999999` 曾让 CLI exit -6、浏览器标签页直接崩，没有任何诊断）。
  const oversized = rooms
    .map((room) => ({ room, reason: oversizeReason(room) }))
    .filter(
      (item): item is { room: (typeof rooms)[number]; reason: string } => item.reason !== undefined,
    );
  if (oversized.length > 0) {
    // 逐间写清原因（老师才知道该改哪一间），但最多列 5 间，免得畸形 job 刷屏
    const shown = oversized.slice(0, 5);
    diagnostics.push({
      code: "INVALID_ROOM_SIZE",
      severity: "error",
      message:
        oversized.length === 1
          ? `${shown[0]!.room.name ?? shown[0]!.room.id} 的尺寸太大：${shown[0]!.reason}`
          : `有 ${oversized.length} 个考场的尺寸太大：${shown
              .map((item) => `${item.room.name ?? item.room.id}（${item.reason}）`)
              .join("；")}`,
      evidence: {
        roomIds: oversized.map((item) => item.room.id),
        maxRoomSide: MAX_ROOM_SIDE,
        maxRoomSeats: MAX_ROOM_SEATS,
      },
      suggestions: [],
    });
  }

  const valid = rooms.filter((room) => isAllocatableRoom(room));
  const seats = totalGridSeats(valid);
  if (seats > MAX_TOTAL_SEATS) {
    diagnostics.push({
      code: "INVALID_ROOM_SIZE",
      severity: "error",
      message: `${valid.length} 个考场加起来 ${seats} 座，超过全部考场上限 ${MAX_TOTAL_SEATS} 座（请检查是否多写了几个零）`,
      evidence: { rooms: valid.length, seats, maxTotalSeats: MAX_TOTAL_SEATS },
      suggestions: [],
    });
  }

  return diagnostics;
}

export function runPrecheck(
  model: CompiledModel,
  ctx: { adjacency: Adjacency; downgraded: boolean; relax: RelaxMode },
): PrecheckResult {
  const diagnostics: Diagnostic[] = [];
  // 同一 job 里多条诊断常常给出**同一条建议**（例如 10 个班都超上限时，每条诊断都带上「加考场」）：
  // 按「建议 id + patch」去重，同一条动作只出现一次，免得老师看到一屏重复按钮。
  const emittedSuggestionKeys = new Set<string>();
  const push = (d: Diagnostic): void => {
    if (d.suggestions === undefined || d.suggestions.length === 0) {
      diagnostics.push(d);
      return;
    }
    const suggestions = d.suggestions.filter((suggestion) => {
      const key = JSON.stringify({ id: suggestion.id, patch: suggestion.patch });
      if (emittedSuggestionKeys.has(key)) return false;
      emittedSuggestionKeys.add(key);
      return true;
    });
    diagnostics.push(suggestions.length === d.suggestions.length ? d : { ...d, suggestions });
  };

  const job = model.job;
  const rooms = model.rooms;
  const students = model.students;
  const constraints = job.constraints ?? [];

  /* ---------------- 数据完整性 ---------------- */

  // 学生必须有学号：`id` 缺失/空串一律明确报错（以前「单个缺 id」会被静默接受，两个才因重复被报出来）
  const missingIds = (job.students ?? []).filter((s) => hasNoId(s));
  if (missingIds.length > 0) {
    push({
      code: "STUDENT_MISSING_ID",
      severity: "error",
      message: `有 ${missingIds.length} 名学生没有学号（id 缺失或为空），请补齐后再排`,
      evidence: { count: missingIds.length },
      suggestions: [],
    });
  }

  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const s of job.students ?? []) {
    // 缺学号已单独报过，这里不再重复算作「重复」
    if (hasNoId(s)) continue;
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

  // 行列数的合法性在 `validateRoomGeometry()` 里、建模型之前就查过了（见该函数注释），这里不重复报。

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
      // 单间设有「同班人数上限」（数字形态）时，把限制逐间写清楚：老师才知道该调哪一间、调到多少
      const cappedRooms = rooms
        .map((room) => ({
          room,
          cap: sameClassLimit(room.spec, room.maxSameClass, room.capacity),
        }))
        .filter(
          (item): item is { room: (typeof rooms)[number]; cap: number } => item.cap !== undefined,
        );
      const hint =
        cappedRooms.length === 0
          ? ""
          : `（其中 ${cappedRooms
              .map((item) => `${roomName(item.room.spec)} 同班上限 ${item.cap} 人`)
              .join("、")}）`;
      push({
        code: "CLASS_LIMIT_EXCEEDED",
        severity: "error",
        message: `${model.classNames[cls]} 有 ${size} 人，但所有考场加起来最多只能容纳该班 ${limit} 人${hint}`,
        evidence: {
          className: model.classNames[cls],
          size,
          limit,
          cappedRooms: cappedRooms.map((item) => ({ roomId: item.room.spec.id, cap: item.cap })),
        },
        suggestions: classLimitSuggestions(model, cls, ctx.adjacency),
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
      message: `${room.spec.name ?? room.spec.id} 已放宽「同班相邻」：${describeSameClassRelax(
        room.spec,
        room.maxSameClass,
        room.capacity,
      )}（正常上限 ${room.maxSameClass}），该考场内同班相邻不再算冲突`,
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

/** 一个考场都没有时，「加考场」建议退回的模板：6 列 × 7 排 = 42 座。 */
const FALLBACK_ROOM_TEMPLATE: RoomSpec = {
  id: "R1",
  name: "第1考场",
  rows: 7,
  cols: 6,
  doorSide: "right",
};

/** 把第 `index` 个考场改成跟 `biggest` 一样大的 JSON Patch（含加座列）。 */
function upgradeRoomPatch(room: RoomSpec, index: number, biggest: RoomSpec): JsonPatchOp[] {
  const patch: JsonPatchOp[] = [
    { op: "replace", path: `/rooms/${index}/rows`, value: biggest.rows },
    { op: "replace", path: `/rooms/${index}/cols`, value: biggest.cols },
  ];
  if (biggest.extraFrontSeats !== undefined) {
    patch.push({
      op: room.extraFrontSeats === undefined ? "add" : "replace",
      path: `/rooms/${index}/extraFrontSeats`,
      value: biggest.extraFrontSeats,
    });
  } else if (room.extraFrontSeats !== undefined) {
    patch.push({ op: "remove", path: `/rooms/${index}/extraFrontSeats` });
  }
  return patch;
}

/** 本 job 里座位数最大的**已编译**考场（没有任何考场时 `undefined`）。 */
function biggestCompiledRoom(rooms: readonly CompiledRoom[]): CompiledRoom | undefined {
  let biggest: CompiledRoom | undefined;
  for (const room of rooms) {
    if (biggest === undefined || room.capacity > biggest.capacity) biggest = room;
  }
  return biggest;
}

/**
 * 新增 `addCount` 个考场的 JSON Patch：新考场照 `template` 的几何复制。
 *
 * Id 从「现有考场数 + 1」起跳号并跳过已用 id，保证**同输入同结果**（铁律 2）。
 */
function addRoomsPatch(
  existingIds: readonly string[],
  template: RoomSpec,
  addCount: number,
): JsonPatchOp[] {
  const usedIds = new Set(existingIds);
  const ids: string[] = [];
  let nextNumber = existingIds.length + 1;
  while (ids.length < addCount) {
    const id = `R${nextNumber}`;
    nextNumber += 1;
    if (usedIds.has(id)) continue;
    usedIds.add(id);
    ids.push(id);
  }
  return ids.map((id) => ({
    op: "add" as const,
    path: "/rooms/-",
    value: {
      id,
      name: `第${id.slice(1)}考场`,
      rows: template.rows,
      cols: template.cols,
      doorSide: template.doorSide ?? "right",
      ...(template.extraFrontSeats === undefined
        ? {}
        : { extraFrontSeats: [...template.extraFrontSeats] }),
    },
  }));
}

/**
 * `CLASS_LIMIT_EXCEEDED` 的**专用**建议。
 *
 * 缺口是「该班的**同班名额**不够」，不是「座位不够」：把座位缺口算法（{@link capacitySuggestions}） 搬过来会得出「加 1
 * 间就够」这种**点了也不够**的结论（report P1-4：真正要 7 间才过预检）， 而且「让最后 N 名学生不参加」会排到无关的小班去。所以这里：
 *
 * 1. **加考场按「每个新考场最多能放该班多少人」算**（受 `maxSameClass` / `relaxSameClass` 约束，
 *    与座位数不一定相同），文案里如实写明「加几间、加完能容纳该班多少人」；
 * 2. **少排人只能从触发诊断的那个班取**；取不到（人数不够）就**不给这条建议** —— 宁可少给，不可误导；
 * 3. 不做任何新的硬阻断，也不改 `CLASS_LIMIT_EXCEEDED` 的严重级。
 */
function classLimitSuggestions(
  model: CompiledModel,
  cls: number,
  adjacency: Adjacency,
): Suggestion[] {
  const out: Suggestion[] = [];
  const rooms = model.rooms;
  const className = model.classNames[cls] ?? "";
  const size = model.classSizes[cls] ?? 0;
  const limit = rooms.reduce(
    (sum, room) => sum + effectiveSameClassLimit(room.spec, room.maxSameClass, room.capacity),
    0,
  );
  const deficit = size - limit;
  if (deficit <= 0) return out;
  const existingIds = rooms.map((room) => room.spec.id);

  // 1) 加考场：每个新考场能容纳该班的**人数**（同班名额），按它算要加几间。
  //    完全没有考场时退回 6 列 × 7 排模板，同班名额按几何上限算（与 `compileModel` 同源）。
  const template = biggestCompiledRoom(rooms);
  const templateSpec = template?.spec ?? FALLBACK_ROOM_TEMPLATE;
  const templateCapacity = Math.max(1, roomCapacity(templateSpec));
  const perRoom = Math.max(
    1,
    template === undefined
      ? maxSameClass(templateSpec, adjacency)
      : effectiveSameClassLimit(template.spec, template.maxSameClass, templateCapacity),
  );
  const addCount = Math.ceil(deficit / perRoom);
  const after = limit + addCount * perRoom;
  out.push({
    id: "add-rooms-for-class",
    label:
      `再加 ${addCount} 个考场（${templateSpec.cols} 列 × ${templateSpec.rows} 排，每个最多放该班 ${perRoom} 人）` +
      `：${className} 的可容纳人数 ${limit} → ${after}，才够放 ${size} 人`,
    effect: `${className} 可容纳人数 ${limit} → ${after}（差 ${deficit} 人）`,
    patch: addRoomsPatch(existingIds, templateSpec, addCount),
  });

  // 2) 少排这个班的人：**只从触发诊断的班级里取**，取不到就不给建议
  const jobStudents = model.job.students ?? [];
  const jobIndexById = new Map<string, number>();
  jobStudents.forEach((student, index) => {
    if (!jobIndexById.has(student.id)) jobIndexById.set(student.id, index);
  });
  const classIndices: number[] = [];
  for (let i = 0; i < model.students.length; i += 1) {
    if (model.classOfStudent[i] !== cls) continue;
    const index = jobIndexById.get(model.students[i]!.id);
    if (index !== undefined) classIndices.push(index);
  }
  if (classIndices.length >= deficit) {
    const chosen = classIndices.slice(-deficit);
    out.push({
      id: "exclude-class-students",
      label: `让 ${className} 里最后 ${deficit} 名学生不参加本次考试`,
      effect: `${className} 的考生数减到 ${classIndices.length - deficit} 人（不超过上限 ${limit} 人）`,
      patch: chosen.map((index) => ({
        op: "replace" as const,
        path: `/students/${index}/included`,
        value: false,
      })),
    });
  }
  return out;
}

function capacitySuggestions(job: Job, deficit: number): Suggestion[] {
  const out: Suggestion[] = [];
  if (deficit <= 0) return out;
  const rooms = job.rooms ?? [];

  // 1) 把比「本 job 最大考场」小的考场改成跟最大考场一样大 —— 不依赖任何预设尺寸
  //    （预设会变：小考场 30 座 → 35 座的静默调整曾让按 30 硬编码的旧建议失效）
  let biggest: RoomSpec | undefined;
  for (const room of rooms) {
    if (biggest === undefined || roomCapacity(room) > roomCapacity(biggest)) biggest = room;
  }
  if (biggest !== undefined) {
    const biggestCapacity = roomCapacity(biggest);
    const upgradable = rooms
      .map((room, index) => ({ room, index, gain: biggestCapacity - roomCapacity(room) }))
      .filter(({ gain }) => gain > 0)
      // 越小的考场改起来越划算，先改它们；同 gain 按考场顺序，保证同输入同建议
      .sort((a, b) => b.gain - a.gain || a.index - b.index);
    const chosen: typeof upgradable = [];
    let gain = 0;
    for (const item of upgradable) {
      if (gain >= deficit) break;
      chosen.push(item);
      gain += item.gain;
    }
    if (gain >= deficit && chosen.length > 0) {
      out.push({
        id: "upgrade-small-rooms",
        label:
          chosen.length === 1
            ? `${chosen[0]!.room.name ?? chosen[0]!.room.id} ${roomCapacity(chosen[0]!.room)} 座 → 改成 ${biggestCapacity} 座可多放 ${chosen[0]!.gain} 人`
            : `把 ${chosen.map(({ room }) => room.name ?? room.id).join("、")} 改成最大考场那样大（${biggestCapacity} 座）`,
        effect: `增加 ${gain} 个座位`,
        patch: chosen.flatMap(({ room, index }) => upgradeRoomPatch(room, index, biggest)),
      });
    }
  }

  // 2) 加考场：新考场按本 job 座位数最大的考场取模板（没有任何考场时退回 6 列 × 7 排），
  //    这样别的学校复用时不至于被写死的 42 座带偏。
  const template = biggest ?? FALLBACK_ROOM_TEMPLATE;
  // 最大考场也可能只有 0 个座位（行列数非法时）—— 兜到 1，避免 ceil(deficit / 0) = Infinity 变成死循环
  const templateCapacity = Math.max(1, roomCapacity(template));
  const addCount = Math.max(1, Math.ceil(deficit / templateCapacity));
  out.push({
    id: "add-rooms",
    label:
      addCount === 1
        ? `加 1 个考场（${template.cols} 列 × ${template.rows} 排，${templateCapacity} 座）`
        : `加 ${addCount} 个考场（共 ${addCount * templateCapacity} 座）`,
    effect: `增加 ${addCount * templateCapacity} 个座位`,
    patch: addRoomsPatch(
      rooms.map((room) => room.id),
      template,
      addCount,
    ),
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
