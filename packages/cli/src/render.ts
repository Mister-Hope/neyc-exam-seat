import { rcToSeatNo } from "@exam-seat/core";
import type { Diagnostic, DoorSide, PlanResult } from "@exam-seat/core";

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
  const lines: string[] = [];

  lines.push(`${" ".repeat(5)}讲台 / 黑板`);
  const head = [" ".repeat(5)];
  for (let pc = 1; pc <= cols; pc += 1) head.push(pad(`c${pc}`));
  lines.push(head.join(""));

  for (let row = 1; row <= rows; row += 1) {
    const cells = [pad(`r${row}`)];
    for (let pc = 1; pc <= cols; pc += 1) {
      const businessCol = doorSide === "right" ? cols - pc + 1 : pc;
      cells.push(pad(String(rcToSeatNo(row, businessCol, rows, cols))));
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
  const lines: string[] = [];
  lines.push("─".repeat(56));
  lines.push(result.ok ? "✅ 排考场完成（零冲突，全部限定已满足）" : "❌ 未能完全满足要求");
  lines.push("─".repeat(56));
  lines.push(
    `考生 ${s.participants} 人 ｜ 班级 ${s.classes} 个 ｜ 考场 ${s.rooms} 个（用到 ${s.roomsUsed} 个）`,
  );
  lines.push(
    `座位 ${s.seatsTotal} 个，已用 ${s.seatsUsed} 个 ｜ 相邻规则：${s.adjacency === "king" ? "8 邻域" : "4 邻域"}`,
  );
  lines.push(
    `判定级别 ${result.level} ｜ 冲突 ${s.conflicts} ｜ 未满足限定 ${s.unmetConstraints} 人`,
  );
  lines.push(`耗时 ${s.elapsedMs}ms ｜ 种子 ${s.seed}`);
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
