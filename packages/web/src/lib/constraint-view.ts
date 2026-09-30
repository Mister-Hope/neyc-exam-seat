import {
  compileConstraintSeats,
  compileModel,
  describeCols,
  describeRows,
  resolveColRef,
  resolveRowRef,
  seatId,
} from "@exam-seat/core";
import type { ColRef, Constraint, RoomSpec, RowRef, SeatId } from "@exam-seat/core";

import { buildSeatGrid } from "./seat-grid";

/**
 * 「限定 → 可用座位集合」的展示层推导（纯函数）。
 *
 * 直接调 core 的 `compileConstraintSeats`，所以界面上看到的座位数就是求解器眼里的座位数，
 * 不存在两套规则。语义值（首排/末排/靠门列/靠窗列）按**每个候选考场自己的行列数**解析。
 */
export interface ConstraintRoomSeats {
  roomId: string;
  roomName: string;
  /** 该考场贡献的可用座位数 */
  seats: number;
  /** 该考场总座位数 */
  capacity: number;
  /** 该考场内可用座位的座位号，按物理列序展示 */
  seatNos: number[];
}

export interface ConstraintSeatView {
  total: number;
  perRoom: ConstraintRoomSeats[];
  /** 因为绝对号越界被整体剔除的考场 */
  droppedRooms: string[];
  /** 用了绝对号但没指定考场 */
  absoluteWithoutRoom: boolean;
  /** 引用不存在的考场 */
  unknownRoomId?: string;
  seatIds: SeatId[];
  /** 人话描述 */
  text: string;
  /** 语义值 / 越界在各类考场里的实际解析说明 */
  hints: string[];
}

export function roomLabel(room: Pick<RoomSpec, "id" | "name">, index: number): string {
  return room.name && room.name.trim().length > 0 ? room.name : `第${index + 1}考场`;
}

/** 下拉选项文案：`第3考场（张老师）`。 */
export function roomOptionLabel(room: RoomSpec, index: number): string {
  const base = roomLabel(room, index);
  const note = room.note?.trim();
  return note ? `${base}（${note}）` : base;
}

export function rowRefLabel(ref: RowRef): string {
  if (ref === "first") return "首排";
  if (ref === "last") return "末排";
  return `第${ref}排`;
}

export function colRefLabel(ref: ColRef): string {
  if (ref === "door") return "靠门列";
  if (ref === "window") return "靠窗列";
  return `第${ref}列`;
}

function distinct(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** 例如「靠窗列 → 5 列考场 = 第5列，6 列考场 = 第6列」。 */
export function semanticRowHint(ref: RowRef, rooms: readonly RoomSpec[]): string {
  if (typeof ref === "number") return `${rowRefLabel(ref)}（绝对排号）`;
  if (rooms.length === 0) return rowRefLabel(ref);
  const dims = distinct(rooms.map((r) => r.rows));
  if (dims.length === 1)
    return `${rowRefLabel(ref)} → 本批考场都是 ${dims[0]} 排，即第${dims[0]}排`;
  const parts = dims.map((dim) => {
    const sample = rooms.find((r) => r.rows === dim)!;
    return `${dim} 排考场 = 第${resolveRowRef(sample, ref) ?? "—"}排`;
  });
  return `${rowRefLabel(ref)} → ${parts.join("，")}`;
}

/** 例如「靠门列 → 第1列（所有考场都一样）」。 */
export function semanticColHint(ref: ColRef, rooms: readonly RoomSpec[]): string {
  if (typeof ref === "number") return `${colRefLabel(ref)}（绝对列号）`;
  if (rooms.length === 0) return colRefLabel(ref);
  const dims = distinct(rooms.map((r) => r.cols));
  if (dims.length === 1) return `${colRefLabel(ref)} → 本批考场都是 ${dims[0]} 列`;
  const parts = dims.map((dim) => {
    const sample = rooms.find((r) => r.cols === dim)!;
    return `${dim} 列考场 = 第${resolveColRef(sample, ref) ?? "—"}列`;
  });
  return `${colRefLabel(ref)} → ${parts.join("，")}`;
}

/** 该考场可填的绝对范围说明。 */
export function absoluteRangeHint(room: RoomSpec): string {
  return `${roomLabel(room, 0).replace(/^第\d+考场$/, "该考场")}：第1–${room.rows}排 × 第1–${room.cols}列`;
}

export function constraintText(constraint: Constraint, rooms: readonly RoomSpec[]): string {
  const index = rooms.findIndex((r) => r.id === constraint.roomId);
  const roomText = constraint.roomId
    ? index === -1
      ? `${constraint.roomId}（不存在）`
      : roomLabel(rooms[index]!, index)
    : "不限考场";
  return `考场：${roomText} ｜ 排：${describeRows(constraint.rows)} ｜ 列：${describeCols(constraint.cols)}`;
}

/** 编译一条限定能看到的所有座位信息。 */
export function viewConstraintSeats(
  rooms: readonly RoomSpec[],
  constraint: Constraint,
): ConstraintSeatView {
  const model = compileModel({ students: [], rooms: [...rooms] });
  const set = compileConstraintSeats(model, constraint);

  const seatNos = new Map<number, number[]>();
  const seatIds: SeatId[] = [];
  for (const seat of set.seats) {
    const roomIndex = model.seatRoom[seat]!;
    const no = model.seatNo[seat]!;
    const list = seatNos.get(roomIndex) ?? [];
    list.push(no);
    seatNos.set(roomIndex, list);
    seatIds.push(seatId(model.rooms[roomIndex]!.spec.id, no));
  }

  const perRoom: ConstraintRoomSeats[] = model.rooms.map((room) => {
    const nos = (seatNos.get(room.index) ?? []).sort((a, b) => a - b);
    return {
      roomId: room.spec.id,
      roomName: room.spec.name ?? room.spec.id,
      seats: nos.length,
      capacity: room.capacity,
      seatNos: nos,
    };
  });
  seatIds.sort((a, b) => {
    const ra = model.rooms.findIndex((r) => r.spec.id === a.slice(0, a.lastIndexOf(":")));
    const rb = model.rooms.findIndex((r) => r.spec.id === b.slice(0, b.lastIndexOf(":")));
    if (ra !== rb) return ra - rb;
    return Number(a.slice(a.lastIndexOf(":") + 1)) - Number(b.slice(b.lastIndexOf(":") + 1));
  });

  const hints: string[] = [];
  for (const ref of constraint.rows ?? []) hints.push(semanticRowHint(ref, rooms));
  for (const ref of constraint.cols ?? []) hints.push(semanticColHint(ref, rooms));

  return {
    total: set.seats.size,
    perRoom,
    droppedRooms: set.droppedRooms,
    absoluteWithoutRoom: set.absoluteWithoutRoom,
    unknownRoomId: set.unknownRoomId,
    seatIds,
    text: constraintText(constraint, rooms),
    hints,
  };
}

/** 在网格上标出「这条限定允许哪些座位」。 返回 `row → Set(physicalCol)`（按物理列序，所见即所得）。 */
export function allowedCellsOnGrid(room: RoomSpec, allowedSeatNos: readonly number[]): Set<string> {
  const allowed = new Set(allowedSeatNos);
  const out = new Set<string>();
  for (const cell of buildSeatGrid(room).cells.flat()) {
    if (allowed.has(cell.seatNo)) out.add(`${cell.row}:${cell.physicalCol}`);
  }
  return out;
}

// 保持既有公共 API：这个模块一直对外透出 core 的 roomCapacity
export { roomCapacity } from "@exam-seat/core";
