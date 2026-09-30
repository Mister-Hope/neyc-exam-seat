import { describe, expect, it } from "vitest";

import {
  compileModel,
  formatCombination,
  normalizeCombination,
  parseCombination,
  plan,
  precheckJob,
  resolveConstraintStudents,
  validateSelection,
} from "../src/index";
import type { Constraint, Job, RoomSpec } from "../src/index";

describe("选科文本解析", () => {
  it("四种组合的简写都能解析成科目集合", () => {
    expect(parseCombination("物化生").subjects).toEqual(["physics", "chemistry", "biology"]);
    expect(parseCombination("物化政").subjects).toEqual(["physics", "chemistry", "politics"]);
    expect(parseCombination("物化地").subjects).toEqual(["physics", "chemistry", "geography"]);
    expect(parseCombination("政史地").subjects).toEqual(["politics", "history", "geography"]);
  });

  it("全名、顿号、空格写法都等价", () => {
    const expected = ["physics", "chemistry", "politics"];
    expect(parseCombination("物理化学政治").subjects).toEqual(expected);
    expect(parseCombination("物理、化学、政治").subjects).toEqual(expected);
    expect(parseCombination("物理 化学 政治").subjects).toEqual(expected);
    expect(parseCombination("物理,化学,政治").subjects).toEqual(expected);
  });

  it("最长匹配，所以「生物」不会被拆成「生 + 物」", () => {
    // 如果按单字切，「生物」会变成 生(biology) + 物(physics) 两门——那就是错的
    expect(parseCombination("生物").subjects).toEqual(["biology"]);
    expect(parseCombination("物理").subjects).toEqual(["physics"]);
    expect(parseCombination("物化生").subjects).toEqual(["physics", "chemistry", "biology"]);
    // 「地理」也不能被拆成「地 + 理」
    expect(parseCombination("地理").subjects).toEqual(["geography"]);
    expect(parseCombination("政史地").subjects).toEqual(["politics", "history", "geography"]);
  });

  it("认不出的字会被报出来，而不是静默丢掉", () => {
    const parsed = parseCombination("物化政X");
    expect(parsed.subjects).toEqual(["physics", "chemistry", "politics"]);
    expect(parsed.unknown).toEqual(["X"]);
  });

  it("组合名规范化后与约定俗成的写法一致", () => {
    expect(parseCombination("物化生").combination).toBe("物化生");
    expect(parseCombination("物化政").combination).toBe("物化政");
    expect(parseCombination("物化地").combination).toBe("物化地");
    // 政治的「政」必须排在历史前面，否则会拼成「史政地」
    expect(parseCombination("政史地").combination).toBe("政史地");
    expect(parseCombination("历史地理政治").combination).toBe("政史地");
  });

  it("normalizeCombination 让同一组合的不同写法可比", () => {
    expect(normalizeCombination("物理化学政治")).toBe(normalizeCombination("物化政"));
    expect(normalizeCombination("政治历史地理")).toBe(normalizeCombination("政史地"));
    expect(formatCombination(["geography", "history", "politics"])).toBe("政史地");
  });
});

describe("3+1+2 校验", () => {
  it("四种合法组合都没有问题", () => {
    for (const text of ["物化生", "物化政", "物化地", "政史地"]) {
      expect(validateSelection(parseCombination(text).subjects)).toEqual([]);
    }
  });

  it("首选不是恰好 1 门会被拦下", () => {
    expect(validateSelection(["chemistry", "biology"])).toContain(
      "首选科目应当恰好 1 门（物理/历史），实际 0 门",
    );
    expect(validateSelection(["physics", "history", "chemistry"])).toContain(
      "首选科目应当恰好 1 门（物理/历史），实际 2 门",
    );
  });

  it("再选不是恰好 2 门会被拦下", () => {
    expect(validateSelection(["physics", "chemistry"])).toContain(
      "再选科目应当恰好 2 门（化学/生物/政治/地理），实际 1 门",
    );
    expect(validateSelection(["physics", "chemistry", "biology", "politics"])).toContain(
      "再选科目应当恰好 2 门（化学/生物/政治/地理），实际 3 门",
    );
  });
});

/* ------------------------------------------------------------------ */
/* 限定选择器                                                          */
/* ------------------------------------------------------------------ */

const ROOM: RoomSpec = { id: "R1", name: "第一考场", rows: 6, cols: 5 };

function selectionJob(extra?: Partial<Job>): Job {
  const roster: [string, string, string][] = [
    ["S1", "高三(1)班", "物化生"],
    ["S2", "高三(1)班", "物化政"],
    ["S3", "高三(2)班", "物化地"],
    ["S4", "高三(2)班", "政史地"],
    ["S5", "高三(3)班", "物化政"],
  ];
  return {
    students: roster.map(([id, className, combination]) => ({
      id,
      name: `学生${id}`,
      className,
      combination,
    })),
    rooms: [ROOM],
    constraints: [],
    ...extra,
  };
}

