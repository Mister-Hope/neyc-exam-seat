/**
 * 零依赖的极小 xlsx 写出器（浏览器 / Node 通用）。
 *
 * 为什么不用 SheetJS 写：社区版**写不出字体 / 字号 / 对齐 / 填充**（`cell.s` 被忽略、styles.xml 只有默认字体），
 * 而老师要拿这些表直接打印。所以这里手写一份最小 OOXML + stored ZIP，专门服务「打印级」表格：
 *
 * - 文本走 `inlineStr`，不写 sharedStrings（表小，省一层映射）；
 * - ZIP 自己写（method 0 存储 + CRC32 表 + UTF-8 文件名），不碰 `node:zlib`，浏览器也能跑；
 * - 固定 A4 横向 + 缩放适应页宽 + 冻结表头 + 每页重复打印表头；
 * - 颜色一律 `rgb`（不用 theme），中文字体名「等线」。
 *
 * 产物是确定性的：同一个 `XlsxBookSpec` 每次得到的字节完全一致（ZIP 时间戳固定、无当前时间）。
 */

import { buildZip } from "./zip";

/** 打 ZIP 包（stored + CRC32 + UTF-8 文件名）；xlsx 内部与网页「整包下载」共用。 */
export { buildZip } from "./zip";

/**
 * 业务样式档位。
 *
 * 只有一档正文样式 `body`（11pt **居中** + 细边框）——正文全部居中，不再保留左对齐 / 居中两套， 避免同一张表里两种对齐混用。`meta` 是唯一左对齐的小字。
 */
export type XlsxStyleName = "title" | "subtitle" | "meta" | "header" | "body" | "note";

export interface XlsxCell {
  value: string | number;
  style?: XlsxStyleName;
}

export type XlsxCellInput = string | number | XlsxCell | null | undefined;

export interface XlsxSheet {
  /** Sheet 名（≤31 字符；非法字符会被替换，重名会自动加序号） */
  name: string;
  rows: XlsxCellInput[][];
  /** 字符宽；缺省用 `planColumnWidths` 自动算，并按 A4 横向收窄 */
  colWidths?: number[];
  /** 行高（磅）；`undefined` = 用默认行高 */
  rowHeights?: (number | undefined)[];
  /** 合并区域，例如 `["A1:F1"]` */
  merges?: string[];
  /** 冻结前 N 行 */
  freezeRows?: number;
  /** 每页重复打印的行，例如 `"1:3"` */
  printTitleRows?: string;
}

export interface XlsxBookSpec {
  sheets: XlsxSheet[];
  title?: string;
}

/** 列宽下限（字符宽） */
export const MIN_COL_WIDTH = 6;
/** 列宽上限（字符宽） */
export const MAX_COL_WIDTH = 60;
/** 1 个字符宽 ≈ 7px ≈ 0.185cm */
export const CHAR_WIDTH_CM = 0.185;
/** A4 横向可用宽度：29.7 − 0.3×2.54×2 ≈ 27.8cm */
export const A4_LANDSCAPE_CONTENT_WIDTH_CM = 27.8;
/** 默认行高（磅） */
const DEFAULT_ROW_HEIGHT = 15;
/** DocProps 的固定创建时间；ZIP 时间戳固定在 `zip.ts`，两处一起保证产物可复现 */
const FIXED_CREATED = "1980-01-01T00:00:00Z";

/* ------------------------------------------------------------------ */
/* 单元格 / 宽度                                                       */
/* ------------------------------------------------------------------ */

function cellValue(cell: XlsxCellInput): string | number {
  if (cell == null) return "";
  if (typeof cell === "object") return cell.value;
  return cell;
}

function cellStyle(cell: XlsxCellInput): XlsxStyleName | undefined {
  if (cell != null && typeof cell === "object") return cell.style;
  return undefined;
}

/** 是否是「宽字符」（CJK / 全角），列宽按 2 个字符算。 */
function isWideChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x11_00 && code <= 0x11_5f) ||
    (code >= 0x2e_80 && code <= 0xa4_cf) ||
    (code >= 0xac_00 && code <= 0xd7_a3) ||
    (code >= 0xf9_00 && code <= 0xfa_ff) ||
    (code >= 0xfe_30 && code <= 0xfe_6f) ||
    (code >= 0xff_00 && code <= 0xff_60) ||
    (code >= 0xff_e0 && code <= 0xff_e6)
  );
}

/** 文本的显示宽度：CJK 记 2，其它记 1，多行取最宽的一行。 */
function displayWidth(value: string | number): number {
  const text = String(value);
  if (text === "") return 0;
  let max = 0;
  for (const line of text.split("\n")) {
    let width = 0;
    for (const char of line) width += isWideChar(char) ? 2 : 1;
    if (width > max) max = width;
  }
  return max;
}

