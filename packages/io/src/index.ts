import * as XLSX from "xlsx";

import type { PlanResult, Student } from "@exam-seat/core";

export interface SheetData {
  name: string;
  /** 表头行（已转成字符串） */
  headers: string[];
  /** 数据行，不含表头 */
  rows: string[][];
}

export interface RosterMapping {
  /** 学号所在列（0 基） */
  id: number;
  /** 姓名所在列 */
  name: number;
  /** 班级所在列 */
  className: number;
  gender?: number;
  note?: number;
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
    const headers = (aoa[0] ?? []).map((cell) => String(cell ?? "").trim());
    const rows = aoa.slice(1).map((row) => headers.map((_, i) => String(row[i] ?? "").trim()));
    return { name, headers, rows };
  });
}

const HEADER_ALIASES: Record<keyof RosterMapping, string[]> = {
  id: ["学号", "考号", "考生号", "准考证号", "学籍号", "编号", "id", "studentid", "studentno"],
  name: ["姓名", "名字", "考生姓名", "学生姓名", "name", "studentname"],
  className: ["班级", "行政班", "所在班级", "班", "class", "classname", "grade"],
  gender: ["性别", "sex", "gender"],
  note: ["备注", "说明", "note", "remark"],
};

function normalizeHeader(header: string): string {
  return header.replaceAll(/[\s_\-（）()]/g, "").toLowerCase();
}

/** 依据表头猜列映射。 */
export function suggestMapping(headers: string[]): {
  mapping: Partial<RosterMapping>;
  missing: (keyof RosterMapping)[];
} {
  const normalized = headers.map(normalizeHeader);
  const mapping: Partial<RosterMapping> = {};
  for (const key of Object.keys(HEADER_ALIASES) as (keyof RosterMapping)[]) {
    const aliases = HEADER_ALIASES[key];
    let found = normalized.findIndex((h) => aliases.includes(h));
    if (found < 0) {
      found = normalized.findIndex((h) => h.length > 0 && aliases.some((a) => h.includes(a)));
    }
    if (found >= 0) mapping[key] = found;
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
} {
  const students: Student[] = [];
  const issues: RosterIssue[] = [];
  const seen = new Set<string>();

  sheet.rows.forEach((row, index) => {
    const excelRow = index + 2; // 含表头行
    const id = String(row[mapping.id] ?? "").trim();
    const name = String(row[mapping.name] ?? "").trim();
    const className = String(row[mapping.className] ?? "").trim();

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
    if (mapping.gender !== undefined) {
      const gender = String(row[mapping.gender] ?? "").trim();
      if (gender) student.gender = gender;
    }
    if (mapping.note !== undefined) {
      const note = String(row[mapping.note] ?? "").trim();
      if (note) student.meta = { note };
    }
    students.push(student);
  });

  return { students, issues };
}

export interface ReadRosterOptions {
  /** 工作表名或下标，缺省取第一张 */
  sheet?: string | number;
  /** 手动指定列映射；不给就自动猜 */
  mapping?: Partial<RosterMapping>;
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
    gender: options.mapping?.gender ?? guessed.mapping.gender,
    note: options.mapping?.note ?? guessed.mapping.note,
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
  };
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

/** 名单表：考场号 / 座位号 / 学号 / 姓名 / 班级 /（性别）。 */
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
  const rows: (string | number)[][] = [];
  rows.push(["排考场结果报告"]);
  rows.push([]);
  rows.push(["是否完美", result.ok ? "是" : "否"]);
  rows.push(["判定级别", result.level]);
  rows.push([
    "相邻规则",
    result.stats.adjacency === "king" ? "8 邻域（含对角）" : "4 邻域（前后左右）",
  ]);
  rows.push(["考生人数", result.stats.participants]);
  rows.push(["班级数", result.stats.classes]);
  rows.push(["考场数", result.stats.rooms]);
  rows.push(["实际用到考场", result.stats.roomsUsed]);
  rows.push(["空置考场", result.stats.emptyRooms.join("、") || "无"]);
  rows.push(["座位总数", result.stats.seatsTotal]);
  rows.push(["已用座位", result.stats.seatsUsed]);
  rows.push(["冲突数", result.stats.conflicts]);
  rows.push(["未满足限定人数", result.stats.unmetConstraints]);
  rows.push(["随机种子", result.stats.seed]);
  rows.push(["数据指纹", result.inputFingerprint]);
  rows.push(["生成时间", result.generatedAt]);
  rows.push([]);
  rows.push(["诊断"]);
  rows.push(["级别", "代码", "说明"]);
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

/** 逐考场一张表：按真实桌面网格排布，方便贴门口。 `seatNoToRC` 由调用方注入，避免 io 依赖 core 的运行时。 */
export function buildRoomSheets(
  result: PlanResult,
  layout: (roomId: string) => { rows: number; cols: number; name: string },
): Uint8Array {
  const byRoom = new Map<string, Map<number, PlanResult["entries"][number]>>();
  for (const e of result.entries) {
    const map = byRoom.get(e.roomId) ?? new Map();
    map.set(e.seatNo, e);
    byRoom.set(e.roomId, map);
  }

  const sheets: { name: string; ws: XLSX.WorkSheet }[] = [];
  for (const [roomId, seats] of byRoom) {
    const info = layout(roomId);
    const rows: (string | number)[][] = [];
    for (let col = 1; col <= info.cols; col += 1) {
      const header: (string | number)[] = [`第${col}列`];
      for (let row = 1; row <= info.rows; row += 1) {
        void row;
        header.push("");
      }
      rows.push(header);
    }
    // 用「行 × 业务列」的网格；业务列 1 = 靠门列
    const grid: string[][] = Array.from({ length: info.rows }, () =>
      Array.from({ length: info.cols }, () => ""),
    );
    for (const e of seats.values()) {
      const r = e.row - 1;
      const c = e.col - 1;
      if (grid[r] && grid[r][c] !== undefined) {
        grid[r][c] = `${e.studentId}\n${e.name}\n${e.className}`;
      }
    }
    const aoa: (string | number)[][] = [
      ["", ...Array.from({ length: info.cols }, (_, i) => `第${i + 1}列`)],
    ];
    for (let r = 0; r < info.rows; r += 1) {
      aoa.push([`第${r + 1}排`, ...grid[r]!]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 8 }, ...Array.from({ length: info.cols }, () => ({ wch: 18 }))];
    ws["!rows"] = Array.from({ length: info.rows + 1 }, () => ({ hpt: 42 }));
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
