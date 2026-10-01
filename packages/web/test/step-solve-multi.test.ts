import { createPinia, setActivePinia } from "pinia";
import type { Pinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

import { useOptionsStore } from "@/stores/options";
import { useResultStore } from "@/stores/result";
import { useRoomsStore } from "@/stores/rooms";
import { useRosterStore } from "@/stores/roster";
import StepSolve from "@/views/StepSolve.vue";
import type { SolverRequest, SolverResponse } from "@/workers/solver-protocol";
import type {
  Job,
  PlanAllResult,
  PlanEntry,
  PlanOptions,
  PlanResult,
  PrecheckOutput,
  RoomSpec,
  SeatingPlan,
  Student,
  StudentSchedule,
  TimeSlot,
} from "@exam-seat/core";

/**
 * 第 ⑤ 步的挂载测试：jsdom 里没有真 Worker，用一个**同步的伪 Worker**顶上。
 *
 * Core 的 `plan` / `planAll` / `precheckJob` 被 mock 成固定夹具（形状由类型系统盯着），
 * 这样本文件只测「网页侧接线」——模式选择、结果落库、多场次渲染、空置考场移除—— 不跟 core 的求解实现耦合，也不跑 990 人。
 */

const coreMocks = vi.hoisted(() => ({
  plan: vi.fn<(job: Job, overrides?: PlanOptions) => PlanResult>(),
  planAll: vi.fn<(job: Job, overrides?: PlanOptions) => PlanAllResult>(),
  precheckJob: vi.fn<(job: Job, overrides?: PlanOptions) => PrecheckOutput>(),
}));

vi.mock(import("@exam-seat/core"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    plan: coreMocks.plan,
    planAll: coreMocks.planAll,
    precheckJob: coreMocks.precheckJob,
  };
});

/* ---------- 夹具（与 core 输出同形） ---------- */

const SLOTS: TimeSlot[] = [
  { id: "T1", name: "T1 语文", subjects: ["chinese"] },
  { id: "T2", name: "T2 数学", subjects: ["math"] },
  { id: "T3", name: "T3 外语", subjects: ["english"] },
  { id: "T4", name: "T4 物理/历史", subjects: ["physics", "history"] },
  { id: "T5", name: "T5 化学", subjects: ["chemistry"] },
  { id: "T6", name: "T6 生物/政治", subjects: ["biology", "politics"] },
  { id: "T7", name: "T7 地理", subjects: ["geography"] },
];

function entry(
  studentId: string,
  name: string,
  className: string,
  roomId: string,
  roomName: string,
  seatNo: number,
): PlanEntry {
  return {
    studentId,
    name,
    className,
    roomId,
    roomName,
    seatNo,
    row: 1,
    col: seatNo,
    physicalCol: seatNo,
  };
}

function planResult(entries: PlanEntry[], emptyRooms: string[], elapsedMs = 10): PlanResult {
  return {
    resultVersion: 1,
    ok: true,
    level: "strict",
    stats: {
      students: 4,
      participants: entries.length,
      excluded: 0,
      rooms: 5,
      roomsUsed: new Set(entries.map((item) => item.roomId)).size,
      emptyRooms,
      seatsTotal: 150,
      seatsUsed: entries.length,
      conflicts: 0,
      unmetConstraints: 0,
      classes: 2,
      elapsedMs,
      seed: 20260930,
      adjacency: "king",
    },
    entries,
    conflicts: [],
    unmetConstraints: [],
    diagnostics: [],
    inputFingerprint: "fixture",
    generatedAt: "2026-09-30T00:00:00.000Z",
  };
}

const S1 = { id: "S1", name: "张一", className: "高三(1)班" };
const S2 = { id: "S2", name: "李二", className: "高三(1)班" };
const S3 = { id: "S3", name: "王三", className: "高三(2)班" };
const S4 = { id: "S4", name: "赵四", className: "高三(2)班" };

function seating(
  roomId: string,
  roomName: string,
  subjects: string[],
  students: { id: string; name: string; className: string }[],
  elapsedMs = 10,
): SeatingPlan {
  const seatNoById: Record<string, number> = {};
  const studentBySeatNo: Record<number, string> = {};
  const entries = students.map((item, index) => {
    seatNoById[item.id] = index + 1;
    studentBySeatNo[index + 1] = item.id;
    return entry(item.id, item.name, item.className, roomId, roomName, index + 1);
  });
  return {
    subjects,
    roomId,
    roomName,
    studentIds: students.map((item) => item.id),
    seatNoById,
    studentBySeatNo,
    result: planResult(entries, [], elapsedMs),
  };
}

