import { describe, expect, it } from "vitest";

import { findRoomSubjectClashes, parseCombination, planAll } from "../src/index";
import type { Job, PlanOptions, RoomSpec } from "../src/index";

const SMALL: Omit<RoomSpec, "id" | "name"> = { rows: 6, cols: 5 };

/** 造一个本校规模的场景： 18 个行政班，混合了四种组合；普通考场若干 + 政治/地理专用考场。 */
function buildJob(perCombo: Record<string, number>): Job {
  const combos = Object.keys(perCombo);
  const students: Job["students"] = [];
  let classCursor = 1;
  for (const combo of combos) {
    const count = perCombo[combo]!;
    for (let i = 0; i < count; i += 1) {
      const className = `高三(${classCursor}班)`;
      classCursor = (classCursor % 18) + 1;
      students.push({
        id: `${combo}-${i}`,
        name: `${combo}${i}`,
        className,
        combination: combo,
      });
    }
  }

  const general: RoomSpec[] = Array.from({ length: 6 }, (_, i) => ({
    id: `R${i + 1}`,
    name: `第${i + 1}考场`,
    location: `高二(${i + 1})班`,
    ...SMALL,
  }));

  return {
    jobVersion: 2,
    students,
    rooms: [
      ...general,
      {
        id: "R20",
        name: "第二十考场",
        location: "生物实验室",
        ...SMALL,
        dedicatedSubjects: ["politics"],
      },
      {
        id: "R21",
        name: "第二十一考场",
        location: "地理教室",
        ...SMALL,
        dedicatedSubjects: ["geography"],
      },
    ],
  };
}

const SCENE = { 物化生: 60, 政史地: 40, 物化政: 10, 物化地: 10 };

function slotWith(
  slots: ReturnType<typeof planAll>["slots"],
  subject: string,
): ReturnType<typeof planAll>["slots"][number] {
  return slots.find((s) => s.subjects.includes(subject))!;
}

