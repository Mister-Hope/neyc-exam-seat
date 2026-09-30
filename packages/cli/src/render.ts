import { rcToSeatNo, subjectLabel, subjectListLabel } from "@exam-seat/core";
import type { Diagnostic, DoorSide, PlanAllResult, PlanResult } from "@exam-seat/core";

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

/** 按物理列序（面对讲台从左往右）画编号图，跟老师看到的一致。 */
export function renderNumbering(rows: number, cols: number, doorSide: DoorSide = "right"): string {
  const total = rows * cols;
  const width = Math.max(4, String(total).length + 2);
  const pad = (s: string): string => s.padStart(width);
  const lines: string[] = [`${" ".repeat(5)}讲台 / 黑板`];

  const head = [" ".repeat(5)];
  for (let pc = 1; pc <= cols; pc += 1) head.push(pad(`c${pc}`));
  lines.push(head.join(""));

  for (let row = 1; row <= rows; row += 1) {
    const cells = [pad(`r${row}`)];
    for (let pc = 1; pc <= cols; pc += 1) {
      const businessCol = doorSide === "right" ? cols - pc + 1 : pc;
      const seatNo = rcToSeatNo(row, businessCol, rows, cols);
      cells.push(pad(String(seatNo)));
    }
    lines.push(cells.join(""));
  }

  const doorCol = doorSide === "right" ? cols : 1;
  lines.push("");
  lines.push(
    `门在${doorSide === "right" ? "右" : "左"}侧，${"c" + doorCol} 那一列就是靠门列（小号列）；` +
      `c${doorSide === "right" ? 1 : cols} 是靠窗列（大号列）。`,
  );
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
  lines.push(result.ok ? "✅ 多场次排考完成（零冲突，全部时段已安排）" : "❌ 未能完全安排");
  lines.push("─".repeat(56));
  lines.push(
    `时段 ${result.slots.length} 个 ｜ 考生 ${result.byStudent.length} 人 ｜ 座位方案 ${result.seatings.length} 套`,
  );
  lines.push(`冲突 ${conflicts} ｜ 超过考场数上限的学生 ${result.overRoomLimit.length} 人`);
  if (result.emptyRooms.length > 0) {
    lines.push(`可取消的空置考场：${result.emptyRooms.join("、")}`);
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
