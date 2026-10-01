import * as XLSX from "xlsx";

import { parseCombination, seatNoToRCIn, validateSelection } from "@exam-seat/core";
import type { PlanAllResult, PlanResult, RoomSpec, Student } from "@exam-seat/core";

/** 带样式的极小 xlsx 写出器（`buildXlsx` / `buildZip` / `planColumnWidths` / `fitToA4Landscape`）。 */
export * from "./xlsx";

export interface SheetData {
  name: string;
  /** 表头行（已转成字符串） */
  headers: string[];
  /** 数据行，不含表头 */
  rows: string[][];
}

/**
 * 名单的列映射：每个字段都是**0 基的列号**。
 *
 * 只认下面这几列，其余列（含「性别」「备注」）一律忽略 —— 它们没有任何排考 / 校验 / 导出逻辑使用。 缺考名单里没有 id 列时会退化为「姓名 + 班级」成对定位，见
 * `readAbsentKeys`。
 */
export interface RosterMapping {
  /** 学号所在列（0 基） */
  id: number;
  /** 姓名所在列 */
  name: number;
  /** 班级所在列 */
  className: number;
  /** 选科所在列，例如「物化政」 */
  combination?: number;
  /** 「缺考」标记所在列；有内容即缺席（否定值除外，见 `isAbsentMark`） */
  absent?: number;
}

export interface RosterIssue {
  level: "error" | "warning";
  /** 1 基行号，与 Excel 里看到的一致（含表头行） */
  row: number;
  message: string;
}

export interface RosterReadResult {
  sheetName: string;
  sheetNames: string[];
  headers: string[];
  mapping: RosterMapping;
  students: Student[];
  issues: RosterIssue[];
  /** 统计：`absent` = 被「缺考」列标记为不参加的人数（没有该列时为 0） */
  stats: { total: number; absent: number };
  /** 另传了缺考名单文件时有值；没传时为 `undefined` */
  absent?: AbsentApplication;
}

/** 缺考名单里的一行：有准考证号列就优先用 id，没有才用 姓名 + 班级 成对定位。 */
export interface AbsentKey {
  /** 缺考名单里的 1 基行号（含表头行），未匹配时报出来 */
  row: number;
  /** 准考证号 / 学号（有 id 列时优先） */
  id?: string;
  /** 姓名（没有 id 时与 className 成对使用） */
  name?: string;
  /** 班级（没有 id 时与 name 成对使用） */
  className?: string;
}

/** 把缺考键写成「第 N 行「张三（高三(1)班）」」这样的人话。 */
export function absentKeyLabel(key: AbsentKey): string {
  const who = key.id ?? [key.className, key.name].filter(Boolean).join(" ");
  return `第 ${key.row} 行「${who === "" ? "（空）" : who}」`;
}

/** 一份缺考名单文件作用到主名单后的结果。 */
export interface AbsentApplication {
  /** 缺考名单文件的绝对路径（Node 侧） */
  file: string;
  /** 缺考名单解析出来的全部键 */
  keys: AbsentKey[];
  /** 在主名单里命中的学生 id（只记一次） */
  matched: string[];
  /** 没能在主名单里找到的缺考行 */
  unmatched: AbsentKey[];
  /** 解析与匹配过程中的问题（列缺失是 error，未匹配是 warning） */
  issues: RosterIssue[];
}

function toArrayBuffer(bytes: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 读出工作簿里所有工作表的内容。 */
export function readWorkbook(bytes: Uint8Array | ArrayBuffer): SheetData[] {
  const wb = XLSX.read(toArrayBuffer(bytes), { type: "array" });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    if (!ws) return { name, headers: [], rows: [] };
    const aoa = XLSX.utils.sheet_to_json<string[]>(ws, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false,
    });
    const headers = (aoa[0] ?? []).map((cell) => (cell ?? "").trim());
    const rows = aoa.slice(1).map((row) => headers.map((_, i) => (row[i] ?? "").trim()));
    return { name, headers, rows };
  });
}

