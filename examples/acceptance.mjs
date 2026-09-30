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
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(ROOT, "packages/cli/bin/exam-seat.mjs");
const CLASSES = 18;
const PER_CLASS = 55;
const TOTAL = CLASSES * PER_CLASS;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? `  —— ${detail}` : ""}`);
};

const runCli = (args, options = {}) =>
  execFileSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    ...options,
  });

const runJson = (args) => JSON.parse(runCli(["--json", ...args]));

const exitCodeOf = (args) => {
  try {
    execFileSync(process.execPath, [CLI, ...args], { stdio: "ignore" });
    return 0;
  } catch (error) {
    return error.status;
  }
};

const work = mkdtempSync(path.join(tmpdir(), "exam-seat-acceptance-"));

/* ---------- 1. 基础契约 ---------- */
check("用法错误返回退出码 1", exitCodeOf(["roster"]) === 1, "");

execFileSync(
  process.execPath,
  [
    path.join(ROOT, "examples/make-roster.mjs"),
    path.join(work, "roster.xlsx"),
    String(CLASSES),
    String(PER_CLASS),
  ],
  { stdio: "ignore" },
);
const roster = runJson(["roster", "--file", path.join(work, "roster.xlsx")]);
check(
  "Excel 名单导入",
  roster.studentCount === TOTAL,
  `${roster.studentCount} 名学生 / ${roster.classCount} 个班`,
);
check("识别出选科列", roster.mapping.combination !== undefined, "");

const combos = new Map();
for (const s of roster.students) combos.set(s.combination, (combos.get(s.combination) ?? 0) + 1);
check(
  "四种选科组合都能解析",
  combos.size === 4,
  [...combos].map(([k, v]) => `${k}:${v}`).join(" "),
);

/* ---------- 2. 多场次排考 ---------- */
const rosterJsonPath = path.join(work, "roster.json");
const jobPath = path.join(work, "job.json");
const outDir = path.join(work, "out");
writeFileSync(rosterJsonPath, JSON.stringify(roster));
execFileSync(
  process.execPath,
  [path.join(ROOT, "examples/build-job.mjs"), rosterJsonPath, jobPath],
  {
    stdio: "ignore",
  },
);

const job = JSON.parse(readFileSync(jobPath, "utf8"));
const started = Date.now();
const result = runJson(["plan", "--job", jobPath, "--out-dir", outDir]);
const elapsed = Date.now() - started;

check(
  "多场次排考完成",
  result.ok === true,
  `${result.slots.length} 个时段 / ${result.seatings.length} 套座位`,
);
check("时段数 = 7", result.slots.length === 7, result.slots.map((s) => s.id).join(","));
check(
  "物理+历史、生物+政治 自动配对",
  result.slots.some((s) => s.subjects.includes("physics") && s.subjects.includes("history")) &&
    result.slots.some((s) => s.subjects.includes("biology") && s.subjects.includes("politics")),
  "",
);
check(
  "所有座位方案零冲突",
  result.seatings.every((s) => s.result.stats.conflicts === 0),
  "",
);

/* ---------- 3. 每人几个考场 ---------- */
const byCombo = new Map();
for (const student of result.byStudent) {
  const list = byCombo.get(student.combination) ?? [];
  list.push(student.distinctRooms);
  byCombo.set(student.combination, list);
}
check(
  "常规组合全程只在一个考场",
  ["物化生", "政史地"].every((c) => (byCombo.get(c) ?? []).every((n) => n === 1)),
  "物化生 / 政史地 → 1 个",
);
check(
  "非常规组合正好两个考场",
  ["物化政", "物化地"].every((c) => (byCombo.get(c) ?? []).every((n) => n === 2)),
  "物化政 / 物化地 → 2 个",
);
check(
  "没有任何学生超过 3 个考场",
  result.overRoomLimit.length === 0,
  `最多 ${Math.max(...result.byStudent.map((s) => s.distinctRooms))} 个`,
);

/* ---------- 4. 专用考场 ---------- */
const dedicatedRoomIds = new Set(
  job.rooms.filter((r) => (r.dedicatedSubjects ?? []).length > 0).map((r) => r.id),
);
const dedicatedSeatings = result.seatings.filter((s) => dedicatedRoomIds.has(s.roomId));
check("专用考场有座位方案", dedicatedSeatings.length > 0, `${dedicatedSeatings.length} 套`);

// 学号是真实格式（2026010001），所以按组合判断，不能靠学号前缀
const comboOf = new Map(result.byStudent.map((s) => [s.studentId, s.combination]));
const irregularCombos = new Set(["物化政", "物化地"]);
check(
  "专用考场只装非常规组合的学生",
  dedicatedSeatings.every((s) => s.studentIds.every((id) => irregularCombos.has(comboOf.get(id)))),
  "",
);
const politicsSeating = result.seatings.find(
  (s) => dedicatedRoomIds.has(s.roomId) && s.subjects.includes("politics"),
);
check(
  "政治专用考场里的学生确实都选了政治",
  (politicsSeating?.studentIds.length ?? 0) > 0 &&
    politicsSeating.studentIds.every((id) => comboOf.get(id) === "物化政"),
  `${politicsSeating?.studentIds.length ?? 0} 人`,
);

/* ---------- 5. 独立暴力复核：每套座位内部 8 邻域无同班 ---------- */
let numberingBad = 0;
let adjacencyBad = 0;
let checkedPairs = 0;
for (const seating of result.seatings) {
  const room = job.rooms.find((r) => r.id === seating.roomId);
  const grid = new Map();
  for (const entry of seating.result.entries) {
    const k = Math.floor((entry.seatNo - 1) / room.rows);
    const off = (entry.seatNo - 1) % room.rows;
    const row = k % 2 === 0 ? off + 1 : room.rows - off;
    const col = k + 1;
    if (row !== entry.row || col !== entry.col) numberingBad += 1;
    grid.set(`${row},${col}`, entry.className);
  }
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
  "暴力复核 8 邻域无同班",
  adjacencyBad === 0,
  `复核 ${checkedPairs} 组相邻关系，违规 ${adjacencyBad}`,
);

/* ---------- 6. 导出 ---------- */
const classBook = readFileSync(path.join(outDir, "按班级考场安排.xlsx"));
const invigilatorBook = readFileSync(path.join(outDir, "考场监考表.xlsx"));
check("导出按班级考场安排.xlsx", classBook.length > 1000, `${classBook.length} 字节`);
check("导出考场监考表.xlsx", invigilatorBook.length > 1000, `${invigilatorBook.length} 字节`);

const movers = result.byStudent.filter((s) => s.distinctRooms > 1);
check("需要换考场的学生有记录", movers.length > 0, `${movers.length} 人`);
check(
  "空置考场会被列出（便于取消）",
  Array.isArray(result.emptyRooms),
  `${result.emptyRooms.length} 个`,
);
check(
  "同 seed 结果可复现",
  JSON.stringify(result.byStudent) ===
    JSON.stringify(runJson(["plan", "--job", jobPath]).byStudent),
  "",
);

/* ---------- 7. 单场模式仍然可用 ---------- */
const single = runJson(["plan", "--job", jobPath, "--single"]);
check(
  "--single 退化成普通单场",
  single.entries?.length === TOTAL,
  `${single.entries?.length ?? 0} 条`,
);

/* ---------- 8. 失败路径要说清楚 ---------- */
const badPath = path.join(work, "bad.json");
writeFileSync(
  badPath,
  JSON.stringify({
    ...job,
    rooms: job.rooms
      .slice(0, 8)
      .map((r) => ({ id: r.id, name: r.name, rows: r.rows, cols: r.cols })),
  }),
);
let badOut = "";
let badExit = 0;
try {
  badOut = runCli(["--json", "plan", "--job", badPath]);
} catch (error) {
  badExit = error.status;
  badOut = error.stdout ?? "";
}
const badResult = JSON.parse(badOut || "{}");
check("无解时退出码非 0", badExit !== 0, `exit=${badExit}`);
check(
  "无解时说清原因",
  (badResult.diagnostics ?? []).some(
    (d) => d.code === "CAPACITY_INSUFFICIENT" || d.severity === "error",
  ),
  "",
);

/* ---------- 9. 班级数不足时退化并告知 ---------- */
const fewPath = path.join(work, "few.json");
writeFileSync(
  fewPath,
  JSON.stringify({
    jobVersion: 2,
    students: job.students.slice(0, 90).map((s, i) => ({
      id: s.id,
      name: s.name,
      className: `高三(${(i % 3) + 1})班`,
    })),
    rooms: job.rooms
      .slice(0, 3)
      .map((r) => ({ id: r.id, name: r.name, rows: r.rows, cols: r.cols })),
  }),
);
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
  for (const f of failed) console.log(`  ❌ ${f.name}${f.detail ? `  —— ${f.detail}` : ""}`);
}
console.log("─".repeat(56));
process.exitCode = failed.length === 0 ? 0 : 1;
