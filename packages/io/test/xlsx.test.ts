import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import {
  A4_LANDSCAPE_CONTENT_WIDTH_CM,
  buildXlsx,
  buildZip,
  fitToA4Landscape,
  planColumnWidths,
} from "../src/xlsx";
import type { XlsxStyleName } from "../src/xlsx";
import { readZip, toArrayBuffer, zipText } from "./helpers";

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

function styled(value: string | number, style: XlsxStyleName) {
  return { value, style };
}

const BOOK = buildXlsx({
  title: "高二上第一次月考 考场安排",
  sheets: [
    {
      name: "总表",
      rows: [
        [styled("高二上第一次月考 考场安排 总表", "title")],
        [styled("共 3 人 ｜ 2 个班 ｜ 1 个考场 ｜ 生成时间 2026-10-01 09:00", "meta")],
        ["班级", "姓名", "准考证号"].map((value) => styled(value, "header")),
        [styled("2501", "body"), styled("同学甲", "body"), styled("20260001", "body")],
        [styled("2502", "body"), styled("同学乙", "body"), styled("20260002", "body")],
      ],
      merges: ["A1:C1"],
      freezeRows: 3,
      printTitleRows: "1:3",
      rowHeights: [26],
    },
    {
      name: "2501",
      rows: [
        [styled("2501 考场安排", "title")],
        [styled("本班 1 人 ｜ 需换考场 0 人", "meta")],
        ["班级", "姓名", "准考证号"].map((value) => styled(value, "header")),
        [styled("2501", "body"), styled("同学甲", "body"), styled("20260001", "body")],
      ],
      merges: ["A1:C1"],
      freezeRows: 3,
      printTitleRows: "1:3",
    },
  ],
});

/* ------------------------------------------------------------------ */
/* SheetJS 读回                                                        */
/* ------------------------------------------------------------------ */

describe("buildXlsx：SheetJS 能读回", () => {
  it("值 / 合并 / 列宽都能读回", () => {
    // SheetJS 只在 cellStyles:true 时才解析 <cols>
    const workbook = XLSX.read(toArrayBuffer(BOOK), { type: "array", cellStyles: true });
    expect(workbook.SheetNames).toEqual(["总表", "2501"]);

    const sheet = workbook.Sheets["总表"]!;
    expect(sheet.A1!.v).toBe("高二上第一次月考 考场安排 总表");
    expect(sheet.A2!.v).toContain("共 3 人");
    expect(sheet.A4!.v).toBe("2501");
    expect(sheet.C5!.v).toBe("20260002");
    expect(sheet["!merges"]).toHaveLength(1);
    expect(sheet["!merges"]![0]).toMatchObject({ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } });
    expect(sheet["!cols"]).toHaveLength(3);
    expect(sheet["!cols"]![1]!.wch).toBeGreaterThan(0);
  });

  it("中文列宽按 2 个字符算，行高写进文件", () => {
    const worksheet = zipText(BOOK, "xl/worksheets/sheet1.xml");
    expect(worksheet).toContain('ht="26"');
    expect(worksheet).toContain('customHeight="1"');
  });
});

/* ------------------------------------------------------------------ */
/* 样式 + 打印设置                                                     */
/* ------------------------------------------------------------------ */

describe("styles.xml", () => {
  const styles = zipText(BOOK, "xl/styles.xml");

  it("含我们定义的字体（等线）与字号", () => {
    expect(styles).toContain('name val="等线"');
    expect(styles).toContain(
      '<sz val="16"/><color rgb="FF000000"/><name val="等线"/><charset val="134"/></font>',
    );
    expect(styles).toContain('<b/><sz val="16"');
    expect(styles).toContain('<sz val="12"/><color rgb="FF000000"/><name val="等线"/>');
    expect(styles).toContain('<sz val="9"/><color rgb="FF666666"/>');
    expect(styles).toContain('<sz val="11"/><color rgb="FF000000"/><name val="等线"/>');
  });

  it("颜色全部用 rgb，不引用 theme", () => {
    expect(styles).not.toContain("theme=");
    expect(styles).toContain('fgColor rgb="FFF2F2F2"');
    expect(styles).toContain("applyBorder");
  });

  it("cellXfs 有 7 档（默认 + 标题/副标题/小字/表头/正文/备注）", () => {
    expect(styles).toContain('<cellXfs count="7">');
  });

  it("只有一档正文样式，且水平居中（不再有左对齐的 body 与 bodyCenter 两套）", () => {
    // 唯一的正文 xf（fontId=5）必须居中
    const bodyXf = /<xf [^>]*fontId="5"[^>]*>.*?<\/xf>/s.exec(styles)?.[0];
    expect(bodyXf).toContain('horizontal="center"');
    // 正文 xf 只出现一次：没有第二处 fontId="5" 的 xf
    expect(styles.match(/fontId="5"/g) ?? []).toHaveLength(1);
  });

  it("meta 小字仍然左对齐", () => {
    const metaXf = /<xf [^>]*fontId="3"[^>]*>.*?<\/xf>/s.exec(styles)?.[0];
    expect(metaXf).toContain('horizontal="left"');
  });
});

