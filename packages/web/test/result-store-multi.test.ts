import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import { useResultStore } from "@/stores/result";
import { useRoomsStore } from "@/stores/rooms";
import type {
  Job,
  PlanAllResult,
  PlanEntry,
  PlanResult,
  RoomSpec,
  SeatingPlan,
  Student,
  StudentSchedule,
  TimeSlot,
} from "@exam-seat/core";

/**
 * Result store 的多场次状态测试。
 *
 * 这里用**与 core 输出形状一致的固定夹具**（`satisfies PlanAllResult` 由类型系统保证不漂移）， 不依赖 core 的运行时：store
 * 的职责是接线与派生，求解本身由 core 自己的测试覆盖。 关键是「空置考场必须按 seatings 用到的 roomId 判定」——夹具里 R5 容量充足但没被任何座位方案使用。
 */

const SLOTS: TimeSlot[] = [
  { id: "T1", name: "T1 语文", subjects: ["chinese"] },
  { id: "T2", name: "T2 数学", subjects: ["math"] },
  { id: "T3", name: "T3 外语", subjects: ["english"] },
  { id: "T4", name: "T4 物理/历史", subjects: ["physics", "history"] },
  { id: "T5", name: "T5 化学", subjects: ["chemistry"] },
  { id: "T6", name: "T6 生物/政治", subjects: ["biology", "politics"] },
  { id: "T7", name: "T7 地理", subjects: ["geography"] },
];

function room(id: string, name: string, extra: Partial<RoomSpec> = {}): RoomSpec {
  return { id, name, rows: 5, cols: 6, doorSide: "right", ...extra };
}

function student(
  id: string,
  name: string,
  className: string,
  combination: string,
  subjects: string[],
): Student {
  return { id, name, className, combination, subjects };
}

/** R4 是政治专用考场；R5 一个学生都用不到，是求解结果里的空置考场。 */
function multiJob(): Job {
  return {
    jobVersion: 2,
    options: { seed: 20260930, timeLimitMs: 1000 },
    students: [
      student("S1", "张一", "高三(1)班", "物化生", ["physics", "chemistry", "biology"]),
      student("S2", "李二", "高三(1)班", "政史地", ["politics", "history", "geography"]),
      student("S3", "王三", "高三(2)班", "物化政", ["physics", "chemistry", "politics"]),
      student("S4", "赵四", "高三(2)班", "物化地", ["physics", "chemistry", "geography"]),
    ],
    rooms: [
      room("R1", "第1考场"),
      room("R2", "第2考场"),
      room("R3", "第3考场"),
      room("R4", "第4考场", { dedicatedSubjects: ["politics"] }),
      room("R5", "第5考场"),
    ],
    constraints: [],
  };
}

function entry(
  studentId: string,
  name: string,
  className: string,
  roomId: string,
  roomName: string,
  seatNo: number,
): PlanEntry {
  return {
    studentId,
    name,
    className,
    roomId,
    roomName,
    seatNo,
    row: 1,
    col: seatNo,
    physicalCol: seatNo,
  };
}

function planResult(
  entries: PlanEntry[],
  emptyRooms: string[],
  overrides: { elapsedMs?: number; rooms?: number } = {},
): PlanResult {
  return {
    resultVersion: 1,
    ok: true,
    level: "strict",
    stats: {
      students: 4,
      participants: entries.length,
      excluded: 0,
      rooms: overrides.rooms ?? 5,
      roomsUsed: new Set(entries.map((item) => item.roomId)).size,
      emptyRooms,
      seatsTotal: 150,
      seatsUsed: entries.length,
      conflicts: 0,
      unmetConstraints: 0,
      classes: 2,
      elapsedMs: overrides.elapsedMs ?? 10,
      seed: 20260930,
      adjacency: "king",
    },
    entries,
    conflicts: [],
    unmetConstraints: [],
    diagnostics: [],
    inputFingerprint: "fixture",
    generatedAt: "2026-09-30T00:00:00.000Z",
  };
}

