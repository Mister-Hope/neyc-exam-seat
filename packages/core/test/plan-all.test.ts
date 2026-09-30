import { describe, expect, it } from "vitest";

import { parseCombination, planAll } from "../src/index";
import type { Job, RoomSpec } from "../src/index";

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
    const main = result.seatings.filter((s) => s.subjects.includes("physics")).at(-1)!;
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
    const {subjects} = parseCombination("物化政");
    expect(subjects).toEqual(["physics", "chemistry", "politics"]);
  });
});
