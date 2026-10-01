import { describe, expect, it } from "vitest";

import { findRoomSubjectClashes, planAll, seatNoToRCIn, validateAll } from "../src/index";
import type { Job, RoomSpec, SeatingPlan, Student } from "../src/index";

/* ------------------------------------------------------------------ */
/* 小样例：4 种组合 + 一两个专用/普通考场                                 */
/* ------------------------------------------------------------------ */

const COMBO_SUBJECTS: Record<string, string[]> = {
  物化生: ["physics", "chemistry", "biology"],
  史地政: ["history", "geography", "politics"],
  史地生: ["history", "geography", "biology"],
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

/** 7 段显式时段表（借考用例用它把「哪一科在哪个时段」钉死，断言不受推导顺序影响） */
const SLOTS_7 = [
  { id: "T1", name: "第1时段", subjects: ["chinese"] },
  { id: "T2", name: "第2时段", subjects: ["math"] },
  { id: "T3", name: "第3时段", subjects: ["english"] },
  { id: "T4", name: "第4时段", subjects: ["physics", "history"] },
  { id: "T5", name: "第5时段", subjects: ["chemistry"] },
  { id: "T6", name: "第6时段", subjects: ["biology"] },
  { id: "T7", name: "第7时段", subjects: ["geography"] },
];

function slotWith(slots: ReturnType<typeof planAll>["slots"], subject: string) {
  return slots.find((slot) => slot.subjects.includes(subject))!;
}

/** 23 人同班（2518）钉进 35 座小考场 R17 + 12 名物化生进 R1 */
function relaxJob(relaxSameClass: boolean | number | undefined): Job {
  return {
    jobVersion: 2,
    students: [
      ...studentsOf("史地政", 23, () => "2518", "文科"),
      ...studentsOf("物化生", 12, (index) => `25${String(index + 1).padStart(2, "0")}`, "理科"),
    ],
    rooms: [room("R1", "第一考场", 6, 5), room("R17", "第十七考场", 7, 5, { relaxSameClass })],
    constraints: [{ id: "C1-2518", classes: ["2518"], roomId: "R17" }],
  };
}

/** 某生（史地生）钉在 R2，物化生钉在 R1；他的某科 subjectRoom 去 R1 借考 */
function borrowJob(subjectRoom: Record<string, string>, physicsChemistryBiology = 20): Job {
  const wu: Student = {
    id: "33300001",
    name: "某生",
    className: "2517",
    combination: "史地生",
    subjects: [...COMBO_SUBJECTS["史地生"]!],
    subjectRoom,
  };
  return {
    jobVersion: 2,
    options: { slots: SLOTS_7 },
    students: [
      ...studentsOf(
        "物化生",
        physicsChemistryBiology,
        (index) => `25${String((index % 8) + 1).padStart(2, "0")}`,
        "理科",
      ),
      wu,
    ],
    rooms: [room("R1", "第一考场", 6, 5), room("R2", "第二考场", 6, 5)],
    constraints: [
      { id: "C1-物化生", combinations: ["物化生"], roomId: "R1" },
      { id: "C2-某生", studentIds: ["33300001"], roomId: "R2" },
    ],
  };
}

function seatingOf(result: ReturnType<typeof planAll>, roomId: string): SeatingPlan {
  const seating = result.seatings.find((item) => item.roomId === roomId);
  expect(seating).toBeDefined();
  return seating!;
}

/* ------------------------------------------------------------------ */

describe("考场级放宽「同班相邻」（A）", () => {
  it("relaxSameClass: true —— 23 人同班进 35 座小考场不再 CLASS_LIMIT_EXCEEDED，结果 ok", () => {
    const job = relaxJob(true);
    const result = planAll(job);

    expect(result.diagnostics.some((d) => d.code === "CLASS_LIMIT_EXCEEDED")).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.relaxedRooms).toEqual(["R17"]);

    const relaxed = result.diagnostics.find((d) => d.code === "ROOM_SAME_CLASS_RELAXED")!;
    expect(relaxed.severity).toBe("warning");
    expect(relaxed.evidence).toMatchObject({ roomId: "R17", relaxSameClass: true, limit: 35 });

    const seating = seatingOf(result, "R17");
    expect(seating.studentIds).toHaveLength(23);
    expect(seating.relaxedSameClass).toBe(true);
    expect(seating.result.ok).toBe(true);
    expect(seating.result.stats.conflicts).toBe(0);

    // 独立校验器也只是 warning，不再拦导出
    const validation = validateAll(job, result);
    expect(validation.ok).toBe(true);
    const relaxedIssue = validation.issues.find((issue) => issue.code === "ADJACENCY_RELAXED")!;
    expect(relaxedIssue.severity).toBe("warning");
    expect(validation.issues.some((issue) => issue.code === "ADJACENCY_CONFLICT")).toBe(false);
  });

  it("relaxSameClass: 30（数字版）同理；不给 relax 时仍然报 CLASS_LIMIT_EXCEEDED（回归）", () => {
    const numeric = planAll(relaxJob(30));
    expect(numeric.diagnostics.some((d) => d.code === "CLASS_LIMIT_EXCEEDED")).toBe(false);
    expect(numeric.ok).toBe(true);
    expect(numeric.relaxedRooms).toEqual(["R17"]);
    expect(
      numeric.diagnostics.find((d) => d.code === "ROOM_SAME_CLASS_RELAXED")!.evidence,
    ).toMatchObject({ roomId: "R17", relaxSameClass: 30, limit: 30 });

    const strict = planAll(relaxJob(undefined));
    expect(strict.diagnostics.some((d) => d.code === "CLASS_LIMIT_EXCEEDED")).toBe(true);
    expect(strict.ok).toBe(false);
    expect(strict.relaxedRooms).toEqual([]);
    expect(seatingOf(strict, "R17").relaxedSameClass).toBeUndefined();
  });
});

