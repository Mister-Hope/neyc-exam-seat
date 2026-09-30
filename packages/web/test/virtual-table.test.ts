import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { App, Ref } from "vue";
import { createApp, h, nextTick, ref } from "vue";

import VirtualTable from "@/components/VirtualTable.vue";
import type { VirtualTableColumn } from "@/components/VirtualTable.vue";

/** 渲染冒烟：jsdom 缺 ResizeObserver，ElAutoResizer 会用到（与 app-smoke.test.ts 同一份最小 stub）。 */
class ResizeObserverStub {
  observe = (): void => {};
  unobserve = (): void => {};
  disconnect = (): void => {};
}

interface Row {
  id: string;
  name: string;
  className: string;
}

const makeRows = (count: number): Row[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `S${String(index + 1).padStart(4, "0")}`,
    name: `学生${index + 1}`,
    className: `高三(${(index % 18) + 1})班`,
  }));

const COLUMNS: VirtualTableColumn[] = [
  { key: "id", title: "学号", width: 120 },
  { key: "name", title: "姓名", width: 120 },
  { key: "className", title: "班级", width: 160 },
];

const flush = async (): Promise<void> => {
  await nextTick();
  await nextTick();
};

interface Mounted {
  app: App;
  host: HTMLElement;
  rows: Ref<Row[]>;
  selected: Ref<string[]>;
  emitted: string[][];
  clicked: unknown[];
}

function mountVirtualTable(
  initialRows: Row[],
  slots?: Record<string, (props: { row: unknown; index: number }) => unknown>,
): Mounted {
  const rows = ref<Row[]>(initialRows);
  const selected = ref<string[]>([]);
  const emitted: string[][] = [];
  const clicked: unknown[] = [];
  const host = document.createElement("div");
  document.body.append(host);

  const app = createApp({
    render: () =>
      h(
        VirtualTable,
        {
          rows: rows.value,
          rowKey: (row: unknown) => (row as Row).id,
          columns: COLUMNS,
          selectable: true,
          selectedKeys: selected.value,
          "onUpdate:selected-keys": (keys: string[]) => {
            emitted.push(keys);
            selected.value = keys;
          },
          onRowClick: (row: unknown) => clicked.push(row),
        },
        slots,
      ),
  });
  app.mount(host);
  return { app, host, rows, selected, emitted, clicked };
}

const renderedRows = (host: HTMLElement): number =>
  host.querySelectorAll(".el-table-v2__row").length;

describe("virtualTable 虚拟滚动", () => {
  beforeAll(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("1000 行时只渲染可视区域，DOM 行数远小于 1000", async () => {
    const { app, host } = mountVirtualTable(makeRows(1000));
    await flush();

    const rendered = renderedRows(host);
    expect(rendered).toBeGreaterThan(0);
    // 实测 24 行（可视 10 行 + cache 2 前后各一批）；离 1000 差两个数量级
    expect(rendered).toBeLessThan(50);
    // 数据仍是 1000 行：滚动条总高度 = 1000 * 44
    expect(host.querySelector(".el-table-v2__row")?.textContent).toContain("S0001");
    app.unmount();
  });

  it("表头勾选 = 全选当前 rows 全量（不是渲染行）", async () => {
    const { app, host, emitted } = mountVirtualTable(makeRows(1000));
    await flush();

    const rendered = renderedRows(host);
    const input = host.querySelector<HTMLInputElement>(".vt-select-all input");
    expect(input).not.toBeNull();
    input!.click();
    await flush();

    const keys = emitted.at(-1);
    expect(keys).toHaveLength(1000);
    // 漏人检查：真正渲染的行只有十几行，选中的必须是全量
    expect(keys!.length).toBeGreaterThan(rendered * 10);
    app.unmount();
  });

  it("部分选中时表头为半选态，全选后恢复", async () => {
    const { app, host, rows, selected } = mountVirtualTable(makeRows(10));
    await flush();

    selected.value = rows.value.slice(0, 3).map((row) => row.id);
    await flush();
    expect(host.querySelector(".el-checkbox__input.is-indeterminate")).not.toBeNull();
    expect(host.querySelector(".vt-select-all")?.getAttribute("aria-checked")).toBe("mixed");

    selected.value = rows.value.map((row) => row.id);
    await flush();
    expect(host.querySelector(".el-checkbox__input.is-indeterminate")).toBeNull();
    expect(host.querySelector<HTMLInputElement>(".vt-select-all input")?.checked).toBe(true);
    app.unmount();
  });

  it("行勾选 emit 完整 keys 数组（以 rowKey 为准，可取消）", async () => {
    const { app, host, emitted, selected } = mountVirtualTable(makeRows(100));
    await flush();

    host.querySelector<HTMLInputElement>(".vt-row-checkbox input")!.click();
    await flush();
    expect(emitted.at(-1)).toEqual(["S0001"]);
    expect(selected.value).toEqual(["S0001"]);

    host.querySelector<HTMLInputElement>(".vt-row-checkbox input")!.click();
    await flush();
    expect(emitted.at(-1)).toEqual([]);
    app.unmount();
  });

  it("换筛选结果（rows 变化）后，不在当前 rows 的选中项被裁掉", async () => {
    const all = makeRows(10);
    const { app, host, rows, selected, emitted } = mountVirtualTable(all);
    await flush();

    selected.value = ["S0001", "S0009"];
    await flush();

    rows.value = all.filter((row) => row.className === "高三(1)班");
    await flush();

    // S0009 是高三(9)班，已不在当前 rows 里
    expect(emitted.at(-1)).toEqual(["S0001"]);
    expect(host.querySelector<HTMLInputElement>(".vt-row-checkbox input")).not.toBeNull();
    app.unmount();
  });

  it("过滤后的 rows 上表头全选只选当前结果", async () => {
    const all = makeRows(1000);
    const { app, host, rows, emitted } = mountVirtualTable(all);
    await flush();

    rows.value = all.filter((row) => row.className === "高三(1)班");
    await flush();
    const filtered = rows.value.length;
    expect(filtered).toBeGreaterThan(0);

    host.querySelector<HTMLInputElement>(".vt-select-all input")!.click();
    await flush();
    expect(emitted.at(-1)).toHaveLength(filtered);
    app.unmount();
  });

  it("cell-<key> 插槽拿得到原始 row 与 index，未给插槽时按 key 取值", async () => {
    const rows = makeRows(5);
    const { app, host } = mountVirtualTable(rows, {
      "cell-name": ({ row }) => h("strong", { class: "custom-name" }, `[${(row as Row).name}]`),
    });
    await flush();

    const custom = host.querySelector(".custom-name");
    expect(custom?.textContent).toBe("[学生1]");
    // id 列没有自定义插槽，走默认渲染
    expect(host.querySelector(".el-table-v2__row")?.textContent).toContain("S0001");
    app.unmount();
  });

  it("空数据渲染 empty 占位", async () => {
    const { app, host } = mountVirtualTable([]);
    await flush();
    expect(host.textContent).toContain("暂无数据");
    app.unmount();
  });

  it("row-click 抛出对应行数据", async () => {
    const rows = makeRows(5);
    const { app, host, clicked } = mountVirtualTable(rows);
    await flush();

    host.querySelector<HTMLElement>(".el-table-v2__row")!.click();
    await flush();

    expect(clicked).toHaveLength(1);
    expect(clicked[0]).toEqual(rows[0]);
    app.unmount();
  });
});
