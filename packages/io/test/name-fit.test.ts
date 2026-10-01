import { describe, expect, it } from "vitest";

import type { PlanAllResult, StudentSchedule } from "@exam-seat/core";

import {
  DEFAULT_NAME_MAX_CHARS,
  buildClassScheduleRows,
  displayStudentName,
  fitNamesToA4,
} from "../src/index";
import type { XlsxCellInput } from "../src/xlsx";
import { rowValues } from "./helpers";

const LONG_NAME = "阿依古丽娜尔古丽米热买买提"; // 13 个字（与真实名单最长姓名的量级一致）

function cell(value: string): XlsxCellInput {
  return { value, style: "body" };
}

/** 三列小表：班级 / 姓名 / 准考证号，姓名是长名字。 */
const ROWS: XlsxCellInput[][] = [
  ["班级", "姓名", "准考证号"].map<XlsxCellInput>((value) => ({ value, style: "header" })),
  [cell("2501"), cell(LONG_NAME), cell("20240101")],
  [cell("2502"), cell("阿依古丽米热·买买提"), cell("20240102")],
];

/* ------------------------------------------------------------------ */
/* displayStudentName                                                  */
/* ------------------------------------------------------------------ */

describe("displayStudentName：按码点截到 N 个字", () => {
  it("超过 5 个字截成前 5 个", () => {
    const truncated = displayStudentName(LONG_NAME);
    expect(truncated).toBe("阿依古丽娜");
    expect(truncated).toHaveLength(DEFAULT_NAME_MAX_CHARS);
  });

  it("不超过 5 个字原样返回，6 字起才截", () => {
    expect(displayStudentName("王小明")).toBe("王小明");
    expect(displayStudentName("李小红")).toBe("李小红");
    expect(displayStudentName("阿依古丽米")).toBe("阿依古丽米"); // 正好 5 字，不截
    expect(displayStudentName("阿依古丽娜尔")).toBe("阿依古丽娜"); // 6 字
    expect(displayStudentName("古丽·买买提")).toBe("古丽·买买"); // 6 字
  });

  it("上限可覆盖", () => {
    expect(displayStudentName(LONG_NAME, 3)).toBe("阿依古");
    expect(displayStudentName("王小明", 10)).toBe("王小明");
  });
});

/* ------------------------------------------------------------------ */
/* fitNamesToA4                                                        */
/* ------------------------------------------------------------------ */

