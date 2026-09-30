import ElementPlus, { ElMessageBox } from "element-plus";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

import type VirtualTableComponent from "@/components/VirtualTable.vue";
import { useExamJob } from "@/composables/useExamJob";
import { XLSX_MIME } from "@/lib/download";
import type { ScheduleColumn } from "@/lib/session-export";
import { useResultStore } from "@/stores/result";
import { useRoomsStore } from "@/stores/rooms";
import StepResult from "@/views/StepResult.vue";
import { fingerprint } from "@exam-seat/core";
import type {
  PlanAllResult,
  PlanResult,
  RoomSpec,
  SeatingPlan,
  StudentSchedule,
  StudentRoomUsage,
  StudentSlotAssignment,
  TimeSlot,
} from "@exam-seat/core";

/* ------------------------------------------------------------------ */
/* mock：下载与 io（只断言调用参数，不真写文件）                         */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
  downloadBytes: vi.fn<(bytes: Uint8Array, fileName: string, mime: string) => void>(),
  downloadText: vi.fn<(text: string, fileName: string, mime?: string) => void>(),
  buildClassScheduleWorkbook: vi.fn<(result: PlanAllResult) => Uint8Array>(
    () => new Uint8Array([1, 2, 3]),
  ),
  buildInvigilatorWorkbook: vi.fn<
    (
      result: PlanAllResult,
      roomLookup?: (roomId: string) => { location?: string; note?: string } | undefined,
    ) => Uint8Array
  >(() => new Uint8Array([4, 5, 6])),
  buildPlanWorkbook: vi.fn<(result: PlanResult, jobTitle?: string) => Uint8Array>(
    () => new Uint8Array([7, 8, 9]),
  ),
}));

vi.mock(import("@/lib/download"), () => ({
  XLSX_MIME: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const,
  JSON_MIME: "application/json" as const,
  downloadBytes: mocks.downloadBytes,
  downloadText: mocks.downloadText,
}));

vi.mock(import("@exam-seat/io"), () => ({
  buildClassScheduleWorkbook: mocks.buildClassScheduleWorkbook,
  buildInvigilatorWorkbook: mocks.buildInvigilatorWorkbook,
  buildPlanWorkbook: mocks.buildPlanWorkbook,
}));

/**
 * 用最小实现的 VirtualTable 替身：渲染每一行 + `cell-<key>` slot。
 *
 * 这样测的是「StepResult 到底喂了什么 rows/columns/slot」，不受 el-table-v2 在 jsdom 下 拿不到高度的干扰；VirtualTable 自己的行为由
 * web-virtual 的 virtual-table.test.ts 覆盖。
 */
vi.mock(import("@/components/VirtualTable.vue"), async () => {
  const { defineComponent, h } = await import("vue");
  const stub = defineComponent({
    name: "VirtualTableStub",
    props: [
      "rows",
      "rowKey",
      "columns",
      "height",
      "rowHeight",
      "selectable",
      "selectedKeys",
      "stripe",
    ],
    setup(props, { slots }) {
      return () => {
        const rows = (props.rows ?? []) as unknown[];
        const columns = (props.columns ?? []) as ScheduleColumn[];
        const rowKey = props.rowKey as ((row: unknown, index: number) => string) | undefined;
        if (rows.length === 0) {
          return h("div", { class: "vt-stub" }, slots.empty ? [slots.empty()] : []);
        }
        return h(
          "div",
          { class: "vt-stub" },
          rows.map((row, index) =>
            h(
              "div",
              { class: "vt-row", key: rowKey ? rowKey(row, index) : index },
              columns.map((column) => {
                const renderCell = slots[`cell-${column.key}`];
                const value = (row as Record<string, unknown>)[column.key];
                const content = renderCell
                  ? renderCell({ row, index })
                  : typeof value === "string" || typeof value === "number"
                    ? String(value)
                    : "";
                return h("span", { class: "vt-cell" }, content);
              }),
            ),
          ),
        );
      };
    },
  }) as unknown as typeof VirtualTableComponent;
  // 替身只对齐运行时形状；类型收口到真实 VirtualTable，避免 mock 绕过类型检查。
  return { default: stub };
});

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

class ResizeObserverStub {
  observe = (): void => {};
  unobserve = (): void => {};
  disconnect = (): void => {};
}

const ROOMS: RoomSpec[] = [
  {
    id: "R3",
    name: "第三考场",
    rows: 6,
    cols: 7,
    doorSide: "right",
    location: "高二三班",
    note: "张老师",
  },
  { id: "R20", name: "第二十考场", rows: 5, cols: 6, doorSide: "right", location: "生物实验室" },
  { id: "R99", name: "第九十九考场", rows: 5, cols: 6, doorSide: "right" },
];

