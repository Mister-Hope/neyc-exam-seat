import { describe, expect, it } from "vitest";

import { compileModel, maxSameClass, rcToSeatNo, roomCapacity, seatNoToRC } from "../src/index";
import type { Adjacency, CompiledModel, CompiledRoom, Job, RoomSpec } from "../src/index";
import { columnSeatCounts, seatNoToRCIn } from "../src/numbering";

/** §4.5 的 37 座规格：5 列 × 7 排 + 第 2、4 列讲台侧各 1 座。 */
const RECT_37: RoomSpec = {
  id: "R37",
  name: "非矩形考场",
  rows: 7,
  cols: 5,
  extraFrontSeats: [2, 4],
};

const RECT_SMALL: RoomSpec = { id: "RS", name: "小考场", rows: 6, cols: 5, doorSide: "right" };
const RECT_LARGE: RoomSpec = { id: "RL", name: "大考场", rows: 7, cols: 6, doorSide: "right" };

/**
 * 设计文档 §4.5 的逐号编号表（业务列序；第 1 列 = 靠门列）。
 *
 * `[seatNo, row, col]`，`row = 0` 表示讲台侧加座。
 */
const TABLE_37: readonly (readonly [number, number, number])[] = [
  [1, 1, 1],
  [2, 2, 1],
  [3, 3, 1],
  [4, 4, 1],
  [5, 5, 1],
  [6, 6, 1],
  [7, 7, 1],
  [8, 7, 2],
  [9, 6, 2],
  [10, 5, 2],
  [11, 4, 2],
  [12, 3, 2],
  [13, 2, 2],
  [14, 1, 2],
  [15, 0, 2],
  [16, 1, 3],
  [17, 2, 3],
  [18, 3, 3],
  [19, 4, 3],
  [20, 5, 3],
  [21, 6, 3],
  [22, 7, 3],
  [23, 7, 4],
  [24, 6, 4],
  [25, 5, 4],
  [26, 4, 4],
  [27, 3, 4],
  [28, 2, 4],
  [29, 1, 4],
  [30, 0, 4],
  [31, 1, 5],
  [32, 2, 5],
  [33, 3, 5],
  [34, 4, 5],
  [35, 5, 5],
  [36, 6, 5],
  [37, 7, 5],
];

const KING_OFFSETS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];
const ORTH_OFFSETS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [0, -1],
  [0, 1],
  [1, 0],
];

function makeJob(rooms: RoomSpec[]): Job {
  return { jobVersion: 2, students: [], rooms, constraints: [] };
}

/** 座位图里 `(row, col)` 的全局座位下标；`row = 0` = 加座。 */
function seatAt(room: CompiledRoom, row: number, col: number): number {
  if (row === 0) return room.extraSeat[col - 1]!;
  return room.grid[(row - 1) * room.spec.cols + (col - 1)]!;
}

function neighborsOf(model: CompiledModel, seat: number): number[] {
  const out: number[] = [];
  for (let k = model.neighborStart[seat]!; k < model.neighborStart[seat + 1]!; k += 1) {
    out.push(model.neighborList[k]!);
  }
  return out;
}

/**
 * 旧实现的逐字复制（纯矩形参照物），用来证明新实现在无加座时**逐元素一致**。
 *
 * 只用于测试，不参与生产代码。
 */
