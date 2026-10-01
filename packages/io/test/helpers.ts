import { crc32 } from "node:zlib";

import * as XLSX from "xlsx";

import type { XlsxCellInput, XlsxSheet } from "../src/xlsx";

/** 一张 sheet 的纯值矩阵（把 `{ value, style }` 拆出来）。 */
export function sheetValues(sheet: XlsxSheet): (string | number)[][] {
  return sheet.rows.map((row) =>
    row.map((cell) => {
      if (cell == null) return "";
      if (typeof cell === "object") return cell.value;
      return cell;
    }),
  );
}

/** 单行取值 */
export function rowValues(row: XlsxCellInput[]): (string | number)[] {
  return row.map((cell) => {
    if (cell == null) return "";
    if (typeof cell === "object") return cell.value;
    return cell;
  });
}

/** 解一个 stored ZIP（写出器只用 method 0），并顺带用 node:zlib 的 crc32 校验。 */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06_05_4b_50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是合法 ZIP：找不到 EOCD");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = new Map<string, Uint8Array>();

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== 0x02_01_4b_50) {
      throw new Error(`第 ${index} 个中央目录项签名不对`);
    }
    const method = view.getUint16(offset + 10, true);
    const expectedCrc = view.getUint32(offset + 16, true);
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + size);

    if (method !== 0) throw new Error(`${name} 不是 stored（method=${method}）`);
    if (crc32(data) !== expectedCrc) throw new Error(`${name} CRC 对不上`);
    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 从 zip 里取一个文件的文本。 */
export function zipText(bytes: Uint8Array, name: string): string {
  const data = readZip(bytes).get(name);
  if (data === undefined) throw new Error(`zip 里没有 ${name}`);
  return new TextDecoder().decode(data);
}

/** SheetJS 读回某张表的 AOA（`raw: false`，数字变字符串），保留空行。 */
export function readAoa(bytes: Uint8Array, name?: string): (string | number)[][] {
  const workbook = XLSX.read(toArrayBuffer(bytes), { type: "array" });
  const sheetName = name ?? workbook.SheetNames[0]!;
  const sheet = workbook.Sheets[sheetName];
  if (sheet === undefined) throw new Error(`工作簿里没有 ${sheetName}`);
  return XLSX.utils.sheet_to_json<(string | number)[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: true,
  });
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
