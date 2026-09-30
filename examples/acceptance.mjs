/**
 * 一键验收：把目标里的每条硬指标跑一遍。
 *
 * Node examples/acceptance.mjs
 *
 * 退出码 0 = 全部通过；1 = 有指标没过。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "packages/cli/bin/exam-seat.mjs");
const CLASSES = 18;
const PER_CLASS = 55;
const TOTAL = CLASSES * PER_CLASS;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? `  —— ${detail}` : ""}`);
};

const run = (args, options = {}) =>
  execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });

const runJson = (args) =>
  JSON.parse(run(["--json", ...args], { stdio: ["ignore", "pipe", "ignore"] }));

const work = mkdtempSync(join(tmpdir(), "exam-seat-acceptance-"));

/* ---------- 1. 用法错误要返回退出码 1 ---------- */
const exitOfUsage = (() => {
  try {
    execFileSync(process.execPath, [CLI, "roster"], { stdio: "ignore" });
    return 0;
  } catch (err) {
    return err.status;
  }
})();
check("用法错误返回退出码 1", exitOfUsage === 1, `实际 ${exitOfUsage}`);

execFileSync(
  process.execPath,
  [
    join(ROOT, "examples/make-roster.mjs"),
    join(work, "roster.xlsx"),
    String(CLASSES),
    String(PER_CLASS),
  ],
  { stdio: "ignore" },
);
const roster = runJson(["roster", "--file", join(work, "roster.xlsx")]);
check(
  "Excel 名单导入",
  roster.studentCount === TOTAL,
  `${roster.studentCount} 名学生 / ${roster.classCount} 个班`,
);

/* ---------- 2. 考场配置 ---------- */
const roomCount = Math.ceil(TOTAL / 30);
const rooms = runJson(["rooms", "--spec", `1-${roomCount}:small`]);
check(
  "考场配置生成",
  rooms.seatsTotal >= TOTAL,
  `${rooms.count} 个考场 / ${rooms.seatsTotal} 个座位`,
);

/* ---------- 3. 拼 job 并求解 ---------- */
const byClass = new Map();
for (const s of roster.students) {
  const list = byClass.get(s.className) ?? [];
  list.push(s.id);
  byClass.set(s.className, list);
}
const classNames = [...byClass.keys()].sort();
const job = {
  jobVersion: 2,
  options: { seed: 20260930, adjacency: "king", relax: "none", timeLimitMs: 30_000 },
  students: roster.students,
  rooms: rooms.rooms,
  constraints: [
    {
      id: "C1",
      note: "有作弊前科，坐首排",
      studentIds: classNames.slice(0, 9).map((c) => byClass.get(c)[0]),
      rows: ["first"],
    },
    {
      id: "C2",
      note: "四人四角",
      studentIds: classNames.slice(10, 14).map((c) => byClass.get(c)[1]),
      roomId: "R7",
      rows: ["first", "last"],
      cols: ["door", "window"],
    },
  ],
};
const jobPath = join(work, "job.json");
writeFileSync(jobPath, JSON.stringify(job));

const started = Date.now();
const result = runJson(["plan", "--job", jobPath, "--out-dir", join(work, "out")]);
const elapsed = Date.now() - started;

check(
  "预检通过",
  result.diagnostics.every((d) => d.severity !== "error"),
  "",
);
check("判定级别 strict（未降级）", result.level === "strict", `level=${result.level}`);
check("零冲突", result.stats.conflicts === 0, `冲突 ${result.stats.conflicts}`);
check(
  "全部限定满足",
  result.stats.unmetConstraints === 0,
  `未满足 ${result.stats.unmetConstraints} 人`,
);
check("人人有座", result.entries.length === TOTAL, `${result.entries.length}/${TOTAL} 条`);