function seating(
  roomId: string,
  roomName: string,
  subjects: string[],
  students: { id: string; name: string; className: string }[],
  elapsedMs = 10,
): SeatingPlan {
  const seatNoById: Record<string, number> = {};
  const studentBySeatNo: Record<number, string> = {};
  const entries = students.map((item, index) => {
    seatNoById[item.id] = index + 1;
    studentBySeatNo[index + 1] = item.id;
    return entry(item.id, item.name, item.className, roomId, roomName, index + 1);
  });
  return {
    subjects,
    roomId,
    roomName,
    studentIds: students.map((item) => item.id),
    seatNoById,
    studentBySeatNo,
    result: planResult(entries, [], { elapsedMs, rooms: 1 }),
  };
}

function schedule(
  id: string,
  name: string,
  className: string,
  combination: string,
  distinctRooms: number,
): StudentSchedule {
  const slots: Record<string, null> = {};
  for (const slot of SLOTS) slots[slot.id] = null;
  return {
    studentId: id,
    name,
    className,
    combination,
    slots,
    rooms: Array.from({ length: distinctRooms }, (_, index) => ({
      roomId: `R${index + 1}`,
      roomName: `第${index + 1}考场`,
      subjects: ["chinese"],
    })),
    distinctRooms,
  };
}

const S1 = { id: "S1", name: "张一", className: "高三(1)班" };
const S2 = { id: "S2", name: "李二", className: "高三(1)班" };
const S3 = { id: "S3", name: "王三", className: "高三(2)班" };
const S4 = { id: "S4", name: "赵四", className: "高三(2)班" };

/** 与真实 `planAll` 输出同形：4 套座位方案（R1~R4），R5 空置。 */
function planAllFixture(): PlanAllResult {
  return {
    ok: true,
    slots: SLOTS,
    seatings: [
      seating("R1", "第1考场", ["chinese", "math", "physics"], [S1], 11),
      seating("R2", "第2考场", ["chinese", "math", "history"], [S2], 12),
      seating("R3", "第3考场", ["chinese", "math", "physics", "chemistry"], [S3, S4], 13),
      seating("R4", "第4考场", ["politics"], [S3], 14),
    ],
    byStudent: [
      schedule("S1", "张一", "高三(1)班", "物化生", 1),
      schedule("S2", "李二", "高三(1)班", "政史地", 1),
      schedule("S3", "王三", "高三(2)班", "物化政", 2),
      schedule("S4", "赵四", "高三(2)班", "物化地", 1),
    ],
    emptyRooms: ["第5考场"],
    overRoomLimit: [],
    diagnostics: [],
  } satisfies PlanAllResult;
}

