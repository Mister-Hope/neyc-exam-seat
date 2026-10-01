import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

import App from "@/App.vue";
import { STEPS } from "@/router";

/** 渲染冒烟测试：六个步骤页各挂载一次，保证模板真能跑通。 jsdom 缺 ResizeObserver，预留一个最小 stub（部分组件/浏览器 API 会探测它）。 */
class ResizeObserverStub {
  observe = (): void => {};
  unobserve = (): void => {};
  disconnect = (): void => {};
}

describe("六个步骤页挂载冒烟", () => {
  beforeAll(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each(STEPS)("$title 能挂载", async (step) => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: STEPS.map((item) => ({ path: item.path, component: item.component })),
    });
    await router.push(step.path);
    await router.isReady();

    const container = document.createElement("div");
    document.body.append(container);
    const app = createApp({ render: () => h(App) });
    setActivePinia(createPinia());
    app.use(createPinia());
    app.use(router);
    app.mount(container);
    await nextTick();
    await nextTick();
    expect(container.innerHTML.length).toBeGreaterThan(200);
    expect(container.textContent).toContain("考场排布");
    app.unmount();
  });
});
