import { normalizeOptions } from "@exam-seat/core";
import type {
  ColRef,
  Constraint,
  Job,
  PlanOptions,
  RoomSpec,
  RowRef,
  Student,
} from "@exam-seat/core";

/**
 * Job.json 是 core / CLI / Web / AI 之间**唯一**的契约。
 *
 * 这里只做三件事：把界面上的草稿拼成 job、把 job 拆回草稿、以及进出 JSON 时的形状校验 （校验信息全是中文，直接展示给老师）。算法语义一律以 core 为准，本文件不复制任何规则。
 */
export const JOB_VERSION = 1;

export interface JobDraft {
  title: string;
  createdAt: string;
  students: Student[];
  rooms: RoomSpec[];
  constraints: Constraint[];
  options: PlanOptions;
}

export const DEFAULT_OPTIONS: Required<PlanOptions> = normalizeOptions();

export function createEmptyDraft(): JobDraft {
  return {
    title: "排考场",
    createdAt: new Date().toISOString(),
    students: [],
    rooms: [],
    constraints: [],
    options: { ...DEFAULT_OPTIONS },
  };
}

/** 草稿 → JOB（可交给 CLI / AI 的完整契约）。 */
export function buildJob(draft: JobDraft): Job {
  const options = normalizeOptions(draft.options);
  return {
    jobVersion: JOB_VERSION,
    meta: {
      title: draft.title,
      createdAt: draft.createdAt || new Date().toISOString(),
    },
    options,
    students: draft.students.map((s) => ({ ...s })),
    rooms: draft.rooms.map((r) => ({ ...r })),
    constraints: draft.constraints.map((c) => ({
      ...c,
      ...(c.studentIds ? { studentIds: [...c.studentIds] } : {}),
      ...(c.rows ? { rows: [...c.rows] } : {}),
      ...(c.cols ? { cols: [...c.cols] } : {}),
    })),
  };
}

/** JOB → 草稿（AI 生成的 job 导回网页时走这里，缺省项补默认值）。 */
export function draftFromJob(job: Job): JobDraft {
  return {
    title: job.meta?.title ?? "排考场",
    createdAt: job.meta?.createdAt ?? new Date().toISOString(),
    students: (job.students ?? []).map((s) => ({ ...s })),
    rooms: (job.rooms ?? []).map((r) => ({ ...r })),
    constraints: (job.constraints ?? []).map((c) => ({
      ...c,
      ...(c.studentIds ? { studentIds: [...c.studentIds] } : {}),
      ...(c.rows ? { rows: [...c.rows] } : {}),
      ...(c.cols ? { cols: [...c.cols] } : {}),
    })),
    options: { ...normalizeOptions(job.options) },
  };
}

export function serializeJob(job: Job): string {
  return `${JSON.stringify(job, null, 2)}\n`;
}

export function jobFileName(title: string | undefined, suffix = "job"): string {
  const base = (title ?? "").trim().replaceAll(/[\\/:*?"<>|\s]+/g, "_") || "exam-seat";
  return `${base}.${suffix}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${what}必须是非空字符串，实际是 ${JSON.stringify(value)}`);
  }
  return value;
}

function requireSize(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${what}必须是 ≥1 的整数，实际是 ${JSON.stringify(value)}`);
  }
  return value;
}

/** 解析并校验一份 job.json。任何形状问题都抛中文 Error， 页面直接把 `error.message` 显示出来即可，不必再翻译一遍。 */
export function parseJobText(text: string): Job {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  return parseJob(raw);
}

export function parseJob(raw: unknown): Job {
  if (!isRecord(raw)) throw new Error("job.json 的顶层必须是一个 JSON 对象");
  if (!Array.isArray(raw.students)) throw new Error("job.json 缺少 students 数组（学生名单）");
  if (!Array.isArray(raw.rooms)) throw new Error("job.json 缺少 rooms 数组（考场列表）");

  const students: Student[] = raw.students.map((item, i) => {
    if (!isRecord(item)) throw new Error(`students[${i}] 必须是对象`);
    const student: Student = {
      id: requireString(item.id, `students[${i}].id（学号）`),
      name: typeof item.name === "string" ? item.name : "",
      className: typeof item.className === "string" ? item.className : "",
    };
    if (typeof item.gender === "string") student.gender = item.gender;
    if (typeof item.included === "boolean") student.included = item.included;
    if (Array.isArray(item.tags)) student.tags = item.tags.map(String);
    if (isRecord(item.meta)) student.meta = item.meta;
    return student;
  });

  const rooms: RoomSpec[] = raw.rooms.map((item, i) => {
    if (!isRecord(item)) throw new Error(`rooms[${i}] 必须是对象`);
    const room: RoomSpec = {
      id: requireString(item.id, `rooms[${i}].id`),
      rows: requireSize(item.rows, `rooms[${i}].rows（排数）`),
      cols: requireSize(item.cols, `rooms[${i}].cols（列数）`),
    };
    if (typeof item.name === "string") room.name = item.name;
    if (item.doorSide === "left" || item.doorSide === "right") room.doorSide = item.doorSide;
    if (typeof item.note === "string") room.note = item.note;
    return room;
  });

  const constraints: Constraint[] = [];
  if (raw.constraints !== undefined) {
    if (!Array.isArray(raw.constraints)) throw new Error("job.json 的 constraints 必须是数组");
    raw.constraints.forEach((item, i) => {
      if (!isRecord(item)) throw new Error(`constraints[${i}] 必须是对象`);
      const constraint: Constraint = {
        id: requireString(item.id, `constraints[${i}].id`),
        studentIds: Array.isArray(item.studentIds) ? item.studentIds.map(String) : [],
      };
      if (typeof item.note === "string") constraint.note = item.note;
      if (typeof item.roomId === "string" && item.roomId.length > 0)
        constraint.roomId = item.roomId;
      const rows = normalizeRefs(item.rows, "row");
      if (rows) constraint.rows = rows as RowRef[];
      const cols = normalizeRefs(item.cols, "col");
      if (cols) constraint.cols = cols as ColRef[];
      constraints.push(constraint);
    });
  }

  const options = isRecord(raw.options) ? (raw.options as PlanOptions) : undefined;

  return {
    jobVersion: typeof raw.jobVersion === "number" ? raw.jobVersion : JOB_VERSION,
    meta: isRecord(raw.meta)
      ? {
          title: typeof raw.meta.title === "string" ? raw.meta.title : undefined,
          createdAt: typeof raw.meta.createdAt === "string" ? raw.meta.createdAt : undefined,
        }
      : undefined,
    options,
    students,
    rooms,
    constraints,
  };
}

function normalizeRefs(value: unknown, axis: "row" | "col"): (string | number)[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error(`constraints 里的 ${axis}s 必须是数组`);
  const allowed = axis === "row" ? ["first", "last"] : ["door", "window"];
  return value.map((ref) => {
    if (typeof ref === "number" && Number.isInteger(ref) && ref >= 1) return ref;
    if (typeof ref === "string" && allowed.includes(ref)) return ref;
    throw new Error(`${axis}s 里的取值不合法：${JSON.stringify(ref)}`);
  });
}
