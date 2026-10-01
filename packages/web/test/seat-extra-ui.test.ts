import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

import SeatGridPreview from "@/components/SeatGridPreview.vue";
import type { SeatOccupant } from "@/lib/seat-grid";
import { useRoomsStore } from "@/stores/rooms";
import StepRooms from "@/views/StepRooms.vue";
import type { RoomSpec } from "@exam-seat/core";

/** Jsdom 缺 ResizeObserver，Element Plus 的表格会用到。 */
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

function mount(component: unknown, rooms: RoomSpec[] = []): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const pinia = createPinia();
  setActivePinia(pinia);
  useRoomsStore().replaceRooms(rooms);
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
});