function legacyRoom(spec: RoomSpec, adjacency: Adjacency) {
  const { rows, cols } = spec;
  const capacity = rows * cols;
  const grid = new Int32Array(rows * cols).fill(-1);
  const seatNo = new Int32Array(capacity);
  const seatRow = new Int32Array(capacity);
  const seatCol = new Int32Array(capacity);
  for (let n = 1; n <= capacity; n += 1) {
    const k = Math.floor((n - 1) / rows);
    const offset = (n - 1) % rows;
    const forward = k % 2 === 0;
    const row = forward ? offset + 1 : rows - offset;
    grid[(row - 1) * cols + k] = n - 1;
    seatNo[n - 1] = n;
    seatRow[n - 1] = row;
    seatCol[n - 1] = k + 1;
  }
  const offsets = adjacency === "orthogonal" ? ORTH_OFFSETS : KING_OFFSETS;
  const neighborStart = new Int32Array(capacity + 1);
  const ordered: number[] = [];
  for (let s = 0; s < capacity; s += 1) {
    neighborStart[s] = ordered.length;
    const row = seatRow[s]!;
    const col = seatCol[s]!;
    for (const [dr, dc] of offsets) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr < 1 || nr > rows || nc < 1 || nc > cols) continue;
      ordered.push(grid[(nr - 1) * cols + (nc - 1)]!);
    }
  }
  neighborStart[capacity] = ordered.length;
  return {
    capacity,
    grid,
    seatNo,
    seatRow,
    seatCol,
    neighborStart,
    neighborList: Int32Array.from(ordered),
    maxSameClass:
      adjacency === "orthogonal"
        ? Math.ceil(capacity / 2)
        : Math.ceil(rows / 2) * Math.ceil(cols / 2),
  };
}

/** 独立的暴力最大独立集，用来交叉验证 `maxSameClass` 的精确算法。 */
function bruteForceMaxIndependentSet(spec: RoomSpec, adjacency: Adjacency): number {
  const seats: { row: number; col: number }[] = [];
  const extra = new Set<number>(spec.extraFrontSeats);
  for (let col = 1; col <= spec.cols; col += 1) if (extra.has(col)) seats.push({ row: 0, col });
  for (let row = 1; row <= spec.rows; row += 1) {
    for (let col = 1; col <= spec.cols; col += 1) seats.push({ row, col });
  }
  const offsets = adjacency === "orthogonal" ? ORTH_OFFSETS : KING_OFFSETS;
  const bit = new Map<string, number>();
  seats.forEach((s, i) => {
    bit.set(`${s.row}:${s.col}`, i);
  });
  const forbidden: number[] = seats.map((s) => {
    let mask = 1 << bit.get(`${s.row}:${s.col}`)!;
    for (const [dr, dc] of offsets) {
      const key = `${s.row + dr}:${s.col + dc}`;
      const j = bit.get(key);
      if (j !== undefined) mask |= 1 << j;
    }
    return mask;
  });
  let best = 0;
  for (let subset = 0; subset < 1 << seats.length; subset += 1) {
    let size = 0;
    let ok = true;
    for (let i = 0; i < seats.length && ok; i += 1) {
      if (!(subset & (1 << i))) continue;
      size += 1;
      if ((subset & forbidden[i]!) !== 1 << i) ok = false;
    }
    if (ok && size > best) best = size;
  }
  return best;
}