const HEADER_ALIASES: Record<keyof RosterMapping, string[]> = {
  id: [
    "学号",
    "考证号",
    "准考证号",
    "准考证",
    "考号",
    "考生号",
    "学籍号",
    "考籍号",
    "编号",
    "id",
    "studentid",
    "studentno",
    "examid",
    "examno",
  ],
  name: ["姓名", "学生姓名", "考生姓名", "名字", "name", "studentname"],
  className: ["班级", "行政班", "所在班级", "教学班", "班", "class", "classname", "grade"],
  absent: [
    "缺考",
    "是否缺考",
    "缺考标记",
    "缺考状态",
    "缺考情况",
    "不参加",
    "不参加考试",
    "缺席",
    "isexcluded",
    "absent",
  ],
  combination: [
    "选科",
    "选考",
    "选考科目",
    "选科组合",
    "选课",
    "组合",
    "科目",
    "学科",
    "elective",
    "combination",
    "subjects",
    "subject",
  ],
};

/**
 * 列归属优先级：同一列只能被一个字段占用，先到先得。
 *
 * `absent` 排在 `combination` 前面：「缺考情况」这类表头不能被选科列抢走。
 */
const FIELD_PRIORITY: (keyof RosterMapping)[] = [
  "id",
  "name",
  "className",
  "absent",
  "combination",
];

/** 全角 ASCII（U+FF01–U+FF5E）→ 半角；其余字符原样。 */
function toHalfWidth(value: string): string {
  return value.replaceAll(/[\uFF01-\uFF5E]/g, (char) =>
    String.fromCodePoint((char.codePointAt(0) ?? 0) - 0xfe_e0),
  );
}

/**
 * 归一化表头：去掉**所有**空白（含 U+3000 全角空格、制表符）、全角 ASCII 转半角、 去掉 `_ - （） () ： :` 等分隔符、转小写。所以 `班 级` / `姓 名` /
 * `准 考 证 号` 都能被认出来。
 */
function normalizeHeader(header: string): string {
  return toHalfWidth(header)
    .replaceAll(/\s/g, "")
    .replaceAll(/[_\-（）：:()]/g, "")
    .toLowerCase();
}

/** 归一化单元格值（缺考判定 / 键匹配用）：去全部空白、全角转半角、字母数字转小写。 */
function normalizeValue(value: string): string {
  return toHalfWidth(value).replaceAll(/\s/g, "").toLowerCase();
}

/** 「缺考」列里表示**不缺席**的取值（已归一化）；其余任何非空内容都视为缺席。 */
const NOT_ABSENT_VALUES = new Set([
  "",
  "否",
  "n",
  "no",
  "false",
  "0",
  "正常",
  "参加",
  "参加考试",
  "不缺考",
  "无",
  "-",
  "—",
  "/",
]);

/**
 * 「缺考」列单元格是否表示**缺席**。
 *
 * 空 → 不缺席；`否 / n / no / false / 0 / 正常 / 参加 / 参加考试 / 不缺考 / 无 / - / — / /`（忽略大小写、全角转半角）→ 不缺席； 其余任何内容
 * → 缺席。全角 `ＮＯ`、`０`、`—` 也能正确判定。
 */
export function isAbsentMark(value: string): boolean {
  return !NOT_ABSENT_VALUES.has(normalizeValue(value));
}

/** 依据表头猜列映射。先全等归一化别名，再「表头包含别名」；包含匹配要求别名 ≥ 2 字。 */
export function suggestMapping(headers: string[]): {
  mapping: Partial<RosterMapping>;
  missing: (keyof RosterMapping)[];
} {
  const normalized = headers.map((header) => normalizeHeader(header));
  const claimed = new Set<number>();
  const mapping: Partial<RosterMapping> = {};

  for (const key of FIELD_PRIORITY) {
    const aliases = HEADER_ALIASES[key]
      .map((alias) => normalizeHeader(alias))
      .filter((alias) => alias.length > 0);
    // 先全等，避免「班主任」这类表头抢走「班」；再「表头包含别名」且别名 ≥ 2 字
    let found = normalized.findIndex(
      (header, index) => !claimed.has(index) && aliases.includes(header),
    );
    if (found < 0) {
      found = normalized.findIndex(
        (header, index) =>
          !claimed.has(index) &&
          aliases.some((alias) => alias.length >= 2 && header.includes(alias)),
      );
    }
    if (found >= 0) {
      mapping[key] = found;
      claimed.add(found);
    }
  }

  const missing: (keyof RosterMapping)[] = [];
  if (mapping.id === undefined) missing.push("id");
  if (mapping.name === undefined) missing.push("name");
  if (mapping.className === undefined) missing.push("className");
  return { mapping, missing };
}

