/**
 * 生成一份假的年级名单 xlsx，用于端到端演练。
 *
 * Node examples/make-roster.mjs [输出路径] [班级数] [每班人数]
 */
import { writeFileSync } from "node:fs";

import * as XLSX from "xlsx";

const out = process.argv[2] ?? "/tmp/roster.xlsx";
const classCount = Number(process.argv[3] ?? 18);
const perClass = Number(process.argv[4] ?? 55);
const SURNAMES = "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜";
const GIVEN = "伟芳娜敏静丽强磊洋艳勇军杰娟涛超明霞平刚桂英建华文博宇轩浩然子涵欣怡";

function pick(text, seed) {
  return text[seed % text.length];
}

const rows = [["学号", "姓名", "班级", "性别"]];
for (let c = 1; c <= classCount; c += 1) {
  for (let i = 1; i <= perClass; i += 1) {
    const seed = c * 977 + i * 131;
    const name = `${pick(SURNAMES, seed)}${pick(GIVEN, seed * 7)}${i % 3 === 0 ? pick(GIVEN, seed * 13) : ""}`;
    rows.push([
      `2026${String(c).padStart(2, "0")}${String(i).padStart(4, "0")}`,
      name,
      `高三(${c})班`,
      seed % 2 === 0 ? "男" : "女",
    ]);
  }
}

const ws = XLSX.utils.aoa_to_sheet(rows);
ws["!cols"] = [{ wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 6 }];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "高三名单");
// 注意：Node 下的 ESM 构建不能用 XLSX.writeFile（需要先 set_fs）。
// 统一用 XLSX.write 拿字节，再自己写文件 —— @exam-seat/io 也是这么做的。
const bytes = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
writeFileSync(out, bytes);
console.log(`已生成 ${out}：${classCount} 个班 × ${perClass} 人 = ${classCount * perClass} 名学生`);
