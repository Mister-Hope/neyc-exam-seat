import { describe, expect, it } from "vitest";

import { precheckJob } from "../src/index";
import type { Job, RoomSpec, Student } from "../src/index";

function students(count: number): Student[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `S${String(index).padStart(3, "0")}`,
    name: `学生${index}`,
    className: `高三(${(index % 18) + 1})班`,
  }));
}

function job(rooms: RoomSpec[], count: number): Job {
  return { jobVersion: 2, students: students(count), rooms };
}

const SMALL_35: RoomSpec = { id: "R1", name: "第1考场", rows: 7, cols: 5 };
const LARGE_42: RoomSpec = { id: "R2", name: "第2考场", rows: 7, cols: 6 };

describe("预检：把比最大考场小的考场改大（不依赖预设尺寸）", () => {
  it("35 座 + 42 座混排：建议出现，gain = 42 − 35 = 7", () => {
    // 77 座 < 80 人 → 缺 3 个座位，把 35 座改成 42 座就够
    const out = precheckJob(job([SMALL_35, LARGE_42], 80));
    const diag = out.diagnostics.find((d) => d.code === "CAPACITY_INSUFFICIENT")!;
    expect(diag).toBeDefined();

    const suggestion = diag.suggestions.find((s) => s.id === "upgrade-small-rooms")!;
    expect(suggestion).toBeDefined();
    expect(suggestion.effect).toBe("增加 7 个座位");
    expect(suggestion.label).toContain("35 座 → 改成 42 座可多放 7 人");
    expect(suggestion.patch).toEqual([
      { op: "replace", path: "/rooms/0/rows", value: 7 },
      { op: "replace", path: "/rooms/0/cols", value: 6 },
    ]);
  });

  it("纯 42 座：没有可改大的考场，不出现升级建议（只能加考场）", () => {
    const out = precheckJob(job([LARGE_42, { ...LARGE_42, id: "R3", name: "第3考场" }], 86));
    const diag = out.diagnostics.find((d) => d.code === "CAPACITY_INSUFFICIENT")!;
    expect(diag).toBeDefined();
    expect(diag.suggestions.some((s) => s.id === "upgrade-small-rooms")).toBe(false);
    expect(diag.suggestions.some((s) => s.id === "add-rooms")).toBe(true);
  });

  it("差异更大的小考场：按 gain 从大到小累计，gain 与 effect 对得上", () => {
    // 30 座 + 35 座 + 42 座 = 107 座 < 120 人 → 缺 13 个座位
    const out = precheckJob(
      job([{ id: "R1", name: "第1考场", rows: 6, cols: 5 }, SMALL_35, LARGE_42], 120),
    );
    const diag = out.diagnostics.find((d) => d.code === "CAPACITY_INSUFFICIENT")!;
    const suggestion = diag.suggestions.find((s) => s.id === "upgrade-small-rooms")!;
    // 先改 30 座（+12），再改 35 座（+7）→ 累计 19 ≥ 13
    expect(suggestion.effect).toBe("增加 19 个座位");
    expect(suggestion.patch).toHaveLength(4);
  });
});

describe("预检：加考场建议按本 job 最大考场取模板（不写死 42 座）", () => {
  function addRoomsSuggestion(rooms: RoomSpec[], count: number) {
    const out = precheckJob(job(rooms, count));
    const diag = out.diagnostics.find((d) => d.code === "CAPACITY_INSUFFICIENT")!;
    expect(diag).toBeDefined();
    return diag.suggestions.find((s) => s.id === "add-rooms")!;
  }

  it("最大考场是 5 列 × 7 排（35 座）：新考场模板就是 5 列 × 7 排", () => {
    const suggestion = addRoomsSuggestion([SMALL_35], 40); // 35 座 < 40 人 → 缺 5
    expect(suggestion).toBeDefined();
    expect(suggestion.label).toBe("加 1 个考场（5 列 × 7 排，35 座）");
    expect(suggestion.effect).toBe("增加 35 个座位");
    expect(suggestion.patch).toEqual([
      {
        op: "add",
        path: "/rooms/-",
        value: { id: "R2", name: "第2考场", rows: 7, cols: 5, doorSide: "right" },
      },
    ]);
  });

  it("混合尺寸（35 + 42）：以 42 座的大考场为准", () => {
    const suggestion = addRoomsSuggestion([SMALL_35, LARGE_42], 80); // 77 座 < 80 人 → 缺 3
    expect(suggestion.label).toBe("加 1 个考场（6 列 × 7 排，42 座）");
    expect(suggestion.effect).toBe("增加 42 个座位");
    expect(suggestion.patch).toEqual([
      {
        op: "add",
        path: "/rooms/-",
        value: { id: "R3", name: "第3考场", rows: 7, cols: 6, doorSide: "right" },
      },
    ]);
  });

  it("没有任何考场时退回 6 列 × 7 排；带加座的考场连加座列一起复制", () => {
    // 无考场：班级上限为 0 → CLASS_LIMIT_EXCEEDED 带上「按同班名额算」的加考场建议（task-66）
    // 10 个班各 1 人 → 6×7 在 8 邻域下每间最多放该班 12 人 → 加 1 间就够
    const noRooms = precheckJob(job([], 10));
    const fallback = noRooms.diagnostics
      .find((d) => d.code === "CLASS_LIMIT_EXCEEDED")!
      .suggestions.find((s) => s.id === "add-rooms-for-class")!;
    expect(fallback.label).toContain("6 列 × 7 排");
    expect(fallback.label).toContain("每个最多放该班 12 人");
    expect(fallback.label).toContain("0 → 12");
    expect(fallback.patch).toEqual([
      {
        op: "add",
        path: "/rooms/-",
        value: { id: "R1", name: "第1考场", rows: 7, cols: 6, doorSide: "right" },
      },
    ]);

    // 37 座（5 列 × 7 排 + 第 2、4 列加座）→ 模板要连 extraFrontSeats 一起复制
    const withExtras: RoomSpec = {
      id: "R1",
      name: "第1考场",
      rows: 7,
      cols: 5,
      extraFrontSeats: [2, 4],
    };
    const suggestion = addRoomsSuggestion([withExtras], 40); // 37 座 < 40 人 → 缺 3
    expect(suggestion.label).toBe("加 1 个考场（5 列 × 7 排，37 座）");
    expect(suggestion.patch).toEqual([
      {
        op: "add",
        path: "/rooms/-",
        value: {
          id: "R2",
          name: "第2考场",
          rows: 7,
          cols: 5,
          doorSide: "right",
          extraFrontSeats: [2, 4],
        },
      },
    ]);
  });

  it("要加多个考场时：文案说总数，patch 的 id 不与既有编号冲突", () => {
    // 42 座 < 90 人 → 缺 48 → 加 2 个（84 座）
    const suggestion = addRoomsSuggestion([LARGE_42], 90);
    expect(suggestion.label).toBe("加 2 个考场（共 84 座）");
    expect(suggestion.effect).toBe("增加 84 个座位");
    // R2 已被占用（rooms.length + 1 = 2），新考场从 R3 起
    expect(suggestion.patch!.map((op) => (op.value as { id: string }).id)).toEqual(["R3", "R4"]);
  });
});
