import { describe, expect, it } from "vitest";

import {
  applyJsonPatch,
  escapeToken,
  pointer,
  tryApplyPatches,
  unescapeToken,
} from "@/lib/json-patch";
import type { Job } from "@exam-seat/core";

function sampleJob(): Job {
  return {
    jobVersion: 2,
    meta: { title: "测试" },
    options: { seed: 1 },
    students: [{ id: "A", name: "张三", className: "一班" }],
    rooms: [{ id: "R1", name: "第1考场", rows: 6, cols: 5, doorSide: "right" }],
    constraints: [{ id: "C1", note: "首排", studentIds: ["A"], rows: ["first"] }],
  };
}

describe("jSON Patch（预检建议 / AI 修改的一键应用通道）", () => {
  it("add 数组元素：`-` 追加，数字下标插入", () => {
    const job = sampleJob();
    const appended = applyJsonPatch(job, [
      { op: "add", path: "/rooms/-", value: { id: "R2", rows: 7, cols: 6 } },
    ]);
    expect(appended.rooms.map((room) => room.id)).toEqual(["R1", "R2"]);

    const inserted = applyJsonPatch(job, [
      { op: "add", path: "/rooms/0", value: { id: "R0", rows: 7, cols: 6 } },
    ]);
    expect(inserted.rooms.map((room) => room.id)).toEqual(["R0", "R1"]);
  });

  it("replace 深层字段（典型：把小考场改成大考场）", () => {
    const job = sampleJob();
    const patched = applyJsonPatch(job, [
      { op: "replace", path: "/rooms/0/rows", value: 7 },
      { op: "replace", path: "/rooms/0/cols", value: 6 },
      { op: "add", path: "/options/adjacency", value: "orthogonal" },
    ]);
    expect(patched.rooms[0]).toMatchObject({ rows: 7, cols: 6 });
    expect(patched.options?.adjacency).toBe("orthogonal");
  });

  it("remove 数组元素 / 对象字段", () => {
    const job = sampleJob();
    job.constraints = [{ id: "C1", note: "首排", studentIds: ["A"], roomId: "R1" }];
    const fieldRemoved = applyJsonPatch(job, [{ op: "remove", path: "/constraints/0/roomId" }]);
    expect(fieldRemoved.constraints?.[0]?.roomId).toBeUndefined();

    const elementRemoved = applyJsonPatch(job, [{ op: "remove", path: "/constraints/0" }]);
    expect(elementRemoved.constraints).toEqual([]);
  });

  it("不改动原文档（纯函数）", () => {
    const job = sampleJob();
    const patched = applyJsonPatch(job, [{ op: "replace", path: "/meta/title", value: "新标题" }]);
    expect(job.meta?.title).toBe("测试");
    expect(patched.meta?.title).toBe("新标题");
  });

  it("路径出错时抛中文错误，方便直接展示给老师", () => {
    const job = sampleJob();
    expect(() => applyJsonPatch(job, [{ op: "replace", path: "/rooms/9/rows", value: 7 }])).toThrow(
      /找不到路径/,
    );
    expect(() => applyJsonPatch(job, [{ op: "remove", path: "/rooms/0/nope" }])).toThrow(/不存在/);
    expect(() => applyJsonPatch(job, [{ op: "add", path: "rooms", value: 1 }])).toThrow(
      /必须以 \/ 开头/,
    );
    expect(() =>
      applyJsonPatch(job, [{ op: "replace", path: "/students/5/id", value: "x" }]),
    ).toThrow(/越界|找不到路径/);
  });

  it("jSON Pointer 转义：带 `/` 和 `~` 的键名", () => {
    expect(escapeToken("a/b")).toBe("a~1b");
    expect(escapeToken("a~b")).toBe("a~0b");
    expect(unescapeToken("a~1b~0c")).toBe("a/b~c");
    expect(pointer("constraints", 0, "rows")).toBe("/constraints/0/rows");
    const doc = { "a/b": 1, "c~d": 2 };
    expect(applyJsonPatch(doc, [{ op: "replace", path: pointer("a/b"), value: 3 }])).toEqual({
      "a/b": 3,
      "c~d": 2,
    });
  });

  it("tryApplyPatches 逐条容错：坏补丁不影响好补丁", () => {
    const job = sampleJob();
    const outcome = tryApplyPatches(job, [
      [{ op: "replace", path: "/rooms/0/cols", value: 6 }],
      [{ op: "replace", path: "/rooms/42/cols", value: 6 }],
    ]);
    expect(outcome.doc.rooms[0]?.cols).toBe(6);
    expect(outcome.errors).toHaveLength(1);
  });
});

