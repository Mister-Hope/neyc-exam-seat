/**
 * 生成一份假的年级名单 xlsx，用于端到端演练。
 *
 * Node examples/make-roster.mjs [输出路径] [班级数] [每班人数]
 *
 * 列：学号 | 姓名 | 班级 | 性别 | 选科 选科按接近真实的比例铺：多数是常规文理，少量物化政 / 物化地。
 */
import { writeFileSync } from "node:fs";

import * as XLSX from "xlsx";

const out = process.argv[2] ?? "/tmp/roster.xlsx";
const classCount = Number(process.argv[3] ?? 18);
const perClass = Number(process.argv[4] ?? 55);

const SURNAMES = "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜";
const GIVEN = "伟芳娜敏静丽强磊洋艳勇军杰娟涛超明霞平刚桂英建华文博宇轩浩然子涵欣怡";

/** 选科分布：物化生 55% / 政史地 40% / 物化政 3% / 物化地 2%。 用确定性散列挑选，保证每次生成结果一致。 */
const COMBO_TABLE = [
  ...Array.from({ length: 55 }, () => "物化生"),
  ...Array.from({ length: 40 }, () => "政史地"),
  ...Array.from({ length: 3 }, () => "物化政"),
  ...Array.from({ length: 2 }, () => "物化地"),
];

const pick = (text, seed) => text[seed % text.length];

const rows = [["学号", "姓名", "班级", "性别", "选科"]];
for (let c = 1; c <= classCount; c += 1) {
  for (let i = 1; i <= perClass; i += 1) {
    const seed = c * 977 + i * 131;
    const name = `${pick(SURNAMES, seed)}${pick(GIVEN, seed * 7)}${i % 3 === 0 ? pick(GIVEN, seed * 13) : ""}`;
    rows.push([
      `2026${String(c).padStart(2, "0")}${String(i).padStart(4, "0")}`,
      name,
      `高三(${c})班`,
      seed % 2 === 0 ? "男" : "女",
      COMBO_TABLE[seed % COMBO_TABLE.length],
    ]);
  }
}

const ws = XLSX.utils.aoa_to_sheet(rows);
ws["!cols"] = [{ wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 6 }, { wch: 10 }];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "高三名单");
// 注意：Node 下的 ESM 构建不能用 XLSX.writeFile（需要先 set_fs）。
const bytes = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
writeFileSync(out, bytes);

const counts = new Map();
for (const row of rows.slice(1)) counts.set(row[4], (counts.get(row[4]) ?? 0) + 1);
console.log(`已生成 ${out}`);
console.log(`  ${classCount} 个班 × ${perClass} 人 = ${classCount * perClass} 名学生`);
console.log(`  选科分布：${[...counts].map(([k, v]) => `${k} ${v} 人`).join("，")}`);