describe("多场次排考 planAll", () => {
  const job = buildJob(SCENE);
  const result = planAll(job);

  it("推导出 7 个时段", () => {
    expect(result.slots).toHaveLength(7);
    expect(result.slots.map((s) => s.subjects.join("+"))).toEqual([
      "chinese",
      "math",
      "english",
      "physics+history",
      "chemistry",
      "biology+politics",
      "geography",
    ]);
  });

  it("常规组合整个考试只在一个考场", () => {
    for (const combo of ["物化生", "政史地"]) {
      const group = result.byStudent.filter((s) => s.combination === combo);
      expect(group.length).toBeGreaterThan(0);
      for (const student of group) {
        expect(student.distinctRooms).toBe(1);
      }
    }
  });

  it("非常规组合正好两个考场：主考场 + 专用考场", () => {
    for (const combo of ["物化政", "物化地"]) {
      const group = result.byStudent.filter((s) => s.combination === combo);
      expect(group.length).toBeGreaterThan(0);
      for (const student of group) {
        expect(student.distinctRooms).toBe(2);
      }
    }
  });

  it("没有任何学生超过 3 个考场", () => {
    expect(result.overRoomLimit).toEqual([]);
    for (const student of result.byStudent) expect(student.distinctRooms).toBeLessThanOrEqual(3);
  });

  it("物化政：语数外物化在主考场，政治去专用考场", () => {
    const student = result.byStudent.find((s) => s.combination === "物化政")!;
    const politicsSlot = slotWith(result.slots, "politics");
    const assigned = student.slots[politicsSlot.id]!;
    expect(assigned.subject).toBe("politics");
    expect(assigned.roomId).toBe("R20");
    expect(assigned.location).toBe("生物实验室");

    // 其余五个时段（语数外物化）都在同一个非专用考场
    const elsewhere = result.slots
      .filter((slot) => slot.id !== politicsSlot.id)
      .map((slot) => student.slots[slot.id])
      .filter((a): a is NonNullable<typeof a> => a != null);
    expect(elsewhere).toHaveLength(5);
    const mainRoom = elsewhere[0]!.roomId;
    expect(mainRoom).not.toBe("R20");
    expect(mainRoom).not.toBe("R21");
    for (const a of elsewhere) expect(a.roomId).toBe(mainRoom);
  });

  it("物化政在生物时段缺考，物化地在政治时段缺考", () => {
    const bioSlot = slotWith(result.slots, "biology");
    const politicsSlot = slotWith(result.slots, "politics");
    const geoSlot = slotWith(result.slots, "geography");

    const zhengzhi = result.byStudent.find((s) => s.combination === "物化政")!;
    const dili = result.byStudent.find((s) => s.combination === "物化地")!;

    // 生物和政治在同一个时段：物化政考政治，不考生物
    expect(bioSlot.id).toBe(politicsSlot.id);
    expect(zhengzhi.slots[bioSlot.id]!.subject).toBe("politics");
    // 地理时段物化政没有考试
    expect(zhengzhi.slots[geoSlot.id]).toBeNull();

    // 物化地反过来
    expect(dili.slots[geoSlot.id]!.subject).toBe("geography");
    expect(dili.slots[geoSlot.id]!.roomId).toBe("R21");
    expect(dili.slots[bioSlot.id]).toBeNull();
    expect(dili.slots[politicsSlot.id]).toBeNull();
  });

  it("物化生考满 6 科，地理时段空档", () => {
    const student = result.byStudent.find((s) => s.combination === "物化生")!;
    const filled = Object.values(student.slots).filter(Boolean);
    expect(filled).toHaveLength(6);
    const subjects = filled.map((a) => a!.subject).sort();
    expect(subjects).toEqual(
      ["biology", "chemistry", "chinese", "english", "math", "physics"].sort(),
    );
    expect(student.slots[slotWith(result.slots, "geography").id]).toBeNull();
  });

  it("政史地考满 6 科（含政治和地理），化学时段空档", () => {
    const student = result.byStudent.find((s) => s.combination === "政史地")!;
    const filled = Object.values(student.slots).filter(Boolean);
    expect(filled).toHaveLength(6);
    expect(student.slots[slotWith(result.slots, "chemistry").id]).toBeNull();
    // 政治、地理都在自己的主考场，不去专用考场
    expect(student.slots[slotWith(result.slots, "politics").id]!.roomId).not.toBe("R20");
    expect(student.slots[slotWith(result.slots, "geography").id]!.roomId).not.toBe("R21");
  });

  it("专用考场只装非常规组合的学生", () => {
    const politicsSeating = result.seatings.find((s) => s.roomId === "R20")!;
    expect(politicsSeating.subjects).toEqual(["politics"]);
    for (const id of politicsSeating.studentIds) {
      expect(id.startsWith("物化政-")).toBe(true);
    }
    const geoSeating = result.seatings.find((s) => s.roomId === "R21")!;
    for (const id of geoSeating.studentIds) expect(id.startsWith("物化地-")).toBe(true);
  });

  it("非常规主考场只覆盖语数外物化", () => {
    const main = result.seatings.findLast((s) => s.subjects.includes("physics"))!;
    // 主考场包含语数外 + 物 + 化，但不含生物/政治/地理
    expect(main.subjects).toEqual(
      expect.arrayContaining(["chinese", "math", "english", "physics", "chemistry"]),
    );
    expect(main.subjects).not.toContain("biology");
    expect(main.subjects).not.toContain("politics");
    expect(main.subjects).not.toContain("geography");
  });

  it("每个座位方案内部都零冲突", () => {
    for (const seating of result.seatings) {
      expect(seating.result.ok).toBe(true);
      expect(seating.result.stats.conflicts).toBe(0);
    }
    expect(result.ok).toBe(true);
  });

  it("每个学生的座位号都在自己那套座位方案里", () => {
    for (const seating of result.seatings) {
      for (const id of seating.studentIds) {
        expect(seating.seatNoById[id]).toBeGreaterThan(0);
      }
    }
  });

  it("没用到的考场会被列出来，便于取消", () => {
    // 6 个普通考场，物化生 2 个 + 政史地 2 个 + 非常规主考场 1 个 = 5 个
    expect(result.emptyRooms).toHaveLength(1);
    expect(result.emptyRooms[0]).toMatch(/^第\d+考场$/);
  });

  it("同 seed 结果可复现", () => {
    const again = planAll(buildJob(SCENE));
    expect(again.byStudent).toEqual(result.byStudent);
  });
});

