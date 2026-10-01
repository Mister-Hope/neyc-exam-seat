import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

import { useRosterStore } from "@/stores/roster";
import StepExclude from "@/views/StepExclude.vue";
import type { Student } from "@exam-seat/core";

const CLASS_COUNT = 18;

const makeStudents = (count: number): Student[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `S${String(index + 1).padStart(4, "0")}`,
    name: `学生${index + 1}`,
    className: `高三(${(index % CLASS_COUNT) + 1})班`,
  }));

const flush = async (): Promise<void> => {
  await nextTick();
  await nextTick();
  await nextTick();
};

const renderedRows = (container: HTMLElement): number =>
  container.querySelectorAll(".vt-row").length;

const findButton = (container: HTMLElement, text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll("button")].find((el) => el.textContent?.includes(text));

async function mountStep(students: Student[]) {
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
  app.mount(container);
  await flush();

  return { app, container, roster };
}

/** 在查询框里输入，触发 v-model。 */
async function typeQuery(container: HTMLElement, text: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>("#exclude-query");
  expect(input).not.toBeNull();
  input!.value = text;
  input!.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
}

describe("排除缺考页 · 虚拟滚动", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("1000 人名单只渲染可视区域的行（DOM 行数远小于 1000）", async () => {
    const { app, container } = await mountStep(makeStudents(1000));

    const rendered = renderedRows(container);
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(50);
    // 数据仍是全量：按钮上的 N 来自计算属性过滤结果，不是渲染行数
    expect(findButton(container, "全选当前结果（1000 人）")).toBeDefined();
    app.unmount();
  });

  it("无筛选时「全选当前结果（1000 人）」勾到全量，不是已渲染的十几行", async () => {
    const { app, container } = await mountStep(makeStudents(1000));

    const rendered = renderedRows(container);
    findButton(container, "全选当前结果（1000 人）")!.click();
    await flush();

    expect(rendered).toBeLessThan(50);
    expect(findButton(container, "批量排除（1000）")).toBeDefined();
    app.unmount();
  });

  it("搜索后「全选当前结果」按过滤结果全选，批量排除一个不漏", async () => {
    const students = makeStudents(1000);
    const { app, container, roster } = await mountStep(students);
    const expected = students.filter((student) => student.className === "高三(7)班").length;
    expect(expected).toBeGreaterThan(0);

    await typeQuery(container, "班级:高三(7)班");

    const allButton = findButton(container, `全选当前结果（${expected} 人）`);
    expect(allButton).toBeDefined();
    allButton!.click();
    await flush();

    const excludeButton = findButton(container, `批量排除（${expected}）`);
    expect(excludeButton).toBeDefined();
    excludeButton!.click();
    await flush();

    expect(roster.excludedCount).toBe(expected);
    expect(findButton(container, `查看已排除（${expected}）`)).toBeDefined();
    // 被排除的行置灰 + 「不参加」标签
    expect(container.querySelector(".row-excluded")).not.toBeNull();
    expect(container.querySelector(".vt-row")?.textContent).toContain("不参加");
    app.unmount();
  });

  it("被排除行置灰，可在表格里单条恢复", async () => {
    const students = makeStudents(100);
    students[0] = { ...students[0]!, included: false };
    const { app, container, roster } = await mountStep(students);

    const row = container.querySelector<HTMLElement>(".vt-row");
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain("不参加");
    expect(row!.classList.contains("row-excluded")).toBe(true);
    expect(roster.excludedCount).toBe(1);

    const restore = [...row!.querySelectorAll("button")].find((el) =>
      el.textContent?.includes("恢复"),
    );
    expect(restore).toBeDefined();
    restore!.click();
    await flush();

    expect(roster.excludedCount).toBe(0);
    expect(container.querySelector(".row-excluded")).toBeNull();
    app.unmount();
  });

  it("清空勾选后批量排除按钮回到禁用态", async () => {
    const { app, container } = await mountStep(makeStudents(200));

    await typeQuery(container, "班级:高三(1)班");
    findButton(container, "全选当前结果")!.click();
    await flush();
    expect(findButton(container, "批量排除")?.disabled).toBe(false);

    findButton(container, "清空勾选")!.click();
    await flush();
    expect(findButton(container, "批量排除")?.disabled).toBe(true);
    app.unmount();
  });

  it("缺考名单导入走隐藏 file input（不再依赖 el-upload）", async () => {
    const { app, container } = await mountStep(makeStudents(20));
    expect(container.querySelector('[data-testid="absent-file"]')).not.toBeNull();
    expect(findButton(container, "导入缺考名单")).toBeDefined();
    app.unmount();
  });
});
