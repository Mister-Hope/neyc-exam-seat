/**
 * `@exam-seat/core` 公共类型定义。
 *
 * 约定（全项目统一，不要改）：
 *
 * - `row` 从讲台起算，1 = 首排。
 * - `col` 从靠门侧起算，1 = 靠门列（小号列），cols = 靠窗列（大号列）。
 */

/** 门在哪一侧。默认 `right`（本项目的编号方案 A）。 */
export type DoorSide = "left" | "right";

/**
 * 行限定。
 *
 * - `'first'` 首排
 * - `'last'` 末排（= 该考场的排数，随考场大小变化）
 * - 数字 绝对排号，**仅在指定了考场时可用**
 */
export type RowRef = "first" | "last" | number;

/**
 * 列限定。
 *
 * - `'door'` 靠门列（= 第 1 列）
 * - `'window'` 靠窗列（= 该考场的列数，随考场大小变化）
 * - 数字 绝对列号（从靠门侧起算），**仅在指定了考场时可用**
 */
export type ColRef = "door" | "window" | number;

/** 相邻判定：`king` = 8 邻域（含对角）；`orthogonal` = 前后左右 4 邻域。 */
export type Adjacency = "king" | "orthogonal";

/** 降级模式。 */
export type RelaxMode = "none" | "softConstraints" | "minConflicts";

/** 结果采用的级别。`strict` 为完全满足。 */
export type PlanLevel = "strict" | "orthogonal" | "softConstraints" | "minConflicts";

export interface Student {
  id: string;
  name: string;
  className: string;
  gender?: string;
  /** False = 本次不参加考试。缺省视为 true。 */
  included?: boolean;
  /** 选科组合的原始文本，例如「物化政」。来自 Excel 的选科列。 */
  combination?: string;
  /** 解析后的选科科目 id，例如 ['physics','chemistry','politics'] */
  subjects?: string[];
  tags?: string[];
  meta?: Record<string, unknown>;
}

export interface RoomSpec {
  id: string;
  name?: string;
  /** 地点，老师自己填，例如「高二一班」「生物实验室」 */
  location?: string;
  /** 排数 */
  rows: number;
  /** 列数 */
  cols: number;
  /** 门所在侧，默认 `right` */
  doorSide?: DoorSide;
  /** 备注，例如监考老师 */
  note?: string;
  /**
   * 这个考场是哪些科目的「专用考场」。
   *
   * 专用考场只接收**非常规组合**（跨文理）中考了该科目的学生。 一个考场可以承担多个学科——例如政治在 T6、地理在 T7，时间不冲突， 同一个房间可以既当政治专用又当地理专用。
   */
  dedicatedSubjects?: string[];
}

export interface Constraint {
  id: string;
  note?: string;
  /** 按学号点名。以下五个选择器至少要写一个。 */
  studentIds?: string[];
  /** 按班级选人，例如 ['高三(3)班'] */
  classes?: string[];
  /** 按选科组合选人，例如 ['物化政']（写法可任意，内部会规范化） */
  combinations?: string[];
  /** 按所选科目选人，例如 ['politics']（命中选了其中任意一门的学生） */
  subjects?: string[];
  /** 单选。缺省 = 不限考场。 */
  roomId?: string;
  rows?: RowRef[];
  cols?: ColRef[];
}

export interface PlanOptions {
  /** 随机种子，默认 20260930。同 seed 同输入必得同结果。 */
  seed?: number;
  /** 相邻判定，默认 `king`。 */
  adjacency?: Adjacency;
  /** 即使班级数不足 9 个也坚持用 8 邻域（不自动退化）。 默认 false：班级数 < 9 时自动退化为 4 邻域并给出提示。 */
  forceKing?: boolean;
  /** 降级模式，默认 `none`。 */
  relax?: RelaxMode;
  /** 求解时间上限（毫秒），默认 10000。 */
  timeLimitMs?: number;
  /**
   * 常规组合（老的文理分科，如物化生 / 政史地）：这些学生整个考试期间只在一个考场。
   *
   * 不填时按传统文理判定（`isRegularCombination`）：选考科目全在理科一侧或全在文科一侧 就算常规，跨文理（物化政 / 物化地）算非常规。
   */
  regularCombinations?: string[];
  /** 一个学生最多允许用几个考场，超过就报警。默认 3。 */
  maxRoomsPerStudent?: number;
}

