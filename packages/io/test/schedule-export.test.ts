import { describe, expect, it } from "vitest";

import { findRoomSubjectClashes, planAll } from "@exam-seat/core";
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
      // 常规组合 32+32 人、非常规 12 人：严格路径需要 5 个普通考场
      // （物化生 2 + 政史地 2 + 非常规主考场 1），少一个就会被判容量不足
      { id: "R5", name: "第五考场", location: "高二五班", ...SMALL },
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

/** `fillRooms` 场景：只有 2 个普通考场，装不下「物化生 / 非常规主批次」各自独占， 但两者逐时段不冲突（T6 只有物化生考生物），必须合并成一套座位方案。 */
function sharedScene(): Job {
  const perCombo: Record<string, number> = { 物化生: 20, 物化政: 6, 物化地: 6 };
  const students: Job["students"] = [];
  let classCursor = 1;
  for (const [combo, count] of Object.entries(perCombo)) {
    for (let i = 0; i < count; i += 1) {
      students.push({
        id: `${combo}-${String(i).padStart(2, "0")}`,
        name: `${combo}${i}`,
        className: `高三(${classCursor}班)`,
        combination: combo,
      });
      classCursor = (classCursor % 12) + 1;
    }
  }
  return {
    jobVersion: 2,
    options: { groupPreference: "fillRooms" },
    students,
    rooms: [
      { id: "R1", name: "第一考场", location: "高二一班", ...SMALL, note: "张老师" },
      { id: "R2", name: "第二考场", location: "高二二班", ...SMALL, note: "李老师" },
      {
        id: "R20",
        name: "第二十考场",
        location: "生物实验室",
        ...SMALL,
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

const sharedResult = planAll(sharedScene());

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
  it("同组合的常规考场各自一张表，标题带全部科目，不拆表", () => {
    const sheets = buildInvigilatorSheets(result);
    const science = sheets.filter((s) => s.name.includes("语数外物化生"));
    expect(science.length).toBeGreaterThan(0);
    for (const sheet of science) expect(sheet.name).toMatch(/^第.考场（语数外物化生）$/);
  });

  it("严格路径下一个考场只有一套座位方案，考场内座位号唯一", () => {
    // 新契约：共用/同组合批次必须合并成一套 seating（一个考场一张监考表），
    // 否则同房两套座位会各自从 1 号开始、座位号撞车。
    const perRoom = new Map<string, number>();
    for (const seating of result.seatings) {
      perRoom.set(seating.roomId, (perRoom.get(seating.roomId) ?? 0) + 1);
      const seatNos = Object.values(seating.seatNoById);
      expect(new Set(seatNos).size).toBe(seatNos.length);
    }
    for (const count of perRoom.values()) expect(count).toBe(1);

    // 默认 sameCombination 严格路径：所有考场都排满，没有空置，也没有同房同时段撞科
    expect(result.emptyRooms).toEqual([]);
    expect(findRoomSubjectClashes(result)).toEqual([]);
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

describe("fillRooms：共用考场合并成一套座位", () => {
  it("逐时段不冲突的批次合并进同一考场，座位号唯一，且不上报撞科", () => {
    // 物化生 20 + 非常规主批次 12 共 32 人，只有 2 个 30 座普通考场：
    // 两者逐时段不冲突（T6 只有物化生考生物），必须并进同一个座位方案。
    const perRoom = new Map<string, number>();
    for (const seating of sharedResult.seatings) {
      perRoom.set(seating.roomId, (perRoom.get(seating.roomId) ?? 0) + 1);
      // 合并后座位号一人一号：去重后的座位号个数 = 该座位方案的学生数
      const seatNos = Object.values(seating.seatNoById);
      expect(new Set(seatNos).size).toBe(seating.studentIds.length);
    }
    for (const count of perRoom.values()) expect(count).toBe(1);

    expect(sharedResult.diagnostics.some((d) => d.code === "ROOMS_SHARED")).toBe(true);
    expect(sharedResult.diagnostics.some((d) => d.code === "ROOM_SUBJECT_CLASH")).toBe(false);
    expect(findRoomSubjectClashes(sharedResult)).toEqual([]);
  });

  it("合并后的监考表一个考场一张，标题取科目并集", () => {
    const sheets = buildInvigilatorSheets(sharedResult);
    const first = sheets.filter((s) => s.name.startsWith("第一考场"));
    expect(first).toHaveLength(1);
    expect(first[0]!.name).toBe("第一考场（语数外物化生）");

    // 专用考场照旧各出一张
    expect(sheets.some((s) => s.name === "第二十考场（政治）")).toBe(true);
    expect(sheets.some((s) => s.name === "第二十一考场（地理）")).toBe(true);

    // 合并后第一考场坐着两批人（物化生 + 物化政/地），正文人数 = 两个批次之和
    const body = first[0]!.rows.slice(4);
    expect(body).toHaveLength(30);
  });
});