describe("多场次排考的边界情况", () => {
  it("专用考场座位不够时明确报错", () => {
    const job = buildJob({ 物化生: 30, 政史地: 30, 物化政: 40 });
    job.rooms = job.rooms.map((r) => (r.id === "R20" ? { ...r, rows: 1, cols: 1 } : r));
    const result = planAll(job);
    const diag = result.diagnostics.find((d) => d.code === "CONSTRAINT_OVERSATURATED");
    expect(diag).toBeDefined();
    expect(diag!.message).toContain("政治专用考场");
    expect(result.ok).toBe(false);
  });

  it("名单里没有选科信息时退化成普通单场", () => {
    const students = Array.from({ length: 30 }, (_, i) => ({
      id: `S${i}`,
      name: `n${i}`,
      className: `高三(${(i % 10) + 1}班)`,
    }));
    const result = planAll({
      jobVersion: 2,
      students,
      rooms: [{ id: "R1", name: "第一考场", rows: 6, cols: 5 }],
    });
    expect(result.slots).toHaveLength(1);
    expect(result.seatings).toHaveLength(1);
    expect(result.seatings[0]!.result.ok).toBe(true);
    expect(result.byStudent).toHaveLength(30);
    expect(result.byStudent[0]!.distinctRooms).toBe(1);
  });

  it("选了政治但组合是常规（政史地）的学生不去政治专用考场", () => {
    const job = buildJob({ 政史地: 20, 物化政: 5 });
    const result = planAll(job);
    const zhengzhi = result.byStudent.filter((s) => s.combination === "政史地");
    const politicsSlot = slotWith(result.slots, "politics");
    for (const student of zhengzhi) {
      expect(student.slots[politicsSlot.id]!.roomId).not.toBe("R20");
    }
  });

  it("parseCombination 与 planAll 串起来跑得通", () => {
    const { subjects } = parseCombination("物化政");
    expect(subjects).toEqual(["physics", "chemistry", "politics"]);
  });
});

/** 考场 id → 这个考场里出现过的组合集合 */
function combosByRoom(result: ReturnType<typeof planAll>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const seating of result.seatings) {
    const combos = out.get(seating.roomId) ?? new Set<string>();
    for (const id of seating.studentIds) combos.add(id.split("-")[0]!);
    out.set(seating.roomId, combos);
  }
  return out;
}

