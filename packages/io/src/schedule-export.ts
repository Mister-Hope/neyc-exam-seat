/**
 * 多场次（选科）的两套导出表：**按班级考场安排** 与 **考场监考表**。
 *
 * 这里只做「把 `PlanAllResult` 变成可打印的 `XlsxSheet`」：样式、A4 横向、冻结表头、每页重复表头 都在 `xlsx.ts` 里落地；`index.ts` 把它连同
 * `./xlsx` 一起再导出，网页与 Node 共用同一套实现。
 */

import { subjectLabel, subjectListLabel } from "@exam-seat/core";
import type {
  PlanAllResult,
  RoomSpec,
  SeatingPlan,
  StudentRoomUsage,
  StudentSchedule,
} from "@exam-seat/core";

import {
  A4_LANDSCAPE_CONTENT_WIDTH_CM,
  MIN_COL_WIDTH,
  buildXlsx,
  exceedsA4Landscape,
  fitToA4Landscape,
  planColumnWidths,
} from "./xlsx";
import type { XlsxCellInput, XlsxSheet } from "./xlsx";

/* ------------------------------------------------------------------ */
/* 多场次（选科）输出                                                   */
/* ------------------------------------------------------------------ */

/** Excel 工作表名上限 31 字符，且不能含这些符号 */
function safeSheetName(name: string): string {
  const cleaned = name.replaceAll(/[[\]:*?/\\]/g, "-").trim() || "Sheet";
  return cleaned.length > 31 ? cleaned.slice(0, 31) : cleaned;
}

/** 单个科目用全名（「政治」），多个科目用简称拼（「语数外物化生」） */
function roomSubjectsLabel(subjects: readonly string[]): string {
  if (subjects.length === 1) return subjectLabel(subjects[0]!);
  return subjectListLabel(subjects);
}

function seatingTitle(roomName: string, subjects: readonly string[]): string {
  const label = roomSubjectsLabel(subjects);
  return label ? `${roomName}（${label}）` : roomName;
}

/**
 * 考场对外展示名：去掉名字里的「（…）」后缀。
 *
 * 老师给的考场名常带科目后缀（「第十七考场 （语史政数英地）」），班级表 / 监考表只保留「第N考场」， 科目由业务逻辑自己拼（否则会出现两个括号）。
 */
export function baseRoomName(room: { id: string; name?: string }): string {
  const name = (room.name ?? "").trim();
  const raw = name === "" ? room.id : name;
  let stripped = raw;
  while (/[（(][^）)]*[）)]\s*$/.test(stripped)) {
    stripped = stripped.replace(/[（(][^）)]*[）)]\s*$/, "").trim();
  }
  return stripped === "" ? raw : stripped;
}

/** 表格末尾列的列名（A、B…Z、AA）。 */
function endColumn(count: number): string {
  let value = Math.max(count, 1);
  let out = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}

/** 输出 A / B 的可选文案；`className` 给了就只产出这一个班。 */
export interface ClassScheduleOptions {
  /** 大标题文案（通常传 `job.meta.title`）；总表标题会加「 总表」 */
  title?: string;
  /** 只生成这个班的内容（单班文件用） */
  className?: string;
  /** 生成时间；缺省用当前时间。测试 / 复现时显式传 */
  generatedAt?: string;
}

function sortByClassAndId(students: readonly StudentSchedule[]): StudentSchedule[] {
  return [...students].sort(
    (a, b) =>
      a.className.localeCompare(b.className, "zh") || a.studentId.localeCompare(b.studentId),
  );
}

/** 主考场：该生座位时段最多的那个考场；并列取 `byStudent.rooms` 里靠前的。 */
function mainRoomId(student: StudentSchedule): string {
  const counts = new Map<string, number>();
  for (const assignment of Object.values(student.slots ?? {})) {
    if (!assignment) continue;
    counts.set(assignment.roomId, (counts.get(assignment.roomId) ?? 0) + 1);
  }
  let best = student.rooms[0]?.roomId ?? "";
  let bestCount = -1;
  for (const room of student.rooms) {
    const count = counts.get(room.roomId) ?? 0;
    if (count > bestCount) {
      bestCount = count;
      best = room.roomId;
    }
  }
  return best;
}

/** 学生用到的考场，主考场排第一。 */
function orderedRooms(student: StudentSchedule): StudentRoomUsage[] {
  const main = mainRoomId(student);
  const primary = student.rooms.find((room) => room.roomId === main);
  if (primary === undefined) return [...student.rooms];
  return [primary, ...student.rooms.filter((room) => room.roomId !== main)];
}

