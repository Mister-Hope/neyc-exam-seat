import type { Adjacency, ColRef, DoorSide, RoomSpec, RowRef, SeatId } from "./types";

export interface SeatRC {
  row: number;
  /** 从靠门侧起算，1 = 靠门列 */
  col: number;
}

/** 考场座位总数 */
export function roomCapacity(room: RoomSpec): number {
  return room.rows * room.cols;
}

/**
 * 座位号 → 行列。
 *
 * 1 号在靠门前角；沿本列向后到底，左移一列，从后往前，再左移一列，从前往后，依次蛇形。 因为按「列」推进，第 k 列（0 基）的业务列号就是 k + 1。
 *
 * ⚠️ 返回的 `col` 是**业务列号，从靠门侧起算**（1 = 靠门列）。 设计文档里的编号示意图按**物理列序**画（c1 在最左、门在最右），两者互为左右镜像； 需要物理列号时用
 * {@link toPhysicalCol} 换算。
 */
export function seatNoToRC(seatNo: number, rows: number, cols: number): SeatRC {
  void cols;
  const k = Math.floor((seatNo - 1) / rows);
  const offset = (seatNo - 1) % rows;
  const forward = k % 2 === 0;
  const row = forward ? offset + 1 : rows - offset;
  return { row, col: k + 1 };
}

/** 行列 → 座位号，`seatNoToRC` 的逆运算。 */
export function rcToSeatNo(row: number, col: number, rows: number, cols: number): number {
  void cols;
  const k = col - 1;
  const forward = k % 2 === 0;
  const offset = forward ? row - 1 : rows - row;
  return k * rows + offset + 1;
}

/** 业务列（靠门侧起算）→ 物理列（面对讲台从左往右），仅用于展示。 */
export function toPhysicalCol(col: number, cols: number, doorSide: DoorSide = "right"): number {
  return doorSide === "right" ? cols - col + 1 : col;
}

/** 解析行限定；越界返回 null（表示该考场无法满足）。 */
export function resolveRowRef(room: RoomSpec, ref: RowRef): number | null {
  if (ref === "first") return 1;
  if (ref === "last") return room.rows;
  return Number.isInteger(ref) && ref >= 1 && ref <= room.rows ? ref : null;
}

/** 解析列限定；越界返回 null（表示该考场无法满足）。 */
export function resolveColRef(room: RoomSpec, ref: ColRef): number | null {
  if (ref === "door") return 1;
  if (ref === "window") return room.cols;
  return Number.isInteger(ref) && ref >= 1 && ref <= room.cols ? ref : null;
}

/** 单个考场内、同班学生数的上限。 国王图（8 邻域）的独立数是 ⌈rows/2⌉·⌈cols/2⌉；退化到 4 邻域后是二分图，取 ⌈n/2⌉。 */
export function maxSameClass(room: RoomSpec, adjacency: Adjacency = "king"): number {
  if (adjacency === "orthogonal") return Math.ceil((room.rows * room.cols) / 2);
  return Math.ceil(room.rows / 2) * Math.ceil(room.cols / 2);
}

/** 座位的外部标识：`roomId:seatNo` */
export function seatId(roomId: string, seatNo: number): SeatId {
  return `${roomId}:${seatNo}`;
}

export function parseSeatId(id: SeatId): { roomId: string; seatNo: number } | null {
  const at = id.lastIndexOf(":");
  if (at <= 0) return null;
  const seatNo = Number(id.slice(at + 1));
  if (!Number.isInteger(seatNo) || seatNo < 1) return null;
  return { roomId: id.slice(0, at), seatNo };
}

/** 把行列号渲染成人话，用于诊断与界面提示。 */
export function describeRows(rows: RowRef[] | undefined): string {
  if (!rows || rows.length === 0) return "任意排";
  return rows.map((r) => (r === "first" ? "首排" : r === "last" ? "末排" : `第${r}排`)).join("、");
}

export function describeCols(cols: ColRef[] | undefined): string {
  if (!cols || cols.length === 0) return "任意列";
  return cols
    .map((c) => (c === "door" ? "靠门列" : c === "window" ? "靠窗列" : `第${c}列`))
    .join("、");
}
