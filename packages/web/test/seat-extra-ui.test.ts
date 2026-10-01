import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

import SeatGridPreview from "@/components/SeatGridPreview.vue";
import { buildJob, createEmptyDraft, parseJobText, serializeJob } from "@/lib/job";
import type { SeatOccupant } from "@/lib/seat-grid";
import { useRoomsStore } from "@/stores/rooms";
import { useRosterStore } from "@/stores/roster";
import StepRooms from "@/views/StepRooms.vue";
import type { RoomSpec, Student } from "@exam-seat/core";

/** Jsdom 缺 ResizeObserver，部分组件会探测它。 */
class ResizeObserverStub {
  observe = (): void => {};
  unobserve = (): void => {};
  disconnect = (): void => {};
}

/** 5 列 × 7 排 + 第 2、4 列加座 = 37 座（docs/design.md §4.5）。 */
const EXTRA_ROOM: RoomSpec = {
  id: "R1",
  name: "第一考场",
  rows: 7,
  cols: 5,
  doorSide: "right",
  extraFrontSeats: [2, 4],
};

const PLAIN_ROOM: RoomSpec = { id: "R2", name: "第二考场", rows: 6, cols: 5, doorSide: "right" };

let app: ReturnType<typeof createApp> | null = null;

function mount(component: unknown, rooms: RoomSpec[] = [], students: Student[] = []): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const pinia = createPinia();
  setActivePinia(pinia);
  useRoomsStore().replaceRooms(rooms);
  useRosterStore().replaceStudents(students);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:pathMatch(.*)*", component: { render: () => null } }],
  });
  const instance = createApp({ render: () => h(component as never) });
  instance.use(pinia);
  instance.use(router);
  instance.mount(container);
  app = instance;
  return container;
}

async function settle(depth = 5): Promise<void> {
  if (depth <= 0) return;
  await nextTick();
  return settle(depth - 1);
}

describe("座位图：讲台侧加座（SeatGridPreview）", () => {
  beforeAll(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;
  });

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    document.body.innerHTML = "";
  });

  it("有加座时多画一行「加座」，只有加座列有格子，抬头写明容量", async () => {
    const occupants = new Map<number, SeatOccupant>([
      [15, { studentId: "S1", name: "加座同学", className: "高三(1)班" }],
    ]);
    const container = mount(
      // 用 h 传 props，避免为一次渲染再包一个组件
      { render: () => h(SeatGridPreview, { room: EXTRA_ROOM, occupants }) },
    );
    await settle();

    const text = container.textContent ?? "";
    expect(text).toContain("5 列 × 7 排 = 37 座");
    expect(text).toContain("含 2 个讲台侧加座");
    expect(text).toContain("加座");

    const extraCells = [...container.querySelectorAll(".seat-grid__cell--extra")];
    expect(extraCells).toHaveLength(2);
    // 门在右：物理列 2 = 业务列 4（30 号），物理列 4 = 业务列 2（15 号）
    expect(extraCells.map((cell) => cell.textContent?.trim())).toEqual(["30", "15加座同学"]);
    // 非加座列留空占位，网格不错位
    expect(container.querySelectorAll(".seat-grid__cell--void")).toHaveLength(3);
  });

  it("纯矩形考场不画加座行", async () => {
    const container = mount({ render: () => h(SeatGridPreview, { room: PLAIN_ROOM }) });
    await settle();

    expect(container.textContent).toContain("5 列 × 6 排 = 30 座");
    expect(container.textContent).not.toContain("含");
    expect(container.querySelectorAll(".seat-grid__cell--extra")).toHaveLength(0);
    expect(container.querySelectorAll(".seat-grid__cell--void")).toHaveLength(0);
  });
});

