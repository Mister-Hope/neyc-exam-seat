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

/**
 * 分房倾向（多场次）。
 *
 * - `sameCombination`（默认）：每个批次（组合）独占考场，一个考场里只有一个组合，监考表最干净； 考场不够时直接报 `CAPACITY_INSUFFICIENT`，不偷偷混排。
 * - `fillRooms`：先把当前考场填满再换下一个，省考场；只允许与**逐时段科目不冲突**的批次共用， 共用时报 `ROOMS_SHARED`。
 *
 * 两种取值都必须满足「一个考场一个时段只能考一科」（详见 `docs/design.md` §5.1）。
 */
export type GroupPreference = "sameCombination" | "fillRooms";

/**
 * 结果采用的级别。
 *
 * - `strict`：完全满足（默认）
 * - `orthogonal`：班级数不足自动退化为 4 邻域
 * - `softConstraints` / `minConflicts`：`--relax` 降级
 * - `roomRelaxed`：考场级放宽过「同班相邻」（`RoomSpec.relaxSameClass`），该结果仍然可用， 但要显式告警并在监考表上标注
 */
export type PlanLevel =
  | "strict"
  | "orthogonal"
  | "softConstraints"
  | "minConflicts"
  | "roomRelaxed";

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
  /**
   * 借考：某科目去指定考场考（科目 id → 考场 id），例如 `{ "biology": "R18" }`。
   *
   * 该时段只占用目标考场的一个**空位**，不改变目标考场该时段的卷子（仍然只有一科）； 其余科目留在自己的主考场。目标考场该时段若另有别的科目，报
   * `SUBJECT_ROOM_CLASH`，不静默混排。
   */
  subjectRoom?: Record<string, string>;
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
  /**
   * 讲台一侧的加座所在业务列（从靠门侧起算），例如 `[2, 4]`。
   *
   * 每个这类列在讲台前面多 1 张桌子，因此该列的座位数 = `rows + 1`；座位号沿用按列蛇形， 加座永远排在该列最后一个号，行号记 `0`（第 1 排之前）。缺省 = 纯矩形
   * `rows × cols`。 详见 `docs/design.md` §4.5（5 列 × 7 排 + 2 个加座 = 37 座）。
   */
  extraFrontSeats?: number[];
  /**
   * 本考场放宽「同班相邻」：`true` = 完全放开；数字 = 该考场同班学生数上限。
   *
   * 只影响本考场：该考场内同班学生相邻不再算冲突（仍会留一条 `ROOM_SAME_CLASS_RELAXED` warning， 并在监考表表头标注）；其余考场规则不变。
   */
  relaxSameClass?: boolean | number;
  /**
   * 这个考场是哪个选科组合的「专属考场」：只接收 `students[].combination` 等于该字符串的 **常规组合批次**（整批进、全程不换考场，仍然遵守「一室一时段一卷」）。
   *
   * 典型用法：指定一间专属的老文科考场，让考政史地的整批学生集中到这里，不必再去第 4 步写限定。
   *
   * - 允许多个考场钉同一个组合（人数超过单室容量时按 `rooms` 顺序依次吃下，装不下走既有缺座路径）；
   * - 写法可任意（「史地政」/「政史地」都行），内部规范化后比较；缺省 = 不专属任何组合，行为不变；
   * - 与 `dedicatedSubjects` 同时出现时按专属组合处理（会报 `ROOM_COMBINATION_IGNORED_DEDICATED`）；
   * - 被 `roomId` 限定显式钉进来的学生不受影响（显式限定优先）。
   */
  combination?: string;
}

