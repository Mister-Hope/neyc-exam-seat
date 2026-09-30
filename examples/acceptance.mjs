/**
 * 一键验收：把目标里的每条硬指标跑一遍。
 *
 * Node examples/acceptance.mjs
 *
 * 退出码 0 = 全部通过；1 = 有指标没过。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { read as readWorkbook, utils as xlsxUtils, write as writeWorkbook } from "xlsx";

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

/** 跑一次 CLI，同时拿到 stdout / stderr / 退出码（--json 模式下日志走 stderr）。 */
const runFull = (args) => {
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  return { stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", status: proc.status };
};

const readTextIfExists = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const readJsonIfExists = (file) => {
  const text = readTextIfExists(file);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const fileSize = (file) => {
  try {
    return readFileSync(file).length;
  } catch {
    return -1;
  }
};

/* ------------------------------------------------------------------ *
 * 独立校验器（本节全部由验收脚本自己实现，不调用 core 的任何校验函数）
 * ------------------------------------------------------------------ */

/** 把多场次结果摊成「考场 × 时段 → 实际开考的科目」，数据只取 byStudent.slots。 */
function roomSlotSubjects(result) {
  const rooms = new Map(); // roomId → Map(slotId → Map(subject → studentIds))
  for (const student of result.byStudent ?? []) {
    for (const [slotId, item] of Object.entries(student.slots ?? {})) {
      if (!item) continue;
      let slots = rooms.get(item.roomId);
      if (!slots) {
        slots = new Map();
        rooms.set(item.roomId, slots);
      }
      let subjects = slots.get(slotId);
      if (!subjects) {
        subjects = new Map();
        slots.set(slotId, subjects);
      }
      const key = item.subject ?? "";
      const list = subjects.get(key) ?? [];
      list.push(student.studentId);
      subjects.set(key, list);
    }
  }
  return rooms;
}

/** 硬规则：同一考场同一时段只允许出现一门科目。 */
function hardRuleViolations(result) {
  const bad = [];
  for (const [roomId, slots] of roomSlotSubjects(result)) {
    for (const [slotId, subjects] of slots) {
      if (subjects.size > 1) {
        bad.push(
          `${roomId} @ ${slotId}：${[...subjects.keys()].map((s) => s || "(无科目)").join(" + ")}`,
        );
      }
    }
  }
  return bad;
}

/** 座位方案自带的 subjects 必须与该方案学生实际考试的科目一致，且每时段仍只有一科。 */
function seatingSubjectViolations(result) {
  const byId = new Map((result.byStudent ?? []).map((s) => [s.studentId, s]));
  const bad = [];
  for (const seating of result.seatings ?? []) {
    const perSlot = new Map(); // slotId → Set(subject)
    for (const id of seating.studentIds ?? []) {
      const student = byId.get(id);
      if (!student) {
        bad.push(`${seating.roomId}：座位方案里的 ${id} 不在 byStudent 里`);
        continue;
      }
      for (const [slotId, item] of Object.entries(student.slots ?? {})) {
        if (!item || item.roomId !== seating.roomId) continue;
        if ((seating.subjects ?? []).length > 0 && !seating.subjects.includes(item.subject)) {
          bad.push(`${seating.roomId} @ ${slotId}：科目 ${item.subject} 不在 seating.subjects 里`);
        }
        const set = perSlot.get(slotId) ?? new Set();
        set.add(item.subject);
        perSlot.set(slotId, set);
      }
    }
    for (const [slotId, set] of perSlot) {
      if (set.size > 1) bad.push(`${seating.roomId} 座位方案 @ ${slotId}：${[...set].join(" + ")}`);
    }
  }
  return bad;
}

/** 常规组合（物化生 / 政史地）与非常规组合不能共用一个考场。 */
const REGULAR_COMBINATIONS = new Set(["物化生", "政史地"]);

function roomCombinationMixViolations(result) {
  const rooms = new Map(); // roomId → Set(combination)
  for (const student of result.byStudent ?? []) {
    const used = new Set(
      Object.values(student.slots ?? {})
        .filter(Boolean)
        .map((item) => item.roomId),
    );
    for (const roomId of used) {
      const set = rooms.get(roomId) ?? new Set();
      set.add(student.combination ?? "(无选科)");
      rooms.set(roomId, set);
    }
  }
  const bad = [];
  for (const [roomId, combos] of rooms) {
    const regular = [...combos].some((c) => REGULAR_COMBINATIONS.has(c));
    const irregular = [...combos].some((c) => c !== "(无选科)" && !REGULAR_COMBINATIONS.has(c));
    if (regular && irregular) bad.push(`${roomId}：${[...combos].join(" + ")}`);
  }
  return bad;
}

/** 同一考场同一时段的座位号不能重复（两人坐一座）。 */
function seatCollisions(result) {
  const seen = new Map(); // `roomId|slotId` → Map(seatNo → studentId)
  const bad = [];
  for (const student of result.byStudent ?? []) {
    for (const [slotId, item] of Object.entries(student.slots ?? {})) {
      if (!item) continue;
      const key = `${item.roomId}|${slotId}`;
      let seats = seen.get(key);
      if (!seats) {
        seats = new Map();
        seen.set(key, seats);
      }
      if (seats.has(item.seatNo)) {
        bad.push(`${key} 座位 ${item.seatNo}：${seats.get(item.seatNo)} / ${student.studentId}`);
      } else {
        seats.set(item.seatNo, student.studentId);
      }
    }
  }
  return bad;
}

const diagnosticCodes = (result) => (result.diagnostics ?? []).map((d) => d.code);

const CORE_SUBJECT_IDS = ["chinese", "math", "english"];
const COMBO_SUBJECT_IDS = {
  物化生: ["physics", "chemistry", "biology"],
  政史地: ["politics", "history", "geography"],
  物化政: ["physics", "chemistry", "politics"],
  物化地: ["physics", "chemistry", "geography"],
};

/** 学生自己的选科科目：优先用 job 里的 subjects，否则按 combination 原文查表。 */
const ownSubjectsOf = (student) =>
  (student.subjects ?? []).length > 0
    ? student.subjects
    : (COMBO_SUBJECT_IDS[student.combination] ?? []);

/** 应考却没有任何座位的学生（用 job 的选科 + byStudent.slots 独立推导）。 */
function unarrangedStudents(result, job) {
  const byId = new Map((result.byStudent ?? []).map((student) => [student.studentId, student]));
  const rows = [];
  for (const student of job.students ?? []) {
    if (student.included === false) continue;
    const schedule = byId.get(student.id);
    const own = new Set([...CORE_SUBJECT_IDS, ...ownSubjectsOf(student)]);
    const missing = [];
    for (const slot of result.slots ?? []) {
      if (!slot.subjects.some((subject) => own.has(subject))) continue;
      // 完全没进 byStudent 的学生 = 所有应考时段都没排
      if (!schedule?.slots?.[slot.id]) missing.push(slot.id);
    }
    if (missing.length > 0) {
      rows.push({ studentId: student.id, combination: student.combination ?? null, missing });
    }
  }
  return rows;
}

/** 每人每时段实际安排的科目必须是自己选的（多场次 byStudent 科目映射复核）。 */
function studentSubjectViolations(result, job) {
  const byId = new Map((result.byStudent ?? []).map((student) => [student.studentId, student]));
  const bad = [];
  for (const student of job.students ?? []) {
    if (student.included === false) continue;
    const schedule = byId.get(student.id);
    const own = new Set([...CORE_SUBJECT_IDS, ...ownSubjectsOf(student)]);
    for (const slot of result.slots ?? []) {
      const expected = slot.subjects.filter((subject) => own.has(subject));
      const assigned = schedule?.slots?.[slot.id] ?? null;
      if (expected.length === 0) {
        if (assigned) bad.push(`${student.id} @ ${slot.id} 没有考试却排在 ${assigned.roomId}`);
      } else if (!schedule) {
        bad.push(`${student.id} @ ${slot.id} 应考 ${expected.join("/")} 却没进任何座位方案`);
      } else if (!assigned) {
        bad.push(`${student.id} @ ${slot.id} 应考 ${expected.join("/")} 却没排`);
      } else if (!expected.includes(assigned.subject)) {
        bad.push(
          `${student.id} @ ${slot.id} 考了 ${assigned.subject}，不是他选的 ${expected.join("/")}`,
        );
      }
    }
  }
  return bad;
}

/** 考场 → 在该考场考过试的组合集合。 */
function roomCombinations(result) {
  const rooms = new Map();
  for (const student of result.byStudent ?? []) {
    const used = new Set(
      Object.values(student.slots ?? {})
        .filter(Boolean)
        .map((item) => item.roomId),
    );
    for (const roomId of used) {
      const set = rooms.get(roomId) ?? new Set();
      set.add(student.combination ?? "(无选科)");
      rooms.set(roomId, set);
    }
  }
  return rooms;
}

/** 独立实现 seatNo → { row, col }（业务列，从靠门侧起算），与 design §4.1 一致。 */
const seatNoToRowCol = (rows, seatNo) => {
  const k = Math.floor((seatNo - 1) / rows);
  const off = (seatNo - 1) % rows;
  return { row: k % 2 === 0 ? off + 1 : rows - off, col: k + 1 };
};

/** 某学生每一次已安排的座位，用 job 的考场规格独立解析行列。 */
function studentSeatAssignments(result, job, studentId) {
  const schedule = (result.byStudent ?? []).find((student) => student.studentId === studentId);
  const out = [];
  for (const [slotId, item] of Object.entries(schedule?.slots ?? {})) {
    if (!item) continue;
    const room = (job.rooms ?? []).find((r) => r.id === item.roomId);
    const rc = room ? seatNoToRowCol(room.rows, item.seatNo) : { row: undefined, col: undefined };
    out.push({ slotId, ...item, row: rc.row, col: rc.col });
  }
  return out;
}

/** 用 aoa 写一份临时 xlsx（表头 + 数据行）。 */
const writeSheet = (file, rows, sheetName = "名单") => {
  const sheet = xlsxUtils.aoa_to_sheet(rows);
  const book = xlsxUtils.book_new();
  xlsxUtils.book_append_sheet(book, sheet, sheetName);
  writeFileSync(file, writeWorkbook(book, { bookType: "xlsx", type: "buffer" }));
};

/** 跑 `roster`，同时拿 stdout / stderr / 退出码 / 解析后的 JSON（不抛异常）。 */
const runRoster = (args) => {
  const run = runFull(["--json", "roster", ...args]);
  let json = null;
  try {
    json = JSON.parse(run.stdout);
  } catch {
    json = null;
  }
  return { ...run, json, output: `${run.stdout}${run.stderr}` };
};

/** 学生数组 → id 下标，便于逐字段核对。 */
const byStudentId = (students) => new Map((students ?? []).map((s) => [s.id, s]));

/** 同一套座位方案内，座位号必须一人一位（不能两人同座或一人两座）。 */
function seatingSeatViolations(result) {
  const bad = [];
  for (const seating of result.seatings ?? []) {
    const seatNos = Object.values(seating.seatNoById ?? {});
    const unique = new Set(seatNos);
    if (seatNos.length !== unique.size) {
      bad.push(`${seating.roomId}：${seatNos.length} 人只占 ${unique.size} 个座位号`);
    }
    if (seatNos.length !== (seating.studentIds ?? []).length) {
      bad.push(
        `${seating.roomId}：座位号 ${seatNos.length} 个 / 学生 ${seating.studentIds?.length ?? 0} 人`,
      );
    }
    const bySeat = Object.keys(seating.studentBySeatNo ?? {});
    if (bySeat.length !== unique.size) {
      bad.push(`${seating.roomId}：studentBySeatNo ${bySeat.length} 项 != ${unique.size} 个座位号`);
    }
  }
  return bad;
}

/** 同一考场的多套座位方案，不能在同一时段同时出现（共用考场必须合并成一套座位）。 */
function overlappingSeatings(result) {
  const byId = new Map((result.byStudent ?? []).map((s) => [s.studentId, s]));
  const perRoom = new Map(); // roomId → [{ index, slots: Set }]
  (result.seatings ?? []).forEach((seating, index) => {
    const slots = new Set();
    for (const id of seating.studentIds ?? []) {
      for (const [slotId, item] of Object.entries(byId.get(id)?.slots ?? {})) {
        if (item && item.roomId === seating.roomId) slots.add(slotId);
      }
    }
    const list = perRoom.get(seating.roomId) ?? [];
    list.push({ index, slots });
    perRoom.set(seating.roomId, list);
  });

  const bad = [];
  for (const [roomId, list] of perRoom) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const overlap = [...list[i].slots].filter((slotId) => list[j].slots.has(slotId));
        if (overlap.length > 0) {
          bad.push(
            `${roomId}：座位方案 #${list[i].index} 与 #${list[j].index} 在 ${overlap.join(",")} 同时出现`,
          );
        }
      }
    }
  }
  return bad;
}

