import type { Adjacency, ColRef, DoorSide, RoomSpec, RowRef, SeatId } from "./types";

export interface SeatRC {
  row: number;
  /** 从靠门侧起算，1 = 靠门列 */
  col: number;
}

/**
 * 计算座位几何所需的最小考场信息（`RoomSpec` 结构上兼容）。
 *
 * 单独抽出来是为了让 io / web 等调用方可以只传 `{ rows, cols, extraFrontSeats }` 字面量， 不必伪造 `id`。
 */
export interface RoomGeometry {
  rows: number;
  cols: number;
  /** 讲台一侧的加座所在业务列，见 {@link RoomSpec.extraFrontSeats} */
  extraFrontSeats?: number[];
}

/**
 * 归一化加座列：只保留 `[1, cols]` 内的整数并升序去重。
 *
 * 非法输入（越界列、重复列、非整数）在这里被静默丢弃，保证下面所有几何函数彼此自洽。
 */
function normalizeExtraSeats(cols: number, extraFrontSeats?: number[]): number[] {
  if (!extraFrontSeats || extraFrontSeats.length === 0) return [];
  const seen = new Set<number>();
  for (const col of extraFrontSeats) {
    if (Number.isInteger(col) && col >= 1 && col <= cols) seen.add(col);
  }
  return [...seen].sort((a, b) => a - b);
}

/** 考场座位总数：矩形部分 + 讲台侧加座（加座列与几何函数用同一套归一化规则，非法列不计）。 */
export function roomCapacity(room: RoomSpec): number {
  return room.rows * room.cols + normalizeExtraSeats(room.cols, room.extraFrontSeats).length;
}

/**
 * 每个业务列的座位数（下标 0 = 第 1 业务列）。
 *
 * 纯矩形时每一项都等于 `rows`；有加座的列等于 `rows + 1`（加座永远是该列最后一个号）。
 */
export function columnSeatCounts(rows: number, cols: number, extraFrontSeats?: number[]): number[] {
  const extra = new Set(normalizeExtraSeats(cols, extraFrontSeats));
  const counts: number[] = [];
  for (let col = 1; col <= cols; col += 1) counts.push(rows + (extra.has(col) ? 1 : 0));
  return counts;
}

/** 列座位数的前缀和：`prefix[k]` = 前 k 个业务列的座位数之和（0 基，长度 `cols + 1`）。 */
function columnPrefix(rows: number, cols: number, extraFrontSeats?: number[]): number[] {
  const prefix = [0];
  for (const n of columnSeatCounts(rows, cols, extraFrontSeats))
    prefix.push(prefix[prefix.length - 1]! + n);
  return prefix;
}

/**
 * 座位号 → 行列。
 *
 * 1 号在靠门前角；沿本列向后到底，左移一列，从后往前，再左移一列，从前往后，依次蛇形。 因为按「列」推进，第 k 列（0 基）的业务列号就是 k + 1。
 *
 * ⚠️ 返回的 `col` 是**业务列号，从靠门侧起算**（1 = 靠门列）。 设计文档里的编号示意图按**物理列序**画（c1 在最左、门在最右），两者互为左右镜像； 需要物理列号时用
 * {@link toPhysicalCol} 换算。
 *
 * 带 `extraFrontSeats` 时每列的座位数不再相同（第 k 列 = `rows + 该列是否有加座`）：
 * 列内顺序不变（奇数列从前排往后排、偶数列从后排往前排），加座永远排在该列**最后**一个号， 返回的行号为 `0`（第 1 排之前，即讲台侧）。`extraFrontSeats`
 * 缺省或为空时与纯矩形实现逐位一致。
 *
 * 座位号越界时不做校验，沿用旧实现的均分公式（调用方应保证 `1 <= seatNo <= roomCapacity`）。
 */
