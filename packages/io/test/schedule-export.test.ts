import { describe, expect, it } from "vitest";

import { findRoomSubjectClashes, planAll } from "@exam-seat/core";
import type { Job, PlanAllResult, RoomSpec } from "@exam-seat/core";

import {
  baseRoomName,
  buildClassScheduleRows,
  buildClassScheduleSheets,
  buildClassScheduleWorkbook,
  buildInvigilatorSheets,
  buildInvigilatorWorkbook,
  readWorkbook,
} from "../src/index";
import type { XlsxCellInput } from "../src/xlsx";
import { readAoa, readZip, rowValues, sheetValues, zipText } from "./helpers";

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

const JOB = scene();
const ROOMS = JOB.rooms;
const result = planAll(JOB);

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

const SHARED_JOB = sharedScene();
const sharedResult = planAll(SHARED_JOB);

/** 考场列（主考场 / 单科考场N，**不含**后面的地点列）。 */
function roomColumns(row: XlsxCellInput[], headers: string[]): string[] {
  return pickColumns(row, headers, (header) => header === "主考场" || /^单科考场\d+$/.test(header));
}

/** 地点列（主考场地点 / 单科考场N地点）。 */
function locationColumns(row: XlsxCellInput[], headers: string[]): string[] {
  return pickColumns(row, headers, (header) => header.endsWith("地点"));
}

function pickColumns(
  row: XlsxCellInput[],
  headers: string[],
  keep: (header: string) => boolean,
): string[] {
  const values = rowValues(row);
  return headers
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => keep(header))
    .map(({ index }) => String(values[index] ?? ""));
}

const CLASS_HEADERS_2_ROOMS = [
  "班级",
  "姓名",
  "准考证号",
  "主考场",
  "主考场地点",
  "单科考场1",
  "单科考场1地点",
];

/* ------------------------------------------------------------------ */
/* 考场名                                                              */
/* ------------------------------------------------------------------ */

describe("baseRoomName：考场名去掉（…）后缀", () => {
  it("去掉老师写在名字里的「（…）」后缀", () => {
    expect(baseRoomName({ id: "R17", name: "第十七考场 （语史政数英地）" })).toBe("第十七考场");
    expect(baseRoomName({ id: "R18", name: "第十八考场（生物）" })).toBe("第十八考场");
    expect(baseRoomName({ id: "R19", name: "第十九考场（政治）（地理）" })).toBe("第十九考场");
  });

  it("没有名字时退回 id；名字里没有括号时原样", () => {
    expect(baseRoomName({ id: "R1" })).toBe("R1");
    expect(baseRoomName({ id: "R1", name: "生物实验室" })).toBe("生物实验室");
  });
});

/* ------------------------------------------------------------------ */
/* 输出 A：按班级                                                      */
/* ------------------------------------------------------------------ */