/** 读一份 xlsx 的工作表名（读不到返回 null）。 */
function invigilatorSheetNames(file) {
  try {
    return readWorkbook(readFileSync(file), { type: "buffer" }).SheetNames;
  } catch {
    return null;
  }
}

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

/* ---------- 10. 硬规则独立复核：一个考场 × 一个时段只能考一科 ---------- */
const hardViolations = hardRuleViolations(result);
const roomSlotCount = [...roomSlotSubjects(result).values()].reduce(
  (sum, slots) => sum + slots.size,
  0,
);
check(
  "硬规则：同一考场同一时段最多一门科目（独立推导）",
  hardViolations.length === 0,
  hardViolations.length > 0
    ? `${hardViolations.length} 处违规：${hardViolations.slice(0, 3).join("；")}`
    : `复核 ${roomSlotCount} 个「考场 × 时段」格子`,
);

const seatingViolations = seatingSubjectViolations(result);
check(
  "座位方案的 subjects 与逐时段实际科目一致",
  seatingViolations.length === 0,
  seatingViolations.slice(0, 3).join("；") || `${result.seatings.length} 套座位方案`,
);

const mixViolations = roomCombinationMixViolations(result);
check(
  "常规组合与非常规组合不共用考场",
  mixViolations.length === 0,
  mixViolations.slice(0, 3).join("；") || "物化生 / 政史地 各自独占考场",
);

const collisions = seatCollisions(result);
check(
  "同一考场同一时段座位号不重复",
  collisions.length === 0,
  collisions.slice(0, 3).join("；") || "逐座复核无重复",
);

const seatViolations = seatingSeatViolations(result);
check(
  "同一 seating 内座位号一人一位",
  seatViolations.length === 0,
  seatViolations.slice(0, 3).join("；") || `${result.seatings.length} 套座位方案`,
);

const seatingOverlaps = overlappingSeatings(result);
check(
  "同一考场的多套座位方案时段不重叠（共用必须合并）",
  seatingOverlaps.length === 0,
  seatingOverlaps.slice(0, 3).join("；") || "逐考场复核无重叠",
);

check(
  "结果里没有 ROOM_SUBJECT_CLASH 诊断",
  !diagnosticCodes(result).includes("ROOM_SUBJECT_CLASH") &&
    result.seatings.every((s) => !diagnosticCodes(s.result).includes("ROOM_SUBJECT_CLASH")),
  "",
);

check(
  "默认 sameCombination 下没有 ROOMS_SHARED",
  !diagnosticCodes(result).includes("ROOMS_SHARED"),
  `诊断码：${[...new Set(diagnosticCodes(result))].join(",") || "无"}`,
);

/* ---------- 11. 考场不足：默认必须报容量不足，不许偷偷混排 ---------- */
const tightSubjects = {
  物化生: ["physics", "chemistry", "biology"],
  政史地: ["politics", "history", "geography"],
};
const tightStudents = [];
for (let i = 1; i <= 40; i += 1) {
  tightStudents.push({
    id: `2026T1${String(i).padStart(3, "0")}`,
    name: `理科${i}`,
    className: `高三(${(i % 6) + 1})班`,
    combination: "物化生",
    subjects: tightSubjects["物化生"],
  });
}
for (let i = 1; i <= 20; i += 1) {
  tightStudents.push({
    id: `2026T2${String(i).padStart(3, "0")}`,
    name: `文科${i}`,
    className: `高三(${(i % 6) + 1})班`,
    combination: "政史地",
    subjects: tightSubjects["政史地"],
  });
}

// 60 人 / 2 个考场 × 30 座 = 60 个座位：总容量刚好够，
// 但「物化生 40 人」自己就要占掉两个考场，所以 sameCombination 下必然排不下。
const tightJob = {
  jobVersion: 2,
  meta: { title: "考场不足反例（默认 sameCombination）" },
  options: { seed: 20260930 },
  students: tightStudents,
  rooms: [
    { id: "R1", name: "第1考场", rows: 6, cols: 5 },
    { id: "R2", name: "第2考场", rows: 6, cols: 5 },
  ],
};
const tightPath = path.join(work, "tight.json");
writeFileSync(tightPath, JSON.stringify(tightJob, null, 2));
const tightRun = runFull(["--json", "plan", "--job", tightPath]);
const tightResult = JSON.parse(tightRun.stdout || "{}");
check(
  "考场不足时默认报 CAPACITY_INSUFFICIENT",
  tightResult.ok === false && diagnosticCodes(tightResult).includes("CAPACITY_INSUFFICIENT"),
  `ok=${tightResult.ok} exit=${tightRun.status} 诊断：${[...new Set(diagnosticCodes(tightResult))].join(",") || "无"}`,
);

const tightPlaced = (tightResult.byStudent ?? []).filter((s) =>
  Object.values(s.slots ?? {}).some(Boolean),
).length;
const tightHard = hardRuleViolations(tightResult);
const tightMix = roomCombinationMixViolations(tightResult);
check(
  "考场不足时不偷偷混排（无同时段两科 / 无常规混非常规 / 未把人全塞进去）",
  tightHard.length === 0 && tightMix.length === 0 && tightPlaced < tightStudents.length,
  `已排 ${tightPlaced}/${tightStudents.length} 人；违规 ${tightHard.length + tightMix.length} 处`,
);

// 多场次结果「不通过」（ok === false）时不得把名单 / 监考表当交付物导出（docs/design.md §5.1 的导出闸门）。
// 仍要留 plan.json + 剔除空置后的 job.json 作证据，并在 stderr 说清楚。
const tightOutDir = path.join(work, "tight-out");
const tightOutRun = runFull(["plan", "--job", tightPath, "--out-dir", tightOutDir]);
const tightOutFiles = {
  classBook: fileSize(path.join(tightOutDir, "按班级考场安排.xlsx")),
  invigilator: fileSize(path.join(tightOutDir, "考场监考表.xlsx")),
  plan: fileSize(path.join(tightOutDir, "plan.json")),
  job: fileSize(path.join(tightOutDir, "job.json")),
};
check(
  "多场次结构性 error：退出码 3、不导出工作簿（只留 plan.json / job.json）",
  tightOutRun.status === 3 &&
    tightOutFiles.classBook < 0 &&
    tightOutFiles.invigilator < 0 &&
    tightOutFiles.plan > 0 &&
    tightOutFiles.job > 0 &&
    /未导出名单|未通过校验|不导出/.test(tightOutRun.stderr),
  `exit=${tightOutRun.status}；文件：${Object.entries(tightOutFiles)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")}；stderr：${tightOutRun.stderr.replaceAll(/\s+/g, " ").trim().slice(0, 80)}`,
);

/* ---------- 11b. 全部考场空置（没有任何座位方案）：job.json 不能被掏空，提示不能骗人 ---------- */
// 6 名学生全部 included:false → 参考人数 0 → 一套座位方案都排不出来（seatings = []）。
// 此时 io 的安全阀必须原样保留 job 的考场，而不是把 job 剔成 0 个考场并谎报「已剔除空置考场」。
const zeroStudents = Array.from({ length: 6 }, (_, i) => ({
  id: `2026X1${String(i + 1).padStart(3, "0")}`,
  name: `缺考${i + 1}`,
  className: `高三(${(i % 3) + 1})班`,
  combination: "物化生",
  subjects: tightSubjects["物化生"],
  included: false,
}));
const zeroJob = {
  jobVersion: 2,
  meta: { title: "全部考场空置（参考人数 0）" },
  options: { seed: 20260930 },
  students: zeroStudents,
  rooms: [1, 2, 3].map((n) => ({ id: `R${n}`, name: `第${n}考场`, rows: 6, cols: 5 })),
};
const zeroPath = path.join(work, "zero.json");
const zeroDir = path.join(work, "zero-out");
const zeroTextDir = path.join(work, "zero-out-text");
writeFileSync(zeroPath, JSON.stringify(zeroJob, null, 2));
const zeroRun = runFull(["--json", "plan", "--job", zeroPath, "--out-dir", zeroDir]);
const zeroResult = JSON.parse(zeroRun.stdout || "{}");
const zeroExportedJob = readJsonIfExists(path.join(zeroDir, "job.json"));
check(
  "没有任何座位方案时：job.json 不被掏空（保留全部考场）",
  zeroResult.seatings?.length === 0 &&
    zeroExportedJob?.rooms?.length === zeroJob.rooms.length &&
    zeroExportedJob.rooms.every((room, index) => room.id === zeroJob.rooms[index].id),
  `座位方案=${zeroResult.seatings?.length ?? 0}；导出考场=${
    zeroExportedJob?.rooms ? zeroExportedJob.rooms.map((r) => r.id).join("、") : "没有 job.json"
  }（原 ${zeroJob.rooms.length} 个）`,
);

const zeroTextRun = runFull(["plan", "--job", zeroPath, "--out-dir", zeroTextDir]);
const zeroText = `${zeroTextRun.stdout}${zeroTextRun.stderr}`;
check(
  "没有任何座位方案时：CLI 不谎报「已剔除空置考场」也不谎报排考完成",
  !zeroText.includes("已剔除") &&
    // 一套座位方案都没有时，绝不能出现「多场次排考完成 / 全部时段已安排」这类成功话术
    !(zeroResult.seatings?.length === 0 && /排考完成|已完成|全部时段已安排/.test(zeroText)) &&
    /未能完全安排|没有任何考场安排|不够|没有.*座位|失败/.test(zeroText) &&
    zeroTextRun.status === 3 &&
    zeroRun.status === 3,
  `exit(--json)=${zeroRun.status} / exit(text)=${zeroTextRun.status}；输出摘要：${zeroText
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 100)}`,
);

