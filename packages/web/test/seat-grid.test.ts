import { describe, expect, it } from "vitest";

import {
  ROOM_PRESETS,
  buildSeatGrid,
  businessColOf,
  capacityWarning,
  columnSeatCounts,
  flattenSeatGrid,
  inferRoomKind,
  normalizeExtraFrontSeats,
  physicalColOf,
  planCapacity,
  rcToSeatNoIn,
  roomKindLabel,
  seatRCIn,
} from "@/lib/seat-grid";
import { rcToSeatNo, roomCapacity, seatNoToRC, seatNoToRCIn } from "@exam-seat/core";
import type { RoomSpec } from "@exam-seat/core";

const small: RoomSpec = { id: "R2", name: "第2考场", rows: 6, cols: 5, doorSide: "right" };
const large: RoomSpec = { id: "R1", name: "第1考场", rows: 7, cols: 6, doorSide: "right" };

const matrix = (room: RoomSpec): number[][] =>
  buildSeatGrid(room).cells.map((line) => line.map((cell) => cell.seatNo));

describe("座位网格推导", () => {
  it("小考场（6 排 × 5 列）按物理列序与设计文档 §9 的编号图完全一致", () => {
    expect(matrix(small)).toEqual([
      [25, 24, 13, 12, 1],
      [26, 23, 14, 11, 2],
      [27, 22, 15, 10, 3],
      [28, 21, 16, 9, 4],
      [29, 20, 17, 8, 5],
      [30, 19, 18, 7, 6],
    ]);
  });

  it("大考场（7 排 × 6 列）按物理列序与设计文档 §9 的编号图完全一致", () => {
    expect(matrix(large)).toEqual([
      [42, 29, 28, 15, 14, 1],
      [41, 30, 27, 16, 13, 2],
      [40, 31, 26, 17, 12, 3],
      [39, 32, 25, 18, 11, 4],
      [38, 33, 24, 19, 10, 5],
      [37, 34, 23, 20, 9, 6],
      [36, 35, 22, 21, 8, 7],
    ]);
  });

  it("门在左侧时整张图左右镜像（1 号仍在靠门前角）", () => {
    const grid = buildSeatGrid({ id: "L", rows: 6, cols: 5, doorSide: "left" });
    expect(grid.cells[0]!.map((cell) => cell.seatNo)).toEqual([1, 12, 13, 24, 25]);
  });

  it("每个座位号恰好出现一次，且 seatNo ↔ 行列可以来回换算", () => {
    for (const room of [small, large]) {
      const cells = flattenSeatGrid(buildSeatGrid(room));
      expect(cells).toHaveLength(roomCapacity(room));
      expect(new Set(cells.map((cell) => cell.seatNo)).size).toBe(roomCapacity(room));
      for (const cell of cells) {
        expect(rcToSeatNo(cell.row, cell.col, room.rows, room.cols)).toBe(cell.seatNo);
        expect(seatNoToRC(cell.seatNo, room.rows, room.cols)).toEqual({
          row: cell.row,
          col: cell.col,
        });
      }
      // 物理列 1 在最左；门在右时，业务列 1（靠门列）出现在最右
      const firstRow = buildSeatGrid(room).cells[0]!;
      expect(firstRow[0]!.physicalCol).toBe(1);
      expect(firstRow[room.cols - 1]!.col).toBe(1);
    }
  });

  it("业务列 / 物理列互为左右镜像", () => {
    expect(businessColOf(1, 5, "right")).toBe(5);
    expect(businessColOf(5, 5, "right")).toBe(1);
    expect(businessColOf(2, 5, "left")).toBe(2);
    expect(physicalColOf(1, 6, "right")).toBe(6);
    expect(physicalColOf(3, 6, "left")).toBe(3);
  });
});

