import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { readRoster, suggestMapping } from "../src/index";

/**
 * 自造夹具（不是真实名单）：故意在「选科」「缺考」两列旁边夹上「性别」「备注」做干扰。
 *
 * 这组用例专门守 `FIELD_PRIORITY`：一旦「选科」不再进优先级（或「性别/备注」又抢回列归属）， 下面的 `combination` / `subjects` / 缺考断言就会失败
 * —— 这是单测曾经漏掉的缺口 （只有 `examples/acceptance.mjs` 的「识别出选科列」兜住）。
 */
const HEADERS = ["学号", "姓名", "班级", "性别", "选科", "缺考", "备注"];

const AOA: (string | number)[][] = [
  HEADERS,
  ["B01", "学生甲", "高三(1)班", "男", "物化生", "", "坐前排"],
  ["B02", "学生乙", "高三(2)班", "女", "史地政", "缺考", "家长申请"],
  ["B03", "学生丙", "高三(3)班", "男", "物化政", "", ""],
];

function makeXlsx(rows: (string | number)[][]): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer);
}

describe("名单导入：选科列必须被认出来（FIELD_PRIORITY 回归）", () => {
  it("suggestMapping：combination 落在选科列、absent 落在缺考列，性别/备注不抢列", () => {
    const { mapping, missing } = suggestMapping(HEADERS);
    expect(missing).toEqual([]);
    expect(mapping).toMatchObject({ id: 0, name: 1, className: 2 });
    expect(mapping.combination).toBe(4);
    expect(mapping.absent).toBe(5);
    // 「性别」(3) / 「备注」(6) 现在不解析，也不能被任何字段认领
    expect(Object.values(mapping)).not.toContain(3);
    expect(Object.values(mapping)).not.toContain(6);
  });

  it("readRoster：combination 保留原文、subjects 解析正确、缺考列照常生效", () => {
    const result = readRoster(makeXlsx(AOA));
    expect(result.issues).toEqual([]);
    expect(result.mapping).toMatchObject({ combination: 4, absent: 5 });

    expect(result.students.map((student) => student.combination)).toEqual([
      "物化生",
      "史地政",
      "物化政",
    ]);
    expect(result.students[0]!.subjects).toEqual(["physics", "chemistry", "biology"]);
    expect(result.students[1]!.subjects).toEqual(["politics", "history", "geography"]);
    expect(result.students[2]!.subjects).toEqual(["physics", "chemistry", "politics"]);

    // 缺考列（第 2 条）生效；没被标记的人不带 included
    expect(result.students[1]!.included).toBe(false);
    expect(result.students[0]!.included).toBeUndefined();
    expect(result.stats.absent).toBe(1);

    // 性别 / 备注列不会进学生对象
    expect(result.students[0]).not.toHaveProperty("gender");
    expect(result.students[0]).not.toHaveProperty("meta");
  });
});
