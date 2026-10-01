import {
  columnSeatCounts as coreColumnSeatCounts,
  rcToSeatNo as coreRcToSeatNo,
  roomCapacity,
  seatNoToRCIn as coreSeatNoToRCIn,
} from "@exam-seat/core";
import type { DoorSide, RoomGeometry, RoomSpec } from "@exam-seat/core";

/**
 * 座位网格的数据推导（纯函数，无 DOM）。
 *
 * 关键约定（与 core 对齐，别搞反）：
 *
 * - 业务列号 `col` 从**靠门侧**起算，1 = 靠门列；座位号 seatNo 也按这个方向蛇形编号。
 * - 物理列号 `physicalCol` 是**面对讲台从左往右**数的列，只用于界面/打印。
 * - 门默认在右侧（`doorSide: 'right'`），此时 physicalCol = cols - col + 1。
 *
 * 这里的唯一职责就是：把 seatNoToRC / rcToSeatNo 的结果摆成老师一眼能看懂的网格。
 */
export interface SeatCell {
  seatNo: number;
  /** 从讲台起算，1 = 首排 */
  row: number;
  /** 从靠门侧起算，1 = 靠门列（业务列号） */
  col: number;
  /** 面对讲台从左往右，1 = 最左列 */
  physicalCol: number;
}

/** 结果预览里每个座位上的考生信息。 */
export interface SeatOccupant {
  studentId?: string;
  name: string;
  className: string;
}

export interface RoomSeatGrid {
  room: RoomSpec;
  rows: number;
  cols: number;
  doorSide: DoorSide;
  /** `cells[row - 1][physicalCol - 1]` */
  cells: SeatCell[][];
  /**
   * 讲台侧加座（行号 0，第 1 排之前），按物理列序；没有加座的列是 `null`。
   *
   * 只有 `extraFrontSeats` 指向的业务列才有格子，其余列留空占位，网格才不会错位。
   */
  frontCells: (SeatCell | null)[];
  /** 这个考场有加座（`extraFrontSeats` 非空且有效） */
  hasExtra: boolean;
}

/** 物理列号 → 业务列号（靠门侧起算）。 */
export function businessColOf(physicalCol: number, cols: number, doorSide: DoorSide): number {
  return doorSide === "right" ? cols - physicalCol + 1 : physicalCol;
}

/** 业务列号 → 物理列号（面对讲台从左往右）。 */
export function physicalColOf(col: number, cols: number, doorSide: DoorSide): number {
  return businessColOf(col, cols, doorSide);
}

/* ------------------------------------------------------------------ */
/* 非矩形考场（讲台侧加座）的几何                                       */
/* ------------------------------------------------------------------ */

/**
 * 有效加座列：整数、在 `1..cols` 内、去重、升序。
 *
 * 界面（多选列）与导入的 job 都可能给出越界值（例如 cols 从 5 改成 4），这里统一收口， 保证容量、编号、座位图三者用的是同一份加座集合。
 */
