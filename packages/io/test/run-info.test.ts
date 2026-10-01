import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import type { Job, PlanAllResult, PlanResult, RoomSpec } from "@exam-seat/core";

import { writeMultiPlanFiles, writePlanFiles } from "../src/node";
import type { RunInfo } from "../src/node";

const ROOM: RoomSpec = { id: "R1", name: "第1考场", rows: 7, cols: 5 };

function planWith(overrides: Partial<PlanResult>): PlanResult {
  return {
    resultVersion: 1,
    ok: true,
    level: "orthogonal",
    stats: {
      students: 1,
      participants: 1,
      excluded: 0,
      rooms: 1,
      roomsUsed: 1,
      emptyRooms: [],
      seatsTotal: 35,
      seatsUsed: 1,
      conflicts: 0,
      unmetConstraints: 0,
      classes: 1,
      elapsedMs: 1,
      seed: 1,
      adjacency: "orthogonal",
    },
    entries: [
      {
        studentId: "SYN001",
        name: "学生01",
        className: "合成1班",
        roomId: "R1",
        roomName: "第1考场",
        seatNo: 1,
        row: 1,
        col: 1,
        physicalCol: 5,
      },
    ],
    conflicts: [],
    unmetConstraints: [],
    diagnostics: [],
    inputFingerprint: "fnv1a:test",
    generatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

const READY = planWith({});
const WARNING = planWith({
  diagnostics: [
    { code: "TOO_FEW_CLASSES", severity: "warning", message: "只有 1 个班", suggestions: [] },
  ],
});
const BLOCKED = planWith({
  ok: false,
  diagnostics: [
    { code: "CAPACITY_INSUFFICIENT", severity: "error", message: "座位不够", suggestions: [] },
  ],
});

const JOB: Job = { jobVersion: 2, students: [], rooms: [ROOM] };

/** 统一的排序：artifacts 与目录清单用同一个 comparator，避免 `.sort()` 与 localeCompare 顺序不同。 */
const sortNames = (names: readonly string[]): string[] =>
  [...names].sort((a, b) => a.localeCompare(b));

function readRun(dir: string): RunInfo {
  return JSON.parse(readFileSync(nodePath.join(dir, "run.json"), "utf8")) as RunInfo;
}

/** 递归列出目录里所有文件（相对路径，排序），用来核对 artifacts 是否与事实一致。 */
function relativeFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  const base = nodePath.join(dir, prefix);
  const entries = readdirSync(base, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...relativeFiles(dir, rel));
    else out.push(rel);
  }
  return out;
}

describe("run.json：本次运行信息", () => {
  it("成功路径：ready + exportedWorkbooks=true，artifacts 与目录实际内容一致", () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "exam-seat-run-"));
    try {
      writePlanFiles(READY, { outDir: dir, rooms: [ROOM], tool: "exam-seat 9.9.9" });
      const run = readRun(dir);
      expect(run.tool).toBe("exam-seat 9.9.9");
      expect(run.delivery).toBe("ready");
      expect(run.exportedWorkbooks).toBe(true);
      expect(Number.isNaN(Date.parse(run.generatedAt))).toBe(false);
      expect(sortNames(run.artifacts)).toEqual(sortNames(relativeFiles(dir)));
      expect(run.artifacts).toContain("run.json");
      expect(run.artifacts).toContain("考场座位表.xlsx");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("有 warning 诊断 → ready-with-warnings", () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "exam-seat-run-"));
    try {
      writePlanFiles(WARNING, { outDir: dir, rooms: [ROOM] });
      expect(readRun(dir).delivery).toBe("ready-with-warnings");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("失败路径（writeWorkbooks:false）→ blocked、exportedWorkbooks=false，只列 json", () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "exam-seat-run-"));
    try {
      writePlanFiles(BLOCKED, {
        outDir: dir,
        rooms: [ROOM],
        writeJson: true,
        job: JOB,
        writeWorkbooks: false,
      });
      const run = readRun(dir);
      expect(run.delivery).toBe("blocked");
      expect(run.exportedWorkbooks).toBe(false);
      expect(run.artifacts.every((name) => name.endsWith(".json"))).toBe(true);
      expect(sortNames(run.artifacts)).toEqual(sortNames(relativeFiles(dir)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("core 已给 delivery 时以它为准（不再按诊断复算）", () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "exam-seat-run-"));
    try {
      writePlanFiles(planWith({ delivery: "blocked" }), { outDir: dir, rooms: [ROOM] });
      expect(readRun(dir).delivery).toBe("blocked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("多场次：artifacts 含分份目录里的相对路径", () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "exam-seat-run-"));
    try {
      const multi: PlanAllResult = {
        ok: true,
        slots: [{ id: "T1", name: "第1时段", subjects: ["chinese"] }],
        seatings: [
          {
            subjects: ["chinese"],
            roomId: "R1",
            roomName: "第1考场",
            studentIds: ["SYN001"],
            seatNoById: { SYN001: 1 },
            studentBySeatNo: { 1: "SYN001" },
            result: READY,
          },
        ],
        byStudent: [
          {
            studentId: "SYN001",
            name: "学生01",
            className: "合成1班",
            combination: "物化生",
            slots: {
              T1: {
                subject: "chinese",
                subjectLabel: "语文",
                roomId: "R1",
                roomName: "第1考场",
                seatNo: 1,
              },
            },
            rooms: [{ roomId: "R1", roomName: "第1考场", subjects: ["chinese"] }],
            distinctRooms: 1,
          },
        ],
        emptyRooms: [],
        overRoomLimit: [],
        unmetConstraints: [],
        relaxedRooms: [],
        borrowings: [],
        diagnostics: [],
      };
      writeMultiPlanFiles(multi, { outDir: dir, rooms: [ROOM], job: JOB });
      const run = readRun(dir);
      expect(run.exportedWorkbooks).toBe(true);
      expect(sortNames(run.artifacts)).toEqual(sortNames(relativeFiles(dir)));
      expect(run.artifacts.some((name) => name.startsWith("按班级考场安排/"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
