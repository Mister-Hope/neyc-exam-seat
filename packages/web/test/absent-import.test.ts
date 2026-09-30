import ElementPlus from "element-plus";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import * as XLSX from "xlsx";

import { toArrayBuffer } from "@/lib/download";
import { resolveAbsentImport } from "@/lib/roster-import";
import { useRosterStore } from "@/stores/roster";
import StepExclude from "@/views/StepExclude.vue";
import type { Student } from "@exam-seat/core";
import type { SheetData } from "@exam-seat/io";

/** Jsdom 缺 ResizeObserver：页面里的 VirtualTable 要用。 */
class ResizeObserverStub {
  observe = (): void => {};
  unobserve = (): void => {};
  disconnect = (): void => {};
}

const sheet = (name: string, headers: string[], rows: string[][]): SheetData => ({
  name,
  headers,
  rows,
});

const makeStudents = (): Student[] => [
  { id: "S1", name: "张三", className: "高三(1)班" },
  { id: "S2", name: "李四", className: "高三(1)班" },
  { id: "S3", name: "王五", className: "高三(2)班" },
];

function workbookBytes(sheets: { name: string; rows: (string | number)[][] }[]): Uint8Array {
  const book = XLSX.utils.book_new();
  for (const item of sheets) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(item.rows), item.name);
  }
  const out = XLSX.write(book, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  return new Uint8Array(out);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });

const flush = async (): Promise<void> => {
  await nextTick();
  await nextTick();
  await nextTick();
  await nextTick();
  await sleep(0);
};

async function mountExclude(students: Student[]) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: StepExclude }],
  });
  await router.push("/");
  await router.isReady();

  const container = document.createElement("div");
  document.body.append(container);
  const pinia = createPinia();
  setActivePinia(pinia);
  const roster = useRosterStore();
  roster.replaceStudents(students);

  const app = createApp({ render: () => h(StepExclude) });
  app.use(pinia);
  app.use(router);
  app.use(ElementPlus);
  app.mount(container);
  await flush();
  return { app, container, roster };
}

/** 直接给 el-upload 的 file input 塞一个真文件，触发页面上的导入逻辑。 */
async function uploadAbsent(container: HTMLElement, name: string, bytes: Uint8Array) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  const file = new File([toArrayBuffer(bytes)], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  Object.defineProperty(input!, "files", { value: [file], configurable: true });
  input!.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
}

