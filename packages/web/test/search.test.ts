import { describe, expect, it } from "vitest";

import { filterStudents, matchToken, parseQuery, summarizeNames } from "@/lib/search";
import type { Student } from "@exam-seat/core";

const students: Student[] = [
  { id: "20240101", name: "张三", className: "高三(1)班" },
  { id: "20240202", name: "李四", className: "高三(2)班" },
  { id: "20250101", name: "张小四", className: "高三(1)班" },
  { id: "20260303", name: "王五", className: "高三(10)班" },
];

const ids = (list: Student[]): string[] => list.map((student) => student.id);

describe("名单搜索（多条件模糊匹配）", () => {
  it("空查询返回全部", () => {
    expect(filterStudents(students)).toHaveLength(4);
    expect(filterStudents(students, { text: "   " })).toHaveLength(4);
  });

  it("单个词在学号 / 姓名 / 班级三个字段里模糊匹配", () => {
    expect(ids(filterStudents(students, { text: "20240202" }))).toEqual(["20240202"]);
    expect(ids(filterStudents(students, { text: "张" }))).toEqual(["20240101", "20250101"]);
    expect(ids(filterStudents(students, { text: "高三(1)班" }))).toEqual(["20240101", "20250101"]);
  });

  it("多个条件是「与」：全部命中才算匹配", () => {
    expect(ids(filterStudents(students, { text: "高三(1)班 张" }))).toEqual([
      "20240101",
      "20250101",
    ]);
    expect(ids(filterStudents(students, { text: "高三(1)班 李" }))).toEqual([]);
    expect(ids(filterStudents(students, { text: "20250101 张小四" }))).toEqual(["20250101"]);
  });

  it("支持 `字段:值` 限定到单个字段，全角冒号 / 全角空格也认", () => {
    expect(ids(filterStudents(students, { text: "姓名:张" }))).toEqual(["20240101", "20250101"]);
    expect(ids(filterStudents(students, { text: "班级:高三(2)" }))).toEqual(["20240202"]);
    expect(ids(filterStudents(students, { text: "学号:2024" }))).toEqual(["20240101", "20240202"]);
    expect(ids(filterStudents(students, { text: "姓名：张　学号:2025" }))).toEqual(["20250101"]);
    expect(parseQuery("班级:高三(1)")).toEqual([{ field: "className", value: "高三(1)" }]);
  });

  it("字段前缀认不出来时当成普通关键词，不影响搜索", () => {
    expect(parseQuery("未知:abc")).toEqual([{ value: "未知:abc" }]);
    expect(ids(filterStudents(students, { text: "id:2026" }))).toEqual(["20260303"]);
  });

  it("班级精确过滤可以与关键词叠加（或关系用于多选班级）", () => {
    expect(ids(filterStudents(students, { classNames: ["高三(1)班"] }))).toEqual([
      "20240101",
      "20250101",
    ]);
    expect(
      ids(filterStudents(students, { classNames: ["高三(1)班", "高三(2)班"], text: "李" })),
    ).toEqual(["20240202"]);
  });

  it("matchToken / summarizeNames 的小工具行为", () => {
    expect(matchToken(students[0]!, { value: "20240101" })).toBe(true);
    expect(matchToken(students[0]!, { field: "name", value: "李" })).toBe(false);
    expect(summarizeNames(["张三", "李四", "王五", "赵六"])).toBe("张三、李四、王五 等 4 人");
    expect(summarizeNames(["张三", "李四"])).toBe("张三、李四");
  });
});
