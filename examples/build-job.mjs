/**
 * 把 roster 的 JSON 输出拼成一份完整的 job.json。
 *
 * Node packages/cli/bin/exam-seat.mjs --json roster --file roster.xlsx > roster.json node
 * examples/build-job.mjs roster.json job.json [普通考场数] [专用考场数]
 *
 * 考场配置：
 *
 * - 若干普通考场（6 排 × 5 列 = 30），带地点与监考
 * - 若干「专用考场」：政治 / 地理共用（这两科不在同一时段，可以同房）
 */
import { readFileSync, writeFileSync } from "node:fs";

const rosterPath = process.argv[2] ?? "/tmp/roster.json";
const outPath = process.argv[3] ?? "/tmp/job.json";
const generalCount = Number(process.argv[4] ?? 0);
const dedicatedCount = Number(process.argv[5] ?? 0);

const roster = JSON.parse(readFileSync(rosterPath, "utf8"));
const { students } = roster;
if (!Array.isArray(students) || students.length === 0) {
  throw new Error("roster.json 里没有 students");
}

const SMALL = { rows: 6, cols: 5 };
const LOCATIONS = [
  "高二(1)班",
  "高二(2)班",
  "高二(3)班",
  "高二(4)班",
  "高二(5)班",
  "高二(6)班",
  "高二(7)班",
  "高二(8)班",
  "物理实验室",
  "化学实验室",
  "生物实验室",
  "地理教室",
  "历史教室",
  "政治教室",
  "阶梯教室",
  "录播教室",
];

const counters = Object.fromEntries(
  ["物化生", "政史地", "物化政", "物化地"].map((c) => [
    c,
    students.filter((s) => s.combination === c).length,
  ]),
);
const regular = counters["物化生"] + counters["政史地"];
const irregular = counters["物化政"] + counters["物化地"];

// 留几个富余，方便演示「哪些考场可以取消」
const totalGeneral = generalCount || Math.ceil(regular / 30) + Math.ceil(irregular / 30) + 2;
// 物化政 / 物化地人数不多，一个专用考场通常够
const totalDedicated = dedicatedCount || Math.max(1, Math.ceil(irregular / 30));

const rooms = [];
for (let i = 1; i <= totalGeneral; i += 1) {
  rooms.push({
    id: `R${i}`,
    name: `第${i}考场`,
    location: LOCATIONS[(i - 1) % LOCATIONS.length],
    ...SMALL,
    note: `监考${i}`,
  });
}
for (let i = 1; i <= totalDedicated; i += 1) {
  const n = totalGeneral + i;
  rooms.push({
    id: `R${n}`,
    name: `第${n}考场`,
    location: "生物实验室",
    ...SMALL,
    note: `监考${n}`,
    dedicatedSubjects: ["politics", "geography"],
  });
}

const job = {
  jobVersion: 2,
  meta: { title: "2026届高三一模（端到端演练）" },
  options: { seed: 20260930, adjacency: "king", relax: "none", timeLimitMs: 30_000 },
  students,
  rooms,
  constraints: [],
};

writeFileSync(outPath, JSON.stringify(job, null, 2));
console.log(`已生成 ${outPath}`);
console.log(`  ${students.length} 名学生，${roster.classCount} 个班`);
console.log(
  `  组合分布：${Object.entries(counters)
    .map(([k, v]) => `${k} ${v}`)
    .join("，")}`,
);
console.log(`  普通考场 ${totalGeneral} 个，专用考场 ${totalDedicated} 个（政治 + 地理共用）`);
