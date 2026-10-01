import { maxSameClass, roomCapacity, seatNoToRC } from "./numbering";
import { isAllocatableRoom, MAX_TOTAL_SEATS, roomGridSeats } from "./room-limits";
import { formatCombination, parseCombination } from "./subjects";
import type { Adjacency, DoorSide, Job, RoomSpec, Student } from "./types";

/** 编译后的考场 */
export interface CompiledRoom {
  index: number;
  spec: RoomSpec;
  doorSide: DoorSide;
  capacity: number;
  /** 该考场第一个座位在全局座位表中的下标 */
  firstSeat: number;
  seatCount: number;
  maxSameClass: number;
  /** (row-1)*cols + (col-1) → 全局座位下标；**只含第 1..rows 排**，加座见 `extraSeat` */
  grid: Int32Array;
  /**
   * 下标 col-1 → 该列讲台侧加座的全局座位下标；该列没有加座时为 -1。
   *
   * 加座不算第 0 排（`seatRow` 记为 0 只是内部坐标），行 / 列限定点不到它。
   */
  extraSeat: Int32Array;
  /** 有加座的业务列（升序去重），等价于 `extraSeat` 中非 -1 的下标 + 1 */
  extraCols: number[];
  /**
   * 本考场放宽了「同班相邻」（`spec.relaxSameClass` 非 undefined 且非 false）。
   *
   * `true` = 完全放开；数字 = 该考场同班学生数上限（数字语义由 solver / validate 解释）。
   */
  relaxedSameClass: boolean;
}

export interface CompiledModel {
  job: Job;
  /** 参加考试的学生（included !== false） */
  students: Student[];
  excluded: Student[];
  rooms: CompiledRoom[];
  /** 全局座位数 */
  seatCount: number;
  /** 座位 → 考场下标 */
  seatRoom: Int32Array;
  /** 座位 → 座位号 */
  seatNo: Int32Array;
  /** 座位 → 排（从讲台起算）；加座为 0 */
  seatRow: Int32Array;
  /** 座位 → 业务列（从靠门侧起算） */
  seatCol: Int32Array;
  /** 邻接表：第 s 个座位的邻居在 neighborList 的 [neighborStart[s], neighborStart[s+1]) 区间 */
  neighborStart: Int32Array;
  neighborList: Int32Array;
  /** 学生 → 班级编号 */
  classOfStudent: Int32Array;
  /** 班级名 → 编号 */
  classNames: string[];
  /** 每个班级的参加考试人数 */
  classSizes: number[];
  /** 学生 → 选科组合的规范名（如「物化政」）；没填选科就是 null */
  combinationOfStudent: (string | null)[];
  /** 学生 → 选科科目 id；没填选科就是 null */
  subjectOfStudent: (readonly string[] | null)[];
  /** 学号 → 学生下标（只含参加考试的；重复学号取第一个） */
  studentIndexById: Map<string, number>;
  /** 选科组合的规范名 → 该组合的学生下标 */
  combinationGroups: Map<string, number[]>;
  /** 出现在名单里的全部选科科目 */
  subjectsInUse: string[];
  adjacency: Adjacency;
}

const NEIGHBOR_OFFSETS_KING: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

const NEIGHBOR_OFFSETS_ORTHOGONAL: readonly (readonly [number, number])[] = [
  [-1, 0],
  [0, -1],
  [0, 1],
  [1, 0],
];

/**
 * 取 `(row, col)` 处的全局座位下标；该位置没有座位（越界，或第 0 排该列没有加座）返回 -1。
 *
 * 第 0 排 = 讲台侧加座，只有 `extraSeat` 里非 -1 的列才有座位。
 *
 * ⚠️ **座位寻址只有这一处实现**（求解器的邻接表、校验器都用它）。历史上校验器手写过 `room.grid[(row - 1) * cols + (col - 1)]`，对加座（行
 * 0）算出负下标而静默跳过 —— 别再复制那个公式。
 */