export interface Job {
  jobVersion?: number;
  meta?: { title?: string; createdAt?: string };
  options?: PlanOptions;
  students: Student[];
  rooms: RoomSpec[];
  constraints?: Constraint[];
}

/* ------------------------------------------------------------------ */
/* 诊断                                                                */
/* ------------------------------------------------------------------ */

export type DiagnosticCode =
  // 数据问题
  | "STUDENT_DUPLICATE_ID"
  | "STUDENT_MISSING_CLASS"
  | "STUDENT_MISSING_NAME"
  | "STUDENT_MISSING_SUBJECTS"
  | "UNKNOWN_ROOM_ID"
  | "UNKNOWN_STUDENT_ID"
  | "INVALID_ROOM_SIZE"
  | "NO_ROOMS"
  | "NO_STUDENTS"
  // 容量与结构
  | "CAPACITY_INSUFFICIENT"
  | "ROOMS_OVERPROVISIONED"
  | "ROOMS_NON_CONTIGUOUS"
  | "ROOMS_SHARED"
  | "TOO_FEW_CLASSES"
  | "CLASS_LIMIT_EXCEEDED"
  // 限定
  | "CONSTRAINT_EMPTY_DOMAIN"
  | "CONSTRAINT_INDEX_OUT_OF_RANGE"
  | "ABSOLUTE_ROWCOL_WITHOUT_ROOM"
  | "CONSTRAINT_OVERSATURATED"
  | "CONSTRAINT_NO_SELECTOR"
  | "RULE_INTERSECT_EMPTY"
  | "SEAT_CONFLICT"
  // 求解
  | "SEARCH_FAILED"
  | "OK";

/** JSON Patch 操作，agent 可直接应用到 job.json 后重跑。 */
export interface JsonPatchOp {
  op: "add" | "remove" | "replace";
  /** JSON Pointer，例如 `/rooms/6/cols` */
  path: string;
  value?: unknown;
}

export interface Suggestion {
  id: string;
  /** 给老师看的人话，例如「把第 7 考场改成大考场（30 → 42 人）」 */
  label: string;
  /** 预期效果，例如「增加 12 个座位」 */
  effect?: string;
  /** 机器可应用的修改 */
  patch?: JsonPatchOp[];
}

export interface Diagnostic {
  code: DiagnosticCode;
  severity: "error" | "warning" | "info";
  /** 中文人话，直接可以念给老师听 */
  message: string;
  evidence?: Record<string, unknown>;
  suggestions: Suggestion[];
}

/* ------------------------------------------------------------------ */
/* 结果                                                                */
/* ------------------------------------------------------------------ */

export interface PlanEntry {
  studentId: string;
  name: string;
  className: string;
  roomId: string;
  roomName: string;
  seatNo: number;
  /** 从讲台起算 */
  row: number;
  /** 从靠门侧起算 */
  col: number;
  /** 物理列（面对讲台从左往右），仅用于展示与打印 */
  physicalCol: number;
}

export interface Conflict {
  roomId: string;
  seatA: number;
  seatB: number;
  studentA: string;
  studentB: string;
  className: string;
}

export interface UnmetConstraint {
  constraintId: string;
  studentIds: string[];
  reason: string;
}

export interface PlanStats {
  students: number;
  participants: number;
  excluded: number;
  rooms: number;
  roomsUsed: number;
  /** 完全没用到、可以不用布置的考场 id */
  emptyRooms: string[];
  seatsTotal: number;
  seatsUsed: number;
  conflicts: number;
  unmetConstraints: number;
  classes: number;
  elapsedMs: number;
  seed: number;
  adjacency: Adjacency;
}

export interface PlanResult {
  resultVersion: number;
  /** 是否零冲突且全部限定满足 */
  ok: boolean;
  level: PlanLevel;
  stats: PlanStats;
  entries: PlanEntry[];
  conflicts: Conflict[];
  unmetConstraints: UnmetConstraint[];
  diagnostics: Diagnostic[];
  inputFingerprint: string;
  generatedAt: string;
}

export interface ValidationIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  refs?: Record<string, unknown>;
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
}

/** 座位外部标识，格式 `roomId:seatNo`，例如 `R1:1`。 */
export type SeatId = string;
