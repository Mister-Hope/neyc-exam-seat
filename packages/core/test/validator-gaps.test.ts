import { describe, expect, it } from "vitest";

import {
  blocksListExport,
  evaluateDelivery,
  evaluateDeliveryAll,
  plan,
  planAll,
  roomCapacity,
  seatNoToRCIn,
  validate,
  validateAll,
} from "../src/index";
import type { Job, PlanAllResult, PlanResult, RoomSpec } from "../src/index";

/** 7 排 × 5 列 + 第 2 列加座：加座是 15 号（行 0 列 2），正前方 14 号（第 1 排第 2 列） */
function extraRoom(): RoomSpec {
  return { id: "R1", name: "第一考场", rows: 7, cols: 5, extraFrontSeats: [2] };
}

/** 找到加座座位号（行号 0） */
function extraSeatNo(room: RoomSpec): number {
  for (let seatNo = 1; seatNo <= roomCapacity(room); seatNo += 1) {
    if (seatNoToRCIn(room, seatNo).row === 0) return seatNo;
  }
  throw new Error("这个考场没有加座");
}

function twoStudentJob(extra: RoomSpec, constraint?: Job["constraints"]): Job {
  return {
    jobVersion: 2,
    students: [
      { id: "A0", name: "甲", className: "合成班1" },
      { id: "A1", name: "乙", className: "合成班2" },
    ],
    rooms: [extra],
    ...(constraint ? { constraints: constraint } : {}),
  };
}

/** 把某位学生挪到指定座位（行/列按蛇形规则重算，保证 ENTRY_* 自洽） */
function moveTo(result: PlanResult, room: RoomSpec, studentId: string, seatNo: number): PlanResult {
  const clone = JSON.parse(JSON.stringify(result)) as PlanResult;
  const rc = seatNoToRCIn(room, seatNo);
  const entry = clone.entries.find((item) => item.studentId === studentId)!;
  const occupied = clone.entries.find(
    (item) => item !== entry && item.roomId === room.id && item.seatNo === seatNo,
  );
  if (occupied) {
    occupied.seatNo = entry.seatNo;
    occupied.row = entry.row;
    occupied.col = entry.col;
  }
  entry.roomId = room.id;
  entry.roomName = room.name ?? room.id;
  entry.seatNo = seatNo;
  entry.row = rc.row;
  entry.col = rc.col;
  return clone;
}

function multiJob(): Job {
  const students: Job["students"] = [];
  const combos: [string, string[]][] = [
    ["物化生", ["physics", "chemistry", "biology"]],
    ["政史地", ["politics", "history", "geography"]],
  ];
  combos.forEach(([combination, subjects], cls) => {
    for (let i = 0; i < 6; i += 1) {
      students.push({
        id: `${combination}-${i}`,
        name: `n${cls}${i}`,
        className: `C${cls}`,
        combination,
        subjects: [...subjects],
      });
    }
  });
  return {
    jobVersion: 2,
    students,
    rooms: [
      { id: "R1", name: "第一考场", rows: 6, cols: 5 },
      { id: "R2", name: "第二考场", rows: 6, cols: 5 },
    ],
  };
}
const cloneAll = (result: PlanAllResult): PlanAllResult =>
  JSON.parse(JSON.stringify(result)) as PlanAllResult;

