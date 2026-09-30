import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, isReactive, reactive } from "vue";
import type { EffectScope } from "vue";

import { useSolver } from "@/composables/useSolver";
import type { SolverRequest, SolverResponse } from "@/workers/solver-protocol";
import type { Job, PlanResult } from "@exam-seat/core";

/**
 * `useSolver.postMessage` 的回归测试。
 *
 * 浏览器实测：job / options 来自 Pinia 与 computed，是 Vue 响应式 **Proxy**，结构化克隆不支持， `Worker.postMessage` 会抛
 * `DataCloneError`，页面永远拿不到结果。jsdom 里以前的 fake Worker 不做克隆， 所以漏掉了。这里让 fake Worker **真的调用
 * `structuredClone`**，模拟浏览器行为。
 */

type WorkerListener = (event: MessageEvent<unknown>) => void;

function messageEvent<T>(data: T): MessageEvent<T> {
  return { data } as unknown as MessageEvent<T>;
}

function fixtureResult(): PlanResult {
  return {
    resultVersion: 1,
    ok: true,
    level: "strict",
    stats: {
      students: 2,
      participants: 2,
      excluded: 0,
      rooms: 1,
      roomsUsed: 1,
      emptyRooms: [],
      seatsTotal: 30,
      seatsUsed: 2,
      conflicts: 0,
      unmetConstraints: 0,
      classes: 1,
      elapsedMs: 5,
      seed: 20260930,
      adjacency: "king",
    },
    entries: [],
    conflicts: [],
    unmetConstraints: [],
    diagnostics: [],
    inputFingerprint: "fixture",
    generatedAt: "2026-09-30T00:00:00.000Z",
  };
}

/** 模拟浏览器：`postMessage` 立刻做结构化克隆，Proxy / 函数等不可克隆值在这里抛 DataCloneError。 */
class StructuredCloneWorker {
  static raw: SolverRequest[] = [];
  static cloned: SolverRequest[] = [];

  static reset(): void {
    StructuredCloneWorker.raw = [];
    StructuredCloneWorker.cloned = [];
  }

  private readonly listeners = new Map<string, WorkerListener[]>();

  constructor(..._args: unknown[]) {
    // 只是记录实例；参数与真 Worker 一致（url / options），这里不需要
    void _args;
  }

  addEventListener(type: string, listener: WorkerListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  postMessage(request: SolverRequest): void {
    StructuredCloneWorker.raw.push(request);
    // 关键：真实的浏览器语义——不可克隆就抛错，和 Vue Proxy 走同一条路径
    StructuredCloneWorker.cloned.push(structuredClone(request));

    const emit = (data: SolverResponse): void => {
      for (const listener of this.listeners.get("message") ?? []) listener(messageEvent(data));
    };
    const { id } = request;
    emit({ id, type: "stage", stage: "precheck" });
    emit({ id, type: "precheck", fatal: false, diagnostics: [] });
    emit({ id, type: "stage", stage: "plan" });
    emit({ id, type: "done", mode: "single", result: fixtureResult() });
  }

  terminate(): void {}
}

function makeJob(): Job {
  return {
    jobVersion: 2,
    options: { seed: 20260930, timeLimitMs: 1000 },
    students: [
      { id: "S1", name: "张一", className: "高三(1)班" },
      { id: "S2", name: "李二", className: "高三(1)班" },
    ],
    rooms: [{ id: "R1", name: "第1考场", rows: 5, cols: 6, doorSide: "right" }],
    constraints: [],
  };
}

describe("useSolver：postMessage 与响应式数据", () => {
  let scope: EffectScope | undefined;

  beforeEach(() => {
    StructuredCloneWorker.reset();
    vi.stubGlobal("Worker", StructuredCloneWorker);
  });

  afterEach(() => {
    scope?.stop();
    scope = undefined;
    vi.unstubAllGlobals();
  });

  function createSolver(): ReturnType<typeof useSolver> {
    scope = effectScope();
    return scope.run(() => useSolver())!;
  }

  it("响应式 job / overrides：不抛 DataCloneError，Worker 收到纯 JSON 对象", async () => {
    const job = reactive<Job>(makeJob());
    const overrides = reactive({ seed: 7, timeLimitMs: 1000 });
    const solver = createSolver();

    const outcome = await solver.run(job, overrides, "single");

    expect(solver.error.value).toBe("");
    expect(outcome).not.toBeNull();
    expect(StructuredCloneWorker.cloned).toHaveLength(1);

    const payload = StructuredCloneWorker.raw[0]!;
    expect(isReactive(payload.job)).toBe(false);
    expect(isReactive(payload.job.options)).toBe(false);
    expect(isReactive(payload.overrides)).toBe(false);
    expect(Object.getPrototypeOf(payload.job)).toBe(Object.prototype);
    expect(payload.job.students[0]?.name).toBe("张一");
    expect(payload.overrides).toEqual({ seed: 7, timeLimitMs: 1000 });
    expect(payload.mode).toBe("single");
  });

  it("请求体含 JSON 无法表示的值（BigInt）：变成 error.value，不抛异常、不留 unhandled rejection", async () => {
    const job = { ...makeJob(), meta: { token: 1n } } as unknown as Job;
    const solver = createSolver();

    const outcome = await solver.run(job);

    expect(outcome).toBeNull();
    expect(solver.error.value).toContain("求解请求无法发送");
    expect(solver.running.value).toBe(false);
    // 发送前就失败了，Worker 一条消息都不该收到
    expect(StructuredCloneWorker.raw).toHaveLength(0);
  });

  it("函数值会被 JSON 往返剥掉（job.json 只允许 JSON），因此不触发 DataCloneError", async () => {
    const job = { ...makeJob(), meta: { title: "测试", hook: () => undefined } } as unknown as Job;
    const solver = createSolver();

    const outcome = await solver.run(job);

    expect(solver.error.value).toBe("");
    expect(outcome?.mode).toBe("single");
    const payload = StructuredCloneWorker.raw[0]!;
    expect(isReactive(payload.job)).toBe(false);
    expect((payload.job.meta as Record<string, unknown>).title).toBe("测试");
    expect((payload.job.meta as Record<string, unknown>).hook).toBeUndefined();
  });
});
