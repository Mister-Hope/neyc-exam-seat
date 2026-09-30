import type { Student } from "@exam-seat/core";
import { applyAbsentKeys, parseRoster, readAbsentKeys, suggestMapping } from "@exam-seat/io";
import type { AbsentKey, RosterIssue, RosterMapping, SheetData } from "@exam-seat/io";

/**
 * 名单输入的纯逻辑层：文件（工作表数组）→ 列映射 / 学生 / 缺考键。
 *
 * 这一层不碰 Pinia、不碰 DOM，方便单测；页面与 store 只做「读文件 + 展示」。 数据流始终是「store 全量 + 页面按需过滤」，这里不做任何搜索/勾选相关的事。
 */

/** 必填三列：准考证号（学号 / 考证号都算，由 io 的别名表归一化）/ 姓名 / 班级。 */
export const REQUIRED_COLUMNS = ["id", "name", "className"] as const;
export type RequiredColumn = (typeof REQUIRED_COLUMNS)[number];

/** 0 → A、2 → C、26 → AA；-1（未映射）返回 "?"。 */
export function columnLabel(index: number): string {
  if (index < 0) return "?";
  let value = index;
  let label = "";
  do {
    label = String.fromCodePoint(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return label;
}

/** 必填列里没认出来的那几列。 */
export function missingRequired(mapping: Partial<RosterMapping>): RequiredColumn[] {
  return REQUIRED_COLUMNS.filter((key) => {
    const value = mapping[key];
    return value === undefined || value < 0;
  });
}

/** 把可能缺列的部分映射补成完整映射（缺的用 -1 表示「没指定」）。 */
export function toRosterMapping(partial: Partial<RosterMapping>): RosterMapping {
  return {
    id: partial.id ?? -1,
    name: partial.name ?? -1,
    className: partial.className ?? -1,
    gender: partial.gender,
    note: partial.note,
    combination: partial.combination,
    absent: partial.absent,
  };
}

export interface SheetGuess {
  sheet: SheetData;
  index: number;
  /** SuggestMapping 的识别结果（可能只有部分）。 */
  autoMapping: Partial<RosterMapping>;
  /** 必填列里没识别出来的。 */
  missing: RequiredColumn[];
}

export function guessSheet(sheet: SheetData, index = 0): SheetGuess {
  const { mapping } = suggestMapping(sheet.headers);
  return { sheet, index, autoMapping: mapping, missing: missingRequired(mapping) };
}

/** 多表：优先选能识别出必填三列的表；都不全就退回第一张（保留部分识别结果，用户只需补缺的那列）。 */
export function pickRosterSheet(sheets: readonly SheetData[]): SheetGuess | undefined {
  if (sheets.length === 0) return undefined;
  const guesses = sheets.map((sheet, index) => guessSheet(sheet, index));
  return guesses.find((guess) => guess.missing.length === 0) ?? guesses[0];
}

/** 缺考名单选表：能识别出准考证号（id）的表优先，其次 姓名+班级，最后退回第一张。 */
export function pickAbsentSheet(sheets: readonly SheetData[]): SheetData | undefined {
  if (sheets.length === 0) return undefined;
  const guesses = sheets.map((sheet) => ({
    sheet,
    mapping: suggestMapping(sheet.headers).mapping,
  }));
  return (
    guesses.find((guess) => guess.mapping.id !== undefined)?.sheet ??
    guesses.find(
      (guess) => guess.mapping.name !== undefined && guess.mapping.className !== undefined,
    )?.sheet ??
    sheets[0]
  );
}

/** 覆盖手动指定的列（undefined 不覆盖自动识别结果）。 */
function mergeMapping(
  autoMapping: Partial<RosterMapping>,
  override?: Partial<RosterMapping>,
): Partial<RosterMapping> {
  const merged: Partial<RosterMapping> = { ...autoMapping };
  const source = override ?? {};
  for (const key of Object.keys(source) as (keyof RosterMapping)[]) {
    const value = source[key];
    if (value !== undefined) (merged as Record<string, number | undefined>)[key] = value;
  }
  return merged;
}

export interface RosterAnalysis {
  sheetName: string;
  headers: string[];
  /** 自动识别结果（用于区分「自动识别」与「手动指定」）。 */
  autoMapping: Partial<RosterMapping>;
  /** 实际使用的完整映射，缺的列是 -1。 */
  mapping: RosterMapping;
  /** 必填列里没识别出来的（UI 标红用）。 */
  missing: RequiredColumn[];
  students: Student[];
  issues: RosterIssue[];
  /** 名单里 included === false 的人数（缺考列识别出的）。 */
  absentCount: number;
}

/** 解析一张表：自动识别 + 手动覆盖。必填列不全时**不解析**，只把识别结果与缺失列交回页面标红。 */
export function analyzeSheet(sheet: SheetData, override?: Partial<RosterMapping>): RosterAnalysis {
  const autoMapping = suggestMapping(sheet.headers).mapping;
  const mapping = toRosterMapping(mergeMapping(autoMapping, override));
  const missing = missingRequired(mapping);
  const base = { sheetName: sheet.name, headers: sheet.headers, autoMapping, mapping, missing };

  if (missing.length > 0) {
    return { ...base, students: [], issues: [], absentCount: 0 };
  }

  const parsed = parseRoster(sheet, mapping);
  return {
    ...base,
    students: parsed.students,
    issues: parsed.issues,
    absentCount: parsed.students.filter((student) => student.included === false).length,
  };
}

/* ------------------------------------------------------------------ */
/* 缺考名单                                                             */
/* ------------------------------------------------------------------ */

export interface AbsentImportReport {
  ok: boolean;
  /** 失败原因（中文）。 */
  error?: string;
  /** 缺考名单里真正缺席的行数。 */
  keys: number;
  matched: number;
  unmatched: number;
  /** 未匹配行的可读键值（最多前 5 条，供页面提示）。 */
  unmatchedSamples: string[];
  issues: RosterIssue[];
}

/** 「第 3 行 准考证号 S001 / 姓名 张三 / 班级 高三(1)班」。 */
export function formatAbsentKey(key: AbsentKey): string {
  const parts = [`第 ${key.row} 行`];
  if (key.id?.trim()) parts.push(`准考证号 ${key.id.trim()}`);
  if (key.name?.trim()) parts.push(`姓名 ${key.name.trim()}`);
  if (key.className?.trim()) parts.push(`班级 ${key.className.trim()}`);
  return parts.join(" ");
}

const fail = (
  error: string,
  students: readonly Student[],
): { students: Student[]; report: AbsentImportReport } => ({
  students: [...students],
  report: { ok: false, error, keys: 0, matched: 0, unmatched: 0, unmatchedSamples: [], issues: [] },
});

/** 缺考名单（工作表数组）→ 应用到现有名单。 准考证号优先，没有准考证号列才走 姓名+班级；未匹配的行会回报给页面。 */
export function resolveAbsentImport(
  sheets: readonly SheetData[],
  students: readonly Student[],
  sheetName?: string,
): { students: Student[]; report: AbsentImportReport } {
  const sheet = sheetName
    ? sheets.find((item) => item.name === sheetName)
    : pickAbsentSheet(sheets);
  if (!sheet) {
    return fail(
      sheetName
        ? `找不到工作表 ${sheetName}，可用的有：${sheets.map((item) => item.name).join("、")}`
        : "这个 Excel 里没有任何工作表",
      students,
    );
  }

  const { keys, issues } = readAbsentKeys(sheet, suggestMapping(sheet.headers).mapping);
  const errors = issues.filter((issue) => issue.level === "error");
  if (keys.length === 0 && errors.length > 0) {
    return fail(errors[0]!.message, students);
  }

  const applied = applyAbsentKeys([...students], keys);
  return {
    students: applied.students,
    report: {
      ok: true,
      keys: keys.length,
      matched: applied.matched.length,
      unmatched: applied.unmatched.length,
      unmatchedSamples: applied.unmatched.slice(0, 5).map((key) => formatAbsentKey(key)),
      issues: [...issues, ...applied.issues],
    },
  };
}
