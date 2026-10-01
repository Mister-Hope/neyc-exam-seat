import { describe, expect, it } from "vitest";

import { plan, planAll, seatNoToRCIn, toPhysicalCol, validate, validateAll } from "../src/index";
import type { Job, PlanResult, RoomSpec, Student } from "../src/index";

/* ------------------------------------------------------------------ */
/* 小样例：4 种组合 + 普通/专用/专属组合考场                              */
/* ------------------------------------------------------------------ */

const COMBO_SUBJECTS: Record<string, string[]> = {
  物化生: ["physics", "chemistry", "biology"],
  史地政: ["history", "geography", "politics"],
  物化政: ["physics", "chemistry", "politics"],
  物化地: ["physics", "chemistry", "geography"],
};

function studentsOf(
  combo: string,
  count: number,
  className: (index: number) => string,
  idPrefix = combo,
): Student[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${idPrefix}-${index}`,
    name: `${combo}${index}`,
    className: className(index),
    combination: combo,
    subjects: [...COMBO_SUBJECTS[combo]!],
  }));
}

function room(
  id: string,
  name: string,
  rows: number,
  cols: number,
  extra: Partial<RoomSpec> = {},
): RoomSpec {
  return { id, name, rows, cols, ...extra };
}

/** 每 8 个人一轮班级，避免同班相邻把用例搞成求解问题 */
const variedClasses = (index: number): string => `25${String((index % 8) + 1).padStart(2, "0")}`;

function jobWith(students: Student[], rooms: RoomSpec[], extra: Partial<Job> = {}): Job {
  return { jobVersion: 2, students, rooms, ...extra };
}

/** 把一套座位还原成一个单房子 job，用于直接调 `validate()` */
function subJobOf(job: Job, roomId: string, studentIds: readonly string[]): Job {
  const byId = new Map(job.students.map((student) => [student.id, student]));
  const students: Student[] = [];
  for (const id of studentIds) {
    const student = byId.get(id);
    if (student) students.push({ ...student });
  }
  return { jobVersion: job.jobVersion, students, rooms: [job.rooms.find((r) => r.id === roomId)!] };
}

describe("专属组合考场（RoomSpec.combination）", () => {
  it("1. 一个考场钉「史地政」：整批只进它，其它组合不受影响，entries 零冲突", () => {
    const job = jobWith(
      [
        ...studentsOf("史地政", 20, variedClasses, "文科"),
        ...studentsOf("物化生", 20, variedClasses, "理科"),
      ],
      [room("R1", "第一考场", 6, 5), room("R2", "第二考场", 6, 5, { combination: "史地政" })],
    );
    const result = planAll(job);

    expect(result.ok).toBe(true);
    const applied = result.diagnostics.find((d) => d.code === "ROOM_COMBINATION_APPLIED")!;
    expect(applied.severity).toBe("info");
    // 写法可任意（史地政 / 政史地），诊断里给规范化后的组合名
    expect(applied.message).toContain("政史地");
    expect(applied.message).toContain("20 人");

    const humanities = result.seatings.find((seating) => seating.roomId === "R2")!;
    expect(humanities.studentIds).toHaveLength(20);
    expect(humanities.studentIds.every((id) => id.startsWith("文科-"))).toBe(true);
    const science = result.seatings.find((seating) => seating.roomId === "R1")!;
    expect(science.studentIds.every((id) => id.startsWith("理科-"))).toBe(true);

    for (const seating of result.seatings) {
      expect(seating.result.ok).toBe(true);
      expect(seating.result.stats.conflicts).toBe(0);
    }
    // 整批全程只在专属考场
    for (const schedule of result.byStudent.filter((s) => s.combination === "政史地")) {
      expect(schedule.distinctRooms).toBe(1);
      expect(schedule.rooms[0]!.roomId).toBe("R2");
    }
    expect(validateAll(job, result).ok).toBe(true);
  });

  it("2a. 两个考场钉同一组合、人数超过单室 → 按考场顺序分流", () => {
    const job = jobWith(studentsOf("物化生", 50, variedClasses), [
      room("R1", "第一考场", 6, 5, { combination: "物化生" }),
      room("R2", "第二考场", 6, 5, { combination: "物化生" }),
    ]);
    const result = planAll(job);

    expect(result.ok).toBe(true);
    expect(result.seatings.find((s) => s.roomId === "R1")!.studentIds).toHaveLength(30);
    expect(result.seatings.find((s) => s.roomId === "R2")!.studentIds).toHaveLength(20);
    // 钉住的考场装得下就不该有缺座/混排
    expect(result.diagnostics.some((d) => d.code === "CAPACITY_INSUFFICIENT")).toBe(false);
    expect(validateAll(job, result).ok).toBe(true);
  });

  it("2b. 只钉一间且装不下 → 走既有缺座路径，不偷偷混排到普通考场", () => {
    const job = jobWith(studentsOf("物化生", 50, variedClasses), [
      room("R1", "第一考场", 6, 5, { combination: "物化生" }),
      room("R2", "第二考场", 6, 5),
    ]);
    const result = planAll(job);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "CAPACITY_INSUFFICIENT")).toBe(true);
    expect(result.seatings.find((s) => s.roomId === "R1")!.studentIds).toHaveLength(30);
    // 没被偷偷塞进普通考场 R2
    expect(result.seatings.some((s) => s.roomId === "R2")).toBe(false);
  });

  it("3. 钉一个名单里不存在的组合 → ROOM_COMBINATION_UNKNOWN，考场空置，结果仍 ok", () => {
    const job = jobWith(
      [
        ...studentsOf("物化生", 20, variedClasses, "理科"),
        ...studentsOf("史地政", 10, variedClasses, "文科"),
      ],
      [
        room("R1", "第一考场", 6, 5),
        room("R2", "第二考场", 6, 5),
        room("R3", "第三考场", 6, 5, { combination: "史生政" }),
      ],
    );
    const result = planAll(job);

    const unknown = result.diagnostics.find((d) => d.code === "ROOM_COMBINATION_UNKNOWN")!;
    expect(unknown.severity).toBe("warning");
    expect(unknown.message).toContain("史生政");
    expect(result.ok).toBe(true);
    expect(result.seatings.some((s) => s.roomId === "R3")).toBe(false);
    expect(result.emptyRooms).toContain("第三考场");
    expect(validateAll(job, result).ok).toBe(true);
  });

  it("4. 同时设 combination 与 dedicatedSubjects → 专属组合优先，专用科目池不含它", () => {
    const job = jobWith(
      [
        ...studentsOf("物化政", 10, variedClasses, "杂"),
        ...studentsOf("物化生", 20, variedClasses, "理"),
      ],
      [
        room("R1", "第一考场", 6, 5),
        room("R2", "第二考场", 6, 5, {
          combination: "物化政",
          dedicatedSubjects: ["politics"],
        }),
        room("R3", "第三考场", 6, 5),
      ],
    );
    const result = planAll(job);

    const ignored = result.diagnostics.find(
      (d) => d.code === "ROOM_COMBINATION_IGNORED_DEDICATED",
    )!;
    expect(ignored.severity).toBe("warning");
    expect(ignored.message).toContain("政治");
    expect(result.ok).toBe(true);

    const seating = result.seatings.find((s) => s.roomId === "R2")!;
    expect(seating.studentIds.every((id) => id.startsWith("杂-"))).toBe(true);
    // 政治的座位并进这套专属组合座位（没有再另开「政治专用考场」座位组）
    expect(seating.subjects).toContain("politics");
    expect(result.seatings.filter((s) => s.subjects.join(",") === "politics")).toHaveLength(0);
    expect(validateAll(job, result).ok).toBe(true);
  });

  it.each(["sameCombination", "fillRooms"] as const)(
    "5. 与「constraints 把该组合钉到同一考场」写法等价（%s）",
    (groupPreference) => {
      const students = [
        ...studentsOf("史地政", 30, variedClasses, "文科"),
        ...studentsOf("物化生", 20, variedClasses, "理科"),
        ...studentsOf("物化政", 8, variedClasses, "政"),
        ...studentsOf("物化地", 6, variedClasses, "地"),
      ];
      const rooms: RoomSpec[] = [
        room("R1", "第一考场", 6, 5),
        room("R2", "第二考场", 6, 5),
        room("R3", "第三考场", 6, 5),
        room("R4", "第四考场", 6, 5),
        room("R5", "第五考场", 6, 5, { dedicatedSubjects: ["politics", "geography"] }),
      ];
      const comboJob = jobWith(
        students,
        rooms.map((r) => (r.id === "R1" ? { ...r, combination: "史地政" } : r)),
        { options: { groupPreference } },
      );
      const constraintJob = jobWith(students, rooms, {
        options: { groupPreference },
        constraints: [{ id: "C1-文科钉R1", combinations: ["史地政"], roomId: "R1" }],
      });

      const withField = planAll(comboJob);
      const withConstraint = planAll(constraintJob);

      expect(withField.ok).toBe(true);
      expect(withConstraint.ok).toBe(true);
      // 新字段不引入语义漂移：连座位号都必须一致
      expect(withField.byStudent).toEqual(withConstraint.byStudent);
      expect(
        withField.seatings.map((s) => ({
          roomId: s.roomId,
          subjects: s.subjects,
          studentIds: s.studentIds,
          seatNoById: s.seatNoById,
        })),
      ).toEqual(
        withConstraint.seatings.map((s) => ({
          roomId: s.roomId,
          subjects: s.subjects,
          studentIds: s.studentIds,
          seatNoById: s.seatNoById,
        })),
      );
    },
  );

  it("6. 同输入同 seed 复现", () => {
    const job = jobWith(
      [
        ...studentsOf("史地政", 24, variedClasses, "文科"),
        ...studentsOf("物化生", 20, variedClasses, "理科"),
      ],
      [room("R1", "第一考场", 6, 5), room("R2", "第二考场", 6, 5, { combination: "史地政" })],
    );
    expect(planAll(job).byStudent).toEqual(planAll(job).byStudent);
  });

  it("7a. 正常结果都通过独立校验（分流 / 未知组合 / 组合+专用科目）", () => {
    const split = jobWith(studentsOf("物化生", 50, variedClasses), [
      room("R1", "第一考场", 6, 5, { combination: "物化生" }),
      room("R2", "第二考场", 6, 5, { combination: "物化生" }),
    ]);
    const unknown = jobWith(
      [
        ...studentsOf("物化生", 20, variedClasses, "理科"),
        ...studentsOf("史地政", 10, variedClasses, "文科"),
      ],
      [
        room("R1", "第一考场", 6, 5),
        room("R2", "第二考场", 6, 5),
        room("R3", "第三考场", 6, 5, { combination: "史生政" }),
      ],
    );
    for (const job of [split, unknown]) {
      const result = planAll(job);
      expect(validateAll(job, result).ok).toBe(true);
      // 单房 validate() 也直接可用
      for (const seating of result.seatings) {
        expect(validate(subJobOf(job, seating.roomId, seating.studentIds), seating.result).ok).toBe(
          true,
        );
      }
    }
  });

  it("7b. 别的组合的学生被搬进专属考场 → ROOM_COMBINATION_MISMATCH", () => {
    const job = jobWith(
      [
        ...studentsOf("史地政", 20, variedClasses, "文科"),
        ...studentsOf("物化生", 20, variedClasses, "理科"),
      ],
      [room("R1", "第一考场", 6, 5), room("R2", "第二考场", 6, 5, { combination: "史地政" })],
    );
    const result = planAll(job);
    // 模拟手改 plan.json：把一名理科生搬到专属文科考场
    const foreign = result.byStudent.find((s) => s.combination === "物化生")!;
    for (const assignment of Object.values(foreign.slots)) {
      if (!assignment) continue;
      assignment.roomId = "R2";
      assignment.roomName = "第二考场";
    }

    const validation = validateAll(job, result);
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((i) => i.code === "ROOM_COMBINATION_MISMATCH")).toBe(true);
  });

  it("7c. 专属组合里的学生被别的限定钉到普通考场 → ROOM_COMBINATION_UNMET", () => {
    const job = jobWith(
      [
        ...studentsOf("史地政", 10, variedClasses, "文科"),
        ...studentsOf("物化生", 10, variedClasses, "理科"),
      ],
      [
        room("R1", "第一考场", 6, 5),
        room("R2", "第二考场", 6, 5, { combination: "史地政" }),
        room("R3", "第三考场", 6, 5),
      ],
      { constraints: [{ id: "C1-个别调整", studentIds: ["文科-0"], roomId: "R3" }] },
    );
    const result = planAll(job);

    const validation = validateAll(job, result);
    expect(validation.ok).toBe(false);
    const unmet = validation.issues.find((i) => i.code === "ROOM_COMBINATION_UNMET")!;
    expect(unmet.refs?.studentId).toBe("文科-0");
  });

  it("7d. 单房 validate() 不再拿被忽略的 combination 判人（单场语义）", () => {
    const job = jobWith(
      [
        ...studentsOf("史地政", 10, variedClasses, "文科"),
        ...studentsOf("物化生", 10, variedClasses, "理科"),
      ],
      [room("R1", "第一考场", 6, 5), room("R2", "第二考场", 6, 5, { combination: "史地政" })],
    );
    const result = planAll(job);
    const seating = result.seatings.find((s) => s.roomId === "R2")!;
    const foreign = job.students.find((s) => s.id === "理科-0")!;
    const roomSpec = job.rooms.find((r) => r.id === "R2")!;
    // 模拟手改 plan.json：把一名理科生写进专属文科考场的一个空位
    const seatNo = 30;
    const rc = seatNoToRCIn(roomSpec, seatNo);
    const forged: PlanResult = {
      ...seating.result,
      entries: [
        ...seating.result.entries,
        {
          studentId: foreign.id,
          name: foreign.name,
          className: foreign.className,
          roomId: "R2",
          roomName: "第二考场",
          seatNo,
          row: rc.row,
          col: rc.col,
          physicalCol: toPhysicalCol(rc.col, roomSpec.cols, roomSpec.doorSide ?? "right"),
        },
      ],
    };
    const byId = new Map(job.students.map((student) => [student.id, student]));
    const subStudents: Student[] = [];
    for (const id of [...seating.studentIds, foreign.id]) subStudents.push({ ...byId.get(id)! });
    const subJob: Job = {
      jobVersion: 2,
      students: subStudents,
      rooms: [roomSpec],
    };
    const report = validate(subJob, forged);
    expect(report.ok).toBe(true);
    expect(report.issues.some((i) => i.code.startsWith("ROOM_COMBINATION_"))).toBe(false);
  });

  it("7e. 被 roomId 显式钉进专属考场的别组合学生：允许（与 constraints 写法一致）", () => {
    // 史生政同学主考场也被钉到文科考场；生物借考走后，他 T4/T7 与史地政同卷，可以合坐
    const gu: Student = {
      id: "借-0",
      name: "借考同学",
      className: "2517",
      combination: "史生政",
      subjects: ["history", "biology", "politics"],
      subjectRoom: { biology: "R3" },
    };
    const job = jobWith(
      [...studentsOf("史地政", 10, variedClasses, "文科"), gu],
      [
        room("R1", "第一考场", 6, 5),
        room("R2", "第二考场", 6, 5, { combination: "史地政" }),
        room("R3", "第三考场", 6, 5),
      ],
      {
        options: { groupPreference: "fillRooms" },
        constraints: [{ id: "C1-个别人也在文科考场", studentIds: [gu.id], roomId: "R2" }],
      },
    );
    const result = planAll(job);

    expect(result.ok).toBe(true);
    const seating = result.seatings.find((s) => s.roomId === "R2")!;
    expect(seating.studentIds).toContain(gu.id);
    const validation = validateAll(job, result);
    expect(validation.ok).toBe(true);
    expect(validation.issues.some((i) => i.code === "ROOM_COMBINATION_MISMATCH")).toBe(false);
  });
});

describe("单场模式：combination 被忽略但不静默（task-22）", () => {
  /** 同一份带选科的 job：单场 `plan()` 与多场次 `planAll()` 两种跑法 */
  function mixedJob(withCombination: boolean): Job {
    return jobWith(
      [
        ...studentsOf("史地政", 10, variedClasses, "文科"),
        ...studentsOf("物化生", 10, variedClasses, "理科"),
      ],
      [
        room("R1", "第一考场", 6, 5, withCombination ? { combination: "史地政" } : {}),
        room("R2", "第二考场", 6, 5),
      ],
    );
  }

  /** 单场：没有任何选科信息的名单 */
  function noSelectionJob(withCombination: boolean): Job {
    return {
      jobVersion: 2,
      students: Array.from({ length: 20 }, (_, index) => ({
        id: `S${String(index).padStart(2, "0")}`,
        name: `学生${index}`,
        className: `高三(${(index % 6) + 1})班`,
      })),
      rooms: [
        room("R1", "第一考场", 6, 5, withCombination ? { combination: "史地政" } : {}),
        room("R2", "第二考场", 6, 5),
      ],
    };
  }

  it("① 单场 plan：ok、有 ROOM_COMBINATION_IGNORED_SINGLE(warning)、不再有 SEARCH_FAILED", () => {
    const result = plan(mixedJob(true));

    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(20);
    const ignored = result.diagnostics.find((d) => d.code === "ROOM_COMBINATION_IGNORED_SINGLE")!;
    expect(ignored).toBeDefined();
    expect(ignored.severity).toBe("warning");
    expect(ignored.message).toContain("第一考场");
    expect(ignored.message).toContain("政史地");
    expect(ignored.message).toContain("不生效");
    expect(result.diagnostics.some((d) => d.code === "SEARCH_FAILED")).toBe(false);
  });

  it("② 单场 validate()：不因为该字段报错", () => {
    const job = mixedJob(true);
    const result = plan(job);

    const report = validate(job, result);
    expect(report.ok).toBe(true);
    expect(report.issues.some((i) => i.code.startsWith("ROOM_COMBINATION_"))).toBe(false);
  });

  it("② 单场 validateAll()：同样不因为该字段报错", () => {
    const job = noSelectionJob(true);
    const all = planAll(job); // 没选科 → 退化单场
    const validation = validateAll(job, all);

    expect(validation.ok).toBe(true);
    expect(validation.issues.some((i) => i.code.startsWith("ROOM_COMBINATION_"))).toBe(false);
  });

  it("③ 同一份 job 的多场次行为不变：APPLIED + 只进专属考场，且不带单场专属诊断", () => {
    const result = planAll(mixedJob(true));

    expect(result.ok).toBe(true);
    expect(result.diagnostics.some((d) => d.code === "ROOM_COMBINATION_APPLIED")).toBe(true);
    expect(result.diagnostics.some((d) => d.code === "ROOM_COMBINATION_IGNORED_SINGLE")).toBe(
      false,
    );
    const seating = result.seatings.find((s) => s.roomId === "R1")!;
    expect(seating.studentIds).toHaveLength(10);
    expect(seating.studentIds.every((id) => id.startsWith("文科-"))).toBe(true);
    // 每套房座位的求解结果里也不该出现「单场忽略」这条
    expect(
      result.seatings.every(
        (item) =>
          !item.result.diagnostics.some((d) => d.code === "ROOM_COMBINATION_IGNORED_SINGLE"),
      ),
    ).toBe(true);
  });

  it("④ 不带 combination 的单场：不产生新诊断", () => {
    const result = plan(mixedJob(false));

    expect(result.ok).toBe(true);
    expect(result.diagnostics.some((d) => d.code.startsWith("ROOM_COMBINATION_"))).toBe(false);
  });
});

/**
 * Task-26：`RoomSpec.combination` 的匹配必须是**完全相等**（归一化后），不是「包含」。
 *
 * 之前的 fixture 组合串都等长、互不为子串，把匹配放宽成 `includes` 时全套测试照样全绿； 这里补互为子串的 fixture，把那类变异钉死。
 */
describe("专属组合必须完全相等（互为子串的 fixture，task-26）", () => {
  const SUBJECTS: Record<string, string[]> = {
    史地: ["history", "geography"],
    史地政: ["history", "geography", "politics"],
    政史地: ["politics", "history", "geography"],
  };

  function customStudents(combination: string, count: number, idPrefix: string): Student[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `${idPrefix}-${index}`,
      name: `${combination}${index}`,
      className: variedClasses(index),
      combination,
      subjects: [...SUBJECTS[combination]!],
    }));
  }

  /** R2 钉一个组合（`roomCombination`），名单里是另一个组合（`studentCombination`）的 6 人 + 6 名物化生 */
  function substringJob(roomCombination: string, studentCombination: string): Job {
    return jobWith(
      [
        ...customStudents(studentCombination, 6, "目标"),
        ...studentsOf("物化生", 6, variedClasses, "理科"),
      ],
      [
        room("R1", "第一考场", 6, 5),
        room("R2", "第二考场", 6, 5, { combination: roomCombination }),
        room("R3", "第三考场", 6, 5),
      ],
    );
  }

  /** 断言「房钉的组合与名单里的组合不相等 → 不收人、UNKNOWN、房空置」 */
  function expectNoMatch(job: Job, normalizedTarget: string): void {
    const result = planAll(job);

    expect(result.diagnostics.some((d) => d.code === "ROOM_COMBINATION_APPLIED")).toBe(false);
    const unknown = result.diagnostics.find((d) => d.code === "ROOM_COMBINATION_UNKNOWN")!;
    expect(unknown).toBeDefined();
    expect(unknown.severity).toBe("warning");
    expect(unknown.evidence).toMatchObject({ roomId: "R2" });

    expect(result.seatings.some((s) => s.roomId === "R2")).toBe(false);
    expect(result.emptyRooms).toContain("第二考场");
    // 目标组合的学生一个都没被错误收进 R2
    const targets = result.byStudent.filter((s) => s.combination === normalizedTarget);
    expect(targets).toHaveLength(6);
    for (const schedule of targets) {
      expect(schedule.rooms.every((usage) => usage.roomId !== "R2")).toBe(true);
    }
    expect(validateAll(job, result).ok).toBe(true);
  }

  it("① 房钉「史地」+ 名单里是「史地政」：互为子串但不相等 → 不收人、UNKNOWN、房空置、ok", () => {
    // 「政史地」包含子串「史地」；放宽成 includes 的实现会把 6 人整批塞进 R2
    const job = substringJob("史地", "史地政");
    const result = planAll(job);

    expect(result.ok).toBe(true);
    expectNoMatch(job, "政史地");
  });

  it("② 反向：房钉「史地政」+ 名单里是「史地」→ 同样不匹配", () => {
    const job = substringJob("史地政", "史地");
    const result = planAll(job);

    expect(result.ok).toBe(true);
    expectNoMatch(job, "史地");
  });

  it("③ 正例对照：房钉「史地政」+ 名单里是「政史地」（写法不同、归一化相等）→ 必须匹配", () => {
    const job = substringJob("史地政", "政史地");
    const result = planAll(job);

    const applied = result.diagnostics.find((d) => d.code === "ROOM_COMBINATION_APPLIED")!;
    expect(applied).toBeDefined();
    expect(applied.message).toContain("政史地");
    expect(result.diagnostics.some((d) => d.code === "ROOM_COMBINATION_UNKNOWN")).toBe(false);
    expect(result.ok).toBe(true);

    const seating = result.seatings.find((s) => s.roomId === "R2")!;
    expect(seating).toBeDefined();
    expect(seating.studentIds).toHaveLength(6);
    expect(seating.studentIds.every((id) => id.startsWith("目标-"))).toBe(true);
    expect(result.emptyRooms).not.toContain("第二考场");
    expect(validateAll(job, result).ok).toBe(true);
  });
});
