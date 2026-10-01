import { normalizeCombination } from "./subjects";
import type { RoomSpec } from "./types";

/**
 * 这个考场是否放宽了「同班相邻」（`RoomSpec.relaxSameClass`，见 `docs/design.md` §5.8.1）。
 *
 * 只有显式写了 `true` 或数字才算放宽；`false` / 缺省 / `null` 都按原规则处理。
 */
export function isSameClassRelaxed(room: Pick<RoomSpec, "relaxSameClass">): boolean {
  return room.relaxSameClass !== undefined && room.relaxSameClass !== false;
}

/**
 * 放宽后这个考场「同班学生数」的有效上限。
 *
 * - 没放宽 → `fallback`（通常是按真实座位图算出来的 `maxSameClass`）
 * - `true` → 座位数（等于完全放开）
 * - 数字 n → `min(n, 座位数)`；n 不合法（NaN / < 1）时退回 `fallback`
 */
export function relaxedClassLimit(
  room: Pick<RoomSpec, "relaxSameClass">,
  fallback: number,
  capacity: number,
): number {
  const relax = room.relaxSameClass;
  if (relax === undefined || relax === false) return fallback;
  if (relax === true) return capacity;
  if (typeof relax !== "number" || !Number.isFinite(relax)) return fallback;
  return Math.max(1, Math.min(Math.floor(relax), capacity));
}

/**
 * 「这个考场最多能坐同一个班多少人」的**硬上限**：只有**数字**形态才返回数字，其余一律 `undefined`（不限人数）。
 *
 * 语义分工（`docs/design.md` §5.8.1）：
 *
 * - 缺省 / `false` → 不放宽：靠普通「同班相邻」规则限制（上限是座位图的最大独立集，即 `fallback`），**没有额外计数上限**；
 * - `true` → 完全放开：该考场不再判同班相邻，也**不限**同班人数（`undefined`）；
 * - 数字 `n` → 该考场不再判同班相邻，但**同班人数不得超过 `n`**（求解器计数约束 + 校验器独立复核）。
 */
export function sameClassLimit(
  room: Pick<RoomSpec, "relaxSameClass">,
  fallback: number,
  capacity: number,
): number | undefined {
  const relax = room.relaxSameClass;
  if (typeof relax !== "number" || !Number.isFinite(relax)) return undefined;
  return relaxedClassLimit(room, fallback, capacity);
}

/**
 * `ROOM_SAME_CLASS_RELAXED` 文案里「本考场放宽成什么样」那半句。
 *
 * `true` 与数字的**语义不同**，文案必须能一眼区分：`true` 是不限人数，数字是同班人数上限 —— 若把 `true` 也写成「上限 N」（N =
 * 座位数），老师会误以为那是自己配置的值。
 */
export function describeSameClassRelax(
  room: Pick<RoomSpec, "relaxSameClass">,
  fallback: number,
  capacity: number,
): string {
  if (room.relaxSameClass === true) return "本考场不限同班人数";
  return `本考场同班人数上限 ${relaxedClassLimit(room, fallback, capacity)} 人`;
}

/**
 * 考场的「专属组合」（`RoomSpec.combination`）规范化后的值：没写或写了空串 = 不专属任何组合。
 *
 * 写法可任意（「史地政」/「政史地」等价）；认不出任何科目的文本按原样返回，既不误伤也便于报错。
 */
export function roomCombination(room: Pick<RoomSpec, "combination">): string | undefined {
  const raw = room.combination?.trim();
  if (raw === undefined || raw === "") return undefined;
  return normalizeCombination(raw) || raw;
}

/** 稳定序列化：对象键排序，保证同输入得到同字符串。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortValue(item));
  if (typeof value === "object" && value != null) {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      if (src[key] === undefined) continue;
      out[key] = sortValue(src[key]);
    }
    return out;
  }
  return value;
}

/** FNV-1a 64 位，用于内容指纹（不是安全哈希）。 */
export function fingerprint(value: unknown): string {
  const text = typeof value === "string" ? value : canonicalJson(value);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return `fnv1a:${hash.toString(16).padStart(16, "0")}`;
}

/** Mulberry32：小而快的可复现 PRNG。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function ceilDiv(a: number, b: number): number {
  return Math.ceil(a / b);
}