/* ---------- 11c. 单场路径共用同一导出闸门（docs/design.md §8.1） ---------- */
// 反例：单场 100 人 / 3 个 30 座考场 → 结构性 CAPACITY_INSUFFICIENT → 不导出名单。
const singleTightStudents = Array.from({ length: 100 }, (_, i) => ({
  id: `2026S1${String(i + 1).padStart(3, "0")}`,
  name: `单场${i + 1}`,
  className: `高三(${(i % 10) + 1})班`,
}));
const singleTightJob = {
  jobVersion: 2,
  meta: { title: "单场容量不足（导出闸门反例）" },
  options: { seed: 20260930 },
  students: singleTightStudents,
  rooms: [1, 2, 3].map((n) => ({ id: `R${n}`, name: `第${n}考场`, rows: 6, cols: 5 })),
};
const singleTightPath = path.join(work, "single-tight.json");
const singleTightDir = path.join(work, "single-tight-out");
writeFileSync(singleTightPath, JSON.stringify(singleTightJob, null, 2));
const singleTightRun = runFull(["plan", "--job", singleTightPath, "--out-dir", singleTightDir]);
const singleTightFiles = {
  list: fileSize(path.join(singleTightDir, "考场安排名单.xlsx")),
  plan: fileSize(path.join(singleTightDir, "plan.json")),
  job: fileSize(path.join(singleTightDir, "job.json")),
};
check(
  "单场结构性 error：退出码 3、不导出名单（只留 plan.json / job.json）",
  singleTightRun.status === 3 &&
    singleTightFiles.list < 0 &&
    singleTightFiles.plan > 0 &&
    singleTightFiles.job > 0 &&
    /未导出名单|未通过校验|不导出/.test(singleTightRun.stderr),
  `exit=${singleTightRun.status}；文件：${Object.entries(singleTightFiles)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")}`,
);

// 正对照：降级（班级数 < 9 → orthogonal）照常导出名单，§8.1 的「降级不拦」。
const fewOutDir = path.join(work, "few-out");
const fewOutRun = runFull(["plan", "--job", fewPath, "--out-dir", fewOutDir]);
check(
  "单场降级结果照常导出名单（降级不拦）",
  fewOutRun.status === 0 &&
    fileSize(path.join(fewOutDir, "考场安排名单.xlsx")) > 0 &&
    !/未导出名单/.test(fewOutRun.stderr),
  `exit=${fewOutRun.status}；名单=${fileSize(path.join(fewOutDir, "考场安排名单.xlsx"))} 字节`,
);

/* ---------- 12. 空置考场剔除：导出的 job.json + CLI 提示 ---------- */
check(
  "主 job 确实有空置考场（剔除断言有对象）",
  result.emptyRooms.length > 0,
  `${result.emptyRooms.length} 个空置考场`,
);

// 12a. 主 job 的 --out-dir 导出
const mainExportedJob = readJsonIfExists(path.join(outDir, "job.json"));
let mainPruneDetail = "out-dir 里没有 job.json";
let mainPruneOk = false;
if (mainExportedJob?.rooms) {
  const keptIds = new Set(mainExportedJob.rooms.map((r) => r.id));
  const keptNames = new Set(mainExportedJob.rooms.map((r) => r.name));
  const leaked = result.emptyRooms.filter((n) => keptIds.has(n) || keptNames.has(n));
  const expected = job.rooms.length - result.emptyRooms.length;
  mainPruneOk = leaked.length === 0 && mainExportedJob.rooms.length === expected;
  mainPruneDetail = `空置 ${result.emptyRooms.length} 个；导出 ${mainExportedJob.rooms.length} 个（应为 ${expected}）；残留 ${leaked.join("、") || "无"}`;
}
check("--out-dir 导出的 job.json 已剔除空置考场", mainPruneOk, mainPruneDetail);

// 12b. 小 job：12 个物化生 / 3 个考场 → 2 个空置，快速复核剔除提示
const thinStudents = Array.from({ length: 12 }, (_, i) => ({
  id: `2026E1${String(i + 1).padStart(3, "0")}`,
  name: `考生${i + 1}`,
  className: `高三(${(i % 4) + 1})班`,
  combination: "物化生",
  subjects: tightSubjects["物化生"],
}));
const thinJob = {
  jobVersion: 2,
  meta: { title: "空置考场剔除反例" },
  options: { seed: 20260930 },
  students: thinStudents,
  rooms: [1, 2, 3].map((n) => ({ id: `R${n}`, name: `第${n}考场`, rows: 6, cols: 5 })),
};
const thinPath = path.join(work, "thin.json");
const thinDir = path.join(work, "thin-out");
writeFileSync(thinPath, JSON.stringify(thinJob, null, 2));
const thinRun = runFull(["--json", "plan", "--job", thinPath, "--out-dir", thinDir]);
const thinResult = JSON.parse(thinRun.stdout || "{}");
check(
  "小 job 排出 1 套座位并列出 2 个空置考场",
  thinResult.ok === true &&
    thinResult.seatings.length === 1 &&
    (thinResult.emptyRooms ?? []).length === 2,
  `ok=${thinResult.ok} 座位方案=${thinResult.seatings?.length ?? 0} 空置=${(thinResult.emptyRooms ?? []).length}`,
);

const thinExportedJob = readJsonIfExists(path.join(thinDir, "job.json"));
check(
  "小 job 导出的 job.json 只保留用到的考场",
  thinExportedJob?.rooms?.length === 1 && thinExportedJob.rooms[0].id === "R1",
  thinExportedJob?.rooms
    ? `导出 ${thinExportedJob.rooms.map((r) => r.id).join("、")}`
    : "out-dir 里没有 job.json",
);

const noticeLine =
  thinRun.stderr
    .split("\n")
    .find((line) => line.includes("空置") && /剔除|移除|去掉|取消/.test(line)) ?? "";
check(
  "CLI 打印了剔除空置考场的提示（stderr）",
  noticeLine.length > 0,
  noticeLine.trim().slice(0, 120) || "stderr 里没有剔除提示",
);

check(
  "--json：stdout 只有一个 JSON 对象，剔除提示只走 stderr",
  (() => {
    try {
      const parsed = JSON.parse(thinRun.stdout);
      return typeof parsed === "object" && parsed != null;
    } catch {
      return false;
    }
  })() &&
    // JSON 正文里本来就可能出现「空置」字样（诊断 message），只查提示整行不在 stdout
    (noticeLine === "" || !thinRun.stdout.includes(noticeLine.trim())),
  `stdout ${Buffer.byteLength(thinRun.stdout)} 字节 / stderr ${Buffer.byteLength(thinRun.stderr)} 字节`,
);

/* ---------- 13. Skill 覆盖 job.json v2 / 多场次（纯文件断言） ---------- */
const skillDir = path.join(ROOT, ".agents/skills/exam-seating");
const skillText = readTextIfExists(path.join(skillDir, "SKILL.md"));
const referenceText = readTextIfExists(path.join(skillDir, "reference.md"));
const skillAll = `${skillText ?? ""}\n${referenceText ?? ""}`;
const countOf = (text, word) => text.split(word).length - 1;

const skillChars = skillText == null ? Number.POSITIVE_INFINITY : [...skillText].length;
check(
  "SKILL.md 字符数 < 8192",
  skillChars < 8192,
  skillText == null
    ? "读不到 SKILL.md"
    : `${skillChars} 字符 / ${Buffer.byteLength(skillText, "utf8")} 字节`,
);

const skillKeywords = ["选科", "combination", "planAll", "多场次", "dedicatedSubjects"];
const missingKeywords = skillKeywords.filter((word) => countOf(skillAll, word) === 0);
check(
  "skill 关键词计数 > 0（选科 / combination / planAll / 多场次 / dedicatedSubjects）",
  missingKeywords.length === 0,
  missingKeywords.length > 0
    ? `缺失：${missingKeywords.join("、")}`
    : skillKeywords.map((word) => `${word}:${countOf(skillAll, word)}`).join("  "),
);

const skillPitfalls = ["选科", "多场次", "--single", "dedicatedSubjects", "groupPreference"];
const missingPitfalls = skillPitfalls.filter((word) => !(skillText ?? "").includes(word));
check(
  "SKILL.md 写了 v2 / 多场次高频坑位",
  missingPitfalls.length === 0,
  missingPitfalls.length > 0 ? `缺失：${missingPitfalls.join("、")}` : skillPitfalls.join("、"),
);

const referenceNeeds = [
  "planAll",
  "combination",
  "dedicatedSubjects",
  "groupPreference",
  "ROOM_SUBJECT_CLASH",
];
const missingReference = referenceNeeds.filter((word) => !(referenceText ?? "").includes(word));
check(
  "reference.md 补了 v2 字段与 ROOM_SUBJECT_CLASH",
  missingReference.length === 0,
  missingReference.length > 0 ? `缺失：${missingReference.join("、")}` : referenceNeeds.join("、"),
);

let sampleFiles = [];
try {
  sampleFiles = readdirSync(path.join(skillDir, "examples")).filter((f) => f.endsWith(".json"));
} catch {
  sampleFiles = [];
}
const sampleWithSelection = sampleFiles.filter((file) => {
  const text = readTextIfExists(path.join(skillDir, "examples", file)) ?? "";
  return ["combination", "subjects", "dedicatedSubjects"].every((word) => text.includes(word));
});
check(
  "skill 样例里有一份带选科的 job",
  sampleWithSelection.length > 0,
  sampleFiles.length > 0 ? `样例：${sampleFiles.join("、")}` : "读不到 examples 目录",
);

/* ---------- 14. 多场次限定：必须真正生效，且不得静默忽略 ---------- */
// 独立复现「四选择器取并集」的命中规则，自己数一遍限定条数与涉及学生数。
const matchesConstraint = (student, constraint) =>
  (constraint.studentIds ?? []).includes(student.id) ||
  (constraint.classes ?? []).includes(student.className) ||
  (constraint.combinations ?? []).includes(student.combination) ||
  (constraint.subjects ?? []).some((subject) => (student.subjects ?? []).includes(subject));

const constrainedJob = {
  jobVersion: 2,
  meta: { title: "多场次 + 限定（应真正生效）" },
  options: { seed: 20260930 },
  students: thinStudents,
  rooms: [
    { id: "R1", name: "第1考场", rows: 6, cols: 5 },
    { id: "R2", name: "第2考场", rows: 6, cols: 5 },
  ],
  constraints: [
    {
      id: "C1",
      note: "点名两人坐首排",
      studentIds: [thinStudents[0].id, thinStudents[1].id],
      rows: ["first"],
    },
    { id: "C2", note: "高三(3)班靠门", classes: ["高三(3)班"], cols: ["door"] },
  ],
};
const involvedStudents = thinStudents.filter((student) =>
  constrainedJob.constraints.some((constraint) => matchesConstraint(student, constraint)),
).length;

const constrainedPath = path.join(work, "constrained.json");
const constrainedDir = path.join(work, "constrained-out");
writeFileSync(constrainedPath, JSON.stringify(constrainedJob, null, 2));
const constrainedRun = runFull([
  "--json",
  "plan",
  "--job",
  constrainedPath,
  "--out-dir",
  constrainedDir,
]);
const constrainedResult = JSON.parse(constrainedRun.stdout || "{}");

