import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { PlanResult, RoomSpec } from "@exam-seat/core";

import { buildPlanWorkbook, buildRoomSheets, readRoster } from "./index";
import type { ReadRosterOptions, RosterReadResult } from "./index";

/** Node 侧：直接读一个 .xlsx 名单文件。 */
export function readRosterFile(path: string, options?: ReadRosterOptions): RosterReadResult {
  return readRoster(readFileSync(resolve(path)), options);
}

export function writeBinaryFile(path: string, bytes: Uint8Array): string {
  const target = resolve(path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, bytes);
  return target;
}

export interface WritePlanOptions {
  outDir: string;
  /** 主文件名，默认「考场安排名单.xlsx」 */
  fileName?: string;
  /** 给了考场规格就额外生成「考场座位表.xlsx」 */
  rooms?: RoomSpec[];
  /** 是否额外写出 plan.json */
  writeJson?: boolean;
  /** 是否额外写出 job.json（调用方提供） */
  job?: unknown;
}

/** 把结果落盘，返回写出的文件路径列表。 */
export function writePlanFiles(result: PlanResult, options: WritePlanOptions): string[] {
  const outDir = resolve(options.outDir);
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];

  const mainName = options.fileName ?? "考场安排名单.xlsx";
  const mainPath = join(outDir, mainName);
  writeFileSync(mainPath, buildPlanWorkbook(result));
  written.push(mainPath);

  if (options.rooms && options.rooms.length > 0 && result.entries.length > 0) {
    const byId = new Map(options.rooms.map((r) => [r.id, r]));
    const sheetsPath = join(outDir, "考场座位表.xlsx");
    writeFileSync(
      sheetsPath,
      buildRoomSheets(result, (roomId) => {
        const room = byId.get(roomId);
        return room
          ? { rows: room.rows, cols: room.cols, name: room.name ?? room.id }
          : { rows: 1, cols: 1, name: roomId };
      }),
    );
    written.push(sheetsPath);
  }

  const planPath = join(outDir, "plan.json");
  writeFileSync(planPath, JSON.stringify(result, null, 2));
  written.push(planPath);

  if (options.writeJson && options.job) {
    const jobPath = join(outDir, "job.json");
    writeFileSync(jobPath, JSON.stringify(options.job, null, 2));
    written.push(jobPath);
  }

  return written;
}