export function seatNoToRC(
  seatNo: number,
  rows: number,
  cols: number,
  extraFrontSeats?: number[],
): SeatRC {
  if (!extraFrontSeats || extraFrontSeats.length === 0) {
    const k = Math.floor((seatNo - 1) / rows);
    const offset = (seatNo - 1) % rows;
    const forward = k % 2 === 0;
    const row = forward ? offset + 1 : rows - offset;
    return { row, col: k + 1 };
  }
  const counts = columnSeatCounts(rows, cols, extraFrontSeats);
  let base = 0;
  for (let k = 0; k < counts.length; k += 1) {
    const n = counts[k]!;
    if (seatNo <= base + n) {
      const offset = seatNo - base; // 1..n
      if (offset > rows) return { row: 0, col: k + 1 };
      const forward = k % 2 === 0;
      return { row: forward ? offset : rows - offset + 1, col: k + 1 };
    }
    base += n;
  }
  // 越界：与纯矩形分支同样不做校验，保持旧行为
  const k = Math.floor((seatNo - 1) / rows);
  const offset = (seatNo - 1) % rows;
  return { row: k % 2 === 0 ? offset + 1 : rows - offset, col: k + 1 };
}

/** {@link seatNoToRC} 的便捷版：直接吃考场（或 `{ rows, cols, extraFrontSeats }`）。 */
export function seatNoToRCIn(room: RoomGeometry, seatNo: number): SeatRC {
  return seatNoToRC(seatNo, room.rows, room.cols, room.extraFrontSeats);
}

/**
 * 行列 → 座位号，`seatNoToRC` 的逆运算。
 *
 * `row === 0` 表示该列的**加座**：该列有加座时返回它的座位号（= 该列最后一个号）， 没有加座时返回 `-1`。`row` 不在 `[1, rows]`、`col` 不在 `[1,
 * cols]` 时同样返回 `-1`。 `extraFrontSeats` 缺省或为空时，`row ∈ [1, rows]` 与旧实现逐位一致。
 */
export function rcToSeatNo(
  row: number,
  col: number,
  rows: number,
  cols: number,
  extraFrontSeats?: number[],
): number {
  if (row === 0 && (!extraFrontSeats || extraFrontSeats.length === 0)) return -1;
  if (!extraFrontSeats || extraFrontSeats.length === 0) {
    const k = col - 1;
    const forward = k % 2 === 0;
    const offset = forward ? row - 1 : rows - row;
    return k * rows + offset + 1;
  }
  if (!Number.isInteger(col) || col < 1 || col > cols) return -1;
  const counts = columnSeatCounts(rows, cols, extraFrontSeats);
  const n = counts[col - 1]!;
  const base = columnPrefix(rows, cols, extraFrontSeats)[col - 1]!;
  if (row === 0) return n > rows ? base + n : -1;
  if (!Number.isInteger(row) || row < 1 || row > rows) return -1;
  const forward = (col - 1) % 2 === 0;
  return base + (forward ? row : rows - row + 1);
}

/** 业务列（靠门侧起算）→ 物理列（面对讲台从左往右），仅用于展示。 */
export function toPhysicalCol(col: number, cols: number, doorSide: DoorSide = "right"): number {
  return doorSide === "right" ? cols - col + 1 : col;
}

/** 解析行限定；越界返回 null（表示该考场无法满足）。加座（第 0 排）不可被行限定点到。 */
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

function popcount(mask: number): number {
  let count = 0;
  let m = mask;
  while (m !== 0) {
    m &= m - 1;
    count += 1;
  }
  return count;
}

/**
 * 4 邻域的座位图是二分图（按 `row + col` 奇偶染色），最大独立集 = 点数 - 最大匹配（König 定理）。
 *
 * 加座与同列第 1 排相邻（这是加座在 4 邻域下唯一的边）。
 */
