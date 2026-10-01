import { matchToken, parseQuery } from "@/lib/search";
import type { StudentQuery } from "@/lib/search";
import { subjectLabel, subjectListLabel } from "@exam-seat/core";
import type {
  Conflict,
  Diagnostic,
  PlanAllResult,
  RoomSpec,
  SeatingPlan,
  StudentSchedule,
  StudentSlotAssignment,
  TimeSlot,
} from "@exam-seat/core";
import {
  buildClassScheduleSheets,
  buildInvigilatorSheets,
  buildXlsx,
  buildZip,
} from "@exam-seat/io";
import type { ClassScheduleOptions, XlsxSheet } from "@exam-seat/io";

/**
 * 多场次（选科）结果页的纯函数层：把 `planAll` 的结果整理成可以直接喂给表格的数据。
 *
 * 这里刻意不碰 Vue、不碰 DOM——页面只负责渲染，排序 / 过滤 / 文案拼装全部可单测。
 */

/** 结果页 VirtualTable 的列定义（与 VirtualTable 的 columns prop 同形）。 */
export interface ScheduleColumn {
  key: string;
  title: string;
  width: number;
  align?: "left" | "center" | "right";
  fixed?: boolean;
}

/** 「每人一张时刻表」的一行。`cells` 以 slotId 为键，存该时段的「考场 · 座位」。 */
export interface ScheduleRow {
  /** VirtualTable 的 rowKey：学号在结果里唯一。 */
  key: string;
  studentId: string;
  name: string;
  className: string;
  combination: string | null;
  /** 组合为空（没填选科字段）时显示「常规」。 */
  combinationLabel: string;
  /** SlotId → 单元格文案，没考试写「—」。 */
  cells: Record<string, string>;
  /** 搜索用的小写关键词：考过的考场名 + 科目名（裸词搜索时匹配）。 */
  keywords: string;
  distinctRooms: number;
  /** 用到了 2 个及以上考场（非常规组合中途换考场）。 */
  changed: boolean;
}

export interface ScheduleTable {
  columns: ScheduleColumn[];
  rows: ScheduleRow[];
}

/** 一个座位方案的单元格文案：`第一考场 · 12号`；没安排写「—」。 */
export function assignmentText(assignment: StudentSlotAssignment | null | undefined): string {
  if (!assignment) return "—";
  return `${assignment.roomName} · ${assignment.seatNo}号`;
}

function roomSubjectsLabel(subjects: readonly string[]): string {
  if (subjects.length === 0) return "";
  if (subjects.length === 1) return subjectLabel(subjects[0]!);
  return subjectListLabel(subjects);
}

/**
 * 构造「每人：时段 → 考场 + 座位」表。
 *
 * 列固定为 班级 / 姓名 / 学号 / 组合，后接每个时段一列；行按班级（中文序）→ 学号排序。
 */
export function buildScheduleTable(
  students: readonly StudentSchedule[],
  slots: readonly TimeSlot[],
): ScheduleTable {
  const columns: ScheduleColumn[] = [
    { key: "className", title: "班级", width: 130 },
    { key: "name", title: "姓名", width: 100, fixed: true },
    { key: "studentId", title: "学号", width: 140 },
    { key: "combination", title: "组合", width: 110 },
    ...slots.map<ScheduleColumn>((slot) => ({ key: slot.id, title: slot.name, width: 170 })),
  ];

  const rows = [...students]
    .sort(
      (a, b) =>
        a.className.localeCompare(b.className, "zh") || a.studentId.localeCompare(b.studentId),
    )
    .map<ScheduleRow>((student) => {
      const cells: Record<string, string> = {};
      const keywords: string[] = [];
      for (const slot of slots) {
        const assignment = student.slots[slot.id];
        cells[slot.id] = assignmentText(assignment);
        if (assignment) {
          keywords.push(assignment.roomName, assignment.subjectLabel, slot.name);
        }
      }
      return {
        key: student.studentId,
        studentId: student.studentId,
        name: student.name,
        className: student.className,
        combination: student.combination,
        combinationLabel: student.combination ?? "常规",
        cells,
        keywords: keywords.join(" ").toLowerCase(),
        distinctRooms: student.distinctRooms,
        changed: student.distinctRooms > 1,
      };
    });

  return { columns, rows };
}

