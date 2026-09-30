import { beforeEach, describe, expect, it } from "vitest";

import {
  STORAGE_PREFIX,
  clearExamSeatStorage,
  loadState,
  removeState,
  saveState,
  storageKey,
} from "@/lib/persist";

/** 这个文件跑在 jsdom 环境里（根 vitest 的 web project），所以直接有 localStorage。 */
describe("localStorage 持久化（键名前缀 exam-seat:）", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("键名统一带前缀", () => {
    expect(STORAGE_PREFIX).toBe("exam-seat:");
    expect(storageKey("roster")).toBe("exam-seat:roster");
  });

  it("存取往返：刷新页面后配置不丢", () => {
    const state = { students: [{ id: "A", name: "张三", className: "一班" }], fileName: "x.xlsx" };
    expect(saveState("roster", state)).toBe(true);
    expect(localStorage.getItem("exam-seat:roster")).not.toBeNull();
    expect(loadState("roster", null)).toEqual(state);
  });

  it("没有存过 / 存坏了都回退到默认值", () => {
    expect(loadState("missing", { fallback: true })).toEqual({ fallback: true });
    localStorage.setItem("exam-seat:rooms", "{坏掉的 JSON");
    expect(loadState("rooms", { rooms: [] })).toEqual({ rooms: [] });
  });

  it("removeState 只删自己那个键", () => {
    saveState("a", 1);
    saveState("b", 2);
    removeState("a");
    expect(loadState("a", null)).toBeNull();
    expect(loadState("b", null)).toBe(2);
  });

  it("无法序列化的值不会抛异常，只是存不进去", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(saveState("bad", circular)).toBe(false);
  });

  it("clearExamSeatStorage 清掉全部本应用键，不动别人的键", () => {
    saveState("roster", 1);
    saveState("result", 2);
    localStorage.setItem("someone-else", "keep");
    const removed = clearExamSeatStorage();
    expect(removed.sort()).toEqual(["exam-seat:result", "exam-seat:roster"]);
    expect(localStorage.getItem("someone-else")).toBe("keep");
    expect(localStorage.getItem("exam-seat:roster")).toBeNull();
  });
});
