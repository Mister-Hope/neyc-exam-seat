/**
 * 把 roster 的 JSON 输出拼成一份完整的 job.json。
 *
 * Node packages/cli/bin/exam-seat.mjs --json roster --file roster.xlsx > roster.json node
 * examples/build-job.mjs roster.json job.json
 */
import { readFileSync, writeFileSync } from "node:fs";

const rosterPath = process.argv[2] ?? "/tmp/roster.json";
const outPath = process.argv[3] ?? "/tmp/job.json";
const roster = JSON.parse(readFileSync(rosterPath, "utf8"));
const { students } = roster;
if (!Array.isArray(students) || students.length === 0) {
  throw new Error("roster.json 里没有 students");
}

const SMALL = { rows: 6, cols: 5 };
const roomCount = Math.ceil(students.length / (SMALL.rows * SMALL.cols));
const rooms = Array.from({ length: roomCount }, (_, i) => ({
  id: `R${i + 1}`,
  name: `第${i + 1}考场`,
  ...SMALL,
  doorSide: "right",
  note: `监考${i + 1}`,
}));

// 造两条真实场景的限定
const byClass = new Map();
for (const s of students) {
  const list = byClass.get(s.className) ?? [];
  list.push(s.id);
  byClass.set(s.className, list);
}
const classes = [...byClass.keys()].sort();

const cheaters = classes.slice(0, 9).map((c) => byClass.get(c)[0]);
const corners = classes.slice(10, 14).map((c) => byClass.get(c)[1]);

const job = {
  jobVersion: 1,
  meta: { title: "2026届高三一模（端到端演练）" },
  options: { seed: 20260930, adjacency: "king", relax: "none", timeLimitMs: 30_000 },
  students,
  rooms,
  constraints: [
    { id: "C1", note: "有作弊前科，坐首排", studentIds: cheaters, rows: ["first"] },
    {
      id: "C2",
      note: "四人坐第7考场四个角",
      studentIds: corners,
      roomId: "R7",
      rows: ["first", "last"],
      cols: ["door", "window"],
    },
  ],
};

writeFileSync(outPath, JSON.stringify(job, null, 2));
console.log(
  `已生成 ${outPath}：${students.length} 名学生、${classes.length} 个班、${rooms.length} 个考场、${job.constraints.length} 条限定`,
);
