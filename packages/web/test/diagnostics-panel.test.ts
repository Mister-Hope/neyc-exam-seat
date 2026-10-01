import { describe, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";

import DiagnosticsPanel from "@/components/DiagnosticsPanel.vue";
import type { Diagnostic, Suggestion } from "@exam-seat/core";

const flush = async (): Promise<void> => {
  await nextTick();
  await nextTick();
};

function mount(diagnostics: Diagnostic[], onApply?: (suggestion: Suggestion) => void): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp({
    render: () => h(DiagnosticsPanel, { diagnostics, onApply }),
  });
  app.mount(container);
  return container;
}

describe("诊断面板：只给人话", () => {
  it("显示诊断原文与中文级别；不显示内部代码名、原始数据", async () => {
    const diagnostic: Diagnostic = {
      code: "ROOM_SAME_CLASS_RELAXED",
      severity: "warning",
      message:
        "第1考场 已放宽「同班相邻」：本考场同班人数上限 1（正常上限 9），该考场内同班相邻不再算冲突",
      evidence: { roomId: "R1", limit: 1 },
      suggestions: [{ id: "S1", label: "改为 9 人", effect: "恢复常规上限" }],
    };
    const container = mount([diagnostic]);
    await flush();

    const text = container.textContent ?? "";
    expect(text).toContain("第1考场 已放宽「同班相邻」");
    expect(text).toContain("提醒");
    expect(text).not.toContain("ROOM_SAME_CLASS_RELAXED");
    expect(text).not.toContain("roomId");
    expect(text).not.toContain("{");
    document.body.innerHTML = "";
  });

  it("建议按钮带文案，点击后把 suggestion 抛给父组件", async () => {
    const applied: Suggestion[] = [];
    const container = mount(
      [
        {
          code: "CAPACITY_INSUFFICIENT",
          severity: "error",
          message: "座位不够：还缺 12 个座位",
          evidence: { deficit: 12 },
          suggestions: [{ id: "S1", label: "补 1 个大考场" }],
        },
      ],
      (suggestion) => {
        applied.push(suggestion);
      },
    );
    await flush();

    expect(container.textContent).toContain("错误");
    const button = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("补 1 个大考场"),
    );
    expect(button).toBeDefined();
    button!.click();
    await flush();
    expect(applied.map((item) => item.id)).toEqual(["S1"]);
    document.body.innerHTML = "";
  });

  it("没有诊断时显示空提示", async () => {
    const container = mount([], undefined);
    await flush();
    expect(container.textContent).toContain("没有诊断信息");
    document.body.innerHTML = "";
  });
});
