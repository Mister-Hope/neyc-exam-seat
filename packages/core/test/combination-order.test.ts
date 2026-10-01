import { describe, expect, it } from "vitest";

import { SUBJECT_SHORT, compareCombinationNames, normalizeCombination } from "../src/index";

/** 与 `COMBINATION_ORDER` 一致的科目顺序（6 门选科） */
const SUBJECT_IDS = [
  "physics",
  "chemistry",
  "biology",
  "politics",
  "history",
  "geography",
] as const;

/** 本项目 6 门选科能拼出的全部组合名（按 `COMBINATION_ORDER` 拼接：2 字 + 3 字，共 35 个） */
const COMBINATIONS: string[] = [];
for (let i = 0; i < SUBJECT_IDS.length; i += 1) {
  for (let j = i + 1; j < SUBJECT_IDS.length; j += 1) {
    const head = SUBJECT_SHORT[SUBJECT_IDS[i]!]! + SUBJECT_SHORT[SUBJECT_IDS[j]!]!;
    COMBINATIONS.push(head);
    for (let k = j + 1; k < SUBJECT_IDS.length; k += 1) {
      COMBINATIONS.push(head + SUBJECT_SHORT[SUBJECT_IDS[k]!]!);
    }
  }
}

/**
 * 冻结的**期望全序**（2026-10 记录）。
 *
 * 这一串是 `compareCombinationNames` 的既有行为快照：它同时也是旧代码 `localeCompare(a, b, "zh")` 给出的顺序 —— 但**测试不依赖
 * ICU**：期望值写死在这里，任何改动（含换排序规则）都会立刻被看见。
 */
const EXPECTED_ORDER =
  "化地 化生 化生地 化生史 化生政 化史 化史地 化政 化政地 化政史 生地 生史 生史地 生政 生政地 生政史 史地 物地 物化 物化地 物化生 物化史 物化政 物生 物生地 物生史 物生政 物史 物史地 物政 物政地 物政史 政地 政史 政史地".split(
    " ",
  );

describe("组合名排序：稳定、可复现、不依赖 ICU", () => {
  it("35 种组合的排序结果与冻结顺序逐项一致（任何人都能复现，不读环境 ICU）", () => {
    expect([...COMBINATIONS].sort(compareCombinationNames)).toEqual(EXPECTED_ORDER);
  });

  it("真实 job 的五个组合：物化生 排在 物化政 之前（默认 locale 的排序会反过来）", () => {
    const real = ["物化生", "史地政", "物化政", "物化地", "史生政"];
    expect([...real].sort(compareCombinationNames)).toEqual([
      "史地政",
      "史生政",
      "物化地",
      "物化生",
      "物化政",
    ]);
    // `Array#sort` 不带比较函数时走 UTF-16 码元序 → 物化政(U+653F) 会跑到 物化生(U+751F) 前面，
    // 这正是「不要用环境默认排序」的反例
    expect([...real].sort()).toEqual(["史地政", "史生政", "物化地", "物化政", "物化生"]);
  });

  it("是全序：自反、反对称、与 normalizeCombination 的规范化结果一致", () => {
    for (const a of COMBINATIONS) {
      expect(compareCombinationNames(a, a)).toBe(0);
      for (const b of COMBINATIONS) {
        expect(
          Math.sign(compareCombinationNames(a, b)) + Math.sign(compareCombinationNames(b, a)),
        ).toBe(0);
      }
    }
    expect(normalizeCombination("物理化学政治")).toBe("物化政");
    expect(compareCombinationNames("物化政", normalizeCombination("物化政"))).toBe(0);
  });

  it("认不出的字符退回 UTF-16 码元序，不会返回 NaN / 0 造成顺序塌陷", () => {
    expect(compareCombinationNames("物化政", "物化X")).not.toBe(0);
    expect(Math.sign(compareCombinationNames("A", "B"))).toBe(-1);
    expect(Math.sign(compareCombinationNames("物化政", "物化政X"))).toBe(-1);
    expect(Math.sign(compareCombinationNames("物化政X", "物化政"))).toBe(1);
  });
});