describe("§4.5 非矩形考场编号（7 排 × 5 列 + [2,4] = 37 座）", () => {
  it("roomCapacity = rows*cols + 加座数", () => {
    expect(roomCapacity(RECT_37)).toBe(37);
    expect(roomCapacity(RECT_SMALL)).toBe(30);
    expect(roomCapacity({ id: "R", rows: 7, cols: 5 })).toBe(35);
    expect(roomCapacity({ id: "R", rows: 7, cols: 5, extraFrontSeats: [] })).toBe(35);
  });

  it("columnSeatCounts 每列 = rows + 是否加座", () => {
    expect(columnSeatCounts(7, 5, [2, 4])).toEqual([7, 8, 7, 8, 7]);
    expect(columnSeatCounts(7, 5, [])).toEqual([7, 7, 7, 7, 7]);
    expect(columnSeatCounts(7, 5)).toEqual([7, 7, 7, 7, 7]);
    // 越界列被忽略、重复列只算一次
    expect(columnSeatCounts(6, 5, [2, 2, 0, 6])).toEqual([6, 7, 6, 6, 6]);
  });

  it("seatNoToRC 逐号核对 §4.5 的编号表", () => {
    for (const [seatNo, row, col] of TABLE_37) {
      expect(seatNoToRC(seatNo, 7, 5, [2, 4]), `seat ${seatNo}`).toEqual({ row, col });
    }
  });

  it("设计文档的物理列图与业务列互为镜像", () => {
    // §4.5.1 的图（物理列 c1..c5，门在右）：31 29 16 14 1 等。
    const physical = [
      [31, 29, 16, 14, 1],
      [32, 28, 17, 13, 2],
      [33, 27, 18, 12, 3],
      [34, 26, 19, 11, 4],
      [35, 25, 20, 10, 5],
      [36, 24, 21, 9, 6],
      [37, 23, 22, 8, 7],
    ];
    for (let row = 1; row <= 7; row += 1) {
      for (let physicalCol = 1; physicalCol <= 5; physicalCol += 1) {
        const businessCol = 6 - physicalCol;
        expect(rcToSeatNo(row, businessCol, 7, 5, [2, 4]), `r${row}c${physicalCol}`).toBe(
          physical[row - 1]![physicalCol - 1],
        );
      }
    }
    expect(rcToSeatNo(0, 4, 7, 5, [2, 4])).toBe(30); // 物理 c2
    expect(rcToSeatNo(0, 2, 7, 5, [2, 4])).toBe(15); // 物理 c4
  });

  it("seatNoToRC 与 rcToSeatNo 互为逆运算（含加座）", () => {
    for (let seatNo = 1; seatNo <= 37; seatNo += 1) {
      const rc = seatNoToRC(seatNo, 7, 5, [2, 4]);
      expect(rcToSeatNo(rc.row, rc.col, 7, 5, [2, 4]), `seat ${seatNo}`).toBe(seatNo);
    }
    for (let row = 0; row <= 7; row += 1) {
      for (let col = 1; col <= 5; col += 1) {
        const seatNo = rcToSeatNo(row, col, 7, 5, [2, 4]);
        if (seatNo === -1) continue;
        expect(seatNoToRC(seatNo, 7, 5, [2, 4])).toEqual({ row, col });
      }
    }
  });

  it("row=0 只对真有加座的列有效，其余返回 -1", () => {
    expect(rcToSeatNo(0, 2, 7, 5, [2, 4])).toBe(15);
    expect(rcToSeatNo(0, 4, 7, 5, [2, 4])).toBe(30);
    expect(rcToSeatNo(0, 1, 7, 5, [2, 4])).toBe(-1);
    expect(rcToSeatNo(0, 3, 7, 5, [2, 4])).toBe(-1);
    expect(rcToSeatNo(0, 5, 7, 5, [2, 4])).toBe(-1);
    expect(rcToSeatNo(0, 2, 7, 5)).toBe(-1);
    expect(rcToSeatNo(8, 2, 7, 5, [2, 4])).toBe(-1);
    expect(rcToSeatNo(1, 6, 7, 5, [2, 4])).toBe(-1);
  });

  it("seatNoToRCIn 直接吃 RoomSpec 或最小几何字面量", () => {
    expect(seatNoToRCIn(RECT_37, 15)).toEqual({ row: 0, col: 2 });
    expect(seatNoToRCIn({ rows: 7, cols: 5, extraFrontSeats: [2, 4] }, 30)).toEqual({
      row: 0,
      col: 4,
    });
    expect(seatNoToRCIn({ rows: 6, cols: 5 }, 7)).toEqual({ row: 6, col: 2 });
  });
});

