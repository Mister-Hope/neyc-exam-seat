import { describe, expect, it } from "vitest";

import { findRoomSubjectClashes, parseCombination, planAll, validateAll } from "../src/index";
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

/** 某个学生每个有考试的时段实际坐在哪（行/列取自对应座位方案的 entries） */
function seatRc(
  result: ReturnType<typeof planAll>,
  studentId: string,
): { row: number; col: number; roomId: string; subject: string }[] {
  const schedule = result.byStudent.find((s) => s.studentId === studentId)!;
  const out: { row: number; col: number; roomId: string; subject: string }[] = [];
  for (const assignment of Object.values(schedule.slots)) {
    if (!assignment) continue;
    const seating = result.seatings.find(
      (s) =>
        s.roomId === assignment.roomId &&
        (s.subjects.length === 0 || s.subjects.includes(assignment.subject)),
    );
    const entry = seating?.result.entries.find((e) => e.studentId === studentId);
    if (!entry) continue;
    out.push({
      row: entry.row,
      col: entry.col,
      roomId: assignment.roomId,
      subject: assignment.subject,
    });
  }
  return out;
}

/** 四个组合齐备（7 段）；R1 小考场 6×5、R2 大考场 7×6、R3 普通考场，R20/R21 是政治/地理专用考场 */
function constraintJob(perCombo?: Partial<Record<string, number>>): Job {
  const counts: Record<string, number> = {
    物化生: 20,
    政史地: 20,
    物化政: 4,
    物化地: 4,
    ...perCombo,
  };
  const subjectsOf: Record<string, string[]> = {
    物化生: ["physics", "chemistry", "biology"],
    政史地: ["history", "politics", "geography"],
    物化政: ["physics", "chemistry", "politics"],
    物化地: ["physics", "chemistry", "geography"],
  };
  const students: Job["students"] = [];
  let cursor = 1;
  for (const [combination, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i += 1) {
      students.push({
        id: `${combination}-${i}`,
        name: `${combination}${i}`,
        className: `高三(${cursor}班)`,
        combination,
        subjects: subjectsOf[combination],
      });
      cursor = (cursor % 12) + 1;
    }
  }
  return {
    jobVersion: 2,
    options: { seed: 20260930 },
    students,
    rooms: [
      { id: "R1", name: "第一考场", rows: 6, cols: 5 },
      { id: "R2", name: "第二考场", rows: 7, cols: 6 },
      { id: "R3", name: "第三考场", rows: 6, cols: 5 },
      { id: "R4", name: "第四考场", rows: 6, cols: 5 },
      { id: "R20", name: "第二十考场", rows: 6, cols: 5, dedicatedSubjects: ["politics"] },
      { id: "R21", name: "第二十一考场", rows: 6, cols: 5, dedicatedSubjects: ["geography"] },
    ],
  };
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

describe("多场次限定真正生效（CONSTRAINTS_IGNORED_MULTI 退场）", () => {
  it("多场次不再产生 CONSTRAINTS_IGNORED_MULTI，first 限定真的落座首排", () => {
    const job = buildJob(SCENE);
    job.constraints = [
      { id: "C1", note: "前排", studentIds: ["物化生-0", "物化生-1"], rows: ["first"] },
    ];
    const result = planAll(job);

    expect(result.diagnostics.some((d) => d.code === "CONSTRAINTS_IGNORED_MULTI")).toBe(false);
    expect(result.ok).toBe(true);
    for (const id of ["物化生-0", "物化生-1"]) {
      expect(seatRc(result, id).every((rc) => rc.row === 1)).toBe(true);
    }
    // 没被限定的同学不要求首排（随机性下可能恰好也在首排，但至少不是全部）
    expect(result.unmetConstraints).toEqual([]);
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

/** 深拷贝一份结果，用来模拟「手改 plan.json 之后再来校验」 */
function cloneResult<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("多场次限定（议题 4）：真生效、不静默", () => {
  it("rows:first —— 小考场与大考场都坐首排", () => {
    const job = constraintJob();
    job.constraints = [{ id: "C1", studentIds: ["物化生-0", "政史地-0"], rows: ["first"] }];
    const result = planAll(job);
    expect(result.ok).toBe(true);

    const small = seatRc(result, "物化生-0");
    expect(small.length).toBeGreaterThan(0);
    expect(small.every((seat) => seat.roomId === "R1")).toBe(true);
    expect(small.every((seat) => seat.row === 1)).toBe(true);

    const big = seatRc(result, "政史地-0");
    expect(big.every((seat) => seat.roomId === "R2")).toBe(true);
    expect(big.every((seat) => seat.row === 1)).toBe(true);
  });

  it("cols:window —— 小考场第 5 列、大考场第 6 列", () => {
    const job = constraintJob();
    job.constraints = [
      { id: "C1", studentIds: ["物化生-1"], cols: ["window"] },
      { id: "C2", studentIds: ["政史地-1"], cols: ["window"] },
    ];
    const result = planAll(job);
    expect(result.ok).toBe(true);
    expect(seatRc(result, "物化生-1").every((seat) => seat.col === 5)).toBe(true);
    expect(seatRc(result, "政史地-1").every((seat) => seat.col === 6)).toBe(true);
  });

  it("cols:door —— 靠门列就是第 1 列", () => {
    const job = constraintJob();
    job.constraints = [{ id: "C1", studentIds: ["物化生-2"], cols: ["door"] }];
    const result = planAll(job);
    expect(result.ok).toBe(true);
    expect(seatRc(result, "物化生-2").every((seat) => seat.col === 1)).toBe(true);
  });

  it("roomId 指定考场 + 绝对排号：命中学生所有时段都在那个考场", () => {
    const job = constraintJob();
    job.constraints = [{ id: "C1", studentIds: ["政史地-2"], roomId: "R2", rows: [3] }];
    const result = planAll(job);
    expect(result.ok).toBe(true);
    const seats = seatRc(result, "政史地-2");
    expect(seats.length).toBeGreaterThan(0);
    expect(seats.every((seat) => seat.roomId === "R2")).toBe(true);
    expect(seats.every((seat) => seat.row === 3)).toBe(true);
  });

  it("多条限定取交集：first × window 落在靠窗首排", () => {
    const job = constraintJob();
    job.constraints = [{ id: "C1", studentIds: ["物化生-3"], rows: ["first"], cols: ["window"] }];
    const result = planAll(job);
    expect(result.ok).toBe(true);
    expect(seatRc(result, "物化生-3").every((seat) => seat.row === 1 && seat.col === 5)).toBe(true);
  });

  it("组合选择器在多场次同样生效：物化政所有座位都是首排", () => {
    const job = constraintJob({ 物化生: 4, 政史地: 4, 物化政: 4, 物化地: 4 });
    job.constraints = [{ id: "C1", combinations: ["物化政"], rows: ["first"] }];
    const result = planAll(job);
    expect(result.ok).toBe(true);
    const group = result.byStudent.filter((s) => s.combination === "物化政");
    expect(group).toHaveLength(4);
    for (const student of group) {
      const seats = seatRc(result, student.studentId);
      expect(seats.every((seat) => seat.row === 1)).toBe(true);
    }
  });

  it("科目选择器在多场次同样生效：考政治的学生靠门", () => {
    const job = constraintJob({ 物化生: 4, 政史地: 4, 物化政: 4, 物化地: 4 });
    job.constraints = [{ id: "C1", subjects: ["politics"], cols: ["door"] }];
    const result = planAll(job);
    expect(result.ok).toBe(true);
    expect(seatRc(result, "政史地-0").every((seat) => seat.col === 1)).toBe(true);
    expect(seatRc(result, "物化政-0").every((seat) => seat.col === 1)).toBe(true);
  });

  it("限定要求的考场装不下 → 明确报错，不静默改成不限考场", () => {
    const job = constraintJob({ 物化生: 40, 政史地: 5, 物化政: 0, 物化地: 0 });
    job.constraints = [
      {
        id: "C1",
        studentIds: job.students.filter((s) => s.combination === "物化生").map((s) => s.id),
        roomId: "R1",
      },
    ];
    const result = planAll(job);
    expect(result.ok).toBe(false);
    const diag = result.diagnostics.find((d) => d.code === "CONSTRAINT_OVERSATURATED");
    expect(diag).toBeDefined();
    expect(diag!.severity).toBe("error");
    expect(diag!.evidence).toMatchObject({ roomId: "R1" });
  });

  it("roomId 指向学生不会去的考场 → CONSTRAINT_EMPTY_DOMAIN，不静默", () => {
    const job = constraintJob();
    job.constraints = [{ id: "C1", studentIds: ["物化生-0"], roomId: "R20" }];
    const result = planAll(job);
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some(
        (d) => d.code === "CONSTRAINT_EMPTY_DOMAIN" && d.severity === "error",
      ),
    ).toBe(true);
  });

  it("同一学生被要求去两个普通考场 → RULE_INTERSECT_EMPTY", () => {
    const job = constraintJob();
    job.constraints = [
      { id: "C1", studentIds: ["物化生-4"], roomId: "R1" },
      { id: "C2", studentIds: ["物化生-4"], roomId: "R2" },
    ];
    const result = planAll(job);
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some((d) => d.code === "RULE_INTERSECT_EMPTY" && d.severity === "error"),
    ).toBe(true);
  });

  it("限定无法满足时把 unmetConstraints 汇总到多场次层（含考场）", () => {
    const job = constraintJob({ 物化生: 20, 政史地: 0, 物化政: 0, 物化地: 0 });
    job.constraints = [{ id: "C1", studentIds: job.students.map((s) => s.id), rows: ["first"] }];
    const result = planAll(job, { relax: "softConstraints" });

    expect(result.ok).toBe(false);
    expect(result.unmetConstraints.length).toBeGreaterThan(0);
    for (const unmet of result.unmetConstraints) {
      expect(unmet.constraintId).toBe("C1");
      expect(unmet.roomId).toBe("R1");
      expect(unmet.roomName).toBe("第一考场");
      expect(unmet.studentIds.length).toBeGreaterThan(0);
    }
  });

  it("限定不影响同 seed 的可复现性", () => {
    const job = constraintJob();
    job.constraints = [
      { id: "C1", studentIds: ["物化生-0", "政史地-0"], rows: ["first"], cols: ["door"] },
      { id: "C2", combinations: ["物化政"], cols: ["window"] },
    ];
    const first = planAll(job);
    const again = planAll(cloneResult(job));
    expect(again.byStudent).toEqual(first.byStudent);
    expect(again.unmetConstraints).toEqual(first.unmetConstraints);
  });
});

describe("validateAll（议题 5）：与 plan-all 分开实现的独立校验", () => {
  it("正常多场次结果：ok=true、逐 seating 报告齐全", () => {
    const job = constraintJob();
    job.constraints = [{ id: "C1", studentIds: ["物化生-0", "政史地-0"], rows: ["first"] }];
    const result = planAll(job);
    expect(result.ok).toBe(true);

    const report = validateAll(job, result);
    expect(report.ok).toBe(true);
    expect(report.seatings).toHaveLength(result.seatings.length);
    expect(report.hardRuleClashes).toEqual([]);
    expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);
    for (const seating of report.seatings) {
      expect(seating.seats).toBeGreaterThan(0);
      expect(seating.report.ok).toBe(true);
    }
  });

  it("人为把受限学生挪出 allowedSeats → ok=false 且 CONSTRAINT_UNMET", () => {
    const job = constraintJob();
    job.constraints = [{ id: "C1", studentIds: ["物化生-0"], rows: ["first"] }];
    const result = planAll(job);
    const broken = cloneResult(result);
    const seating = broken.seatings.find((s) =>
      s.result.entries.some((e) => e.studentId === "物化生-0"),
    )!;
    const victim = seating.result.entries.find((e) => e.studentId === "物化生-0")!;
    const swap = seating.result.entries.find(
      (e) => e.studentId !== "物化生-0" && e.row !== victim.row,
    )!;
    const parked = {
      seatNo: victim.seatNo,
      row: victim.row,
      col: victim.col,
      physicalCol: victim.physicalCol,
    };
    Object.assign(victim, {
      seatNo: swap.seatNo,
      row: swap.row,
      col: swap.col,
      physicalCol: swap.physicalCol,
    });
    Object.assign(swap, parked);

    const report = validateAll(job, broken);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "CONSTRAINT_UNMET" && i.severity === "error")).toBe(
      true,
    );
  });

  it("人为改出同址两人 → ok=false 且 ENTRY_DUPLICATE_SEAT", () => {
    const job = constraintJob();
    const result = planAll(job);
    const broken = cloneResult(result);
    const seating = broken.seatings.find((s) => s.result.entries.length >= 2)!;
    const first = seating.result.entries[0]!;
    const second = seating.result.entries[1]!;
    Object.assign(second, {
      seatNo: first.seatNo,
      row: first.row,
      col: first.col,
      physicalCol: first.physicalCol,
    });

    const report = validateAll(job, broken);
    expect(report.ok).toBe(false);
    expect(
      report.issues.some((i) => i.code === "ENTRY_DUPLICATE_SEAT" && i.severity === "error"),
    ).toBe(true);
  });

  it("独立复核硬规则：把文科生塞进理科考场同一时段 → ROOM_SUBJECT_CLASH", () => {
    const job = constraintJob();
    const result = planAll(job);
    const broken = cloneResult(result);
    const science = broken.byStudent.find((s) => s.combination === "物化生")!;
    const arts = broken.byStudent.find((s) => s.combination === "政史地")!;
    const bioSlot = broken.slots.find((s) => s.subjects.includes("biology"))!;
    const target = science.slots[bioSlot.id]!;
    arts.slots[bioSlot.id] = {
      ...arts.slots[bioSlot.id]!,
      roomId: target.roomId,
      roomName: target.roomName,
    };

    const report = validateAll(job, broken);
    expect(report.ok).toBe(false);
    expect(report.hardRuleClashes.length).toBeGreaterThan(0);
    expect(report.hardRuleClashes[0]!.subjects).toEqual(["biology", "politics"]);
    expect(report.issues.some((i) => i.code === "ROOM_SUBJECT_CLASH")).toBe(true);
  });

  it("座位方案引用不存在的考场 → ok=false 且 issue 说清", () => {
    const job = constraintJob();
    const result = planAll(job);
    const broken = cloneResult(result);
    broken.seatings[0]!.roomId = "R99";

    const report = validateAll(job, broken);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "ENTRY_UNKNOWN_ROOM")).toBe(true);
  });

  it("没有任何座位方案（全部缺考）→ 不能真空通过", () => {
    const job = constraintJob({ 物化生: 6, 政史地: 0, 物化政: 0, 物化地: 0 });
    for (const student of job.students) student.included = false;
    const result = planAll(job);
    expect(result.seatings).toEqual([]);

    const report = validateAll(job, result);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "NO_STUDENTS" && i.severity === "error")).toBe(
      true,
    );
  });
});