/** 按映射把一张表解析成学生名单。 */
export function parseRoster(
  sheet: SheetData,
  mapping: RosterMapping,
): {
  students: Student[];
  issues: RosterIssue[];
  /** 统计：`absent` = 被「缺考」列标记为不参加的人数 */
  stats: { total: number; absent: number };
} {
  const students: Student[] = [];
  const issues: RosterIssue[] = [];
  const seen = new Set<string>();
  let absent = 0;

  sheet.rows.forEach((row, index) => {
    const excelRow = index + 2; // 含表头行
    const id = (row[mapping.id] ?? "").trim();
    const name = (row[mapping.name] ?? "").trim();
    const className = (row[mapping.className] ?? "").trim();

    if (!id && !name && !className) return; // 空行
    if (!id) {
      issues.push({ level: "error", row: excelRow, message: "缺少学号，这一行被跳过" });
      return;
    }
    if (seen.has(id)) {
      issues.push({ level: "error", row: excelRow, message: `学号 ${id} 重复，这一行被跳过` });
      return;
    }
    if (!className) {
      issues.push({ level: "warning", row: excelRow, message: `学号 ${id} 没有班级` });
    }
    if (!name) {
      issues.push({ level: "warning", row: excelRow, message: `学号 ${id} 没有姓名` });
    }
    seen.add(id);
    const student: Student = { id, name, className };
    // 「性别」「备注」列不解析：它们没有任何排考 / 校验 / 导出逻辑使用（老 job.json 里可能已有
    // `student.gender` / `student.meta`，类型字段保留，但这里不再产生）
    if (mapping.combination !== undefined) {
      const raw = (row[mapping.combination] ?? "").trim();
      if (raw) {
        const parsed = parseCombination(raw);
        student.combination = raw;
        if (parsed.subjects.length > 0) student.subjects = parsed.subjects;
        if (parsed.unknown.length > 0) {
          issues.push({
            level: "warning",
            row: excelRow,
            message: `选科「${raw}」里有认不出的字：${parsed.unknown.join("")}`,
          });
        }
        const problems = validateSelection(parsed.subjects);
        if (problems.length > 0) {
          issues.push({
            level: "warning",
            row: excelRow,
            message: `选科「${raw}」不符合 3+1+2：${problems.join("；")}`,
          });
        }
      }
    }
    if (mapping.absent !== undefined && isAbsentMark(row[mapping.absent] ?? "")) {
      // 「缺考」列有内容（否定值除外）= 这份文件是「完整名单 + 标记」
      student.included = false;
      absent += 1;
    }
    students.push(student);
  });

  return { students, issues, stats: { total: students.length, absent } };
}

export interface ReadRosterOptions {
  /** 工作表名或下标，缺省取第一张 */
  sheet?: string | number;
  /** 手动指定列映射；不给就自动猜 */
  mapping?: Partial<RosterMapping>;
  /** 另传一份缺考名单文件（只有 Node 侧的 `readRosterFile` 会读它） */
  absentFile?: string;
  /** 缺考名单的工作表名或下标，缺省取第一张 */
  absentSheet?: string | number;
  /** 手动指定缺考名单的列映射 */
  absentMapping?: Partial<RosterMapping>;
}

