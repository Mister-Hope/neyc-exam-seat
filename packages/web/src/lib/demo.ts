import type { Student } from "@exam-seat/core";

/** 生成一份示例名单：`classCount` 个班、每班 `perClass` 人，学号 = 年级 + 班级号 + 序号。 */
export function createDemoStudents(classCount = 18, perClass = 54): Student[] {
  const students: Student[] = [];
  for (let c = 1; c <= classCount; c += 1) {
    const className = `高三(${c})班`;
    for (let i = 1; i <= perClass; i += 1) {
      const id = `2026${String(c).padStart(2, "0")}${String(i).padStart(3, "0")}`;
      students.push({
        id,
        name: `${"赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许"[c % 20] ?? "李"}${surnameOf(i)}${i}`,
        className,
        gender: i % 2 === 0 ? "女" : "男",
      });
    }
  }
  return students;
}

function surnameOf(index: number): string {
  const pool = "子涵雨欣梓萱浩然宇轩思远佳怡";
  return pool[index % pool.length] ?? "明";
}