describe("分房倾向 groupPreference 与「一个考场一个时段只能考一科」（S5）", () => {
  it("默认 sameCombination：常规理与常规文永不共用考场，也没有 ROOMS_SHARED", () => {
    const result = planAll(buildJob(SCENE));
    expect(result.ok).toBe(true);
    expect(result.diagnostics.some((d) => d.code === "ROOMS_SHARED")).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "ROOM_SUBJECT_CLASH")).toBe(false);
    expect(findRoomSubjectClashes(result)).toEqual([]);

    // 常规理与常规文永远不在同一个考场（T4 物理/历史、T6 生物/政治）
    for (const combos of combosByRoom(result).values()) {
      expect(combos.has("物化生") && combos.has("政史地")).toBe(false);
    }
  });

  it("默认 sameCombination：考场不够直接报 CAPACITY_INSUFFICIENT，不偷偷混排", () => {
    const job = buildJob(SCENE);
    // 只留 3 个普通考场：够物化生 2 个，政史地只装得下 1 个
    job.rooms = job.rooms.filter((room) => !["R4", "R5", "R6"].includes(room.id));
    const result = planAll(job);

    const diag = result.diagnostics.find((d) => d.code === "CAPACITY_INSUFFICIENT");
    expect(diag).toBeDefined();
    expect(diag!.severity).toBe("error");
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "ROOMS_SHARED")).toBe(false);
    // 没有为了「塞下」而混排：每套座位仍然只服务一个组合，也没有硬规则违规
    expect(findRoomSubjectClashes(result)).toEqual([]);
    for (const combos of combosByRoom(result).values()) expect(combos.size).toBe(1);
  });

  it("fillRooms：逐时段不冲突的物化政 + 物化地合并进同一考场，并报 ROOMS_SHARED", () => {
    // 四个组合都在 → 时段表稳定为 7 段（T6 生物/政治、T7 地理），便于核对缺考时段
    const job = buildJob({ 物化生: 32, 政史地: 32, 物化政: 10, 物化地: 10 });
    const result = planAll(job, {
      groupPreference: "fillRooms",
      regularCombinations: ["物化生", "政史地", "物化政", "物化地"],
    });

    const shared = result.diagnostics.find((d) => d.code === "ROOMS_SHARED");
    expect(shared).toBeDefined();
    expect(shared!.severity).toBe("warning");
    expect(shared!.evidence!.roomIds).toEqual(["R5"]);
    expect(result.diagnostics.some((d) => d.code === "ROOM_SUBJECT_CLASH")).toBe(false);
    expect(findRoomSubjectClashes(result)).toEqual([]);
    expect(result.ok).toBe(true);

    const merged = result.seatings.find((s) => s.roomId === "R5")!;
    expect(new Set(merged.studentIds.map((id) => id.split("-")[0]))).toEqual(
      new Set(["物化政", "物化地"]),
    );
    expect(merged.studentIds).toHaveLength(20);
    // 合并成一套座位 → 座位号在考场内唯一
    expect(new Set(Object.values(merged.seatNoById)).size).toBe(20);
    // 逐时段最多一门科目
    for (const slot of result.slots) {
      expect(slot.subjects.filter((s) => merged.subjects.includes(s)).length).toBeLessThanOrEqual(
        1,
      );
    }
  });

  it("fillRooms 合并考场：只有一批有考试的时段，另一批为 null 且不落座位", () => {
    const job = buildJob({ 物化生: 32, 政史地: 32, 物化政: 10, 物化地: 10 });
    const result = planAll(job, {
      groupPreference: "fillRooms",
      regularCombinations: ["物化生", "政史地", "物化政", "物化地"],
    });
    const merged = result.seatings.find((s) => s.roomId === "R5")!;
    const bioSlot = slotWith(result.slots, "biology"); // T6 生物/政治
    const geoSlot = slotWith(result.slots, "geography"); // T7 地理
    expect(bioSlot.id).toBe(slotWith(result.slots, "politics").id);
    expect(geoSlot.id).not.toBe(bioSlot.id);

    const inShared = result.byStudent.filter((s) => merged.studentIds.includes(s.studentId));
    const zhengzhi = inShared.find((s) => s.combination === "物化政")!;
    const dili = inShared.find((s) => s.combination === "物化地")!;
    expect(zhengzhi.slots[bioSlot.id]!.subject).toBe("politics");
    expect(zhengzhi.slots[geoSlot.id]).toBeNull();
    expect(dili.slots[bioSlot.id]).toBeNull();
    expect(dili.slots[geoSlot.id]!.subject).toBe("geography");
    // 两人在合并考场里都拿到了座位号，只是缺考时段不落座位
    const seats = [zhengzhi.studentId, dili.studentId].map((id) => merged.seatNoById[id]);
    expect(seats.every((seatNo) => seatNo != null && seatNo > 0)).toBe(true);
  });

  it("fillRooms：兼容批次（常规理 + 非常规主批次）合并，共用一个考场", () => {
    const job = buildJob({ 物化生: 32, 物化政: 20, 物化地: 20 });
    const result = planAll(job, { groupPreference: "fillRooms" });

    expect(result.ok).toBe(true);
    const shared = result.diagnostics.find((d) => d.code === "ROOMS_SHARED");
    expect(shared).toBeDefined();
    expect(shared!.evidence!.roomIds).toEqual(["R2"]);
    expect(findRoomSubjectClashes(result)).toEqual([]);

    // R2 = 物化生 2 + 非常规主批次 28；T6 只有物化生在考生物，逐时段不冲突
    const merged = result.seatings.find((s) => s.roomId === "R2")!;
    const combos = new Set(merged.studentIds.map((id) => id.split("-")[0]));
    expect(combos.has("物化生")).toBe(true);
    expect(combos.has("物化政") || combos.has("物化地")).toBe(true);
    for (const slot of result.slots) {
      expect(slot.subjects.filter((s) => merged.subjects.includes(s)).length).toBeLessThanOrEqual(
        1,
      );
    }
  });

  it("fillRooms：常规理 × 常规文 不兼容，绝不合并（宁可多占一个考场）", () => {
    const job = buildJob({ 物化生: 32, 政史地: 32, 物化政: 6, 物化地: 6 });
    const result = planAll(job, { groupPreference: "fillRooms" });

    expect(result.ok).toBe(true);
    expect(result.diagnostics.some((d) => d.code === "ROOMS_SHARED")).toBe(false);
    expect(findRoomSubjectClashes(result)).toEqual([]);
    // 常规理 × 常规文 永远不在同一考场 —— 即使后面还有空房间也不混排
    for (const present of combosByRoom(result).values()) {
      expect(present.has("物化生") && present.has("政史地")).toBe(false);
    }
    for (const seating of result.seatings) expect(seating.result.ok).toBe(true);
  });

  it("真跑在分房结果上：专用考场被指派同槽两科时报 ROOM_SUBJECT_CLASH 且 ok=false", () => {
    const job = buildJob({ 物化生: 12, 政史地: 12, 物化政: 12, 物化地: 12 });
    // R20 同时当「生物 + 政治」专用考场：两科都在 T6（生物/政治），必然违反硬规则
    job.rooms = job.rooms.map((room) =>
      room.id === "R20"
        ? { ...room, dedicatedSubjects: ["biology", "politics"] }
        : room.id === "R21"
          ? { ...room, dedicatedSubjects: [] }
          : room,
    );
    // 物化生默认是常规组合、不会进专用考场，这里把它挤进非常规，让 biology 有非常规考生
    const result = planAll(job, { regularCombinations: ["政史地"] });

    const clash = result.diagnostics.find((d) => d.code === "ROOM_SUBJECT_CLASH");
    expect(clash).toBeDefined();
    expect(clash!.severity).toBe("error");
    expect(clash!.evidence).toMatchObject({
      roomId: "R20",
      slot: "T6",
      subjects: ["biology", "politics"],
    });
    expect(result.ok).toBe(false);
    expect(findRoomSubjectClashes(result)).toHaveLength(1);
  });

  it("反向：物化生 + 政史地 同考场会被 findRoomSubjectClashes 抓到 T4 / T6", () => {
    const result = planAll(buildJob(SCENE));
    expect(findRoomSubjectClashes(result)).toEqual([]);

    const science = result.seatings.find(
      (s) => s.studentIds.length > 0 && s.studentIds.every((id) => id.startsWith("物化生-")),
    )!;
    const arts = result.seatings.find(
      (s) => s.studentIds.length > 0 && s.studentIds.every((id) => id.startsWith("政史地-")),
    )!;

    // 手工把两套座位塞进同一个考场，模拟「偷偷混排」
    const crafted = {
      slots: result.slots,
      seatings: [
        { ...science, roomId: "X", roomName: "共用考场" },
        { ...arts, roomId: "X", roomName: "共用考场" },
      ],
    };
    const clashes = findRoomSubjectClashes(crafted);
    expect(clashes.map((clash) => clash.slotId)).toEqual(["T4", "T6"]);
    expect(clashes.map((clash) => clash.subjects)).toEqual([
      ["history", "physics"],
      ["biology", "politics"],
    ]);
    for (const clash of clashes) {
      expect(clash.roomId).toBe("X");
      expect(clash.studentIds.length).toBeGreaterThan(0);
    }
  });

  it("groupPreference 未知取值退化为 sameCombination，绝不静默混排", () => {
    const job = buildJob({ 物化生: 45, 政史地: 2, 物化政: 20, 物化地: 20 });
    const options = { groupPreference: "fillroom" } as unknown as PlanOptions;
    const result = planAll(job, options);
    const strict = planAll(job);
    expect(result.diagnostics.some((d) => d.code === "ROOMS_SHARED")).toBe(false);
    expect(result.byStudent).toEqual(strict.byStudent);
  });

  it("fillRooms 下同输入同 seed 结果一致", () => {
    const job = buildJob({ 物化生: 45, 政史地: 2, 物化政: 20, 物化地: 20 });
    const first = planAll(job, { groupPreference: "fillRooms" });
    const again = planAll(job, { groupPreference: "fillRooms" });
    expect(again.byStudent).toEqual(first.byStudent);
    expect(again.seatings.map((s) => s.studentIds)).toEqual(
      first.seatings.map((s) => s.studentIds),
    );
    expect(again.diagnostics).toEqual(first.diagnostics);
  });
});

