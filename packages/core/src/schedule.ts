/**
 * 时段推导：把考试科目分成若干个「可以同时开考」的时段。
 *
 * 两门科目能同时开考 ⟺ 没有任何一个学生同时选了两门。 所以只要拿到「每个学生/每种组合选了哪些科目」，就能把冲突关系建成一张图， 再对这张图做图着色：同一种颜色 = 同一个时段。
 *
 * 这样规则不是写死的——学校以后新增选科组合，重新推一次就行。
 */

/** 时段排序用的展示顺序：语文、数学、外语、物理、历史、化学、生物、政治、地理 */
import { CORE_SUBJECTS } from "./subjects";

const SLOT_DISPLAY_ORDER = [
  "chinese",
  "math",
  "english",
  "physics",
  "history",
  "chemistry",
  "biology",
  "politics",
  "geography",
];

export interface TimeSlot {
  id: string;
  name: string;
  /** 本时段并行开考的科目 */
  subjects: string[];
}

/** 把「每种组合选了哪些科目」变成两两冲突的邻接表。 */
export function buildConflictGraph(
  combinations: readonly (readonly string[])[],
): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  const ensure = (subject: string): Set<string> => {
    let set = adjacency.get(subject);
    if (!set) {
      set = new Set<string>();
      adjacency.set(subject, set);
    }
    return set;
  };

  for (const combo of combinations) {
    for (const subject of combo) ensure(subject);
    // 同一种组合里的科目两两冲突
    for (let i = 0; i < combo.length; i += 1) {
      for (let j = i + 1; j < combo.length; j += 1) {
        ensure(combo[i]!).add(combo[j]!);
        ensure(combo[j]!).add(combo[i]!);
      }
    }
  }

  return adjacency;
}

/**
 * 推导时段。用 DSATUR（饱和度优先）着色，对这类小图基本能给出最优解。
 *
 * 以本项目的 4 种组合为例，会推出 7 个时段： 语文 / 数学 / 外语 / 物理+历史 / 化学 / 生物+政治 / 地理
 *
 * `coreSubjects` 是**全体都考**的科目（默认语数外）。它们不在选科文本里， 但和所有科目都冲突，所以必须显式并进每个人的科目集合。传 `[]` 表示本次只考选考科目。
 */
export function deriveTimeSlots(
  combinations: readonly (readonly string[])[],
  coreSubjects: readonly string[] = CORE_SUBJECTS,
): TimeSlot[] {
  const fullSets = combinations.map((combo) => [...coreSubjects, ...combo]);
  const adjacency = buildConflictGraph(fullSets);
  if (adjacency.size === 0) return [];

  const orderIndex = (subject: string): number => {
    const at = SLOT_DISPLAY_ORDER.indexOf(subject);
    return at === -1 ? SLOT_DISPLAY_ORDER.length : at;
  };

  const colorOf = new Map<string, number>();
  const remaining = new Set(adjacency.keys());

  while (remaining.size > 0) {
    // 选饱和度最高（邻居里已着色的颜色种类最多）的顶点，平局时选度数大的
    let picked = "";
    let bestSaturation = -1;
    let bestDegree = -1;
    for (const subject of remaining) {
      const neighbours = adjacency.get(subject)!;
      const saturation = new Set(
        [...neighbours].filter((n) => colorOf.has(n)).map((n) => colorOf.get(n)!),
      ).size;
      const degree = neighbours.size;
      if (
        saturation > bestSaturation ||
        (saturation === bestSaturation && degree > bestDegree) ||
        (saturation === bestSaturation &&
          degree === bestDegree &&
          orderIndex(subject) < orderIndex(picked))
      ) {
        picked = subject;
        bestSaturation = saturation;
        bestDegree = degree;
      }
    }

    const used = new Set(
      [...adjacency.get(picked)!].filter((n) => colorOf.has(n)).map((n) => colorOf.get(n)!),
    );
    let color = 0;
    while (used.has(color)) color += 1;
    colorOf.set(picked, color);
    remaining.delete(picked);
  }

  // 颜色号 → 科目
  const buckets = new Map<number, string[]>();
  for (const [subject, color] of colorOf) {
    const list = buckets.get(color) ?? [];
    list.push(subject);
    buckets.set(color, list);
  }

  // 按展示顺序给时段排序：取时段内最早出现的科目
  const sorted = [...buckets.entries()]
    .map(([color, subjects]) => {
      const ordered = [...subjects].sort((a, b) => orderIndex(a) - orderIndex(b));
      return { color, subjects: ordered, key: orderIndex(ordered[0]!) };
    })
    .sort((a, b) => a.key - b.key || a.color - b.color);

  return sorted.map((entry, index) => ({
    id: `T${index + 1}`,
    name: `第${index + 1}时段`,
    subjects: entry.subjects,
  }));
}

/** 校验：同一个学生在同一个时段里是否被安排了两场考试。返回冲突描述。 */
export function findSlotConflicts(
  slots: readonly TimeSlot[],
  studentSubjects: readonly (readonly string[])[],
): { studentIndex: number; slotId: string; subjects: string[] }[] {
  const problems: { studentIndex: number; slotId: string; subjects: string[] }[] = [];
  for (let i = 0; i < studentSubjects.length; i += 1) {
    const own = new Set(studentSubjects[i] ?? []);
    for (const slot of slots) {
      const hit = slot.subjects.filter((s) => own.has(s));
      if (hit.length > 1) problems.push({ studentIndex: i, slotId: slot.id, subjects: hit });
    }
  }
  return problems;
}

/** 某个学生在某个时段考什么。返回 null 表示这个时段他没考试（缺考 / 空档）。 */
export function subjectInSlot(
  slots: readonly TimeSlot[],
  studentSubjects: readonly string[],
  slotId: string,
): string | null {
  const slot = slots.find((s) => s.id === slotId);
  if (!slot) return null;
  return slot.subjects.find((s) => studentSubjects.includes(s)) ?? null;
}