describe("fitNamesToA4：只在整表超 A4 时才截姓名", () => {
  it("超宽：长姓名截成 5 个字，其它列不动，并报 truncatedNames", () => {
    // 极窄阈值模拟「整表超宽」
    const fitted = fitNamesToA4(ROWS, { availableWidthCm: 5 });
    expect(fitted.truncatedNames).toBe(true);
    expect(String(rowValues(fitted.rows[1]!)[1])).toBe("阿依古丽娜");
    expect(String(rowValues(fitted.rows[2]!)[1])).toBe("阿依古丽米");
    // 班级 / 准考证号不动
    expect(String(rowValues(fitted.rows[1]!)[0])).toBe("2501");
    expect(String(rowValues(fitted.rows[1]!)[2])).toBe("20240101");
    // 表头不动
    expect(String(rowValues(fitted.rows[0]!)[1])).toBe("姓名");
  });

  it("不超宽：一个名字都不动，原样返回", () => {
    const fitted = fitNamesToA4(ROWS, { availableWidthCm: 30 });
    expect(fitted.truncatedNames).toBe(false);
    expect(fitted.rows).toBe(ROWS);
    expect(String(rowValues(fitted.rows[1]!)[1])).toBe(LONG_NAME);
  });

  it("超宽但没有超过上限的姓名时，不算截断", () => {
    const shortRows: XlsxCellInput[][] = [
      ["班级", "姓名", "准考证号"].map<XlsxCellInput>((value) => ({ value, style: "header" })),
      [cell("2501"), cell("王小明"), cell("20240101")],
    ];
    const fitted = fitNamesToA4(shortRows, { availableWidthCm: 2 });
    expect(fitted.truncatedNames).toBe(false);
    expect(fitted.rows).toBe(shortRows);
  });

  it("默认阈值（27.8cm）下，这份小表不截断", () => {
    expect(fitNamesToA4(ROWS).truncatedNames).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* buildClassScheduleRows 的 truncatedNames                             */
/* ------------------------------------------------------------------ */

function schedule(
  studentId: string,
  name: string,
  className: string,
  rooms: StudentSchedule["rooms"],
): StudentSchedule {
  return {
    studentId,
    name,
    className,
    combination: null,
    slots: {},
    rooms,
    distinctRooms: rooms.length,
  };
}

function planResult(byStudent: StudentSchedule[]): PlanAllResult {
  return {
    ok: true,
    slots: [],
    seatings: [],
    byStudent,
    emptyRooms: [],
    overRoomLimit: [],
    unmetConstraints: [],
    relaxedRooms: [],
    borrowings: [],
    diagnostics: [],
  };
}

/** 720 人（31 个长姓名，最长 13 字）：与真实名单同量级，宽度不该超 A4。 */
function realSizeResult(): PlanAllResult {
  const students: StudentSchedule[] = [];
  for (let index = 0; index < 720; index += 1) {
    const long = index % 23 === 0;
    const name = long ? LONG_NAME : `阿依古丽娜${String(index % 10)}`; // 长名 / 6 字名交替
    students.push(
      schedule(
        `2024${String(10000 + index)}`,
        name,
        `25${String((index % 18) + 1).padStart(2, "0")}`,
        [
          { roomId: "R1", roomName: "第一考场", location: "高二一班", subjects: ["biology"] },
          { roomId: "R19", roomName: "第十九考场", location: "地理教室", subjects: ["politics"] },
        ],
      ),
    );
  }
  return planResult(students);
}

describe("buildClassScheduleRows：truncatedNames", () => {
  it("真实量级（720 人、最长 13 字）不超宽 → truncatedNames=false，姓名原样", () => {
    const big = realSizeResult();
    const { rows, truncatedNames } = buildClassScheduleRows(big, cohorts());
    expect(truncatedNames).toBe(false);
    const names = rows.map((row) => String(rowValues(row)[1]));
    expect(names).toContain(LONG_NAME);
    expect(names.every((name) => name.length >= 3)).toBe(true);
  });

  it("整表超宽 → truncatedNames=true，所有超长姓名截成 5 字（全表口径一致）", () => {
    const wide = planResult([
      schedule("S1", LONG_NAME, "2501", [
        { roomId: "R1", roomName: "第一考场", location: "高二一班", subjects: ["biology"] },
        {
          roomId: "R19",
          roomName: "第十九考场（政治、地理、生物、化学）",
          location: "生物实验楼二楼西侧第一实验室",
          subjects: ["politics", "geography", "biology", "chemistry"],
        },
        {
          roomId: "R20",
          roomName: "第二十考场（语文、数学、英语、物理、历史）",
          location: "教学楼三楼东侧第二实验室",
          subjects: ["chinese", "math", "english", "physics", "history"],
        },
      ]),
      schedule("S2", "阿依古丽米热·买买提", "2501", [
        { roomId: "R1", roomName: "第一考场", location: "高二一班", subjects: ["biology"] },
      ]),
    ]);

    const { rows, headers, truncatedNames } = buildClassScheduleRows(wide, cohorts());
    expect(truncatedNames).toBe(true);
    expect(headers[1]).toBe("姓名");
    // 13 字 → 前 5 字
    expect(String(rowValues(rows[0]!)[1])).toBe("阿依古丽娜");
    // 单班表用同一个全局结论，显示一致
    const single = buildClassScheduleRows(wide, cohorts(), { className: "2501" });
    expect(single.truncatedNames).toBe(true);
    expect(single.rows.map((row) => rowValues(row)[1])).toEqual(["阿依古丽娜", "阿依古丽米"]);
  });
});

function cohorts() {
  return [
    { id: "R1", name: "第一考场", location: "高二一班", rows: 6, cols: 5 },
    { id: "R19", name: "第十九考场", location: "地理教室", rows: 6, cols: 5 },
    { id: "R20", name: "第二十考场", location: "物理实验室", rows: 6, cols: 5 },
  ];
}