describe("输出 A：按班级", () => {
  it("列是 班级 / 姓名 / 准考证号 / 主考场 + 地点 / 单科考场1 + 地点，列数按实际用到的最大数", () => {
    const { headers } = buildClassScheduleRows(result, ROOMS);
    expect(headers).toEqual(CLASS_HEADERS_2_ROOMS);
  });

  it("没人换考场时只出 主考场 / 主考场地点 两列", () => {
    const singleRoom: PlanAllResult = {
      ...result,
      byStudent: result.byStudent.map((student) => ({
        ...student,
        rooms: student.rooms.slice(0, 1),
        distinctRooms: 1,
      })),
    };
    const { headers } = buildClassScheduleRows(singleRoom, ROOMS);
    expect(headers).toEqual(["班级", "姓名", "准考证号", "主考场", "主考场地点"]);
  });

  it("每个考场列后面紧跟一列地点，取值来自 byStudent[].rooms[].location", () => {
    const { rows, headers } = buildClassScheduleRows(result, ROOMS);
    const politics = rows.find((row) => String(rowValues(row)[1]).startsWith("物化政"))!;
    const politicsLocations = locationColumns(politics, headers);
    // 主考场是普通考场（高二N班），单科考场是生物实验室
    expect(politicsLocations[0]).toMatch(/^高二.+班$/);
    expect(politicsLocations[1]).toBe("生物实验室");

    const geography = rows.find((row) => String(rowValues(row)[1]).startsWith("物化地"))!;
    expect(locationColumns(geography, headers)[1]).toBe("地理教室");

    // 常规组合只有一个考场，第二组地点留空
    const regular = rows.find((row) => String(rowValues(row)[1]).startsWith("物化生"))!;
    const regularLocations = locationColumns(regular, headers);
    expect(regularLocations[0]).toMatch(/^高二.+班$/);
    expect(regularLocations[1]).toBe("");
    expect(roomColumns(regular, headers).filter((value) => value !== "")).toHaveLength(1);
  });

  it("byStudent 没带 location 时退回 job.rooms 的 location", () => {
    const noLocation: PlanAllResult = {
      ...result,
      byStudent: result.byStudent.map((student) => ({
        ...student,
        rooms: student.rooms.map((room) => ({
          roomId: room.roomId,
          roomName: room.roomName,
          subjects: room.subjects,
        })),
      })),
    };
    const { rows, headers } = buildClassScheduleRows(noLocation, ROOMS);
    const politics = rows.find((row) => String(rowValues(row)[1]).startsWith("物化政"))!;
    const rooms = roomColumns(politics, headers);
    const locations = locationColumns(politics, headers);
    expect(rooms[1]).toBe("第二十考场（政治）");
    expect(locations[1]).toBe("生物实验室"); // job.rooms 里 R20 的 location
    expect(locations[0]).toMatch(/^高二.+班$/);
  });

  it("这份表没超 A4 → 不截断姓名（truncatedNames=false）", () => {
    const { truncatedNames } = buildClassScheduleRows(result, ROOMS);
    expect(truncatedNames).toBe(false);
  });

  it("班级列每行都填（不再只在第一行写一次）", () => {
    const { rows } = buildClassScheduleRows(result, ROOMS);
    expect(rows).toHaveLength(result.byStudent.length);
    expect(rows.every((row) => String(rowValues(row)[0]).trim() !== "")).toBe(true);
  });

  it("准考证号列 = 学生学号", () => {
    const { rows } = buildClassScheduleRows(result, ROOMS);
    const ids = new Set(result.byStudent.map((student) => student.studentId));
    expect(rows.every((row) => ids.has(String(rowValues(row)[2])))).toBe(true);
  });

  it("主考场只写「第N考场」不带括号，换考场才带括号写科目", () => {
    const { rows, headers } = buildClassScheduleRows(result, ROOMS);

    const regular = rows.find((row) => String(rowValues(row)[1]).startsWith("物化生"))!;
    const regularRooms = roomColumns(regular, headers);
    expect(regularRooms[0]).toMatch(/^第.考场$/);
    expect(regularRooms[1]).toBe("");
    expect(regularRooms[0]).not.toContain("（");

    const politics = rows.find((row) => String(rowValues(row)[1]).startsWith("物化政"))!;
    const politicsRooms = roomColumns(politics, headers);
    expect(politicsRooms[0]).toMatch(/^第.考场$/);
    expect(politicsRooms[0]).not.toContain("（");
    expect(politicsRooms[1]).toBe("第二十考场（政治）");

    const geography = rows.find((row) => String(rowValues(row)[1]).startsWith("物化地"))!;
    const geographyRooms = roomColumns(geography, headers);
    expect(geographyRooms[0]).toMatch(/^第.考场$/);
    expect(geographyRooms[1]).toBe("第二十一考场（地理）");
  });

  it("第一列考场永远是主考场（不带括号），其余列都有括号", () => {
    const { rows, headers } = buildClassScheduleRows(result, ROOMS);
    const firstColumns: string[] = [];
    const otherColumns: string[] = [];
    for (const row of rows) {
      const filled = roomColumns(row, headers).filter((value) => value !== "");
      // 第一列是主考场，其余列是换考场
      firstColumns.push(...filled.slice(0, 1));
      otherColumns.push(...filled.slice(1));
    }
    expect(firstColumns.length).toBeGreaterThan(0);
    expect(otherColumns.length).toBeGreaterThan(0);
    expect(firstColumns.every((value) => !value.includes("（"))).toBe(true);
    expect(otherColumns.every((value) => value.includes("（"))).toBe(true);
  });

  it("总表 + 每班一张 sheet，sheet 名就是班级名", () => {
    const sheets = buildClassScheduleSheets(result, ROOMS);
    const classes = [...new Set(result.byStudent.map((student) => student.className))];
    expect(sheets[0]!.name).toBe("总表");
    expect(sheets).toHaveLength(classes.length + 1);
    expect(new Set(sheets.slice(1).map((sheet) => sheet.name))).toEqual(new Set(classes));
  });

  it("总表三行表头：大标题 / 统计小字 / 列名，且班级列每行都有值", () => {
    const bytes = buildClassScheduleWorkbook(result, ROOMS, {
      title: "高二上第一次月考 考场安排",
      generatedAt: "2026-10-01 09:00",
    });
    const aoa = readAoa(bytes, "总表");
    expect(aoa[0]![0]).toBe("高二上第一次月考 考场安排 总表");
    expect(String(aoa[1]![0])).toContain("共 76 人");
    expect(String(aoa[1]![0])).toContain("个考场");
    expect(String(aoa[1]![0])).toContain("生成时间 2026-10-01 09:00");
    expect(aoa[2]).toEqual(CLASS_HEADERS_2_ROOMS);
    const body = aoa.slice(3).filter((row) => String(row[1] ?? "") !== "");
    expect(body).toHaveLength(76);
    expect(body.every((row) => String(row[0]).trim() !== "")).toBe(true);
    expect(body.every((row) => String(row[2]).trim() !== "")).toBe(true);
  });

  it("每班一张：标题是「<班级> 考场安排」，小字给出本班人数与换考场人数", () => {
    const bytes = buildClassScheduleWorkbook(result, ROOMS, { title: "考场安排" });
    const workbookSheets = readZip(bytes);
    expect(workbookSheets.size).toBeGreaterThan(0);
    const firstClass = [...new Set(result.byStudent.map((student) => student.className))].sort(
      (a, b) => a.localeCompare(b, "zh"),
    )[0]!;
    const aoa = readAoa(bytes, firstClass);
    expect(aoa[0]![0]).toBe(`${firstClass} 考场安排`);
    expect(String(aoa[1]![0])).toMatch(/^本班 \d+ 人 ｜ 需换考场 \d+ 人$/);
  });

  it("打印横向 A4：每张表列宽总和不超过可用宽度", () => {
    const bytes = buildClassScheduleWorkbook(result, ROOMS, { generatedAt: "2026-10-01 09:00" });
    for (const name of ["xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"]) {
      const xml = zipText(bytes, name);
      const widths = [...xml.matchAll(/<col min="\d+" max="\d+" width="(?:[\d.]+)"/g)].map(
        (match) => Number(match[0].replace(/.*width="/, "").replace(/".*/, "")),
      );
      expect(widths.length).toBeGreaterThan(0);
      const totalCm = widths.reduce((sum, width) => sum + width, 0) * 0.185;
      expect(totalCm).toBeLessThanOrEqual(27.8 + 1e-9);
    }
  });

  it("长标题不会把第一列撑爆：列宽按正文算，表头三行有行高", () => {
    const bytes = buildClassScheduleWorkbook(result, ROOMS, {
      title: "高二上第一次月考 考场安排（考场级放宽 + 借考）",
    });
    const xml = zipText(bytes, "xl/worksheets/sheet1.xml");
    const widths = [...xml.matchAll(/<col min="\d+" max="\d+" width="(?:[\d.]+)"/g)].map((match) =>
      Number(match[0].replace(/.*width="/, "").replace(/".*/, "")),
    );
    expect(widths[0]).toBeLessThan(20); // 班级列只按「高三(10)班」这种内容算，不被长标题撑到 60
    expect(widths.some((width) => width >= 20)).toBe(true); // 姓名 / 考场列仍然够宽
    expect(widths.reduce((sum, width) => sum + width, 0) * 0.185).toBeLessThanOrEqual(27.8 + 1e-9);
    // 大标题 26 磅、小字 16 磅、表头 20 磅（正文不写行高，交给 Excel 自适应）
    expect(xml).toContain('ht="26"');
    expect(xml).toContain('ht="20"');
  });

  it("用 SheetJS 能读回两份表的值", () => {
    const bytes = buildClassScheduleWorkbook(result, ROOMS, { generatedAt: "2026-10-01 09:00" });
    const headers = readAoa(bytes, "总表")[2]!;
    expect(headers).toEqual(CLASS_HEADERS_2_ROOMS);
  });
});

