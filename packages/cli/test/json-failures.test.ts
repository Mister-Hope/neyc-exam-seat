import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EXIT_USAGE, main } from "../src/cli";

let restoreSpies: (() => void) | undefined;

/** 每个测试只装一次 spy（同一个测试里再 spyOn 会拿到同一个 spy，输出会串）。 */
function capture(): { stdout: () => string; stderr: () => string } {
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  restoreSpies = () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  };
  const text = (calls: readonly unknown[][]): string =>
    calls.map((call) => String(call[0])).join("");
  return {
    stdout: () => text(stdoutSpy.mock.calls),
    stderr: () => text(stderrSpy.mock.calls),
  };
}

function tempDir(): string {
  return mkdtempSync(nodePath.join(tmpdir(), "exam-seat-json-"));
}

/** 断言 stdout 恰好一个 JSON 对象，并返回解析结果。 */
function parseExactlyOne(stdout: string): {
  ok?: boolean;
  error?: { code?: string; message?: string };
} {
  const text = stdout.trim();
  expect(text.startsWith("{")).toBe(true);
  expect(text.endsWith("}")).toBe(true);
  expect(text.split(/\n(?=\{)/)).toHaveLength(1); // 只有一个顶层对象
  return JSON.parse(text) as { ok?: boolean; error?: { code?: string; message?: string } };
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("cli 失败输出（--json / 人类可读）", () => {
  afterEach(() => {
    restoreSpies?.();
    restoreSpies = undefined;
  });

  describe("--json 失败输出：stdout 必须是一个可解析的 JSON", () => {
    it("坏 JSON → INVALID_JSON（stdout 一个对象、stderr 只有一遍）", async () => {
      const dir = tempDir();
      try {
        const bad = nodePath.join(dir, "bad.json");
        writeFileSync(bad, "{");
        const captured = capture();
        const code = await main(["node", "exam-seat", "--json", "plan", "--job", bad]);

        expect(code).toBe(EXIT_USAGE);
        const payload = parseExactlyOne(captured.stdout());
        expect(payload.ok).toBe(false);
        expect(payload.error!.code).toBe("INVALID_JSON");
        expect(String(payload.error!.message)).toContain("不是合法 JSON");
        expect(countOf(captured.stderr(), "不是合法 JSON")).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("文件不存在 → FILE_NOT_FOUND", async () => {
      const captured = capture();
      const missing = nodePath.join(tempDir(), "nope.json");
      const code = await main(["node", "exam-seat", "--json", "plan", "--job", missing]);

      expect(code).toBe(EXIT_USAGE);
      const payload = parseExactlyOne(captured.stdout());
      expect(payload.ok).toBe(false);
      expect(payload.error!.code).toBe("FILE_NOT_FOUND");
      expect(String(payload.error!.message)).toContain("读不到 job 文件");
      expect(countOf(captured.stderr(), "读不到 job 文件")).toBe(1);
    });

    it("未知命令 → USAGE（错误只打一遍）", async () => {
      const captured = capture();
      const code = await main(["node", "exam-seat", "--json", "frobnicate"]);

      expect(code).toBe(EXIT_USAGE);
      const payload = parseExactlyOne(captured.stdout());
      expect(payload.ok).toBe(false);
      expect(payload.error!.code).toBe("USAGE");
      expect(payload.error!.message).toBe("unknown command 'frobnicate'");
      expect(countOf(captured.stderr(), "unknown command")).toBe(1);
    });

    it("缺必填参数 → USAGE（错误只打一遍）", async () => {
      const captured = capture();
      const code = await main(["node", "exam-seat", "--json", "plan"]);

      expect(code).toBe(EXIT_USAGE);
      const payload = parseExactlyOne(captured.stdout());
      expect(payload.ok).toBe(false);
      expect(payload.error!.code).toBe("USAGE");
      expect(payload.error!.message).toBe("required option '--job <file>' not specified");
      expect(countOf(captured.stderr(), "required option")).toBe(1);
    });
  });

  describe("非 --json 的人类输出保持不变", () => {
    it("坏 JSON：stdout 空，stderr 仍是原来的「exam-seat: …」一行", async () => {
      const dir = tempDir();
      try {
        const bad = nodePath.join(dir, "bad.json");
        writeFileSync(bad, "{");
        const captured = capture();
        const code = await main(["node", "exam-seat", "plan", "--job", bad]);

        expect(code).toBe(EXIT_USAGE);
        expect(captured.stdout()).toBe("");
        expect(captured.stderr().startsWith("exam-seat: job 文件不是合法 JSON：")).toBe(true);
        expect(captured.stderr().trim().split("\n")).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("未知命令：stderr 仍是 commander + exam-seat 两行（历史行为，未改）", async () => {
      const captured = capture();
      const code = await main(["node", "exam-seat", "frobnicate"]);

      expect(code).toBe(EXIT_USAGE);
      expect(captured.stdout()).toBe("");
      const lines = captured.stderr().trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe("error: unknown command 'frobnicate'");
      expect(lines[1]).toBe("exam-seat: error: unknown command 'frobnicate'");
    });

    it("缺参数：stderr 仍是 commander + exam-seat 两行（历史行为，未改）", async () => {
      const captured = capture();
      const code = await main(["node", "exam-seat", "plan"]);

      expect(code).toBe(EXIT_USAGE);
      expect(captured.stdout()).toBe("");
      const lines = captured.stderr().trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe("error: required option '--job <file>' not specified");
      expect(lines[1]).toBe("exam-seat: error: required option '--job <file>' not specified");
    });

    it("文件不存在：stdout 空，stderr 一行", async () => {
      const captured = capture();
      const code = await main([
        "node",
        "exam-seat",
        "plan",
        "--job",
        nodePath.join(tempDir(), "nope.json"),
      ]);

      expect(code).toBe(EXIT_USAGE);
      expect(captured.stdout()).toBe("");
      expect(captured.stderr().trim().split("\n")).toHaveLength(1);
      expect(captured.stderr()).toContain("读不到 job 文件");
    });
  });
});