check(
  "多场次 + 非空 constraints：限定已生效，不再出现 CONSTRAINTS_IGNORED_MULTI",
  !diagnosticCodes(constrainedResult).includes("CONSTRAINTS_IGNORED_MULTI") &&
    constrainedResult.ok === true,
  `诊断码：${[...new Set(diagnosticCodes(constrainedResult))].join(",") || "无"}；涉及 ${involvedStudents} 名学生 / ${constrainedJob.constraints.length} 条限定`,
);

// 限定必须真的落到「学生自己那套座位」：C1 点名两人首排、C2 按班靠门（独立解析 seatNo → 行列）。
const constrainedFirstRow = (constrainedJob.constraints[0].studentIds ?? []).flatMap((id) =>
  studentSeatAssignments(constrainedResult, constrainedJob, id),
);
const constrainedDoorCol = thinStudents
  .filter((student) => matchesConstraint(student, constrainedJob.constraints[1]))
  .flatMap((student) => studentSeatAssignments(constrainedResult, constrainedJob, student.id));
check(
  "多场次限定生效：点名两人首排、按班三人靠门（独立解析行列）",
  constrainedFirstRow.length > 0 &&
    constrainedFirstRow.every((assignment) => assignment.row === 1) &&
    constrainedDoorCol.length > 0 &&
    constrainedDoorCol.every((assignment) => assignment.col === 1),
  `首排 ${constrainedFirstRow.length} 次（行=${[...new Set(constrainedFirstRow.map((a) => a.row))].join("/")}）；靠门 ${constrainedDoorCol.length} 次（列=${[...new Set(constrainedDoorCol.map((a) => a.col))].join("/")}）`,
);

check(
  "多场次但无 constraints：没有 CONSTRAINTS_IGNORED_MULTI",
  !diagnosticCodes(thinResult).includes("CONSTRAINTS_IGNORED_MULTI") && thinResult.ok === true,
  `诊断码：${[...new Set(diagnosticCodes(thinResult))].join(",") || "无"}`,
);

check(
  "多场次 + constraints：限定满足时照常导出（ok=true、exit=0、写出名单）",
  constrainedResult.ok === true &&
    constrainedRun.status === 0 &&
    fileSize(path.join(constrainedDir, "按班级考场安排.xlsx")) > 0,
  `ok=${constrainedResult.ok} exit=${constrainedRun.status} 名单=${fileSize(path.join(constrainedDir, "按班级考场安排.xlsx"))} 字节`,
);

const constrainedSingleRun = runFull(["--json", "plan", "--job", constrainedPath, "--single"]);
const constrainedSingleResult = JSON.parse(constrainedSingleRun.stdout || "{}");
check(
  "单场模式不产生 CONSTRAINTS_IGNORED_MULTI（限定走单场路径）",
  !diagnosticCodes(constrainedSingleResult).includes("CONSTRAINTS_IGNORED_MULTI") &&
    constrainedSingleResult.entries?.length === thinStudents.length,
  `诊断码：${[...new Set(diagnosticCodes(constrainedSingleResult))].join(",") || "无"}；${constrainedSingleResult.entries?.length ?? 0} 条名单`,
);

const severityOf = (planAllResult, code) =>
  (planAllResult.diagnostics ?? []).find((d) => d.code === code)?.severity;
check(
  "诊断分级：error 级阻塞 ok，warning 级不阻塞 ok",
  severityOf(tightResult, "CAPACITY_INSUFFICIENT") === "error" &&
    tightResult.ok === false &&
    severityOf(fewResult, "TOO_FEW_CLASSES") === "warning" &&
    fewResult.ok === true,
  `CAPACITY_INSUFFICIENT：exit=${tightRun.status}、ok=${tightResult.ok}；TOO_FEW_CLASSES：level=${fewResult.level}、ok=${fewResult.ok}`,
);

/* ---------- 15. fillRooms 共用考场：合并成一套座位 + 只出一张监考表 ---------- */
const fillStudents = [];
for (let i = 1; i <= 40; i += 1) {
  fillStudents.push({
    id: `2026F1${String(i).padStart(3, "0")}`,
    name: `理${i}`,
    className: `高三(${(i % 8) + 1})班`,
    combination: "物化生",
    subjects: ["physics", "chemistry", "biology"],
  });
}
for (let i = 1; i <= 20; i += 1) {
  fillStudents.push({
    id: `2026F2${String(i).padStart(3, "0")}`,
    name: `政${i}`,
    className: `高三(${(i % 8) + 1})班`,
    combination: "物化政",
    subjects: ["physics", "chemistry", "politics"],
  });
}

// 物化生 40 人用不满两个考场 → 必然有一个普通考场被两批学生共用；
// 两批学生逐时段不冲突（T6 物化政去政治专用考场），所以 fillRooms 允许共用。
const fillRooms = [
  { id: "R1", name: "第1考场", rows: 6, cols: 5 },
  { id: "R2", name: "第2考场", rows: 6, cols: 5 },
  { id: "R3", name: "第3考场", rows: 6, cols: 5, dedicatedSubjects: ["politics"] },
];
const fillJob = {
  jobVersion: 2,
  meta: { title: "fillRooms 共用考场" },
  options: { seed: 20260930, groupPreference: "fillRooms" },
  students: fillStudents,
  rooms: fillRooms,
};
const fillPath = path.join(work, "fill.json");
const fillDir = path.join(work, "fill-out");
writeFileSync(fillPath, JSON.stringify(fillJob, null, 2));
const fillRun = runFull(["--json", "plan", "--job", fillPath, "--out-dir", fillDir]);
const fillResult = JSON.parse(fillRun.stdout || "{}");

const fillRoomCombos = new Map();
for (const student of fillResult.byStudent ?? []) {
  const used = new Set(
    Object.values(student.slots ?? {})
      .filter(Boolean)
      .map((item) => item.roomId),
  );
  for (const roomId of used) {
    const set = fillRoomCombos.get(roomId) ?? new Set();
    set.add(student.combination);
    fillRoomCombos.set(roomId, set);
  }
}
const fillDedicatedIds = new Set(
  fillRooms.filter((room) => (room.dedicatedSubjects ?? []).length > 0).map((room) => room.id),
);
const sharedGeneralRooms = [...fillRoomCombos]
  .filter(([roomId, combos]) => !fillDedicatedIds.has(roomId) && combos.size > 1)
  .map(([roomId]) => roomId);

check(
  "fillRooms：共用考场仍然 ok 且 60 人全部有座位",
  fillResult.ok === true && (fillResult.byStudent ?? []).length === fillStudents.length,
  `ok=${fillResult.ok} 人数=${(fillResult.byStudent ?? []).length}/${fillStudents.length} 诊断：${
    [...new Set(diagnosticCodes(fillResult))].join(",") || "无"
  }`,
);

check(
  "fillRooms：共用考场合并成一套座位方案（时段不重叠）",
  overlappingSeatings(fillResult).length === 0,
  overlappingSeatings(fillResult).slice(0, 3).join("；") ||
    `共用考场：${sharedGeneralRooms.join("、") || "无"}`,
);

check(
  "fillRooms：同一 seating 内座位号一人一位",
  seatingSeatViolations(fillResult).length === 0,
  seatingSeatViolations(fillResult).slice(0, 3).join("；") ||
    `${fillResult.seatings?.length ?? 0} 套座位方案`,
);

const fillSheets = invigilatorSheetNames(path.join(fillDir, "考场监考表.xlsx"));
const sharedRoomSheets = sharedGeneralRooms.map((roomId) => {
  const room = fillRooms.find((r) => r.id === roomId);
  const roomName = room?.name ?? roomId;
  const seatings = (fillResult.seatings ?? []).filter((s) => s.roomId === roomId);
  const sheets = (fillSheets ?? []).filter((name) => name.startsWith(roomName));
  return { roomName, seatings: seatings.length, sheets };
});
check(
  "fillRooms：共用考场只出一张监考表（科目并集）",
  sharedGeneralRooms.length > 0 &&
    sharedRoomSheets.every((item) => item.seatings === 1 && item.sheets.length === 1),
  sharedRoomSheets.length > 0
    ? sharedRoomSheets
        .map(
          (item) =>
            `${item.roomName}：座位方案 ${item.seatings} 套 / 监考表 ${item.sheets.length} 张 [${item.sheets.join("、")}]`,
        )
        .join("；")
    : `没有共用考场；监考表共 ${(fillSheets ?? []).length} 张`,
);

// 同一份名单换成默认 sameCombination：60 人 / 2 个普通考场，但「一个考场只放一种组合」，
// 物化生 40 人自己就要占满两个考场 → 必须报容量不足，不能偷偷与物化政混排。
const fillStrictJob = { ...fillJob, options: { seed: 20260930 } };
const fillStrictPath = path.join(work, "fill-strict.json");
writeFileSync(fillStrictPath, JSON.stringify(fillStrictJob, null, 2));
const fillStrictRun = runFull(["--json", "plan", "--job", fillStrictPath]);
const fillStrictResult = JSON.parse(fillStrictRun.stdout || "{}");
check(
  "sameCombination 遇考场不足：报 CAPACITY_INSUFFICIENT（error）",
  fillStrictResult.ok === false &&
    diagnosticCodes(fillStrictResult).includes("CAPACITY_INSUFFICIENT"),
  `ok=${fillStrictResult.ok} exit=${fillStrictRun.status} 诊断：${
    [...new Set(diagnosticCodes(fillStrictResult))].join(",") || "无"
  }`,
);
const fillStrictUnarranged = unarrangedStudents(fillStrictResult, fillStrictJob);
const fillStrictIrregularRooms = new Set();
for (const student of fillStrictResult.byStudent ?? []) {
  if (student.combination !== "物化政") continue;
  for (const item of Object.values(student.slots ?? {})) {
    if (item) fillStrictIrregularRooms.add(item.roomId);
  }
}
check(
  "sameCombination 不混排：无共用考场、无重叠座位方案、确实有人应考时段没排满",
  roomCombinationMixViolations(fillStrictResult).length === 0 &&
    overlappingSeatings(fillStrictResult).length === 0 &&
    hardRuleViolations(fillStrictResult).length === 0 &&
    fillStrictUnarranged.length > 0 &&
    // 「没偷偷混排」的直接证据：物化政只出现在专用政治考场，没被塞进常规考场
    [...fillStrictIrregularRooms].every((roomId) => roomId === "R3"),
  `未排满 ${fillStrictUnarranged.length} 人（首个：${fillStrictUnarranged[0]?.studentId ?? "—"} 缺 ${
    fillStrictUnarranged[0]?.missing.join(",") ?? "—"
  }）；物化政只出现在 ${[...fillStrictIrregularRooms].join("、") || "（无座位）"}；混排 ${
    roomCombinationMixViolations(fillStrictResult).length
  } 处；重叠 ${overlappingSeatings(fillStrictResult).length} 处`,
);

/* ---------- 16. 阶段 2 对抗用例 ---------- */