describe("按科目借考（C）", () => {
  it("某生某科借考到另一个已用考场：byStudent 指向目标考场 + 座位号，其它时段在主考场，不产生第二科", () => {
    const job = borrowJob({ biology: "R1" });
    const result = planAll(job);

    expect(result.ok).toBe(true);
    expect(result.borrowings).toEqual([
      {
        studentId: "33300001",
        name: "某生",
        className: "2517",
        subject: "biology",
        subjectLabel: "生物",
        roomId: "R1",
        roomName: "第一考场",
        seatNo: expect.any(Number),
      },
    ]);
    const applied = result.diagnostics.find((d) => d.code === "SUBJECT_ROOM_APPLIED")!;
    expect(applied.severity).toBe("info");

    const target = seatingOf(result, "R1");
    expect(target.borrowedSubjects).toEqual({ "33300001": ["biology"] });
    expect(target.studentIds).toContain("33300001");
    // 目标座位组里确实有「生物」这张卷子，但该时段仍然只有这一科
    expect(target.subjects).toContain("biology");
    expect(findRoomSubjectClashes(result)).toEqual([]);

    const biologySlot = slotWith(result.slots, "biology").id;
    const wu = result.byStudent.find((s) => s.studentId === "33300001")!;
    const biology = wu.slots[biologySlot]!;
    expect(biology.subject).toBe("biology");
    expect(biology.roomId).toBe("R1");
    expect(biology.seatNo).toBe(result.borrowings[0]!.seatNo);

    // 其余时段（缺考的空档除外）全在钉住的主考场 R2
    for (const [slotId, assignment] of Object.entries(wu.slots)) {
      if (slotId === biologySlot || assignment == null) continue;
      expect(assignment.roomId).toBe("R2");
    }
    expect(wu.distinctRooms).toBe(2);

    const validation = validateAll(job, result);
    expect(validation.ok).toBe(true);
    expect(validation.hardRuleClashes).toEqual([]);
  });

  it("借考冲突：目标考场该时段已考别的科目 → SUBJECT_ROOM_CLASH error 且 ok=false", () => {
    // 第 4 时段是「物理 + 历史」，R1（物化生）那时开考物理；某生的历史借考到 R1 就撞卷子了
    const result = planAll(borrowJob({ history: "R1" }));

    const clash = result.diagnostics.find((d) => d.code === "SUBJECT_ROOM_CLASH")!;
    expect(clash.severity).toBe("error");
    expect(clash.message).toContain("第一考场");
    expect(clash.message).toContain("第4时段");
    expect(clash.message).toContain("历史");
    expect(clash.message).toContain("物理");
    expect(result.ok).toBe(false);
    expect(result.borrowings).toEqual([]);
    // 借考没落地：不会偷偷把历史塞进主考场
    expect(seatingOf(result, "R1").borrowedSubjects).toBeUndefined();
  });

  it("借考容量不足 → SUBJECT_ROOM_NO_SEAT", () => {
    // 30 名物化生正好坐满 6×5 的 R1，某生再借考生物就没位子了
    const result = planAll(borrowJob({ biology: "R1" }, 30));

    const noSeat = result.diagnostics.find((d) => d.code === "SUBJECT_ROOM_NO_SEAT")!;
    expect(noSeat.severity).toBe("error");
    expect(noSeat.message).toContain("第一考场");
    expect(noSeat.evidence).toMatchObject({
      studentId: "33300001",
      subject: "biology",
      roomId: "R1",
    });
    expect(result.ok).toBe(false);
    expect(result.borrowings).toEqual([]);
  });

  it("借考目标考场不存在 / 科目没选 → 明确报错，绝不静默", () => {
    const unknownRoom = planAll(borrowJob({ biology: "R99" }));
    expect(unknownRoom.diagnostics.some((d) => d.code === "SUBJECT_ROOM_UNKNOWN_ROOM")).toBe(true);
    expect(unknownRoom.ok).toBe(false);

    const unknownSubject = planAll(borrowJob({ politics: "R1" }));
    expect(unknownSubject.diagnostics.some((d) => d.code === "SUBJECT_ROOM_UNKNOWN_SUBJECT")).toBe(
      true,
    );
    expect(unknownSubject.ok).toBe(false);
  });

  it("借考的科目不在任何时段里 → SUBJECT_ROOM_NO_SLOT", () => {
    const job = borrowJob({ biology: "R1" });
    // 老师给的时段表里根本没排生物
    job.options!.slots = SLOTS_7.filter((slot) => !slot.subjects.includes("biology"));
    const result = planAll(job);

    const noSlot = result.diagnostics.find((d) => d.code === "SUBJECT_ROOM_NO_SLOT")!;
    expect(noSlot.severity).toBe("error");
    expect(noSlot.message).toContain("生物");
    expect(result.ok).toBe(false);
  });

  it("目标考场完全没用上时，新建一套只含借考生的座位组", () => {
    const job = borrowJob({ biology: "R3" }, 12);
    job.rooms.push(room("R3", "第三考场", 6, 5));
    const result = planAll(job);

    expect(result.ok).toBe(true);
    const target = seatingOf(result, "R3");
    expect(target.studentIds).toEqual(["33300001"]);
    expect(target.subjects).toEqual(["biology"]);
    expect(target.borrowedSubjects).toEqual({ "33300001": ["biology"] });
    expect(result.borrowings[0]).toMatchObject({ roomId: "R3", subject: "biology" });
    expect(result.emptyRooms).not.toContain("第三考场");
    expect(findRoomSubjectClashes(result)).toEqual([]);
  });

  it("主考场里别人也考同一科时，借考优先（不会被主座位组盖掉）", () => {
    const wu: Student = {
      id: "33300001",
      name: "某生",
      className: "2517",
      combination: "史地生",
      subjects: [...COMBO_SUBJECTS["史地生"]!],
      subjectRoom: { biology: "R1" },
    };
    const peer: Student = {
      id: "peer-1",
      name: "小李",
      className: "2517",
      combination: "史地生",
      subjects: [...COMBO_SUBJECTS["史地生"]!],
    };
    const job: Job = {
      jobVersion: 2,
      options: { slots: SLOTS_7 },
      students: [
        ...studentsOf(
          "物化生",
          12,
          (index) => `25${String((index % 8) + 1).padStart(2, "0")}`,
          "理科",
        ),
        wu,
        peer,
      ],
      rooms: [room("R1", "第一考场", 6, 5), room("R2", "第二考场", 6, 5)],
      constraints: [
        { id: "C1-物化生", combinations: ["物化生"], roomId: "R1" },
        { id: "C2-2517", classes: ["2517"], roomId: "R2" },
      ],
    };
    const result = planAll(job);
    expect(result.ok).toBe(true);

    const biologySlot = slotWith(result.slots, "biology").id;
    const wuSchedule = result.byStudent.find((s) => s.studentId === "33300001")!;
    const peerSchedule = result.byStudent.find((s) => s.studentId === "peer-1")!;
    // 主考场 R2 里小李也考生物（R2 的 subjects 含 biology），但某生那一科必须走借考的目标考场
    expect(seatingOf(result, "R2").subjects).toContain("biology");
    expect(wuSchedule.slots[biologySlot]!.roomId).toBe("R1");
    expect(peerSchedule.slots[biologySlot]!.roomId).toBe("R2");
    expect(findRoomSubjectClashes(result)).toEqual([]);
  });

  it("借考座位照常吃 roomId-less 行列限定（靠门列）；排不下就报错，不静默放宽", () => {
    const job = borrowJob({ biology: "R1" });
    job.constraints!.push({ id: "C3-2517靠门", classes: ["2517"], cols: ["door"] });
    const result = planAll(job);

    expect(result.ok).toBe(true);
    const rooms = new Map(job.rooms.map((room) => [room.id, room]));
    const wu = result.byStudent.find((s) => s.studentId === "33300001")!;
    // 主考场与借考考场都必须落在靠门列（按各自考场自己的行列数解析）
    for (const assignment of Object.values(wu.slots)) {
      if (!assignment) continue;
      expect(seatNoToRCIn(rooms.get(assignment.roomId)!, assignment.seatNo).col).toBe(1);
    }
    const biologySlot = slotWith(result.slots, "biology").id;
    expect(wu.slots[biologySlot]!.roomId).toBe("R1");
    expect(seatNoToRCIn(rooms.get("R1")!, wu.slots[biologySlot]!.seatNo).col).toBe(1);
    expect(validateAll(job, result).ok).toBe(true);

    // 限定第 99 列（哪个考场都解析不出来）→ 一个座位都落不下，明确报错
    const impossible = borrowJob({ biology: "R1" });
    impossible.constraints!.push({ id: "C3-第99列", studentIds: ["33300001"], cols: [99] });
    const bad = planAll(impossible);
    expect(bad.diagnostics.some((d) => d.code === "CONSTRAINT_EMPTY_DOMAIN")).toBe(true);
    expect(bad.ok).toBe(false);
    expect(bad.borrowings).toEqual([]);
  });
});