/** 第 index 个考场列的表头文案：第 0 个是主考场，之后是单科考场 1、2… */
function roomLabel(index: number): string {
  return index === 0 ? "主考场" : `单科考场${index}`;
}

/**
 * 考场列表头：每个考场列后面紧跟一列地点。
 *
 * `主考场 | 主考场地点 | 单科考场1 | 单科考场1地点 | …`
 */
function roomColumnHeaders(count: number): string[] {
  const headers: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const label = roomLabel(index);
    headers.push(label, `${label}地点`);
  }
  return headers;
}

/** 两位补零。 */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 生成时间 → `YYYY-MM-DD HH:mm`；给进来的值解析不了就原样返回。 */
function formatGeneratedAt(value?: string): string {
  if (value === undefined) {
    const now = new Date();
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function distinctRoomIds(result: PlanAllResult): string[] {
  const ids = new Set<string>();
  for (const seating of result.seatings) ids.add(seating.roomId);
  for (const student of result.byStudent) {
    for (const room of student.rooms) ids.add(room.roomId);
  }
  return [...ids];
}

/** 考场显示名：优先用 job 里的 `rooms[].name`，再去掉「（…）」后缀。 */
function scheduleRoomName(roomId: string, fallback: string, byId: Map<string, RoomSpec>): string {
  const name = byId.get(roomId)?.name?.trim();
  return baseRoomName({ id: roomId, name: name === undefined || name === "" ? fallback : name });
}

/** 主考场只写「第N考场」，其余考场写「第N考场（科目全名、科目全名）」。 */
function roomCellText(room: StudentRoomUsage, name: string, isMain: boolean): string {
  if (isMain || room.subjects.length === 0) return name;
  return `${name}（${room.subjects.map((subject) => subjectLabel(subject)).join("、")}）`;
}

/** 考场地点：优先用 `byStudent[].rooms[].location`，缺失退回 job 里 `rooms[].location`，再缺留空。 */
function roomLocation(room: StudentRoomUsage, byId: Map<string, RoomSpec>): string {
  const own = room.location?.trim();
  if (own !== undefined && own !== "") return own;
  return byId.get(room.roomId)?.location?.trim() ?? "";
}

/** 姓名默认最多保留几个字 */
export const DEFAULT_NAME_MAX_CHARS = 5;

/**
 * 显示用姓名：超过 `maxChars` 个字就截成前 `maxChars` 个字，否则原样返回。
 *
 * 按**码点**切，不会把一个字切成半个；默认 5 个字（老师的要求）。
 */
export function displayStudentName(name: string, maxChars = DEFAULT_NAME_MAX_CHARS): string {
  // Array.from 按码点切，不会把代理对切成半个字
  const chars = Array.from(name);
  return chars.length <= maxChars ? name : chars.slice(0, maxChars).join("");
}

export interface FitNamesOptions {
  /** 姓名所在列（0 基），班级表是 1、监考表是 2 */
  nameColumn?: number;
  /** 最多保留几个字，缺省 {@link DEFAULT_NAME_MAX_CHARS} */
  maxChars?: number;
  /** A4 横向可用宽度（cm），缺省 27.8；测试里可以调窄来构造超宽场景 */
  availableWidthCm?: number;
  /** 每列最小字符宽，缺省 6 */
  min?: number;
}

/** 把 rows 里姓名列超过 `maxChars` 的值截短；返回新行与「是否真的截过」。 */
function truncateNamesInRows(
  rows: XlsxCellInput[][],
  nameColumn: number,
  maxChars: number,
): { rows: XlsxCellInput[][]; truncatedNames: boolean } {
  let truncated = false;
  const next = rows.map((row) => {
    const cell = row[nameColumn];
    if (cell == null) return row;
    const value = typeof cell === "object" ? cell.value : cell;
    if (typeof value !== "string") return row;
    const short = displayStudentName(value, maxChars);
    if (short === value) return row;
    truncated = true;
    const copy = [...row];
    copy[nameColumn] = typeof cell === "object" ? { ...cell, value: short } : short;
    return copy;
  });
  return truncated ? { rows: next, truncatedNames: true } : { rows, truncatedNames: false };
}

/**
 * 姓名自适应：**整表超 A4 横向可用宽度时**才把姓名截到 `maxChars` 个字。
 *
 * 不超宽一律不动（真实名单里 31 个长姓名、截到 5 字会出现同名，所以默认不能截）； 超宽先截姓名，仍超宽由 `fitToA4Landscape` 等比收窄兜底。
 */
export function fitNamesToA4(
  rows: XlsxCellInput[][],
  opts: FitNamesOptions = {},
): { rows: XlsxCellInput[][]; truncatedNames: boolean } {
  const nameColumn = opts.nameColumn ?? 1;
  const maxChars = opts.maxChars ?? DEFAULT_NAME_MAX_CHARS;
  if (
    !exceedsA4Landscape(rows, {
      min: opts.min ?? MIN_COL_WIDTH,
      availableWidthCm: opts.availableWidthCm ?? A4_LANDSCAPE_CONTENT_WIDTH_CM,
    })
  ) {
    return { rows, truncatedNames: false };
  }
  return truncateNamesInRows(rows, nameColumn, maxChars);
}

/** 班级表里姓名列的下标（班级 | 姓名 | 准考证号 | …） */
const CLASS_NAME_COLUMN = 1;
/** 监考表里姓名列的下标（座位号 | 班级 | 姓名 | 准考证号 | 备注） */
const INVIGILATOR_NAME_COLUMN = 2;

/** 一个班 / 全年级一张班级表的原始行（姓名未截断）。 */
interface ClassTable {
  headers: string[];
  rows: XlsxCellInput[][];
}

function buildClassTable(
  result: PlanAllResult,
  rooms: RoomSpec[] | undefined,
  className?: string,
): ClassTable {
  const byId = new Map((rooms ?? []).map((room) => [room.id, room]));
  const all = sortByClassAndId(result.byStudent);
  const students =
    className === undefined ? all : all.filter((student) => student.className === className);
  const maxRooms = Math.max(1, ...students.map((student) => student.rooms.length));
  const headers = ["班级", "姓名", "准考证号", ...roomColumnHeaders(maxRooms)];

  const rows = students.map<XlsxCellInput[]>((student) => {
    const ordered = orderedRooms(student);
    const cells: XlsxCellInput[] = [];
    for (const [index, room] of ordered.entries()) {
      cells.push({
        value: roomCellText(room, scheduleRoomName(room.roomId, room.roomName, byId), index === 0),
        style: "body",
      });
      cells.push({ value: roomLocation(room, byId), style: "body" });
    }
    while (cells.length < maxRooms * 2) cells.push({ value: "", style: "body" });
    const head: XlsxCellInput[] = [
      { value: student.className, style: "body" },
      { value: student.name, style: "body" },
      { value: student.studentId, style: "body" },
    ];
    return head.concat(cells);
  });

  return { headers, rows };
}

function withHeaderRow(headers: string[], rows: XlsxCellInput[][]): XlsxCellInput[][] {
  return [headers.map<XlsxCellInput>((header) => ({ value: header })), ...rows];
}

/**
 * 输出 A 的数据行。
 *
 * 列：`班级 | 姓名 | 准考证号 | 主考场 | 主考场地点 | 单科考场1 | 单科考场1地点 | …`； 考场列数 = 实际用到的最大数（最少 1
 * 列），用不到的列不出现。**班级列每行都填**（不是只写第一行）， 方便按班级筛选 / 排序。
 *
 * `truncatedNames` = 这次导出是否把姓名截成了 5 个字（整表超 A4 横向宽度才会截，见 {@link fitNamesToA4}）； 判断基于**全年级**，所以总表 /
 * 每班表 / 单班文件的口径一致。 `options.className` 给了就只产出这个班。
 */
export function buildClassScheduleRows(
  result: PlanAllResult,
  rooms: RoomSpec[] | undefined,
  options: ClassScheduleOptions = {},
): { rows: XlsxCellInput[][]; headers: string[]; truncatedNames: boolean } {
  // 截断与否按**全年级**这张表判断：同一工作簿里的总表与每班表、以及单独落盘的班级文件，
  // 都会得到同一个结论，同一学生在各处显示一致。
  const globalTable = buildClassTable(result, rooms);
  const globalFit = fitNamesToA4(withHeaderRow(globalTable.headers, globalTable.rows));
  const target =
    options.className === undefined
      ? globalTable
      : buildClassTable(result, rooms, options.className);
  const rows = globalFit.truncatedNames
    ? truncateNamesInRows(target.rows, CLASS_NAME_COLUMN, DEFAULT_NAME_MAX_CHARS).rows
    : target.rows;

  return { rows, headers: target.headers, truncatedNames: globalFit.truncatedNames };
}

function headRows(
  title: string,
  meta: string,
  headers: string[],
  body: XlsxCellInput[][],
): XlsxCellInput[][] {
  return [
    [{ value: title, style: "title" }],
    [{ value: meta, style: "meta" }],
    headers.map<XlsxCellInput>((header) => ({ value: header, style: "header" })),
    ...body,
  ];
}

const HEAD_ROW_COUNT = 3;
const PRINT_TITLE_ROWS = "1:3";
/** 前 3 行的行高（磅）：大标题 / 小字 / 表头；正文不写行高，交给 Excel 自适应 */
const HEAD_ROW_HEIGHTS = [26, 16, 20];

/**
 * 只用**正文**（表头 + 数据）算列宽，再按 A4 横向收窄。
 *
 * 不把大标题算进去：否则「高二上第一次月考…总表」这种长标题会把第一列撑到 60 字符宽， 打印出来班级列比名字列宽一倍。标题行是合并单元格，居中显示即可。
 */
function tableColWidths(headers: string[], body: XlsxCellInput[][]): number[] {
  return fitToA4Landscape(planColumnWidths(withHeaderRow(headers, body)));
}

function overallClassSheet(
  result: PlanAllResult,
  rooms: RoomSpec[] | undefined,
  options: ClassScheduleOptions,
  generatedAt: string,
): XlsxSheet {
  const { rows, headers } = buildClassScheduleRows(result, rooms);
  const students = new Set(result.byStudent.map((student) => student.studentId));
  const classes = new Set(result.byStudent.map((student) => student.className));
  const roomCount = distinctRoomIds(result).length;
  const title = `${options.title ?? "考场安排"} 总表`;
  const meta = `共 ${students.size} 人 ｜ ${classes.size} 个班 ｜ ${roomCount} 个考场 ｜ 生成时间 ${generatedAt}`;
  return {
    name: "总表",
    rows: headRows(title, meta, headers, rows),
    colWidths: tableColWidths(headers, rows),
    rowHeights: HEAD_ROW_HEIGHTS,
    merges: [`A1:${endColumn(headers.length)}1`],
    freezeRows: HEAD_ROW_COUNT,
    printTitleRows: PRINT_TITLE_ROWS,
  };
}

function singleClassSheet(
  result: PlanAllResult,
  rooms: RoomSpec[] | undefined,
  className: string,
): XlsxSheet {
  const { rows, headers } = buildClassScheduleRows(result, rooms, { className });
  const students = result.byStudent.filter((student) => student.className === className);
  const movers = students.filter((student) => student.distinctRooms > 1).length;
  const title = `${className} 考场安排`;
  const meta = `本班 ${students.length} 人 ｜ 需换考场 ${movers} 人`;
  return {
    name: className,
    rows: headRows(title, meta, headers, rows),
    colWidths: tableColWidths(headers, rows),
    rowHeights: HEAD_ROW_HEIGHTS,
    merges: [`A1:${endColumn(headers.length)}1`],
    freezeRows: HEAD_ROW_COUNT,
    printTitleRows: PRINT_TITLE_ROWS,
  };
}

/**
 * 输出 A 的工作表：第一张「总表」，之后每班一张（sheet 名 = 班级名）。
 *
 * `options.className` 给了就只返回这一个班的那张（落盘单班文件用）。
 */
export function buildClassScheduleSheets(
  result: PlanAllResult,
  rooms: RoomSpec[] | undefined,
  options: ClassScheduleOptions = {},
): XlsxSheet[] {
  const generatedAt = formatGeneratedAt(options.generatedAt);
  if (options.className !== undefined) {
    return [singleClassSheet(result, rooms, options.className)];
  }
  const classes = [
    ...new Set(sortByClassAndId(result.byStudent).map((student) => student.className)),
  ];
  return [
    overallClassSheet(result, rooms, options, generatedAt),
    ...classes.map((className) => singleClassSheet(result, rooms, className)),
  ];
}

/** 输出 A 的完整工作簿 */
export function buildClassScheduleWorkbook(
  result: PlanAllResult,
  rooms: RoomSpec[] | undefined,
  options: ClassScheduleOptions = {},
): Uint8Array {
  return buildXlsx({
    sheets: buildClassScheduleSheets(result, rooms, options),
    title: options.title ?? "考场安排",
  });
}

/**
 * 借考备注：「借考（第6时段 生物）」。
 *
 * 借考座位是**该时段的空位**，同一座号可以被别人在别的时段复用，所以备注必须带时段才看得懂。 时段从 `byStudent[].slots`（该生在该考场的这个科目） 配合
 * `result.slots` 反查；查不到就退回「借考（生物）」，不输出 undefined。
 */
function borrowRemark(
  seating: SeatingPlan,
  studentId: string,
  subjects: readonly string[],
  scheduleById: Map<string, StudentSchedule>,
  slotNames: Map<string, string>,
): string {
  const schedule = scheduleById.get(studentId);
  const labels = subjects.map((subject) => {
    const subjectName = subjectLabel(subject);
    let slotId: string | undefined;
    for (const [id, assignment] of Object.entries(schedule?.slots ?? {})) {
      if (assignment && assignment.roomId === seating.roomId && assignment.subject === subject) {
        slotId = id;
        break;
      }
    }
    const slotName = slotId === undefined ? undefined : slotNames.get(slotId);
    return slotName === undefined ? subjectName : `${slotName} ${subjectName}`;
  });
  return `借考（${labels.join("、")}）`;
}

/**
 * 输出 B：按考场（给监考老师）。
 *
 * 一张表 = 一套座位 = 「考场 × 同一批考生的科目」。常规考场（同组合）只会出一张，例如
 * 「第一考场（语数外物化生）」；某个考场混了组合时会拆成「第一考场（语数外物化）」+「第一考场（生物）」。
 *
 * 表头三行：合并大标题（与 sheet 名同文案）、`地点：… ｜ 考场人数：N`（放宽过的考场再补一句）， 以及 `座位号 | 班级 | 姓名 | 准考证号 |
 * 备注`。**不再有「监考：…」那一行**。 没有任何座位方案时兜底一张「无安排」表。
 */
export function buildInvigilatorSheets(
  result: PlanAllResult,
  rooms: RoomSpec[] | undefined,
): XlsxSheet[] {
  const roomById = new Map((rooms ?? []).map((room) => [room.id, room]));
  const scheduleById = new Map(result.byStudent.map((student) => [student.studentId, student]));
  const slotNames = new Map(result.slots.map((slot) => [slot.id, slot.name]));
  const headers = ["座位号", "班级", "姓名", "准考证号", "备注"];

  const sheets = result.seatings.map<XlsxSheet>((seating) => {
    const spec = roomById.get(seating.roomId);
    const roomName = scheduleRoomName(seating.roomId, seating.roomName, roomById);
    const title = seatingTitle(roomName, seating.subjects);
    const location =
      [seating.location, spec?.location].find(
        (value) => value !== undefined && value.trim() !== "",
      ) ?? "—";
    const relaxed = seating.relaxedSameClass ?? Boolean(spec?.relaxSameClass);
    const entries = Object.entries(seating.seatNoById)
      .map(([studentId, seatNo]) => ({ studentId, seatNo }))
      .sort((a, b) => a.seatNo - b.seatNo);

    const meta = `地点：${location} ｜ 考场人数：${entries.length}${
      relaxed ? " ｜ 本考场已放宽同班相邻" : ""
    }`;
    const body: XlsxCellInput[][] = [];
    for (const { studentId, seatNo } of entries) {
      const student = scheduleById.get(studentId);
      const borrowed = seating.borrowedSubjects?.[studentId];
      const remark =
        borrowed && borrowed.length > 0
          ? borrowRemark(seating, studentId, borrowed, scheduleById, slotNames)
          : "";
      body.push([
        { value: seatNo, style: "body" },
        { value: student?.className ?? "", style: "body" },
        { value: student?.name ?? studentId, style: "body" },
        { value: studentId, style: "body" },
        { value: remark, style: "body" },
      ]);
    }

    // 监考表自己判断是否超宽（目前很窄，不会触发），保证长姓名在这一侧也不太宽
    const fitted = fitNamesToA4(withHeaderRow(headers, body), {
      nameColumn: INVIGILATOR_NAME_COLUMN,
    });

    return {
      name: safeSheetName(title),
      rows: headRows(title, meta, headers, fitted.rows.slice(1)),
      colWidths: tableColWidths(headers, fitted.rows.slice(1)),
      rowHeights: HEAD_ROW_HEIGHTS,
      merges: [`A1:${endColumn(headers.length)}1`],
      freezeRows: HEAD_ROW_COUNT,
      printTitleRows: PRINT_TITLE_ROWS,
    };
  });

  // 一条名单都没有时（例如预检没过），补一张占位表：Excel 不接受空工作簿
  if (sheets.length === 0) {
    return [
      {
        name: "无安排",
        rows: headRows(
          "无安排",
          "本次没有任何考场安排",
          ["说明"],
          [[{ value: "（预检未通过或名单为空）", style: "body" }]],
        ),
        merges: ["A1:E1"],
        freezeRows: HEAD_ROW_COUNT,
        printTitleRows: PRINT_TITLE_ROWS,
      },
    ];
  }
  return sheets;
}

/** 输出 B 的完整工作簿（每个考场一套座位一张表） */
export function buildInvigilatorWorkbook(result: PlanAllResult, rooms?: RoomSpec[]): Uint8Array {
  return buildXlsx({ sheets: buildInvigilatorSheets(result, rooms), title: "考场监考表" });
}
