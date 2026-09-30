import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import { useConstraintResolver } from "@/composables/useExamJob";
import { useRosterStore } from "@/stores/roster";
import type { Constraint, Student } from "@exam-seat/core";

/** V2 的限定选择器（点名 / 班级 / 组合 / 科目）必须和 core 完全一致： 网页上显示的「命中 N 人」就是求解器眼里那 N 个人。 */
const students: Student[] = [
  {
    id: "A",
    name: "张伟",
    className: "高三(1)班",
    combination: "物化政",
    subjects: ["physics", "chemistry", "politics"],
  },
  {
    id: "B",
    name: "李娜",
    className: "高三(1)班",
    combination: "政史地",
    subjects: ["history", "politics", "geography"],
  },
  {
    id: "C",
    name: "王强",
    className: "高三(2)班",
    combination: "物化生",
    subjects: ["physics", "chemistry", "biology"],
  },
];

const constraint = (patch: Partial<Constraint>): Constraint => ({ id: "C1", ...patch });

describe("限定选择器解析（core 语义，网页只做展示）", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    useRosterStore().replaceStudents(students);
  });

  it("点名 / 班级 / 组合 / 科目四种选择器", () => {
    const { resolveCount, resolveStudentIds } = useConstraintResolver();

    expect(resolveStudentIds(constraint({ studentIds: ["A", "C"] }))).toEqual(["A", "C"]);
    expect(resolveCount(constraint({ classes: ["高三(1)班"] }))).toBe(2);
    expect(resolveCount(constraint({ combinations: ["物化政"] }))).toBe(1);
    expect(resolveCount(constraint({ subjects: ["politics"] }))).toBe(2);
    expect(resolveCount(constraint({ subjects: ["biology"] }))).toBe(1);
  });

  it("多个选择器是并集（与 core 一致）", () => {
    const { resolveCount } = useConstraintResolver();
    expect(resolveCount(constraint({ classes: ["高三(2)班"], subjects: ["politics"] }))).toBe(3);
    expect(resolveCount(constraint({ studentIds: ["A"], combinations: ["政史地"] }))).toBe(2);
  });

  it("组合写法随意：中文简写与「物理+化学+政治」等价", () => {
    const { resolveCount } = useConstraintResolver();
    expect(resolveCount(constraint({ combinations: ["物理+化学+政治"] }))).toBe(1);
    expect(resolveCount(constraint({ combinations: ["物化政"] }))).toBe(1);
  });

  it("没有任何选择器时命中 0 人（由 core 报 CONSTRAINT_NO_SELECTOR）", () => {
    const { resolveCount, resolveStudentIds } = useConstraintResolver();
    expect(resolveCount(constraint({ rows: ["first"] }))).toBe(0);
    expect(resolveStudentIds(constraint({}))).toEqual([]);
  });
});