/** 多场次搜索：与其它页同一套查询语义（学号 / 姓名 / 班级）， 另外**不加字段限定**的条件也会拿去匹配「这个人在哪个考场 / 考哪科」，方便老师搜「第一考场」。 */
export function filterScheduleRows(
  rows: readonly ScheduleRow[],
  query: StudentQuery = {},
): ScheduleRow[] {
  const tokens = parseQuery(query.text);
  const classFilter =
    query.classNames && query.classNames.length > 0 ? new Set(query.classNames) : null;

  return rows.filter((row) => {
    if (classFilter && !classFilter.has(row.className)) return false;
    return tokens.every((token) => {
      if (matchToken({ id: row.studentId, name: row.name, className: row.className }, token)) {
        return true;
      }
      // 字段限定只认学生字段；没有限定的裸词才顺便搜考场与科目
      if (token.field) return false;
      return row.keywords.includes(token.value);
    });
  });
}

/** 座位方案概览的一行：考场 × 科目 × 人数。 */
export interface SeatingOverviewRow {
  key: string;
  roomId: string;
  roomName: string;
  /** 原始科目 id，逗号分隔 */
  subjects: string;
  /** 「语数外物化生」这种中文简称 */
  subjectsLabel: string;
  studentCount: number;
  location: string;
  note: string;
  /** 本考场已放宽「同班相邻」（`RoomSpec.relaxSameClass`） */
  relaxed: boolean;
  /** 这套座位里的借考学生数（`SeatingPlan.borrowedSubjects`） */
  borrowedCount: number;
}

export function buildSeatingOverview(seatings: readonly SeatingPlan[]): SeatingOverviewRow[] {
  return seatings.map((seating, index) => ({
    key: `${seating.roomId}:${index}`,
    roomId: seating.roomId,
    roomName: seating.roomName,
    subjects: seating.subjects.join(","),
    subjectsLabel: roomSubjectsLabel(seating.subjects),
    studentCount: seating.studentIds.length,
    location: seating.location ?? "—",
    note: seating.note ?? "—",
    relaxed: seating.relaxedSameClass === true,
    borrowedCount: Object.keys(seating.borrowedSubjects ?? {}).length,
  }));
}

/** 借考明细的一行（结果页「借考」表直接渲染）。 */
export interface BorrowingRow {
  key: string;
  studentId: string;
  name: string;
  className: string;
  /** 时段 id / 名称（从该生的时刻表反查，`BorrowedSeat` 本身不带时段） */
  slotId: string;
  slotName: string;
  subject: string;
  subjectLabel: string;
  roomId: string;
  roomName: string;
  seatNo: number;
}

/**
 * 借考落位：按 `seatings` 的考场顺序 → 座位号排序，方便老师一个考场一个考场核对。
 *
 * `PlanAllResult.borrowings` 已经是扁平明细，这里补齐「时段」展示字段（老师看的是考务表的时段名）， 不重算借考语义。
 */
export function buildBorrowingRows(result: PlanAllResult | null): BorrowingRow[] {
  if (!result) return [];
  const roomOrder = new Map<string, number>();
  for (const [index, seating] of result.seatings.entries()) {
    if (!roomOrder.has(seating.roomId)) roomOrder.set(seating.roomId, index);
  }
  const slotNames = new Map(result.slots.map((slot) => [slot.id, slot.name]));
  const scheduleById = new Map(result.byStudent.map((student) => [student.studentId, student]));

  return [...(result.borrowings ?? [])]
    .sort((a, b) => {
      const ra = roomOrder.get(a.roomId) ?? Number.MAX_SAFE_INTEGER;
      const rb = roomOrder.get(b.roomId) ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      if (a.seatNo !== b.seatNo) return a.seatNo - b.seatNo;
      return a.studentId.localeCompare(b.studentId);
    })
    .map((item) => {
      const schedule = scheduleById.get(item.studentId);
      const slotId =
        Object.keys(schedule?.slots ?? {}).find((id) => {
          const assignment = schedule?.slots[id];
          return (
            assignment != null &&
            assignment.subject === item.subject &&
            assignment.roomId === item.roomId &&
            assignment.seatNo === item.seatNo
          );
        }) ?? "";
      return {
        key: `${item.roomId}:${item.seatNo}:${item.studentId}:${item.subject}`,
        studentId: item.studentId,
        name: item.name,
        className: item.className,
        slotId,
        slotName: slotNames.get(slotId) ?? (slotId || "—"),
        subject: item.subject,
        subjectLabel: item.subjectLabel || subjectLabel(item.subject),
        roomId: item.roomId,
        roomName: item.roomName,
        seatNo: item.seatNo,
      };
    });
}

