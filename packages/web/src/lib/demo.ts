import type { Student } from "@exam-seat/core";

/** 示例名单的三种组合：两种常规（物化生 / 政史地）+ 一种跨文理（物化政，会换考场）。 */
const DEMO_COMBINATIONS: { label: string; subjects: string[] }[] = [
  { label: "物化生", subjects: ["physics", "chemistry", "biology"] },
  { label: "政史地", subjects: ["politics", "history", "geography"] },
  { label: "物化政", subjects: ["physics", "chemistry", "politics"] },
];

/**
 * 生成一份示例名单：`classCount` 个班、每班 `perClass` 人，学号 = 年级 + 班级号 + 序号。
 *
 * 每个人都带选科（三种组合循环），这样老师点「载入示例名单」就能直接看到多场次效果。
 */
export function createDemoStudents(classCount = 3, perClass = 24): Student[] {
  const students: Student[] = [];
  for (let c = 1; c <= classCount; c += 1) {
    const className = `高三(${c})班`;
    for (let i = 1; i <= perClass; i += 1) {
      const id = `2026${String(c).padStart(2, "0")}${String(i).padStart(3, "0")}`;
      const combination = DEMO_COMBINATIONS[(c + i) % DEMO_COMBINATIONS.length]!;
      students.push({
        id,
        name: `${"赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许"[c % 20] ?? "李"}${surnameOf(i)}${i}`,
        className,
        combination: combination.label,
        subjects: [...combination.subjects],
      });
    }
  }
  return students;
}

function surnameOf(index: number): string {
  const pool = "子涵雨欣梓萱浩然宇轩思远佳怡";
  return pool[index % pool.length] ?? "明";
}