describe("多场次暂不支持限定：CONSTRAINTS_IGNORED_MULTI", () => {
  it("带 constraints 的多场次：有且仅有一条 warning，且不阻塞 ok", () => {
    const job = buildJob(SCENE);
    job.constraints = [
      { id: "C1", note: "前排", studentIds: ["物化生-0", "物化生-1"], rows: ["first"] },
      { id: "C2", note: "靠窗", classes: ["高三(1班)"], cols: ["window"] },
    ];
    const result = planAll(job);

    const hits = result.diagnostics.filter((d) => d.code === "CONSTRAINTS_IGNORED_MULTI");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.severity).toBe("warning");
    expect(hits[0]!.suggestions.length).toBeGreaterThan(0);

    // 受影响学生数 = 两条选择器命中的去重学生数（独立算一遍）
    const expected = new Set<string>();
    for (const constraint of job.constraints) {
      for (const student of job.students) {
        if (constraint.studentIds?.includes(student.id)) expected.add(student.id);
        if (constraint.classes?.includes(student.className)) expected.add(student.id);
      }
    }
    expect(hits[0]!.evidence).toEqual({ constraints: 2, students: expected.size });
    expect(expected.size).toBeGreaterThan(2);

    // 限定不参与多场次：结果与「同一 job 去掉 constraints」完全一致
    const plain = buildJob(SCENE);
    const withoutConstraints = planAll(plain);
    expect(result.byStudent).toEqual(withoutConstraints.byStudent);
    expect(result.seatings.map((s) => s.studentIds)).toEqual(
      withoutConstraints.seatings.map((s) => s.studentIds),
    );
    expect(result.ok).toBe(true);
  });

  it("不带 constraints 的多场次：没有 CONSTRAINTS_IGNORED_MULTI", () => {
    const result = planAll(buildJob(SCENE));
    expect(result.diagnostics.some((d) => d.code === "CONSTRAINTS_IGNORED_MULTI")).toBe(false);
  });

  it("单场退化模式（没选科）：不产生 CONSTRAINTS_IGNORED_MULTI", () => {
    const job: Job = {
      jobVersion: 2,
      students: Array.from({ length: 12 }, (_, i) => ({
        id: `S${i}`,
        name: `n${i}`,
        className: `高三(${(i % 6) + 1}班)`,
      })),
      rooms: [{ id: "R1", name: "第一考场", rows: 6, cols: 5 }],
      constraints: [{ id: "C1", studentIds: ["S0"], rows: ["first"] }],
    };
    const result = planAll(job);
    expect(result.diagnostics.some((d) => d.code === "CONSTRAINTS_IGNORED_MULTI")).toBe(false);
  });
});