function schedule(
  id: string,
  name: string,
  className: string,
  combination: string,
  distinctRooms: number,
): StudentSchedule {
  const slots: Record<string, null> = {};
  for (const slot of SLOTS) slots[slot.id] = null;
  return {
    studentId: id,
    name,
    className,
    combination,
    slots,
    rooms: Array.from({ length: distinctRooms }, (_, index) => ({
      roomId: `R${index + 1}`,
      roomName: `第${index + 1}考场`,
      subjects: ["chinese"],
    })),
    distinctRooms,
  };
}

/** 多场次夹具：R1~R4 各一套座位方案，R5 全程空置（容量充足但没人用）。 */
function allFixture(): PlanAllResult {
  return {
    ok: true,
    slots: SLOTS,
    seatings: [
      seating("R1", "第1考场", ["chinese", "math", "physics"], [S1], 11),
      seating("R2", "第2考场", ["chinese", "math", "history"], [S2], 12),
      seating("R3", "第3考场", ["chinese", "math", "physics", "chemistry"], [S3, S4], 13),
      seating("R4", "第4考场", ["politics"], [S3], 14),
    ],
    byStudent: [
      schedule("S1", "张一", "高三(1)班", "物化生", 1),
      schedule("S2", "李二", "高三(1)班", "政史地", 1),
      schedule("S3", "王三", "高三(2)班", "物化政", 2),
      schedule("S4", "赵四", "高三(2)班", "物化地", 1),
    ],
    emptyRooms: ["第5考场"],
    overRoomLimit: [],
    relaxedRooms: [],
    borrowings: [],
    diagnostics: [],
    unmetConstraints: [],
  } satisfies PlanAllResult;
}

function singleFixture(): PlanResult {
  return planResult(
    [
      entry("S1", "张一", "高三(1)班", "R1", "第1考场", 1),
      entry("S2", "李二", "高三(1)班", "R1", "第1考场", 2),
      entry("S3", "王三", "高三(2)班", "R1", "第1考场", 3),
      entry("S4", "赵四", "高三(2)班", "R1", "第1考场", 4),
    ],
    ["R2", "R3", "R4", "R5"],
  );
}

/* ---------- 伪 Worker ---------- */

type WorkerListener = (event: MessageEvent<unknown>) => void;

/** 只用到 `event.data`，这里造一个最小 MessageEvent，避免依赖 jsdom 的 MessageEvent 构造器。 */
function messageEvent<T>(data: T): MessageEvent<T> {
  return { data } as unknown as MessageEvent<T>;
}

/** 预检通过的桩：界面只读 `fatal` 与 `diagnostics`，其余字段用不到。 */
const PRECHECK_OK = { fatal: false, diagnostics: [] } as unknown as PrecheckOutput;

class FakeWorker {
  static instances: FakeWorker[] = [];
  static requests: SolverRequest[] = [];

  private readonly listeners = new Map<string, WorkerListener[]>();
  terminated = false;

  constructor(..._args: unknown[]) {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: WorkerListener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  postMessage(request: SolverRequest): void {
    FakeWorker.requests.push(request);
    const emit = (data: SolverResponse): void => {
      for (const listener of this.listeners.get("message") ?? []) {
        listener(messageEvent(data));
      }
    };
    const { id, job, overrides, mode = "single" } = request;
    emit({ id, type: "stage", stage: "precheck" });
    const pre = coreMocks.precheckJob(job, overrides);
    emit({ id, type: "precheck", fatal: pre.fatal, diagnostics: pre.diagnostics });
    emit({ id, type: "stage", stage: "plan" });
    if (mode === "all") {
      emit({ id, type: "done", mode: "all", result: coreMocks.planAll(job, overrides) });
    } else {
      emit({ id, type: "done", mode: "single", result: coreMocks.plan(job, overrides) });
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

class ResizeObserverStub {
  observe = (): void => {};
  unobserve = (): void => {};
  disconnect = (): void => {};
}

/* ---------- 数据与挂载 ---------- */

function room(id: string, name: string, extra: Partial<RoomSpec> = {}): RoomSpec {
  return { id, name, rows: 5, cols: 6, doorSide: "right", ...extra };
}

function multiRooms(): RoomSpec[] {
  return [
    room("R1", "第1考场"),
    room("R2", "第2考场"),
    room("R3", "第3考场"),
    room("R4", "第4考场", { dedicatedSubjects: ["politics"] }),
    room("R5", "第5考场"),
  ];
}

function withSubjects(): Student[] {
  return [
    {
      id: "S1",
      name: "张一",
      className: "高三(1)班",
      combination: "物化生",
      subjects: ["physics", "chemistry", "biology"],
    },
    {
      id: "S2",
      name: "李二",
      className: "高三(1)班",
      combination: "政史地",
      subjects: ["politics", "history", "geography"],
    },
    {
      id: "S3",
      name: "王三",
      className: "高三(2)班",
      combination: "物化政",
      subjects: ["physics", "chemistry", "politics"],
    },
    {
      id: "S4",
      name: "赵四",
      className: "高三(2)班",
      combination: "物化地",
      subjects: ["physics", "chemistry", "geography"],
    },
  ];
}

/** 没有选科字段的名单 → 单场路径。 */
function withoutSubjects(): Student[] {
  return withSubjects().map(({ combination: _combination, subjects: _subjects, ...rest }) => rest);
}

function setupStore(students: Student[], rooms: RoomSpec[]): Pinia {
  const pinia = createPinia();
  setActivePinia(pinia);
  useRosterStore().replaceStudents(students);
  useRoomsStore().replaceRooms(rooms);
  useOptionsStore().reset();
  return pinia;
}

async function flush(): Promise<void> {
  await Promise.all(Array.from({ length: 6 }, () => nextTick()));
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, 0);
  });
  await Promise.all(Array.from({ length: 6 }, () => nextTick()));
}

async function mountSolve(
  pinia: Pinia,
): Promise<{ app: ReturnType<typeof createApp>; container: HTMLElement }> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: { render: () => h("div") } }],
  });
  const container = document.createElement("div");
  document.body.append(container);
  const app = createApp({ render: () => h(StepSolve) });
  app.use(pinia);
  app.use(router);
  await router.push("/");
  await router.isReady();
  app.mount(container);
  await flush();
  return { app, container };
}

