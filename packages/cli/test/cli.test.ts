import { describe, expect, it } from "vitest";

import { planAll } from "@exam-seat/core";
import type { Job } from "@exam-seat/core";

import { parseRoomSpec } from "../src/cli";
import { renderPlanAll } from "../src/render";

describe("考场规格解析", () => {
  it("small / large 展开成 30 人与 42 人的考场", () => {
    const rooms = parseRoomSpec("1-3:small,4:large");
    expect(rooms).toHaveLength(4);
    expect(rooms[0]).toMatchObject({ id: "R1", rows: 6, cols: 5 });
    expect(rooms[2]).toMatchObject({ id: "R3", rows: 6, cols: 5 });
    expect(rooms[3]).toMatchObject({ id: "R4", rows: 7, cols: 6 });
  });

  it("自定义 NxM 按「N 排 × M 列」解析", () => {
    const rooms = parseRoomSpec("26:6x4");
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ rows: 6, cols: 4 });
    expect(rooms[0]!.rows * rooms[0]!.cols).toBe(24);
  });

  it("中文别名和别的乘号也能认", () => {
    expect(parseRoomSpec("1:小")[0]).toMatchObject({ rows: 6, cols: 5 });
    expect(parseRoomSpec("1:大")[0]).toMatchObject({ rows: 7, cols: 6 });
    expect(parseRoomSpec("1:6×4")[0]).toMatchObject({ rows: 6, cols: 4 });
    expect(parseRoomSpec("1:6*4")[0]).toMatchObject({ rows: 6, cols: 4 });
  });

  it("默认名是「第N考场」，id 是 R N", () => {
    expect(parseRoomSpec("7:small")[0]).toMatchObject({ id: "R7", name: "第7考场" });
  });

  it("写错了会明确报错，而不是静默产出空列表", () => {
    expect(() => parseRoomSpec("abc")).toThrow(/看不懂/);
    expect(() => parseRoomSpec("1-3")).toThrow(/看不懂/);
    expect(() => parseRoomSpec("3-1:small")).toThrow(/看不懂/);
    expect(() => parseRoomSpec("1:5x")).toThrow(/看不懂/);
  });

  it("混合规格的总容量算得对", () => {
    const rooms = parseRoomSpec("1-20:small,21-25:large,26:6x4");
    const total = rooms.reduce((sum, r) => sum + r.rows * r.cols, 0);
    expect(rooms).toHaveLength(26);
    expect(total).toBe(20 * 30 + 5 * 42 + 24);
  });
});

describe("多场次终端摘要", () => {
  it("一套座位方案都没有时不得出现「排考完成」这类成功话术", () => {
    const job: Job = {
      jobVersion: 2,
      students: Array.from({ length: 6 }, (_, i) => ({
        id: `X${i + 1}`,
        name: `缺考${i + 1}`,
        className: "高三(1)班",
        combination: "物化生",
        subjects: ["physics", "chemistry", "biology"],
        included: false,
      })),
      rooms: [1, 2, 3].map((n) => ({ id: `R${n}`, name: `第${n}考场`, rows: 6, cols: 5 })),
    };
    const result = planAll(job);
    expect(result.seatings).toHaveLength(0);

    const text = renderPlanAll(result);
    expect(text).toMatch(/没有任何考场安排/);
    expect(text).not.toMatch(/排考完成|全部时段已安排|✅/);
  });

  it("有未满足限定时单列一段，写明限定 / 考场 / 人数 / 原因", () => {
    const job: Job = {
      jobVersion: 2,
      options: { relax: "minConflicts" },
      students: Array.from({ length: 12 }, (_, i) => ({
        id: `U${String(i).padStart(2, "0")}`,
        name: `学生${i}`,
        className: `高三(${i + 1}班)`,
        combination: "物化生",
      })),
      rooms: [{ id: "R1", name: "第1考场", rows: 6, cols: 5 }],
      // 3 个人都要坐「末排靠门」这同一个座位 → 必然有人坐不上
      constraints: [
        {
          id: "C5",
          note: "物化生全体末排靠门",
          studentIds: ["U00", "U01", "U02"],
          rows: ["last"],
          cols: ["door"],
        },
      ],
    };
    const result = planAll(job);
    expect(result.unmetConstraints.length).toBeGreaterThan(0);

    const text = renderPlanAll(result);
    expect(text).toContain("未满足的限定：");
    expect(text).toContain("C5 · 第1考场");
    expect(text).toMatch(/涉及 \d+ 人：/);
    expect(text).toContain("原因：");
  });

  it("没有未满足限定时不打「未满足的限定」标题", () => {
    const job: Job = {
      jobVersion: 2,
      students: Array.from({ length: 12 }, (_, i) => ({
        id: `V${String(i).padStart(2, "0")}`,
        name: `学生${i}`,
        className: `高三(${i + 1}班)`,
        combination: "物化生",
      })),
      rooms: [{ id: "R1", name: "第1考场", rows: 6, cols: 5 }],
    };
    const result = planAll(job);
    expect(result.unmetConstraints).toEqual([]);

    const text = renderPlanAll(result);
    expect(text).not.toContain("未满足的限定");
  });
});