describe("绝不静默成功（C1）：seatings 为空或单场退化时 ok 必须为 false", () => {
  it("所有学生 included:false：ok=false、seatings 为空、明确报 NO_STUDENTS", () => {
    const result = planAll({
      jobVersion: 2,
      options: { seed: 20260930 },
      students: Array.from({ length: 6 }, (_, i) => ({
        id: `X${i + 1}`,
        name: `缺考${i + 1}`,
        className: "高三(1)班",
        combination: "物化生",
        subjects: ["physics", "chemistry", "biology"],
        included: false,
      })),
      rooms: [1, 2, 3].map((n) => ({ id: `R${n}`, name: `第${n}考场`, rows: 6, cols: 5 })),
    });

    expect(result.seatings).toEqual([]);
    expect(result.byStudent).toEqual([]);
    expect(result.ok).toBe(false);
    const diag = result.diagnostics.find((d) => d.code === "NO_STUDENTS");
    expect(diag).toBeDefined();
    expect(diag!.severity).toBe("error");
    expect(diag!.message).toContain("没有需要安排的考生");
  });

  it("有考生但没有任何人选科：ok=false，且明确说明已退化为单场", () => {
    const result = planAll({
      jobVersion: 2,
      students: Array.from({ length: 12 }, (_, i) => ({
        id: `S${i}`,
        name: `n${i}`,
        className: `高三(${(i % 6) + 1}班)`,
      })),
      rooms: [{ id: "R1", name: "第一考场", rows: 6, cols: 5 }],
    });

    // 座位本身排得出来（单场退化），但这不是有效的多场次结果
    expect(result.seatings.length).toBeGreaterThan(0);
    expect(result.seatings[0]!.result.ok).toBe(true);
    expect(result.ok).toBe(false);
    const warning = result.diagnostics.find((d) => d.code === "STUDENT_MISSING_SUBJECTS");
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe("warning");
    expect(warning!.message).toContain("单场");
  });

  it("有考生但没有选科、也没有考场：ok=false，报出错原因而不是真空成功", () => {
    const result = planAll({
      jobVersion: 2,
      students: [{ id: "S1", name: "n1", className: "高三(1)班" }],
      rooms: [],
    });

    expect(result.seatings).toEqual([]);
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some(
        (d) =>
          d.severity === "error" && (d.code === "CAPACITY_INSUFFICIENT" || d.code === "NO_ROOMS"),
      ),
    ).toBe(true);
  });

  it("单场退化但考场装不下：报 CAPACITY_INSUFFICIENT，不静默丢人", () => {
    const result = planAll({
      jobVersion: 2,
      students: Array.from({ length: 40 }, (_, i) => ({
        id: `S${i}`,
        name: `n${i}`,
        className: `高三(${(i % 8) + 1}班)`,
      })),
      rooms: [{ id: "R1", name: "第一考场", rows: 6, cols: 5 }],
    });

    expect(result.ok).toBe(false);
    const diag = result.diagnostics.find((d) => d.code === "CAPACITY_INSUFFICIENT");
    expect(diag).toBeDefined();
    expect(diag!.evidence).toMatchObject({ missingSeats: 10 });
  });
});

