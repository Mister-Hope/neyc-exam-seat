import { describe, expect, it } from "vitest";

import {
  blocksListExport,
  evaluateDelivery,
  plan,
  precheckJob,
  seatNoToRCIn,
  toPhysicalCol,
  validate,
} from "../src/index";
import type { Job, PlanResult, RoomSpec } from "../src/index";

/** 两间 2×3（6 座）考场 */
function rooms(relax?: boolean | number, count = 2): RoomSpec[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `R${index + 1}`,
    name: `第${index + 1}考场`,
    rows: 2,
    cols: 3,
    ...(relax === undefined ? {} : { relaxSameClass: relax }),
  }));
}

function studentsByClass(counts: number[]): Job["students"] {
  const out: Job["students"] = [];
  counts.forEach((count, cls) => {
    for (let i = 0; i < count; i += 1) {
      out.push({ id: `C${cls}-${i}`, name: `n${cls}${i}`, className: `合成班${cls + 1}` });
    }
  });
  return out;
}

/** 每间考场里各班的人数 */
function perRoomClass(result: PlanResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of result.entries) {
    const key = `${entry.roomId}|${entry.className}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

describe("`relaxSameClass` 数字 = 该考场同班人数上限（task-59）", () => {
  const baseJob = (relax: boolean | number, counts = [4, 2], roomCount = 2): Job => ({
    jobVersion: 2,
    students: studentsByClass(counts),
    rooms: rooms(relax, roomCount),
  });

  it("① 两间都设 2 + A 班 4 人：没有任何一间 A 班超过 2（修复前是 4 人同房）", () => {
    const result = plan(baseJob(2));
    const counts = perRoomClass(result);

    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(6);
    for (const [key, count] of Object.entries(counts)) {
      if (!key.endsWith("合成班1")) continue;
      expect(count).toBeLessThanOrEqual(2);
    }
    // 4 个 A 班学生被拆成 2 + 2
    expect(Object.entries(counts).filter(([key]) => key.endsWith("合成班1"))).toHaveLength(2);
    expect(validate(baseJob(2), result).ok).toBe(true);
  });

  it("② 设 `true`（完全放开）：行为不变，允许集中在同一间", () => {
    const result = plan(baseJob(true));
    const counts = perRoomClass(result);

    expect(result.ok).toBe(true);
    expect(counts["R1|合成班1"]).toBe(4); // `true` 不限人数，greedy 会把 4 人放进第一间
    expect(validate(baseJob(true), result).ok).toBe(true);
  });

  it("③ 手工业造「4 人进上限 2 的同一间」→ 校验器报错、delivery=blocked", () => {
    const job = baseJob(2, [4, 2], 2);
    const base = plan(job);
    const forced = JSON.parse(JSON.stringify(base)) as PlanResult;
    const roomOf = (id: string): RoomSpec => job.rooms.find((room) => room.id === id)!;
    const place = (
      entry: (typeof forced.entries)[number],
      roomId: string,
      seatNo: number,
    ): void => {
      const room = roomOf(roomId);
      const rc = seatNoToRCIn(room, seatNo);
      entry.roomId = roomId;
      entry.roomName = room.name ?? roomId;
      entry.seatNo = seatNo;
      entry.row = rc.row;
      entry.col = rc.col;
      entry.physicalCol = toPhysicalCol(rc.col, room.cols, room.doorSide ?? "right");
    };
    // 4 个 A 班学生全塞进 R1（上限 2），2 个 B 班学生放 R2：除了「同班超上限」不该有别的 error
    const classA = forced.entries.filter((entry) => entry.className === "合成班1");
    const classB = forced.entries.filter((entry) => entry.className === "合成班2");
    for (const [index, entry] of classA.entries()) place(entry, "R1", index + 1);
    for (const [index, entry] of classB.entries()) place(entry, "R2", index + 1);

    const report = validate(job, forced);
    expect(report.ok).toBe(false);
    expect(
      report.issues.filter((item) => item.severity === "error").map((item) => item.code),
    ).toEqual(["ROOM_SAME_CLASS_LIMIT_EXCEEDED"]);
    const issue = report.issues.find((item) => item.code === "ROOM_SAME_CLASS_LIMIT_EXCEEDED")!;
    expect(issue.refs).toMatchObject({ roomId: "R1", limit: 2, count: 4, className: "合成班1" });
    expect(evaluateDelivery(job, forced)).toBe("blocked");
  });

  it("④ 三间都设 2、A 班 6 人 + B 班 3 人：每间 ≤ 2 且 9 人全部有座", () => {
    const job = baseJob(2, [6, 3], 3);
    const result = plan(job);

    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(9);
    const classARooms = Object.entries(perRoomClass(result)).filter(([key]) =>
      key.endsWith("合成班1"),
    );
    expect(classARooms.every(([, count]) => count <= 2)).toBe(true);
    expect(validate(job, result).ok).toBe(true);
    expect(evaluateDelivery(job, result)).not.toBe("blocked");
  });

  it("④ 上限装不下时（7 人 vs 3×2）由聚合口径拦住，不会静默超上限", () => {
    const job = baseJob(2, [7, 2], 3);
    const pre = precheckJob(job);

    expect(pre.fatal).toBe(true);
    const diag = pre.diagnostics.find((item) => item.code === "CLASS_LIMIT_EXCEEDED")!;
    expect(diag).toBeDefined();
    // 新增的可操作提示：逐间写出同班上限
    expect(diag.message).toContain("同班上限 2 人");
    expect(plan(job).entries).toHaveLength(0);
  });

  it("⑤ 聚合口径回归：预检的每间上限逐间可读，且数字形态真的生效", () => {
    const pre = precheckJob(baseJob(2, [4, 2]));
    const relaxed = pre.diagnostics.filter((item) => item.code === "ROOM_SAME_CLASS_RELAXED");
    expect(relaxed).toHaveLength(2);
    expect(relaxed[0]!.message).toContain("同班人数上限 2");

    // `true` = 不限同班人数（不再显示成「上限 = 座位数」那种实现细节）；数字形态才是「同班人数上限 N 人」
    const truePre = precheckJob(baseJob(true, [4, 2]));
    const trueRelaxed = truePre.diagnostics.find(
      (item) => item.code === "ROOM_SAME_CLASS_RELAXED",
    )!;
    expect(trueRelaxed.message).toContain("本考场不限同班人数");
    expect(trueRelaxed.message).not.toContain("同班人数上限");
    const fresh = plan(baseJob(2));
    expect(blocksListExport(fresh.diagnostics)).toBe(false);
  });
});