describe("显式时段 / 禁止同段（B）", () => {
  it("给了 slots 就原样采用，并留一条 SLOTS_PROVIDED", () => {
    const result = planAll(borrowJob({ biology: "R1" }, 10));

    expect(result.slots).toEqual(SLOTS_7);
    const provided = result.diagnostics.find((d) => d.code === "SLOTS_PROVIDED")!;
    expect(provided.severity).toBe("info");
    expect(provided.evidence).toMatchObject({ slots: 7 });
  });

  it("同一学生同一时段被排两科 → SLOTS_CONFLICT error 且 ok=false", () => {
    const job: Job = {
      jobVersion: 2,
      options: { slots: [{ id: "T1", name: "第1时段", subjects: ["physics", "chemistry"] }] },
      students: studentsOf("物化生", 6, (index) => `250${index + 1}`),
      rooms: [room("R1", "第一考场", 6, 5)],
    };
    const result = planAll(job);

    const conflict = result.diagnostics.find((d) => d.code === "SLOTS_CONFLICT")!;
    expect(conflict.severity).toBe("error");
    expect(conflict.message).toContain("同一时段");
    expect(result.ok).toBe(false);
  });

  it("forbiddenSameSlot：化学与生物必须分开 → 推导出的 slots 里两者不同段", () => {
    // 这两种组合里没有任何学生同时选化学与生物：不补冲突边时它们可以同段
    const students = [
      ...studentsOf("物化政", 10, (index) => `25${index % 8}`),
      ...studentsOf("史地生", 10, (index) => `25${(index % 8) + 1}`),
    ];
    const rooms = [room("R1", "第一考场", 6, 5), room("R2", "第二考场", 6, 5)];
    const base = planAll({ jobVersion: 2, students, rooms }, { seed: 20260930 });
    const forced = planAll(
      { jobVersion: 2, students, rooms },
      { seed: 20260930, forbiddenSameSlot: [["chemistry", "biology"]] },
    );

    expect(slotWith(forced.slots, "chemistry").id).not.toBe(slotWith(forced.slots, "biology").id);
    // 不补这条边时它们本来可以同段（对照，证明这条边确实起了作用）
    expect(slotWith(base.slots, "chemistry").id).toBe(slotWith(base.slots, "biology").id);
  });
});