describe("非常规批次按逐时段签名拆分（C12）：不再自伤式无解", () => {
  it("政治/地理落在同一时段时，物化政与物化地各自占房（本来可行）", () => {
    const combos: Record<string, string[]> = {
      物化政: ["physics", "chemistry", "politics"],
      物化地: ["physics", "chemistry", "geography"],
    };
    const students: Job["students"] = [];
    for (const [combination, subjects] of Object.entries(combos)) {
      for (let i = 0; i < 20; i += 1) {
        students.push({
          id: `${combination}-${i}`,
          name: `${combination}${i}`,
          className: `高三(${(i % 8) + 1}班)`,
          combination,
          subjects,
        });
      }
    }
    const result = planAll({
      jobVersion: 2,
      options: { seed: 20260930 },
      students,
      rooms: [1, 2].map((n) => ({ id: `R${n}`, name: `第${n}考场`, rows: 6, cols: 5 })),
    });

    // 没有政史地 → politics 与 geography 被推到同一个时段；两批必须分开占房
    const politicsSlot = slotWith(result.slots, "politics");
    expect(politicsSlot.id).toBe(slotWith(result.slots, "geography").id);

    expect(result.diagnostics.some((d) => d.code === "ROOM_SUBJECT_CLASH")).toBe(false);
    expect(findRoomSubjectClashes(result)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.seatings).toHaveLength(2);
    expect(combosByRoom(result).get("R1")).toEqual(new Set(["物化政"]));
    expect(combosByRoom(result).get("R2")).toEqual(new Set(["物化地"]));
    for (const student of result.byStudent) expect(student.distinctRooms).toBe(1);
  });

  it("逐时段不冲突时，物化政 + 物化地仍共用一个非常规主考场", () => {
    const job = buildJob({ 物化生: 30, 政史地: 30, 物化政: 10, 物化地: 10 });
    // 只留政治专用考场：地理回到主考场（T7），与政治（T6）不冲突 → 两批仍应共用
    job.rooms = job.rooms.filter((room) => room.id !== "R21");
    const result = planAll(job);

    expect(result.ok).toBe(true);
    expect(findRoomSubjectClashes(result)).toEqual([]);
    const main = result.seatings.findLast((seating) => seating.subjects.includes("physics"))!;
    const combos = new Set(main.studentIds.map((id) => id.split("-")[0]));
    expect(combos.has("物化政")).toBe(true);
    expect(combos.has("物化地")).toBe(true);

    // 政治仍然去政治专用考场
    const zhengzhi = result.byStudent.find((s) => s.combination === "物化政")!;
    expect(zhengzhi.slots[slotWith(result.slots, "politics").id]!.roomId).toBe("R20");
  });
});