function idsOf(job: Job, constraint: Constraint): string[] {
  const model = compileModel(job, "king");
  return resolveConstraintStudents(model, constraint).map((i) => model.students[i]!.id);
}

describe("限定选择器", () => {
  it("按选科组合选人", () => {
    const job = selectionJob();
    expect(idsOf(job, { id: "c", combinations: ["物化政"] })).toEqual(["S2", "S5"]);
    expect(idsOf(job, { id: "c", combinations: ["物化生"] })).toEqual(["S1"]);
  });

  it("组合写法不同也能匹配上（内部会规范化）", () => {
    const job = selectionJob();
    expect(idsOf(job, { id: "c", combinations: ["物理化学政治"] })).toEqual(["S2", "S5"]);
    expect(idsOf(job, { id: "c", combinations: ["政治历史地理"] })).toEqual(["S4"]);
  });

  it("按班级选人", () => {
    const job = selectionJob();
    expect(idsOf(job, { id: "c", classes: ["高三(1)班"] })).toEqual(["S1", "S2"]);
  });

  it("按所选科目选人：政治 = 政史地 + 物化政", () => {
    const job = selectionJob();
    expect(idsOf(job, { id: "c", subjects: ["politics"] })).toEqual(["S2", "S4", "S5"]);
    // 化学 = 三种理科组合
    expect(idsOf(job, { id: "c", subjects: ["chemistry"] })).toEqual(["S1", "S2", "S3", "S5"]);
    // 生物只有物化生
    expect(idsOf(job, { id: "c", subjects: ["biology"] })).toEqual(["S1"]);
    // 地理 = 政史地 + 物化地
    expect(idsOf(job, { id: "c", subjects: ["geography"] })).toEqual(["S3", "S4"]);
  });

  it("多个选择器取并集", () => {
    const job = selectionJob();
    expect(idsOf(job, { id: "c", combinations: ["物化生"], classes: ["高三(2)班"] })).toEqual([
      "S1",
      "S3",
      "S4",
    ]);
  });

  it("按学号点名仍然可用", () => {
    const job = selectionJob();
    expect(idsOf(job, { id: "c", studentIds: ["S3", "S1"] })).toEqual(["S1", "S3"]);
  });
});

describe("选择器接进预检", () => {
  it("一个选择器都不写 → 报 CONSTRAINT_NO_SELECTOR", () => {
    const job = selectionJob({
      constraints: [{ id: "empty", note: "空限定", roomId: "R1" }],
    });
    const out = precheckJob(job);
    expect(out.fatal).toBe(true);
    expect(out.diagnostics.some((d) => d.code === "CONSTRAINT_NO_SELECTOR")).toBe(true);
  });

  it("「所有物化政学生去第一考场」这种写法能直接跑通", () => {
    const job = selectionJob({
      rooms: [
        ROOM,
        { id: "R2", name: "第二考场", rows: 6, cols: 5 },
        { id: "R3", name: "第二十考场", rows: 6, cols: 5 },
      ],
      constraints: [
        { id: "dedicated", note: "物化政专用", combinations: ["物化政"], roomId: "R3" },
      ],
    });
    const result = plan(job);
    expect(result.ok).toBe(true);
    for (const id of ["S2", "S5"]) {
      expect(result.entries.find((e) => e.studentId === id)!.roomId).toBe("R3");
    }
    // 其他人不在 R3
    for (const id of ["S1", "S3", "S4"]) {
      expect(result.entries.find((e) => e.studentId === id)!.roomId).not.toBe("R3");
    }
  });

  it("选择器选出来的人超过座位数 → 报超员并给出建议", () => {
    const job = selectionJob({
      rooms: [{ id: "R1", name: "小教室", rows: 1, cols: 1 }], // 只有 1 个座位
      constraints: [{ id: "all", note: "所有人", classes: ["高三(1)班"], roomId: "R1" }],
    });
    const out = precheckJob(job);
    expect(out.fatal).toBe(true);
    const diag = out.diagnostics.find((d) => d.code === "CONSTRAINT_OVERSATURATED")!;
    expect(diag).toBeDefined();
    expect(diag.message).toContain("命中了 2 名学生");
  });
});

describe("选科是可选的", () => {
  it("名单里没有选科信息时，按普通单场排考", () => {
    const students = [];
    for (let c = 1; c <= 18; c += 1) {
      for (let i = 1; i <= 2; i += 1) {
        students.push({ id: `S${c}-${i}`, name: `n${c}${i}`, className: `C${c}` });
      }
    }
    const job: Job = {
      students,
      rooms: [
        { id: "R1", rows: 6, cols: 5 },
        { id: "R2", rows: 6, cols: 5 },
      ],
      constraints: [{ id: "c1", studentIds: ["S1-1"], rows: ["first"] }],
    };
    const result = plan(job);
    expect(result.ok).toBe(true);
    expect(result.entries.find((e) => e.studentId === "S1-1")!.row).toBe(1);
  });
});