/** 放宽同班相邻的考场标签（结果页抬头展示）；按 `relaxedRooms` 顺序。 */
export function relaxedRoomLabels(
  result: PlanAllResult | null,
  roomNameById: ReadonlyMap<string, string> = new Map(),
): { roomId: string; roomName: string }[] {
  if (!result) return [];
  const names = new Map<string, string>();
  for (const seating of result.seatings) {
    if (!names.has(seating.roomId)) names.set(seating.roomId, seating.roomName);
  }
  return (result.relaxedRooms ?? []).map((roomId) => ({
    roomId,
    roomName: names.get(roomId) ?? roomNameById.get(roomId) ?? roomId,
  }));
}

/** 校验摘要的一行：每套座位方案的冲突 / 未满足限定 / 诊断条数。 */
export interface SeatingCheckRow {
  key: string;
  roomName: string;
  subjectsLabel: string;
  studentCount: number;
  ok: boolean;
  level: string;
  conflicts: number;
  unmetConstraints: number;
  diagnostics: number;
}

export function buildSeatingChecks(seatings: readonly SeatingPlan[]): SeatingCheckRow[] {
  return seatings.map((seating, index) => ({
    key: `${seating.roomId}:${index}`,
    roomName: seating.roomName,
    subjectsLabel: roomSubjectsLabel(seating.subjects),
    studentCount: seating.studentIds.length,
    ok: seating.result.ok,
    level: seating.result.level,
    conflicts: seating.result.conflicts.length,
    unmetConstraints: seating.result.unmetConstraints.length,
    diagnostics: seating.result.diagnostics.length,
  }));
}

/** 各套 result 的冲突汇总（带上所属考场，页面直接渲染）。 */
export interface SeatingConflictRow extends Conflict {
  key: string;
  roomName: string;
  subjectsLabel: string;
}

export function collectSeatingConflicts(seatings: readonly SeatingPlan[]): SeatingConflictRow[] {
  const rows: SeatingConflictRow[] = [];
  for (const [index, seating] of seatings.entries()) {
    for (const conflict of seating.result.conflicts) {
      rows.push({
        ...conflict,
        key: `${seating.roomId}:${index}:${conflict.seatA}:${conflict.seatB}`,
        roomName: seating.roomName,
        subjectsLabel: roomSubjectsLabel(seating.subjects),
      });
    }
  }
  return rows;
}

/** 各套 result 里「未满足的限定」汇总。 */
export interface SeatingUnmetRow {
  key: string;
  roomName: string;
  subjectsLabel: string;
  constraintId: string;
  studentCount: number;
  reason: string;
}

export function collectSeatingUnmet(seatings: readonly SeatingPlan[]): SeatingUnmetRow[] {
  const rows: SeatingUnmetRow[] = [];
  for (const [index, seating] of seatings.entries()) {
    for (const unmet of seating.result.unmetConstraints) {
      rows.push({
        key: `${seating.roomId}:${index}:${unmet.constraintId}`,
        roomName: seating.roomName,
        subjectsLabel: roomSubjectsLabel(seating.subjects),
        constraintId: unmet.constraintId,
        studentCount: unmet.studentIds.length,
        reason: unmet.reason,
      });
    }
  }
  return rows;
}

