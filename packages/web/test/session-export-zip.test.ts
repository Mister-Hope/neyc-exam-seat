import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildClassFilesZip,
  buildInvigilatorFilesZip,
  sheetsToZipFiles,
} from "@/lib/session-export";
import type { PlanAllResult, RoomSpec } from "@exam-seat/core";
import type { XlsxSheet } from "@exam-seat/io";

/* ------------------------------------------------------------------ */
/* mock io：只断言 web 传了什么、怎么拼文件名，不真写 Excel             */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
  buildXlsx: vi.fn<(book: { sheets: XlsxSheet[]; title?: string }) => Uint8Array>(
    () => new Uint8Array([1]),
  ),
  buildZip: vi.fn<(files: { name: string; bytes: Uint8Array }[]) => Uint8Array>(
    () => new Uint8Array([2]),
  ),
  buildClassScheduleSheets: vi.fn<
    (
      result: PlanAllResult,
      rooms?: RoomSpec[],
      options?: { title?: string; className?: string; generatedAt?: string },
    ) => XlsxSheet[]
  >(() => []),
  buildInvigilatorSheets: vi.fn<(result: PlanAllResult, rooms?: RoomSpec[]) => XlsxSheet[]>(
    () => [],
  ),
}));

vi.mock(import("@exam-seat/io"), () => ({
  buildClassScheduleSheets: mocks.buildClassScheduleSheets,
  buildInvigilatorSheets: mocks.buildInvigilatorSheets,
  buildXlsx: mocks.buildXlsx,
  buildZip: mocks.buildZip,
}));

const RESULT = { ok: true } as unknown as PlanAllResult;
const ROOMS: RoomSpec[] = [
  { id: "R1", name: "第一考场", rows: 6, cols: 5 },
  { id: "R2", name: "第二考场", rows: 5, cols: 5 },
];

/** 只带 name 的 sheet 替身：web 侧只用 sheet 名拼文件名。 */
function fakeSheet(name: string): XlsxSheet {
  return { name } as unknown as XlsxSheet;
}

describe("整包下载（ZIP）", () => {
  /** 每个用例都从「io 返回空表 + 固定字节」的干净状态开始（`clearAllMocks` 不会还原实现）。 */
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildXlsx.mockReturnValue(new Uint8Array([1]));
    mocks.buildZip.mockReturnValue(new Uint8Array([2]));
    mocks.buildClassScheduleSheets.mockReturnValue([]);
    mocks.buildInvigilatorSheets.mockReturnValue([]);
  });

  describe("sheetsToZipFiles 纯函数（文件名与单表工作簿）", () => {
    it("一张 sheet 一个文件，文件名 = 清洗后的表名 + .xlsx", () => {
      const sheets = [fakeSheet("按班级考场安排"), fakeSheet("高三(1)班")];
      const files = sheetsToZipFiles(sheets);

      expect(files.map((file) => file.name)).toEqual(["按班级考场安排.xlsx", "高三(1)班.xlsx"]);
      expect(mocks.buildXlsx).toHaveBeenCalledTimes(2);
      expect(mocks.buildXlsx).toHaveBeenNthCalledWith(1, { sheets: [sheets[0]] });
      expect(mocks.buildXlsx).toHaveBeenNthCalledWith(2, { sheets: [sheets[1]] });
      expect(files[0]!.bytes).toEqual(new Uint8Array([1]));
    });

    it("清洗后重名时补 (2)、(3)，保证 ZIP 条目名唯一", () => {
      const files = sheetsToZipFiles([
        fakeSheet("高三(1)班/第一考场"),
        fakeSheet("高三(1)班:第一考场"),
        fakeSheet("高三(1)班"),
      ]);

      expect(files.map((file) => file.name)).toEqual([
        "高三(1)班-第一考场.xlsx",
        "高三(1)班-第一考场(2).xlsx",
        "高三(1)班.xlsx",
      ]);
    });

    it("没有 sheet 时给出空数组", () => {
      expect(sheetsToZipFiles([])).toEqual([]);
      expect(mocks.buildXlsx).not.toHaveBeenCalled();
    });
  });

  describe("整包下载的 io 调用契约", () => {
    it("buildClassFilesZip：rooms 与 options 原样透传，逐个文件交给 buildZip", () => {
      const sheets = [fakeSheet("按班级考场安排"), fakeSheet("高三(1)班")];
      mocks.buildClassScheduleSheets.mockReturnValue(sheets);
      const zipped = new Uint8Array([9, 9]);
      mocks.buildZip.mockReturnValue(zipped);

      const bytes = buildClassFilesZip(RESULT, ROOMS, { title: "期中考试" });

      expect(mocks.buildClassScheduleSheets).toHaveBeenCalledWith(RESULT, ROOMS, {
        title: "期中考试",
      });
      expect(mocks.buildZip).toHaveBeenCalledTimes(1);
      const [files] = mocks.buildZip.mock.calls[0]!;
      expect(files.map((file) => file.name)).toEqual(["按班级考场安排.xlsx", "高三(1)班.xlsx"]);
      expect(bytes).toBe(zipped);
    });

    it("buildInvigilatorFilesZip：rooms 原样透传", () => {
      mocks.buildInvigilatorSheets.mockReturnValue([fakeSheet("第一考场（语数外物化生）")]);

      const bytes = buildInvigilatorFilesZip(RESULT, ROOMS);

      expect(mocks.buildInvigilatorSheets).toHaveBeenCalledWith(RESULT, ROOMS);
      expect(mocks.buildZip).toHaveBeenCalledWith([
        { name: "第一考场（语数外物化生）.xlsx", bytes: new Uint8Array([1]) },
      ]);
      expect(bytes).toEqual(new Uint8Array([2]));
    });

    it("不传 rooms 时也不炸（io 侧自己兜底）", () => {
      mocks.buildClassScheduleSheets.mockReturnValue([]);
      mocks.buildInvigilatorSheets.mockReturnValue([]);

      buildClassFilesZip(RESULT);
      buildInvigilatorFilesZip(RESULT);

      expect(mocks.buildClassScheduleSheets).toHaveBeenCalledWith(RESULT, undefined, undefined);
      expect(mocks.buildInvigilatorSheets).toHaveBeenCalledWith(RESULT, undefined);
    });
  });
});