/** 一站式：字节 → 学生名单。 */
export function readRoster(
  bytes: Uint8Array | ArrayBuffer,
  options: ReadRosterOptions = {},
): RosterReadResult {
  const sheets = readWorkbook(bytes);
  if (sheets.length === 0) throw new Error("这个 Excel 里没有任何工作表");

  let sheet: SheetData | undefined;
  if (typeof options.sheet === "number") sheet = sheets[options.sheet];
  else if (typeof options.sheet === "string") sheet = sheets.find((s) => s.name === options.sheet);
  else sheet = sheets[0];
  if (!sheet) {
    throw new Error(
      `找不到工作表 ${String(options.sheet)}，可用的有：${sheets.map((s) => s.name).join("、")}`,
    );
  }

  const guessed = suggestMapping(sheet.headers);
  const mapping: RosterMapping = {
    id: options.mapping?.id ?? guessed.mapping.id ?? -1,
    name: options.mapping?.name ?? guessed.mapping.name ?? -1,
    className: options.mapping?.className ?? guessed.mapping.className ?? -1,
    combination: options.mapping?.combination ?? guessed.mapping.combination,
    absent: options.mapping?.absent ?? guessed.mapping.absent,
  };
  if (mapping.id < 0 || mapping.name < 0 || mapping.className < 0) {
    const missing = [
      mapping.id < 0 ? "学号" : null,
      mapping.name < 0 ? "姓名" : null,
      mapping.className < 0 ? "班级" : null,
    ].filter(Boolean);
    throw new Error(
      `认不出这些列：${missing.join("、")}。表头是「${sheet.headers.join("、")}」，请手动指定列映射。`,
    );
  }

  const parsed = parseRoster(sheet, mapping);
  return {
    sheetName: sheet.name,
    sheetNames: sheets.map((s) => s.name),
    headers: sheet.headers,
    mapping,
    students: parsed.students,
    issues: parsed.issues,
    stats: parsed.stats,
  };
}

/* ------------------------------------------------------------------ */
/* 缺考名单（另一份文件，浏览器 / Node 通用）                            */
/* ------------------------------------------------------------------ */

/**
 * 从一张「缺考名单」表里解析出缺考键。
 *
 * - 该表**自带「缺考」列** → 这是「完整名单 + 标记」，只取真正缺席的行（见 `isAbsentMark`）；
 * - 否则**有 id 列就用 id**（优先）；没有 id 列时必须同时有 姓名 + 班级，缺列返回 error issue；
 * - 定位不到人的行会给出 warning issue（不静默）。
 */
export function readAbsentKeys(
  sheet: SheetData,
  mapping: Partial<RosterMapping> = {},
): { keys: AbsentKey[]; issues: RosterIssue[] } {
  const guessed = suggestMapping(sheet.headers);
  const resolved: Partial<RosterMapping> = { ...guessed.mapping, ...mapping };
  const keys: AbsentKey[] = [];
  const issues: RosterIssue[] = [];

  const hasId = resolved.id !== undefined;
  const hasName = resolved.name !== undefined;
  const hasClass = resolved.className !== undefined;
  const absentColumn = resolved.absent;

  if (!hasId && !(hasName && hasClass)) {
    const missing: string[] = [];
    if (!hasName) missing.push("姓名");
    if (!hasClass) missing.push("班级");
    const detail =
      missing.length === 2 ? "也没有「姓名 + 班级」两列" : `也没有「${missing.join("、")}」列`;
    issues.push({
      level: "error",
      row: 1,
      message: `缺考名单里没有能识别的「准考证号 / 学号」列，${detail}；表头是「${sheet.headers.join(
        "、",
      )}」，请手动指定列映射。`,
    });
    return { keys, issues };
  }

  sheet.rows.forEach((row, index) => {
    const excelRow = index + 2; // 含表头行
    const id = hasId ? (row[resolved.id!] ?? "").trim() : "";
    const name = hasName ? (row[resolved.name!] ?? "").trim() : "";
    const className = hasClass ? (row[resolved.className!] ?? "").trim() : "";

    const marked = absentColumn !== undefined && isAbsentMark(row[absentColumn] ?? "");
    // 自带「缺考」列 → 只取真正缺席的行
    if (absentColumn !== undefined && !marked) return;
    // 空行（但如果这一行被标记了缺席，就不能静默丢弃）
    if (id === "" && name === "" && className === "" && !marked) return;

    if (id !== "") {
      keys.push({ row: excelRow, id });
    } else if (name !== "" && className !== "") {
      keys.push({ row: excelRow, name, className });
    } else {
      issues.push({
        level: "warning",
        row: excelRow,
        message: `缺考名单第 ${excelRow} 行没有准考证号，也没有「姓名 + 班级」，无法定位到学生，这一行被跳过`,
      });
    }
  });

  return { keys, issues };
}