/** 列宽（字符）→ 厘米；A4 判断与列宽收窄都用这一个口径。 */
export function columnsWidthCm(widths: readonly number[]): number {
  return widths.reduce((sum, width) => sum + width, 0) * CHAR_WIDTH_CM;
}

/** 这张表（表头 + 正文）按内容算完列宽后，是否已经超出 A4 横向可用宽度。 */
export function exceedsA4Landscape(
  rows: XlsxCellInput[][],
  opts: { min?: number; availableWidthCm?: number } = {},
): boolean {
  const widths = planColumnWidths(rows, { min: opts.min ?? MIN_COL_WIDTH });
  return columnsWidthCm(widths) > (opts.availableWidthCm ?? A4_LANDSCAPE_CONTENT_WIDTH_CM);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * 按内容算列宽（字符宽）：取每列最宽单元格的显示宽度 + 2 余量，落在 `[min, max]`。
 *
 * 空行 / 空单元格不计入；整张表为空时返回空数组。
 */
export function planColumnWidths(
  rows: XlsxCellInput[][],
  opts: { min?: number; max?: number } = {},
): number[] {
  const min = opts.min ?? MIN_COL_WIDTH;
  const max = opts.max ?? MAX_COL_WIDTH;
  const widths: number[] = [];
  for (const row of rows) {
    for (let index = 0; index < row.length; index += 1) {
      const cell = row[index];
      if (cell == null) continue;
      const width = displayWidth(cellValue(cell));
      if (width > (widths[index] ?? 0)) widths[index] = width;
    }
  }
  return widths.map((width) => clamp(width + 2, min, max));
}

/**
 * 把算好的列宽按 A4 横向可用宽度（{@link A4_LANDSCAPE_CONTENT_WIDTH_CM}）等比收窄。
 *
 * 不超宽时原样返回（拷贝）；超宽时等比缩放，并保证每列不低于 `min(width, 6)`； 缩放后若因下限仍有超出，再从「高于下限」的列里按富余量分摊，尽量压进一页宽。
 */
export function fitToA4Landscape(widths: number[]): number[] {
  if (widths.length === 0) return [];
  const available = A4_LANDSCAPE_CONTENT_WIDTH_CM / CHAR_WIDTH_CM;
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (columnsWidthCm(widths) <= A4_LANDSCAPE_CONTENT_WIDTH_CM) return [...widths];

  const floors = widths.map((width) => Math.min(width, MIN_COL_WIDTH));
  if (columnsWidthCm(floors) >= A4_LANDSCAPE_CONTENT_WIDTH_CM) return [...floors];

  const factor = available / total;
  let scaled = widths.map((width, index) => Math.max(floors[index]!, width * factor));

  // 第二遍：把下限撑出来的超出量，从还有富余的列里按比例扣掉
  const excess = scaled.reduce((sum, width) => sum + width, 0) - available;
  if (excess > 0) {
    const slack = scaled.map((width, index) => width - floors[index]!);
    const slackTotal = slack.reduce((sum, value) => sum + value, 0);
    if (slackTotal > 0) {
      const shrink = Math.min(excess, slackTotal);
      scaled = scaled.map((width, index) =>
        Math.max(floors[index]!, width - shrink * (slack[index]! / slackTotal)),
      );
    }
  }

  // 向下取整到 2 位小数，确保总宽不会因为四舍五入又冒出去
  return scaled.map((width) => Math.floor(width * 100) / 100);
}

/* ------------------------------------------------------------------ */
/* OOXML                                                               */
/* ------------------------------------------------------------------ */

/** 样式名 → `cellXfs` 下标 */
const STYLE_INDEX: Record<XlsxStyleName, number> = {
  title: 1,
  subtitle: 2,
  meta: 3,
  header: 4,
  body: 5,
  note: 6,
};

const FONT_NAME = "等线";

/** 去掉 XML 1.0 不允许的控制字符（保留 tab / LF / CR）。 */
function stripControlChars(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) out += char;
  }
  return out;
}

