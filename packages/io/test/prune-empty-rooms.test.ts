import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import { plan, planAll } from "@exam-seat/core";
import type { Job, RoomSpec } from "@exam-seat/core";

import { pruneEmptyRooms, usedRoomIds } from "../src/index";
import { writeMultiPlanFiles, writePlanFiles } from "../src/node";

const SMALL: Omit<RoomSpec, "id" | "name"> = { rows: 6, cols: 5 };

function room(n: number): RoomSpec {
  return { id: `R${n}`, name: `第${n}考场`, ...SMALL };
}

/** 9 个学生、12 个考场：求解器最多用到 9 个考场，必然有空置。 */
function singleScene(): Job {
  const students: Job["students"] = Array.from({ length: 9 }, (_, i) => ({
    id: `S${String(i).padStart(2, "0")}`,
    name: `学生${i}`,
    className: `高三(${i + 1}班)`,
  }));
  return {
    jobVersion: 2,
    students,
    rooms: Array.from({ length: 12 }, (_, i) => room(i + 1)),
  };
}

/** 36 个学生、4 个普通考场 + 3 个备用普通考场：必然有空置考场。 */
function multiScene(): Job {
  const perCombo: Record<string, number> = { 物化生: 12, 政史地: 12, 物化政: 6, 物化地: 6 };
  const students: Job["students"] = [];
  let cursor = 0;
  for (const [combination, count] of Object.entries(perCombo)) {
    for (let i = 0; i < count; i += 1) {
      cursor += 1;
      students.push({
        id: `${combination}-${String(i).padStart(2, "0")}`,
        name: `${combination}${i}`,
        className: `高三(${(cursor % 12) + 1}班)`,
        combination,
      });
    }
  }
  return {
    jobVersion: 2,
    students,
    rooms: [
      { ...room(1), location: "高二一班", note: "张老师" },
      { ...room(2), location: "高二二班", note: "李老师" },
      { ...room(3), location: "高二三班" },
      { ...room(4), location: "高二四班" },
      { ...room(20), location: "生物实验室", dedicatedSubjects: ["politics"] },
      { ...room(21), location: "地理教室", dedicatedSubjects: ["geography"] },
      room(98),
      room(99),
    ],
  };
}

const SINGLE_JOB = singleScene();
const SINGLE_RESULT = plan(SINGLE_JOB);
const MULTI_JOB = multiScene();
const MULTI_RESULT = planAll(MULTI_JOB);

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "exam-seat-prune-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("从结果推导用到的考场", () => {
  it("单场从 entries 推导，去重且保留首次出现顺序", () => {
    const used = usedRoomIds(SINGLE_RESULT);
    expect(used).toEqual([...new Set(SINGLE_RESULT.entries.map((e) => e.roomId))]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.length).toBeLessThan(SINGLE_JOB.rooms.length);
  });

  it("多场次从 seatings 推导，空置考场不在其中", () => {
    const used = usedRoomIds(MULTI_RESULT);
    expect(used).toEqual([...new Set(MULTI_RESULT.seatings.map((s) => s.roomId))]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.length).toBeLessThan(MULTI_JOB.rooms.length);
    expect(MULTI_RESULT.emptyRooms.length).toBeGreaterThan(0);
  });
});

describe("剔除空置考场", () => {
  it("剔除没用到的考场，removed 按原 rooms 顺序", () => {
    const job = { meta: { title: "一模" }, rooms: [room(3), room(1), room(2)] };
    const { job: pruned, removed } = pruneEmptyRooms(job, ["R1"]);
    expect(pruned.meta).toEqual({ title: "一模" });
    expect(pruned.rooms.map((r) => r.id)).toEqual(["R1"]);
    expect(removed.map((r) => r.id)).toEqual(["R3", "R2"]);
    expect(removed.map((r) => r.name)).toEqual(["第3考场", "第2考场"]);
  });

  it("不原地修改原 job", () => {
    const job = { rooms: [room(1), room(2)] };
    const snapshot = JSON.stringify(job);
    const { job: pruned, removed } = pruneEmptyRooms(job, ["R1"]);
    expect(JSON.stringify(job)).toBe(snapshot);
    expect(pruned).not.toBe(job);
    expect(pruned.rooms).not.toBe(job.rooms);
    expect(removed).toHaveLength(1);
  });

  it("没有 rooms 字段时也不炸，返回空 removed", () => {
    const job: { students: string[]; rooms?: RoomSpec[] } = { students: [] };
    const { job: pruned, removed } = pruneEmptyRooms(job, ["R1"]);
    expect(pruned.students).toEqual([]);
    expect(removed).toEqual([]);
  });
});

