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

/* ---------- 19. 考场级放宽 / 按科目借考 / 加座考场 / 显式时段（见 docs/design.md §5.8） ---------- */

/** 跑一次 plan 并把 plan.json 读回来（第 19 节自己的小工具）。 */
const runPlanJob = (label, job, extraArgs = []) => {
  const jobPath = path.join(work, `${label}.json`);
  const outDir = path.join(work, `${label}-out`);
  writeFileSync(jobPath, JSON.stringify(job, null, 2));
  const run = runFull(["--json", "plan", "--job", jobPath, "--out-dir", outDir, ...extraArgs]);
  let result = {};
  try {
    result = JSON.parse(run.stdout || "{}");
  } catch {
    result = {};
  }
  return {
    job,
    jobPath,
    outDir,
    run,
    result,
    plan: readJsonIfExists(path.join(outDir, "plan.json")),
  };
};

/** 工作簿里全部单元格文本拼起来，用于断言「借考」「已放宽同班相邻」这类标注。 */
const workbookText = (file) => {
  try {
    const wb = readWorkbook(readFileSync(file), { type: "buffer" });
    const parts = [];
    for (const name of wb.SheetNames) {
      const rows = xlsxUtils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false });
      parts.push(`${name} ${rows.flat().join(" ")}`);
    }
    return parts.join(" ");
  } catch {
    return "";
  }
};

/** 给指定学生加 `subjectRoom`（第 19 节借考场景用；用副本，不改原数组）。 */
const withBorrowRoom = (roster, subjectRoom) => {
  const out = [];
  for (const student of roster) {
    out.push(student.id === "BORROW01" ? { ...student, subjectRoom } : student);
  }
  return out;
};

/** 递归剔掉 generatedAt / elapsedMs，用于「同 seed 结果一致」比较。 */
const pruneTimestamps = (node) => {
  if (node == null || typeof node !== "object") return;
  delete node.generatedAt;
  if (node.stats) delete node.stats.elapsedMs;
  for (const value of Object.values(node)) {
    if (typeof value === "object") pruneTimestamps(value);
  }
};

/** 独立重算加座考场的座位号（不 import core）：列座位数 = rows + 该列是否加座； 列内蛇形（奇数列从前往后、偶数列从后往前），加座永远是该列最后一个号、行号 0。 */
const seatNoInRoom = (rows, cols, extraCols, row, col) => {
  let base = 0;
  for (let c = 1; c < col; c += 1) base += rows + (extraCols.includes(c) ? 1 : 0);
  const count = rows + (extraCols.includes(col) ? 1 : 0);
  if (row === 0) return count > rows ? base + count : -1;
  return base + (col % 2 === 1 ? row : rows - row + 1);
};

/** 多场次结果里每套座位自带 generatedAt / elapsedMs，只剔顶层会误判成「结果不一致」。 */
const stablePlan = (plan) => {
  if (!plan) return null;
  const copy = JSON.parse(JSON.stringify(plan));
  pruneTimestamps(copy);
  return JSON.stringify(copy);
};

