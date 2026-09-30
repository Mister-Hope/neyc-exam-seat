/**
 * 冒烟测试：18 个班、990 人、33 个小考场，要求零冲突。
 *
 * Node examples/smoke.mjs
 */
import { plan } from "../packages/core/dist/index.js";

const CLASSES = 18;
const PER_CLASS = 55;
const ROOM_COUNT = 33;

const rooms = Array.from({ length: ROOM_COUNT }, (_, i) => ({
  id: `R${i + 1}`,
  name: `第${i + 1}考场`,
  rows: 6,
  cols: 5,
  doorSide: "right",
  note: `监考${i + 1}`,
}));

const students = [];
for (let c = 1; c <= CLASSES; c += 1) {
  for (let i = 1; i <= PER_CLASS; i += 1) {
    students.push({
      id: `S${String(c).padStart(2, "0")}-${String(i).padStart(3, "0")}`,
      name: `学生${c}-${i}`,
      className: `高三(${c})班`,
    });
  }
}

const job = {
  jobVersion: 2,
  meta: { title: "冒烟测试" },
  options: { seed: 20260930, adjacency: "king", relax: "none", timeLimitMs: 30_000 },
  students,
  rooms,
  constraints: [
    {
      id: "C1",
      note: "有作弊前科，坐首排",
      studentIds: Array.from({ length: 9 }, (_, i) => `S${String(i + 1).padStart(2, "0")}-001`),
      rows: ["first"],
    },
    {
      id: "C2",
      note: "四人四角",
      studentIds: ["S10-001", "S11-001", "S12-001", "S13-001"],
      roomId: "R7",
      rows: ["first", "last"],
      cols: ["door", "window"],
    },
  ],
};

const started = Date.now();
const result = plan(job);
const elapsed = Date.now() - started;

console.log("=".repeat(64));
console.log("排考场冒烟测试");
console.log("=".repeat(64));
console.log(`考生        ${result.stats.participants}`);
console.log(`班级        ${result.stats.classes}`);
console.log(`考场        ${result.stats.rooms}（实际用到 ${result.stats.roomsUsed}）`);
console.log(`座位        ${result.stats.seatsTotal}，已用 ${result.stats.seatsUsed}`);
console.log(`冲突        ${result.stats.conflicts}`);
console.log(`未满足限定  ${result.stats.unmetConstraints}`);
console.log(`判定级别    ${result.level}`);
console.log(`结果        ${result.ok ? "✅ 完美" : "❌ 未排满"}`);
console.log(`耗时        ${elapsed}ms（内核自报 ${result.stats.elapsedMs}ms）`);
console.log();

const diag = result.diagnostics.filter((d) => d.severity !== "info");
if (diag.length > 0) {
  console.log("诊断：");
  for (const d of diag) console.log(`  [${d.severity}] ${d.code}: ${d.message}`);
  console.log();
}

console.log("四角核对（第7考场）：");
for (const s of ["S10-001", "S11-001", "S12-001", "S13-001"]) {
  const e = result.entries.find((x) => x.studentId === s);
  console.log(
    `  ${s} → ${e.roomName} ${e.seatNo}号（第${e.row}排 业务第${e.col}列 / 物理第${e.physicalCol}列）`,
  );
}

console.log();
console.log("前 12 条名单：");
for (const e of result.entries.slice(0, 12)) {
  console.log(
    `  ${e.roomName.padEnd(6)} ${String(e.seatNo).padStart(2)}号  ${e.studentId}  ${e.name.padEnd(10)} ${e.className}`,
  );
}

process.exit(result.ok ? 0 : 1);
