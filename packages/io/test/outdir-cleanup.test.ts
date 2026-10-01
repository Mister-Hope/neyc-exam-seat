import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import type { Job, PlanAllResult, PlanResult, RoomSpec } from "@exam-seat/core";

import { cleanOwnedArtifacts, writeMultiPlanFiles, writePlanFiles } from "../src/node";

const ROOM: RoomSpec = { id: "R1", name: "第1考场", rows: 7, cols: 5 };

const PLAN: PlanResult = {
  resultVersion: 1,
  ok: false,
  level: "orthogonal",
  stats: {
    students: 2,
    participants: 2,
    excluded: 0,
    rooms: 1,
    roomsUsed: 1,
    emptyRooms: [],
    seatsTotal: 35,
    seatsUsed: 2,
    conflicts: 0,
    unmetConstraints: 0,
    classes: 2,
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
    {
      studentId: "SYN002",
      name: "学生02",
      className: "合成2班",
      roomId: "R1",
      roomName: "第1考场",
      seatNo: 2,
      row: 1,
      col: 2,
      physicalCol: 4,
    },
  ],
  conflicts: [],
  unmetConstraints: [],
  diagnostics: [],
  inputFingerprint: "fnv1a:test",
  generatedAt: "2026-10-01T00:00:00.000Z",
};

const JOB: Job = {
  jobVersion: 2,
  students: [
    { id: "SYN001", name: "学生01", className: "合成1班", combination: "物化生" },
    { id: "SYN002", name: "学生02", className: "合成2班", combination: "物化生" },
  ],
  rooms: [ROOM],
};

const MULTI: PlanAllResult = {
  ok: true,
  slots: [{ id: "T1", name: "第1时段", subjects: ["chinese"] }],
  seatings: [
    {
      subjects: ["chinese"],
      roomId: "R1",
      roomName: "第1考场",
      studentIds: ["SYN001", "SYN002"],
      seatNoById: { SYN001: 1, SYN002: 2 },
      studentBySeatNo: { 1: "SYN001", 2: "SYN002" },
      result: PLAN,
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
    {
      studentId: "SYN002",
      name: "学生02",
      className: "合成2班",
      combination: "物化生",
      slots: {
        T1: {
          subject: "chinese",
          subjectLabel: "语文",
          roomId: "R1",
          roomName: "第1考场",
          seatNo: 2,
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

function tempDir(): string {
  return mkdtempSync(nodePath.join(tmpdir(), "exam-seat-clean-"));
}

describe("输出目录清理（清单制）", () => {
  it("cleanOwnedArtifacts 只删本工具产物，用户文件与 plan.json 都留着", () => {
    const dir = tempDir();
    try {
      writeFileSync(nodePath.join(dir, "考场安排名单.xlsx"), "x");
      writeFileSync(nodePath.join(dir, "按班级考场安排.xlsx"), "x");
      writeFileSync(nodePath.join(dir, "plan.json"), "{}");
      writeFileSync(nodePath.join(dir, "我的笔记.txt"), "别删我");
      const classDir = nodePath.join(dir, "按班级考场安排");
      mkdirSync(classDir, { recursive: true });
      writeFileSync(nodePath.join(classDir, "合成1班.xlsx"), "x");
      writeFileSync(nodePath.join(classDir, "老师的说明.txt"), "别删我");

      const removed = cleanOwnedArtifacts(dir);

      expect(removed.length).toBeGreaterThan(0);
      expect(existsSync(nodePath.join(dir, "考场安排名单.xlsx"))).toBe(false);
      expect(existsSync(nodePath.join(dir, "按班级考场安排.xlsx"))).toBe(false);
      expect(existsSync(nodePath.join(classDir, "合成1班.xlsx"))).toBe(false);
      // 工具清单之外的东西一个都不许动
      expect(existsSync(nodePath.join(dir, "plan.json"))).toBe(true);
      expect(existsSync(nodePath.join(dir, "我的笔记.txt"))).toBe(true);
      expect(existsSync(nodePath.join(classDir, "老师的说明.txt"))).toBe(true);
      expect(readdirSync(classDir)).toEqual(["老师的说明.txt"]); // 目录非空 → 保留
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("单场：成功 → 失败（writeWorkbooks:false）不残留上一次的名单", () => {
    const dir = tempDir();
    try {
      writePlanFiles(PLAN, { outDir: dir, rooms: [ROOM] });
      writeFileSync(nodePath.join(dir, "我的笔记.txt"), "别删我");
      expect(existsSync(nodePath.join(dir, "考场安排名单.xlsx"))).toBe(true);
      expect(existsSync(nodePath.join(dir, "考场座位表.xlsx"))).toBe(true);

      // 第二次：结构性 error → CLI 传 writeWorkbooks:false，只留证据
      writePlanFiles(PLAN, {
        outDir: dir,
        rooms: [ROOM],
        writeJson: true,
        job: JOB,
        writeWorkbooks: false,
      });

      expect(existsSync(nodePath.join(dir, "考场安排名单.xlsx"))).toBe(false);
      expect(existsSync(nodePath.join(dir, "考场座位表.xlsx"))).toBe(false);
      expect(existsSync(nodePath.join(dir, "plan.json"))).toBe(true);
      expect(existsSync(nodePath.join(dir, "job.json"))).toBe(true);
      expect(existsSync(nodePath.join(dir, "我的笔记.txt"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("多场次：成功 → 失败不残留工作簿与分份目录", () => {
    const dir = tempDir();
    try {
      writeMultiPlanFiles(MULTI, { outDir: dir, rooms: [ROOM], job: JOB });
      writeFileSync(nodePath.join(dir, "我的笔记.txt"), "别删我");
      expect(existsSync(nodePath.join(dir, "按班级考场安排.xlsx"))).toBe(true);
      expect(existsSync(nodePath.join(dir, "考场监考表.xlsx"))).toBe(true);

      writeMultiPlanFiles(MULTI, {
        outDir: dir,
        rooms: [ROOM],
        job: JOB,
        writeWorkbooks: false,
      });

      expect(existsSync(nodePath.join(dir, "按班级考场安排.xlsx"))).toBe(false);
      expect(existsSync(nodePath.join(dir, "考场监考表.xlsx"))).toBe(false);
      expect(existsSync(nodePath.join(dir, "按班级考场安排"))).toBe(false);
      expect(existsSync(nodePath.join(dir, "考场监考表"))).toBe(false);
      expect(existsSync(nodePath.join(dir, "plan.json"))).toBe(true);
      expect(existsSync(nodePath.join(dir, "job.json"))).toBe(true);
      expect(existsSync(nodePath.join(dir, "我的笔记.txt"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("多场次：成功 → 成功但班级变少，旧班级文件被清掉", () => {
    const dir = tempDir();
    try {
      // 先造一个上一次运行留下的「旧班级.xlsx」（以及老师自己的文件）
      const classDir = nodePath.join(dir, "按班级考场安排");
      mkdirSync(classDir, { recursive: true });
      writeFileSync(nodePath.join(classDir, "旧班级.xlsx"), "stale");
      writeFileSync(nodePath.join(classDir, "老师的说明.txt"), "别删我");

      writeMultiPlanFiles(MULTI, { outDir: dir, rooms: [ROOM], job: JOB });

      expect(existsSync(nodePath.join(classDir, "旧班级.xlsx"))).toBe(false);
      expect(existsSync(nodePath.join(classDir, "老师的说明.txt"))).toBe(true);
      expect(existsSync(nodePath.join(dir, "按班级考场安排.xlsx"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