describe("第 ③ 步考场配置：加座 / 放宽列", () => {
  beforeAll(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;
  });

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    document.body.innerHTML = "";
  });

  it("容量按 roomCapacity 算（含加座），并有加座 / 放宽两列", async () => {
    const container = mount(StepRooms, [EXTRA_ROOM]);
    await settle();

    const text = container.textContent ?? "";
    expect(text).toContain("讲台侧加座");
    expect(text).toContain("放宽同班相邻");
    expect(text).toContain("37");
    expect(text).toContain("有加座的考场");
    expect(text).toContain("1 个");
    expect(useRoomsStore().totalSeats).toBe(37);
  });

  it("放宽了的考场在摘要里点名", async () => {
    const container = mount(StepRooms, [{ ...EXTRA_ROOM, relaxSameClass: true }]);
    await settle();

    expect(container.textContent).toContain("放宽同班相邻的考场");
    expect(container.textContent).toContain("第一考场");
  });

  it("类型徽标点击循环：大(6列7排) → 小(5列7排) → 自定义(5列6排)", async () => {
    const container = mount(StepRooms, [
      { id: "R1", name: "第一考场", rows: 7, cols: 6, doorSide: "right" },
    ]);
    await settle();

    const badge = container.querySelector<HTMLButtonElement>('[data-testid="room-kind-R1"]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain("大(6列7排)");
    expect(useRoomsStore().roomById("R1")?.rows).toBe(7);
    expect(useRoomsStore().roomById("R1")?.cols).toBe(6);

    badge!.click();
    await settle();
    expect(badge!.textContent).toContain("小(5列7排)");
    expect(useRoomsStore().roomById("R1")).toMatchObject({ rows: 7, cols: 5 });
    expect(useRoomsStore().totalSeats).toBe(35);

    badge!.click();
    await settle();
    expect(badge!.textContent).toContain("自定义");
    // 自定义默认 5 列 × 6 排 = 30 座
    expect(useRoomsStore().roomById("R1")).toMatchObject({ rows: 6, cols: 5 });
    expect(useRoomsStore().totalSeats).toBe(30);

    badge!.click();
    await settle();
    expect(badge!.textContent).toContain("大(6列7排)");
    expect(useRoomsStore().totalSeats).toBe(42);
  });

  it("放宽：可见的勾选框 + 「同班学生数上限」输入框", async () => {
    const container = mount(StepRooms, [
      { id: "R1", name: "第一考场", rows: 7, cols: 6, doorSide: "right" },
    ]);
    await settle();

    const box = container.querySelector<HTMLElement>('[aria-label="第一考场 放宽本考场"]');
    expect(box).not.toBeNull();

    box!.click();
    await settle();
    expect(container.textContent).toContain("同班学生数上限");
    expect(useRoomsStore().roomById("R1")?.relaxSameClass).toBe(true);

    const limit = container.querySelector<HTMLInputElement>(
      '[aria-label="第一考场 同班学生数上限"]',
    );
    expect(limit).not.toBeNull();
    limit!.value = "12";
    limit!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(useRoomsStore().roomById("R1")?.relaxSameClass).toBe(12);
    // 语义说明在界面上写清楚
    expect(container.textContent).toContain("勾选后本考场内同班相邻不算冲突");

    box!.click();
    await settle();
    expect(useRoomsStore().roomById("R1")?.relaxSameClass).toBeUndefined();
  });

  it("表头顺序：备注在专用科目后、门的位置靠后；且不再出现「监考老师」", async () => {
    const container = mount(StepRooms, [
      { id: "R1", name: "第一考场", rows: 7, cols: 6, doorSide: "right" },
    ]);
    await settle();

    const headers = [...container.querySelectorAll("th")].map((th) => th.textContent?.trim());
    expect(headers).toContain("备注");
    expect(headers.some((header) => header?.includes("监考老师"))).toBe(false);

    const indexOf = (text: string): number => headers.indexOf(text);
    expect(indexOf("备注")).toBeGreaterThan(indexOf("专用科目"));
    expect(indexOf("门的位置")).toBeGreaterThan(indexOf("备注"));
    expect(headers).toContain("放宽同班相邻按考场");
    expect(container.textContent).toContain("常规考场");
    expect(container.textContent).toContain("无加座");
  });

  it("操作列是带 aria-label 的图标按钮，下移真的换顺序、删除走确认框", async () => {
    const container = mount(StepRooms, [
      { id: "R1", name: "第一考场", rows: 7, cols: 6, doorSide: "right" },
      { id: "R2", name: "第二考场", rows: 7, cols: 6, doorSide: "right" },
    ]);
    await settle();

    const down = container.querySelector<HTMLButtonElement>('[aria-label="把第一考场下移"]');
    const del = container.querySelector<HTMLButtonElement>('[aria-label="删除第一考场"]');
    const up = container.querySelector<HTMLButtonElement>('[aria-label="把第一考场上移"]');
    expect(down).not.toBeNull();
    expect(del).not.toBeNull();
    expect(up?.disabled).toBe(true);

    down!.click();
    await settle();
    expect(useRoomsStore().rooms.map((room) => room.id)).toEqual(["R2", "R1"]);
  });

  it("专属组合：下拉来自名单组合（按 core 归一），可写回 / 清空，与专用科目互斥有提示", async () => {
    const container = mount(
      StepRooms,
      [{ id: "R1", name: "第一考场", rows: 7, cols: 6, doorSide: "right" }],
      [
        { id: "S1", name: "张三", className: "高三(1)班", combination: "物化生" },
        { id: "S2", name: "李四", className: "高三(2)班", combination: "史地政" },
        { id: "S3", name: "王五", className: "高三(3)班", combination: "物化生" },
      ],
    );
    await settle();

    const select = container.querySelector<HTMLSelectElement>('[aria-label="第一考场 专属组合"]');
    expect(select).not.toBeNull();
    const values = [...select!.options].map((option) => option.value);
    expect(values[0]).toBe("");
    expect(values).toContain("物化生");
    // core 归一化：史地政 → 政史地（不自己造写法）
    expect(values).toContain("政史地");
    expect(values).not.toContain("史地政");
    expect(select!.textContent).toContain("常规（自动）");
    expect(container.textContent).toContain("想把考政史地（或物化生）的整批学生集中到一个考场");

    select!.value = "政史地";
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(useRoomsStore().roomById("R1")?.combination).toBe("政史地");

    // 同时设了专用科目 → 互斥提示
    useRoomsStore().updateRoom("R1", { dedicatedSubjects: ["history"] });
    await settle();
    expect(container.textContent).toContain("设了专属组合后，本考场不再走专用科目");

    select!.value = "";
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    expect(useRoomsStore().roomById("R1")?.combination).toBeUndefined();
  });

  it("导入的非归一写法（史地政）在下拉里能回显，且导出仍是原写法", async () => {
    const container = mount(
      StepRooms,
      [
        { id: "R1", name: "第一考场", rows: 7, cols: 6, doorSide: "right", combination: "史地政" },
        { id: "R2", name: "第二考场", rows: 7, cols: 6, doorSide: "right" },
      ],
      [{ id: "S1", name: "张三", className: "高三(1)班", combination: "史地政" }],
    );
    await settle();

    const select = container.querySelector<HTMLSelectElement>('[aria-label="第一考场 专属组合"]');
    expect(select).not.toBeNull();
    // 当前值 = job 里的原写法，能正常回显
    expect(select!.value).toBe("史地政");
    const values = [...select!.options].map((option) => option.value);
    expect(values).toContain("政史地"); // 名单归一后的候选
    expect(values).toContain("史地政"); // 这一行的原值额外并进来

    // 原值只并进「有它的那一行」，别的行不出现
    const plain = container.querySelector<HTMLSelectElement>('[aria-label="第二考场 专属组合"]');
    expect([...plain!.options].map((option) => option.value)).not.toContain("史地政");

    // 存储值保持原样，同时导出往返仍是「史地政」
    expect(useRoomsStore().roomById("R1")?.combination).toBe("史地政");
    const draft = { ...createEmptyDraft(), rooms: useRoomsStore().rooms };
    const roundTrip = parseJobText(serializeJob(buildJob(draft)));
    expect(roundTrip.rooms?.[0]?.combination).toBe("史地政");
    expect(roundTrip.rooms?.[1]?.combination).toBeUndefined();
  });
});