describe("分房游标回卷 / 同批两段共用考场（D）", () => {
  function splitJob(preference: "sameCombination" | "fillRooms"): Job {
    const literati = studentsOf("史地政", 28, () => "2518", "文科");
    return {
      jobVersion: 2,
      options: { groupPreference: preference },
      students: [
        ...studentsOf(
          "物化生",
          60,
          (index) => `25${String((index % 8) + 1).padStart(2, "0")}`,
          "理科",
        ),
        ...literati,
      ],
      rooms: [
        room("R1", "第一考场", 6, 5),
        room("R2", "第二考场", 6, 5),
        // 28 人同班（2518）待在一间小教室里 → 必须放宽同班相邻，本用例只考游标行为
        room("R3", "第三考场", 7, 5, { relaxSameClass: true }),
      ],
      constraints: [
        {
          id: "C1-文科钉R3",
          // 只钉住前 22 人：同一批被拆成「钉住的 22 + 未钉住的 6」
          studentIds: literati.slice(0, 22).map((student) => student.id),
          roomId: "R3",
        },
      ],
    };
  }

  it.each(["sameCombination", "fillRooms"] as const)(
    "%s：未钉住的 6 人回到本批次已占用的 R3，不再误报 CAPACITY_INSUFFICIENT",
    (preference) => {
      const result = planAll(splitJob(preference));

      expect(result.diagnostics.some((d) => d.code === "CAPACITY_INSUFFICIENT")).toBe(false);
      expect(result.ok).toBe(true);
      const r3 = seatingOf(result, "R3");
      expect(r3.studentIds).toHaveLength(28);
      expect(r3.subjects).toEqual(
        expect.arrayContaining(["chinese", "math", "english", "history", "geography", "politics"]),
      );
      // 同一次拆分的两段共用一个考场，不算「考场紧张合并」
      expect(result.diagnostics.some((d) => d.code === "ROOMS_SHARED")).toBe(false);
    },
  );

  it("回归：没有钉住人的不同批次仍然各自独占考场（sameCombination）", () => {
    const job: Job = {
      jobVersion: 2,
      students: [
        ...studentsOf("物化生", 20, (index) => `25${(index % 8) + 1}`, "理科"),
        ...studentsOf("史地政", 20, (index) => `26${(index % 8) + 1}`, "文科"),
      ],
      rooms: [room("R1", "第一考场", 6, 5), room("R2", "第二考场", 6, 5)],
    };
    const result = planAll(job);

    expect(result.ok).toBe(true);
    expect(result.diagnostics.some((d) => d.code === "ROOMS_SHARED")).toBe(false);
    const used = result.seatings.filter((seating) => seating.studentIds.length > 0);
    expect(used).toHaveLength(2);
    // 一个考场里只有一个批次：不会出现「物理 + 历史」这种两条批次同房的科目并集
    for (const seating of used) {
      const hasPhysics = seating.subjects.includes("physics");
      const hasHistory = seating.subjects.includes("history");
      expect(hasPhysics).not.toBe(hasHistory);
    }
  });
});

describe("可复现性", () => {
  it("同输入同 seed 跑两次结果完全一致（放宽 + 借考 + 显式时段）", () => {
    const run = () => {
      const job = borrowJob({ biology: "R1" });
      job.rooms[0]!.relaxSameClass = true;
      const result = planAll(job);
      return {
        ok: result.ok,
        slots: result.slots,
        relaxedRooms: result.relaxedRooms,
        borrowings: result.borrowings,
        byStudent: result.byStudent,
        diagnostics: result.diagnostics.map((d) => ({ code: d.code, message: d.message })),
        seatings: result.seatings.map((seating) => ({
          roomId: seating.roomId,
          subjects: seating.subjects,
          studentIds: seating.studentIds,
          seatNoById: seating.seatNoById,
          borrowedSubjects: seating.borrowedSubjects,
          relaxedSameClass: seating.relaxedSameClass,
          conflictCodes: seating.result.diagnostics.map((d) => d.code),
        })),
      };
    };

    expect(run()).toEqual(run());
  });
});
