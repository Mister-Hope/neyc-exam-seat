import { describe, expect, it } from "vitest";

import {
  buildConflictGraph,
  deriveTimeSlots,
  findSlotConflicts,
  parseCombination,
  subjectInSlot,
} from "../src/index";

/** 学校的四种组合 */
const COMBINATIONS = ["物化生", "政史地", "物化政", "物化地"].map(
  (text) => parseCombination(text).subjects,
);

function slotOf(slots: ReturnType<typeof deriveTimeSlots>, subject: string): string[] {
  return slots.find((s) => s.subjects.includes(subject))?.subjects ?? [];
}

describe("时段推导", () => {
  it("四种组合推出 7 个时段", () => {
    const slots = deriveTimeSlots(COMBINATIONS);
    expect(slots).toHaveLength(7);
    for (const slot of slots) expect(slot.subjects.length).toBeGreaterThan(0);
  });

  it("物理和历史同时考（首选互斥，没人同时选）", () => {
    const slots = deriveTimeSlots(COMBINATIONS);
    expect(slotOf(slots, "physics")).toEqual(["physics", "history"]);
  });

  it("生物和政治同时考（生物只有物化生选，政治是政史地+物化政选，无交集）", () => {
    const slots = deriveTimeSlots(COMBINATIONS);
    expect(slotOf(slots, "biology")).toEqual(["biology", "politics"]);
  });

  it("化学独占一个时段（它和生物/政治/地理/物理全冲突）", () => {
    const slots = deriveTimeSlots(COMBINATIONS);
    expect(slotOf(slots, "chemistry")).toEqual(["chemistry"]);
  });

  it("语数外各自独占一个时段", () => {
    const slots = deriveTimeSlots(COMBINATIONS);
    expect(slotOf(slots, "chinese")).toEqual(["chinese"]);
    expect(slotOf(slots, "math")).toEqual(["math"]);
    expect(slotOf(slots, "english")).toEqual(["english"]);
  });

  it("时段顺序是 语 → 数 → 外 → 物历 → 化 → 生政 → 地", () => {
    const slots = deriveTimeSlots(COMBINATIONS);
    expect(slots.map((s) => s.subjects.join("+"))).toEqual([
      "chinese",
      "math",
      "english",
      "physics+history",
      "chemistry",
      "biology+politics",
      "geography",
    ]);
  });

  it("每个学生在每个时段最多只有一门考试", () => {
    const slots = deriveTimeSlots(COMBINATIONS);
    const CORE = ["chinese", "math", "english"];
    const students = [
      ...COMBINATIONS.map((c) => [...CORE, ...c]),
      [...CORE, "physics", "chemistry", "biology"],
      [...CORE, "politics", "history", "geography"],
    ];
    expect(findSlotConflicts(slots, students)).toEqual([]);
  });

  it("时段推导是从冲突关系来的，不是写死的——新增组合会重新推导", () => {
    // 原先：物理和历史互斥，可以同段
    expect(slotOf(deriveTimeSlots(COMBINATIONS), "physics")).toContain("history");

    // 假设学校新增「物化历」（物理+化学+历史）：物理和历史这下冲突了
    const withNew = [...COMBINATIONS, parseCombination("物化历").subjects];
    const slots = deriveTimeSlots(withNew);
    expect(slotOf(slots, "physics")).not.toContain("history");
    expect(slotOf(slots, "physics")).not.toContain("chemistry");
    expect(slotOf(slots, "chemistry")).toEqual(["chemistry"]);
    const CORE = ["chinese", "math", "english"];
    expect(
      findSlotConflicts(
        slots,
        withNew.map((c) => CORE.concat(c)),
      ),
    ).toEqual([]);
  });

  it("冲突图正确：政史地让政治和地理冲突", () => {
    const graph = buildConflictGraph(COMBINATIONS);
    expect(graph.get("politics")!.has("geography")).toBe(true);
    expect(graph.get("politics")!.has("history")).toBe(true);
    // 生物和政治无交集
    expect(graph.get("biology")!.has("politics")).toBe(false);
    // 物理和历史无交集
    expect(graph.get("physics")!.has("history")).toBe(false);
  });

  it("subjectInSlot：物化地学生在生物时段没有考试", () => {
    const slots = deriveTimeSlots(COMBINATIONS);
    const wuhuadi = parseCombination("物化地").subjects;
    const bioSlot = slots.find((s) => s.subjects.includes("biology"))!;
    const geoSlot = slots.find((s) => s.subjects.includes("geography"))!;
    expect(subjectInSlot(slots, wuhuadi, bioSlot.id)).toBeNull(); // 生物缺考
    expect(subjectInSlot(slots, wuhuadi, geoSlot.id)).toBe("geography");
  });

  it("物化政学生在化学、政治时段有考试，地理时段没有", () => {
    const slots = deriveTimeSlots(COMBINATIONS);
    const wuhuazheng = parseCombination("物化政").subjects;
    const chemSlot = slots.find((s) => s.subjects.includes("chemistry"))!;
    const polSlot = slots.find((s) => s.subjects.includes("politics"))!;
    const geoSlot = slots.find((s) => s.subjects.includes("geography"))!;
    expect(subjectInSlot(slots, wuhuazheng, chemSlot.id)).toBe("chemistry");
    expect(subjectInSlot(slots, wuhuazheng, polSlot.id)).toBe("politics");
    expect(subjectInSlot(slots, wuhuazheng, geoSlot.id)).toBeNull();
  });
});