/** 显式时段表的单个时段（`PlanOptions.slots`）。 */
export interface PlanSlotSpec {
  /** 缺省按顺序生成 `T1`、`T2`… */
  id?: string;
  /** 缺省按顺序生成「第N时段」 */
  name?: string;
  /** 本时段并行开考的科目 id */
  subjects: string[];
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
   * 分房倾向，默认 `sameCombination`。
   *
   * 只影响多场次 `planAll`；未知取值按最严格的 `sameCombination` 处理（绝不静默混排）。
   */
  groupPreference?: GroupPreference;
  /**
   * 常规组合（老的文理分科，如物化生 / 政史地）：这些学生整个考试期间只在一个考场。
   *
   * 不填时按传统文理判定（`isRegularCombination`）：选考科目全在理科一侧或全在文科一侧 就算常规，跨文理（物化政 / 物化地）算非常规。
   */
  regularCombinations?: string[];
  /** 一个学生最多允许用几个考场，超过就报警。默认 3。 */
  maxRoomsPerStudent?: number;
  /**
   * 显式时段表：一旦给定就**不再自动推导**时段（老师按考务表把 7 个时段填死）。
   *
   * 用在名单被手工剔除、自动推导会塌陷的场合（`docs/design.md` §5.3）。时段 id / 名称缺省时按顺序补齐。 同一学生在同一时段被排两科 → 报错，不静默合并。
   */
  slots?: PlanSlotSpec[];
  /** 只补「必须分开考」的科目对，例如 `[["chemistry","biology"]]`：它们会被并进冲突图再着色， 其余时段仍自动推导。用在不方便整张时段表填死的场合。 */
  forbiddenSameSlot?: string[][];
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
  | "STUDENT_MISSING_ID"
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
  // 多场次
  | "ROOMS_SHARED"
  | "ROOM_SUBJECT_CLASH"
  | "CONSTRAINTS_IGNORED_MULTI"
  | "TOO_FEW_CLASSES"
  | "CLASS_LIMIT_EXCEEDED"
  // 考场级放宽 / 借考 / 显式时段（本轮新增，见 docs/design.md §5.8）
  | "ROOM_SAME_CLASS_RELAXED"
  | "SUBJECT_ROOM_APPLIED"
  | "SUBJECT_ROOM_UNKNOWN_ROOM"
  | "SUBJECT_ROOM_UNKNOWN_SUBJECT"
  | "SUBJECT_ROOM_CLASH"
  | "SUBJECT_ROOM_NO_SEAT"
  | "SUBJECT_ROOM_NO_SLOT"
  | "SLOTS_PROVIDED"
  | "SLOTS_CONFLICT"
  // 专属组合考场（RoomSpec.combination）
  | "ROOM_COMBINATION_APPLIED"
  | "ROOM_COMBINATION_UNKNOWN"
  | "ROOM_COMBINATION_IGNORED_DEDICATED"
  | "ROOM_COMBINATION_IGNORED_SINGLE"
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
  | "TIME_LIMIT_REACHED"
  // 校验器（`validate()` / `validateAll()`）的原始码：自校验失败时**按原码**升成顶层诊断，
  // 不再统一泛化成 SEARCH_FAILED（否则结构性错误会绕过导出门禁，见 docs/design.md §18 R-1）
  | "ADJACENCY_CONFLICT"
  | "ENTRY_DUPLICATE_SEAT"
  | "ENTRY_DUPLICATE_STUDENT"
  | "ENTRY_MISSING_SLOT"
  | "ENTRY_MISSING_STUDENT"
  | "ENTRY_NUMBERING_MISMATCH"
  | "ENTRY_SEAT_OUT_OF_RANGE"
  | "ENTRY_UNKNOWN_ROOM"
  | "ENTRY_UNKNOWN_SLOT"
  | "ENTRY_UNKNOWN_STUDENT"
  | "CONSTRAINT_UNMET"
  | "ROOM_SAME_CLASS_LIMIT_EXCEEDED"
  | "ROOM_COMBINATION_MISMATCH"
  | "ROOM_COMBINATION_UNMET"
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
  /**
   * 本次求解实际跑的退火迭代数（可选：手工拼的历史结果可能没有）。
   *
   * 预算 = `min(4_000_000, max(1000, timeLimitMs × 400))`，**只由输入决定**（可复现）。 用 `iterations === 预算 &&
   * !ok` 判断「是不是被预算截断」，不必看耗时。
   */
  iterations?: number;
}

/**
 * 交付状态：由 core 在**独立校验之后**统一判定，导出层只消费这个字段（不要自己看诊断猜）。
 *
 * - `blocked`：**不得**导出名单 / 监考表。存在结构性 error（编号不符、重复占座、未知学生、漏排、 专属组合不符、容量不足……），导出只会误导老师；
 * - `ready-with-warnings`：可以导出，但带着 warning（`--relax` 主动降级、考场级放宽、空置考场……）；
 * - `ready`：零 error、零 warning。
 *
 * `plan()` / `planAll()` 一定会写入该字段；手工拼出来的历史结果可能缺省， 用 `blocksListExport(result)` 或
 * `evaluateDelivery(job, result)` 兜底判定。
 */
export type PlanDelivery = "blocked" | "ready" | "ready-with-warnings";

export interface PlanResult {
  resultVersion: number;
  /** 是否零冲突且全部限定满足 */
  ok: boolean;
  /** 交付状态：导出闸门只看这个（见 {@link PlanDelivery}） */
  delivery?: PlanDelivery;
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