function escapeXml(value: string): string {
  return stripControlChars(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function columnName(index: number): string {
  let value = index + 1;
  let out = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    value = Math.floor((value - 1) / 26);
  }
  return out;
}

function fontXml(size: number, bold: boolean, color: string): string {
  return `<font>${bold ? "<b/>" : ""}<sz val="${size}"/><color rgb="${color}"/><name val="${FONT_NAME}"/><charset val="134"/></font>`;
}

function borderSideXml(tag: string): string {
  return `<${tag} style="thin"><color rgb="FFBFBFBF"/></${tag}>`;
}

function borderXml(): string {
  return `<border>${borderSideXml("left")}${borderSideXml("right")}${borderSideXml("top")}${borderSideXml("bottom")}<diagonal/></border>`;
}

/** 7 档业务样式 + 1 档默认样式；颜色全部 rgb，字体统一「等线」。 */
function stylesXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<fonts count="6">',
    fontXml(11, false, "FF000000"),
    fontXml(16, true, "FF000000"),
    fontXml(12, true, "FF000000"),
    fontXml(9, false, "FF666666"),
    fontXml(11, true, "FF000000"),
    fontXml(11, false, "FF000000"),
    "</fonts>",
    '<fills count="3">',
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill>',
    "</fills>",
    '<borders count="2">',
    "<border><left/><right/><top/><bottom/><diagonal/></border>",
    borderXml(),
    "</borders>",
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    '<cellXfs count="7">',
    // 0 = 默认（未指定 style 的普通值）
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    // 1 = title：16pt 加粗居中
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>',
    // 2 = subtitle：12pt 加粗
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>',
    // 3 = meta：9pt 灰字左对齐（唯一左对齐的正文档）
    '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>',
    // 4 = header：11pt 加粗居中 + 浅灰填充 + 细边框
    '<xf numFmtId="0" fontId="4" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>',
    // 5 = body：11pt 居中 + 细边框（正文只有这一档，全部居中）
    '<xf numFmtId="0" fontId="5" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>',
    // 6 = note：9pt 灰字
    '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>',
    "</cellXfs>",
    '<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>',
    "</styleSheet>",
  ].join("");
}

function cellXml(ref: string, cell: XlsxCellInput): string {
  const style = cellStyle(cell);
  const styleAttr = style === undefined ? "" : ` s="${STYLE_INDEX[style]}"`;
  const value = cellValue(cell);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t>${escapeXml(String(value))}</t></is></c>`;
    return `<c r="${ref}"${styleAttr}><v>${value}</v></c>`;
  }
  if (value === "" && style === undefined) return "";
  if (value === "") return `<c r="${ref}"${styleAttr}/>`;
  return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function colsXml(widths: number[]): string {
  if (widths.length === 0) return "";
  const cols = widths
    .map(
      (width, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${Number(width.toFixed(2))}" customWidth="1"/>`,
    )
    .join("");
  return `<cols>${cols}</cols>`;
}

function sheetDataXml(sheet: XlsxSheet, rowCount: number): string {
  const out: string[] = [];
  for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex += 1) {
    const row = sheet.rows[rowIndex]!;
    const height = sheet.rowHeights?.[rowIndex];
    const heightAttr =
      height === undefined ? "" : ` ht="${Number(height.toFixed(2))}" customHeight="1"`;
    const cells: string[] = [];
    for (let colIndex = 0; colIndex < rowCount; colIndex += 1) {
      const cell = row[colIndex];
      if (cell == null) continue;
      const xml = cellXml(`${columnName(colIndex)}${rowIndex + 1}`, cell);
      if (xml !== "") cells.push(xml);
    }
    out.push(`<row r="${rowIndex + 1}"${heightAttr}>${cells.join("")}</row>`);
  }
  return `<sheetData>${out.join("")}</sheetData>`;
}

function sheetViewsXml(freezeRows = 0): string {
  if (freezeRows <= 0) return '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  const topLeft = `A${freezeRows + 1}`;
  return (
    '<sheetViews><sheetView workbookViewId="0">' +
    `<pane ySplit="${freezeRows}" topLeftCell="${topLeft}" activePane="bottomLeft" state="frozen"/>` +
    `<selection pane="bottomLeft" activeCell="${topLeft}" sqref="${topLeft}"/>` +
    "</sheetView></sheetViews>"
  );
}

/**
 * 一张工作表的 XML。
 *
 * 元素顺序严格按 OOXML：`sheetPr → dimension → sheetViews → sheetFormatPr → cols → sheetData → mergeCells →
 * printOptions → pageMargins → pageSetup`（顺序错 Excel 会报「文件已损坏」）。
 */
