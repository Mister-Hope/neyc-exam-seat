import { describe, expect, it } from "vitest";
import { reactive } from "vue";

import type { SolverRequest, SolverResponse } from "@/workers/solver-protocol";
import type { PlanAllResult } from "@exam-seat/core";

const job = reactive({
  jobVersion: 2,
  meta: { title: "worker e2e" },
  options: { seed: 7 },
  students: [
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `A0${i}`,
      name: `甲${i}`,
      className: "高三(1)班",
      combination: "物化生",
      subjects: ["physics", "chemistry", "biology"],
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `B0${i}`,
      name: `乙${i}`,
      className: "高三(2)班",
      combination: "政史地",
      subjects: ["history", "politics", "geography"],
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      id: `C0${i}`,
      name: `丙${i}`,
      className: "高三(3)班",
      combination: "物化政",
      subjects: ["physics", "chemistry", "politics"],
    })),
  ],
  rooms: [
    { id: "R1", name: "第1考场", rows: 6, cols: 5 },
    { id: "R2", name: "第2考场", rows: 6, cols: 5 },
    { id: "R3", name: "第3考场", rows: 6, cols: 5 },
    { id: "R20", name: "第20考场", rows: 6, cols: 5, dedicatedSubjects: ["politics"] },
  ],
  constraints: [{ id: "C1", note: "甲0首排", studentIds: ["A00"], rows: ["first"] }],
});

/**
 * 未 mock 的 Worker 端到端回归：直接 import solver.worker，用「响应式 job」走 JSON 往返（useSolver 的发送路径）再派发消息。
 *
 * 背景：useSolver 曾把 Pinia 的响应式 Proxy 直接 postMessage，浏览器抛 DataCloneError，网页第 ⑤ 步从未成功排过；本用例在 jsdom
 * 里复现同一链路， 去掉 JSON 往返即会失败。
 */
describe("worker 端到端（不经 mock，直接跑 solver.worker）", () => {
  it("响应式 job 经 JSON 往返后可结构化克隆，且 worker 能返回 ok 的多场次结果", async () => {
    const received: SolverResponse[] = [];
    const scope = globalThis as unknown as {
      postMessage: (message: SolverResponse) => void;
      dispatchEvent: (event: MessageEvent) => boolean;
    };
    scope.postMessage = (message) => {
      received.push(message);
    };
    await import("@/workers/solver.worker");

    const request = JSON.parse(
      JSON.stringify({ id: 1, job, overrides: reactive({ seed: 7 }), mode: "all" }),
    ) as SolverRequest;
    expect(() => structuredClone(request)).not.toThrow();

    scope.dispatchEvent(new MessageEvent("message", { data: request }));

    const done = received.find((message) => message.type === "done");
    expect(done, `收到的消息：${received.map((message) => message.type).join(",")}`).toBeTruthy();
    if (done?.type !== "done" || done.mode !== "all") throw new Error("worker 没有返回多场次 done");
    const allResult: PlanAllResult = done.result;
    expect(allResult.ok).toBe(true);
    expect(allResult.seatings.length).toBeGreaterThan(0);
    expect(allResult.unmetConstraints).toHaveLength(0);
    const a00 = allResult.byStudent.find((schedule) => schedule.studentId === "A00");
    expect(a00?.distinctRooms).toBe(1);
  });
});