export function seatIndexAt(room: CompiledRoom, row: number, col: number): number {
  if (!Number.isInteger(row) || !Number.isInteger(col)) return -1;
  if (col < 1 || col > room.spec.cols) return -1;
  if (row === 0) return room.extraSeat[col - 1]!;
  if (row < 1 || row > room.spec.rows) return -1;
  return room.grid[(row - 1) * room.spec.cols + (col - 1)]!;
}

/** 把 Job 编译成求解器使用的扁平结构。纯函数，不做任何校验。 */
export function compileModel(job: Job, adjacency: Adjacency = "king"): CompiledModel {
  const allStudents = job.students ?? [];
  const students = allStudents.filter((s) => s.included !== false);
  const excluded = allStudents.filter((s) => s.included === false);

  // 班级编号
  const classIndex = new Map<string, number>();
  const classNames: string[] = [];
  const classOfStudent = new Int32Array(students.length);
  for (let i = 0; i < students.length; i += 1) {
    const name = students[i]!.className ?? "";
    let id = classIndex.get(name);
    if (id === undefined) {
      id = classNames.length;
      classIndex.set(name, id);
      classNames.push(name);
    }
    classOfStudent[i] = id;
  }
  const classSizes = Array.from({ length: classNames.length }, () => 0);
  for (let i = 0; i < students.length; i += 1) classSizes[classOfStudent[i]!]! += 1;

  // 选科
  const studentIndexById = new Map<string, number>();
  const combinationOfStudent: (string | null)[] = Array.from(
    { length: students.length },
    () => null,
  );
  const subjectOfStudent: (readonly string[] | null)[] = Array.from(
    { length: students.length },
    () => null,
  );
  const combinationGroups = new Map<string, number[]>();
  const subjectsInUse = new Set<string>();

  for (let i = 0; i < students.length; i += 1) {
    const student = students[i]!;
    if (!studentIndexById.has(student.id)) studentIndexById.set(student.id, i);

    // subjects 优先；没给就尝试从 combination 文本解析
    let subjects: string[] | null = student.subjects ? [...student.subjects] : null;
    // 空串按「没给」处理：下面 `combination ??= canonical` 依赖这个归一化，
    // 所以不能用 `??`（`??` 会把空串当有效值保留下来）
    const combinationText = student.combination?.trim() ?? "";
    let combination: string | null = combinationText === "" ? null : combinationText;
    if (!subjects && combination) {
      subjects = parseCombination(combination).subjects;
    }
    if (subjects && subjects.length > 0) {
      subjectOfStudent[i] = subjects;
      for (const s of subjects) subjectsInUse.add(s);
      const canonical = formatCombination(subjects);
      combinationOfStudent[i] = canonical;
      // 原始文本保留在 student.combination 上，这里只在缺省时补规范名
      combination ??= canonical;
    } else if (combination) {
      // 有文本但一个字都没认出来，保留原样以便报错
      combinationOfStudent[i] = combination;
    }
    if (!student.combination && combination) student.combination = combination;

    const key = combinationOfStudent[i];
    if (key) {
      const list = combinationGroups.get(key) ?? [];
      list.push(i);
      combinationGroups.set(key, list);
    }
  }

  // 考场与座位
  const rooms: CompiledRoom[] = [];
  let seatCount = 0;
  // 已分配出去的网格座位数：总上限之后的考场按「空考场」处理（诊断由 validateRoomGeometry 报）
  let allocatedGridSeats = 0;
  for (let r = 0; r < job.rooms.length; r += 1) {
    const spec = job.rooms[r]!;
    // ⚠️ 尺寸上限**必须**在这里兜住：`compileModel` 可能被直接调用（浏览器主线程 / worker），
    // 不能指望调用方先跑 `validateRoomGeometry`。畸形超大尺寸若照原样分配 → OOM（见 room-limits.ts）。
    const gridSeats = roomGridSeats(spec);
    const allocatable =
      isAllocatableRoom(spec) && allocatedGridSeats + gridSeats <= MAX_TOTAL_SEATS;
    if (allocatable) allocatedGridSeats += gridSeats;
    const capacity = allocatable ? roomCapacity(spec) : 0;
    // grid 语义不变：只放第 1..rows 排；加座单独放 extraSeat
    const grid = new Int32Array(allocatable ? gridSeats : 0).fill(-1);
    const extraSeat = new Int32Array(allocatable ? Math.max(0, Math.floor(spec.cols)) : 0).fill(-1);
    for (let seatNo = 1; seatNo <= capacity; seatNo += 1) {
      const { row, col } = seatNoToRC(seatNo, spec.rows, spec.cols, spec.extraFrontSeats);
      if (row === 0) {
        extraSeat[col - 1] = seatCount + seatNo - 1;
      } else if (row >= 1 && row <= spec.rows) {
        grid[(row - 1) * spec.cols + (col - 1)] = seatCount + seatNo - 1;
      }
      // 其余情况是非法 extraFrontSeats 造成的越界号，直接忽略（不覆盖已有座位）
    }
    const extraCols: number[] = [];
    for (let col = 1; col <= spec.cols; col += 1) {
      if (extraSeat[col - 1]! >= 0) extraCols.push(col);
    }
    rooms.push({
      index: r,
      spec,
      doorSide: spec.doorSide ?? "right",
      capacity,
      firstSeat: seatCount,
      seatCount: capacity,
      maxSameClass: allocatable ? maxSameClass(spec, adjacency) : 0,
      grid,
      extraSeat,
      extraCols,
      relaxedSameClass: spec.relaxSameClass !== undefined && spec.relaxSameClass !== false,
    });
    seatCount += capacity;
  }

  const seatRoom = new Int32Array(seatCount);
  const seatNo = new Int32Array(seatCount);
  const seatRow = new Int32Array(seatCount);
  const seatCol = new Int32Array(seatCount);
  for (const room of rooms) {
    for (let n = 1; n <= room.seatCount; n += 1) {
      const s = room.firstSeat + n - 1;
      const rc = seatNoToRC(n, room.spec.rows, room.spec.cols, room.spec.extraFrontSeats);
      seatRoom[s] = room.index;
      seatNo[s] = n;
      seatRow[s] = rc.row;
      seatCol[s] = rc.col;
    }
  }

  // 邻接表：按座位下标顺序逐座位生成，邻居偏移顺序固定（纯矩形时与旧实现逐元素一致）。
  // 加座（第 0 排）与同列 / 相邻列的第 1 排相邻；两个加座之间是否相邻由几何决定（相隔 1 列才算相邻）。
  const offsets = adjacency === "orthogonal" ? NEIGHBOR_OFFSETS_ORTHOGONAL : NEIGHBOR_OFFSETS_KING;
  const neighborStart = new Int32Array(seatCount + 1);
  const ordered: number[] = [];
  for (let s = 0; s < seatCount; s += 1) {
    neighborStart[s] = ordered.length;
    const room = rooms[seatRoom[s]!]!;
    const row = seatRow[s]!;
    const col = seatCol[s]!;
    for (const [dr, dc] of offsets) {
      const target = seatIndexAt(room, row + dr, col + dc);
      if (target >= 0) ordered.push(target);
    }
  }
  neighborStart[seatCount] = ordered.length;
  const neighborList = Int32Array.from(ordered);

  return {
    job,
    students,
    excluded,
    rooms,
    seatCount,
    seatRoom,
    seatNo,
    seatRow,
    seatCol,
    neighborStart,
    neighborList,
    classOfStudent,
    classNames,
    classSizes,
    combinationOfStudent,
    subjectOfStudent,
    studentIndexById,
    combinationGroups,
    subjectsInUse: [...subjectsInUse],
    adjacency,
  };
}