describe("jSON Patch 原型污染防御（R-4）", () => {
  const dangerous = ["__proto__", "constructor", "prototype"];

  it("回归：add /__proto__/polluted 不再污染 Object.prototype", () => {
    const job = sampleJob();
    expect(() =>
      applyJsonPatch(job, [{ op: "add", path: "/__proto__/polluted", value: "PWNED" }]),
    ).toThrow(/原型链/);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
    // 被修补的文档本身也不该多出这个字段
    expect(Object.hasOwn(applyJsonPatch(job, []), "polluted")).toBe(false);
  });

  it("回归：remove /__proto__/toString 不会删掉原型方法", () => {
    const job = sampleJob();
    expect(() => applyJsonPatch(job, [{ op: "remove", path: "/__proto__/toString" }])).toThrow(
      /原型链/,
    );

    expect(Object.prototype.toString).toBeTypeOf("function");
    expect(Object.hasOwn(Object.prototype, "toString")).toBe(true);
  });

  it("危险段在 add / remove / replace 与顶层 / 嵌套路径上一律被拒", () => {
    const job = sampleJob();
    for (const token of dangerous) {
      for (const op of ["add", "remove", "replace"] as const) {
        for (const path of [`/${token}`, `/options/${token}`, `/${token}/x`, `/rooms/0/${token}`]) {
          expect(
            () => applyJsonPatch(job, [{ op, path, value: "PWNED" }]),
            `${op} ${path}`,
          ).toThrow(/原型链/);
        }
      }
    }
  });

  it("非危险的正常路径不受影响：add / remove / replace 覆盖嵌套对象、数组与数字下标", () => {
    const job = sampleJob();
    const patched = applyJsonPatch(job, [
      { op: "add", path: "/rooms/0/note", value: "靠窗" },
      { op: "replace", path: "/rooms/0/rows", value: 8 },
      { op: "remove", path: "/students/0/className" },
      { op: "add", path: "/students/-", value: { id: "B", name: "李四", className: "二班" } },
      { op: "replace", path: "/constraints/0/studentIds/0", value: "B" },
      { op: "add", path: "/meta/createdAt", value: "2026-01-01" },
    ]);

    expect(patched.rooms[0]).toMatchObject({ rows: 8, note: "靠窗" });
    expect(Object.hasOwn(patched.students[0]!, "className")).toBe(false);
    expect(patched.students).toHaveLength(2);
    expect(patched.students[1]).toMatchObject({ id: "B", className: "二班" });
    expect(patched.constraints?.[0]?.studentIds).toEqual(["B"]);
    expect(patched.meta?.createdAt).toBe("2026-01-01");
  });

  it("存在性只认自有属性：继承来的 toString 不再算「字段存在」", () => {
    const job = sampleJob();
    expect(() =>
      applyJsonPatch(job, [{ op: "replace", path: "/meta/toString", value: "x" }]),
    ).toThrow(/不存在/);
    expect(() => applyJsonPatch(job, [{ op: "remove", path: "/meta/hasOwnProperty" }])).toThrow(
      /不存在/,
    );
    expect(() =>
      applyJsonPatch(job, [{ op: "replace", path: "/meta/toString/x", value: 1 }]),
    ).toThrow(/找不到路径/);
  });
});