function assignment(
  subject: string,
  subjectLabel: string,
  roomId: string,
  roomName: string,
  seatNo: number,
): StudentSlotAssignment {
  return { subject, subjectLabel, roomId, roomName, seatNo };
}

function usage(roomId: string, roomName: string, subjects: string[]): StudentRoomUsage {
  return { roomId, roomName, subjects };
}

function makeStudents(): StudentSchedule[] {
  return [
    {
      studentId: "S1",
      name: "张伟",
      className: "高三(1)班",
      combination: "物化生",
      slots: {
        T1: assignment("chinese", "语文", "R3", "第三考场", 1),
        T2: assignment("math", "数学", "R3", "第三考场", 1),
        T6: assignment("biology", "生物", "R3", "第三考场", 1),
      },
      rooms: [usage("R3", "第三考场", ["chinese", "math", "biology"])],
      distinctRooms: 1,
    },
    {
      studentId: "S2",
      name: "李娜",
      className: "高三(7)班",
      combination: "物化政",
      slots: {
        T1: assignment("chinese", "语文", "R3", "第三考场", 5),
        T2: assignment("math", "数学", "R3", "第三考场", 5),
        T6: assignment("politics", "政治", "R20", "第二十考场", 12),
      },
      rooms: [
        usage("R3", "第三考场", ["chinese", "math"]),
        usage("R20", "第二十考场", ["politics"]),
      ],
      distinctRooms: 2,
    },
    {
      studentId: "S3",
      name: "王强",
      className: "高三(9)班",
      combination: "物化地",
      slots: {
        T1: assignment("chinese", "语文", "R3", "第三考场", 9),
        T2: assignment("math", "数学", "R3", "第三考场", 9),
        T6: null,
      },
      rooms: [usage("R3", "第三考场", ["chinese", "math"])],
      distinctRooms: 1,
    },
  ];
}

const SLOTS: TimeSlot[] = [
  { id: "T1", name: "T1 语文", subjects: ["chinese"] },
  { id: "T2", name: "T2 数学", subjects: ["math"] },
  { id: "T6", name: "T6 生物/政治", subjects: ["biology", "politics"] },
];

function singleResult(): PlanResult {
  return {
    resultVersion: 2,
    ok: true,
    level: "strict",
    stats: {
      students: 2,
      participants: 2,
      excluded: 0,
      rooms: 3,
      roomsUsed: 1,
      emptyRooms: ["R20", "R99"],
      seatsTotal: 117,
      seatsUsed: 2,
      conflicts: 0,
      unmetConstraints: 0,
      classes: 2,
      elapsedMs: 12,
      seed: 1,
      adjacency: "king",
    },
    entries: [
      {
        studentId: "S1",
        name: "张伟",
        className: "高三(1)班",
        roomId: "R3",
        roomName: "第三考场",
        seatNo: 1,
        row: 1,
        col: 1,
        physicalCol: 1,
      },
      {
        studentId: "S2",
        name: "李娜",
        className: "高三(7)班",
        roomId: "R3",
        roomName: "第三考场",
        seatNo: 2,
        row: 1,
        col: 2,
        physicalCol: 2,
      },
    ],
    conflicts: [],
    unmetConstraints: [],
    diagnostics: [],
    inputFingerprint: "single-fp",
    generatedAt: "2026-09-30T00:00:00.000Z",
  };
}

function seating(partial: Partial<SeatingPlan> & Pick<SeatingPlan, "roomId">): SeatingPlan {
  return {
    subjects: partial.subjects ?? ["chinese"],
    roomName: partial.roomName ?? partial.roomId,
    studentIds: partial.studentIds ?? [],
    seatNoById: partial.seatNoById ?? {},
    studentBySeatNo: partial.studentBySeatNo ?? {},
    result: partial.result ?? singleResult(),
    ...partial,
  };
}

function multiResult(): PlanAllResult {
  return {
    ok: true,
    slots: SLOTS,
    seatings: [
      seating({
        roomId: "R3",
        roomName: "第三考场",
        subjects: ["chinese", "math", "physics", "chemistry"],
        location: "高二三班",
        note: "张老师",
        studentIds: ["S1", "S2", "S3"],
      }),
      seating({
        roomId: "R20",
        roomName: "第二十考场",
        subjects: ["politics"],
        location: "生物实验室",
        studentIds: ["S2"],
      }),
    ],
    byStudent: makeStudents(),
    emptyRooms: ["R99"],
    overRoomLimit: [],
    diagnostics: [],
    unmetConstraints: [],
  };
}

