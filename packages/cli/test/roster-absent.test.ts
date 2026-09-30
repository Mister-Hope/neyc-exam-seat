import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

import { EXIT_OK, EXIT_USAGE, main } from "../src/cli";

function makeXlsx(rows: (string | number)[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "exam-seat-roster-cli-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const spies: { mockRestore: () => void }[] = [];

function captureOutput(): { stdout: () => string; stderr: () => string } {
  const outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  spies.push(outSpy, errSpy);
  return {
    stdout: () => outSpy.mock.calls.map((call) => String(call[0])).join(""),
    stderr: () => errSpy.mock.calls.map((call) => String(call[0])).join(""),
  };
}

const ROSTER = [
  ["学号", "姓名", "班级"],
  ["A1", "张三", "高三(1)班"],
  ["A2", "李四", "高三(1)班"],
  ["A3", "王五", "高三(2)班"],
];

describe("exam-seat roster --absent", () => {
  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
  });

  it("按准考证号命中：--json 里缺考者 included=false，并打印命中 / 未匹配", async () => {
    await withTempDir(async (dir) => {
      const rosterPath = nodePath.join(dir, "全名单.xlsx");
      const absentPath = nodePath.join(dir, "缺考名单.xlsx");
      writeFileSync(rosterPath, makeXlsx(ROSTER));
      writeFileSync(absentPath, makeXlsx([["准考证号"], ["A2"], ["A9"]]));

      const captured = captureOutput();
      const code = await main([
        "node",
        "exam-seat",
        "--json",
        "roster",
        "--file",
        rosterPath,
        "--absent",
        absentPath,
      ]);

      expect(code).toBe(EXIT_OK);
      const payload = JSON.parse(captured.stdout()) as {
        students: { id: string; included?: boolean }[];
        absentCount: number;
        absent: {
          file: string;
          keyCount: number;
          matchedCount: number;
          unmatchedCount: number;
          unmatched: { row: number; id?: string }[];
        };
        issues: { level: string; message: string }[];
      };
      expect(payload.students.find((s) => s.id === "A2")!.included).toBe(false);
      expect(payload.students.find((s) => s.id === "A1")!.included).toBeUndefined();
      expect(payload.absentCount).toBe(1);
      expect(payload.absent).toMatchObject({
        file: absentPath,
        keyCount: 2,
        matchedCount: 1,
        unmatchedCount: 1,
        unmatched: [{ row: 3, id: "A9" }],
      });
      // 未匹配必须能被看到（JSON issues + stderr 双份，不能静默）
      expect(payload.issues.some((issue) => issue.message.includes("没找到"))).toBe(true);
      expect(captured.stderr()).toContain("缺考名单命中 1 人 / 未匹配 1 行");
      expect(captured.stderr()).toContain("缺考名单第 3 行");
    });
  });

  it("按 姓名 + 班级 命中（非 --json 时也打印摘要）", async () => {
    await withTempDir(async (dir) => {
      const rosterPath = nodePath.join(dir, "全名单.xlsx");
      const absentPath = nodePath.join(dir, "缺考名单.xlsx");
      writeFileSync(rosterPath, makeXlsx(ROSTER));
      writeFileSync(
        absentPath,
        makeXlsx([
          ["姓名", "班级"],
          ["王五", "高三(2)班"],
        ]),
      );

      const captured = captureOutput();
      const code = await main([
        "node",
        "exam-seat",
        "roster",
        "--file",
        rosterPath,
        "--absent",
        absentPath,
      ]);

      expect(code).toBe(EXIT_OK);
      expect(captured.stderr()).toContain("缺考名单命中 1 人 / 未匹配 0 行");
    });
  });

  it("缺考名单自带「缺考」列 → 只取真正缺席的行", async () => {
    await withTempDir(async (dir) => {
      const rosterPath = nodePath.join(dir, "全名单.xlsx");
      const absentPath = nodePath.join(dir, "缺考名单.xlsx");
      writeFileSync(rosterPath, makeXlsx(ROSTER));
      writeFileSync(
        absentPath,
        makeXlsx([
          ["学号", "姓名", "班级", "缺考"],
          ["A1", "张三", "高三(1)班", "是"],
          ["A2", "李四", "高三(1)班", "否"],
        ]),
      );

      const captured = captureOutput();
      const code = await main([
        "node",
        "exam-seat",
        "--json",
        "roster",
        "--file",
        rosterPath,
        "--absent",
        absentPath,
      ]);

      expect(code).toBe(EXIT_OK);
      const payload = JSON.parse(captured.stdout()) as {
        students: { id: string; included?: boolean }[];
        absent: { matchedCount: number };
      };
      expect(payload.students.find((s) => s.id === "A1")!.included).toBe(false);
      expect(payload.students.find((s) => s.id === "A2")!.included).toBeUndefined();
      expect(payload.absent.matchedCount).toBe(1);
    });
  });

  it("缺考名单缺列 → --json 输出 ABSENT_LIST_INVALID，退出码 1", async () => {
    await withTempDir(async (dir) => {
      const rosterPath = nodePath.join(dir, "全名单.xlsx");
      const absentPath = nodePath.join(dir, "缺考名单.xlsx");
      writeFileSync(rosterPath, makeXlsx(ROSTER));
      writeFileSync(absentPath, makeXlsx([["姓名"], ["张三"]]));

      const captured = captureOutput();
      const code = await main([
        "node",
        "exam-seat",
        "--json",
        "roster",
        "--file",
        rosterPath,
        "--absent",
        absentPath,
      ]);

      expect(code).toBe(EXIT_USAGE);
      expect(JSON.parse(captured.stdout())).toMatchObject({
        ok: false,
        error: "ABSENT_LIST_INVALID",
      });
    });
  });

  it("名单里的缺考列：不传 --absent 也标 included=false，且不打印缺考名单摘要", async () => {
    await withTempDir(async (dir) => {
      const rosterPath = nodePath.join(dir, "全名单.xlsx");
      writeFileSync(
        rosterPath,
        makeXlsx([
          ["学号", "姓名", "班级", "是否缺考"],
          ["A1", "张三", "高三(1)班", "是"],
          ["A2", "李四", "高三(1)班", "否"],
          ["A3", "王五", "高三(2)班", ""],
        ]),
      );

      const captured = captureOutput();
      const code = await main(["node", "exam-seat", "--json", "roster", "--file", rosterPath]);

      expect(code).toBe(EXIT_OK);
      const payload = JSON.parse(captured.stdout()) as {
        mapping: { absent?: number };
        students: { id: string; included?: boolean }[];
        absentCount: number;
      };
      expect(payload.mapping.absent).toBe(3);
      expect(payload.students.map((s) => s.included === false)).toEqual([true, false, false]);
      expect(payload.absentCount).toBe(1);
      expect(captured.stderr()).not.toContain("缺考名单命中");
    });
  });
});