describe("worksheet：打印设置与元素顺序", () => {
  const worksheet = zipText(BOOK, "xl/worksheets/sheet1.xml");

  it("打印设置：A4 横向 + 缩放适应页宽 + 页边距 + 水平居中", () => {
    expect(worksheet).toContain(
      '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>',
    );
    expect(worksheet).toContain('<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
    expect(worksheet).toContain(
      '<pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.3" footer="0.3"/>',
    );
    expect(worksheet).toContain('<printOptions horizontalCentered="1"/>');
  });

  it("冻结前 3 行 + 合并单元格 + cols", () => {
    expect(worksheet).toContain(
      '<pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/>',
    );
    expect(worksheet).toContain('<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>');
    expect(worksheet).toContain("<cols>");
    expect(worksheet).toContain("<sheetData>");
  });

  it("用了我们的样式下标 s：标题 1 / 表头 4 / 正文 5", () => {
    expect(worksheet).toContain('<c r="A1" s="1"');
    expect(worksheet).toContain('s="4"');
    expect(worksheet).toContain('s="5"');
  });

  it("正文单元格（A4）指向居中的正文样式", () => {
    const bodyStyle = /<c r="A4" s="(?<style>\d+)"/.exec(worksheet)?.groups?.style;
    expect(bodyStyle).toBe("5");
    const styles = zipText(BOOK, "xl/styles.xml");
    const cellXfs = /<cellXfs[^>]*>(?<xfs>.*?)<\/cellXfs>/s.exec(styles)?.groups?.xfs ?? "";
    const xfs = [...cellXfs.matchAll(/<xf\b[^>]*?(?:\/>|>.*?<\/xf>)/gs)].map((match) => match[0]);
    expect(xfs).toHaveLength(7);
    expect(xfs[Number(bodyStyle)]).toContain('horizontal="center"');
  });

  it("元素顺序符合 OOXML", () => {
    const order = [
      "<sheetPr>",
      "<dimension ",
      "<sheetViews>",
      "<sheetFormatPr ",
      "<cols>",
      "<sheetData>",
      "<mergeCells ",
      "<printOptions ",
      "<pageMargins ",
      "<pageSetup ",
    ];
    const positions = order.map((tag) => worksheet.indexOf(tag));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("每页重复打印表头写进 workbook 的 definedNames", () => {
    const workbook = zipText(BOOK, "xl/workbook.xml");
    expect(workbook).toContain('name="_xlnm.Print_Titles"');
    expect(workbook).toContain("&apos;总表&apos;!$1:$3");
    expect(workbook).toContain("<definedNames>");
    // sheets 在 definedNames 之前
    expect(workbook.indexOf("<sheets>")).toBeLessThan(workbook.indexOf("<definedNames>"));
  });

  it("包的骨架文件齐全（无 sharedStrings）", () => {
    const entries = readZip(BOOK);
    const names = [...entries.keys()];
    expect(names).toContain("[Content_Types].xml");
    expect(names).toContain("_rels/.rels");
    expect(names).toContain("docProps/core.xml");
    expect(names).toContain("xl/workbook.xml");
    expect(names).toContain("xl/_rels/workbook.xml.rels");
    expect(names).toContain("xl/styles.xml");
    expect(names).toContain("xl/worksheets/sheet1.xml");
    expect(names).toContain("xl/worksheets/sheet2.xml");
    expect(names.some((name) => name.includes("sharedStrings"))).toBe(false);
    expect(zipText(BOOK, "[Content_Types].xml")).toContain("/xl/styles.xml");
  });
});

/* ------------------------------------------------------------------ */
/* sheet 名 & 兜底                                                     */
/* ------------------------------------------------------------------ */

describe("sheet 名与兜底", () => {
  it("非法字符替换、超长截断、重名加序号", () => {
    const bytes = buildXlsx({
      sheets: [
        { name: "第一考场（语数外物化生）", rows: [] },
        { name: "第一考场（语数外物化生）", rows: [] },
        { name: "a/b:c*d?e[f]g\\h", rows: [] },
      ],
    });
    const workbook = XLSX.read(toArrayBuffer(bytes), { type: "array" });
    expect(workbook.SheetNames[0]).toBe("第一考场（语数外物化生）");
    expect(workbook.SheetNames[1]).not.toBe(workbook.SheetNames[0]);
    expect(workbook.SheetNames[1]).toMatch(/\(2\)$/);
    expect(workbook.SheetNames[2]).toBe("a-b-c-d-e-f-g-h");
  });

  it("一张表都没有时兜底一张空白表（Excel 不接受空工作簿）", () => {
    const bytes = buildXlsx({ sheets: [] });
    const workbook = XLSX.read(toArrayBuffer(bytes), { type: "array" });
    expect(workbook.SheetNames).toHaveLength(1);
  });

  it("产物可复现：同一入参两次字节完全一致", () => {
    const spec = {
      title: "高二上第一次月考 考场安排",
      sheets: [
        {
          name: "总表",
          rows: [[styled("高二上第一次月考 考场安排 总表", "title")]],
          merges: ["A1:C1"],
          freezeRows: 3,
          printTitleRows: "1:3",
        },
      ],
    };
    expect(buildXlsx(spec)).toEqual(buildXlsx(spec));
  });
});

/* ------------------------------------------------------------------ */
/* ZIP 与列宽                                                          */
/* ------------------------------------------------------------------ */

describe("buildZip：stored 打包", () => {
  it("stored 打包，CRC 与文件名正确，能被解压", () => {
    const encoder = new TextEncoder();
    const bytes = buildZip([
      { name: "a.txt", bytes: encoder.encode("hello") },
      { name: "目录/b.txt", bytes: encoder.encode("中文内容") },
    ]);
    const entries = readZip(bytes); // readZip 内部用 node:zlib 的 crc32 校验
    expect([...entries.keys()]).toEqual(["a.txt", "目录/b.txt"]);
    expect(new TextDecoder().decode(entries.get("a.txt"))).toBe("hello");
    expect(new TextDecoder().decode(entries.get("目录/b.txt"))).toBe("中文内容");
  });

  it("空文件名直接报错", () => {
    expect(() => buildZip([{ name: "", bytes: new Uint8Array(0) }])).toThrow("文件名不能为空");
  });
});

describe("planColumnWidths：内容自适应", () => {
  it("中文列宽按 2 个字符算，加 2 余量并夹在 [min, max]", () => {
    const widths = planColumnWidths([
      ["张三", "20260001"],
      ["李四四", "1"],
    ]);
    expect(widths[0]).toBe(8); // 「李四四」= 6 + 2
    expect(widths[1]).toBe(10); // 8 + 2
  });

  it("min / max 可覆盖", () => {
    expect(planColumnWidths([["a"]], { min: 3 })[0]).toBe(3);
    expect(planColumnWidths([["a".repeat(100)]], { max: 20 })[0]).toBe(20);
  });

  it("空表返回空数组", () => {
    expect(planColumnWidths([])).toEqual([]);
  });
});

describe("fitToA4Landscape：按 A4 收窄", () => {
  const cm = (widths: number[]): number => widths.reduce((sum, width) => sum + width, 0) * 0.185;

  it("不超宽时原样返回", () => {
    const widths = [10, 12, 14];
    expect(fitToA4Landscape(widths)).toEqual(widths);
  });

  it("超宽时等比收窄到 A4 横向可用宽度以内", () => {
    const widths = [60, 60, 60, 60, 60];
    expect(cm(widths)).toBeGreaterThan(A4_LANDSCAPE_CONTENT_WIDTH_CM);
    const fitted = fitToA4Landscape(widths);
    expect(cm(fitted)).toBeLessThanOrEqual(A4_LANDSCAPE_CONTENT_WIDTH_CM + 1e-9);
    expect(fitted.every((width, index) => width <= widths[index]!)).toBe(true);
    expect(fitted.every((width) => width >= 6)).toBe(true);
  });

  it("列多到下限都放不下时退回下限，不产生负数", () => {
    const fitted = fitToA4Landscape(Array.from({ length: 40 }, () => 40));
    expect(fitted.every((width) => width >= 6)).toBe(true);
  });

  it("空数组返回空数组", () => {
    expect(fitToA4Landscape([])).toEqual([]);
  });
});