/**
 * 把缺考键作用到主名单上。
 *
 * - 匹配键归一化：去全部空白、全角转半角、字母数字转小写；id 走 id 精确匹配，(班级, 姓名) 走成对精确匹配；
 * - 命中者 `included: false`（与「缺考」列的结果取并集）；
 * - 未命中者进 `unmatched` 并生成 warning issue（写明第几行与键值）；
 * - **不修改原数组**：返回新数组，命中/未命中的元素都是浅拷贝。
 */
export function applyAbsentKeys(
  students: Student[],
  keys: AbsentKey[],
): { students: Student[]; matched: string[]; unmatched: AbsentKey[]; issues: RosterIssue[] } {
  const byId = new Map<string, number>();
  const byNameClass = new Map<string, number>();
  students.forEach((student, index) => {
    const idKey = normalizeValue(student.id);
    if (idKey !== "" && !byId.has(idKey)) byId.set(idKey, index);
    const pairKey = `${normalizeValue(student.className)}\u0000${normalizeValue(student.name)}`;
    if (!byNameClass.has(pairKey)) byNameClass.set(pairKey, index);
  });

  const next = students.map((student) => ({ ...student }));
  const matched: string[] = [];
  const unmatched: AbsentKey[] = [];
  const issues: RosterIssue[] = [];
  const hitIndexes = new Set<number>();

  for (const key of keys) {
    const idKey = key.id === undefined ? "" : normalizeValue(key.id);
    const pairKey = `${normalizeValue(key.className ?? "")}\u0000${normalizeValue(key.name ?? "")}`;
    const index = idKey === "" ? (byNameClass.get(pairKey) ?? -1) : (byId.get(idKey) ?? -1);

    if (index < 0) {
      unmatched.push(key);
      issues.push({
        level: "warning",
        row: key.row,
        message: `缺考名单${absentKeyLabel(key)}在主名单里没找到，这一行被忽略`,
      });
      continue;
    }
    if (hitIndexes.has(index)) continue; // 同一学生被多行命中只置一次
    hitIndexes.add(index);
    const updated: Student = { ...next[index]!, included: false };
    next[index] = updated;
    matched.push(updated.id);
  }

  return { students: next, matched, unmatched, issues };
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

function sheetFromRows(rows: (string | number)[][], widths: number[]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = widths.map((w) => ({ wch: w }));
  return ws;
}

function writeWorkbook(sheets: { name: string; ws: XLSX.WorkSheet }[]): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const { name, ws } of sheets) XLSX.utils.book_append_sheet(wb, ws, name);
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  return new Uint8Array(out);
}

/** 名单表：考场号 / 座位号 / 学号 / 姓名 / 班级（不含性别——姓名/性别这类扩展列都不参与排考与导出）。 */
export function planToRows(result: PlanResult): (string | number)[][] {
  const rows: (string | number)[][] = [["考场", "座位号", "学号", "姓名", "班级"]];
  for (const e of result.entries) {
    rows.push([e.roomName, e.seatNo, e.studentId, e.name, e.className]);
  }
  return rows;
}

/** 按班级分组的名单表。 */
export function classRows(result: PlanResult): (string | number)[][] {
  const rows: (string | number)[][] = [["班级", "学号", "姓名", "考场", "座位号"]];
  const sorted = [...result.entries].sort(
    (a, b) =>
      a.className.localeCompare(b.className, "zh") || a.studentId.localeCompare(b.studentId),
  );
  for (const e of sorted) rows.push([e.className, e.studentId, e.name, e.roomName, e.seatNo]);
  return rows;
}