// 16a. 单场 --relax minConflicts：4 个班 9/9/9/3 挤满 6×5、坚持 8 邻域 → 国王图唯一分法 9/6/9/6，
//      必然冲突 → SEARCH_FAILED（§8.1 明确「不阻止导出」）。名单必须照常导出。
const relaxStudents = [];
for (const [classIndex, count] of [9, 9, 9, 3].entries()) {
  for (let i = 1; i <= count; i += 1) {
    relaxStudents.push({
      id: `2026R1${classIndex + 1}${String(i).padStart(2, "0")}`,
      name: `松弛${classIndex + 1}-${i}`,
      className: `高三(${classIndex + 1})班`,
    });
  }
}
const relaxJob = {
  jobVersion: 2,
  meta: { title: "单场 --relax minConflicts（SEARCH_FAILED 仍导出）" },
  options: { seed: 20260930 },
  students: relaxStudents,
  rooms: [{ id: "R1", name: "第1考场", rows: 6, cols: 5 }],
};
const relaxPath = path.join(work, "relax.json");
const relaxDir = path.join(work, "relax-out");
writeFileSync(relaxPath, JSON.stringify(relaxJob, null, 2));
const relaxRun = runFull([
  "--json",
  "plan",
  "--job",
  relaxPath,
  "--relax",
  "minConflicts",
  "--force-king",
  "--out-dir",
  relaxDir,
]);
const relaxResult = JSON.parse(relaxRun.stdout || "{}");
const relaxListSize = fileSize(path.join(relaxDir, "考场安排名单.xlsx"));
check(
  "单场 --relax minConflicts：SEARCH_FAILED 仍照常导出名单",
  diagnosticCodes(relaxResult).includes("SEARCH_FAILED") &&
    relaxResult.ok === false &&
    relaxRun.status === 2 &&
    relaxListSize > 0 &&
    fileSize(path.join(relaxDir, "plan.json")) > 0 &&
    !/未导出名单/.test(relaxRun.stderr),
  `exit=${relaxRun.status} ok=${relaxResult.ok}；诊断：${
    [...new Set(diagnosticCodes(relaxResult))].join(",") || "无"
  }；名单=${relaxListSize} 字节`,
);

// 16b. fillRooms 也不能合并「逐时段冲突」的批次：1 个考场装 物化生 20 + 政史地 20。
const illegalMergeJob = {
  jobVersion: 2,
  meta: { title: "fillRooms 不合并逐时段冲突的批次" },
  options: { seed: 20260930, groupPreference: "fillRooms" },
  students: [
    ...Array.from({ length: 20 }, (_, i) => ({
      id: `2026M1${String(i + 1).padStart(3, "0")}`,
      name: `理${i + 1}`,
      className: `高三(${(i % 5) + 1})班`,
      combination: "物化生",
      subjects: tightSubjects["物化生"],
    })),
    ...Array.from({ length: 20 }, (_, i) => ({
      id: `2026M2${String(i + 1).padStart(3, "0")}`,
      name: `文${i + 1}`,
      className: `高三(${(i % 5) + 1})班`,
      combination: "政史地",
      subjects: tightSubjects["政史地"],
    })),
  ],
  rooms: [{ id: "R1", name: "第1考场", rows: 6, cols: 5 }],
};
const illegalMergePath = path.join(work, "illegal-merge.json");
const illegalMergeDir = path.join(work, "illegal-merge-out");
writeFileSync(illegalMergePath, JSON.stringify(illegalMergeJob, null, 2));
const illegalMergeRun = runFull([
  "--json",
  "plan",
  "--job",
  illegalMergePath,
  "--out-dir",
  illegalMergeDir,
]);
const illegalMergeResult = JSON.parse(illegalMergeRun.stdout || "{}");
const illegalMergeRooms = [...roomCombinations(illegalMergeResult).entries()];
const illegalMergeUnarranged = unarrangedStudents(illegalMergeResult, illegalMergeJob).length;
check(
  "fillRooms 不合并逐时段冲突的批次（1 个考场 → CAPACITY_INSUFFICIENT、不混排、不导表）",
  illegalMergeResult.ok === false &&
    diagnosticCodes(illegalMergeResult).includes("CAPACITY_INSUFFICIENT") &&
    hardRuleViolations(illegalMergeResult).length === 0 &&
    illegalMergeRooms.every(([, combos]) => combos.size <= 1) &&
    illegalMergeUnarranged > 0 &&
    fileSize(path.join(illegalMergeDir, "考场监考表.xlsx")) < 0,
  `ok=${illegalMergeResult.ok}；考场组合：${
    illegalMergeRooms.map(([roomId, combos]) => `${roomId}=${[...combos].join("+")}`).join(" ") ||
    "无"
  }；未排满 ${illegalMergeUnarranged} 人`,
);

// 16c. 非法 groupPreference：安全回退 sameCombination，绝不静默混排（见 §3.2 B4）。
const bogusJob = { ...tightJob, options: { seed: 20260930, groupPreference: "bogus" } };
const bogusPath = path.join(work, "bogus.json");
writeFileSync(bogusPath, JSON.stringify(bogusJob, null, 2));
const bogusRun = runFull(["--json", "plan", "--job", bogusPath]);
const bogusResult = JSON.parse(bogusRun.stdout || "{}");
check(
  "非法 groupPreference 安全回退 sameCombination（不混排、报容量不足）",
  bogusResult.ok === false &&
    diagnosticCodes(bogusResult).includes("CAPACITY_INSUFFICIENT") &&
    hardRuleViolations(bogusResult).length === 0 &&
    roomCombinationMixViolations(bogusResult).length === 0 &&
    overlappingSeatings(bogusResult).length === 0,
  `ok=${bogusResult.ok} 诊断：${[...new Set(diagnosticCodes(bogusResult))].join(",") || "无"}；混排 ${
    roomCombinationMixViolations(bogusResult).length
  } 处`,
);

// 16d. 没有专用考场时 物化政 + 物化地 会合并在非常规主考场：每人在场科目必须是自己选的。
const mixedStudents = [
  ...Array.from({ length: 20 }, (_, i) => ({
    id: `2026N1${String(i + 1).padStart(3, "0")}`,
    name: `政${i + 1}`,
    className: `高三(${(i % 8) + 1})班`,
    combination: "物化政",
    subjects: COMBO_SUBJECT_IDS["物化政"],
  })),
  ...Array.from({ length: 20 }, (_, i) => ({
    id: `2026N2${String(i + 1).padStart(3, "0")}`,
    name: `地${i + 1}`,
    className: `高三(${(i % 8) + 1})班`,
    combination: "物化地",
    subjects: COMBO_SUBJECT_IDS["物化地"],
  })),
];
const mixedJob = {
  jobVersion: 2,
  meta: { title: "无专用考场：混合批次逐时段科目复核" },
  options: { seed: 20260930 },
  students: mixedStudents,
  rooms: [1, 2].map((n) => ({ id: `R${n}`, name: `第${n}考场`, rows: 6, cols: 5 })),
};
const mixedPath = path.join(work, "mixed.json");
const mixedDir = path.join(work, "mixed-out");
writeFileSync(mixedPath, JSON.stringify(mixedJob, null, 2));
const mixedRun = runFull(["--json", "plan", "--job", mixedPath, "--out-dir", mixedDir]);
const mixedResult = JSON.parse(mixedRun.stdout || "{}");
const mixedMismatches = studentSubjectViolations(mixedResult, mixedJob);
const mixedHard = hardRuleViolations(mixedResult);
const mixedClash = diagnosticCodes(mixedResult).includes("ROOM_SUBJECT_CLASH");
const mixedSheetSize = fileSize(path.join(mixedDir, "考场监考表.xlsx"));
check(
  "无专用考场 + 政治/地理同段：不静默（合法拆房，或报 ROOM_SUBJECT_CLASH 且不导出）",
  mixedMismatches.length === 0 &&
    (mixedResult.ok === true
      ? mixedHard.length === 0
      : mixedClash && mixedHard.length > 0 && mixedSheetSize < 0),
  `ok=${mixedResult.ok}；独立复核违规 ${mixedHard.length} 处；核心 ROOM_SUBJECT_CLASH=${mixedClash}；科目映射错误 ${mixedMismatches.length} 处；监考表=${mixedSheetSize} 字节`,
);

// 16e. fillRooms 场景可复现：同 seed 两次结果一致（只比稳定字段，排除 elapsedMs / generatedAt）。
const seatingSignature = (result) =>
  JSON.stringify(
    (result.seatings ?? []).map((seating) => ({
      roomId: seating.roomId,
      subjects: seating.subjects,
      studentIds: seating.studentIds,
      seatNoById: seating.seatNoById,
      studentBySeatNo: seating.studentBySeatNo,
    })),
  );
const fillRerun = JSON.parse(runFull(["--json", "plan", "--job", fillPath]).stdout || "{}");
check(
  "fillRooms 场景同 seed 可复现（座位方案 + byStudent 逐字节一致）",
  seatingSignature(fillRerun) === seatingSignature(fillResult) &&
    JSON.stringify(fillRerun.byStudent) === JSON.stringify(fillResult.byStudent),
  `${fillRerun.seatings?.length ?? 0} 套座位方案`,
);

// 16f. 非常规学生的选考科目「全部」被专用考场接走时，语数外仍必须有主批次（不能漏排）。
const allDedicatedJob = {
  jobVersion: 2,
  meta: { title: "选考科目全在专用考场：语数外不能漏排" },
  options: { seed: 20260930 },
  students: Array.from({ length: 10 }, (_, i) => ({
    id: `2026D1${String(i + 1).padStart(3, "0")}`,
    name: `专${i + 1}`,
    className: `高三(${(i % 4) + 1})班`,
    combination: "物化政",
    subjects: COMBO_SUBJECT_IDS["物化政"],
  })),
  rooms: [
    { id: "R1", name: "第1考场", rows: 6, cols: 5 },
    {
      id: "R2",
      name: "第2考场",
      rows: 6,
      cols: 5,
      dedicatedSubjects: ["physics", "chemistry", "politics"],
    },
  ],
};
const allDedicatedPath = path.join(work, "all-dedicated.json");
writeFileSync(allDedicatedPath, JSON.stringify(allDedicatedJob, null, 2));
const allDedicatedRun = runFull(["--json", "plan", "--job", allDedicatedPath]);
const allDedicatedResult = JSON.parse(allDedicatedRun.stdout || "{}");
const allDedicatedUnarranged = unarrangedStudents(allDedicatedResult, allDedicatedJob);
const allDedicatedRoomCounts = (allDedicatedResult.byStudent ?? []).map((s) => s.distinctRooms);
check(
  "选考科目全被专用考场接走时：语数外仍排上（无应考时段漏排）",
  allDedicatedResult.ok === true &&
    allDedicatedUnarranged.length === 0 &&
    allDedicatedRoomCounts.length === allDedicatedJob.students.length &&
    allDedicatedRoomCounts.every((count) => count === 2) &&
    hardRuleViolations(allDedicatedResult).length === 0 &&
    !diagnosticCodes(allDedicatedResult).includes("ROOM_SUBJECT_CLASH"),
  `ok=${allDedicatedResult.ok}；未排满 ${allDedicatedUnarranged.length} 人；每人考场数 ${
    [...new Set(allDedicatedRoomCounts)].join("/") || "—"
  }；座位方案 ${allDedicatedResult.seatings?.length ?? 0} 套`,
);

