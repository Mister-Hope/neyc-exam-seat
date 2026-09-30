import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";

import { createDemoStudents } from "@/lib/demo";
import { loadState, saveState } from "@/lib/persist";
import {
  analyzeSheet,
  missingRequired,
  pickRosterSheet,
  resolveAbsentImport,
  toRosterMapping,
} from "@/lib/roster-import";
import type { AbsentImportReport, RosterAnalysis } from "@/lib/roster-import";
import type { Student } from "@exam-seat/core";
import { readWorkbook, suggestMapping } from "@exam-seat/io";
import type { RosterIssue, RosterMapping, SheetData } from "@exam-seat/io";

interface PersistedRoster {
  students: Student[];
  mapping: RosterMapping | null;
  headers: string[];
  sheetName: string;
  sheetNames: string[];
  issues: RosterIssue[];
  fileName: string;
}

const EMPTY: PersistedRoster = {
  students: [],
  mapping: null,
  headers: [],
  sheetName: "",
  sheetNames: [],
  issues: [],
  fileName: "",
};

const STORAGE_NAME = "roster";

/** 缺考用 `included: false` 标记；没写这个字段的都算参考。 */
function isIncluded(student: Student): boolean {
  return student.included !== false;
}

/** 第 ① 步：名单导入与基础统计；`included === false` 就是第 ② 步的「不参加」。 */
export const useRosterStore = defineStore("roster", () => {
  const saved = loadState<PersistedRoster>(STORAGE_NAME, EMPTY);

  const students = ref<Student[]>(saved.students ?? []);
  const mapping = ref<RosterMapping | null>(saved.mapping ?? null);
  const headers = ref<string[]>(saved.headers ?? []);
  const sheetName = ref<string>(saved.sheetName ?? "");
  const sheetNames = ref<string[]>(saved.sheetNames ?? []);
  const issues = ref<RosterIssue[]>(saved.issues ?? []);
  const fileName = ref<string>(saved.fileName ?? "");
  const errorMessage = ref("");
  /** 本次导入由「缺考」列直接标记为不参加的人数（页面提示用，不持久化）。 */
  const absentMarked = ref(0);

  /** 原始工作表与文件字节只留在内存：刷新后需要重新选文件才能换表/改列映射。 */
  const bytes = shallowRef<Uint8Array | null>(null);
  const sheets = ref<SheetData[]>([]);

  const total = computed(() => students.value.length);
  const classNames = computed(() =>
    [...new Set(students.value.map((s) => s.className).filter((c) => c.length > 0))].sort((a, b) =>
      a.localeCompare(b, "zh"),
    ),
  );
  const classCount = computed(() => classNames.value.length);
  const classSizes = computed(() => {
    const map = new Map<string, number>();
    for (const student of students.value) {
      map.set(student.className, (map.get(student.className) ?? 0) + 1);
    }
    return [...map.entries()].map(([className, count]) => ({ className, count }));
  });
  /** 选科组合分布（v2）：名单里带选科列时，第 ① 步直接给老师看一眼。 */
  const combinationSizes = computed(() => {
    const map = new Map<string, number>();
    for (const student of students.value) {
      const key = student.combination?.trim();
      if (!key) continue;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([combination, count]) => ({ combination, count }))
      .sort((a, b) => a.combination.localeCompare(b.combination, "zh"));
  });

  const subjectCount = computed(() => students.value.filter((s) => Boolean(s.combination)).length);

  const issueCount = computed(() => ({
    errors: issues.value.filter((i) => i.level === "error").length,
    warnings: issues.value.filter((i) => i.level === "warning").length,
  }));

  const excludedStudents = computed(() => students.value.filter((s) => s.included === false));
  const excludedCount = computed(() => excludedStudents.value.length);
  const participants = computed(() => students.value.length - excludedCount.value);

  const studentById = computed(() => new Map(students.value.map((s) => [s.id, s])));

  function persist(): void {
    saveState(STORAGE_NAME, {
      students: students.value,
      mapping: mapping.value,
      headers: headers.value,
      sheetName: sheetName.value,
      sheetNames: sheetNames.value,
      issues: issues.value,
      fileName: fileName.value,
    } satisfies PersistedRoster);
  }

  function adopt(report: RosterAnalysis, sheetNamesValue: string[]): void {
    const previous = new Map(students.value.map((s) => [s.id, s.included]));
    sheetName.value = report.sheetName;
    sheetNames.value = sheetNamesValue;
    headers.value = report.headers;
    mapping.value = report.mapping;
    students.value = report.students.map((s) =>
      previous.get(s.id) === false ? { ...s, included: false } : s,
    );
    issues.value = report.issues;
    absentMarked.value = report.absentCount;
    errorMessage.value = "";
  }

  /** 选表：换表时重新自动识别（列号在不同表里不通用），解析结果替换当前名单，已排除状态按 id 保留。 */
  function selectSheet(name: string, override?: Partial<RosterMapping>): void {
    sheetName.value = name;
    const sheet = sheets.value.find((item) => item.name === name);
    if (!sheet) {
      // 工作表只在内存里：刷新后 sheets 为空，必须重新选文件
      errorMessage.value = bytes.value
        ? `找不到工作表 ${name}，可用的有：${sheets.value.map((item2) => item2.name).join("、")}`
        : "原始表只在内存里：刷新页面后请重新选择文件，才能换表或改列映射";
      return;
    }
    adopt(
      analyzeSheet(sheet, override),
      sheets.value.map((item) => item.name),
    );
  }

  /** 读入工作簿：自动选表（优先能识别出必填三列的那张）+ 自动预填列映射。 必填列没认全时不报错、不解析，只把识别结果留给页面标红提示。 */
  function importSheets(nextSheets: SheetData[], name = ""): boolean {
    sheets.value = nextSheets;
    if (name) fileName.value = name;
    const picked = pickRosterSheet(nextSheets);
    if (!picked) {
      errorMessage.value = "这个 Excel 里没有任何工作表";
      return false;
    }
    adopt(
      analyzeSheet(picked.sheet),
      nextSheets.map((sheet) => sheet.name),
    );
    return true;
  }

  function importBytes(data: Uint8Array, name: string): boolean {
    bytes.value = data;
    fileName.value = name;
    try {
      return importSheets(readWorkbook(data));
    } catch (err) {
      sheets.value = [];
      errorMessage.value = `读不出这个 Excel：${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }

  function updateMapping(partial: Partial<RosterMapping>): void {
    const next: Partial<RosterMapping> = { ...mapping.value, ...partial };
    mapping.value = toRosterMapping(next);
    // 必填列没补全时只更新映射（页面标红），不重解析，避免把已有名单清空
    if (missingRequired(next).length > 0) return;
    selectSheet(sheetName.value, mapping.value);
  }

  /** 导入缺考名单（已读成工作表）：准考证号优先，没有才用 姓名+班级；未匹配的行回报给页面。 */
  function importAbsentSheets(nextSheets: SheetData[]): AbsentImportReport {
    const outcome = resolveAbsentImport(nextSheets, students.value);
    if (outcome.report.ok) students.value = outcome.students;
    return outcome.report;
  }

  function importAbsentBytes(data: Uint8Array): AbsentImportReport {
    try {
      return importAbsentSheets(readWorkbook(data));
    } catch (err) {
      return {
        ok: false,
        error: `读不出这个 Excel：${err instanceof Error ? err.message : String(err)}`,
        keys: 0,
        matched: 0,
        unmatched: 0,
        unmatchedSamples: [],
        issues: [],
      };
    }
  }

  function guessMappingForCurrentSheet(): Partial<RosterMapping> {
    return suggestMapping(headers.value).mapping;
  }

  function setIncluded(ids: readonly string[], included: boolean): number {
    const target = new Set(ids);
    let changed = 0;
    students.value = students.value.map((student) => {
      if (!target.has(student.id)) return student;
      const next = included ? { ...student } : { ...student, included: false };
      if (included) delete next.included;
      changed += 1;
      return next;
    });
    return changed;
  }

  function includeAll(): void {
    students.value = students.value.map((student) => {
      const next = { ...student };
      delete next.included;
      return next;
    });
  }

  function loadDemo(): void {
    bytes.value = null;
    sheets.value = [];
    students.value = createDemoStudents();
    // 示例名单的列映射直接给好：页面不再让老师从头手选
    mapping.value = { id: 0, name: 1, className: 2 };
    headers.value = ["学号", "姓名", "班级"];
    sheetName.value = "示例名单";
    sheetNames.value = ["示例名单"];
    issues.value = [];
    absentMarked.value = 0;
    errorMessage.value = "";
    fileName.value = "示例名单（18 个班 × 54 人）";
  }

  function replaceStudents(next: readonly Student[]): void {
    students.value = next.map((s) => ({ ...s }));
  }

  function reset(): void {
    students.value = [];
    mapping.value = null;
    headers.value = [];
    sheetName.value = "";
    sheetNames.value = [];
    issues.value = [];
    fileName.value = "";
    absentMarked.value = 0;
    errorMessage.value = "";
    bytes.value = null;
    sheets.value = [];
  }

  watch(
    () =>
      [
        students.value,
        mapping.value,
        headers.value,
        sheetName.value,
        sheetNames.value,
        issues.value,
        fileName.value,
      ] as const,
    persist,
    { deep: true },
  );

  return {
    students,
    mapping,
    headers,
    sheetName,
    sheetNames,
    issues,
    fileName,
    errorMessage,
    absentMarked,
    sheets,
    total,
    classNames,
    classCount,
    classSizes,
    combinationSizes,
    subjectCount,
    issueCount,
    excludedStudents,
    excludedCount,
    participants,
    studentById,
    isIncluded,
    importBytes,
    importSheets,
    importAbsentBytes,
    importAbsentSheets,
    selectSheet,
    updateMapping,
    guessMappingForCurrentSheet,
    setIncluded,
    includeAll,
    loadDemo,
    replaceStudents,
    reset,
  };
});