function sheetXml(sheet: XlsxSheet): string {
  const rowCount = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0);
  const colCount = Math.max(rowCount, sheet.colWidths?.length ?? 0, 1);
  const lastColumn = columnName(colCount - 1);
  const lastRow = Math.max(sheet.rows.length, 1);
  const widths =
    sheet.colWidths && sheet.colWidths.length > 0
      ? sheet.colWidths
      : fitToA4Landscape(planColumnWidths(sheet.rows));

  const merges = [...new Set((sheet.merges ?? []).filter((ref) => ref !== ""))];

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>',
    `<dimension ref="A1:${lastColumn}${lastRow}"/>`,
    sheetViewsXml(sheet.freezeRows),
    `<sheetFormatPr defaultRowHeight="${DEFAULT_ROW_HEIGHT}"/>`,
    colsXml(widths),
    sheetDataXml(sheet, colCount),
    merges.length > 0
      ? `<mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${escapeXml(ref)}"/>`).join("")}</mergeCells>`
      : "",
    '<printOptions horizontalCentered="1"/>',
    '<pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.3" footer="0.3"/>',
    '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>',
    "</worksheet>",
  ].join("");
}

function contentTypesXml(sheets: XlsxSheet[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    ...sheets.map(
      (_, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    ),
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    "</Types>",
  ].join("");
}

function rootRelsXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
    "</Relationships>",
  ].join("");
}

function coreXml(title: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `<dc:title>${escapeXml(title)}</dc:title>`,
    "<dc:creator>exam-seat</dc:creator>",
    "<cp:lastModifiedBy>exam-seat</cp:lastModifiedBy>",
    `<dcterms:created xsi:type="dcterms:W3CDTF">${FIXED_CREATED}</dcterms:created>`,
    "</cp:coreProperties>",
  ].join("");
}

/** 引号内的 sheet 名（内部单引号翻倍），用于 Print_Titles 的引用。 */
function quoteSheetName(name: string): string {
  return `'${name.replaceAll("'", "''")}'`;
}

function workbookXml(sheets: XlsxSheet[]): string {
  const sheetTags = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("");
  const definedNames = sheets
    .map((sheet, index) => {
      const rows = sheet.printTitleRows;
      if (rows === undefined || rows === "") return "";
      return `<definedName name="_xlnm.Print_Titles" localSheetId="${index}">${escapeXml(`${quoteSheetName(sheet.name)}!$${rows.replaceAll(":", ":$")}`)}</definedName>`;
    })
    .filter((xml) => xml !== "")
    .join("");
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<sheets>${sheetTags}</sheets>`,
    definedNames === "" ? "" : `<definedNames>${definedNames}</definedNames>`,
    "</workbook>",
  ].join("");
}

function workbookRelsXml(sheets: XlsxSheet[]): string {
  const sheetRels = sheets
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join("");
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    sheetRels,
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    "</Relationships>",
  ].join("");
}

const encoder = new TextEncoder();

function xmlBytes(value: string): Uint8Array {
  return encoder.encode(value);
}

/** Sheet 名规范化：非法字符换 `-`、截到 31 字符、重名加 `(2)`。 */
function normalizeSheetName(name: string, index: number, used: Set<string>): string {
  let base = name
    .replaceAll(/[[\]:*?/\\]/g, "-")
    .replaceAll("'", "’")
    .trim();
  if (base === "") base = `Sheet${index + 1}`;
  if (base.length > 31) base = base.slice(0, 31);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    const tail = `(${suffix})`;
    candidate = `${base.slice(0, 31 - tail.length)}${tail}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

/**
 * 生成一个 .xlsx 工作簿。
 *
 * - 列宽缺省 = `fitToA4Landscape(planColumnWidths(rows))`（内容自适应 + A4 横向一页宽）；
 * - 每张表固定 A4 横向、`fitToWidth=1`、页边距 0.3/0.3/0.4/0.4、水平居中；
 * - `freezeRows` / `printTitleRows` 会写进 sheetView 与 `definedNames`（每页重复表头）。
 *
 * 空 `sheets` 会兜底出一张空白表（Excel 不接受 0 张表的工作簿）。
 */
export function buildXlsx(book: XlsxBookSpec): Uint8Array {
  const source = book.sheets.length > 0 ? book.sheets : [{ name: "无安排", rows: [] }];
  const used = new Set<string>();
  const sheets: XlsxSheet[] = [];
  for (const [index, sheet] of source.entries()) {
    sheets.push({ ...sheet, name: normalizeSheetName(sheet.name, index, used) });
  }

  const files = [
    { name: "[Content_Types].xml", bytes: xmlBytes(contentTypesXml(sheets)) },
    { name: "_rels/.rels", bytes: xmlBytes(rootRelsXml()) },
    { name: "docProps/core.xml", bytes: xmlBytes(coreXml(book.title ?? "")) },
    { name: "xl/workbook.xml", bytes: xmlBytes(workbookXml(sheets)) },
    { name: "xl/_rels/workbook.xml.rels", bytes: xmlBytes(workbookRelsXml(sheets)) },
    { name: "xl/styles.xml", bytes: xmlBytes(stylesXml()) },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      bytes: xmlBytes(sheetXml(sheet)),
    })),
  ];
  return buildZip(files);
}