function click(container: HTMLElement, testId: string): void {
  const target = container.querySelector(`[data-testid="${testId}"]`);
  if (!target) throw new Error(`找不到 [data-testid="${testId}"]`);
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

describe("第 ⑤ 步：带选科默认多场次（场次编排）", () => {
  beforeAll(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;
  });

  beforeEach(() => {
    localStorage.clear();
    FakeWorker.instances = [];
    FakeWorker.requests = [];
    vi.stubGlobal("Worker", FakeWorker);
    coreMocks.precheckJob.mockReturnValue(PRECHECK_OK);
    coreMocks.plan.mockReturnValue(singleFixture());
    coreMocks.planAll.mockReturnValue(allFixture());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("求解走 planAll：展示时段划分 / 座位方案 / 换考场人数 / 空置考场，且不再提示用 CLI", async () => {
    const pinia = setupStore(withSubjects(), multiRooms());
    const { app, container } = await mountSolve(pinia);

    expect(container.textContent).toContain("场次编排");
    expect(container.textContent).not.toContain("CLI");
    expect(container.querySelector('[data-testid="solve-mode"]')).not.toBeNull();

    click(container, "solve");
    await flush();

    expect(FakeWorker.requests.at(-1)?.mode).toBe("all");
    expect(coreMocks.planAll).toHaveBeenCalledTimes(1);
    expect(coreMocks.plan).not.toHaveBeenCalled();

    const store = useResultStore();
    expect(store.mode).toBe("all");
    expect(store.hasMultiResult).toBe(true);
    expect(store.planAll?.seatings).toHaveLength(4);

    for (const text of ["时段划分", "座位方案", "需要换考场", "空置考场", "第5考场", "王三"]) {
      expect(container.textContent).toContain(text);
    }

    const slots = container.querySelector('[data-testid="multi-slots"]')?.textContent ?? "";
    for (const text of ["语文", "物理"]) expect(slots).toContain(text);
    expect(container.querySelector('[data-testid="remove-empty-rooms"]')).not.toBeNull();

    app.unmount();
  });

  it("一键移除空置考场：同时改 rooms store 与结果，并提示「配置已变，建议重排」", async () => {
    const pinia = setupStore(withSubjects(), multiRooms());
    const { app, container } = await mountSolve(pinia);
    click(container, "solve");
    await flush();

    expect(useRoomsStore().rooms.map((item) => item.id)).toContain("R5");
    click(container, "remove-empty-rooms");
    await flush();

    expect(useRoomsStore().rooms.map((item) => item.id)).toEqual(["R1", "R2", "R3", "R4"]);
    expect(useResultStore().hasResult).toBe(false);
    expect(useResultStore().emptyRoomNames).toEqual([]);
    expect(container.textContent).toContain("已移除空置考场：第5考场");
    expect(container.textContent).toContain("配置已变，建议重排");

    app.unmount();
  });

  it("没有选科字段：单场路径行为不变，不出现多场次摘要与模式开关", async () => {
    const pinia = setupStore(withoutSubjects(), multiRooms());
    const { app, container } = await mountSolve(pinia);

    expect(container.textContent).not.toContain("场次编排");
    expect(container.textContent).not.toContain("CLI");
    expect(container.querySelector('[data-testid="solve-mode"]')).toBeNull();

    click(container, "solve");
    await flush();

    expect(FakeWorker.requests.at(-1)?.mode).toBe("single");
    expect(coreMocks.plan).toHaveBeenCalledTimes(1);
    expect(coreMocks.planAll).not.toHaveBeenCalled();

    const store = useResultStore();
    expect(store.mode).toBe("single");
    expect(store.result).not.toBeNull();
    expect(store.planAll).toBeNull();
    expect(store.hasMultiResult).toBe(false);
    expect(container.querySelector('[data-testid="multi-slots"]')).toBeNull();
    expect(container.textContent).not.toContain("时段划分");
    expect(container.textContent).toContain("考生");

    app.unmount();
  });

  it("带选科时也能退回单场（模式开关），结果写回单场路径", async () => {
    const pinia = setupStore(withSubjects(), multiRooms());
    const { app, container } = await mountSolve(pinia);

    const singleToggle = [
      ...container.querySelectorAll<HTMLButtonElement>('[data-testid="solve-mode"] button'),
    ].find((el) => el.textContent?.includes("单场"));
    expect(singleToggle).toBeDefined();
    singleToggle!.click();
    await flush();

    click(container, "solve");
    await flush();

    expect(FakeWorker.requests.at(-1)?.mode).toBe("single");
    const store = useResultStore();
    expect(store.mode).toBe("single");
    expect(store.result).not.toBeNull();
    expect(store.hasMultiResult).toBe(false);
    expect(container.querySelector('[data-testid="multi-slots"]')).toBeNull();

    app.unmount();
  });

  it("多场次摘要带上放宽考场与借考人次", async () => {
    const relaxed = allFixture();
    relaxed.relaxedRooms = ["R4"];
    relaxed.borrowings = [
      {
        studentId: "S3",
        name: "王三",
        className: "高三(2)班",
        subject: "biology",
        subjectLabel: "生物",
        roomId: "R4",
        roomName: "第4考场",
        seatNo: 2,
      },
    ];
    coreMocks.planAll.mockReturnValue(relaxed);
    const pinia = setupStore(withSubjects(), multiRooms());
    const { app, container } = await mountSolve(pinia);

    click(container, "solve");
    await flush();

    const summary =
      container.querySelector('[data-testid="multi-relax-borrow"]')?.textContent ?? "";
    expect(summary).toContain("第4考场");
    expect(summary).toContain("借考");
    expect(summary).toContain("1 人次");
    // 主动放宽不是降级：多场次依旧走「编排完成」成功提示
    expect(container.textContent).toContain("场次编排完成");

    app.unmount();
  });

  it("单场 level = roomRelaxed：显示「已按考场放宽」而不是「已降级」", async () => {
    coreMocks.plan.mockReturnValue({ ...singleFixture(), level: "roomRelaxed" as const });
    const pinia = setupStore(withoutSubjects(), multiRooms());
    const { app, container } = await mountSolve(pinia);

    click(container, "solve");
    await flush();

    const text = container.textContent ?? "";
    expect(text).toContain("已按考场放宽");
    expect(text).toContain("roomRelaxed（本考场已放宽同班相邻，其余考场规则不变）");
    expect(text).not.toContain("已降级");
    // 主动放宽不是降级：结果仍按正常结果展示
    expect(useResultStore().isRoomRelaxed).toBe(true);
    expect(useResultStore().isDegraded).toBe(false);

    app.unmount();
  });
});

describe("求解 Worker：mode 分发", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("mode=all 调 planAll 并回 PlanAllResult；不传 mode 仍是单场 plan", async () => {
    const posted: SolverResponse[] = [];
    const listeners: WorkerListener[] = [];
    vi.stubGlobal("postMessage", (message: SolverResponse) => {
      posted.push(message);
    });
    vi.stubGlobal("addEventListener", (type: string, listener: WorkerListener) => {
      if (type === "message") listeners.push(listener);
    });

    await import("@/workers/solver.worker");
    const handler = listeners.at(-1);
    expect(handler).toBeDefined();

    const all = allFixture();
    coreMocks.planAll.mockReturnValue(all);
    coreMocks.precheckJob.mockReturnValue(PRECHECK_OK);
    handler!(messageEvent({ id: 7, job: { students: [], rooms: [] }, mode: "all" }));

    expect(coreMocks.planAll).toHaveBeenCalledTimes(1);
    expect(coreMocks.plan).not.toHaveBeenCalled();
    expect(posted).toContainEqual({ id: 7, type: "done", mode: "all", result: all });

    posted.length = 0;
    const single = singleFixture();
    coreMocks.plan.mockReturnValue(single);
    handler!(messageEvent({ id: 8, job: { students: [], rooms: [] } }));

    expect(coreMocks.plan).toHaveBeenCalledTimes(1);
    expect(posted).toContainEqual({ id: 8, type: "done", mode: "single", result: single });
  });
});
