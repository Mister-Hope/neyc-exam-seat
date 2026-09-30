import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPTIONS,
  buildJob,
  createEmptyDraft,
  draftFromJob,
  jobFileName,
  parseJob,
  parseJobText,
  serializeJob,
} from "@/lib/job";
import { applyJsonPatch } from "@/lib/json-patch";
import { plan, precheckJob, validate } from "@exam-seat/core";
import type { Job, Student } from "@exam-seat/core";

function makeStudents(count: number, classes = 10): Student[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `2026${String((i % classes) + 1).padStart(2, "0")}${String(i + 1).padStart(3, "0")}`,
    name: `学生${i + 1}`,
    className: `高三(${(i % classes) + 1})班`,
  }));
}

function baseDraft(students = 40) {
  return {
    ...createEmptyDraft(),
    title: "2026届高三一模",
    students: makeStudents(students, 10),
    rooms: [{ id: "R1", name: "第1考场", rows: 6, cols: 5, doorSide: "right" as const }],
  };
}

describe("job.json 契约（core / CLI / Web / AI 的唯一交换格式）", () => {
  it("buildJob 补齐默认 options，并保持 JSON 可序列化", () => {
    const job = buildJob(baseDraft());
    expect(job.jobVersion).toBe(2);
    expect(job.options).toEqual(DEFAULT_OPTIONS);
    expect(job.meta?.title).toBe("2026届高三一模");
    expect(JSON.parse(JSON.stringify(job))).toEqual(job);
  });

  it("导出 → 导入 不丢信息", () => {
    const job = buildJob(baseDraft());
    const roundTrip = parseJobText(serializeJob(job));
    expect(roundTrip).toEqual(job);
  });

  it("draftFromJob 把缺省项补全，再 buildJob 得到等价 job", () => {
    const minimal: Job = {
      students: [{ id: "A", name: "张三", className: "一班", included: false }],
      rooms: [{ id: "R1", rows: 7, cols: 6 }],
    };
    const draft = draftFromJob(minimal);
    expect(draft.options).toEqual(DEFAULT_OPTIONS);
    expect(draft.students[0]?.included).toBe(false);
    const rebuilt = buildJob(draft);
    expect(rebuilt.students).toEqual(minimal.students);
    expect(rebuilt.rooms).toEqual(minimal.rooms);
  });

  it("形状不对时抛中文错误", () => {
    expect(() => parseJobText("{")).toThrow(/不是合法的 JSON/);
    expect(() => parseJobText("[]")).toThrow(/顶层必须是一个 JSON 对象/);
    expect(() => parseJobText('{"rooms":[]}')).toThrow(/students/);
    expect(() => parseJobText('{"students":[],"rooms":[{"id":"R1"}]}')).toThrow(/rows/);
    expect(() => parseJobText('{"students":[{"name":"x","className":"y"}],"rooms":[]}')).toThrow(
      /学号/,
    );
    expect(() =>
      parseJobText(
        '{"students":[],"rooms":[],"constraints":[{"id":"C1","studentIds":[],"rows":["middle"]}]}',
      ),
    ).toThrow(/不合法/);
  });

  it("文件名按考试名称生成，去掉非法字符", () => {
    expect(jobFileName("2026届 高三/一模")).toBe("2026届_高三_一模.job.json");
    expect(jobFileName("")).toBe("exam-seat.job.json");
  });
});

describe("预检建议 → JSON Patch → 回灌 job（Web ↔ CLI ↔ AI 接力）", () => {
  it("容量不足的诊断带可应用补丁，应用后预检就通过", () => {
    const job = buildJob(baseDraft());
    const before = precheckJob(job);
    const capacity = before.diagnostics.find((d) => d.code === "CAPACITY_INSUFFICIENT");
    expect(capacity).toBeDefined();
    expect(before.fatal).toBe(true);
    const suggestion = capacity!.suggestions[0]!;
    expect(suggestion.patch?.length).toBeGreaterThan(0);

    const fixed = applyJsonPatch(job, suggestion.patch!);
    const after = precheckJob(fixed);
    expect(after.diagnostics.some((d) => d.code === "CAPACITY_INSUFFICIENT")).toBe(false);
    expect(after.fatal).toBe(false);
  });

  it("排不出来时 plan() 不用异常表达失败，且不产出 entries", () => {
    const result = plan(buildJob(baseDraft()));
    expect(result.ok).toBe(false);
    expect(result.entries).toEqual([]);
    expect(result.diagnostics.some((d) => d.code === "CAPACITY_INSUFFICIENT")).toBe(true);
  });

  it("修好容量后能真排出来，并且独立校验器认可", () => {
    // 30 人 / 10 个班进 6 列 × 7 排的大考场：留了余量，求解必然收敛
    const patched = applyJsonPatch(buildJob(baseDraft(30)), [
      { op: "replace", path: "/rooms/0/rows", value: 7 },
      { op: "replace", path: "/rooms/0/cols", value: 6 },
    ]);
    const result = plan(patched, { timeLimitMs: 5000 });
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(30);
    // 与导出前同样的安全闸门
    const report = validate(patched, result);
    expect(report.ok).toBe(true);
    // 每个座位号在考场内唯一，且结果按考场 → 座位号排序
    const seatKeys = result.entries.map((entry) => `${entry.roomId}:${entry.seatNo}`);
    expect(new Set(seatKeys).size).toBe(30);
    const sorted = [...result.entries].sort((a, b) => a.seatNo - b.seatNo);
    expect(result.entries).toEqual(sorted);
  });
});