/** 校验 / 诊断报告表。 */
export function reportRows(result: PlanResult): (string | number)[][] {
  const rows: (string | number)[][] = [
    ["排考场结果报告"],
    [],
    ["是否完美", result.ok ? "是" : "否"],
    ["判定级别", result.level],
    ["相邻规则", result.stats.adjacency === "king" ? "8 邻域（含对角）" : "4 邻域（前后左右）"],
    ["考生人数", result.stats.participants],
    ["班级数", result.stats.classes],
    ["考场数", result.stats.rooms],
    ["实际用到考场", result.stats.roomsUsed],
    ["空置考场", result.stats.emptyRooms.join("、") || "无"],
    ["座位总数", result.stats.seatsTotal],
    ["已用座位", result.stats.seatsUsed],
    ["冲突数", result.stats.conflicts],
    ["未满足限定人数", result.stats.unmetConstraints],
    ["随机种子", result.stats.seed],
    ["数据指纹", result.inputFingerprint],
    ["生成时间", result.generatedAt],
    [],
    ["诊断"],
    ["级别", "代码", "说明"],
  ];
  for (const d of result.diagnostics) {
    rows.push([d.severity, d.code, d.message]);
  }
  if (result.conflicts.length > 0) {
    rows.push([]);
    rows.push(["冲突明细"]);
    rows.push(["考场", "座位A", "座位B", "学生A", "学生B", "班级"]);
    for (const c of result.conflicts) {
      rows.push([c.roomId, c.seatA, c.seatB, c.studentA, c.studentB, c.className]);
    }
  }
  if (result.unmetConstraints.length > 0) {
    rows.push([]);
    rows.push(["未满足的限定"]);
    rows.push(["限定ID", "涉及学生", "原因"]);
    for (const u of result.unmetConstraints) {
      rows.push([u.constraintId, u.studentIds.join("、"), u.reason]);
    }
  }
  return rows;
}

/** 生成完整的考场安排名单.xlsx */
export function buildPlanWorkbook(result: PlanResult, jobTitle?: string): Uint8Array {
  void jobTitle;
  return writeWorkbook([
    { name: "考场安排名单", ws: sheetFromRows(planToRows(result), [10, 8, 14, 12, 14]) },
    { name: "按班级", ws: sheetFromRows(classRows(result), [14, 14, 12, 10, 8]) },
    { name: "校验报告", ws: sheetFromRows(reportRows(result), [18, 24, 60, 14, 14, 14]) },
  ]);
}

/** 座位表里单个考场的网格形状；`extraFrontSeats` 缺省 = 纯矩形。 */
export interface RoomSheetLayout {
  rows: number;
  cols: number;
  name: string;
  /** 讲台一侧加座所在业务列（从靠门侧起算），例如 `[2, 4]`；缺省 = 纯矩形。 */
  extraFrontSeats?: number[];
}

/**
 * 逐考场一张表：按真实桌面网格排布，方便贴门口。
 *
 * 有加座（`extraFrontSeats`）时在网格最上面多画一行「加座」，加座画在对应业务列；行 / 列都用 core 的编号函数算， 不在这里重写蛇形。`layout` 回调返回值新增的
 * `extraFrontSeats` 是可选字段，缺省时行为与纯矩形完全一致。
 */
