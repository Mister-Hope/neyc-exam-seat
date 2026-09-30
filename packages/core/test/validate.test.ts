import { describe, expect, it } from "vitest";

import { plan, rcToSeatNo, seatNoToRC, validate } from "../src/index";
import type { Job, PlanEntry, PlanResult, RoomSpec } from "../src/index";

function job(): Job {
  const students = [];
  for (let c = 1; c <= 18; c += 1) {
    for (let i = 1; i <= 2; i += 1) {
      students.push({ id: `S${c}-${i}`, name: `n${c}${i}`, className: `C${c}` });
    }
  }
  const rooms: RoomSpec[] = [
    { id: "R1", name: "第1考场", rows: 6, cols: 5 },
    { id: "R2", name: "第2考场", rows: 6, cols: 5 },
  ];
  return { students, rooms };
}

function clone(result: PlanResult): PlanResult {
  return JSON.parse(JSON.stringify(result)) as PlanResult;
}

/** 交换两个人的座位信息，保证「每个学生恰好出现一次」不被破坏 */
function swapSeats(a: PlanEntry, b: PlanEntry): void {
  const swap = <K extends keyof PlanEntry>(key: K): void => {
    const tmp = a[key];
    a[key] = b[key];
    b[key] = tmp;
  };
  swap("roomId");
  swap("roomName");
  swap("seatNo");
  swap("row");
  swap("col");
  swap("physicalCol");
}

/** 找一个与 entry 相邻的另一个座位号 */
function neighborSeatNo(j: Job, entry: PlanEntry): number {
  const room = j.rooms.find((r) => r.id === entry.roomId)!;
  const rc = seatNoToRC(entry.seatNo, room.rows, room.cols);
  const target =
    rc.col < room.cols
      ? { row: rc.row, col: rc.col + 1 }
      : { row: rc.row, col: Math.max(1, rc.col - 1) };
  return rcToSeatNo(target.row, target.col, room.rows, room.cols);
}

describe("独立校验器", () => {
  it("求解器自己的结果一定通过校验", () => {
    const j = job();
    const result = plan(j);
    expect(result.ok).toBe(true);
    const report = validate(j, result);
    expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("抓出「两个同班学生被挪成相邻」", () => {
    const j = job();
    const result = clone(plan(j));
    const a = result.entries[0]!;
    const seatNo = neighborSeatNo(j, a);
    const occupant = result.entries.find((e) => e.roomId === a.roomId && e.seatNo === seatNo);
    const sameClass = result.entries.find(
      (e) => e.className === a.className && e.studentId !== a.studentId,
    );
    expect(occupant).toBeDefined();
    expect(sameClass).toBeDefined();
    swapSeats(occupant!, sameClass!);

    const report = validate(j, result);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "ADJACENCY_CONFLICT")).toBe(true);
  });

  it("抓出「同一个座位安排了两个人」", () => {
    const j = job();
    const result = clone(plan(j));
    const a = result.entries[0]!;
    const b = result.entries.find((e) => e.studentId !== a.studentId)!;
    b.roomId = a.roomId;
    b.roomName = a.roomName;
    b.seatNo = a.seatNo;
    b.row = a.row;
    b.col = a.col;
    b.physicalCol = a.physicalCol;
    const report = validate(j, result);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "ENTRY_DUPLICATE_SEAT")).toBe(true);
  });

  it("抓出「有人没被安排」", () => {
    const j = job();
    const result = clone(plan(j));
    result.entries.pop();
    const report = validate(j, result);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "ENTRY_MISSING_STUDENT")).toBe(true);
  });

  it("抓出「座位号与蛇形编号对不上」", () => {
    const j = job();
    const result = clone(plan(j));
    const e = result.entries[0]!;
    e.row = e.row === 1 ? 2 : 1;
    const report = validate(j, result);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "ENTRY_NUMBERING_MISMATCH")).toBe(true);
  });

  it("抓出「限定没被满足」", () => {
    const j = job();
    // 只允许坐第 1 考场最后一排靠窗列
    j.constraints = [
      {
        id: "C1",
        note: "角落",
        studentIds: ["S1-1"],
        roomId: "R1",
        rows: ["last"],
        cols: ["window"],
      },
    ];
    const result = clone(plan(j));
    const target = result.entries.find((e) => e.studentId === "S1-1")!;
    expect(target.row).toBe(6);
    expect(target.col).toBe(5);

    // 把它挪到同考场另一个座位（连带把占位的人换过去，保持人数守恒）
    const other = result.entries.find(
      (e) => e.roomId === "R1" && e.seatNo !== target.seatNo && e.studentId !== target.studentId,
    )!;
    swapSeats(target, other);

    const report = validate(j, result);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "CONSTRAINT_UNMET")).toBe(true);
  });

  it("抓出「安排了不参加考试的学生」", () => {
    const j = job();
    const excluded = j.students[0]!;
    excluded.included = false;
    const result = clone(plan(j));
    // 手动把被排除的学生顶替掉某个正常学生
    result.entries[0]!.studentId = excluded.id;
    const report = validate(j, result);
    expect(report.ok).toBe(false);
  });
});