describe("result store：多场次状态", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("setAllResult 写入多场次结果，单场字段被清空", () => {
    const store = useResultStore();
    const job = multiJob();
    const all = planAllFixture();

    store.setAllResult(all, job);

    expect(store.mode).toBe("all");
    expect(store.planAll).not.toBeNull();
    expect(store.result).toBeNull();
    expect(store.hasMultiResult).toBe(true);
    expect(store.hasResult).toBe(true);
    expect(store.status).toBe("done");
    expect(store.slots).toHaveLength(7);
    expect(store.seatings).toHaveLength(4);
    expect(store.scheduleByStudent).toHaveLength(4);
    expect(store.isDegraded).toBe(false);
    expect(store.elapsedMs).toBe(11 + 12 + 13 + 14);
  });

  it("空置考场按求解结果判定：seatings 没用到 R5，即使它容量充足也算空置", () => {
    const store = useResultStore();
    const job = multiJob();
    store.setAllResult(planAllFixture(), job);

    expect(store.job?.rooms.find((item) => item.id === "R5")?.rows).toBe(5);
    expect(store.emptyRoomIds).toEqual(["R5"]);
    expect(store.emptyRoomNames).toEqual(["第5考场"]);
  });

  it("需要换考场的非常规组合学生：物化政去专用考场，物化地不换", () => {
    const store = useResultStore();
    const job = multiJob();
    store.setAllResult(planAllFixture(), job);

    const byId = new Map(store.scheduleByStudent.map((item) => [item.studentId, item]));
    expect(byId.get("S1")!.distinctRooms).toBe(1);
    expect(byId.get("S2")!.distinctRooms).toBe(1);
    expect(byId.get("S3")!.distinctRooms).toBe(2);
    expect(byId.get("S4")!.distinctRooms).toBe(1);
    expect(store.planAll!.overRoomLimit).toEqual([]);
  });

  it("setResult 默认单场：老调用方行为不变，多场次字段清空", () => {
    const store = useResultStore();
    const job = multiJob();
    store.setAllResult(planAllFixture(), job);
    expect(store.hasMultiResult).toBe(true);

    const single = planResult(
      [
        entry("S1", "张一", "高三(1)班", "R1", "第1考场", 1),
        entry("S2", "李二", "高三(1)班", "R1", "第1考场", 2),
        entry("S3", "王三", "高三(2)班", "R1", "第1考场", 3),
        entry("S4", "赵四", "高三(2)班", "R1", "第1考场", 4),
      ],
      ["R2", "R3", "R4", "R5"],
    );
    store.setResult(single, job);

    expect(store.mode).toBe("single");
    expect(store.planAll).toBeNull();
    expect(store.hasMultiResult).toBe(false);
    expect(store.result?.stats.participants).toBe(4);
    expect(store.entries).toHaveLength(4);
    // 单场也提供空置考场（来自 result.stats.emptyRooms，同样是求解结果）
    expect(store.emptyRoomIds).toEqual(["R2", "R3", "R4", "R5"]);
    expect(store.emptyRoomNames).toEqual(["第2考场", "第3考场", "第4考场", "第5考场"]);
    expect(store.report).not.toBeNull();
  });

  it("多场次结果写回后单场结果消失，反之亦然（两条路径互斥）", () => {
    const store = useResultStore();
    const job = multiJob();
    const single = planResult(
      [entry("S1", "张一", "高三(1)班", "R1", "第1考场", 1)],
      ["R2", "R3", "R4", "R5"],
    );
    store.setResult(single, job);
    store.setAllResult(planAllFixture(), job);
    expect(store.result).toBeNull();
    expect(store.hasMultiResult).toBe(true);

    store.setResult(single, job);
    expect(store.planAll).toBeNull();
    expect(store.hasMultiResult).toBe(false);
  });

  it("removeEmptyRooms 只删空置考场，同时改 rooms store 与 job 快照，并清掉旧结果", () => {
    const store = useResultStore();
    const rooms = useRoomsStore();
    const job = multiJob();
    rooms.replaceRooms(job.rooms);
    store.setAllResult(planAllFixture(), job);

    const { removed } = store.removeEmptyRooms();

    expect(removed).toEqual(["第5考场"]);
    expect(rooms.rooms.map((item) => item.id)).toEqual(["R1", "R2", "R3", "R4"]);
    expect(store.job!.rooms.map((item) => item.id)).toEqual(["R1", "R2", "R3", "R4"]);
    // 旧结果已不对应新配置 → 清掉，提示重排
    expect(store.hasResult).toBe(false);
    expect(store.hasMultiResult).toBe(false);
    expect(store.status).toBe("idle");
    expect(store.emptyRoomIds).toEqual([]);

    // 没有空置考场时是幂等的空操作
    expect(store.removeEmptyRooms()).toEqual({ removed: [] });
    expect(rooms.rooms).toHaveLength(4);
  });

  it("clear() 同时清掉单场与多场次结果", () => {
    const store = useResultStore();
    const job = multiJob();
    store.setAllResult(planAllFixture(), job);
    store.clear();

    expect(store.planAll).toBeNull();
    expect(store.result).toBeNull();
    expect(store.mode).toBe("single");
    expect(store.hasResult).toBe(false);
    expect(store.slots).toEqual([]);
    expect(store.seatings).toEqual([]);
    expect(store.scheduleByStudent).toEqual([]);
  });

  it("持久化 planAll 与 mode，刷新（重建 pinia）后能恢复多场次状态", async () => {
    const store = useResultStore();
    const job = multiJob();
    store.setAllResult(planAllFixture(), job);
    await nextTick();

    const raw = localStorage.getItem("exam-seat:result");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { mode?: string; planAll?: unknown; result?: unknown };
    expect(parsed.mode).toBe("all");
    expect(parsed.planAll).not.toBeNull();
    expect(parsed.result).toBeNull();

    // 重建 pinia 模拟刷新
    setActivePinia(createPinia());
    const restored = useResultStore();
    expect(restored.mode).toBe("all");
    expect(restored.hasMultiResult).toBe(true);
    expect(restored.slots).toHaveLength(7);
    expect(restored.emptyRoomIds).toEqual(["R5"]);
  });
});