describe("缺考名单导入", () => {
  beforeAll(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;
  });

  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("有准考证号列：按准考证号命中，未匹配行带行号回报", () => {
    const students = makeStudents();
    const { students: next, report } = resolveAbsentImport(
      [
        sheet(
          "缺考",
          ["准考证号", "备注"],
          [
            ["S1", "病假"],
            ["S3", "事假"],
            ["S9", "不在名单"],
          ],
        ),
      ],
      students,
    );

    expect(report).toMatchObject({ ok: true, keys: 3, matched: 2, unmatched: 1 });
    expect(
      next.filter((student) => student.included === false).map((student) => student.id),
    ).toEqual(["S1", "S3"]);
    expect(report.unmatchedSamples[0]).toContain("第 4 行");
    expect(report.unmatchedSamples[0]).toContain("S9");
  });

  it("没有准考证号列：按 姓名+班级 成对命中", () => {
    const { students: next, report } = resolveAbsentImport(
      [
        sheet(
          "缺考",
          ["姓名", "班级"],
          [
            ["张三", "高三(1)班"],
            ["王五", "高三(2)班"],
            ["赵六", "高三(3)班"],
          ],
        ),
      ],
      makeStudents(),
    );

    expect(report).toMatchObject({ ok: true, matched: 2, unmatched: 1 });
    expect(
      next.filter((student) => student.included === false).map((student) => student.id),
    ).toEqual(["S1", "S3"]);
    expect(report.unmatchedSamples[0]).toContain("赵六");
  });

  it("缺准考证号也缺 姓名+班级 时给中文原因，主名单不动", () => {
    const students = makeStudents();
    const { students: next, report } = resolveAbsentImport(
      [sheet("缺考", ["备注"], [["随便写点"]])],
      students,
    );

    expect(report.ok).toBe(false);
    expect(report.error).toBeTruthy();
    expect(next.every((student) => student.included === undefined)).toBe(true);
    expect(students.every((student) => student.included === undefined)).toBe(true);
  });

  it("缺考名单自带「缺考」列时只取真正缺席的行", () => {
    const { students: next, report } = resolveAbsentImport(
      [
        sheet(
          "缺考",
          ["准考证号", "缺考"],
          [
            ["S1", "是"],
            ["S2", "否"],
            ["S3", "病假"],
          ],
        ),
      ],
      makeStudents(),
    );

    expect(report).toMatchObject({ ok: true, keys: 2, matched: 2, unmatched: 0 });
    expect(
      next.filter((student) => student.included === false).map((student) => student.id),
    ).toEqual(["S1", "S3"]);
  });

  it("未匹配行不修改原数组（applyAbsentKeys 不就地改）", () => {
    const students = makeStudents();
    resolveAbsentImport([sheet("缺考", ["准考证号"], [["S2"]])], students);
    expect(students.map((student) => student.included)).toEqual([undefined, undefined, undefined]);
  });

  it("store：导入缺考名单后持久化，模拟刷新仍是不参加", async () => {
    const roster = useRosterStore();
    roster.replaceStudents(makeStudents());
    const report = roster.importAbsentBytes(
      workbookBytes([{ name: "缺考", rows: [["准考证号"], ["S1"], ["S2"], ["S9"]] }]),
    );

    expect(report).toMatchObject({ ok: true, matched: 2, unmatched: 1 });
    expect(roster.excludedCount).toBe(2);
    expect(roster.participants).toBe(1);

    await flush();
    setActivePinia(createPinia());
    const reloaded = useRosterStore();
    expect(reloaded.excludedCount).toBe(2);
    expect(reloaded.students.find((student) => student.id === "S1")?.included).toBe(false);
  });

  it("页面：导入缺考名单后提示命中人数、未匹配行与键值", async () => {
    const { app, container, roster } = await mountExclude(makeStudents());
    await uploadAbsent(
      container,
      "缺考名单.xlsx",
      workbookBytes([{ name: "缺考", rows: [["准考证号"], ["S1"], ["S2"], ["S9"]] }]),
    );

    expect(roster.excludedCount).toBe(2);
    expect(container.textContent).toContain("命中 2 人");
    expect(container.textContent).toContain("未匹配 1 行");
    expect(container.textContent).toContain("第 4 行");
    expect(container.textContent).toContain("S9");
    app.unmount();
  });

  it("页面：缺列时报中文原因，不写坏主名单", async () => {
    const { app, container, roster } = await mountExclude(makeStudents());
    await uploadAbsent(
      container,
      "缺考名单.xlsx",
      workbookBytes([{ name: "缺考", rows: [["备注"], ["x"]] }]),
    );

    expect(roster.excludedCount).toBe(0);
    expect(container.textContent).toContain("缺考名单导入失败");
    app.unmount();
  });

  it("页面：原有「全选当前结果 → 批量排除」不受缺考名单入口影响", async () => {
    const { app, container, roster } = await mountExclude(makeStudents());
    await uploadAbsent(
      container,
      "缺考名单.xlsx",
      workbookBytes([{ name: "缺考", rows: [["准考证号"], ["S1"]] }]),
    );
    expect(roster.excludedCount).toBe(1);

    const button = [...container.querySelectorAll("button")].find((el) =>
      el.textContent?.includes("全选当前结果"),
    );
    expect(button).toBeDefined();
    button!.click();
    await flush();

    const exclude = [...container.querySelectorAll("button")].find((el) =>
      el.textContent?.includes("批量排除"),
    );
    expect(exclude?.textContent).toContain("批量排除（3）");
    exclude!.click();
    await flush();
    expect(roster.excludedCount).toBe(3);
    app.unmount();
  });
});
