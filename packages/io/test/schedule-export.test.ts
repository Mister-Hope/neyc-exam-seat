import { describe, expect, it } from "vitest";

import { planAll } from "@exam-seat/core";
import type { Job, RoomSpec } from "@exam-seat/core";

import {
  buildClassScheduleRows,
  buildClassScheduleWorkbook,
  buildInvigilatorSheets,
  buildInvigilatorWorkbook,
  readWorkbook,
} from "../src/index";

const SMALL: Omit<RoomSpec, "id" | "name"> = { rows: 6, cols: 5 };

function scene(): Job {
  const perCombo: Record<string, number> = { 物化生: 32, 政史地: 32, 物化政: 6, 物化地: 6 };
  const students: Job["students"] = [];
  let classCursor = 1;
  for (const [combo, count] of Object.entries(perCombo)) {
    for (let i = 0; i < count; i += 1) {
      const className = `高三(${classCursor}班)`;
      classCursor = (classCursor % 18) + 1;
      students.push({
        id: `${combo}-${String(i).padStart(2, "0")}`,
        name: `${combo}${i}`,
        className,
        combination: combo,
      });
    }
  }
  return {
    jobVersion: 2,
    students,
    rooms: [
      { id: "R1", name: "第一考场", location: "高二一班", ...SMALL, note: "张老师" },
      { id: "R2", name: "第二考场", location: "高二二班", ...SMALL, note: "李老师" },
      { id: "R3", name: "第三考场", location: "高二三班", ...SMALL },
      { id: "R4", name: "第四考场", location: "高二四班", ...SMALL },
      {
        id: "R20",
        name: "第二十考场",
        location: "生物实验室",
        ...SMALL,
        note: "王老师",
        dedicatedSubjects: ["politics"],
      },
      {
        id: "R21",
        name: "第二十一考场",
        location: "地理教室",
        ...SMALL,
        dedicatedSubjects: ["geography"],
      },
    ],
  };
}

const result = planAll(scene());

describe("输出 A：按班级", () => {
  it("列是 班级 / 姓名 / 考场①②③，且只输出实际用到的列", () => {
    const { headers } = buildClassScheduleRows(result);
    expect(headers).toEqual(["班级", "姓名", "考场①", "考场②"]);
  });

  it("常规组合只有一个考场，②列留空", () => {
    const { rows, headers } = buildClassScheduleRows(result);
    const row = rows.find((r) => String(r[1]).startsWith("物化生"))!;
    expect(String(row[headers.indexOf("考场①")])).toMatch(/^第.考场（语数外物化生）$/);
    expect(row[headers.indexOf("考场②")]).toBe("");
  });

  it("非常规组合有两列，②列写明换到哪个考场、考什么", () => {
    const { rows, headers } = buildClassScheduleRows(result);
    const row = rows.find((r) => String(r[1]).startsWith("物化政"))!;
    expect(String(row[headers.indexOf("考场①")])).toMatch(/（语数外物化）$/);
    expect(String(row[headers.indexOf("考场②")])).toBe("第二十考场（政治）");

    const geo = rows.find((r) => String(r[1]).startsWith("物化地"))!;
    expect(String(geo[headers.indexOf("考场②")])).toBe("第二十一考场（地理）");
  });

  it("表尾给出各班需要换考场的人数", () => {
    const movers = result.byStudent.filter((s) => s.distinctRooms > 1);
    expect(movers).toHaveLength(12);
    const { rows } = readWorkbook(buildClassScheduleWorkbook(result))[0]!;
    expect(rows.some((r) => r[0] === "班级" && r[1] === "需要换考场的人数")).toBe(true);
  });

  it("能导出成工作簿并读回来", () => {
    const sheets = readWorkbook(buildClassScheduleWorkbook(result));
    expect(sheets.map((s) => s.name)).toEqual(["按班级考场安排"]);
    expect(sheets[0]!.headers).toEqual(["班级", "姓名", "考场①", "考场②"]);
    expect(sheets[0]!.rows.length).toBeGreaterThan(result.byStudent.length);
  });
});

describe("输出 B：按考场", () => {
  it("常规考场只有一张表，标题带全部科目", () => {
    const sheets = buildInvigilatorSheets(result);
    const science = sheets.filter((s) => s.name.includes("语数外物化生"));
    expect(science.length).toBeGreaterThan(0);
    for (const sheet of science) expect(sheet.name).toMatch(/^第.考场（语数外物化生）$/);
  });

  it("专用考场各出一张，标题是「考场（科目）」", () => {
    const sheets = buildInvigilatorSheets(result);
    expect(sheets.some((s) => s.name === "第二十考场（政治）")).toBe(true);
    expect(sheets.some((s) => s.name === "第二十一考场（地理）")).toBe(true);
  });

  it("非常规主考场只有语数外物化", () => {
    const sheets = buildInvigilatorSheets(result);
    const main = sheets.filter((s) => s.name.endsWith("（语数外物化）"));
    expect(main).toHaveLength(1);
  });

  it("每张表的表头含考场名 / 地点 / 监考，正文是 座位号 | 班级 | 姓名", () => {
    const sheets = buildInvigilatorSheets(result);
    const sheet = sheets.find((s) => s.name === "第二十考场（政治）")!;
    expect(sheet.rows[0]![0]).toBe("第二十考场（政治）");
    expect(String(sheet.rows[1]![0])).toBe("地点：生物实验室");
    expect(String(sheet.rows[1]![2])).toBe("监考：王老师");
    expect(sheet.rows[3]).toEqual(["座位号", "班级", "姓名"]);

    const body = sheet.rows.slice(4);
    expect(body).toHaveLength(6); // 6 个物化政学生
    // 座位号从 1 开始且连续递增
    const seatNos = body.map((r) => Number(r[0]));
    expect([...seatNos].sort((a, b) => a - b)).toEqual(seatNos);
    expect(body[0]![0]).toBe(1);
  });

  it("每张表里的人都是同一个座位方案的，且不含外人", () => {
    const sheets = buildInvigilatorSheets(result);
    const politics = sheets.find((s) => s.name === "第二十考场（政治）")!;
    const names = politics.rows.slice(4).map((r) => String(r[2]));
    expect(names.every((n) => n.startsWith("物化政"))).toBe(true);
  });

  it("能导出成多 sheet 工作簿并读回来", () => {
    const workbook = buildInvigilatorWorkbook(result);
    const sheets = readWorkbook(workbook);
    expect(sheets).toHaveLength(result.seatings.length);
    expect(sheets.map((s) => s.name)).toContain("第二十考场（政治）");
    // 工作表名不超过 31 字符
    for (const sheet of sheets) expect(sheet.name.length).toBeLessThanOrEqual(31);
  });

  it("工作表名会去掉 Excel 不允许的字符", () => {
    const sheets = buildInvigilatorSheets(result);
    for (const sheet of sheets) {
      expect(sheet.name).not.toMatch(/[[\]:*?/\\]/);
    }
  });
});
