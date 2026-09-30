import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";

import { createDemoStudents } from "@/lib/demo";
import { loadState, saveState } from "@/lib/persist";
import type { Student } from "@exam-seat/core";
import { parseRoster, readRoster, readWorkbook, suggestMapping } from "@exam-seat/io";
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
  const issueCount = computed(() => ({
    errors: issues.value.filter((i) => i.level === "error").length,
    warnings: issues.value.filter((i) => i.level === "warning").length,
  }));

  const excludedStudents = computed(() => students.value.filter((s) => s.included === false));
  const excludedCount = computed(() => excludedStudents.value.length);
  const participants = computed(() => students.value.length - excludedCount.value);

  const studentById = computed(() => new Map(students.value.map((s) => [s.id, s])));

  function isIncluded(student: Student): boolean {
    return student.included !== false;
  }

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

  function adopt(report: {
    sheetName: string;
    sheetNames: string[];
    headers: string[];
    mapping: RosterMapping;
    students: Student[];
    issues: RosterIssue[];
  }): void {
    const previous = new Map(students.value.map((s) => [s.id, s.included]));
    sheetName.value = report.sheetName;
    sheetNames.value = report.sheetNames;
    headers.value = report.headers;
    mapping.value = report.mapping;
    students.value = report.students.map((s) =>
      previous.get(s.id) === false ? { ...s, included: false } : s,
    );
    issues.value = report.issues;
    errorMessage.value = "";
  }

  /** 选表 / 改列映射后重新解析。优先走 readRoster，认不出列时退回 parseRoster 让老师手点。 */
  function selectSheet(name: string, override?: Partial<RosterMapping>): void {
    sheetName.value = name;
    const data = bytes.value;
    const current = { ...mapping.value, ...override };
    const complete =
      typeof current.id === "number" &&
      current.id >= 0 &&
      typeof current.name === "number" &&
      current.name >= 0 &&
      typeof current.className === "number" &&
      current.className >= 0;
    if (!data) {
      errorMessage.value = "原始表只在内存里：刷新页面后请重新选择文件，才能换表或改列映射";
      return;
    }
    try {
      adopt(readRoster(data, complete ? { sheet: name, mapping: current } : { sheet: name }));
    } catch (err) {
      const sheet = sheets.value.find((s) => s.name === name);
      headers.value = sheet?.headers ?? [];
      errorMessage.value = err instanceof Error ? err.message : String(err);
      // 自动认列失败时，仍用现有（哪怕是空的）映射解析一遍，保持表格可见
      if (sheet && complete) {
        const parsed = parseRoster(sheet, current as RosterMapping);
        students.value = parsed.students;
        issues.value = parsed.issues;
        mapping.value = current as RosterMapping;
      } else {
        mapping.value = complete ? (current as RosterMapping) : null;
        students.value = [];
        issues.value = [];
      }
    }
  }

  function importBytes(data: Uint8Array, name: string): void {
    bytes.value = data;
    fileName.value = name;
    sheets.value = readWorkbook(data);
    const first = sheets.value[0]?.name;
    if (first === undefined) {
      errorMessage.value = "这个 Excel 里没有任何工作表";
      return;
    }
    mapping.value = null;
    selectSheet(first);
  }

  function updateMapping(partial: Partial<RosterMapping>): void {
    const next = { ...mapping.value, ...partial } as RosterMapping;
    mapping.value = next;
    if (next.id >= 0 && next.name >= 0 && next.className >= 0) selectSheet(sheetName.value, next);
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
    mapping.value = null;
    headers.value = ["学号", "姓名", "班级"];
    sheetName.value = "示例名单";
    sheetNames.value = ["示例名单"];
    issues.value = [];
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
    sheets,
    total,
    classNames,
    classCount,
    classSizes,
    issueCount,
    excludedStudents,
    excludedCount,
    participants,
    studentById,
    isIncluded,
    importBytes,
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