describe("加座（行号 0）必须参与语义检查（task-58）", () => {
  it("① 受限学生坐在加座上 → CONSTRAINT_UNMET（修复前是静默放行）", () => {
    const room = extraRoom();
    const base = plan(twoStudentJob(room));
    const atExtra = moveTo(base, room, "A0", extraSeatNo(room));
    const job = twoStudentJob(room, [{ id: "C1", studentIds: ["A0"], rows: ["first"] }]);

    const report = validate(job, atExtra);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "CONSTRAINT_UNMET")).toBe(true);
    // ⚠️ 注意：`CONSTRAINT_UNMET` 在 task-51 里是「可降级」码（为了保住 strict 模式的 exit 2 契约），
    // 所以这里 delivery 仍是 ready-with-warnings；真正要的是「校验器不再隐身」（上面两条断言）。
    // lead 已把这个 open question 留到 task-59 一并拍板：若改成 strict 失败即 blocked，这里改成 "blocked"。
    expect(evaluateDelivery(job, atExtra)).not.toBe("ready");
  });

  it("② 加座与正前方座位同班相邻 → ADJACENCY_CONFLICT", () => {
    const room = extraRoom();
    const job: Job = {
      jobVersion: 2,
      students: [
        { id: "A0", name: "甲", className: "合成班1" },
        { id: "A1", name: "乙", className: "合成班1" },
      ],
      rooms: [room],
    };
    const base = plan(job);
    const extra = extraSeatNo(room);
    const front = extra - 1; // 同列第 1 排
    expect(seatNoToRCIn(room, front)).toEqual({ row: 1, col: 2 });

    let tampered = moveTo(base, room, "A0", extra);
    tampered = moveTo(tampered, room, "A1", front);
    const report = validate(job, tampered);

    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "ADJACENCY_CONFLICT")).toBe(true);
  });

  it("③ 加座生正常就座（无限定、不同班）→ 不误报", () => {
    const room = extraRoom();
    const job = twoStudentJob(room);
    const base = plan(job);
    const okResult = moveTo(base, room, "A0", extraSeatNo(room));

    const report = validate(job, okResult);
    expect(report.ok).toBe(true);
    expect(report.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });
});

describe("validateAll 收紧：清空 / 删一科 / 非法时段都要拦住（task-58）", () => {
  it("④-1 清空某生 slots → ENTRY_MISSING_STUDENT + blocked", () => {
    const job = multiJob();
    const tampered = cloneAll(planAll(job));
    const victim = tampered.byStudent[0]!;
    victim.slots = {};
    victim.rooms = [];
    victim.distinctRooms = 0;

    const report = validateAll(job, tampered);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "ENTRY_MISSING_STUDENT")).toBe(true);
    expect(evaluateDeliveryAll(job, tampered)).toBe("blocked");
  });

  it("④-2 slots 全部置 null → ENTRY_MISSING_STUDENT + blocked", () => {
    const job = multiJob();
    const tampered = cloneAll(planAll(job));
    const victim = tampered.byStudent[1]!;
    for (const key of Object.keys(victim.slots)) victim.slots[key] = null;

    const report = validateAll(job, tampered);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "ENTRY_MISSING_STUDENT")).toBe(true);
    expect(evaluateDeliveryAll(job, tampered)).toBe("blocked");
  });

  it("④-3 删掉某生一个时段 → ENTRY_MISSING_SLOT（座位方案里还有他）+ blocked", () => {
    const job = multiJob();
    const tampered = cloneAll(planAll(job));
    const victim = tampered.byStudent[2]!;
    const slotId = Object.keys(victim.slots)[0]!;
    victim.slots = Object.fromEntries(
      Object.entries(victim.slots).filter(([key]) => key !== slotId),
    );

    const report = validateAll(job, tampered);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "ENTRY_MISSING_SLOT")).toBe(true);
    expect(evaluateDeliveryAll(job, tampered)).toBe("blocked");
  });

  it("④-4 塞一个不存在的时段 → ENTRY_UNKNOWN_SLOT + blocked", () => {
    const job = multiJob();
    const tampered = cloneAll(planAll(job));
    const victim = tampered.byStudent[3]!;
    const slotId = Object.keys(victim.slots)[0]!;
    victim.slots["T99-不存在"] = { ...victim.slots[slotId]! };

    const report = validateAll(job, tampered);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "ENTRY_UNKNOWN_SLOT")).toBe(true);
    expect(evaluateDeliveryAll(job, tampered)).toBe("blocked");
  });

  it("合法结果不受影响（不误报）+ delivery 联动", () => {
    const job = multiJob();
    const valid = planAll(job);

    expect(validateAll(job, valid).ok).toBe(true);
    expect(evaluateDeliveryAll(job, valid)).toBe(valid.delivery);
    expect(blocksListExport(valid.diagnostics)).toBe(false);
    // 篡改后的结果必须靠 evaluateDeliveryAll 复算才拦得住（delivery 字段是旧的）
    const tampered = cloneAll(valid);
    tampered.byStudent[0]!.slots = {};
    expect(evaluateDeliveryAll(job, tampered)).toBe("blocked");
  });
});
