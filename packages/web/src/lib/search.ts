import type { Student } from "@exam-seat/core";

/**
 * 名单搜索（纯函数，无 DOM）。第 ②③④ 步共用同一套查询语义：
 *
 * - 空格分隔多个条件，**全部命中**才算匹配（AND）。
 * - 每个条件默认在「学号 / 姓名 / 班级」三个字段里**模糊匹配**（忽略大小写的子串）。
 * - 支持 `字段:值` 限定到单个字段，例如 `班级:高三(1)`、`姓名:张`、`学号:2024`。
 * - 全角空格、全角冒号都当分隔符处理，老师从 Excel 粘贴过来也能直接用。
 */
export type StudentField = "id" | "name" | "className";

export interface QueryToken {
  field?: StudentField;
  value: string;
}

export interface StudentQuery {
  text?: string;
  /** 班级精确过滤，多选时为「或」 */
  classNames?: readonly string[];
}

const FIELD_ALIASES: Record<string, StudentField> = {
  学号: "id",
  考号: "id",
  考生号: "id",
  准考证号: "id",
  编号: "id",
  id: "id",
  studentid: "id",
  姓名: "name",
  名字: "name",
  学生姓名: "name",
  name: "name",
  班级: "className",
  行政班: "className",
  班: "className",
  class: "className",
  classname: "className",
};

/** 把查询串拆成条件列表。 */
export function parseQuery(text: string | undefined): QueryToken[] {
  if (!text) return [];
  const normalized = text.replaceAll(/[：]/g, ":").replaceAll(/[\u3000\t\n\r]/g, " ");
  return normalized
    .split(" ")
    .map((raw) => raw.trim())
    .filter((raw) => raw.length > 0)
    .map((raw) => {
      const at = raw.indexOf(":");
      if (at <= 0) return { value: raw.toLowerCase() };
      const field = FIELD_ALIASES[raw.slice(0, at).trim().toLowerCase()];
      const value = raw
        .slice(at + 1)
        .trim()
        .toLowerCase();
      if (!field || !value) return { value: raw.toLowerCase() };
      return { field, value };
    });
}

export function matchToken(
  student: Pick<Student, "id" | "name" | "className">,
  token: QueryToken,
): boolean {
  if (token.field === "id") return student.id.toLowerCase().includes(token.value);
  if (token.field === "name") return student.name.toLowerCase().includes(token.value);
  if (token.field === "className") return student.className.toLowerCase().includes(token.value);
  return (
    student.id.toLowerCase().includes(token.value) ||
    student.name.toLowerCase().includes(token.value) ||
    student.className.toLowerCase().includes(token.value)
  );
}

/** 名单过滤：先按班级集合过滤，再按查询串（多条件 AND）。 */
export function filterStudents<T extends Pick<Student, "id" | "name" | "className">>(
  students: readonly T[],
  query: StudentQuery = {},
): T[] {
  const tokens = parseQuery(query.text);
  const classFilter =
    query.classNames && query.classNames.length > 0 ? new Set(query.classNames) : null;
  return students.filter((student) => {
    if (classFilter && !classFilter.has(student.className)) return false;
    return tokens.every((token) => matchToken(student, token));
  });
}

/** 把一串学号压缩成「张三、李四 等 12 人」这种摘要。 */
export function summarizeNames(names: readonly string[], limit = 3): string {
  const shown = names.slice(0, limit).join("、");
  return names.length > limit ? `${shown} 等 ${names.length} 人` : shown;
}
