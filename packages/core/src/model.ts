import { maxSameClass, roomCapacity, seatNoToRC } from "./numbering";
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
  /** (row-1)*cols + (col-1) → 全局座位下标 */
  grid: Int32Array;
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
  /** 座位 → 排（从讲台起算） */
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
  for (let r = 0; r < job.rooms.length; r += 1) {
    const spec = job.rooms[r]!;
    const capacity = roomCapacity(spec);
    const grid = new Int32Array(spec.rows * spec.cols).fill(-1);
    for (let seatNo = 1; seatNo <= capacity; seatNo += 1) {
      const { row, col } = seatNoToRC(seatNo, spec.rows, spec.cols);
      grid[(row - 1) * spec.cols + (col - 1)] = seatCount + seatNo - 1;
    }
    rooms.push({
      index: r,
      spec,
      doorSide: spec.doorSide ?? "right",
      capacity,
      firstSeat: seatCount,
      seatCount: capacity,
      maxSameClass: maxSameClass(spec, adjacency),
      grid,
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
      const rc = seatNoToRC(n, room.spec.rows, room.spec.cols);
      seatRoom[s] = room.index;
      seatNo[s] = n;
      seatRow[s] = rc.row;
      seatCol[s] = rc.col;
    }
  }

  // 邻接表
  const offsets = adjacency === "orthogonal" ? NEIGHBOR_OFFSETS_ORTHOGONAL : NEIGHBOR_OFFSETS_KING;
  const neighborStart = new Int32Array(seatCount + 1);
  const lists: number[] = [];
  for (const room of rooms) {
    for (let row = 1; row <= room.spec.rows; row += 1) {
      for (let col = 1; col <= room.spec.cols; col += 1) {
        const self = room.grid[(row - 1) * room.spec.cols + (col - 1)]!;
        neighborStart[self + 1] = 0; // 占位，稍后累加
        for (const [dr, dc] of offsets) {
          const nr = row + dr;
          const nc = col + dc;
          if (nr < 1 || nr > room.spec.rows || nc < 1 || nc > room.spec.cols) continue;
          const target = room.grid[(nr - 1) * room.spec.cols + (nc - 1)]!;
          lists.push(target);
        }
      }
    }
  }
  // 重新按座位顺序构建，保证 neighborStart 单调
  const ordered: number[] = [];
  const start = new Int32Array(seatCount + 1);
  for (let s = 0; s < seatCount; s += 1) {
    start[s] = ordered.length;
    const room = rooms[seatRoom[s]!]!;
    const row = seatRow[s]!;
    const col = seatCol[s]!;
    for (const [dr, dc] of offsets) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 1 || nr > room.spec.rows || nc < 1 || nc > room.spec.cols) continue;
      ordered.push(room.grid[(nr - 1) * room.spec.cols + (nc - 1)]!);
    }
  }
  start[seatCount] = ordered.length;
  void neighborStart;
  void lists;
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
    neighborStart: start,
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
