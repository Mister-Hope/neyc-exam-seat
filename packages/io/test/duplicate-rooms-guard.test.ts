import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import type { PlanAllResult, PlanResult, RoomSpec } from "@exam-seat/core";

import { describeDuplicateRoomIds, findDuplicateRoomIds } from "../src/index";
import { writeMultiPlanFiles, writePlanFiles } from "../src/node";

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

const ROOM: RoomSpec = { id: "R1", name: "第1考场", rows: 7, cols: 5 };

const PLAN: PlanResult = {
  resultVersion: 1,
  ok: true,
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
  byStudent: [],
  emptyRooms: [],
  overRoomLimit: [],
  unmetConstraints: [],
  relaxedRooms: [],
  borrowings: [],
  diagnostics: [],
};

/* ------------------------------------------------------------------ */
/* 重复 id 检测                                                        */
/* ------------------------------------------------------------------ */

describe("重复考场 id 检测", () => {
  it("id 唯一时返回空/undefined", () => {
    expect(findDuplicateRoomIds([ROOM, { ...ROOM, id: "R2" }])).toEqual([]);
    expect(describeDuplicateRoomIds([ROOM, { ...ROOM, id: "R2" }])).toBeUndefined();
  });

  it("列出重复 id 与它出现的下标（1 基给老师看）", () => {
    const rooms = [ROOM, { ...ROOM, id: "R2" }, { ...ROOM, name: "第2考场" }];
    expect(findDuplicateRoomIds(rooms)).toEqual([{ id: "R1", indices: [0, 2] }]);
    const message = describeDuplicateRoomIds(rooms);
    expect(message).toContain("考场 id 重复");
    expect(message).toContain("R1（第 1、3 个考场）");
  });
});

/* ------------------------------------------------------------------ */
/* 写文件入口自保：重复 id 一个文件都不写                                */
/* ------------------------------------------------------------------ */

describe("写文件入口自保", () => {
  const duplicated: RoomSpec[] = [ROOM, { ...ROOM, name: "第2考场" }];

  it("writePlanFiles 遇到重复 id 直接抛错，不建目录", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "exam-seat-dup-"));
    const dir = nodePath.join(root, "out");
    try {
      expect(() => writePlanFiles(PLAN, { outDir: dir, rooms: duplicated })).toThrow(
        /考场 id 重复/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writeMultiPlanFiles 遇到重复 id 直接抛错", () => {
    const root = mkdtempSync(nodePath.join(tmpdir(), "exam-seat-dup-"));
    const dir = nodePath.join(root, "out");
    try {
      expect(() =>
        writeMultiPlanFiles(MULTI, {
          outDir: dir,
          rooms: duplicated,
          job: { jobVersion: 2, rooms: duplicated, students: [] },
        }),
      ).toThrow(/考场 id 重复/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("id 唯一的正常 job 照常导出（防回归）", () => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "exam-seat-uniq-"));
    try {
      const written = writePlanFiles(PLAN, { outDir: dir, rooms: [ROOM] });
      expect(written.files.some((file) => file.endsWith("考场安排名单.xlsx"))).toBe(true);
      expect(written.files.some((file) => file.endsWith("考场座位表.xlsx"))).toBe(true);
      expect(written.files.some((file) => file.endsWith("plan.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