/* ---------- 4. 完全独立的暴力复核（不复用 validator） ---------- */
const roomById = new Map(job.rooms.map((r) => [r.id, r]));
const rc = (no, R) => {
  const k = Math.floor((no - 1) / R);
  const off = (no - 1) % R;
  return { row: k % 2 === 0 ? off + 1 : R - off, col: k + 1 };
};
let numberingBad = 0;
let adjacencyBad = 0;
let checkedPairs = 0;
const grids = new Map();
const seenStudent = new Set();
const seenSeat = new Set();
for (const e of result.entries) {
  const room = roomById.get(e.roomId);
  const expect = rc(e.seatNo, room.rows);
  if (expect.row !== e.row || expect.col !== e.col) numberingBad += 1;
  seenStudent.add(e.studentId);
  seenSeat.add(`${e.roomId}:${e.seatNo}`);
  if (!grids.has(e.roomId)) grids.set(e.roomId, new Map());
  grids.get(e.roomId).set(`${expect.row},${expect.col}`, e.className);
}
for (const grid of grids.values()) {
  for (const [key, cls] of grid) {
    const [r, c] = key.split(",").map(Number);
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        if (dr === 0 && dc === 0) continue;
        const other = grid.get(`${r + dr},${c + dc}`);
        if (other === undefined) continue;
        checkedPairs += 1;
        if (other === cls) adjacencyBad += 1;
      }
    }
  }
}
check("蛇形编号与设计一致", numberingBad === 0, `${numberingBad} 处不符`);
check(
  "无重复学生、无重座",
  seenStudent.size === TOTAL && seenSeat.size === TOTAL,
  `${seenStudent.size} 人 / ${seenSeat.size} 座`,
);
check(
  "暴力复核 8 邻域无同班",
  adjacencyBad === 0,
  `复核 ${checkedPairs} 组相邻关系，违规 ${adjacencyBad}`,
);

/* ---------- 5. 导出与独立校验器 ---------- */
const files = readFileSync(join(work, "out", "plan.json"), "utf8");
check("导出 plan.json", files.length > 1000, `${files.length} 字节`);
const validation = runJson([
  "validate",
  "--job",
  jobPath,
  "--plan",
  join(work, "out", "plan.json"),
]);
check("独立校验器通过", validation.ok === true, `${validation.issues.length} 个问题`);

/* ---------- 6. 可复现性 ---------- */
const again = runJson(["plan", "--job", jobPath]);
const same = JSON.stringify(again.entries) === JSON.stringify(result.entries);
check("同 seed 结果可复现", same, same ? "" : "两次结果不一致");

/* ---------- 7. 无解时必须说清楚 ---------- */
const badJob = { ...job, rooms: job.rooms.slice(0, 10) };
const badPath = join(work, "bad.json");
writeFileSync(badPath, JSON.stringify(badJob));
let badExit = 0;
let badOut = "";
try {
  badOut = execFileSync(process.execPath, [CLI, "--json", "plan", "--job", badPath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (err) {
  badExit = err.status;
  badOut = err.stdout ?? "";
}
const badResult = JSON.parse(badOut);
const hasReason = badResult.diagnostics.some((d) => d.code === "CAPACITY_INSUFFICIENT");
const hasFix = badResult.diagnostics.some((d) => d.suggestions.some((s) => s.patch?.length > 0));
check("无解时退出码 3 且 stdout 是合法 JSON", badExit === 3, `exit=${badExit}`);
check("无解时说清原因", hasReason, "CAPACITY_INSUFFICIENT");
check("无解时给出可一键应用的放宽建议", hasFix, "");

/* ---------- 8. 班级数不足时自动退化并告知 ---------- */
const fewClasses = {
  ...job,
  students: job.students
    .slice(0, 90)
    .map((s, i) => ({ ...s, className: `高三(${(i % 3) + 1})班` })),
  rooms: job.rooms.slice(0, 3),
  constraints: [],
};
const fewPath = join(work, "few.json");
writeFileSync(fewPath, JSON.stringify(fewClasses));
const fewResult = runJson(["plan", "--job", fewPath]);
check("班级数 < 9 自动退化到 4 邻域", fewResult.level === "orthogonal", `level=${fewResult.level}`);
check(
  "退化时明确告知用户",
  fewResult.diagnostics.some((d) => d.code === "TOO_FEW_CLASSES"),
  "",
);

/* ---------- 汇总 ---------- */
const failed = results.filter((r) => !r.ok);
console.log();
console.log("─".repeat(56));
console.log(`耗时 ${elapsed}ms ｜ ${TOTAL} 名考生 / ${job.rooms.length} 个考场`);
console.log(`${results.length - failed.length}/${results.length} 项通过`);
if (failed.length > 0) {
  console.log("\n未通过：");
  for (const f of failed) console.log(`  ❌ ${f.name}`);
}
console.log("─".repeat(56));
process.exitCode = failed.length === 0 ? 0 : 1;