// 16g. validate 喂多场次 plan.json：走 core 的 validateAll（task-13 契约），逐 seating 给结论。
const multiPlanPath = path.join(thinDir, "plan.json");
const validateMultiRun = runFull(["validate", "--job", thinPath, "--plan", multiPlanPath]);
const validateMultiJsonRun = runFull([
  "--json",
  "validate",
  "--job",
  thinPath,
  "--plan",
  multiPlanPath,
]);
const validateMultiJson = JSON.parse(validateMultiJsonRun.stdout || "{}");
check(
  "validate 喂多场次 plan.json：走 validateAll（exit 0、逐 seating 有结论、不抛内部错误）",
  validateMultiRun.status === 0 &&
    validateMultiJsonRun.status === 0 &&
    !validateMultiRun.stderr.includes("内部错误") &&
    validateMultiJson.ok === true &&
    Array.isArray(validateMultiJson.seatings) &&
    validateMultiJson.seatings.length === (thinResult.seatings?.length ?? 0) &&
    validateMultiJson.seatings.every((seating) => seating.ok === true),
  `exit=${validateMultiRun.status} ok=${validateMultiJson.ok}；seating 结论 ${validateMultiJson.seatings?.length ?? 0}/${thinResult.seatings?.length ?? 0}；stderr：${validateMultiRun.stderr
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 80)}`,
);

/* ---------- 17. 输入契约（task-11）：表头宽容 / 缺考两路 / 未匹配不静默 ---------- */

// 17a. 表头花样：准 考 证 号（空格）/ 姓（全角空格）名 / 班 级
const spacedHeaderFile = path.join(work, "input-header-spaced.xlsx");
writeSheet(spacedHeaderFile, [
  ["准 考 证 号", "姓\u3000名", "班 级"],
  ["H1", "张三", "高三(1)班"],
  ["H2", "李四", "高三(1)班"],
  ["H3", "王五", "高三(2)班"],
]);
const spacedHeaderRun = runRoster(["--file", spacedHeaderFile]);
const spacedHeaderStudents = byStudentId(spacedHeaderRun.json?.students);
const spacedHeaderExpected = [
  ["H1", "张三", "高三(1)班"],
  ["H2", "李四", "高三(1)班"],
  ["H3", "王五", "高三(2)班"],
];
check(
  "输入契约：带空格/全角空格的 准考证号·姓名·班级 表头都能识别",
  spacedHeaderRun.status === 0 &&
    spacedHeaderRun.json?.mapping?.id !== undefined &&
    spacedHeaderRun.json?.mapping?.name !== undefined &&
    spacedHeaderRun.json?.mapping?.className !== undefined &&
    spacedHeaderRun.json?.studentCount === 3 &&
    spacedHeaderExpected.every(([id, name, className]) => {
      const student = spacedHeaderStudents.get(id);
      return student?.name === name && student?.className === className;
    }),
  `studentCount=${spacedHeaderRun.json?.studentCount ?? "?"}；mapping.id=${spacedHeaderRun.json?.mapping?.id ?? "无"} name=${spacedHeaderRun.json?.mapping?.name ?? "无"} class=${spacedHeaderRun.json?.mapping?.className ?? "无"}`,
);

// 17b. 别名「考证号」也要认成 id
const examNoHeaderFile = path.join(work, "input-header-examno.xlsx");
writeSheet(examNoHeaderFile, [
  ["考证号", "姓名", "班级"],
  ["E1", "考生甲", "高三(1)班"],
  ["E2", "考生乙", "高三(2)班"],
]);
const examNoHeaderRun = runRoster(["--file", examNoHeaderFile]);
const examNoStudents = byStudentId(examNoHeaderRun.json?.students);
check(
  "输入契约：「考证号」表头识别为 id",
  examNoHeaderRun.status === 0 &&
    examNoHeaderRun.json?.mapping?.id !== undefined &&
    examNoStudents.get("E1")?.className === "高三(1)班" &&
    examNoStudents.get("E2")?.className === "高三(2)班",
  `id 列=${examNoHeaderRun.json?.mapping?.id ?? "无"}；id=${[...examNoStudents.keys()].join("、") || "无"}`,
);

// 17c. 「班主任」不能当班级列
const headTeacherFile = path.join(work, "input-header-headteacher.xlsx");
writeSheet(headTeacherFile, [
  ["准考证号", "姓名", "班级", "班主任"],
  ["T1", "考生丙", "高三(3)班", "张老师"],
  ["T2", "考生丁", "高三(3)班", "李老师"],
]);
const headTeacherRun = runRoster(["--file", headTeacherFile]);
const headTeacherStudents = headTeacherRun.json?.students ?? [];
check(
  "输入契约：「班主任」不会被当成班级列",
  headTeacherRun.status === 0 &&
    headTeacherStudents.length === 2 &&
    headTeacherStudents.every(
      (student) => student.className === "高三(3)班" && !String(student.className).includes("老师"),
    ) &&
    headTeacherRun.json?.mapping?.className !== 3,
  `mapping.className=${headTeacherRun.json?.mapping?.className ?? "无"}；解析出的班级=${[...new Set(headTeacherStudents.map((s) => s.className))].join("/") || "无"}`,
);

// 17d. 缺考列取值矩阵（空 / 否 / N / no / false / 0 / 正常 / 参加 / 无 / - / — / / 视为不缺席）
const absentCellValues = [
  "",
  "否",
  "N",
  "no",
  "false",
  "0",
  "正常",
  "参加",
  "无",
  "-",
  "—",
  "/",
  "病假",
  "是",
  "缺席",
];
const absentMatrixRows = [["准考证号", "姓名", "班级", "缺考"]];
absentCellValues.forEach((value, index) => {
  absentMatrixRows.push([
    `M${String(index + 1).padStart(2, "0")}`,
    `考生${index + 1}`,
    "高三(1)班",
    value,
  ]);
});
const absentMatrixFile = path.join(work, "input-absent-matrix.xlsx");
writeSheet(absentMatrixFile, absentMatrixRows);
const absentMatrixRun = runRoster(["--file", absentMatrixFile]);
const absentMatrixAbsentIds = (absentMatrixRun.json?.students ?? [])
  .filter((student) => student.included === false)
  .map((student) => student.id)
  .sort();
check(
  "输入契约：缺考列取值矩阵（只有 病假/是/缺席 视为缺席）",
  absentMatrixRun.status === 0 &&
    absentMatrixRun.json?.studentCount === absentCellValues.length &&
    JSON.stringify(absentMatrixAbsentIds) === JSON.stringify(["M13", "M14", "M15"]),
  `缺席=${absentMatrixAbsentIds.join("、") || "无"}（期望 M13、M14、M15）；共 ${absentMatrixRun.json?.studentCount ?? "?"} 人`,
);

// 17e–17h 共用完整名单（8 人）
const fullRosterRows = [
  ["准考证号", "姓名", "班级"],
  ["S01", "学生01", "高三(1)班"],
  ["S02", "学生02", "高三(1)班"],
  ["S03", "学生03", "高三(2)班"],
  ["S04", "学生04", "高三(2)班"],
  ["S05", "学生05", "高三(3)班"],
  ["S06", "学生06", "高三(3)班"],
  ["S07", "学生07", "高三(1)班"],
  ["S08", "学生08", "高三(2)班"],
];
const fullRosterFile = path.join(work, "input-full-roster.xlsx");
writeSheet(fullRosterFile, fullRosterRows);
const absentFromRoster = (result) =>
  (result.json?.students ?? [])
    .filter((student) => student.included === false)
    .map((student) => student.id)
    .sort();

// 17e. 缺考名单按准考证号（优先）
const absentByIdFile = path.join(work, "input-absent-by-id.xlsx");
writeSheet(absentByIdFile, [["准考证号"], ["S02"], ["S04"], ["S05"], ["S07"], ["S08"]]);
const absentByIdRun = runRoster(["--file", fullRosterFile, "--absent", absentByIdFile]);
check(
  "输入契约：缺考名单按准考证号匹配（命中 5 人）",
  absentByIdRun.status === 0 &&
    absentByIdRun.json?.studentCount === 8 &&
    JSON.stringify(absentFromRoster(absentByIdRun)) ===
      JSON.stringify(["S02", "S04", "S05", "S07", "S08"]) &&
    /命中/.test(absentByIdRun.output),
  `included=false：${absentFromRoster(absentByIdRun).join("、") || "无"}；stderr：${absentByIdRun.stderr.replaceAll(/\s+/g, " ").trim().slice(0, 80)}`,
);

// 17f. 缺考名单按 姓名 + 班级
const absentByNameClassFile = path.join(work, "input-absent-by-name-class.xlsx");
writeSheet(absentByNameClassFile, [
  ["姓名", "班级"],
  ["学生02", "高三(1)班"],
  ["学生05", "高三(3)班"],
  ["学生08", "高三(2)班"],
]);
const absentByNameClassRun = runRoster([
  "--file",
  fullRosterFile,
  "--absent",
  absentByNameClassFile,
]);
check(
  "输入契约：缺考名单按 姓名+班级 匹配（命中 3 人）",
  absentByNameClassRun.status === 0 &&
    JSON.stringify(absentFromRoster(absentByNameClassRun)) ===
      JSON.stringify(["S02", "S05", "S08"]),
  `included=false：${absentFromRoster(absentByNameClassRun).join("、") || "无"}（期望 S02、S05、S08）`,
);

// 17g. 未匹配必须报出来（键值可见，不能静默）
const absentUnmatchedFile = path.join(work, "input-absent-unmatched.xlsx");
writeSheet(absentUnmatchedFile, [["准考证号"], ["S02"], ["S99"]]);
const absentUnmatchedRun = runRoster(["--file", fullRosterFile, "--absent", absentUnmatchedFile]);
const unmatchedOutput = absentUnmatchedRun.output;
const unmatchedVisible =
  /未匹配|未找到|找不到|未命中/.test(unmatchedOutput) && unmatchedOutput.includes("S99");
check(
  "输入契约：缺考名单未匹配的行必须报出来（不静默）",
  absentUnmatchedRun.status === 0 &&
    JSON.stringify(absentFromRoster(absentUnmatchedRun)) === JSON.stringify(["S02"]) &&
    unmatchedVisible,
  `included=false：${absentFromRoster(absentUnmatchedRun).join("、") || "无"}；输出含未匹配字样=${/未匹配|未找到|找不到|未命中/.test(unmatchedOutput)}、含键值 S99=${unmatchedOutput.includes("S99")}`,
);

