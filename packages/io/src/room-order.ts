/**
 * 考场名的「第 N 考场」序号解析与自然排序。
 *
 * 求解器给出的 `seatings` 顺序是**分配顺序**（被限定钉住的考场、专用考场会排在最前）， 直接拿来出 sheet 会得到「第十七、第十八、第一、第二…」这种反直觉顺序。 展示 /
 * 导出层统一用这里的中文数字解析 + 稳定排序再排一遍；**不改 `plan.json` 里 seatings 的顺序**。
 *
 * 为什么放 io 不放 core：`core/src/index.ts` 的 utils 是具名导出清单，新增工具函数要动那个清单 （不在本任务写权限内）；这里零依赖、随时可以整体搬去 core。
 */

/** 中文数字字符 → 数值 */
const CHINESE_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 中文数位 → 数值（不支持「万」以上，考场号到不了） */
const CHINESE_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** 全角数字 → 半角。 */
function toHalfWidthDigits(text: string): string {
  return text.replaceAll(/[０-９]/g, (char) =>
    String.fromCodePoint((char.codePointAt(0) ?? 0) - 0xfe_e0),
  );
}

/**
 * 中文数字 / 阿拉伯数字 → `number`；**解析不出返回 `undefined`，不抛异常**。
 *
 * 支持：`一`…`十`、`十一`…`十九`、`二十`…`九十九`、`一百`、`一百零一`、`一百二十三`， `两` / `〇` / 全角数字，以及纯阿拉伯数字（`12`、`017`）。
 * 连续数字（`一七`）、重复或逆序数位（`十十`）、夹杂别的字（`十七考场`）都算解析不出。
 */
export function chineseNumberToArabic(text: string): number | undefined {
  const value = toHalfWidthDigits(text.trim());
  if (value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value);

  let total = 0;
  let current = 0;
  let lastUnit = Number.POSITIVE_INFINITY;
  let sawAny = false;

  for (const char of value) {
    const digit = CHINESE_DIGITS[char];
    if (digit !== undefined) {
      if (current !== 0) return undefined; // 「一七」这种连写不是合法数字
      current = digit;
      sawAny = true;
      continue;
    }
    const unit = CHINESE_UNITS[char];
    if (unit === undefined) return undefined;
    if (unit >= lastUnit) return undefined; // 「十十」这种重复数位 / 逆序数位
    total += (current === 0 ? 1 : current) * unit; // 「十五」= 15
    current = 0;
    lastUnit = unit;
    sawAny = true;
  }

  return sawAny ? total + current : undefined;
}

/**
 * 考场名的排序键：取「第」与「考场」之间的数字，例如 `第十七考场 （语史政数英地）` → `17`、`第一考场` → `1`、`第12考场` → `12`。
 *
 * 名字为空时退回 `id`；解析不出返回 `undefined`（由调用方排到最后）。
 */
export function roomOrderKey(room: { id: string; name?: string }): number | undefined {
  const named = (room.name ?? "").trim();
  const name = named === "" ? room.id : named;
  const match = /第\s*(?<number>.+?)\s*考场/.exec(name);
  return match ? chineseNumberToArabic(match.groups?.number ?? "") : undefined;
}

/** 考场序号比较器：解析不出的排最后；两边都解析不出返回 `0`（交给稳定排序保持原相对顺序）。 */
export function compareRoomOrder(
  a: { id: string; name?: string },
  b: { id: string; name?: string },
): number {
  const left = roomOrderKey(a);
  const right = roomOrderKey(b);
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left - right;
}

/**
 * 按考场序号**稳定排序**（返回新数组，不改原数组）。
 *
 * - `roomOf` 把元素映射成 `{ id, name? }`（`SeatingPlan` 传 `roomId` / `roomName`）；
 * - 解析不出序号的考场排在最后，且它们之间的相对顺序与输入一致（不许把 sheet 打乱或丢掉）；
 * - 同一考场多套座位（如「第十九考场（政治）」+「（地理）」）序号相同 → 保持原相对顺序。
 */
export function sortByRoomOrder<T>(
  items: readonly T[],
  roomOf: (item: T) => { id: string; name?: string },
): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => compareRoomOrder(roomOf(a.item), roomOf(b.item)) || a.index - b.index)
    .map((entry) => entry.item);
}
