import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import * as XLSX from "xlsx";

import { toArrayBuffer } from "@/lib/download";
import { analyzeSheet, columnLabel, missingRequired, pickRosterSheet } from "@/lib/roster-import";
import { useRosterStore } from "@/stores/roster";
import StepImport from "@/views/StepImport.vue";
import type { SheetData } from "@exam-seat/io";

/** Jsdom 缺 ResizeObserver：问题行表（VirtualTable）要用。 */
class ResizeObserverStub {
  observe = (): void => {};
  unobserve = (): void => {};
  disconnect = (): void => {};
}

const sheet = (name: string, headers: string[], rows: string[][] = []): SheetData => ({
  name,
  headers,
  rows,
});

/** 用真实的 xlsx 字节走完整导入链路（readWorkbook → 自动选表 → 预填映射 → parseRoster）。 */
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
};

async function mountImport(setup: (roster: ReturnType<typeof useRosterStore>) => void) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/", component: StepImport }],
  });
  await router.push("/");
  await router.isReady();

  const container = document.createElement("div");
  document.body.append(container);
  const pinia = createPinia();
  setActivePinia(pinia);
  const roster = useRosterStore();
  setup(roster);

  const app = createApp({ render: () => h(StepImport) });
  app.use(pinia);
  app.use(router);
  app.mount(container);
  await flush();
  return { app, container, roster };
}