// 17h. 缺考名单自带「缺考」列 → 完整名单 + 标记，只取真正缺席的行
const markedFullRows = [["准考证号", "姓名", "班级"]];
const markedAbsentRows = [["准考证号", "姓名", "班级", "缺考"]];
const markedValues = { A01: "", A02: "否", A03: "病假", A04: "是", A05: "正常", A06: "-" };
for (const [id, value] of Object.entries(markedValues)) {
  markedFullRows.push([id, `标记${id}`, "高三(1)班"]);
  markedAbsentRows.push([id, `标记${id}`, "高三(1)班", value]);
}
const markedFullFile = path.join(work, "input-marked-full.xlsx");
const markedAbsentFile = path.join(work, "input-marked-absent.xlsx");
writeSheet(markedFullFile, markedFullRows);
writeSheet(markedAbsentFile, markedAbsentRows);
const markedRun = runRoster(["--file", markedFullFile, "--absent", markedAbsentFile]);
check(
  "输入契约：缺考名单自带「缺考」列时只取真正缺席的行",
  markedRun.status === 0 &&
    markedRun.json?.studentCount === 6 &&
    JSON.stringify(absentFromRoster(markedRun)) === JSON.stringify(["A03", "A04"]),
  `included=false：${absentFromRoster(markedRun).join("、") || "无"}（期望 A03、A04）`,
);

// 17i. 多个疑似 id 列（准考证号 + 学号，值不同）：必须稳定地只认一列，不能混用/串列。
const dualIdFile = path.join(work, "input-dual-id.xlsx");
writeSheet(dualIdFile, [
  ["准考证号", "学号", "姓名", "班级"],
  ["Z1", "X1", "甲", "高三(1)班"],
  ["Z2", "X2", "乙", "高三(2)班"],
]);
const dualIdRun = runRoster(["--file", dualIdFile]);
const dualIdStudents = dualIdRun.json?.students ?? [];
const dualIds = dualIdStudents.map((student) => student.id).sort();
const dualByName = new Map(dualIdStudents.map((student) => [student.name, student]));
const dualIdOneColumn =
  dualIds.every((id) => id.startsWith("Z")) || dualIds.every((id) => id.startsWith("X"));
check(
  "输入契约：多个疑似 id 列（准考证号 + 学号）时只认一列、不混用",
  dualIdRun.status === 0 &&
    dualIdStudents.length === 2 &&
    dualIdOneColumn &&
    dualByName.get("甲")?.className === "高三(1)班" &&
    dualByName.get("乙")?.className === "高三(2)班",
  `id 列=${dualIdRun.json?.mapping?.id ?? "无"}；ids=${dualIds.join("、") || "无"}；班级=${dualIdStudents.map((s) => s.className).join("、") || "无"}`,
);

// 17j. 名单自带「缺考」列 + 缺考名单同时存在 → 两份来源取并集，不能互相覆盖/吞掉。
const unionFullRows = [["准考证号", "姓名", "班级", "缺考"]];
for (const row of fullRosterRows.slice(1)) {
  unionFullRows.push([...row, row[0] === "S03" ? "病假" : ""]);
}
const unionFullFile = path.join(work, "input-union-full.xlsx");
const unionAbsentFile = path.join(work, "input-union-absent.xlsx");
writeSheet(unionFullFile, unionFullRows);
writeSheet(unionAbsentFile, [["准考证号"], ["S05"]]);
const unionRun = runRoster(["--file", unionFullFile, "--absent", unionAbsentFile]);
check(
  "输入契约：名单「缺考」列与缺考名单同时存在时取并集（S03 + S05）",
  unionRun.status === 0 &&
    JSON.stringify(absentFromRoster(unionRun)) === JSON.stringify(["S03", "S05"]),
  `included=false：${absentFromRoster(unionRun).join("、") || "无"}（期望 S03、S05）`,
);

// 17k. 读名单 / 应用缺考名单不能原地改原文件。
const rosterBytesBefore = readFileSync(fullRosterFile);
runRoster(["--file", fullRosterFile, "--absent", absentByIdFile]);
const rosterBytesAfter = readFileSync(fullRosterFile);
check(
  "输入契约：读取名单与应用缺考名单不会改动原文件",
  Buffer.compare(rosterBytesBefore, rosterBytesAfter) === 0,
  `原文件 ${rosterBytesBefore.length} → ${rosterBytesAfter.length} 字节`,
);

// 17l. 缺考名单既无 id 又缺班级：必须明确报错，不能按姓名静默匹配。
const nameOnlyAbsentFile = path.join(work, "input-absent-name-only.xlsx");
writeSheet(nameOnlyAbsentFile, [["姓名"], ["学生02"]]);
const nameOnlyRun = runRoster(["--file", fullRosterFile, "--absent", nameOnlyAbsentFile]);
check(
  "输入契约：缺考名单既无 id 又缺班级时必须明确报错（不能静默）",
  (nameOnlyRun.status !== 0 || /班级|className|缺少|无法/.test(nameOnlyRun.output)) &&
    !absentFromRoster(nameOnlyRun).includes("S02"),
  `exit=${nameOnlyRun.status}；included=false：${absentFromRoster(nameOnlyRun).join("、") || "无"}；输出：${nameOnlyRun.output
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 90)}`,
);

/* ---------- 18. 多场次限定 + 多场次校验（task-14） ---------- */

const constraintStudents = [];
const addConstraintStudents = (prefix, combination, count) => {
  for (let i = 1; i <= count; i += 1) {
    constraintStudents.push({
      id: `${prefix}${String(i).padStart(2, "0")}`,
      name: `${prefix}考生${i}`,
      className: `高三(${i})班`,
      combination,
      subjects: COMBO_SUBJECT_IDS[combination],
    });
  }
};
addConstraintStudents("P", "物化生", 6);
addConstraintStudents("H", "政史地", 5);
addConstraintStudents("Z", "物化政", 4);
addConstraintStudents("D", "物化地", 4);

const constraintJob = {
  jobVersion: 2,
  meta: { title: "多场次限定验收" },
  options: { seed: 20260930 },
  students: constraintStudents,
  rooms: [
    { id: "R1", name: "第1考场", rows: 6, cols: 5 },
    { id: "R2", name: "第2考场", rows: 7, cols: 6 },
    { id: "R3", name: "第3考场", rows: 6, cols: 5, dedicatedSubjects: ["politics"] },
    { id: "R4", name: "第4考场", rows: 6, cols: 5 },
    { id: "R5", name: "第5考场", rows: 6, cols: 5 },
    { id: "R6", name: "第6考场", rows: 7, cols: 6 },
  ],
  constraints: [
    { id: "C1", note: "指定大考场首排", studentIds: ["P01", "P02"], roomId: "R2", rows: ["first"] },
    { id: "C2", note: "指定大考场靠门", studentIds: ["P03"], roomId: "R2", cols: ["door"] },
    { id: "C3", note: "指定小考场首排", studentIds: ["P06"], roomId: "R1", rows: ["first"] },
    { id: "C4", note: "指定大考场靠窗", studentIds: ["P05"], roomId: "R2", cols: ["window"] },
    { id: "C5", note: "首排（与 C6 交集）", studentIds: ["P04"], rows: ["first"] },
    { id: "C6", note: "靠门（与 C5 交集）", studentIds: ["P04"], cols: ["door"] },
    { id: "C7", note: "政史地全体末排", combinations: ["政史地"], rows: ["last"] },
    { id: "C8", note: "H01 靠窗", studentIds: ["H01"], cols: ["window"] },
    { id: "C9", note: "物化政全体靠门", combinations: ["物化政"], cols: ["door"] },
    { id: "C10", note: "物化地全体首排", combinations: ["物化地"], rows: ["first"] },
    { id: "C11", note: "考历史的末排（subjects 选择器）", subjects: ["history"], rows: ["last"] },
    { id: "C12", note: "指定小考场靠窗", studentIds: ["P06"], roomId: "R1", cols: ["window"] },
  ],
};
const constraintPath = path.join(work, "multi-constraints.json");
const constraintDir = path.join(work, "multi-constraints-out");
writeFileSync(constraintPath, JSON.stringify(constraintJob, null, 2));
const constraintRun = runFull([
  "--json",
  "plan",
  "--job",
  constraintPath,
  "--out-dir",
  constraintDir,
]);
const constraintResult = JSON.parse(constraintRun.stdout || "{}");
const assignMany = (ids) =>
  ids.flatMap((id) => studentSeatAssignments(constraintResult, constraintJob, id));

// 18a. rows:["first"]：大考场（R2，7×6，C1 钉住）与小考场（R1，6×5，C3 钉住）各一例；
//      另复核物化地全体（C10，不钉考场）。
const largeFirst = assignMany(["P01", "P02"]);
const smallFirst = assignMany(["P06"]);
const dFirst = assignMany(["D01", "D02", "D03", "D04"]);
const constraintErrors = (constraintResult.diagnostics ?? []).filter(
  (diagnostic) => diagnostic.severity === "error",
);
check(
  '多场次限定：rows:["first"] 在大考场（R2）与小考场（R1）都落第 1 排',
  constraintResult.ok === true &&
    (constraintResult.unmetConstraints ?? []).length === 0 &&
    constraintErrors.length === 0 &&
    largeFirst.length > 0 &&
    largeFirst.every((assignment) => assignment.roomId === "R2" && assignment.row === 1) &&
    smallFirst.length > 0 &&
    smallFirst.every((assignment) => assignment.roomId === "R1" && assignment.row === 1) &&
    dFirst.length > 0 &&
    dFirst.every((assignment) => assignment.row === 1),
  `ok=${constraintResult.ok} unmet=${(constraintResult.unmetConstraints ?? []).length} errors=${
    constraintErrors.map((diagnostic) => diagnostic.code).join(",") || "无"
  }；R2 首排 ${largeFirst.length} 次；R1 首排 ${smallFirst.length} 次；物化地首排 ${dFirst.length} 次`,
);

// 18b. cols:["door"] = 业务第 1 列；cols:["window"] = 大考场第 6 列（R2）/ 小考场第 5 列（R1）
const doorAssignments = assignMany(["P03", "Z01", "Z02", "Z03", "Z04"]);
const largeWindow = assignMany(["P05"]);
const smallWindow = assignMany(["P06"]);
const hWindow = assignMany(["H01"]);
check(
  '多场次限定：cols:["door"]=第 1 列；["window"]=大考场第 6 列 / 小考场第 5 列',
  constraintResult.ok === true &&
    doorAssignments.length > 0 &&
    doorAssignments.every((assignment) => assignment.col === 1) &&
    largeWindow.length > 0 &&
    largeWindow.every((assignment) => assignment.roomId === "R2" && assignment.col === 6) &&
    smallWindow.length > 0 &&
    smallWindow.every((assignment) => assignment.roomId === "R1" && assignment.col === 5) &&
    hWindow.length > 0 &&
    hWindow.every(
      (assignment) =>
        assignment.col ===
        (constraintJob.rooms.find((room) => room.id === assignment.roomId)?.cols ?? -1),
    ),
  `靠门 ${doorAssignments.length} 次（列=${[...new Set(doorAssignments.map((a) => a.col))].join("/")}）；R2 靠窗 ${largeWindow.map((a) => a.col).join("/") || "—"}；R1 靠窗 ${smallWindow.map((a) => a.col).join("/") || "—"}；H01=${hWindow.map((a) => `${a.roomId}#${a.col}`).join("、") || "无"}`,
);