export function normalizeExtraFrontSeats(
  room: Pick<RoomSpec, "cols" | "extraFrontSeats">,
): number[] {
  const raw = room.extraFrontSeats;
  if (!raw || raw.length === 0) return [];
  const seen = new Set<number>();
  for (const col of raw) {
    if (Number.isInteger(col) && col >= 1 && col <= room.cols) seen.add(col);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * 每列的座位数（业务列序）：`rows + 该列是否加座`。
 *
 * 直接委托 core 的 `columnSeatCounts`，网页不再自己算一遍几何。
 */
export function columnSeatCounts(room: RoomGeometry): number[] {
  return coreColumnSeatCounts(room.rows, room.cols, normalizeExtraFrontSeats(room));
}

/**
 * 座位号 → 行列（按列蛇形，支持加座）；越界返回 `null`。
 *
 * 委托 core 的 `seatNoToRCIn`（docs/design.md §4.5：加座永远是本列最后一个号，行号记 `0`）； 这里只补一个越界保护，座位图不会因为脏数据画出第 0
 * 号格子。
 */
export function seatRCIn(room: RoomGeometry, seatNo: number): { row: number; col: number } | null {
  const total = columnSeatCounts(room).reduce((sum, count) => sum + count, 0);
  if (!Number.isInteger(seatNo) || seatNo < 1 || seatNo > total) return null;
  return coreSeatNoToRCIn(room, seatNo);
}

/** 行列 → 座位号（`seatRCIn` 的逆运算）；`row = 0` 表示加座，越界/该列没加座返回 `null`。委托 core 的 `rcToSeatNo`。 */
export function rcToSeatNoIn(room: RoomGeometry, row: number, col: number): number | null {
  const seatNo = coreRcToSeatNo(row, col, room.rows, room.cols, normalizeExtraFrontSeats(room));
  return seatNo < 1 ? null : seatNo;
}

/** 按物理列序展开整个考场，`cells[row-1][physicalCol-1]`；加座在 `frontCells[physicalCol-1]`。所见即所得。 */
export function buildSeatGrid(room: RoomSpec): RoomSeatGrid {
  const doorSide: DoorSide = room.doorSide ?? "right";
  const cells: SeatCell[][] = [];
  for (let row = 1; row <= room.rows; row += 1) {
    const line: SeatCell[] = [];
    for (let physicalCol = 1; physicalCol <= room.cols; physicalCol += 1) {
      const col = businessColOf(physicalCol, room.cols, doorSide);
      line.push({
        seatNo: rcToSeatNoIn(room, row, col) ?? 0,
        row,
        col,
        physicalCol,
      });
    }
    cells.push(line);
  }

  const frontCells: (SeatCell | null)[] = [];
  for (let physicalCol = 1; physicalCol <= room.cols; physicalCol += 1) {
    const col = businessColOf(physicalCol, room.cols, doorSide);
    const seatNo = rcToSeatNoIn(room, 0, col);
    frontCells.push(seatNo == null ? null : { seatNo, row: 0, col, physicalCol });
  }

  return {
    room,
    rows: room.rows,
    cols: room.cols,
    doorSide,
    cells,
    frontCells,
    hasExtra: frontCells.some((cell) => cell != null),
  };
}

/** 网格里所有座位按「加座 → 排 → 物理列」展开成一维。 */
export function flattenSeatGrid(grid: RoomSeatGrid): SeatCell[] {
  return [
    ...grid.frontCells.filter((cell): cell is SeatCell => cell != null),
    ...grid.cells.flat(),
  ];
}

/** 排 × 列，纯位置占位（用于结果预览里叠加人名）。 */
export function emptySeatGrid(rows: number, cols: number): (SeatCell | null)[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
}

/* ------------------------------------------------------------------ */
/* 考场类型预设                                                        */
/* ------------------------------------------------------------------ */

export type RoomKind = "large" | "small" | "custom";

/** 大考场 = 6 列 × 7 排 = 42；小考场 = 5 列 × 6 排 = 30。 */
export const ROOM_PRESETS: Record<
  "large" | "small",
  { rows: number; cols: number; label: string }
> = {
  large: { rows: 7, cols: 6, label: "大（6 列 × 7 排 = 42）" },
  small: { rows: 6, cols: 5, label: "小（5 列 × 6 排 = 30）" },
};

export function inferRoomKind(room: Pick<RoomSpec, "rows" | "cols">): RoomKind {
  if (room.rows === ROOM_PRESETS.large.rows && room.cols === ROOM_PRESETS.large.cols)
    return "large";
  if (room.rows === ROOM_PRESETS.small.rows && room.cols === ROOM_PRESETS.small.cols)
    return "small";
  return "custom";
}

export function roomKindLabel(room: Pick<RoomSpec, "rows" | "cols">): string {
  const kind = inferRoomKind(room);
  if (kind === "large") return "大";
  if (kind === "small") return "小";
  return "自定义";
}

/* ------------------------------------------------------------------ */
/* 容量核算                                                            */
/* ------------------------------------------------------------------ */

export interface CapacityPlan {
  /** 全部考场座位合计 */
  totalSeats: number;
  /** 实际参考人数 */
  participants: number;
  /** 还缺多少座位（0 = 够） */
  deficit: number;
  /** 多出多少座位 */
  spare: number;
  /** 按顺序填满后，最后一个会用到的考场下标；-1 表示没有考场 */
  lastUsedRoomIndex: number;
  /** 预计完全空置的考场 */
  emptyRooms: RoomSpec[];
  /** 座位明显过剩（多出的座位 ≥ 半数容量） */
  overProvisioned: boolean;
}

/** 按「依次填满考场」的既定策略推算容量与空置情况。 */
export function planCapacity(rooms: readonly RoomSpec[], participants: number): CapacityPlan {
  let totalSeats = 0;
  let cumulative = 0;
  let lastUsedRoomIndex = -1;
  for (let i = 0; i < rooms.length; i += 1) {
    const capacity = roomCapacity(rooms[i]!);
    totalSeats += capacity;
    cumulative += capacity;
    if (lastUsedRoomIndex < 0 && participants > 0 && cumulative >= participants)
      lastUsedRoomIndex = i;
  }
  const spare = Math.max(0, totalSeats - participants);
  const emptyRooms = participants > 0 ? rooms.slice(lastUsedRoomIndex + 1) : [...rooms];
  return {
    totalSeats,
    participants,
    deficit: Math.max(0, participants - totalSeats),
    spare,
    lastUsedRoomIndex,
    emptyRooms,
    overProvisioned: totalSeats > 0 && spare * 2 >= totalSeats,
  };
}

/** 容量告警文案，直接展示给老师；没有问题时返回 null。 */
export function capacityWarning(plan: CapacityPlan): string | null {
  if (plan.deficit > 0) {
    return `座位不够：${plan.participants} 人要考，只有 ${plan.totalSeats} 个座位，还缺 ${plan.deficit} 个`;
  }
  if (plan.emptyRooms.length > 0 && plan.overProvisioned) {
    const names = plan.emptyRooms.map((r) => r.name ?? r.id).join("、");
    return `座位比考生多 ${plan.spare} 个：${names} 会整场空置，可以少配几个考场`;
  }
  return null;
}