/* ------------------------------------------------------------------ */
/* 输出 B：按考场                                                      */
/* ------------------------------------------------------------------ */

describe("输出 B：按考场", () => {
  it("同组合的常规考场各自一张表，标题带全部科目，不拆表", () => {
    const sheets = buildInvigilatorSheets(result, ROOMS);
    const science = sheets.filter((sheet) => sheet.name.includes("语数外物化生"));
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
    const sheets = buildInvigilatorSheets(result, ROOMS);
    expect(sheets.some((sheet) => sheet.name === "第二十考场（政治）")).toBe(true);
    expect(sheets.some((sheet) => sheet.name === "第二十一考场（地理）")).toBe(true);
  });

  it("非常规主考场只有语数外物化", () => {
    const sheets = buildInvigilatorSheets(result, ROOMS);
    const main = sheets.filter((sheet) => sheet.name.endsWith("（语数外物化）"));
    expect(main).toHaveLength(1);
  });

  it("表头是 大标题 / 地点+人数 / 具名列，正文含准考证号并按座位号排序", () => {
    const sheets = buildInvigilatorSheets(result, ROOMS);
    const sheet = sheets.find((item) => item.name === "第二十考场（政治）")!;
    const rows = sheetValues(sheet);
    expect(rows[0]![0]).toBe("第二十考场（政治）");
    expect(String(rows[1]![0])).toBe("地点：生物实验室 ｜ 考场人数：6");
    expect(rowValues(sheet.rows[2]!)).toEqual(["座位号", "班级", "姓名", "准考证号", "备注"]);

    const body = sheetValues(sheet).slice(3);
    expect(body).toHaveLength(6); // 6 个物化政学生
    const seatNos = body.map((row) => Number(row[0]));
    expect([...seatNos].sort((a, b) => a - b)).toEqual(seatNos);
    expect(body[0]![0]).toBe(1);
    expect(body.every((row) => String(row[3]).startsWith("物化政"))).toBe(true); // 准考证号
  });

  it("不再有「监考：…」那一行，也没有 job 里的双括号后缀", () => {
    const sheets = buildInvigilatorSheets(result, ROOMS);
    const sheet = sheets.find((item) => item.name === "第二十考场（政治）")!;
    expect(JSON.stringify(sheetValues(sheet))).not.toContain("监考");
    for (const item of sheets) {
      expect(item.name).not.toContain("语史政数英地");
      expect(item.name.match(/（/g) ?? []).toHaveLength(1);
    }
  });

  it("放宽了同班相邻的考场在第二行补一句标注", () => {
    const relaxed: PlanAllResult = {
      ...result,
      seatings: result.seatings.map((seating, index) =>
        index === 0 ? { ...seating, relaxedSameClass: true } : seating,
      ),
    };
    const sheet = buildInvigilatorSheets(relaxed, ROOMS)[0]!;
    const meta = String(sheetValues(sheet)[1]![0]);
    expect(meta).toContain("｜ 本考场已放宽同班相邻");
  });

  it("考场名带「（语史政数英地）」后缀时标题只保留一个括号", () => {
    const suffixed: PlanAllResult = {
      ...result,
      seatings: [
        {
          ...result.seatings[0]!,
          roomId: "R17",
          roomName: "第十七考场 （语史政数英地）",
          subjects: ["biology"],
        },
      ],
    };
    const sheets = buildInvigilatorSheets(suffixed, [
      { id: "R17", name: "第十七考场 （语史政数英地）", rows: 6, cols: 5, location: "生物实验室" },
    ]);
    expect(sheets[0]!.name).toBe("第十七考场（生物）");
    expect(String(sheetValues(sheets[0]!)[0]![0])).toBe("第十七考场（生物）");
  });

  it("能导出成多 sheet 工作簿并读回", () => {
    const workbook = buildInvigilatorWorkbook(result, ROOMS);
    const sheets = readAoaNames(workbook);
    expect(sheets).toHaveLength(result.seatings.length);
    expect(sheets).toContain("第二十考场（政治）");
    for (const name of sheets) expect(name.length).toBeLessThanOrEqual(31);
  });

  it("工作表名会去掉 Excel 不允许的字符", () => {
    const sheets = buildInvigilatorSheets(result, ROOMS);
    for (const sheet of sheets) {
      expect(sheet.name).not.toMatch(/[[\]:*?/\\]/);
    }
  });

  it("一套座位都没有时兜底一张「无安排」", () => {
    const empty: PlanAllResult = { ...result, seatings: [], byStudent: [] };
    const sheets = buildInvigilatorSheets(empty, ROOMS);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.name).toBe("无安排");
    expect(String(sheetValues(sheets[0]!)[1]![0])).toContain("没有任何考场安排");
  });
});

function readAoaNames(bytes: Uint8Array): string[] {
  return readWorkbook(bytes).map((sheet) => sheet.name);
}

/* ------------------------------------------------------------------ */
/* fillRooms：共用考场合并成一套座位                                    */
/* ------------------------------------------------------------------ */

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
    const sheets = buildInvigilatorSheets(sharedResult, SHARED_JOB.rooms);
    const first = sheets.filter((sheet) => sheet.name.startsWith("第一考场"));
    expect(first).toHaveLength(1);
    expect(first[0]!.name).toBe("第一考场（语数外物化生）");

    // 专用考场照旧各出一张
    expect(sheets.some((sheet) => sheet.name === "第二十考场（政治）")).toBe(true);
    expect(sheets.some((sheet) => sheet.name === "第二十一考场（地理）")).toBe(true);

    // 合并后第一考场坐着两批人（物化生 + 物化政/地），正文人数 = 两个批次之和
    expect(sheetValues(first[0]!).slice(3)).toHaveLength(30);
  });
});