// 本节自成一块作用域，避免与前面各节的变量重名
{
  // 19a. 考场级放宽「同班相邻」：不放宽必须判死，放开后必须排得下且留痕
  const relaxStudents = [];
  for (let i = 0; i < 25; i += 1)
    relaxStudents.push({ id: `2026RA${i}`, name: `一班${i}`, className: "高三(1)班" });
  for (let i = 0; i < 5; i += 1)
    relaxStudents.push({ id: `2026RB${i}`, name: `二班${i}`, className: "高三(2)班" });
  const relaxRoomBase = { id: "R1", name: "第1考场", rows: 7, cols: 5 };
  const relaxMake = (relaxSameClass) => ({
    jobVersion: 2,
    meta: { title: `放宽同班相邻（${relaxSameClass ?? "不放宽"}）` },
    options: { seed: 20260930 },
    students: relaxStudents,
    rooms: [relaxSameClass === undefined ? relaxRoomBase : { ...relaxRoomBase, relaxSameClass }],
  });
  const relaxStrict = runPlanJob("accept-relax-strict", relaxMake());
  const relaxTrue = runPlanJob("accept-relax-true", relaxMake(true));
  const relaxNumber = runPlanJob("accept-relax-number", relaxMake(30));
  const relaxTooSmall = runPlanJob("accept-relax-small", relaxMake(20));

  check(
    "放宽同班相邻：默认（不放宽）25 人同班进 35 座考场 → CLASS_LIMIT_EXCEEDED 且不导出",
    relaxStrict.run.status === 3 &&
      diagnosticCodes(relaxStrict.result).includes("CLASS_LIMIT_EXCEEDED") &&
      (relaxStrict.plan?.entries ?? []).length === 0,
    `exit=${relaxStrict.run.status}；诊断=${[...new Set(diagnosticCodes(relaxStrict.result))].join(",")}`,
  );

  check(
    "放宽同班相邻：relaxSameClass=true → 30 人全部有座、零冲突、留痕、level=roomRelaxed",
    relaxTrue.result.ok === true &&
      (relaxTrue.plan?.entries ?? []).length === 30 &&
      (relaxTrue.plan?.stats?.conflicts ?? -1) === 0 &&
      relaxTrue.plan?.level === "roomRelaxed" &&
      diagnosticCodes(relaxTrue.result).includes("ROOM_SAME_CLASS_RELAXED"),
    `ok=${relaxTrue.result.ok} 人数=${(relaxTrue.plan?.entries ?? []).length} 冲突=${relaxTrue.plan?.stats?.conflicts} level=${relaxTrue.plan?.level}`,
  );

  check(
    "放宽同班相邻：数字上限 30 够用 → 同样通过；上限 20 不够 → 仍然 CLASS_LIMIT_EXCEEDED",
    relaxNumber.result.ok === true &&
      relaxTooSmall.run.status === 3 &&
      diagnosticCodes(relaxTooSmall.result).includes("CLASS_LIMIT_EXCEEDED"),
    `30→ok=${relaxNumber.result.ok}；20→exit=${relaxTooSmall.run.status}`,
  );

  // 19b. 非矩形加座考场：37 座编号与容量
  const nonRectStudents = Array.from({ length: 37 }, (_, i) => ({
    id: `2026N${String(i).padStart(2, "0")}`,
    name: `加座生${i}`,
    className: `高三(${(i % 10) + 1})班`,
  }));
  const nonRect = runPlanJob("accept-nonrect", {
    jobVersion: 2,
    meta: { title: "非矩形加座考场 37 座" },
    options: { seed: 20260930 },
    students: nonRectStudents,
    rooms: [{ id: "R1", name: "第1考场", rows: 7, cols: 5, extraFrontSeats: [2, 4] }],
  });
  const nonRectEntries = nonRect.plan?.entries ?? [];
  const extraSeat15 = nonRectEntries.find((entry) => entry.seatNo === 15);
  const extraSeat30 = nonRectEntries.find((entry) => entry.seatNo === 30);
  const nonRectSeatNos = new Set(nonRectEntries.map((entry) => entry.seatNo));
  check(
    "加座考场：5×7+[2,4] → 容量 37、37 人全有座、15/30 号是讲台侧加座（row=0）",
    nonRect.result.ok === true &&
      (nonRect.plan?.stats?.seatsTotal ?? 0) === 37 &&
      nonRectEntries.length === 37 &&
      nonRectSeatNos.size === 37 &&
      extraSeat15?.row === 0 &&
      extraSeat15?.col === 2 &&
      extraSeat30?.row === 0 &&
      extraSeat30?.col === 4,
    `总座位=${nonRect.plan?.stats?.seatsTotal} 人数=${nonRectEntries.length} 15号=${JSON.stringify(extraSeat15)} 30号=${JSON.stringify(extraSeat30)}`,
  );

  // 19c. 按科目借考：史生政学生 T6 到物化生的考场借考生物
  const borrowCombos = {
    物化生: ["physics", "chemistry", "biology"],
    物化政: ["physics", "chemistry", "politics"],
    物化地: ["physics", "chemistry", "geography"],
    史地政: ["history", "politics", "geography"],
    史生政: ["history", "biology", "politics"],
  };
  const borrowStudents = [];
  const borrowPush = (combo, count, classBase) => {
    for (let i = 0; i < count; i += 1)
      borrowStudents.push({
        id: `${combo}-${i}`,
        name: `${combo}${i}`,
        className: `高三(${classBase + (i % 3)})班`,
        combination: combo,
        subjects: borrowCombos[combo],
      });
  };
  borrowPush("物化生", 10, 1);
  borrowPush("物化政", 5, 4);
  borrowPush("物化地", 5, 6);
  borrowPush("史地政", 6, 8);
  const borrowee = {
    id: "BORROW01",
    name: "借考生",
    className: "高三(9)班",
    combination: "史生政",
    subjects: borrowCombos["史生政"],
    subjectRoom: { biology: "R1" },
  };
  borrowStudents.push(borrowee);
  const borrowRooms = [
    { id: "R1", name: "第1考场", rows: 7, cols: 6 },
    { id: "R2", name: "第2考场", rows: 7, cols: 6 },
    {
      id: "R3",
      name: "第3考场",
      rows: 6,
      cols: 5,
      dedicatedSubjects: ["politics", "geography"],
    },
    { id: "R4", name: "第4考场", rows: 7, cols: 5 },
  ];
  const borrowJobBase = (subjectRoom) => ({
    jobVersion: 2,
    meta: { title: "按科目借考" },
    options: { seed: 20260930, groupPreference: "fillRooms" },
    students: withBorrowRoom(borrowStudents, subjectRoom),
    rooms: borrowRooms,
    constraints: [
      { id: "B1-史地政在R4", combinations: ["史地政"], roomId: "R4" },
      { id: "B2-借考生主考场R4", studentIds: ["BORROW01"], roomId: "R4" },
    ],
  });
  const borrowRun = runPlanJob("accept-borrow", borrowJobBase({ biology: "R1" }));
  const borrowResult = borrowRun.result;
  const borrowStudent = (borrowResult.byStudent ?? []).find((s) => s.studentId === "BORROW01");
  const borrowSlot6 = borrowStudent?.slots?.T6 ?? null;
  const borrowSlot4 = borrowStudent?.slots?.T4 ?? null;
  const [borrowInfo] = borrowResult.borrowings ?? [];
  const politicsInR3 = (borrowResult.byStudent ?? []).filter(
    (s) => s.slots?.T7?.roomId === "R3",
  ).length;
  check(
    "按科目借考：T6 生物落在目标考场（R1）并与主考场（R4）分开，其它时段仍在主考场",
    borrowResult.ok === true &&
      borrowInfo?.studentId === "BORROW01" &&
      borrowInfo?.subject === "biology" &&
      borrowInfo?.roomId === "R1" &&
      borrowSlot6?.roomId === "R1" &&
      borrowSlot6?.subject === "biology" &&
      borrowSlot4?.roomId === "R4" &&
      borrowStudent?.distinctRooms === 2,
    `ok=${borrowResult.ok} T6=${JSON.stringify(borrowSlot6)} T4=${JSON.stringify(borrowSlot4)} borrowings=${(borrowResult.borrowings ?? []).length}`,
  );

  check(
    "按科目借考：目标考场该时段仍只开一科（硬规则独立复核 0 违规）、座位不冲突",
    hardRuleViolations(borrowResult).length === 0 &&
      seatCollisions(borrowResult).length === 0 &&
      seatingSubjectViolations(borrowResult).length === 0 &&
      !diagnosticCodes(borrowResult).includes("ROOM_SUBJECT_CLASH"),
    `硬规则违规=${hardRuleViolations(borrowResult).length} 座位冲突=${seatCollisions(borrowResult).length}`,
  );

  check(
    "按科目借考：主考场本来就考这一科时留在主考场（政治不进专用考场）",
    politicsInR3 === 5,
    `R3 政治人数=${politicsInR3}（期望 5 = 物化政，借考生政治留在 R4）`,
  );

  const borrowValidate = runFull([
    "--json",
    "validate",
    "--job",
    borrowRun.jobPath,
    "--plan",
    path.join(borrowRun.outDir, "plan.json"),
  ]);
  let borrowValidateJson = {};
  try {
    borrowValidateJson = JSON.parse(borrowValidate.stdout || "{}");
  } catch {
    borrowValidateJson = {};
  }
  check(
    "按科目借考：validate 独立复核通过（exit 0）",
    borrowValidate.status === 0 && borrowValidateJson.ok === true,
    `exit=${borrowValidate.status} ok=${borrowValidateJson.ok} issues=${(borrowValidateJson.issues ?? []).map((i) => i.code).join(",") || "无"}`,
  );

  const borrowWb = readWorkbook(readFileSync(path.join(borrowRun.outDir, "考场监考表.xlsx")), {
    type: "buffer",
  });
  const borrowSheetName = borrowWb.SheetNames.find((name) => name.startsWith("第1考场"));
  const borrowRemarkRows = borrowSheetName
    ? xlsxUtils
        .sheet_to_json(borrowWb.Sheets[borrowSheetName], { header: 1, raw: false, defval: "" })
        .slice(3)
        .filter((row) => String(row[4] ?? "").trim() !== "")
    : [];
  check(
    "按科目借考：借考行写「只考：生物」、主考场里缺生物的人写「不考：生物」（都不带时段）",
    borrowRemarkRows.length === 11 &&
      borrowRemarkRows.filter((row) => String(row[4]) === "只考：生物").length === 1 &&
      borrowRemarkRows.filter((row) => String(row[4]) === "不考：生物").length === 10 &&
      borrowRemarkRows.every((row) => !/时段|借考|（/.test(String(row[4]))),
    `sheet=${borrowSheetName}；备注行=${borrowRemarkRows.length}：只考=${borrowRemarkRows.filter((row) => String(row[4]) === "只考：生物").length} 不考=${borrowRemarkRows.filter((row) => String(row[4]) === "不考：生物").length}`,
  );

  // 19d. 借考目标考场该时段另有别的科目 → 必须报错、不导出
  const borrowClash = runPlanJob("accept-borrow-clash", borrowJobBase({ biology: "R3" }));
  check(
    "按科目借考：目标考场该时段已考别的科目 → SUBJECT_ROOM_CLASH 且不导出名单",
    borrowClash.run.status === 3 &&
      diagnosticCodes(borrowClash.result).includes("SUBJECT_ROOM_CLASH"),
    `exit=${borrowClash.run.status}；诊断=${[...new Set(diagnosticCodes(borrowClash.result))].join(",")}`,
  );

  // 19e. 显式时段：名单剔除文科生后自动推导会塌陷，显式给时段表就不塌
  const explicitSubjects = {
    物化生: ["physics", "chemistry", "biology"],
    物化政: ["physics", "chemistry", "politics"],
    物化地: ["physics", "chemistry", "geography"],
  };
  const explicitStudents = [];
  for (let i = 0; i < 10; i += 1)
    explicitStudents.push({
      id: `EX-生${i}`,
      name: `物化生${i}`,
      className: `高三(${1 + (i % 4)})班`,
      combination: "物化生",
      subjects: explicitSubjects["物化生"],
    });
  for (let i = 0; i < 6; i += 1)
    explicitStudents.push({
      id: `EX-政${i}`,
      name: `物化政${i}`,
      className: `高三(${5 + (i % 3)})班`,
      combination: "物化政",
      subjects: explicitSubjects["物化政"],
    });
  for (let i = 0; i < 6; i += 1)
    explicitStudents.push({
      id: `EX-地${i}`,
      name: `物化地${i}`,
      className: `高三(${8 + (i % 3)})班`,
      combination: "物化地",
      subjects: explicitSubjects["物化地"],
    });
  const explicitRooms = [
    { id: "R1", name: "第1考场", rows: 7, cols: 6 },
    { id: "R2", name: "第2考场", rows: 6, cols: 5, dedicatedSubjects: ["politics", "geography"] },
  ];
  const explicitSlots = [
    { id: "T1", name: "第1时段", subjects: ["chinese"] },
    { id: "T2", name: "第2时段", subjects: ["math"] },
    { id: "T3", name: "第3时段", subjects: ["english"] },
    { id: "T4", name: "第4时段", subjects: ["physics"] },
    { id: "T5", name: "第5时段", subjects: ["chemistry"] },
    { id: "T6", name: "第6时段", subjects: ["biology"] },
    { id: "T7", name: "第7时段", subjects: ["politics"] },
    { id: "T8", name: "第8时段", subjects: ["geography"] },
  ];
  const collapsed = runPlanJob("accept-slots-collapse", {
    jobVersion: 2,
    meta: { title: "时段塌陷（不给时段表）" },
    options: { seed: 20260930, groupPreference: "fillRooms" },
    students: explicitStudents,
    rooms: explicitRooms,
  });
  const explicit = runPlanJob("accept-slots-explicit", {
    jobVersion: 2,
    meta: { title: "显式时段表" },
    options: { seed: 20260930, groupPreference: "fillRooms", slots: explicitSlots },
    students: explicitStudents,
    rooms: explicitRooms,
  });
  const derivedSubjects = (collapsed.plan?.slots ?? []).map((s) => s.subjects.join("+"));
  check(
    "时段塌陷：政治/地理/生物被并进同一时段时，专用考场报 ROOM_SUBJECT_CLASH（不导出）",
    collapsed.run.status === 3 &&
      diagnosticCodes(collapsed.result).includes("ROOM_SUBJECT_CLASH") &&
      derivedSubjects.some((s) => s.includes("politics") && s.includes("geography")),
    `exit=${collapsed.run.status}；推导时段=${derivedSubjects.join(" | ")}`,
  );

  check(
    "显式时段：options.slots 原样生效、不再 ROOM_SUBJECT_CLASH、留有 SLOTS_PROVIDED",
    explicit.result.ok === true &&
      (explicit.plan?.slots ?? []).length === explicitSlots.length &&
      (explicit.plan?.slots ?? []).every((slot, i) => slot.id === explicitSlots[i].id) &&
      !diagnosticCodes(explicit.result).includes("ROOM_SUBJECT_CLASH") &&
      diagnosticCodes(explicit.result).includes("SLOTS_PROVIDED"),
    `ok=${explicit.result.ok} 时段数=${(explicit.plan?.slots ?? []).length} 诊断=${[...new Set(diagnosticCodes(explicit.result))].join(",")}`,
  );

  // 19f. 分房游标回卷：整批钉考场拆出的「未钉住」部分要能回到本批次已占用的考场
  // 注意：被钉的班（高三(1)班）不能再出现在物化生名单里，否则物化生的钉住批次会先占掉 R3
  const wrapClasses = ["高三(2)班", "高三(3)班", "高三(4)班", "高三(5)班", "高三(6)班"];
  const wrapHistory = ["history", "politics", "geography"];
  const wrapStudents = [];
  for (let i = 0; i < 12; i += 1)
    wrapStudents.push({
      id: `WRAP-A${i}`,
      name: `史地政A${i}`,
      className: "高三(1)班",
      combination: "史地政",
      subjects: wrapHistory,
    });
  for (let i = 0; i < 6; i += 1)
    wrapStudents.push({
      id: `WRAP-B${i}`,
      name: `史地政B${i}`,
      className: "高三(7)班",
      combination: "史地政",
      subjects: wrapHistory,
    });
  for (let i = 0; i < 119; i += 1)
    wrapStudents.push({
      id: `WRAP-P${i}`,
      name: `物化生${i}`,
      className: wrapClasses[i % wrapClasses.length],
      combination: "物化生",
      subjects: ["physics", "chemistry", "biology"],
    });
  const wrapJob = {
    jobVersion: 2,
    meta: { title: "整批钉考场 + 未钉住部分回卷" },
    options: { seed: 20260930, groupPreference: "fillRooms" },
    students: wrapStudents,
    rooms: [
      { id: "R1", name: "第1考场", rows: 7, cols: 6 },
      { id: "R2", name: "第2考场", rows: 7, cols: 6 },
      { id: "R3", name: "第3考场", rows: 7, cols: 5, relaxSameClass: true },
      { id: "R4", name: "第4考场", rows: 7, cols: 5 },
    ],
    constraints: [{ id: "W1-1班钉R3", classes: ["高三(1)班"], roomId: "R3" }],
  };
  const wrapRun = runPlanJob("accept-wrap", wrapJob);
  const wrapBIds = new Set(Array.from({ length: 6 }, (_, i) => `WRAP-B${i}`));
  const wrapBStudents = (wrapRun.result.byStudent ?? []).filter((s) => wrapBIds.has(s.studentId));
  const wrapBInR3 = wrapBStudents.filter((s) =>
    Object.values(s.slots ?? {}).some((item) => item?.roomId === "R3"),
  ).length;
  check(
    "分房游标回卷：整批钉考场后未钉住的 6 人回到本批次考场（不再 CAPACITY_INSUFFICIENT）",
    wrapRun.result.ok === true &&
      !diagnosticCodes(wrapRun.result).includes("CAPACITY_INSUFFICIENT") &&
      (wrapRun.result.byStudent ?? []).length === wrapStudents.length &&
      wrapBInR3 === 6,
    `ok=${wrapRun.result.ok} 诊断=${[...new Set(diagnosticCodes(wrapRun.result))].join(",")} 未钉住 6 人落在 R3 的有 ${wrapBInR3} 人`,
  );

  const wrapInvigilatorText = workbookText(path.join(wrapRun.outDir, "考场监考表.xlsx"));
  check("放宽留痕：监考表标注「已放宽同班相邻」", /已放宽同班相邻/.test(wrapInvigilatorText), "");

  // 19g. 复现性：同 job 同 seed 跑两次，plan.json 完全一致（排除时间戳/耗时）
  const borrowAgain = runPlanJob("accept-borrow-again", borrowJobBase({ biology: "R1" }));
  check(
    "借考场景可复现：同 job 同 seed 两次 plan.json 一致",
    stablePlan(borrowRun.plan) != null &&
      stablePlan(borrowRun.plan) === stablePlan(borrowAgain.plan),
    `首次大小=${JSON.stringify(borrowRun.plan ?? {}).length} 二次大小=${JSON.stringify(borrowAgain.plan ?? {}).length}`,
  );

  // 19h. 显式时段把同一学生的两科排进同一时段 → SLOTS_CONFLICT，不导出名单
  const slotConflict = runPlanJob("accept-slots-conflict", {
    jobVersion: 2,
    meta: { title: "显式时段：同一学生同段两科" },
    options: {
      seed: 20260930,
      slots: [
        { id: "T1", name: "第1时段", subjects: ["chinese"] },
        { id: "T2", name: "第2时段", subjects: ["math"] },
        { id: "T3", name: "第3时段", subjects: ["english"] },
        { id: "T4", name: "第4时段", subjects: ["physics", "chemistry", "biology"] },
      ],
    },
    students: Array.from({ length: 6 }, (_, i) => ({
      id: `SLOT-${i}`,
      name: `物化生${i}`,
      className: `高三(${1 + (i % 3)})班`,
      combination: "物化生",
      subjects: ["physics", "chemistry", "biology"],
    })),
    rooms: [{ id: "R1", name: "第1考场", rows: 7, cols: 6 }],
  });
  check(
    "显式时段：同一学生在同一时段被排两科 → SLOTS_CONFLICT 且不导出名单",
    slotConflict.run.status === 3 &&
      diagnosticCodes(slotConflict.result).includes("SLOTS_CONFLICT") &&
      fileSize(path.join(slotConflict.outDir, "按班级考场安排.xlsx")) < 0 &&
      fileSize(path.join(slotConflict.outDir, "考场监考表.xlsx")) < 0,
    `exit=${slotConflict.run.status}；诊断=${[...new Set(diagnosticCodes(slotConflict.result))].join(",")}；名单文件=${fileSize(path.join(slotConflict.outDir, "按班级考场安排.xlsx"))}`,
  );

  // 19i. 借考目标考场该时段满座 → SUBJECT_ROOM_NO_SEAT，不导出名单
  const fullBorrowStudents = Array.from({ length: 42 }, (_, i) => ({
    id: `FULL-P${i}`,
    name: `物化生${i}`,
    className: `高三(${1 + (i % 5)})班`,
    combination: "物化生",
    subjects: ["physics", "chemistry", "biology"],
  }));
  for (let i = 0; i < 6; i += 1)
    fullBorrowStudents.push({
      id: `FULL-H${i}`,
      name: `史地政${i}`,
      className: "高三(7)班",
      combination: "史地政",
      subjects: ["history", "politics", "geography"],
    });
  fullBorrowStudents.push({
    id: "FULL-BORROW",
    name: "满座借考生",
    className: "高三(8)班",
    combination: "史生政",
    subjects: ["history", "biology", "politics"],
    subjectRoom: { biology: "R1" },
  });
  const fullBorrow = runPlanJob("accept-borrow-full", {
    jobVersion: 2,
    meta: { title: "借考目标考场满座" },
    options: { seed: 20260930, groupPreference: "fillRooms" },
    students: fullBorrowStudents,
    rooms: [
      { id: "R1", name: "第1考场", rows: 7, cols: 6 },
      { id: "R2", name: "第2考场", rows: 7, cols: 5 },
    ],
    constraints: [
      { id: "F1-史地政在R2", combinations: ["史地政"], roomId: "R2" },
      { id: "F2-借考生主考场R2", studentIds: ["FULL-BORROW"], roomId: "R2" },
    ],
  });
  check(
    "按科目借考：目标考场该时段满座 → SUBJECT_ROOM_NO_SEAT 且不导出名单",
    fullBorrow.run.status === 3 &&
      diagnosticCodes(fullBorrow.result).includes("SUBJECT_ROOM_NO_SEAT") &&
      fileSize(path.join(fullBorrow.outDir, "按班级考场安排.xlsx")) < 0 &&
      fileSize(path.join(fullBorrow.outDir, "考场监考表.xlsx")) < 0,
    `exit=${fullBorrow.run.status}；诊断=${[...new Set(diagnosticCodes(fullBorrow.result))].join(",")}；名单文件=${fileSize(path.join(fullBorrow.outDir, "按班级考场安排.xlsx"))}`,
  );

  // 19j. 编号图：加座考场按 §4.5 逐座对齐（CLI 级，不给 --extra 时行为不变）
  // 座号只在 preview 文本里，所以拿**脚本自己重算的公式**去核对 CLI 打印的每一排数字（不是拿常量验公式）。
  const extraNumbering = runJson(["numbering", "--rows", "7", "--cols", "5", "--extra", "2,4"]);
  const extraSeats = extraNumbering.seats ?? [];
  const frontRow = extraSeats.filter((seat) => seat.row === 0);
  const plainNumbering = runJson(["numbering", "--rows", "7", "--cols", "5"]);
  const previewRow = (prefix) => {
    const line = String(extraNumbering.preview ?? "")
      .split("\n")
      .find((text) => text.trim().startsWith(prefix));
    // 去掉行首的 `r0` / `r1` 标签，只取这一排的座位号
    return (line ?? "").trim().replace(/^r\d+/, "").match(/\d+/g)?.map(Number) ?? [];
  };
  // 物理列 pc → 业务列 = cols - pc + 1（doorSide: right，门在右）；纯矩形/加座都按 §4.5 的列内蛇形
  const expectedRow = (row) =>
    Array.from({ length: 5 }, (_, index) => seatNoInRoom(7, 5, [2, 4], row, 5 - index)).filter(
      (seatNo) => seatNo > 0,
    );
  const previewMatches = [0, 1, 3, 7].every(
    (row) => JSON.stringify(previewRow(`r${row}`)) === JSON.stringify(expectedRow(row)),
  );
  check(
    "加座编号图：--extra 2,4 → preview 每排数字与脚本独立重算一致（r0 只有 15/30、第 3 列从 16 开始）",
    extraNumbering.extraFrontSeats?.join(",") === "2,4" &&
      extraSeats.length === 37 &&
      frontRow.length === 2 &&
      frontRow.every((seat) => seat.businessCol === 2 || seat.businessCol === 4) &&
      previewMatches &&
      JSON.stringify(previewRow("r1")) === JSON.stringify([31, 29, 16, 14, 1]) &&
      JSON.stringify(previewRow("r7")) === JSON.stringify([37, 23, 22, 8, 7]) &&
      plainNumbering.extraFrontSeats === undefined &&
      (plainNumbering.seats ?? []).length === 35 &&
      (plainNumbering.seats ?? []).every((seat) => seat.row >= 1),
    `加座座位数=${extraSeats.length}（r0=${frontRow.length}，列=${frontRow.map((s) => s.businessCol).join("/")}）；preview r0=${JSON.stringify(previewRow("r0"))} r1=${JSON.stringify(previewRow("r1"))} r7=${JSON.stringify(previewRow("r7"))}；自算 r0=${JSON.stringify(expectedRow(0))} r1=${JSON.stringify(expectedRow(1))}；纯矩形座位数=${(plainNumbering.seats ?? []).length}`,
  );
}

