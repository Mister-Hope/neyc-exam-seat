import { describe, expect, it } from "vitest";

import {
  absoluteRangeHint,
  allowedCellsOnGrid,
  colRefLabel,
  constraintText,
  roomOptionLabel,
  rowRefLabel,
  semanticColHint,
  semanticRowHint,
  viewConstraintSeats,
} from "@/lib/constraint-view";
import type { Constraint, RoomSpec } from "@exam-seat/core";

/** 一大一小两个考场：语义值就是为这种混排而存在的。 */
const rooms: RoomSpec[] = [
  { id: "R1", name: "第1考场", rows: 7, cols: 6, doorSide: "right", note: "张老师" },
  { id: "R2", name: "第2考场", rows: 6, cols: 5, doorSide: "right", note: "李老师" },
];

const constraint = (patch: Partial<Constraint>): Constraint => ({
  id: "C1",
  studentIds: [],
  ...patch,
});

describe("限定 → 可用座位集合（与 core 的编译结果同源）", () => {
  it("不指定考场时，`末排` 按每个考场自己的排数解析", () => {
    const view = viewConstraintSeats(rooms, constraint({ rows: ["last"] }));
    // 大考场 7 排 → 第 7 排 6 个座；小考场 6 排 → 第 6 排 5 个座
    expect(view.total).toBe(11);
    expect(view.perRoom.map((room) => room.seats)).toEqual([6, 5]);
    expect(view.droppedRooms).toEqual([]);
  });

  it("`靠窗列` 同样按每个考场自己的列数解析", () => {
    const view = viewConstraintSeats(rooms, constraint({ cols: ["window"] }));
    // 6 列考场：7 个座；5 列考场：6 个座
    expect(view.total).toBe(13);
  });

  it("四角预设（首+末 排 × 靠门+靠窗 列）在大小考场里都是 4 个角落", () => {
    const view = viewConstraintSeats(
      rooms,
      constraint({ rows: ["first", "last"], cols: ["door", "window"] }),
    );
    expect(view.total).toBe(8);
    expect(view.perRoom.map((room) => room.seats)).toEqual([4, 4]);
    expect(view.hints).toHaveLength(4);
  });

  it("指定考场后写绝对号：含义确定，越界就剔除该考场", () => {
    const outOfRange = viewConstraintSeats(rooms, constraint({ roomId: "R2", rows: [7] }));
    expect(outOfRange.total).toBe(0);
    expect(outOfRange.droppedRooms).toEqual(["R2"]);

    const ok = viewConstraintSeats(rooms, constraint({ roomId: "R1", rows: [3] }));
    expect(ok.total).toBe(6);
    expect(ok.perRoom.find((room) => room.roomId === "R1")?.seats).toBe(6);

    // 第 6 列在 5 列考场不存在，但在 6 列考场存在
    const onlyLarge = viewConstraintSeats(rooms, constraint({ cols: [6] }));
    expect(onlyLarge.droppedRooms).toEqual(["R2"]);
    expect(onlyLarge.total).toBe(7);
    expect(onlyLarge.absoluteWithoutRoom).toBe(true);
  });

  it("单座位限定给出精确的座位号，能直接画在网格上", () => {
    const view = viewConstraintSeats(rooms, constraint({ roomId: "R2", rows: [6], cols: [1] }));
    expect(view.seatIds).toEqual(["R2:6"]);
    const smallRoom = view.perRoom.find((room) => room.roomId === "R2")!;
    expect(smallRoom.seatNos).toEqual([6]);
    const highlighted = allowedCellsOnGrid(rooms[1]!, smallRoom.seatNos);
    // 小考场第 6 排靠门列 → 物理列 5（门在右侧）
    expect([...highlighted]).toEqual(["6:5"]);
  });

  it("引用不存在的考场时给出 unknownRoomId，不抛异常", () => {
    const view = viewConstraintSeats(rooms, constraint({ roomId: "R9" }));
    expect(view.unknownRoomId).toBe("R9");
    expect(view.total).toBe(0);
  });
});

describe("人话渲染", () => {
  it("下拉文案带上监考老师", () => {
    expect(roomOptionLabel(rooms[0]!, 0)).toBe("第1考场（张老师）");
    expect(roomOptionLabel({ id: "R3", rows: 6, cols: 5 }, 2)).toBe("第3考场");
  });

  it("语义值在各类考场里的实际解析写清楚", () => {
    expect(semanticRowHint("last", rooms)).toBe("末排 → 6 排考场 = 第6排，7 排考场 = 第7排");
    expect(semanticColHint("window", rooms)).toBe("靠窗列 → 5 列考场 = 第5列，6 列考场 = 第6列");
    expect(semanticColHint("door", rooms)).toBe("靠门列 → 5 列考场 = 第1列，6 列考场 = 第1列");
    expect(semanticRowHint(3, rooms)).toBe("第3排（绝对排号）");
    expect(semanticRowHint("first", [])).toBe("首排");
  });

  it("单个尺寸时直接说结果", () => {
    expect(semanticRowHint("last", [rooms[0]!])).toBe("末排 → 本批考场都是 7 排，即第7排");
  });

  it("规则摘要与取值范围提示", () => {
    expect(constraintText(constraint({ roomId: "R1", rows: ["first"] }), rooms)).toBe(
      "考场：第1考场 ｜ 排：首排 ｜ 列：任意列",
    );
    expect(constraintText(constraint({}), rooms)).toBe(
      "考场：不限考场 ｜ 排：任意排 ｜ 列：任意列",
    );
    expect(absoluteRangeHint(rooms[1]!)).toContain("第1–6排 × 第1–5列");
    expect(rowRefLabel("first")).toBe("首排");
    expect(rowRefLabel(2)).toBe("第2排");
    expect(colRefLabel("door")).toBe("靠门列");
    expect(colRefLabel(3)).toBe("第3列");
  });
});
