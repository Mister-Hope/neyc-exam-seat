/**
 * 极小 ZIP 打包器（零依赖，只用 node:zlib 的 deflate）。
 *
 * 为什么不用 `zip` 命令 / archiver：打包脚本要在 mac（本地）与 ubuntu（CI bundle job）上都能跑， 还要产出**确定性**字节（同样的输入 → 同样的
 * zip），方便复现与校验。 用 STORE 之外的 deflate（method 8），文件名走 UTF-8（通用标志位 bit 11）。
 */
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1)
      value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

/** ZIP 里固定用 1980-01-01（DOS 纪元起点）：让产物字节可复现。 */
const DOS_TIME = 0;
const DOS_DATE = 33; // 1980-01-01

class Buffer32 {
  constructor() {
    this.parts = [];
    this.length = 0;
  }

  push(bytes) {
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  u16(value) {
    const buffer = Buffer.alloc(2);
    buffer.writeUInt16LE(value & 0xff_ff, 0);
    this.push(buffer);
  }

  u32(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value >>> 0, 0);
    this.push(buffer);
  }

  bytes() {
    return Buffer.concat(this.parts, this.length);
  }
}

/**
 * @param {{ name: string; bytes: Uint8Array }[]} files 包内路径（用 / 分隔）+ 文件字节
 * @returns {Uint8Array} ZIP 字节
 */
export function createZip(files) {
  const encoder = new TextEncoder();
  const local = new Buffer32();
  const central = new Buffer32();
  const offsets = [];

  for (const file of files) {
    if (file.name === "") throw new Error("createZip: 文件名不能为空");
    const nameBytes = encoder.encode(file.name);
    const raw = Buffer.from(file.bytes);
    const deflated = deflateRawSync(raw, { level: 9 });
    // 压不小就用 stored，别做无用功
    const stored = deflated.length >= raw.length;
    const payload = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(raw);

    offsets.push(local.length);
    local.u32(0x04_03_4b_50);
    local.u16(20);
    local.u16(0x08_00); // UTF-8 文件名
    local.u16(method);
    local.u16(DOS_TIME);
    local.u16(DOS_DATE);
    local.u32(crc);
    local.u32(payload.length);
    local.u32(raw.length);
    local.u16(nameBytes.length);
    local.u16(0);
    local.push(nameBytes);
    local.push(payload);
  }

  files.forEach((file, index) => {
    const nameBytes = encoder.encode(file.name);
    const raw = Buffer.from(file.bytes);
    const deflated = deflateRawSync(raw, { level: 9 });
    const stored = deflated.length >= raw.length;
    const payload = stored ? raw : deflated;

    central.u32(0x02_01_4b_50);
    central.u16(20); // version made by
    central.u16(20); // version needed
    central.u16(0x08_00);
    central.u16(stored ? 0 : 8);
    central.u16(DOS_TIME);
    central.u16(DOS_DATE);
    central.u32(crc32(raw));
    central.u32(payload.length);
    central.u32(raw.length);
    central.u16(nameBytes.length);
    central.u16(0); // extra
    central.u16(0); // comment
    central.u16(0); // disk
    central.u16(0); // internal attrs
    central.u32(0); // external attrs
    central.u32(offsets[index]);
    central.push(nameBytes);
  });

  const archive = new Buffer32();
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
  return new Uint8Array(archive.bytes());
}