/** 正则命中次数（与既有 countOf 区分开）。 */
const countMatches = (text, pattern) => (text.match(pattern) ?? []).length;
/** 一张 worksheet XML 里用到的样式序号集合。 */
const styleIdsOf = (xml) =>
  new Set([...xml.matchAll(/ s="(?<id>\d+)"/g)].map((m) => Number(m.groups.id)));
/** 专属组合验收用：两间标准考场（第一间可覆盖，例如加 combination）。 */
const standardRooms = (first = {}) => [
  { id: "R1", name: "第十七考场", location: "高二·十八班", rows: 7, cols: 5, ...first },
  { id: "R2", name: "第一考场", location: "高二·四班", rows: 7, cols: 6 },
];
/** 某个学生的主考场（语数外所在考场）。 */
const mainRoomOf = (result, id) =>
  (result.byStudent ?? []).find((student) => student.studentId === id)?.rooms?.[0]?.roomId;
/** Plan.json 的「座位分配负载」（不含诊断/时间戳）：用于两种写法等价性比对。 */
const seatingPayload = (plan) =>
  JSON.stringify(
    (plan?.seatings ?? []).map((seating) => [
      seating.roomId,
      seating.studentIds,
      seating.seatNoById,
      seating.subjects,
    ]),
  );
/** Plan.json 的「学生视角负载」：按人对比考场与座位。 */
const studentPayload = (plan) =>
  JSON.stringify([
    (plan?.byStudent ?? []).map((student) => [
      student.studentId,
      student.rooms?.map((room) => [room.roomId, room.subjects]),
      student.distinctRooms,
      student.slots,
    ]),
    plan?.emptyRooms,
    plan?.borrowings,
    plan?.relaxedRooms,
    plan?.unmetConstraints,
  ]);