export function buildRoomSheets(
  result: PlanResult,
  layout: (roomId: string) => RoomSheetLayout,
): Uint8Array {
  const byRoom = new Map<string, Map<number, PlanResult["entries"][number]>>();
  for (const e of result.entries) {
    const map = byRoom.get(e.roomId) ?? new Map<number, PlanResult["entries"][number]>();
    map.set(e.seatNo, e);
    byRoom.set(e.roomId, map);
  }

  const sheets: { name: string; ws: XLSX.WorkSheet }[] = [];
  for (const [roomId, seats] of byRoom) {
    const info = layout(roomId);
    // 去重 + 越界过滤，避免 layout 回调给脏数据时把网格画歪
    const extra = [...new Set(info.extraFrontSeats)]
      .filter((col) => Number.isInteger(col) && col >= 1 && col <= info.cols)
      .sort((a, b) => a - b);
    const roomSpec: RoomSpec = {
      id: roomId,
      rows: info.rows,
      cols: info.cols,
      extraFrontSeats: extra,
    };
    // 有加座时网格顶部多一行「加座」（加座的行号是 0，第 1 排之前）
    const extraRow = extra.length > 0 ? 1 : 0;
    // 用「行 × 业务列」的网格；业务列 1 = 靠门列
    const grid: string[][] = Array.from({ length: info.rows + extraRow }, () =>
      Array.from({ length: info.cols }, () => ""),
    );
    for (const e of seats.values()) {
      const { row, col } = seatNoToRCIn(roomSpec, e.seatNo);
      const r = row === 0 ? 0 : row - 1 + extraRow;
      const c = col - 1;
      if (grid[r] && grid[r][c] !== undefined) {
        grid[r][c] = `${e.studentId}\n${e.name}\n${e.className}`;
      }
    }
    const aoa: (string | number)[][] = [
      ["", ...Array.from({ length: info.cols }, (_, i) => `第${i + 1}列`)],
    ];
    if (extraRow === 1) aoa.push(["加座", ...grid[0]!]);
    for (let r = 0; r < info.rows; r += 1) {
      aoa.push([`第${r + 1}排`, ...grid[r + extraRow]!]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 8 }, ...Array.from({ length: info.cols }, () => ({ wch: 18 }))];
    ws["!rows"] = Array.from({ length: info.rows + extraRow + 1 }, () => ({ hpt: 42 }));
    sheets.push({ name: info.name.slice(0, 28), ws });
  }

  // 一条名单都没有时（例如预检就没过），SheetJS 不允许写空工作簿，补一张占位表
  if (sheets.length === 0) {
    sheets.push({
      name: "无安排",
      ws: XLSX.utils.aoa_to_sheet([["本次没有任何座位安排"], ["（预检未通过或名单为空）"]]),
    });
  }
  return writeWorkbook(sheets);
}

/* ------------------------------------------------------------------ */
/* 空置考场剔除（浏览器 / Node 通用）                                   */
/* ------------------------------------------------------------------ */

export interface PrunedJob<T> {
  /** 剔除空置考场后的新 job（浅拷贝，原对象不动） */
  job: T;
  /** 被剔除的空置考场，按原 `rooms` 顺序 */
  removed: RoomSpec[];
}

/**
 * 从求解结果推导真正用到了座位的考场 id（按首次出现顺序去重）。
 *
 * 单场看 `entries`；多场次看 `seatings`。与 core 判定 `emptyRooms` 的口径一致： 只要这个考场里坐过至少一个人，就不算空置。
 */
export function usedRoomIds(result: PlanResult | PlanAllResult): string[] {
  const roomIds =
    "seatings" in result
      ? result.seatings.map((seating) => seating.roomId)
      : result.entries.map((entry) => entry.roomId);
  return [...new Set(roomIds)];
}

/**
 * 返回剔除「没用到的考场」后的新 job，**不原地修改**。
 *
 * `usedIds` 之外的考场一律算空置（通常由 `usedRoomIds(result)` 提供）； `removed` 保持原 `rooms` 顺序，方便按老师配置的顺序提示。
 */
export function pruneEmptyRooms<T extends { rooms?: RoomSpec[] }>(
  job: T,
  usedIds: Iterable<string>,
): PrunedJob<T> {
  const used = new Set(usedIds);
  const rooms = job.rooms ?? [];
  const kept = rooms.filter((room) => used.has(room.id));
  const removed = rooms.filter((room) => !used.has(room.id));
  return { job: { ...job, rooms: kept }, removed };
}

/** 多场次两套导出表（`buildClassScheduleSheets` / `buildInvigilatorSheets` 等）。 */
export * from "./schedule-export";

/** 考场名的中文序号解析与自然排序（`chineseNumberToArabic` / `sortByRoomOrder` 等）。 */
export * from "./room-order";
