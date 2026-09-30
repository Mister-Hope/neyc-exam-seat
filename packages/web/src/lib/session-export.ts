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

/** 监考表要用的 `roomLookup`：从 job 的考场配置里取地点 / 监考老师。 传给 `buildInvigilatorWorkbook` 的第二个参数。 */
export function makeRoomLookup(
  rooms: readonly RoomSpec[],
): (roomId: string) => { location?: string; note?: string } | undefined {
  const byId = new Map(rooms.map((room) => [room.id, room]));
  return (roomId) => {
    const room = byId.get(roomId);
    return room && { location: room.location, note: room.note };
  };
}