/** 考场/科目文本的基础名：去掉「（…）」后缀。 */
const baseNameOf = (text) =>
  String(text)
    .split(/[（(]/)[0]
    .trim();
/** 数据行（第 4 行起）用到的样式下标集合。 */
const dataStyleIdsOf = (sheetXml) =>
  new Set(
    [...sheetXml.matchAll(/<row r="(?<row>\d+)"[^>]*>(?<cells>[\s\S]*?)<\/row>/g)]
      .filter((m) => Number(m.groups.row) >= 4)
      .flatMap((m) =>
        [...m.groups.cells.matchAll(/ s="(?<id>\d+)"/g)].map((s2) => Number(s2.groups.id)),
      ),
  );
/** 正文样式是否都是水平居中（解析 styles.xml 的 cellXfs 下标）。 */
const bodyCellsCentered = (stylesXml, sheetXml) => {
  const xfs = stylesXml.match(/<cellXfs[^>]*>(?<body>[\s\S]*?)<\/cellXfs>/)?.groups?.body ?? "";
  // 要连子元素一起取：居中写在 <xf> 里的 <alignment> 上（自闭合 <xf/> 与嵌套两种都要正确处理）
  const entries = [];
  const openTag = /<xf\b[^>]*?(?<self>\/)?>/g;
  for (let match = openTag.exec(xfs); match != null; match = openTag.exec(xfs)) {
    if (match.groups.self === "/") {
      entries.push(match[0]);
      continue;
    }
    const close = xfs.indexOf("</xf>", openTag.lastIndex);
    if (close === -1) break;
    entries.push(xfs.slice(match.index, close + 5));
    openTag.lastIndex = close + 5;
  }
  const dataStyles = dataStyleIdsOf(sheetXml);
  return (
    dataStyles.size > 0 &&
    [...dataStyles].every((index) => /horizontal="center"/.test(entries[index] ?? ""))
  );
};

/** 从考场名里取序号：中文数字或阿拉伯数字，取不到返回 Infinity（排到最后）。 */
const orderKey = (name) => {
  const matched = String(name).match(/第(?<number>\d+|[一二两三四五六七八九十百零]+)考场/);
  if (!matched) return Number.POSITIVE_INFINITY;
  const text = matched.groups.number;
  if (/^\d+$/.test(text)) return Number(text);
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 零: 0 };
  const unit = { 十: 10, 百: 100 };
  let total = 0;
  let current = 0;
  for (const char of text) {
    if (digits[char] === undefined) {
      const weight = unit[char];
      if (weight === undefined) return Number.POSITIVE_INFINITY;
      total += (current === 0 ? 1 : current) * weight;
      current = 0;
    } else current = digits[char];
  }
  return total + current;
};