describe("job.json v2：选科 / 地点 / 专用考场 / 选择器都必须无损往返", () => {
  const v2: Job = {
    jobVersion: 2,
    meta: { title: "2026届高三二模" },
    options: { seed: 7, groupPreference: "sameCombination" },
    students: [
      {
        id: "2026010001",
        name: "张伟",
        className: "高三(1)班",
        combination: "物化政",
        subjects: ["physics", "chemistry", "politics"],
        included: true,
      },
      { id: "2026010002", name: "李娜", className: "高三(2)班", combination: "政史地" },
    ],
    rooms: [
      {
        id: "R1",
        name: "第一考场",
        location: "高二一班",
        rows: 6,
        cols: 5,
        doorSide: "right",
        note: "张老师",
        dedicatedSubjects: ["politics", "geography"],
      },
    ],
    constraints: [
      { id: "C1", note: "按班级", classes: ["高三(1)班"], rows: ["first"] },
      { id: "C2", note: "按组合", combinations: ["物化政"], roomId: "R1" },
      { id: "C3", note: "按科目", subjects: ["politics"] },
    ],
  };

  it("导出再导入逐字段相等（不丢 v2 字段）", () => {
    const roundTrip = parseJobText(serializeJob(v2));
    expect(roundTrip).toEqual(v2);
    expect(roundTrip.students[0]?.combination).toBe("物化政");
    expect(roundTrip.rooms[0]?.location).toBe("高二一班");
    expect(roundTrip.rooms[0]?.dedicatedSubjects).toEqual(["politics", "geography"]);
    expect(roundTrip.constraints?.[0]?.classes).toEqual(["高三(1)班"]);
    expect(roundTrip.constraints?.[1]?.combinations).toEqual(["物化政"]);
    expect(roundTrip.constraints?.[2]?.subjects).toEqual(["politics"]);
    // core 还不认识的 options 字段也要带回来（前向兼容，例如草案里的 groupPreference）
    expect((roundTrip.options as Record<string, unknown>).groupPreference).toBe("sameCombination");
    // 没有点名选择器时不要伪造一个空 studentIds
    expect(roundTrip.constraints?.[0]?.studentIds).toBeUndefined();
  });

  it("草稿往返同样不丢字段", () => {
    const draft = draftFromJob(v2);
    const rebuilt = buildJob(draft);
    expect(rebuilt.students).toEqual(v2.students);
    expect(rebuilt.rooms).toEqual(v2.rooms);
    expect(rebuilt.constraints).toEqual(v2.constraints);
    expect(rebuilt.jobVersion).toBe(2);
    expect((rebuilt.options as Record<string, unknown>).groupPreference).toBe("sameCombination");
  });

  it("限定缺 id 时补一个不冲突的 id，AI 生成的 job 也能直接导入", () => {
    const parsed = parseJob({
      students: [{ id: "A", name: "张三", className: "一班" }],
      rooms: [{ id: "R1", rows: 6, cols: 5 }],
      constraints: [{ note: "无 id" }, { id: "C1", note: "占位" }, { note: "又一个无 id" }],
    });
    const ids = (parsed.constraints ?? []).map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(["C1", "C1-2", "C3"]);
  });

  it("一条没有选择器的限定会交给 core 报 CONSTRAINT_NO_SELECTOR，而不是被悄悄丢掉", () => {
    const parsed = parseJob({
      students: [{ id: "A", name: "张三", className: "一班" }],
      rooms: [{ id: "R1", rows: 6, cols: 5 }],
      constraints: [{ id: "C1", note: "空的" }],
    });
    expect(parsed.constraints).toHaveLength(1);
    const pre = precheckJob(parsed);
    expect(pre.diagnostics.some((d) => d.code === "CONSTRAINT_NO_SELECTOR")).toBe(true);
  });
});