describe("非矩形考场：讲台侧加座（docs/design.md §4.5）", () => {
  /** 5 列 × 7 排 + 第 2、4 列各 1 个加座 = 37 座 */
  const extra: RoomSpec = {
    id: "R1",
    name: "第一考场",
    rows: 7,
    cols: 5,
    doorSide: "right",
    extraFrontSeats: [2, 4],
  };

  it("容量 = 排 × 列 + 加座数，逐列座位数 = rows + 该列是否加座", () => {
    expect(roomCapacity(extra)).toBe(37);
    expect(columnSeatCounts(extra)).toEqual([7, 8, 7, 8, 7]);
    expect(columnSeatCounts(small)).toEqual([6, 6, 6, 6, 6]);
  });

  it("座位号与文档示例表逐号一致（15 / 30 是加座，行号 0）", () => {
    expect(seatRCIn(extra, 1)).toEqual({ row: 1, col: 1 });
    expect(seatRCIn(extra, 7)).toEqual({ row: 7, col: 1 });
    expect(seatRCIn(extra, 8)).toEqual({ row: 7, col: 2 });
    expect(seatRCIn(extra, 14)).toEqual({ row: 1, col: 2 });
    expect(seatRCIn(extra, 15)).toEqual({ row: 0, col: 2 });
    expect(seatRCIn(extra, 16)).toEqual({ row: 1, col: 3 });
    expect(seatRCIn(extra, 22)).toEqual({ row: 7, col: 3 });
    expect(seatRCIn(extra, 23)).toEqual({ row: 7, col: 4 });
    expect(seatRCIn(extra, 29)).toEqual({ row: 1, col: 4 });
    expect(seatRCIn(extra, 30)).toEqual({ row: 0, col: 4 });
    expect(seatRCIn(extra, 31)).toEqual({ row: 1, col: 5 });
    expect(seatRCIn(extra, 37)).toEqual({ row: 7, col: 5 });
    // 越界（37 座）返回 null，不会画出第 38 号
    expect(seatRCIn(extra, 38)).toBeNull();
    expect(seatRCIn(extra, 0)).toBeNull();
  });

  it("座位图在网格上方多画一行加座，只有加座列有格子", () => {
    const grid = buildSeatGrid(extra);
    expect(grid.hasExtra).toBe(true);
    // 门在右：物理列 2 = 业务列 4（30 号加座），物理列 4 = 业务列 2（15 号加座）
    expect(grid.frontCells.map((cell) => cell?.seatNo ?? null)).toEqual([null, 30, null, 15, null]);
    expect(flattenSeatGrid(grid)).toHaveLength(37);
    expect(new Set(flattenSeatGrid(grid).map((cell) => cell.seatNo)).size).toBe(37);
    // 每个座位号都与 core 的 seatNoToRCIn 对上，且行列可逆
    for (const cell of flattenSeatGrid(grid)) {
      expect(seatNoToRCIn(extra, cell.seatNo)).toEqual({ row: cell.row, col: cell.col });
      expect(rcToSeatNoIn(extra, cell.row, cell.col)).toBe(cell.seatNo);
    }
  });

  it("纯矩形考场的座位图不变，且没有加座行", () => {
    const grid = buildSeatGrid(large);
    expect(grid.hasExtra).toBe(false);
    expect(grid.frontCells).toEqual([null, null, null, null, null, null]);
    expect(flattenSeatGrid(grid)).toHaveLength(42);
  });

  it("门在左侧时加座行与网格一起左右镜像", () => {
    const grid = buildSeatGrid({ ...extra, doorSide: "left" });
    // 门在左：物理列号 = 业务列号，加座落在物理第 2、4 列
    expect(grid.frontCells.map((cell) => cell?.seatNo ?? null)).toEqual([null, 15, null, 30, null]);
    expect(grid.cells[0]!.map((cell) => cell.seatNo)).toEqual([1, 14, 16, 29, 31]);
  });

  it("加座列越界 / 重复 / 非整数一律收口", () => {
    expect(normalizeExtraFrontSeats({ cols: 5, extraFrontSeats: [4, 2, 4, 9, 0, -1] })).toEqual([
      2, 4,
    ]);
    expect(normalizeExtraFrontSeats({ cols: 5, extraFrontSeats: [] })).toEqual([]);
    expect(normalizeExtraFrontSeats({ cols: 5 })).toEqual([]);
    // 归一化后与 core 的容量口径一致
    const dirty: RoomSpec = { id: "R9", rows: 7, cols: 5, extraFrontSeats: [2, 2, 9] };
    expect(columnSeatCounts(dirty)).toEqual([7, 8, 7, 7, 7]);
    expect(roomCapacity(dirty)).toBe(36);
  });

  it("容量核算把加座算进去", () => {
    const plan = planCapacity([extra, { id: "R2", rows: 7, cols: 5, extraFrontSeats: [2, 4] }], 74);
    expect(plan.totalSeats).toBe(74);
    expect(plan.deficit).toBe(0);
  });
});

describe("考场类型预设", () => {
  it("认得出大 / 小 / 自定义", () => {
    expect(inferRoomKind({ rows: 7, cols: 6 })).toBe("large");
    expect(inferRoomKind({ rows: 7, cols: 5 })).toBe("small");
    expect(inferRoomKind({ rows: 6, cols: 4 })).toBe("custom");
    expect(roomKindLabel({ rows: 6, cols: 5 })).toBe("自定义");
    expect(ROOM_PRESETS.large.rows * ROOM_PRESETS.large.cols).toBe(42);
    expect(ROOM_PRESETS.small.rows * ROOM_PRESETS.small.cols).toBe(35);
  });
});

describe("容量核算", () => {
  const rooms: RoomSpec[] = [
    { id: "R1", name: "第1考场", rows: 7, cols: 6 },
    { id: "R2", name: "第2考场", rows: 7, cols: 6 },
    { id: "R3", name: "第3考场", rows: 7, cols: 6 },
  ];

  it("座位不足时报出缺多少", () => {
    const plan = planCapacity(rooms, 140);
    expect(plan.totalSeats).toBe(126);
    expect(plan.deficit).toBe(14);
    expect(capacityWarning(plan)).toContain("还缺 14 个");
  });

  it("座位充足时按顺序推算哪些考场会空置", () => {
    const plan = planCapacity(rooms, 50);
    expect(plan.deficit).toBe(0);
    expect(plan.spare).toBe(76);
    expect(plan.lastUsedRoomIndex).toBe(1);
    expect(plan.emptyRooms.map((room) => room.id)).toEqual(["R3"]);
    expect(plan.overProvisioned).toBe(true);
    expect(capacityWarning(plan)).toContain("第3考场");
  });

  it("刚好填满时没有空置考场，也没有告警", () => {
    const plan = planCapacity(rooms, 126);
    expect(plan.emptyRooms).toEqual([]);
    expect(plan.overProvisioned).toBe(false);
    expect(capacityWarning(plan)).toBeNull();
  });

  it("没有考生时所有考场都算空置", () => {
    const plan = planCapacity(rooms, 0);
    expect(plan.lastUsedRoomIndex).toBe(-1);
    expect(plan.emptyRooms).toHaveLength(3);
    expect(plan.deficit).toBe(0);
  });
});
