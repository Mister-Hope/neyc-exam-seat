/**
 * 零依赖的极小 ZIP 打包器（stored + CRC32 + UTF-8 文件名），浏览器 / Node 通用。
 *
 * 不用压缩：xlsx 里主要是 XML，先不管体积；stored 被 Excel / LibreOffice 接受。 刻意不碰 `node:zlib`，这样 `@exam-seat/io`
 * 的写出器在浏览器里也能跑。
 */

/** ZIP 里的固定时间戳（1980-01-01），保证产物可复现 */
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE = 33;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

class ByteBuffer {
  private readonly parts: Uint8Array[] = [];
  private readonly encoder = new TextEncoder();
  private size = 0;

  get length(): number {
    return this.size;
  }

  push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.size += bytes.length;
  }

  u16(value: number): void {
    this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
  }

  u32(value: number): void {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    this.push(bytes);
  }

  text(value: string): void {
    this.push(this.encoder.encode(value));
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
}

/** 打一个 ZIP 包（全部 stored、UTF-8 文件名）。 */
export function buildZip(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const local = new ByteBuffer();
  const central = new ByteBuffer();
  const offsets: number[] = [];

  for (const file of files) {
    if (file.name === "") throw new Error("buildZip: 文件名不能为空");
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(file.bytes);
    const size = file.bytes.length;
    offsets.push(local.length);

    local.u32(0x04_03_4b_50);
    local.u16(20);
    local.u16(0x08_00); // UTF-8 文件名
    local.u16(0); // stored
    local.u16(ZIP_DOS_TIME);
    local.u16(ZIP_DOS_DATE);
    local.u32(crc);
    local.u32(size);
    local.u32(size);
    local.u16(nameBytes.length);
    local.u16(0);
    local.push(nameBytes);
    local.push(file.bytes);
  }

  for (const [index, file] of files.entries()) {
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(file.bytes);
    const size = file.bytes.length;

    central.u32(0x02_01_4b_50);
    central.u16(20); // version made by
    central.u16(20); // version needed
    central.u16(0x08_00);
    central.u16(0);
    central.u16(ZIP_DOS_TIME);
    central.u16(ZIP_DOS_DATE);
    central.u32(crc);
    central.u32(size);
    central.u32(size);
    central.u16(nameBytes.length);
    central.u16(0); // extra
    central.u16(0); // comment
    central.u16(0); // disk
    central.u16(0); // internal attrs
    central.u32(0); // external attrs
    central.u32(offsets[index]!);
    central.push(nameBytes);
  }

  const archive = new ByteBuffer();
  archive.push(local.bytes());
  const centralOffset = archive.length;
  archive.push(central.bytes());
  archive.u32(0x06_05_4b_50);
  archive.u16(0);
  archive.u16(0);
  archive.u16(files.length);
  archive.u16(files.length);
  archive.u32(central.length);
  archive.u32(centralOffset);
  archive.u16(0);
  return archive.bytes();
}
