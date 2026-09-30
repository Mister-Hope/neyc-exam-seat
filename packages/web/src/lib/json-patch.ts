import type { JsonPatchOp } from "@exam-seat/core";

/**
 * 最小实现的 JSON Patch（RFC 6902 的 add / remove / replace 三种操作）。
 *
 * 为什么自己写：core 的 `Diagnostic.suggestions[].patch` 就是这三种操作， Web 要能「一键应用 AI / 预检给出的补丁再重跑」，而不引额外依赖。
 * 约定被修补的文档是纯 JSON（job.json 契约本来就只含 JSON 值）。
 */

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 把一段字符串转义成 JSON Pointer 的单个 token（`~` → `~0`，`/` → `~1`）。 */
export function escapeToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** JSON Pointer token 反转义。 */
export function unescapeToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** 拼一个 JSON Pointer，数字 token 用于数组下标。 */
export function pointer(...tokens: (string | number)[]): string {
  return `/${tokens.map((t) => escapeToken(String(t))).join("/")}`;
}

function parsePointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) {
    throw new Error(`JSON Pointer 必须以 / 开头，收到的是「${path}」`);
  }
  return path.split("/").slice(1).map(unescapeToken);
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === "object" && value != null;
}

function readChild(container: unknown, token: string, path: string): unknown {
  if (Array.isArray(container)) {
    const index = Number(token);
    if (!Number.isInteger(index) || index < 0 || index >= container.length) {
      throw new Error(`JSON Patch 找不到路径「${path}」`);
    }
    return container[index];
  }
  if (isContainer(container)) {
    const record = container as Record<string, unknown>;
    if (!(token in record)) throw new Error(`JSON Patch 找不到路径「${path}」`);
    return record[token];
  }
  throw new Error(`JSON Patch 找不到路径「${path}」`);
}

function applyOp(target: unknown, token: string, op: JsonPatchOp): void {
  if (Array.isArray(target)) {
    if (token === "-" && op.op === "add") {
      target.push(clone(op.value));
      return;
    }
    const index = Number(token);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`JSON Patch 的数组下标不合法：「${op.path}」`);
    }
    if (op.op === "add") {
      if (index > target.length) throw new Error(`JSON Patch 的数组下标越界：「${op.path}」`);
      target.splice(index, 0, clone(op.value));
      return;
    }
    if (index >= target.length) throw new Error(`JSON Patch 的数组下标越界：「${op.path}」`);
    if (op.op === "replace") target[index] = clone(op.value);
    else target.splice(index, 1);
    return;
  }

  if (isContainer(target)) {
    const record = target as Record<string, unknown>;
    if (op.op === "remove") {
      if (!(token in record)) throw new Error(`JSON Patch 要删除的字段不存在：「${op.path}」`);
      delete record[token];
      return;
    }
    if (op.op === "replace" && !(token in record)) {
      throw new Error(`JSON Patch 要替换的字段不存在：「${op.path}」`);
    }
    record[token] = clone(op.value);
    return;
  }

  throw new Error(`JSON Patch 无法在「${op.path}」上操作：目标不是对象或数组`);
}

/** 应用一组 JSON Patch 操作，返回新文档（不改原文档）。 任何一步失败都会抛出中文错误，调用方可以原样展示给老师。 */
export function applyJsonPatch<T>(doc: T, ops: readonly JsonPatchOp[]): T {
  let root: unknown = clone(doc);
  for (const op of ops) {
    const tokens = parsePointer(op.path);
    if (tokens.length === 0) {
      if (op.op === "remove") throw new Error("JSON Patch 不支持删除整个文档");
      root = clone(op.value);
      continue;
    }
    let parent: unknown = root;
    for (let i = 0; i < tokens.length - 1; i += 1) {
      parent = readChild(parent, tokens[i]!, op.path);
    }
    applyOp(parent, tokens[tokens.length - 1]!, op);
  }
  return root as T;
}

/** 依次应用多条建议里的 patch，收集失败信息（一条失败不影响其它条）。 */
export function tryApplyPatches<T>(
  doc: T,
  patches: readonly (readonly JsonPatchOp[])[],
): { doc: T; errors: string[] } {
  let current = doc;
  const errors: string[] = [];
  for (const patch of patches) {
    try {
      current = applyJsonPatch(current, patch);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { doc: current, errors };
}