// 18c. roomId:"R2" → 命中学生所有时段都在 R2，且 R2 是其组合批次
const roomIdAssignments = assignMany(["P01", "P02"]);
const p01Seatings = (constraintResult.seatings ?? []).filter((seating) =>
  seating.studentIds.includes("P01"),
);
check(
  '多场次限定：roomId:"R2" 的命中学生所有时段都在 R2，且 R2 是其组合批次',
  constraintResult.ok === true &&
    roomIdAssignments.length > 0 &&
    roomIdAssignments.every((assignment) => assignment.roomId === "R2") &&
    p01Seatings.length >= 1 &&
    p01Seatings.every((seating) => seating.roomId === "R2") &&
    p01Seatings.every((seating) =>
      seating.studentIds.every(
        (id) =>
          constraintJob.students.find((student) => student.id === id)?.combination === "物化生",
      ),
    ),
  `P01/P02 共 ${roomIdAssignments.length} 次，房间=${[...new Set(roomIdAssignments.map((a) => a.roomId))].join("/") || "—"}；P01 所属座位方案=${p01Seatings.map((s) => `${s.roomId}(${s.studentIds.length}人)`).join("、") || "无"}`,
);

// 18d. 两条规则取交集：P04 = 首排（C3）∩ 靠门（C4）
const p04Assignments = assignMany(["P04"]);
check(
  "多场次限定：同一学生两条规则取交集（首排 ∩ 靠门 → 第 1 排第 1 列）",
  p04Assignments.length > 0 &&
    p04Assignments.every((assignment) => assignment.row === 1 && assignment.col === 1),
  `P04 共 ${p04Assignments.length} 次；行列=${p04Assignments.map((a) => `(${a.row},${a.col})`).join(" ") || "无"}`,
);

// 18e. combinations / subjects 选择器在多场次下同样生效
const hAssignments = assignMany(["H01", "H02", "H03", "H04", "H05"]);
const zAssignments = assignMany(["Z01", "Z02", "Z03", "Z04"]);
check(
  "多场次限定：combinations / subjects 选择器生效（政史地末排、物化政靠门、物化地首排）",
  constraintResult.ok === true &&
    hAssignments.length > 0 &&
    hAssignments.every(
      (assignment) =>
        assignment.row ===
        (constraintJob.rooms.find((room) => room.id === assignment.roomId)?.rows ?? -1),
    ) &&
    dFirst.length > 0 &&
    dFirst.every((assignment) => assignment.row === 1) &&
    zAssignments.length > 0 &&
    zAssignments.every((assignment) => assignment.col === 1),
  `政史地 ${hAssignments.length} 次（末排）；物化政 ${zAssignments.length} 次（靠门）；物化地 ${dFirst.length} 次（首排）`,
);

// 18f. 无法满足的限定：必须明确诊断且不导出名单，绝不静默
const unsatisfiableJob = {
  jobVersion: 2,
  meta: { title: "多场次限定不可满足" },
  options: { seed: 20260930 },
  students: constraintStudents.filter(
    (student) => student.combination === "物化生" || student.combination === "物化政",
  ),
  rooms: [
    { id: "R1", name: "第1考场", rows: 6, cols: 5 },
    { id: "R2", name: "第2考场", rows: 6, cols: 5, dedicatedSubjects: ["politics"] },
    { id: "R3", name: "第3考场", rows: 6, cols: 5 },
  ],
  constraints: [{ id: "X1", note: "把物化生钉进政治专用考场", studentIds: ["P01"], roomId: "R2" }],
};
const unsatisfiablePath = path.join(work, "multi-constraints-unsat.json");
const unsatisfiableDir = path.join(work, "multi-constraints-unsat-out");
writeFileSync(unsatisfiablePath, JSON.stringify(unsatisfiableJob, null, 2));
const unsatisfiableRun = runFull([
  "--json",
  "plan",
  "--job",
  unsatisfiablePath,
  "--out-dir",
  unsatisfiableDir,
]);
const unsatisfiableResult = JSON.parse(unsatisfiableRun.stdout || "{}");
const unsatisfiableDiagnostics = (unsatisfiableResult.diagnostics ?? []).map(
  (diagnostic) => `${diagnostic.code}: ${diagnostic.message}`,
);
check(
  "多场次限定无法满足：明确诊断 + 不静默 + 不导出名单",
  unsatisfiableResult.ok === false &&
    (unsatisfiableDiagnostics.some((entry) =>
      /CONSTRAINT|RULE_INTERSECT|ROOM|SEARCH_FAILED|NO_ROOMS|CAPACITY/.test(entry),
    ) ||
      (unsatisfiableResult.unmetConstraints ?? []).length > 0) &&
    /P01|X1|限定|专用/.test(`${unsatisfiableRun.stdout}${unsatisfiableRun.stderr}`) &&
    fileSize(path.join(unsatisfiableDir, "按班级考场安排.xlsx")) < 0 &&
    unsatisfiableRun.status !== 0,
  `ok=${unsatisfiableResult.ok} exit=${unsatisfiableRun.status}；诊断：${
    unsatisfiableDiagnostics.slice(0, 3).join(" | ") || "无"
  }；unmet=${(unsatisfiableResult.unmetConstraints ?? []).length}`,
);

// 18g. validate 对多场次正常结果：exit 0，每套 seating 都有结论
const constraintPlanPath = path.join(constraintDir, "plan.json");
const validateAllJsonRun = runFull([
  "--json",
  "validate",
  "--job",
  constraintPath,
  "--plan",
  constraintPlanPath,
]);
let validateAllJson = {};
try {
  validateAllJson = JSON.parse(validateAllJsonRun.stdout);
} catch {
  validateAllJson = {};
}
const validateAllTextRun = runFull([
  "validate",
  "--job",
  constraintPath,
  "--plan",
  constraintPlanPath,
]);
const validateAllSeatings = validateAllJson.seatings ?? [];
const validateTextOutput = `${validateAllTextRun.stdout}${validateAllTextRun.stderr}`;
check(
  "多场次校验：validate 对正常结果 exit 0，且每套 seating 都有结论",
  constraintRun.status === 0 &&
    validateAllJsonRun.status === 0 &&
    validateAllJson.ok === true &&
    validateAllSeatings.length === (constraintResult.seatings ?? []).length &&
    validateAllSeatings.every((seating) => seating.ok === true) &&
    validateAllSeatings.every((seating) => (seating.seats ?? 0) > 0) &&
    validateAllTextRun.status === 0 &&
    (constraintResult.seatings ?? []).every((seating) =>
      validateTextOutput.includes(seating.roomName),
    ),
  `exit=${validateAllJsonRun.status} ok=${validateAllJson.ok}；seating 结论 ${validateAllSeatings.length}/${constraintResult.seatings?.length ?? 0}；issues=${(validateAllJson.issues ?? []).length}`,
);

// 18h. 人为改坏：同一座位两人 → exit 3 且原因可读
const corruptedDupPlan = JSON.parse(readFileSync(constraintPlanPath, "utf8"));
let corruptedDupApplied = false;
const dupSeating = (corruptedDupPlan.seatings ?? []).find(
  (seating) => (seating.result?.entries ?? []).length >= 2,
);
if (dupSeating) {
  const { entries } = dupSeating.result;
  entries[1].seatNo = entries[0].seatNo;
  corruptedDupApplied = true;
}
const corruptedDupPath = path.join(work, "plan-corrupted-duplicate-seat.json");
writeFileSync(corruptedDupPath, JSON.stringify(corruptedDupPlan, null, 2));
const corruptedDupRun = runFull([
  "--json",
  "validate",
  "--job",
  constraintPath,
  "--plan",
  corruptedDupPath,
]);
let corruptedDupJson = {};
try {
  corruptedDupJson = JSON.parse(corruptedDupRun.stdout);
} catch {
  corruptedDupJson = {};
}
check(
  "多场次校验：人为造同址两人 → exit 3 且原因可读",
  corruptedDupApplied &&
    corruptedDupRun.status === 3 &&
    corruptedDupJson.ok === false &&
    (corruptedDupJson.issues ?? []).length > 0 &&
    /SEAT|座位/.test(JSON.stringify(corruptedDupJson.issues)),
  `exit=${corruptedDupRun.status} ok=${corruptedDupJson.ok}；issues=${(corruptedDupJson.issues ?? []).map((issue) => issue.code).join(",") || "无"}`,
);

// 18i. 人为改坏：把受限学生挪出首排 → exit 3 且限定未满足被指出
const corruptedConstraintPlan = JSON.parse(readFileSync(constraintPlanPath, "utf8"));
const targetSeating = (corruptedConstraintPlan.seatings ?? []).find((seating) =>
  (seating.studentIds ?? []).includes("P01"),
);
const targetRoom = targetSeating
  ? constraintJob.rooms.find((room) => room.id === targetSeating.roomId)
  : undefined;
const targetEntry = targetSeating?.result?.entries?.find((entry) => entry.studentId === "P01");
let corruptedConstraintApplied = false;
if (targetSeating && targetRoom && targetEntry) {
  const usedSeats = new Set(Object.values(targetSeating.seatNoById ?? {}));
  let nextSeat = targetRoom.rows + 1;
  while (usedSeats.has(nextSeat)) nextSeat += 1;
  const rc = seatNoToRowCol(targetRoom.rows, nextSeat);
  const oldSeat = targetEntry.seatNo;
  targetEntry.seatNo = nextSeat;
  targetEntry.row = rc.row;
  targetEntry.col = rc.col;
  targetEntry.physicalCol = targetRoom.cols - rc.col + 1;
  targetSeating.seatNoById.P01 = nextSeat;
  targetSeating.studentBySeatNo = Object.fromEntries(
    Object.entries(targetSeating.studentBySeatNo).filter(([seatNo]) => Number(seatNo) !== oldSeat),
  );
  targetSeating.studentBySeatNo[nextSeat] = "P01";
  corruptedConstraintApplied = true;
}
const corruptedConstraintPath = path.join(work, "plan-corrupted-constraint-seat.json");
writeFileSync(corruptedConstraintPath, JSON.stringify(corruptedConstraintPlan, null, 2));
const corruptedConstraintRun = runFull([
  "--json",
  "validate",
  "--job",
  constraintPath,
  "--plan",
  corruptedConstraintPath,
]);
let corruptedConstraintJson = {};
try {
  corruptedConstraintJson = JSON.parse(corruptedConstraintRun.stdout);
} catch {
  corruptedConstraintJson = {};
}
check(
  "多场次校验：把受限学生挪出首排 → exit 3 且限定未满足被指出",
  corruptedConstraintApplied &&
    corruptedConstraintRun.status === 3 &&
    corruptedConstraintJson.ok === false &&
    /CONSTRAINT|限定|未满足/.test(JSON.stringify(corruptedConstraintJson.issues ?? [])),
  `exit=${corruptedConstraintRun.status} ok=${corruptedConstraintJson.ok}；issues=${
    (corruptedConstraintJson.issues ?? []).map((issue) => issue.code).join(",") || "无"
  }`,
);

// 18j. 带限定场景的硬规则独立复核
check(
  "带限定的多场次结果：硬规则独立复核零违规",
  constraintResult.ok === true &&
    hardRuleViolations(constraintResult).length === 0 &&
    seatingSubjectViolations(constraintResult).length === 0 &&
    seatCollisions(constraintResult).length === 0 &&
    !diagnosticCodes(constraintResult).includes("ROOM_SUBJECT_CLASH"),
  `座位方案 ${constraintResult.seatings?.length ?? 0} 套；硬规则违规 ${hardRuleViolations(constraintResult).length} 处`,
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