describe("单场导出剔除空置考场", () => {
  it("job.json 不再包含空置考场，plan.json 保持原样", () => {
    withTempDir((dir) => {
      const before = SINGLE_JOB.rooms.length;
      const written = writePlanFiles(SINGLE_RESULT, {
        outDir: dir,
        rooms: SINGLE_JOB.rooms,
        writeJson: true,
        job: SINGLE_JOB,
      });

      expect(readdirSync(dir)).toContain("job.json");
      const exportedJob = JSON.parse(readFileSync(nodePath.join(dir, "job.json"), "utf8")) as Job;
      const keptIds = new Set(usedRoomIds(SINGLE_RESULT));
      expect(exportedJob.rooms.map((r) => r.id)).toEqual(
        SINGLE_JOB.rooms.filter((r) => keptIds.has(r.id)).map((r) => r.id),
      );
      expect(exportedJob.rooms.length).toBeLessThan(before);
      expect(exportedJob.students).toEqual(SINGLE_JOB.students);
      expect(SINGLE_JOB.rooms).toHaveLength(before); // 原 job 未被改

      expect(written.removedRooms).toEqual(
        SINGLE_JOB.rooms.filter((r) => !keptIds.has(r.id)).map((r) => r.name ?? r.id),
      );
      expect(written.removedRooms.length).toBeGreaterThan(0);

      const exportedPlan = JSON.parse(readFileSync(nodePath.join(dir, "plan.json"), "utf8")) as {
        stats: { emptyRooms: string[] };
      };
      expect(exportedPlan.stats.emptyRooms).toEqual(SINGLE_RESULT.stats.emptyRooms);
      expect(exportedPlan.stats.emptyRooms.length).toBeGreaterThan(0);
    });
  });

  it("不传 job 时不写 job.json，removedRooms 为空", () => {
    withTempDir((dir) => {
      const written = writePlanFiles(SINGLE_RESULT, { outDir: dir, writeJson: true });
      expect(readdirSync(dir)).not.toContain("job.json");
      expect(written.removedRooms).toEqual([]);
    });
  });

  it("一个考场都没用到时不掏空 job.json（这次没排出来，原样留证据）", () => {
    const nothingPlanned = {
      ...SINGLE_RESULT,
      entries: [],
      stats: { ...SINGLE_RESULT.stats, roomsUsed: 0 },
    };
    withTempDir((dir) => {
      const written = writePlanFiles(nothingPlanned, {
        outDir: dir,
        writeJson: true,
        job: SINGLE_JOB,
      });
      const exportedJob = JSON.parse(readFileSync(nodePath.join(dir, "job.json"), "utf8")) as Job;
      expect(exportedJob.rooms).toHaveLength(SINGLE_JOB.rooms.length);
      expect(written.removedRooms).toEqual([]);
    });
  });

  it("writeWorkbooks=false 时只留 plan.json / job.json，不写名单工作簿", () => {
    withTempDir((dir) => {
      const written = writePlanFiles(SINGLE_RESULT, {
        outDir: dir,
        rooms: SINGLE_JOB.rooms,
        writeJson: true,
        job: SINGLE_JOB,
        writeWorkbooks: false,
      });
      const files = readdirSync(dir);
      expect(files).toContain("plan.json");
      expect(files).toContain("job.json");
      expect(files).not.toContain("考场安排名单.xlsx");
      expect(files).not.toContain("考场座位表.xlsx");
      expect(written.files.some((path) => path.endsWith(".xlsx"))).toBe(false);
    });
  });
});

describe("多场次导出剔除空置考场", () => {
  it("额外写出剔除空置后的 job.json，plan.json 保持原样", () => {
    withTempDir((dir) => {
      const before = MULTI_JOB.rooms.length;
      const written = writeMultiPlanFiles(MULTI_RESULT, {
        outDir: dir,
        rooms: MULTI_JOB.rooms,
        job: MULTI_JOB,
      });

      const files = readdirSync(dir);
      expect(files).toContain("job.json");
      expect(files).toContain("plan.json");
      expect(files).toContain("按班级考场安排.xlsx");
      expect(files).toContain("考场监考表.xlsx");

      const exportedJob = JSON.parse(readFileSync(nodePath.join(dir, "job.json"), "utf8")) as Job;
      const keptIds = new Set(usedRoomIds(MULTI_RESULT));
      expect(exportedJob.rooms.map((r) => r.id)).toEqual(
        MULTI_JOB.rooms.filter((r) => keptIds.has(r.id)).map((r) => r.id),
      );
      expect(exportedJob.rooms.length).toBeLessThan(before);
      expect(MULTI_JOB.rooms).toHaveLength(before);

      expect(written.removedRooms).toEqual(
        MULTI_JOB.rooms.filter((r) => !keptIds.has(r.id)).map((r) => r.name ?? r.id),
      );
      expect(written.removedRooms.length).toBeGreaterThan(0);

      const exportedPlan = JSON.parse(readFileSync(nodePath.join(dir, "plan.json"), "utf8")) as {
        emptyRooms: string[];
      };
      expect(exportedPlan.emptyRooms).toEqual(MULTI_RESULT.emptyRooms);
      expect(exportedPlan.emptyRooms.length).toBeGreaterThan(0);
    });
  });

  it("一套座位方案都没有时不掏空 job.json", () => {
    const nothingPlanned = { ...MULTI_RESULT, seatings: [], byStudent: [] };
    withTempDir((dir) => {
      const written = writeMultiPlanFiles(nothingPlanned, {
        outDir: dir,
        rooms: MULTI_JOB.rooms,
        job: MULTI_JOB,
      });
      const exportedJob = JSON.parse(readFileSync(nodePath.join(dir, "job.json"), "utf8")) as Job;
      expect(exportedJob.rooms).toHaveLength(MULTI_JOB.rooms.length);
      expect(written.removedRooms).toEqual([]);
    });
  });

  it("writeWorkbooks=false 时只留 plan.json / job.json，不写工作簿", () => {
    withTempDir((dir) => {
      const written = writeMultiPlanFiles(MULTI_RESULT, {
        outDir: dir,
        rooms: MULTI_JOB.rooms,
        job: MULTI_JOB,
        writeWorkbooks: false,
      });
      const files = readdirSync(dir);
      expect(files).toContain("plan.json");
      expect(files).toContain("job.json");
      expect(files).not.toContain("按班级考场安排.xlsx");
      expect(files).not.toContain("考场监考表.xlsx");
      expect(written.files.some((path) => path.endsWith(".xlsx"))).toBe(false);
    });
  });
});