/** 两个 sheet 的行内容是否逐格一致。 */
const sameRows = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 考场基础名：去掉 job 里那些「（语史政数英地）」后缀。 */
const roomBaseName = (room) =>
  String(room.name ?? room.id)
    .split(/[（(]/)[0]
    .trim();

/** 列出 xlsx（zip）里的条目名。 */
const zipEntries = (file) =>
  execFileSync("unzip", ["-Z1", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .trim()
    .split("\n")
    .filter((name) => name !== "");

/** 从 xlsx 里取一段 XML（本轮产物是 stored zip，直接解压即可）。 */
const unzipText = (file, member) =>
  execFileSync("unzip", ["-p", file, member], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const sheetNamesOf = (file) => readWorkbook(readFileSync(file), { type: "buffer" }).SheetNames;
const sheetRowsOf = (file, name) => {
  const wb = readWorkbook(readFileSync(file), { type: "buffer" });
  return xlsxUtils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "" });
};
/** Xlsx 是否有「A4 横向 + 缩放到一页宽 + 冻结 + 合并标题」这套打印设置。 */
const hasPrintSetup = (xml) =>
  xml.includes('paperSize="9"') &&
  xml.includes('orientation="landscape"') &&
  xml.includes('fitToWidth="1"') &&
  xml.includes('fitToPage="1"') &&
  xml.includes("<mergeCells") &&
  xml.includes('state="frozen"');
/** 列宽总宽（厘米）：1 字符宽 ≈ 0.185cm。 */
const columnWidthCm = (xml) => {
  const widths = [...xml.matchAll(/<col [^>]*width="(?<w>[\d.]+)"/g)].map((m) =>
    Number(m.groups.w),
  );
  return widths.reduce((sum, width) => sum + width * 0.185, 0);
};

/* ---------- 20. 可直接打印的 Excel 交付物（老师反馈：准考证号 / 标题 / 字号 / A4 横向） ---------- */
{
  const classBookPath = path.join(outDir, "按班级考场安排.xlsx");
  const invigilatorBookPath = path.join(outDir, "考场监考表.xlsx");
  const classSheets = sheetNamesOf(classBookPath);
  const invigilatorSheets = sheetNamesOf(invigilatorBookPath);
  const classNames = [...new Set(job.students.map((s) => s.className))];
  const worksheetXmls = (file) =>
    zipEntries(file)
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
      .map((name) => unzipText(file, name));

  // 20a. 合并工作簿结构：总表第一 + 每班一张；每考场一张
  check(
    "班级表：第一张是「总表」，之后每班一张 sheet",
    classSheets[0] === "总表" &&
      classSheets.length === classNames.length + 1 &&
      classNames.every((name) => classSheets.includes(name)),
    `${classSheets.length} 张：${classSheets.slice(0, 4).join(",")}…`,
  );
  check(
    "监考表：每个考场一张 sheet，名字是「第N考场（科目单字）」",
    invigilatorSheets.length === result.seatings.length &&
      invigilatorSheets.every((name) => /^第.+考场（[^（）]+）$/.test(name)),
    `${invigilatorSheets.length} 张：${invigilatorSheets.slice(0, 3).join(" | ")}`,
  );

  // 20a-2. 监考表 sheet 必须按考场序号自然排序（中文数字要解析成数字，不能按字符串排）
  const sheetKeys = invigilatorSheets.map((name) => orderKey(name));
  const sortedSheetKeys = [...sheetKeys].sort((a, b) => a - b);
  check(
    "监考表：sheet 顺序按考场序号递增排（第1 → 第2 → …，不再出现十七/十八跑到最前）",
    sheetKeys.every((key) => Number.isFinite(key)) &&
      JSON.stringify(sheetKeys) === JSON.stringify(sortedSheetKeys) &&
      sheetKeys[0] === 1 &&
      sheetKeys.includes(sheetKeys.length) &&
      /^第(?:1|一)考场/.test(String(invigilatorSheets[0])),
    `顺序=${invigilatorSheets.slice(0, 4).join(" → ")} … ${invigilatorSheets.slice(-2).join(" / ")}（共 ${invigilatorSheets.length} 张）`,
  );

  // 20b. 总表：三样基本信息 + 班级每行都填 + 主考场不带括号
  const totalRows = sheetRowsOf(classBookPath, "总表");
  const totalHeader = (totalRows[2] ?? []).map(String);
  const totalBody = totalRows.slice(3).filter((row) => row.some((cell) => String(cell) !== ""));
  const roomCols = totalHeader
    .map((h, index) => (/^主考场$|^单科考场\d+$/.test(h) ? index : -1))
    .filter((index) => index >= 0);
  const bodyIds = new Set(totalBody.map((row) => String(row[2])));
  const expectedIds = new Set(job.students.filter((s) => s.included !== false).map((s) => s.id));
  check(
    "总表：列含班级/姓名/准考证号，且准考证号与名单一一对应",
    totalHeader[0] === "班级" &&
      totalHeader[1] === "姓名" &&
      totalHeader[2] === "准考证号" &&
      roomCols.length >= 1 &&
      bodyIds.size === expectedIds.size &&
      [...expectedIds].every((id) => bodyIds.has(id)),
    `表头=${totalHeader.join(" | ")}；人数=${bodyIds.size}/${expectedIds.size}`,
  );
  check(
    "总表：班级列每行都填（不是只写第一行）",
    totalBody.length === expectedIds.size && totalBody.every((row) => String(row[0]).trim() !== ""),
    `${totalBody.length} 行，空班级 ${totalBody.filter((row) => String(row[0]).trim() === "").length} 行`,
  );
  const primaryCells = totalBody.map((row) => String(row[roomCols[0]] ?? "")).filter(Boolean);
  const specialCells = totalBody
    .flatMap((row) => roomCols.slice(1).map((index) => String(row[index] ?? "")))
    .filter(Boolean);
  check(
    "总表：主考场不带括号，只有换考场才在考场后标科目",
    primaryCells.length > 0 &&
      primaryCells.every((cell) => !cell.includes("（")) &&
      specialCells.length > 0 &&
      specialCells.every((cell) => /^.+（[^（）]+）$/.test(cell)),
    `主考场样例=${primaryCells[0]}；换考场样例=${specialCells.slice(0, 3).join("、")}`,
  );
  // 每个考场列后面必须紧跟同名的「…地点」列，且地点与 job 里的教室对得上
  const locationOfRoom = new Map(
    job.rooms.map((room) => [baseNameOf(room.name ?? room.id), room.location ?? ""]),
  );
  const locationProblems = [];
  for (const index of roomCols) {
    const label = totalHeader[index];
    if (totalHeader[index + 1] !== `${label}地点`) {
      locationProblems.push(`${label}:缺地点列`);
      continue;
    }
    for (const row of totalBody) {
      const roomCell = String(row[index] ?? "").trim();
      const placeCell = String(row[index + 1] ?? "").trim();
      if (roomCell === "") {
        if (placeCell !== "") locationProblems.push(`${label}:空考场却有地点`);
        continue;
      }
      const expected = locationOfRoom.get(baseNameOf(roomCell));
      if (expected === undefined) locationProblems.push(`${label}:认不出考场 ${roomCell}`);
      else if (placeCell !== expected)
        locationProblems.push(`${label}:${roomCell} 地点=${placeCell}≠${expected}`);
    }
  }
  check(
    "总表：每个考场列后面紧跟「…地点」列，且地点与考务表的教室一致",
    roomCols.length > 0 && locationProblems.length === 0,
    locationProblems.length === 0
      ? `${totalHeader.join(" | ")}`
      : locationProblems.slice(0, 3).join("；"),
  );
  check(
    "总表：不再出现旧的「考场①/②」列名",
    !totalHeader.some((h) => /^考场[①②③④⑤]/.test(h)),
    totalHeader.join(" | "),
  );

  // 20c. 每班 sheet 都自成一张表（标题、班级列、准考证号）
  const classSheetProblems = classNames.filter((name) => {
    const rows = sheetRowsOf(classBookPath, name);
    const header = (rows[2] ?? []).map(String);
    const body = rows.slice(3).filter((row) => row.some((cell) => String(cell) !== ""));
    return !(
      String(rows[0]?.[0] ?? "").includes(`${name} 考场安排`) &&
      /^本班 \d+ 人 ｜ 需换考场 \d+ 人$/.test(String(rows[1]?.[0] ?? "")) &&
      header[0] === "班级" &&
      header[1] === "姓名" &&
      header[2] === "准考证号" &&
      body.length > 0 &&
      body.every((row) => String(row[0]) === name && String(row[2]).length > 0)
    );
  });
  check(
    "每班 sheet：标题带班级、小字写本班人数、班级列每行都填、准考证号不空",
    classSheetProblems.length === 0,
    classSheetProblems.length === 0
      ? `${classNames.length} 张全部合规`
      : classSheetProblems.join("、"),
  );

  // 20d. 监考表：逐张核对标题 / 小字 / 表头
  const invigilatorProblems = [];
  const remarkRows = [];
  const remarkPairs = new Set();
  const sheetPairs = new Set();
  for (const name of invigilatorSheets) {
    const rows = sheetRowsOf(invigilatorBookPath, name);
    const header = (rows[2] ?? []).map(String);
    const meta = String(rows[1]?.[0] ?? "");
    const room = job.rooms.find((r) => name.startsWith(roomBaseName(r)));
    if (String(rows[0]?.[0] ?? "") !== name) invigilatorProblems.push(`${name}:标题`);
    if (!/^地点：.+ ｜ 考场人数：\d+(?<relax> ｜ 本考场已放宽同班相邻)?$/.test(meta))
      invigilatorProblems.push(`${name}:小字`);
    if (header.join("|") !== "座位号|班级|姓名|准考证号|备注")
      invigilatorProblems.push(`${name}:表头`);
    if (!room) {
      invigilatorProblems.push(`${name}:认不出考场`);
      continue;
    }
    const body = rows.slice(3).filter((row) => row.some((cell) => String(cell) !== ""));
    const declared = meta.match(/考场人数：(?<n>\d+)/)?.groups?.n;
    if (declared === undefined || Number(declared) !== body.length)
      invigilatorProblems.push(`${name}:人数(${declared}≠${body.length})`);
    for (const row of body) {
      sheetPairs.add(`${room.id}|${row[0]}|${row[3]}`);
      if (String(row[4] ?? "").trim() !== "") {
        remarkRows.push(String(row[4]));
        remarkPairs.add(`${room.id}|${row[3]}`);
      }
    }
  }
  const invigilatorText = invigilatorSheets
    .map((name) => sheetRowsOf(invigilatorBookPath, name).flat().join(" "))
    .join(" ");
  check(
    "监考表：逐张 sheet 的标题=sheet 名、小字人数与表内行数一致、表头五列齐全",
    invigilatorProblems.length === 0 && !invigilatorText.includes("监考："),
    invigilatorProblems.length === 0
      ? `${invigilatorSheets.length} 张全部合规，且全簿无「监考：」`
      : invigilatorProblems.slice(0, 3).join("；"),
  );

  // 20e. 座位号 → 准考证号 必须与 plan 逐条一致（多一张、少一张、张冠李戴都要抓）
  const expectedPairs = new Set();
  for (const student of result.byStudent) {
    for (const item of Object.values(student.slots ?? {})) {
      if (item) expectedPairs.add(`${item.roomId}|${item.seatNo}|${student.studentId}`);
    }
  }
  const pairDiff =
    [...expectedPairs].filter((key) => !sheetPairs.has(key)).length +
    [...sheetPairs].filter((key) => !expectedPairs.has(key)).length;
  check(
    "监考表：每张表的座位号→准考证号与 plan 逐条一致",
    pairDiff === 0 && sheetPairs.size === expectedPairs.size && expectedPairs.size > 0,
    `表内 ${sheetPairs.size} 条 / plan ${expectedPairs.size} 条，差异 ${pairDiff} 条`,
  );
  const borrowKeys = new Set((result.borrowings ?? []).map((b) => `${b.roomId}|${b.studentId}`));
  const borrowMiss = [...borrowKeys].filter((key) => !remarkPairs.has(key)).length;
  const borrowExtra = [...remarkPairs].filter((key) => !borrowKeys.has(key)).length;
  check(
    "监考表：备注列与 plan 的借考记录一一对应（张冠李戴也算错）",
    remarkRows.length === borrowKeys.size &&
      borrowMiss === 0 &&
      borrowExtra === 0 &&
      remarkRows.every((remark) => /^(?<kind>只考|不考)：.+$/.test(remark)),
    `备注行=${remarkRows.length}（借考 ${borrowKeys.size} 处）；漏标 ${borrowMiss}、错挂 ${borrowExtra}${remarkRows.length > 0 ? `：${remarkRows.slice(0, 2).join("、")}` : ""}`,
  );

  // 20f. 打印设置与字号：逐张 worksheet 都要有
  const classWorksheetXmls = worksheetXmls(classBookPath);
  const roomWorksheetXmls = worksheetXmls(invigilatorBookPath);
  const allXml = [...classWorksheetXmls, ...roomWorksheetXmls];
  const classStylesXml = unzipText(classBookPath, "xl/styles.xml");
  const classWorkbookXml = unzipText(classBookPath, "xl/workbook.xml");
  const printBad = allXml.filter((xml) => !hasPrintSetup(xml)).length;
  // 每张表都要有 title(1) / meta(3) / header(4) 三档样式
  const styledBad = allXml.filter((xml) => {
    const ids = styleIdsOf(xml);
    return ![1, 3, 4].every((id) => ids.has(id));
  }).length;
  const printTitleCounts = countMatches(classWorkbookXml, /_xlnm\.Print_Titles/g);
  const roomWorkbookXml = unzipText(invigilatorBookPath, "xl/workbook.xml");
  const roomPrintTitleCounts = countMatches(roomWorkbookXml, /_xlnm\.Print_Titles/g);
  check(
    "打印设置：每一张 sheet 都是 A4 横向 + 缩放到一页宽 + 冻结表头 + 合并标题，且每张都登记了重复打印 1–3 行",
    printBad === 0 &&
      styledBad === 0 &&
      printTitleCounts === classSheets.length &&
      roomPrintTitleCounts === invigilatorSheets.length &&
      allXml.length === classSheets.length + invigilatorSheets.length,
    `${allXml.length} 张表，缺打印设置 ${printBad} 张，缺标题/表头样式 ${styledBad} 张；Print_Titles ${printTitleCounts}/${classSheets.length} + ${roomPrintTitleCounts}/${invigilatorSheets.length}`,
  );
  check(
    "字号与字体：标题 16pt / 小字 9pt / 等线，且单元格带样式引用",
    classStylesXml.includes('<sz val="16"') &&
      classStylesXml.includes('<sz val="9"') &&
      classStylesXml.includes("等线") &&
      classWorksheetXmls[0].includes('s="1"'),
    `styles.xml 含 16pt=${classStylesXml.includes('<sz val="16"')} / 9pt=${classStylesXml.includes('<sz val="9"')} / 等线=${classStylesXml.includes("等线")}`,
  );

  check(
    "两张表的正文单元格都居中（标题/表头居中，meta 小字左对齐）",
    bodyCellsCentered(classStylesXml, classWorksheetXmls[0]) &&
      bodyCellsCentered(unzipText(invigilatorBookPath, "xl/styles.xml"), roomWorksheetXmls[0]),
    `班级表正文样式=${JSON.stringify([...dataStyleIdsOf(classWorksheetXmls[0])])} ｜ 监考表正文样式=${JSON.stringify([...dataStyleIdsOf(roomWorksheetXmls[0])])}`,
  );

  // 20g. 列宽总宽不超过 A4 横向可用宽度（1 字符宽 ≈ 0.185cm，A4 横向可用 ≈ 27.8cm）
  const widthReport = allXml.map((xml) => columnWidthCm(xml));
  const widthBad = widthReport.filter((cm) => !(cm > 0 && cm <= 27.8)).length;
  check(
    "列宽自适应且每张表总宽都不超过 A4 横向（27.8cm）",
    widthBad === 0 && widthReport.length > 0,
    `${widthReport.length} 张表，最大 ${Math.max(...widthReport).toFixed(2)}cm，超宽 ${widthBad} 张`,
  );

  // 20h. 每班 / 每考场单独文件
  const classDir = path.join(outDir, "按班级考场安排");
  const roomDir = path.join(outDir, "考场监考表");
  const classFiles = readdirSync(classDir).filter((name) => name.endsWith(".xlsx"));
  const roomFiles = readdirSync(roomDir).filter((name) => name.endsWith(".xlsx"));
  check(
    "落盘：每班一个文件、每考场一个文件（文件名 = sheet 名）",
    classFiles.length === classNames.length &&
      classNames.every((name) => classFiles.includes(`${name}.xlsx`)) &&
      roomFiles.length === invigilatorSheets.length &&
      invigilatorSheets.every((name) => roomFiles.includes(`${name}.xlsx`)),
    `按班级考场安排/${classFiles.length} 个；考场监考表/${roomFiles.length} 个`,
  );
  const singleClassSheets = sheetNamesOf(path.join(classDir, `${classNames[0]}.xlsx`));
  const singleRoomSheets = sheetNamesOf(path.join(roomDir, `${invigilatorSheets[0]}.xlsx`));
  check(
    "单班 / 单考场文件都只有一张 sheet（可直接发给班主任 / 监考老师）",
    singleClassSheets.length === 1 &&
      singleClassSheets[0] === classNames[0] &&
      singleRoomSheets.length === 1 &&
      singleRoomSheets[0] === invigilatorSheets[0],
    `${classNames[0]}.xlsx → ${singleClassSheets.join(",")}；${invigilatorSheets[0]}.xlsx → ${singleRoomSheets.join(",")}`,
  );
  const classFileMismatch = classNames.filter(
    (name) =>
      !sameRows(
        sheetRowsOf(path.join(classDir, `${name}.xlsx`), name),
        sheetRowsOf(classBookPath, name),
      ),
  );
  const roomFileMismatch = invigilatorSheets.filter(
    (name) =>
      !sameRows(
        sheetRowsOf(path.join(roomDir, `${name}.xlsx`), name),
        sheetRowsOf(invigilatorBookPath, name),
      ),
  );
  // 20i. 姓名：整表不超 A4 时完整显示（截断只在超宽时发生，算法另由 io 单测覆盖）
  const longName = "阿依古丽娜尔古丽米热买买提";
  const longNameRun = runPlanJob("accept-longname", {
    jobVersion: 2,
    meta: { title: "长姓名不截断" },
    options: { seed: 20260930 },
    students: Array.from({ length: 5 }, (_, i) => ({
      id: `LN-${i}`,
      name: i === 0 ? longName : `同学${i}`,
      className: "2501",
      combination: "物化生",
      subjects: ["physics", "chemistry", "biology"],
    })),
    rooms: [{ id: "R1", name: "第一考场", location: "高一·一班", rows: 7, cols: 6 }],
  });
  const longNameCells = longNameRun.plan
    ? sheetRowsOf(path.join(longNameRun.outDir, "按班级考场安排.xlsx"), "总表").flat()
    : [];
  check(
    "姓名：整表不超 A4 时 13 字姓名完整保留（不截断）",
    longNameRun.result.ok === true && longNameCells.some((cell) => String(cell) === longName),
    `ok=${longNameRun.result.ok}；姓名列=${JSON.stringify(longNameCells.filter((cell) => /穆海|同学/.test(String(cell))))}`,
  );

  check(
    "单班 / 单考场文件的内容与合并版对应 sheet 逐格一致",
    classFileMismatch.length === 0 && roomFileMismatch.length === 0,
    `比对 ${classNames.length} 个班文件 + ${invigilatorSheets.length} 个考场文件；不一致 ${classFileMismatch.length + roomFileMismatch.length} 个`,
  );
}

/* ---------- 21. 专属组合考场（RoomSpec.combination） ---------- */
{
  const comboStudents = [
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `H${index}`,
      name: `文${index}`,
      className: `250${index + 1}`,
      combination: "政史地",
      subjects: ["history", "politics", "geography"],
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `W${index}`,
      name: `理${index}`,
      className: `251${index + 1}`,
      combination: "物化生",
      subjects: ["physics", "chemistry", "biology"],
    })),
  ];
  const comboJob = (rooms, extra = {}) => ({
    jobVersion: 2,
    meta: { title: "专属组合" },
    options: { seed: 20261001, ...extra.options },
    students: comboStudents,
    rooms,
    ...(extra.constraints ? { constraints: extra.constraints } : {}),
  });
  // 21a. 钉住的考场只收该组合，其它组合不受影响
  const pinned = runPlanJob(
    "accept-combination",
    comboJob(standardRooms({ combination: "政史地" })),
  );
  const pinnedResult = pinned.result;
  const pinnedIds = new Set(
    (pinnedResult.seatings ?? [])
      .filter((seating) => seating.roomId === "R1")
      .flatMap((seating) => seating.studentIds ?? []),
  );
  check(
    "专属组合考场：钉住的考场只收该组合（整批），其它组合不受影响、零冲突",
    pinnedResult.ok === true &&
      mainRoomOf(pinnedResult, "H0") === "R1" &&
      mainRoomOf(pinnedResult, "H5") === "R1" &&
      mainRoomOf(pinnedResult, "W0") === "R2" &&
      pinnedIds.size === 6 &&
      [...pinnedIds].every((id) => id.startsWith("H")) &&
      hardRuleViolations(pinnedResult).length === 0 &&
      seatCollisions(pinnedResult).length === 0,
    `exit=${pinned.run.status} ok=${pinnedResult.ok} R1 学生=${[...pinnedIds].join(",")} 理0 考场=${mainRoomOf(pinnedResult, "W0")}`,
  );
  check(
    "专属组合考场：诊断用中文说明「哪个考场专属哪个组合、多少人」",
    (pinnedResult.diagnostics ?? []).some(
      (diagnostic) =>
        diagnostic.code === "ROOM_COMBINATION_APPLIED" &&
        diagnostic.severity === "info" &&
        /第十七考场/.test(String(diagnostic.message)) &&
        /政史地/.test(String(diagnostic.message)),
    ),
    (pinnedResult.diagnostics ?? [])
      .map((diagnostic) => `${diagnostic.severity}:${diagnostic.code}`)
      .join(" | "),
  );
  const pinnedValidate = runFull([
    "--json",
    "validate",
    "--job",
    pinned.jobPath,
    "--plan",
    path.join(pinned.outDir, "plan.json"),
  ]);
  check(
    "专属组合考场：独立校验器 validate 也通过（exit 0）",
    pinnedValidate.status === 0,
    `exit=${pinnedValidate.status} stdout=${(pinnedValidate.stdout ?? "").slice(0, 120)}`,
  );

  // 21b. 等价性：新字段写法 == 既有「限定把该组合钉到同一考场」写法
  const byConstraint = runPlanJob(
    "accept-combination-constraint",
    comboJob(standardRooms(), {
      constraints: [{ id: "C-文科在R1", combinations: ["政史地"], roomId: "R1" }],
    }),
  );
  // 诊断里多一条 info（ROOM_COMBINATION_APPLIED）是预期的，所以只比「结果负载」
  check(
    "专属组合考场：与「限定把该组合钉到同一考场」的写法结果完全一致（含座位号）",
    pinned.plan != null &&
      byConstraint.plan != null &&
      byConstraint.run.status === 0 &&
      seatingPayload(pinned.plan) === seatingPayload(byConstraint.plan) &&
      studentPayload(pinned.plan) === studentPayload(byConstraint.plan),
    `新字段 exit=${pinned.run.status} ／ 限定写法 exit=${byConstraint.run.status}`,
  );

  // 21c. 名单里没有这个组合 → 警告 + 空置，但不阻断导出
  const unknownCombo = runPlanJob(
    "accept-combination-unknown",
    comboJob([
      ...standardRooms({ combination: "不存在的组合" }),
      { id: "R3", name: "第二考场", location: "高二·五班", rows: 7, cols: 6 },
    ]),
  );
  check(
    "专属组合考场：名单里没有该组合 → 中文警告 + 该考场空置，结果仍可导出",
    unknownCombo.result.ok === true &&
      (unknownCombo.result.diagnostics ?? []).some(
        (diagnostic) =>
          diagnostic.code === "ROOM_COMBINATION_UNKNOWN" && diagnostic.severity === "warning",
      ) &&
      (unknownCombo.result.emptyRooms ?? []).includes("第十七考场"),
    `ok=${unknownCombo.result.ok} 空置=${JSON.stringify(unknownCombo.result.emptyRooms ?? [])}`,
  );

  // 21d. 同时设专属组合与专用科目 → 组合优先 + 警告
  const bothWays = runPlanJob(
    "accept-combination-dedicated",
    comboJob(standardRooms({ combination: "政史地", dedicatedSubjects: ["history"] })),
  );
  check(
    "专属组合考场：同一考场又设了专用科目 → 按专属组合处理并给出警告",
    bothWays.result.ok === true &&
      (bothWays.result.diagnostics ?? []).some(
        (diagnostic) =>
          diagnostic.code === "ROOM_COMBINATION_IGNORED_DEDICATED" &&
          diagnostic.severity === "warning",
      ) &&
      mainRoomOf(bothWays.result, "H0") === "R1",
    `ok=${bothWays.result.ok} 诊断=${diagnosticCodes(bothWays.result).join(",")}`,
  );

  // 21e. 多个考场钉同一组合：按顺序分流
  const splitRooms = [
    {
      id: "R1",
      name: "第十七考场",
      location: "高二·十八班",
      rows: 2,
      cols: 2,
      combination: "政史地",
    },
    {
      id: "R3",
      name: "第十八考场",
      location: "高二·十七班",
      rows: 2,
      cols: 2,
      combination: "政史地",
    },
    { id: "R2", name: "第一考场", location: "高二·四班", rows: 7, cols: 6 },
  ];
  const split = runPlanJob("accept-combination-split", comboJob(splitRooms));
  const splitSeats = (split.result.seatings ?? []).filter((seating) => seating.roomId !== "R2");
  check(
    "专属组合考场：多间考场钉同一组合 → 按顺序分流，不混进别的考场",
    split.result.ok === true &&
      splitSeats.reduce((sum, seating) => sum + (seating.studentIds ?? []).length, 0) === 6 &&
      splitSeats.length >= 2 &&
      [...new Set(splitSeats.flatMap((seating) => seating.studentIds ?? []))].every((id) =>
        String(id).startsWith("H"),
      ),
    `ok=${split.result.ok} 专属考场座位方案=${splitSeats.length} 套 / ${splitSeats.reduce((sum, s) => sum + (s.studentIds ?? []).length, 0)} 人`,
  );

  // 21f. 装不下 → 失败且不导出名单
  const tooSmall = runPlanJob(
    "accept-combination-capacity",
    comboJob(standardRooms({ combination: "政史地", rows: 2, cols: 2 })),
  );
  check(
    "专属组合考场：钉住的考场装不下该组合 → 报缺座且不导出名单（绝不混排到别的考场）",
    tooSmall.result.ok === false &&
      diagnosticCodes(tooSmall.result).some(
        (code) => code === "CAPACITY_INSUFFICIENT" || code === "SEARCH_FAILED",
      ) &&
      fileSize(path.join(tooSmall.outDir, "按班级考场安排.xlsx")) < 0,
    `ok=${tooSmall.result.ok} 诊断=${diagnosticCodes(tooSmall.result).join(",")} 名单大小=${fileSize(path.join(tooSmall.outDir, "按班级考场安排.xlsx"))}`,
  );

  // 21h. 组合必须「完全相等」才算匹配：房钉「史地」不该把「史地政」的人收进来
  const prefixOnly = runPlanJob(
    "accept-combination-prefix",
    comboJob([
      ...standardRooms({ combination: "史地" }),
      { id: "R3", name: "第二考场", location: "高二·五班", rows: 7, cols: 6 },
    ]),
  );
  check(
    "专属组合考场：只匹配「完全相等」的组合（房写「史地」不会把「史地政」的人收进来）",
    prefixOnly.result.ok === true &&
      (prefixOnly.result.diagnostics ?? []).some(
        (diagnostic) => diagnostic.code === "ROOM_COMBINATION_UNKNOWN",
      ) &&
      mainRoomOf(prefixOnly.result, "H0") === "R2" &&
      (prefixOnly.result.emptyRooms ?? []).includes("第十七考场"),
    `ok=${prefixOnly.result.ok} H0 考场=${mainRoomOf(prefixOnly.result, "H0")} 诊断=${diagnosticCodes(prefixOnly.result).join(",")} 空置=${JSON.stringify(prefixOnly.result.emptyRooms ?? [])}`,
  );

  // 21g. 预检建议：小考场改大不再写死 30 座，按本 job 最大考场动态算
  const upgradeJob = comboJob([
    { id: "R1", name: "第一考场", location: "高二·四班", rows: 7, cols: 5 },
    { id: "R2", name: "第二考场", location: "高二·五班", rows: 7, cols: 6 },
  ]);
  upgradeJob.students = Array.from({ length: 80 }, (_, index) => ({
    id: `U${index}`,
    name: `学${index}`,
    className: "2501",
    combination: "物化生",
    subjects: ["physics", "chemistry", "biology"],
  }));
  const upgradePath = path.join(work, "accept-upgrade.json");
  writeFileSync(upgradePath, JSON.stringify(upgradeJob, null, 2));
  // precheck 在「座位不够」时本身就以非 0 退出，所以用 runFull 自己解析 stdout
  const upgradeRun = runFull(["--json", "precheck", "--job", upgradePath]);
  const upgrade = JSON.parse(upgradeRun.stdout || "{}");
  const upgradeLabels = (upgrade.diagnostics ?? []).flatMap((diagnostic) =>
    (diagnostic.suggestions ?? []).map((suggestion) => String(suggestion.label)),
  );
  check(
    "预检建议：35 座考场可建议改成 42 座（gain 7），不再写死 30 座",
    (upgrade.diagnostics ?? []).some((diagnostic) => diagnostic.code === "CAPACITY_INSUFFICIENT") &&
      upgradeLabels.some((label) => /35 座 → 改成 42 座/.test(label) && /多放 7 人/.test(label)),
    `建议=${upgradeLabels.join("；")}`,
  );
}

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