function orthogonalMaxIndependentSet(rows: number, cols: number, extraCols: number[]): number {
  const key = (row: number, col: number): number => row * (cols + 1) + col;
  const nodes: { row: number; col: number }[] = [];
  const index = new Map<number, number>();
  const add = (row: number, col: number): void => {
    index.set(key(row, col), nodes.length);
    nodes.push({ row, col });
  };
  for (const col of extraCols) add(0, col);
  for (let row = 1; row <= rows; row += 1) {
    for (let col = 1; col <= cols; col += 1) add(row, col);
  }
  const offsets: readonly (readonly [number, number])[] = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  const adj: number[][] = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i += 1) {
    const { row, col } = nodes[i]!;
    for (const [dr, dc] of offsets) {
      const j = index.get(key(row + dr, col + dc));
      if (j !== undefined) adj[i]!.push(j);
    }
  }

  const matchOf = new Int32Array(nodes.length).fill(-1);
  const tryAugment = (u: number, seen: Uint8Array): boolean => {
    for (const v of adj[u]!) {
      if (seen[v] === 1) continue;
      seen[v] = 1;
      if (matchOf[v] === -1 || tryAugment(matchOf[v]!, seen)) {
        matchOf[v] = u;
        return true;
      }
    }
    return false;
  };

  let matched = 0;
  for (let u = 0; u < nodes.length; u += 1) {
    const { row, col } = nodes[u]!;
    if ((row + col) % 2 !== 0) continue; // 只从一侧出发做增广
    if (tryAugment(u, new Uint8Array(nodes.length))) matched += 1;
  }
  return nodes.length - matched;
}

/**
 * 轮廓线 DP 允许的最大位宽。
 *
 * DP 是 `O(width · 2^width)`：本机实测 20×20（width 20）约 0.4s、24×24（width 24）约 8.8s， 而且 `1 << width` 在
 * width ≥ 31 时按 32 位取模会溢出（30×40 直接抛 `RangeError`）。
 * 超过这个宽度就退回闭式解（对纯矩形是精确值，带加座时是**保守下界**）：宁可少算也不能算错或卡死。
 */
const MAX_DP_WIDTH = 20;

/**
 * 国王图（8 邻域）的精确最大独立集（非攻击国王问题的「带洞」一般化）。
 *
 * 座位图仍是一个 `rows+1` 行 × `cols` 列的网格：第 1..rows 排满座，第 0 排只有加座。 逐行做轮廓线 DP（bitmask
 * 记录上一排选中了哪些座位），转移时用「子集最大值」变换 (SOS) 把 `2^width` 的枚举压到 `width · 2^width`。为了控制位宽，列数比 `rows + 1`
 * 大时把网格转置后再做（国王图对转置不变）。
 *
 * 无加座时直接返回闭式解 `⌈rows/2⌉·⌈cols/2⌉`（与 DP 逐值一致，见 `docs/design.md` §4.5）； 位宽超过 {@link MAX_DP_WIDTH}
 * 时同样退回闭式解（不抛异常、不误算）。
 */
function kingMaxIndependentSet(rows: number, cols: number, extraCols: number[]): number {
  if (extraCols.length === 0 || Math.min(cols, rows + 1) > MAX_DP_WIDTH) {
    // 加座只会增加节点，不可能让最大独立集变小 → 纯矩形闭式解是带加座时的下界
    return Math.ceil(rows / 2) * Math.ceil(cols / 2);
  }
  if (cols <= rows + 1) {
    let extraMask = 0;
    for (const col of extraCols) extraMask |= 1 << (col - 1);
    const allowed = [extraMask];
    const full = (1 << cols) - 1;
    for (let row = 1; row <= rows; row += 1) allowed.push(full);
    return kingProfileMaxIndependentSet(allowed, cols);
  }
  // 转置：轮廓线 = 业务列，宽度 = rows + 1；位置 0 = 加座排，位置 1..rows = 第 1..rows 排
  const extra = new Set(extraCols);
  const full = (1 << (rows + 1)) - 1;
  const withoutExtraRow = full & ~1;
  const allowed: number[] = [];
  for (let col = 1; col <= cols; col += 1) allowed.push(extra.has(col) ? full : withoutExtraRow);
  return kingProfileMaxIndependentSet(allowed, rows + 1);
}