/* ------------------------------------------------------------------ */
/* 挂载                                                                */
/* ------------------------------------------------------------------ */

interface Harness {
  container: HTMLElement;
  app: ReturnType<typeof createApp>;
}

function mount(): Harness {
  const container = document.createElement("div");
  document.body.append(container);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/solve", component: { render: () => h("div") } },
      { path: "/:pathMatch(.*)*", component: { render: () => h("div") } },
    ],
  });
  const app = createApp({ render: () => h(StepResult) });
  app.use(ElementPlus);
  app.use(router);
  app.mount(container);
  return { container, app };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(text),
  );
  if (!button) throw new Error(`找不到按钮：${text}`);
  return button;
}

/** 等所有嵌套组件（el-card / el-table / el-descriptions）都完成渲染。 */
async function settle(depth = 5): Promise<void> {
  if (depth <= 0) return;
  await nextTick();
  return settle(depth - 1);
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event("input"));
  await nextTick();
}

/** 单场 / 多场次搜索框（placeholder 区分）。 */
function searchInput(container: HTMLElement, multi: boolean): HTMLInputElement {
  const selector = multi
    ? 'input[placeholder="学号 / 姓名 / 班级 / 考场，空格分隔多个条件"]'
    : 'input[placeholder="学号 / 姓名 / 班级，空格分隔多个条件"]';
  const input = container.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`找不到搜索框：${selector}`);
  return input;
}

function useRooms(): void {
  useRoomsStore().replaceRooms(ROOMS);
}

let app: ReturnType<typeof createApp> | null = null;