describe("名单导入 · 列映射与预填", () => {
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

  it("columnLabel：0→A、2→C、26→AA、未映射→?", () => {
    expect(columnLabel(0)).toBe("A");
    expect(columnLabel(2)).toBe("C");
    expect(columnLabel(25)).toBe("Z");
    expect(columnLabel(26)).toBe("AA");
    expect(columnLabel(-1)).toBe("?");
  });

  it("带空格表头（姓 名 / 班 级）也能识别出必填三列", () => {
    const target = sheet("名单", ["准考证号", "姓 名", "班 级"], [["S1", "张三", "高三(1)班"]]);
    const picked = pickRosterSheet([target]);
    expect(picked?.missing).toEqual([]);

    const analysis = analyzeSheet(target);
    expect(analysis.missing).toEqual([]);
    expect(analysis.students).toHaveLength(1);
    expect(analysis.students[0]).toMatchObject({ id: "S1", name: "张三", className: "高三(1)班" });
  });

  it("考证号 当作准考证号预填", () => {
    const analysis = analyzeSheet(
      sheet("名单", ["考证号", "姓名", "班级"], [["S9", "李四", "高三(2)班"]]),
    );
    expect(analysis.missing).toEqual([]);
    expect(analysis.mapping.id).toBe(0);
    expect(analysis.students[0]?.id).toBe("S9");
  });

  it("缺考列：是 / 病假 记缺考，否 / 空 不记", () => {
    const analysis = analyzeSheet(
      sheet(
        "名单",
        ["准考证号", "姓名", "班级", "缺考"],
        [
          ["S1", "张三", "高三(1)班", "是"],
          ["S2", "李四", "高三(1)班", "否"],
          ["S3", "王五", "高三(1)班", ""],
          ["S4", "赵六", "高三(1)班", "病假"],
        ],
      ),
    );
    expect(analysis.mapping.absent).toBe(3);
    expect(analysis.absentCount).toBe(2);
    expect(analysis.students.map((student) => student.included === false)).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });

  it("必填列没识别出来时交回 missing，且不解析", () => {
    const analysis = analyzeSheet(sheet("名单", ["名字", "备注"], [["张三", "x"]]));
    expect(analysis.missing).toEqual(["id", "className"]);
    expect(analysis.students).toEqual([]);
    expect(missingRequired(analysis.mapping)).toEqual(["id", "className"]);
  });

  it("多表：优先选能识别出必填三列的工作表", () => {
    const bad = sheet("Sheet1", ["名字", "备注"], [["张三", "x"]]);
    const good = sheet("Sheet2", ["准考证号", "姓名", "班级"], [["S1", "张三", "高三(1)班"]]);
    expect(pickRosterSheet([bad, good])?.sheet.name).toBe("Sheet2");
  });

  it("多表都不全时退回第一张，并保留部分识别结果", () => {
    const first = sheet("Sheet1", ["姓名", "备注"], [["张三", "x"]]);
    const second = sheet("Sheet2", ["学号"], [["S1"]]);
    const picked = pickRosterSheet([first, second]);
    expect(picked?.sheet.name).toBe("Sheet1");
    expect(picked?.missing).toContain("id");
    expect(picked?.autoMapping.name).toBe(0);
  });

  it("store：真实 xlsx 导入后列映射自动预填，缺考列直接生效", async () => {
    const roster = useRosterStore();
    const ok = roster.importBytes(
      workbookBytes([
        {
          name: "名单",
          rows: [
            ["考证号", "姓 名", "班 级", "缺考"],
            ["S1", "张三", "高三(1)班", "是"],
            ["S2", "李四", "高三(1)班", "否"],
          ],
        },
      ]),
      "测试名单.xlsx",
    );
    expect(ok).toBe(true);
    expect(roster.mapping).toMatchObject({ id: 0, name: 1, className: 2, absent: 3 });
    expect(roster.total).toBe(2);
    expect(roster.absentMarked).toBe(1);
    expect(roster.excludedCount).toBe(1);
    expect(roster.isIncluded(roster.students.find((s) => s.id === "S1")!)).toBe(false);

    await flush();
    const raw = JSON.parse(localStorage.getItem("exam-seat:roster")!) as {
      students: { id: string; included?: boolean }[];
    };
    expect(raw.students.find((s) => s.id === "S1")?.included).toBe(false);
  });

  it("store：多表 xlsx 自动选能识别出必填三列的那张表", () => {
    const roster = useRosterStore();
    roster.importBytes(
      workbookBytes([
        {
          name: "说明",
          rows: [
            ["名字", "备注"],
            ["张三", "x"],
          ],
        },
        {
          name: "高三名单",
          rows: [
            ["准考证号", "姓名", "班级"],
            ["S1", "张三", "高三(1)班"],
          ],
        },
      ]),
      "多表.xlsx",
    );
    expect(roster.sheetName).toBe("高三名单");
    expect(roster.total).toBe(1);
  });

  it("store：必填列缺失时不报错、不解析，留给页面标红", () => {
    const roster = useRosterStore();
    roster.importSheets([sheet("名单", ["名字", "备注"], [["张三", "x"]])], "缺列.xlsx");
    expect(roster.total).toBe(0);
    expect(roster.errorMessage).toBe("");
    expect(missingRequired(roster.mapping ?? {})).toEqual(["id", "className"]);
  });

  it("手动补列映射后立刻重解析", () => {
    const roster = useRosterStore();
    roster.importSheets([
      sheet(
        "名单",
        ["名字", "流水", "班 级"],
        [
          ["张三", "S1", "高三(1)班"],
          ["李四", "S2", "高三(1)班"],
        ],
      ),
    ]);
    expect(roster.total).toBe(0);
    expect(missingRequired(roster.mapping ?? {})).toEqual(["id"]);

    roster.updateMapping({ id: 1 });
    expect(roster.mapping?.id).toBe(1);
    expect(roster.total).toBe(2);
    expect(roster.classCount).toBe(1);
  });

  it("固定 1000 行名单导入后，统计与人数按钮都对", () => {
    const rows: (string | number)[][] = [["准考证号", "姓名", "班级"]];
    for (let index = 0; index < 1000; index += 1) {
      rows.push([`S${index}`, `学生${index}`, `高三(${(index % 18) + 1})班`]);
    }
    const roster = useRosterStore();
    roster.importBytes(workbookBytes([{ name: "名单", rows }]), "1000人.xlsx");
    expect(roster.total).toBe(1000);
    expect(roster.classCount).toBe(18);
  });

  it("页面：列映射自动预填并显示「自动识别」，必填列缺失时标红提示", async () => {
    const { app, container } = await mountImport((roster) => {
      roster.importSheets(
        [
          sheet(
            "名单",
            ["考证号", "姓 名", "班 级"],
            [
              ["S1", "张三", "高三(1)班"],
              ["S2", "李四", "高三(2)班"],
            ],
          ),
        ],
        "预填.xlsx",
      );
    });

    expect(container.textContent).toContain("已自动识别 3/3 个必填列");
    expect(container.textContent).toContain("自动识别");
    expect(container.textContent).toContain("A 列");
    expect(container.textContent).toContain("考证号");
    // 预填结果要真的落在下拉框上（不只是文字提示）：考证号 = 第 0 列
    expect(container.querySelector<HTMLSelectElement>("#mapping-id")?.value).toBe("0");
    expect(container.querySelector<HTMLSelectElement>("#mapping-name")?.value).toBe("1");
    expect(container.querySelector<HTMLSelectElement>("#mapping-className")?.value).toBe("2");
    expect(container.querySelector("[data-invalid='true']")).toBeNull();
    app.unmount();
  });

  it("页面：必填列没认出来时把该下拉标红并提示手动指定", async () => {
    const { app, container } = await mountImport((roster) => {
      roster.importSheets([sheet("名单", ["名字", "备注"], [["张三", "x"]])], "缺列.xlsx");
    });

    const errorItems = container.querySelectorAll("[data-invalid='true']");
    expect(errorItems.length).toBeGreaterThan(0);
    expect(container.textContent).toContain("没认出来这些必填列");
    // 必填列没认出来时错误文案要一直挂在字段下面，且下拉停在「还没认出来」的占位项
    expect(container.querySelector<HTMLSelectElement>("#mapping-id")?.value).toBe("-1");
    await sleep(150);
    await nextTick();
    expect(container.textContent).toContain("没认出来，请手动指定");
    app.unmount();
  });

  it("页面：隐藏的 file input 选文件后走完整导入链路并预填映射", async () => {
    const { app, container, roster } = await mountImport(() => {});
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input!.accept).toBe(".xlsx,.xls");

    const file = new File(
      [
        toArrayBuffer(
          workbookBytes([
            {
              name: "名单",
              rows: [
                ["考证号", "姓 名", "班 级", "缺考"],
                ["S1", "张三", "高三(1)班", "是"],
              ],
            },
          ]),
        ),
      ],
      "上传名单.xlsx",
      { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    );
    Object.defineProperty(input!, "files", { value: [file], configurable: true });
    input!.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    await sleep(0);

    expect(roster.total).toBe(1);
    expect(roster.mapping).toMatchObject({ id: 0, name: 1, className: 2, absent: 3 });
    expect(container.textContent).toContain("已自动识别 3/3 个必填列");
    expect(container.textContent).toContain("上传名单.xlsx");
    // 缺考列照样直接生效
    expect(container.textContent).toContain("1 人已标记为不参加");
    app.unmount();
  });

  it("页面：识别到缺考列时提示「N 人已标记为不参加」", async () => {
    const { app, container, roster } = await mountImport((store) => {
      store.importSheets(
        [
          sheet(
            "名单",
            ["准考证号", "姓名", "班级", "缺考"],
            [
              ["S1", "张三", "高三(1)班", "是"],
              ["S2", "李四", "高三(1)班", "否"],
            ],
          ),
        ],
        "带缺考列.xlsx",
      );
    });

    expect(roster.excludedCount).toBe(1);
    expect(container.textContent).toContain("识别到缺考列");
    expect(container.textContent).toContain("1 人已标记为不参加");
    expect(container.textContent).toContain("可在第 ② 步恢复");
    app.unmount();
  });
});
