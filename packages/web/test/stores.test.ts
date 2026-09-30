import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import { useConstraintsStore } from "@/stores/constraints";
import { useOptionsStore } from "@/stores/options";
import { useRoomsStore } from "@/stores/rooms";
import { useRosterStore } from "@/stores/roster";

describe("pinia stores（名单 / 排除、考场、限定）", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("示例名单：18 个班 × 54 人 = 972 人", () => {
    const roster = useRosterStore();
    roster.loadDemo();
    expect(roster.total).toBe(972);
    expect(roster.classCount).toBe(18);
    expect(roster.participants).toBe(972);
    expect(roster.classSizes[0]).toMatchObject({ count: 54 });
  });

  it("排除缺考 = Student.included:false，实际参考随之变化，可整体恢复", () => {
    const roster = useRosterStore();
    roster.loadDemo();
    const ids = roster.students.slice(0, 3).map((student) => student.id);

    roster.setIncluded(ids, false);
    expect(roster.excludedCount).toBe(3);
    expect(roster.participants).toBe(969);
    expect(roster.excludedStudents.map((student) => student.id)).toEqual(ids);
    expect(roster.isIncluded(roster.students[0]!)).toBe(false);

    roster.setIncluded([ids[0]!], true);
    expect(roster.excludedCount).toBe(2);

    roster.includeAll();
    expect(roster.excludedCount).toBe(0);
    // 恢复后不留下 included 字段，导出的 job.json 干净
    expect(roster.students.every((student) => student.included === undefined)).toBe(true);
  });

  it("名单状态会写进 localStorage（刷新不丢）", async () => {
    const roster = useRosterStore();
    roster.loadDemo();
    roster.setIncluded([roster.students[0]!.id], false);
    await nextTick();
    const raw = localStorage.getItem("exam-seat:roster");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { students: { included?: boolean }[] };
    expect(parsed.students[0]?.included).toBe(false);
  });

  it("考场：批量新建、容量合计、重排考场号", () => {
    const rooms = useRoomsStore();
    rooms.replaceRooms([]);
    rooms.addRooms(3, "small");
    expect(rooms.rooms.map((room) => room.id)).toEqual(["R1", "R2", "R3"]);
    expect(rooms.totalSeats).toBe(90);
    expect(rooms.capacityPlan(100).deficit).toBe(10);

    rooms.updateRoom("R2", { rows: 7, cols: 6, note: "张老师" });
    expect(rooms.totalSeats).toBe(102);
    expect(rooms.roomById("R2")?.note).toBe("张老师");

    rooms.move("R3", -1);
    expect(rooms.rooms.map((room) => room.id)).toEqual(["R1", "R3", "R2"]);

    rooms.renumber();
    expect(rooms.rooms.map((room) => room.name)).toEqual(["第1考场", "第2考场", "第3考场"]);

    rooms.removeRoom("R1");
    expect(rooms.rooms).toHaveLength(2);
  });

  it("限定：ID 不冲突、可编辑、可删除，多规则命中同一学生可查", () => {
    const constraints = useConstraintsStore();
    constraints.replaceConstraints([]);
    const first = constraints.addConstraint({ studentIds: ["A"], rows: ["first"] });
    const second = constraints.addConstraint({
      studentIds: ["A", "B"],
      roomId: "R1",
      cols: ["door"],
    });
    expect(first.id).toBe("C1");
    expect(second.id).toBe("C2");
    expect(constraints.constrainedStudentCount).toBe(2);
    expect(constraints.constraintsOfStudent("A")).toHaveLength(2);

    constraints.updateConstraint("C2", { studentIds: ["B"], note: "靠门" });
    expect(constraints.constraintLabel("C2")).toBe("靠门");
    expect(constraints.constraintsOfStudent("A")).toHaveLength(1);

    constraints.removeConstraint("C1");
    expect(constraints.count).toBe(1);
  });

  it("选项：默认值与三种降级设置都能改", () => {
    const options = useOptionsStore();
    options.reset();
    expect(options.options.seed).toBe(20260930);
    options.setRelax("minConflicts");
    options.setForceKing(true);
    options.setTimeLimit(3000);
    expect(options.options).toMatchObject({
      relax: "minConflicts",
      forceKing: true,
      timeLimitMs: 3000,
    });
    options.setRelax("none");
    expect(options.options.relax).toBe("none");
  });
});