/** 多场次诊断 = planAll 自身的诊断；各套 result 的诊断很多是重复的，按 code+message 去重后并入。 */
export function collectMultiDiagnostics(result: PlanAllResult | null): Diagnostic[] {
  if (!result) return [];
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  const push = (diagnostic: Diagnostic): void => {
    const key = `${diagnostic.code}:${diagnostic.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(diagnostic);
  };
  for (const diagnostic of result.diagnostics) push(diagnostic);
  for (const seating of result.seatings) {
    for (const diagnostic of seating.result.diagnostics) push(diagnostic);
  }
  return out;
}

/** 需要换考场的人数（用到 ≥2 个考场）。 */
export function countChangedStudents(students: readonly StudentSchedule[]): number {
  return students.filter((student) => student.distinctRooms > 1).length;
}

/** 按班级统计「需要换考场的人数」，给总览卡片用。 */
export function changedByClass(
  students: readonly StudentSchedule[],
): { className: string; count: number }[] {
  const map = new Map<string, number>();
  for (const student of students) {
    if (student.distinctRooms <= 1) continue;
    map.set(student.className, (map.get(student.className) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([className, count]) => ({ className, count }))
    .sort((a, b) => a.className.localeCompare(b.className, "zh"));
}

/**
 * 座位表要用的 `layout`：考场网格形状 + 讲台侧加座列。
 *
 * 传给 io 的 `buildRoomSheets`；`extraFrontSeats` 是可选字段，io 会据此在网格最上面多画一行「加座」， 缺省时不改变纯矩形考场的既有输出。
 */
export interface RoomGridLayout {
  rows: number;
  cols: number;
  name: string;
  extraFrontSeats?: number[];
}

export function makeRoomLayout(rooms: readonly RoomSpec[]): (roomId: string) => RoomGridLayout {
  const byId = new Map(rooms.map((room) => [room.id, room]));
  return (roomId) => {
    const room = byId.get(roomId);
    if (!room) return { rows: 0, cols: 0, name: roomId };
    const layout: RoomGridLayout = {
      rows: room.rows,
      cols: room.cols,
      name: room.name ?? room.id,
    };
    if (room.extraFrontSeats && room.extraFrontSeats.length > 0) {
      layout.extraFrontSeats = [...room.extraFrontSeats];
    }
    return layout;
  };
}

/* ------------------------------------------------------------------ */
/* 整包下载：分班 / 分考场 单独文件（ZIP）                               */
/* ------------------------------------------------------------------ */

/** ZIP 里的一个文件：文件名（含 `.xlsx`）+ 文件字节。 */
export interface ExportZipFile {
  name: string;
  bytes: Uint8Array;
}

/** 文件名里不能出现的字符：路径分隔符 + Windows 禁用字符（`/ \ : * ? " < > |`）。 */
const UNSAFE_FILE_NAME_CHARS = /[/\\:*?"<>|]/g;

/**
 * 把工作表名洗成安全的文件名（不含扩展名）。
 *
 * Excel 工作表名本身不会带这些字符，但工作表名来自考场 / 班级名，拼进文件名前统一清洗： 命中禁用字符换成 `-`，去掉首尾空白；清洗后为空时退回 `fallback`。
 */
export function safeExportFileName(name: string, fallback = "sheet"): string {
  const cleaned = name.replaceAll(UNSAFE_FILE_NAME_CHARS, "-").trim();
  return cleaned === "" ? fallback : cleaned;
}

/**
 * 逐张 sheet → 一个单表工作簿文件，交给 `buildZip` 打包。
 *
 * 文件名 = 清洗后的 sheet 名 + `.xlsx`；清洗后重名时补 `(2)`、`(3)`…，保证 ZIP 里条目名唯一。
 */
export function sheetsToZipFiles(sheets: readonly XlsxSheet[]): ExportZipFile[] {
  const seen = new Map<string, number>();
  return sheets.map((sheet) => {
    const base = safeExportFileName(sheet.name);
    const hit = seen.get(base) ?? 0;
    seen.set(base, hit + 1);
    return {
      name: hit === 0 ? `${base}.xlsx` : `${base}(${hit + 1}).xlsx`,
      bytes: buildXlsx({ sheets: [sheet] }),
    };
  });
}

/** 「分班文件」整包：总表 + 每班一张表，一张表一个 `.xlsx`，再打成一个 ZIP。 */
export function buildClassFilesZip(
  result: PlanAllResult,
  rooms?: RoomSpec[],
  options?: ClassScheduleOptions,
): Uint8Array {
  return buildZip(sheetsToZipFiles(buildClassScheduleSheets(result, rooms, options)));
}

/** 「分考场文件」整包：每套座位一张表（＝每个考场一张监考表），一张表一个 `.xlsx`，再打成一个 ZIP。 */
export function buildInvigilatorFilesZip(result: PlanAllResult, rooms?: RoomSpec[]): Uint8Array {
  return buildZip(sheetsToZipFiles(buildInvigilatorSheets(result, rooms)));
}