/** 逐线轮廓线 DP：`allowed[i]` = 第 i 条线上存在的座位位图，`width` = 每条线的位数。 */
function kingProfileMaxIndependentSet(allowed: number[], width: number): number {
  const size = 1 << width;
  let prev = new Int32Array(size).fill(-1);
  const first = allowed[0] ?? 0;
  // 第 0 条线：没有任何上一条线，内部只需满足「左右不相邻」
  for (let mask = first; ; mask = (mask - 1) & first) {
    if ((mask & (mask << 1)) === 0) prev[mask] = popcount(mask);
    if (mask === 0) break;
  }
  for (let i = 1; i < allowed.length; i += 1) {
    // best[m] = max{ prev[p] : p ⊆ m }，一次 SOS 变换即可查询全部合法上一条线
    const best = prev.slice();
    for (let bit = 0; bit < width; bit += 1) {
      const flag = 1 << bit;
      for (let mask = 0; mask < size; mask += 1) {
        if (mask & flag) {
          const candidate = best[mask ^ flag]!;
          if (candidate > best[mask]!) best[mask] = candidate;
        }
      }
    }
    const cur = new Int32Array(size).fill(-1);
    const line = allowed[i]!;
    const prevLine = allowed[i - 1]!;
    for (let mask = line; ; mask = (mask - 1) & line) {
      if ((mask & (mask << 1)) === 0) {
        // 上下两排的国王不能落在彼此的相邻列（含正上方与两个斜上方）
        const banned = (mask | (mask << 1) | (mask >> 1)) & (size - 1);
        const above = best[prevLine & ~banned]!;
        if (above >= 0) cur[mask] = above + popcount(mask);
      }
      if (mask === 0) break;
    }
    prev = cur;
  }
  let answer = 0;
  for (let mask = 0; mask < size; mask += 1) if (prev[mask]! > answer) answer = prev[mask]!;
  return answer;
}

/**
 * 单个考场内、同班学生数的上限 = 真实座位图的最大独立集。
 *
 * 4 邻域（orthogonal）时图是二分图，用 König 定理精确求；8 邻域（king）时按实际图形状做轮廓线 DP。 纯矩形（无加座）直接返回闭式解，与 DP 逐值一致：4 邻域 =
 * `⌈rows·cols / 2⌉`，8 邻域 = `⌈rows/2⌉ · ⌈cols/2⌉`。
 *
 * 加座会改变图的形状：37 座（7×5 + 第 2、4 列加座）的 4 邻域上限是 **20**（不是设计文档 §4.5 写的 19—— 加座落在二分图的另一侧，两侧为 20 /
 * 17，最大匹配只能到 17）。加座 + 位宽超过 {@link MAX_DP_WIDTH} 时退回闭式解（保守下界，绝不抛异常）。
 *
 * 本函数**不抛异常**（铁律 3）：大考场（30×40 / 40×40 / 100×100）与非法尺寸都必须安全返回。
 */
export function maxSameClass(room: RoomSpec, adjacency: Adjacency = "king"): number {
  const rows = Math.max(0, Math.floor(room.rows));
  const cols = Math.max(0, Math.floor(room.cols));
  if (rows === 0 || cols === 0) return 0;
  const extraCols = normalizeExtraSeats(cols, room.extraFrontSeats);
  if (adjacency === "orthogonal") {
    // 二分图：纯矩形闭式解精确，加座才需要跑匹配
    if (extraCols.length === 0) return Math.ceil((rows * cols) / 2);
    return orthogonalMaxIndependentSet(rows, cols, extraCols);
  }
  return kingMaxIndependentSet(rows, cols, extraCols);
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
