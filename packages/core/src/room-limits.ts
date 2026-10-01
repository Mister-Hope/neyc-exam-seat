import type { RoomSpec } from "./types";

/**
 * 考场尺寸的**硬上限** —— 一条 DoS 防线，必须在任何「按行列分配内存」的代码之前生效。
 *
 * 依据（真实用量 vs 安全余量）：
 *
 * - 真实考场最多几十列、几百座：本仓库 `examples/acceptance.mjs` 是 38 个考场 / 990 人（每间 30 座）， 大礼堂式考场 30 × 40 = 1200 座；
 * - **单边 1000**：比真实值大一个数量级；
 * - **单间 10000 座**（≈ 100 × 100）：比真实最大值大两个数量级，同时把单间内存钉在几百 KB（`Int32Array` 网格 + 邻接表）；
 * - **全考场 100000 座**：够覆盖超大型考点，又把总内存钉在几十 MB。
 *
 * 为什么必须有：`job.json` 可以由 AI 直接生成（项目 skill 就是这么用的），`rows: 999999` 这种 「多写了几个零」会让 `compileModel` 按
 * `rows × cols` 分配网格与邻接表 → 进程 OOM （CLI `exit -6` / 浏览器标签页直接崩，没有任何诊断）。
 */
export const MAX_ROOM_SIDE = 1000;
export const MAX_ROOM_SEATS = 10_000;
export const MAX_TOTAL_SEATS = 100_000;

/** 考场网格座位数（`rows × cols`；加座的数量受 `cols` 限制，量级可忽略） */
export function roomGridSeats(room: RoomSpec): number {
  const rows = Number.isFinite(room.rows) ? Math.max(0, Math.floor(room.rows)) : 0;
  const cols = Number.isFinite(room.cols) ? Math.max(0, Math.floor(room.cols)) : 0;
  return rows * cols;
}

/**
 * 尺寸是否超过上限；`undefined` = 正常。
 *
 * 返回的是**人话原因**（供诊断拼装）：真实老师看到「999999 × 5 = 4999995 座，超过单考场上限 10000 座」 就知道自己多打了几个零。
 */
export function oversizeReason(room: RoomSpec): string | undefined {
  const rows = room.rows;
  const cols = room.cols;
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) {
    // 尺寸本身非法由既有校验负责，这里不抢
    return undefined;
  }
  if (rows > MAX_ROOM_SIDE || cols > MAX_ROOM_SIDE) {
    return `${rows} 排 × ${cols} 列，单边超过上限 ${MAX_ROOM_SIDE}（请检查是否多写了几个零）`;
  }
  const seats = rows * cols;
  if (seats > MAX_ROOM_SEATS) {
    return `${rows} 排 × ${cols} 列 = ${seats} 座，超过单考场上限 ${MAX_ROOM_SEATS} 座（请检查是否多写了几个零）`;
  }
  return undefined;
}

/** 这个考场能不能安全地分配网格（尺寸合法且不超上限） */
export function isAllocatableRoom(room: RoomSpec): boolean {
  return (
    Number.isInteger(room.rows) &&
    Number.isInteger(room.cols) &&
    room.rows >= 1 &&
    room.cols >= 1 &&
    oversizeReason(room) === undefined
  );
}

/** 全部考场的网格座位总数（用于总上限校验） */
export function totalGridSeats(rooms: readonly RoomSpec[]): number {
  let total = 0;
  for (const room of rooms) total += roomGridSeats(room);
  return total;
}