describe("maxSameClass 按真实座位图算", () => {
  it("37 座基准：king 12 / orthogonal 20", () => {
    expect(maxSameClass(RECT_37, "king")).toBe(12);
    expect(maxSameClass(RECT_37, "orthogonal")).toBe(20);
  });

  it("其余基准：7×5 = 35 → king 12 / orth 18；7×6 = 42 → king 12 / orth 21", () => {
    expect(maxSameClass({ id: "R", rows: 7, cols: 5 }, "king")).toBe(12);
    expect(maxSameClass({ id: "R", rows: 7, cols: 5 }, "orthogonal")).toBe(18);
    expect(maxSameClass({ id: "R", rows: 7, cols: 6 }, "king")).toBe(12);
    expect(maxSameClass({ id: "R", rows: 7, cols: 6 }, "orthogonal")).toBe(21);
  });

  it("纯矩形结果与旧闭式公式逐值一致", () => {
    for (let rows = 1; rows <= 9; rows += 1) {
      for (let cols = 1; cols <= 9; cols += 1) {
        const spec: RoomSpec = { id: "R", rows, cols };
        expect(maxSameClass(spec, "king"), `${rows}×${cols} king`).toBe(
          Math.ceil(rows / 2) * Math.ceil(cols / 2),
        );
        expect(maxSameClass(spec, "orthogonal"), `${rows}×${cols} orth`).toBe(
          Math.ceil((rows * cols) / 2),
        );
      }
    }
  });

  it("小规模非矩形与暴力最大独立集一致", () => {
    const shapes: RoomSpec[] = [
      { id: "A", rows: 3, cols: 3, extraFrontSeats: [2] },
      { id: "B", rows: 4, cols: 3, extraFrontSeats: [1, 3] },
      { id: "C", rows: 2, cols: 4, extraFrontSeats: [2, 4] },
      { id: "D", rows: 5, cols: 2, extraFrontSeats: [1, 2] },
      { id: "E", rows: 3, cols: 3, extraFrontSeats: [1] },
      { id: "F", rows: 4, cols: 4, extraFrontSeats: [2, 4] },
    ];
    for (const spec of shapes) {
      for (const adjacency of ["king", "orthogonal"] as const) {
        expect(maxSameClass(spec, adjacency), `${spec.id} ${adjacency}`).toBe(
          bruteForceMaxIndependentSet(spec, adjacency),
        );
      }
    }
  });
});

describe("compileModel 的非矩形几何", () => {
  const model = compileModel(makeJob([RECT_37]), "king");
  const room = model.rooms[0]!;

  it("容量 / 座位数 / 座位表元数据", () => {
    expect(model.seatCount).toBe(37);
    expect(room.capacity).toBe(37);
    expect(room.seatCount).toBe(37);
    expect(room.extraCols).toEqual([2, 4]);
    expect([...room.extraSeat]).toEqual([-1, 14, -1, 29, -1]);
    expect(room.maxSameClass).toBe(12);
    expect(room.relaxedSameClass).toBe(false);
    // grid 语义不变：只含第 1..rows 排，(row-1)*cols+(col-1) → 全局下标
    expect(room.grid).toHaveLength(35);
    for (const [seatNo, row, col] of TABLE_37) {
      if (row === 0) continue;
      expect(room.grid[(row - 1) * 5 + (col - 1)], `seat ${seatNo}`).toBe(seatNo - 1);
    }
  });

  it("seatNo / seatRow / seatCol 覆盖加座且 seatRow = 0", () => {
    expect(model.seatRow[14]).toBe(0);
    expect(model.seatCol[14]).toBe(2);
    expect(model.seatNo[14]).toBe(15);
    expect(model.seatRow[29]).toBe(0);
    expect(model.seatCol[29]).toBe(4);
    expect(model.seatNo[29]).toBe(30);
    const extras = [...model.seatRow].filter((row) => row === 0);
    expect(extras).toHaveLength(2);
  });

  it("8 邻域：加座 (0,2) 只与第 1 排的 1/2/3 列相邻", () => {
    const extra = seatAt(room, 0, 2);
    expect(extra).toBe(14);
    expect(new Set(neighborsOf(model, extra))).toEqual(
      new Set([seatAt(room, 1, 1), seatAt(room, 1, 2), seatAt(room, 1, 3)]),
    );
    expect(neighborsOf(model, extra)).not.toContain(seatAt(room, 1, 4));
    expect(neighborsOf(model, extra)).not.toContain(seatAt(room, 0, 4));
    // 对称
    for (const col of [1, 2, 3]) {
      expect(neighborsOf(model, seatAt(room, 1, col))).toContain(extra);
    }
    expect(neighborsOf(model, seatAt(room, 1, 4))).not.toContain(extra);
  });

  it("两个加座之间不相邻（第 2、4 列中间隔着第 3 列）", () => {
    const a = seatAt(room, 0, 2);
    const b = seatAt(room, 0, 4);
    expect(neighborsOf(model, a)).not.toContain(b);
    expect(neighborsOf(model, b)).not.toContain(a);
  });

  it("4 邻域：加座 (0,2) 只与 (1,2) 相邻", () => {
    const orth = compileModel(makeJob([RECT_37]), "orthogonal");
    const orthRoom = orth.rooms[0]!;
    const extra = seatAt(orthRoom, 0, 2);
    expect(neighborsOf(orth, extra)).toEqual([seatAt(orthRoom, 1, 2)]);
    expect(neighborsOf(orth, extra)).not.toContain(seatAt(orthRoom, 0, 4));
    expect(neighborsOf(orth, seatAt(orthRoom, 1, 2))).toContain(extra);
  });

  it("relaxSameClass 编译成 relaxedSameClass 布尔（冻结公式：非 undefined 且非 false）", () => {
    const cases: [RoomSpec["relaxSameClass"], boolean][] = [
      [undefined, false],
      [false, false],
      [true, true],
      [3, true],
      // 冻结契约按 `!== undefined && !== false` 判定：0 也是「设过数字上限」= true
      [0, true],
    ];
    for (const [value, expected] of cases) {
      const spec: RoomSpec = { id: "R", rows: 2, cols: 2, relaxSameClass: value };
      expect(compileModel(makeJob([spec])).rooms[0]!.relaxedSameClass).toBe(expected);
    }
  });
});

