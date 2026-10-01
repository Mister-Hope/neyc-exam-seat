import {
  columnSeatCounts,
  rcToSeatNo,
  seatNoToRCIn,
  subjectLabel,
  subjectListLabel,
} from "@exam-seat/core";
import type {
  BorrowedSeat,
  Diagnostic,
  DoorSide,
  PlanAllResult,
  PlanAllValidation,
  PlanResult,
  RoomGeometry,
} from "@exam-seat/core";

const ICON: Record<Diagnostic["severity"], string> = {
  error: "❌",
  warning: "⚠️ ",
  info: "ℹ️ ",
};

export function renderDiagnostics(diagnostics: Diagnostic[], indent = "  "): string {
  if (diagnostics.length === 0) return `${indent}（无）`;
  const lines: string[] = [];
  for (const d of diagnostics) {
    lines.push(`${indent}${ICON[d.severity]} ${d.message}`);
    if (d.evidence && Object.keys(d.evidence).length > 0) {
      const detail = Object.entries(d.evidence)
        .filter(([, v]) => v != null && !(Array.isArray(v) && v.length === 0))
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : String(v)}`)
        .join("  ");
      if (detail) lines.push(`${indent}   证据：${detail}`);
    }
    for (const s of d.suggestions) {
      lines.push(`${indent}   💡 ${s.label}${s.effect ? `（${s.effect}）` : ""}`);
    }
  }
  return lines.join("\n");
}

/**
 * 按物理列序（面对讲台从左往右）画编号图，跟老师看到的一致。
 *
 * 传了 `extraFrontSeats`（讲台侧加座的业务列，例如 `[2, 4]`）时，网格上方多画一行 `r0` 加座，
 * 只在加座列显示该列最后一个号；不给时输出与纯矩形完全一致（逐字符不变）。
 */
export function renderNumbering(
  rows: number,
  cols: number,
  doorSide: DoorSide = "right",
  extraFrontSeats: readonly number[] = [],
): string {
  const extra = [...new Set(extraFrontSeats)]
    .filter((col) => Number.isInteger(col) && col >= 1 && col <= cols)
    .sort((a, b) => a - b);

  // 不加座：保持原有输出逐字符不变（列号来自 core 的 rcToSeatNo）
  if (extra.length === 0) {
    const total = rows * cols;
    const plainWidth = Math.max(4, String(total).length + 2);
    const plainPad = (s: string): string => s.padStart(plainWidth);
    const plainLines: string[] = [`${" ".repeat(5)}讲台 / 黑板`];

    const plainHead = [" ".repeat(5)];
    for (let pc = 1; pc <= cols; pc += 1) plainHead.push(plainPad(`c${pc}`));
    plainLines.push(plainHead.join(""));

    for (let row = 1; row <= rows; row += 1) {
      const cells = [plainPad(`r${row}`)];
      for (let pc = 1; pc <= cols; pc += 1) {
        const businessCol = doorSide === "right" ? cols - pc + 1 : pc;
        const seatNo = rcToSeatNo(row, businessCol, rows, cols);
        cells.push(plainPad(String(seatNo)));
      }
      plainLines.push(cells.join(""));
    }

    const plainDoorCol = doorSide === "right" ? cols : 1;
    plainLines.push("");
    plainLines.push(
      `门在${doorSide === "right" ? "右" : "左"}侧，${"c" + plainDoorCol} 那一列就是靠门列（小号列）；` +
        `c${doorSide === "right" ? 1 : cols} 是靠窗列（大号列）。`,
    );
    return plainLines.join("\n");
  }

  // 有加座：座位号 → 行列一律用 core 的编号函数摆回网格（加座行号 0）
  const room: RoomGeometry = { rows, cols, extraFrontSeats: extra };
  const capacity = columnSeatCounts(rows, cols, extra).reduce((sum, count) => sum + count, 0);
  const width = Math.max(4, String(capacity).length + 2);
  const pad = (s: string): string => s.padStart(width);
  const lines: string[] = [`${" ".repeat(5)}讲台 / 黑板`];

  const head = [" ".repeat(5)];
  for (let pc = 1; pc <= cols; pc += 1) head.push(pad(`c${pc}`));
  lines.push(head.join(""));

  // grid[row][业务列 - 1]；grid[0] = 加座行
  const grid: (number | null)[][] = Array.from({ length: rows + 1 }, () =>
    Array.from({ length: cols }, (): number | null => null),
  );
  for (let seatNo = 1; seatNo <= capacity; seatNo += 1) {
    const { row, col } = seatNoToRCIn(room, seatNo);
    const line = grid[row];
    if (line && col >= 1 && col <= cols) line[col - 1] = seatNo;
  }

  for (let row = 0; row <= rows; row += 1) {
    const cells = [pad(`r${row}`)];
    for (let pc = 1; pc <= cols; pc += 1) {
      const businessCol = doorSide === "right" ? cols - pc + 1 : pc;
      const seatNo = grid[row]?.[businessCol - 1] ?? null;
      cells.push(seatNo == null ? " ".repeat(width) : pad(String(seatNo)));
    }
    lines.push(cells.join(""));
  }

  const doorCol = doorSide === "right" ? cols : 1;
  lines.push("");
  lines.push(
    `门在${doorSide === "right" ? "右" : "左"}侧，${"c" + doorCol} 那一列就是靠门列（小号列）；` +
      `c${doorSide === "right" ? 1 : cols} 是靠窗列（大号列）。`,
  );
  lines.push(`本考场含 ${extra.length} 个讲台侧加座（第 ${extra.join("、")} 列）。`);
  return lines.join("\n");
}

export function renderPlan(result: PlanResult, limit = 0): string {
  const s = result.stats;
  const lines: string[] = [
    "─".repeat(56),
    result.ok ? "✅ 排考场完成（零冲突，全部限定已满足）" : "❌ 未能完全满足要求",
    "─".repeat(56),
    `考生 ${s.participants} 人 ｜ 班级 ${s.classes} 个 ｜ 考场 ${s.rooms} 个（用到 ${s.roomsUsed} 个）`,
    `座位 ${s.seatsTotal} 个，已用 ${s.seatsUsed} 个 ｜ 相邻规则：${s.adjacency === "king" ? "8 邻域" : "4 邻域"}`,
    `判定级别 ${result.level} ｜ 冲突 ${s.conflicts} ｜ 未满足限定 ${s.unmetConstraints} 人`,
    `耗时 ${s.elapsedMs}ms ｜ 种子 ${s.seed}`,
  ];
  if (s.emptyRooms.length > 0) lines.push(`空置考场：${s.emptyRooms.join("、")}`);
  lines.push("");

  if (!result.ok) {
    lines.push("诊断：");
    lines.push(renderDiagnostics(result.diagnostics));
    lines.push("");
  }

  const shown = limit > 0 ? result.entries.slice(0, limit) : result.entries;
  if (shown.length > 0) {
    lines.push("考场  座位  学号          姓名        班级");
    for (const e of shown) {
      lines.push(
        `${e.roomName.padEnd(6)}${String(e.seatNo).padStart(4)}  ${e.studentId.padEnd(12)}${e.name.padEnd(12)}${e.className}`,
      );
    }
    if (limit > 0 && result.entries.length > limit) {
      lines.push(`… 还有 ${result.entries.length - limit} 条，用 --out-dir 导出完整 Excel`);
    }
  }
  return lines.join("\n");
}

/** 多场次（选科）结果的终端摘要 */
export function renderPlanAll(result: PlanAllResult): string {
  const lines: string[] = [];
  const conflicts = result.seatings.reduce((sum, s) => sum + s.result.stats.conflicts, 0);
  lines.push("─".repeat(56));
  if (result.seatings.length === 0) {
    // `ok` 在 seatings 为空时可能真空为真（every 空数组），这里绝不能说「排考完成」
    const errors = result.diagnostics.filter((d) => d.severity === "error");
    const warnings = result.diagnostics.filter((d) => d.severity === "warning");
    const reason = (errors.length > 0 ? errors : warnings)[0]?.message;
    lines.push(`❌ 没有任何考场安排：没有生成任何座位方案${reason ? ` —— ${reason}` : ""}`);
    if (result.byStudent.length > 0) {
      lines.push(`${result.byStudent.length} 名考生没有任何时段可排`);
    }
  } else {
    lines.push(result.ok ? "✅ 多场次排考完成（零冲突，全部时段已安排）" : "❌ 未能完全安排");
  }
  lines.push("─".repeat(56));
  lines.push(
    `时段 ${result.slots.length} 个 ｜ 考生 ${result.byStudent.length} 人 ｜ 座位方案 ${result.seatings.length} 套`,
  );
  lines.push(`冲突 ${conflicts} ｜ 超过考场数上限的学生 ${result.overRoomLimit.length} 人`);
  if (result.emptyRooms.length > 0) {
    lines.push(`可取消的空置考场：${result.emptyRooms.join("、")}`);
  }
  // 老版本（本次改动之前）导出的 plan.json 里没有这两个字段，读进来也不能崩
  const relaxedRooms = result.relaxedRooms ?? [];
  const borrowings = result.borrowings ?? [];
  if (relaxedRooms.length > 0) {
    lines.push(`放宽同班相邻：${relaxedRooms.join("、")}`);
  }
  if (borrowings.length > 0) {
    const detail = borrowings.map((b) => borrowLabel(result, b));
    const shown = detail.slice(0, 5).join("；");
    lines.push(`借考：${borrowings.length} 人（${shown}${detail.length > 5 ? "；…" : ""}）`);
  }
  lines.push("");

  lines.push("时段划分：");
  for (const slot of result.slots) {
    lines.push(`  ${slot.id}  ${slot.subjects.join(" + ") || "（单场）"}`);
  }
  lines.push("");

  if (result.diagnostics.length > 0) {
    lines.push("诊断：");
    lines.push(renderDiagnostics(result.diagnostics));
    lines.push("");
  }

  // 哪条限定在哪个考场没满足：AI 与老师都需要直接看到，别只藏在 diagnostics 里
  if (result.unmetConstraints.length > 0) {
    lines.push("未满足的限定：");
    for (const unmet of result.unmetConstraints) {
      const where = unmet.roomName?.trim() || unmet.roomId;
      const shown = unmet.studentIds.slice(0, 10).join("、");
      const people = unmet.studentIds.length > 10 ? `${shown}…` : shown || "—";
      lines.push(
        `${unmet.constraintId} · ${where} ｜ 涉及 ${unmet.studentIds.length} 人：${people} ｜ 原因：${unmet.reason}`,
      );
    }
    lines.push("");
  }

  const movers = result.byStudent.filter((s) => s.distinctRooms > 1);
  lines.push(`需要换考场的学生：${movers.length} 人`);
  for (const student of movers.slice(0, 10)) {
    const route = student.rooms
      .map((r) => `${r.roomName}（${subjectRoomLabel(r.subjects)}）`)
      .join(" → ");
    lines.push(`  ${student.className} ${student.name}：${route}`);
  }
  if (movers.length > 10) lines.push(`  … 还有 ${movers.length - 10} 人`);
  return lines.join("\n");
}

/** 单科目用全名，多科目用简称拼 —— 与导出表格保持一致 */
function subjectRoomLabel(subjects: readonly string[]): string {
  if (subjects.length === 1) return subjectLabel(subjects[0]!);
  return subjectListLabel(subjects);
}

/** 借考时段从 `byStudent[].slots` 反查（`BorrowedSeat` 本身不带 slotId）。 */
function findBorrowSlotId(result: PlanAllResult, borrowing: BorrowedSeat): string | undefined {
  const student = result.byStudent.find((item) => item.studentId === borrowing.studentId);
  if (!student) return undefined;
  for (const [slotId, assignment] of Object.entries(student.slots)) {
    if (
      assignment &&
      assignment.roomId === borrowing.roomId &&
      assignment.subject === borrowing.subject
    ) {
      return slotId;
    }
  }
  return undefined;
}

/** 一条借考的人话：「某生 T6 生物 → 第十八考场」 */
function borrowLabel(result: PlanAllResult, borrowing: BorrowedSeat): string {
  const slotId = findBorrowSlotId(result, borrowing);
  const subject = borrowing.subjectLabel || subjectLabel(borrowing.subject);
  const where = borrowing.roomName || borrowing.roomId;
  return `${borrowing.name || borrowing.studentId}${slotId ? ` ${slotId}` : ""} ${subject} → ${where}`;
}

/** 多场次独立校验结果（等价于 core 的 `PlanAllValidation`；保留此名方便 CLI 侧引用）。 */
export type PlanAllValidationView = PlanAllValidation;

/** 多场次「逐 seating 独立校验」结果的人话摘要 */
export function renderPlanAllValidation(validation: PlanAllValidationView): string {
  const lines: string[] = [
    "─".repeat(56),
    validation.ok
      ? "✅ 多场次校验通过：每套座位都与配置一致"
      : validation.seatings.length === 0
        ? "❌ 多场次校验未通过：没有生成任何座位方案"
        : "❌ 多场次校验未通过：结果不能用，请按下面的原因修正后重排",
    "─".repeat(56),
    `座位方案 ${validation.seatings.length} 套 ｜ 硬规则冲突 ${validation.hardRuleClashes.length} 处 ｜ 汇总问题 ${validation.issues.length} 条`,
    "",
    "逐套座位：",
  ];
  if (validation.seatings.length === 0) {
    lines.push("  （没有任何座位方案）");
  }
  for (const seating of validation.seatings) {
    const label =
      seating.subjects.length > 0
        ? `${seating.roomName}（${subjectRoomLabel(seating.subjects)}）`
        : seating.roomName;
    lines.push(`  ${seating.ok ? "✅" : "❌"} ${label}：${seating.seats} 人`);
    for (const issue of seating.report.issues) {
      lines.push(`      [${issue.severity}] ${issue.code}: ${issue.message}`);
    }
  }

  if (validation.issues.length > 0) {
    lines.push("");
    lines.push("汇总问题：");
    for (const issue of validation.issues) {
      lines.push(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
    }
  }

  lines.push("");
  lines.push(validation.ok ? "总结论：通过" : "总结论：不通过（退出码 3）");
  return lines.join("\n");
}