describe("第 ⑥ 步结果页：多场次 / 单场", () => {
  beforeAll(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;
  });

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    document.body.innerHTML = "";
  });

  /* ---------------- 多场次 ---------------- */

  function mountMulti(): HTMLElement {
    const store = useResultStore();
    useRooms();
    store.planAll = multiResult();
    store.result = null;
    store.mode = "all";
    store.job = useExamJob().job.value;
    store.report = null;
    const harness = mount();
    ({ app } = harness);
    return harness.container;
  }

  it("渲染「时段 → 考场 + 座位」、座位方案概览与校验摘要", async () => {
    const container = mountMulti();
    await settle();

    const text = container.textContent ?? "";
    expect(text).toContain("多场次总览");
    expect(text).toContain("时段 → 考场 + 座位");
    expect(text).toContain("座位方案概览");
    expect(text).toContain("校验摘要");
    // 时刻表单元格：考场 + 座位号，没考试的时段写破折号
    expect(text).toContain("第三考场 · 5号");
    expect(text).toContain("第二十考场 · 12号");
    expect(text).toContain("—");
    // 概览：科目简称与人数
    expect(text).toContain("语数物化");
    expect(text).toContain("政治");
  });

  it("时刻表每个时段一列，行数 = 全部考生", async () => {
    const container = mountMulti();
    await settle();
    const headers = [...container.querySelectorAll(".vt-stub .vt-row")].map(
      (row) => row.textContent ?? "",
    );
    expect(headers).toHaveLength(3);
    expect(container.querySelectorAll(".vt-stub .vt-row")[0]?.textContent).toBe(
      "高三(1)班张伟S1物化生第三考场 · 1号第三考场 · 1号第三考场 · 1号",
    );
  });

  it("搜索「某人坐哪」只保留匹配行，数据仍是 store 全量", async () => {
    const container = mountMulti();
    await settle();
    expect(container.querySelectorAll(".vt-stub .vt-row")).toHaveLength(3);

    await typeInto(searchInput(container, true), "李娜");
    expect(container.querySelectorAll(".vt-stub .vt-row")).toHaveLength(1);
    expect(container.textContent).toContain("李娜");
    expect(container.textContent).not.toContain("张伟");

    await typeInto(searchInput(container, true), "第三考场");
    expect(container.querySelectorAll(".vt-stub .vt-row")).toHaveLength(3);
  });

  it("空置考场被点名列出，一键移除会同时改考场 store 与结果", async () => {
    const container = mountMulti();
    await settle();
    expect(container.textContent).toContain("第九十九考场");

    const confirmSpy = vi.spyOn(ElMessageBox, "confirm").mockResolvedValue("confirm" as never);
    buttonByText(container, "一键移除空置考场").click();
    await nextTick();
    await nextTick();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const call = confirmSpy.mock.calls[0] ?? [];
    const options = call[0] as { message?: string } | string | undefined;
    const message = typeof options === "string" ? options : options?.message;
    expect(message).toContain("第九十九考场");
    expect(useRoomsStore().rooms.some((room) => room.id === "R99")).toBe(false);
    // 结果已作废 → 回到空状态
    expect(container.textContent).toContain("还没有求解结果");
    confirmSpy.mockRestore();
  });

  it("导出「按班级考场安排.xlsx」用 buildClassScheduleWorkbook(planAll)", async () => {
    const container = mountMulti();
    await settle();
    const { planAll } = useResultStore();

    buttonByText(container, "导出 按班级考场安排.xlsx").click();
    await nextTick();

    expect(mocks.buildClassScheduleWorkbook).toHaveBeenCalledWith(planAll);
    expect(mocks.downloadBytes).toHaveBeenCalledWith(
      mocks.buildClassScheduleWorkbook.mock.results[0]?.value,
      "按班级考场安排.xlsx",
      XLSX_MIME,
    );
  });

  it("导出「考场监考表.xlsx」时把 location/note 的 roomLookup 传给 io", async () => {
    const container = mountMulti();
    await settle();
    const { planAll } = useResultStore();

    buttonByText(container, "导出 考场监考表.xlsx").click();
    await nextTick();

    expect(mocks.buildInvigilatorWorkbook).toHaveBeenCalledTimes(1);
    const [passedResult, lookup] = mocks.buildInvigilatorWorkbook.mock.calls[0] as [
      PlanAllResult,
      (roomId: string) => { location?: string; note?: string } | undefined,
    ];
    expect(passedResult).toBe(planAll);
    expect(lookup("R3")).toEqual({ location: "高二三班", note: "张老师" });
    expect(lookup("R99")).toEqual({ location: undefined, note: undefined });
    expect(mocks.downloadBytes).toHaveBeenCalledWith(
      mocks.buildInvigilatorWorkbook.mock.results[0]?.value,
      "考场监考表.xlsx",
      XLSX_MIME,
    );
  });

  /* ---------------- 单场回归 ---------------- */

  function mountSingle(
    inputFingerprint?: string,
    planAll: PlanAllResult | null = null,
  ): {
    container: HTMLElement;
    job: ReturnType<typeof useExamJob>["job"]["value"];
  } {
    const store = useResultStore();
    useRooms();
    const job = useExamJob().job.value;
    const result = singleResult();
    result.inputFingerprint = inputFingerprint ?? fingerprint(job);
    store.result = result;
    store.planAll = planAll;
    store.mode = planAll ? "all" : "single";
    store.job = job;
    store.report = null;
    const harness = mount();
    ({ app } = harness);
    return { container: harness.container, job };
  }

  it("单场模式保留原有卡片、虚拟结果表与座位网格预览", async () => {
    const { container } = mountSingle();
    await settle();

    const text = container.textContent ?? "";
    expect(text).toContain("结果名单");
    expect(text).toContain("校验报告");
    expect(text).toContain("座位网格预览");
    expect(text).toContain("导出 考场安排名单.xlsx");
    expect(text).not.toContain("多场次总览");
    expect(container.querySelectorAll(".vt-stub .vt-row")).toHaveLength(2);
    expect(container.querySelector(".vt-stub")?.textContent).toContain("第三考场");
    expect(text).toContain("靠门侧第1列");
  });

  it("单场搜索仍是「store 全量 + 计算属性过滤」", async () => {
    const { container } = mountSingle();
    await settle();
    await typeInto(searchInput(container, false), "李娜");
    expect(container.querySelectorAll(".vt-stub .vt-row")).toHaveLength(1);
    expect(container.textContent).toContain("李娜");
    expect(container.textContent).not.toContain("张伟");
  });

  it("单场指纹过期提示只在旧配置结果上出现", async () => {
    const { container } = mountSingle("stale-fingerprint");
    await settle();
    expect(container.textContent).toContain("当前配置已经改过");
  });

  it("单场导出仍是考场安排名单.xlsx（buildPlanWorkbook）", async () => {
    const { container } = mountSingle();
    await settle();
    buttonByText(container, "导出 考场安排名单.xlsx").click();
    await nextTick();

    const { result } = useResultStore();
    expect(mocks.buildPlanWorkbook).toHaveBeenCalledWith(result, "排考场");
    expect(mocks.downloadBytes).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "排考场-考场安排名单.xlsx",
      XLSX_MIME,
    );
  });
});