describe("纯矩形向后兼容（逐元素对照旧实现）", () => {
  const legacyCases = [RECT_SMALL, RECT_LARGE, { id: "R75", rows: 7, cols: 5 } as RoomSpec].flatMap(
    (spec) => (["king", "orthogonal"] as const).map((adjacency) => ({ spec, adjacency })),
  );

  it.each(legacyCases)(
    "$spec.rows×$spec.cols $adjacency 与旧实现完全一致",
    ({ spec, adjacency }) => {
      const legacy = legacyRoom(spec, adjacency);
      const model = compileModel(makeJob([spec]), adjacency);
      const room = model.rooms[0]!;
      expect(room.capacity).toBe(legacy.capacity);
      expect(model.seatCount).toBe(legacy.capacity);
      expect([...room.grid]).toEqual([...legacy.grid]);
      expect([...room.extraSeat]).toEqual(Array.from({ length: spec.cols }, () => -1));
      expect(room.extraCols).toEqual([]);
      expect(room.relaxedSameClass).toBe(false);
      expect([...model.seatNo]).toEqual([...legacy.seatNo]);
      expect([...model.seatRow]).toEqual([...legacy.seatRow]);
      expect([...model.seatCol]).toEqual([...legacy.seatCol]);
      expect([...model.neighborStart]).toEqual([...legacy.neighborStart]);
      expect([...model.neighborList]).toEqual([...legacy.neighborList]);
      expect(room.maxSameClass).toBe(legacy.maxSameClass);
    },
  );

  it("编号与容量在无加座时与旧实现逐位一致", () => {
    for (const spec of [RECT_SMALL, RECT_LARGE]) {
      for (let seatNo = 1; seatNo <= spec.rows * spec.cols; seatNo += 1) {
        const expected = legacyRoom(spec, "king");
        const row = expected.seatRow[seatNo - 1]!;
        const col = expected.seatCol[seatNo - 1]!;
        expect(seatNoToRC(seatNo, spec.rows, spec.cols), `seat ${seatNo}`).toEqual({ row, col });
        expect(seatNoToRC(seatNo, spec.rows, spec.cols, []), `seat ${seatNo}`).toEqual({
          row,
          col,
        });
        expect(rcToSeatNo(row, col, spec.rows, spec.cols)).toBe(seatNo);
        expect(rcToSeatNo(row, col, spec.rows, spec.cols, [])).toBe(seatNo);
      }
    }
  });
});
