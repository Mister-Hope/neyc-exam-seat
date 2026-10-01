/* oxlint-disable no-await-in-loop -- 等待页面/CDP 就绪必须按顺序轮询，并发没有意义 */
/**
 * 桌面版端到端烟雾测试（本地 / CI 都能跑）。
 *
 * 用 CDP（`--remote-debugging-port`）驱动打包好的应用，验证四件事： ① 页面通过 `app://bundle/` 协议正常加载（不是 file://）； ②
 * 六个步骤页都能渲染； ③ **真跑一次求解**：既点界面的「开始排考场」，也直接构造模块 Worker 走一遍求解协议； ④ 导出 Excel / ZIP 真的落盘，且产物是合法工作簿。
 *
 * 用法： node scripts/smoke.mjs [--app <可执行文件>] [--port 9333] [--download-dir /tmp/xxx] [--out
 * smoke-out] [--no-sandbox] # 受限 shell（无法创建 Chromium 沙箱）里跑时加
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const REPO_ROOT = path.resolve(APP_DIR, "../..");
// 注意：**不要**把这个绑定命名为 `require` —— TS 6.0 在 `checkJs` + `noUnusedLocals` 下
// 会把名为 `require` 的 `createRequire` 绑定误判成「声明未使用」（TS6133）。改名即可规避。
const requireFromRepo = createRequire(path.join(REPO_ROOT, "package.json"));

/** @param {unknown} message 要写进 stdout 的内容 */
const log = (message) => process.stdout.write(`${message}\n`);
/** @param {unknown} message 要写进 stderr 的内容 */
const logError = (message) => process.stderr.write(`${message}\n`);

const STEPS = [
  { hash: "#/import", marker: "载入示例名单" },
  { hash: "#/exclude", marker: "排除缺考" },
  { hash: "#/rooms", marker: "配置考场" },
  { hash: "#/constraints", marker: "限定规则" },
  { hash: "#/solve", marker: "开始排考场" },
];

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const PORT = Number(arg("port", "9333"));
const DOWNLOAD_DIR = path.resolve(arg("download-dir", `/tmp/exam-seat-smoke/${Date.now()}`));
const OUT_DIR = path.resolve(APP_DIR, arg("out", "smoke-out"));
const NO_SANDBOX = process.argv.includes("--no-sandbox");
const APP_PATH = arg("app", path.join(APP_DIR, "release/mac-arm64/考场排布.app"));

/**
 * 已完成步骤（失败时回显用）。
 *
 * @type {string[]}
 */
const steps = [];

/** @param {string} message 步骤名 */
function heading(message) {
  steps.push(message);
  log(`\n▶ ${message}`);
}
/** @param {string} message 通过的说明 */
const pass = (message) => log(`  ✅ ${message}`);
/** @param {string} message 附加说明 */
const info = (message) => log(`  · ${message}`);
/** @param {number} ms 等待毫秒数 */
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function resolveExecutable(appPath) {
  const resolved = path.resolve(appPath);
  if (!existsSync(resolved)) throw new Error(`找不到应用：${resolved}（先跑 build:mac）`);
  if (resolved.endsWith(".app")) {
    const mac = path.join(resolved, "Contents/MacOS", path.basename(resolved, ".app"));
    if (!existsSync(mac)) throw new Error(`找不到可执行文件：${mac}`);
    return mac;
  }
  return resolved;
}

/**
 * @returns {Promise<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>} 第一个 app://
 *   页面目标
 */
async function waitForPageTarget(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "还没拿到调试端口";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      // CDP 的 /json/list 返回的是外部 JSON（`response.json()` 类型是 unknown），
      // 这里显式收窄成我们真正用到的三个字段；字段缺失时下面的可选链会兜住。
      /** @type {{ type?: string; url?: string; webSocketDebuggerUrl?: string }[]} */
      const targets = /** @type {any} */ (await response.json());
      const page = targets.find((item) => item.type === "page" && item.url?.startsWith("app://"));
      if (page) return page;
      lastError = `目标列表里没有 app:// 页面：${targets.map((item) => item.url).join(", ")}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(300);
  }
  throw new Error(`等待页面超时：${lastError}`);
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (!entry) return;
        if (message.error) entry.reject(new Error(`${message.error.message} (${entry.method})`));
        else entry.resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP 连接失败")), { once: true });
    });
    return new Cdp(socket);
  }

  on(handler) {
    this.listeners.push(handler);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP 超时：${method}`));
      }, 180_000);
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`页面执行出错：${detail}`);
  }
  return result.result.value;
}

async function waitFor(cdp, expression, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, `Boolean(${expression})`)) return;
    await sleep(250);
  }
  const preview = await evaluate(cdp, "document.body.innerText.slice(0, 400)");
  throw new Error(`等待「${label}」超时。当前页面文本：${preview}`);
}

const clickButton = (text) =>
  `(() => {
    const buttons = [...document.querySelectorAll("button")];
    // 先找文案完全相等的（例如弹窗里的「导入」），避免误点「导入排布状态」这种包含匹配
    const target =
      buttons.find((button) => (button.textContent ?? "").trim() === ${JSON.stringify(text)}) ??
      buttons.find((button) => (button.textContent ?? "").includes(${JSON.stringify(text)}));
    if (!target) return false;
    target.click();
    return true;
  })()`;

async function screenshot(cdp, name) {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT_DIR, `${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  info(`截图：${path.relative(REPO_ROOT, file)}`);
}

async function runSmoke() {
  const executable = resolveExecutable(APP_PATH);
  rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const appArgs = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT_DIR, "user-data")}`,
    "--exam-seat-smoke",
  ];
  // 只在本地自动化时加：受限 shell 里 Chromium 起不了自己的沙箱，打包产物默认不带这个开关
  if (NO_SANDBOX) appArgs.push("--no-sandbox");

  log(`▶ 启动桌面版：${path.relative(REPO_ROOT, executable)}`);
  // 某些开发壳（含本机 harness）会带着 ELECTRON_RUN_AS_NODE=1：那样 Electron 会当普通 Node 跑；
  // NODE_OPTIONS 在**打包后的** Electron 里会直接致命退出。两个都摘掉。
  // 声明成「字符串字典」：process.env 里这两个键本来就可能不存在，
  // 而我们要主动删掉它们，所以类型上必须允许任意键存在。
  /** @type {Record<string, string | undefined>} */
  const appEnv = { ...process.env, EXAM_SEAT_DOWNLOAD_DIR: DOWNLOAD_DIR, EXAM_SEAT_SMOKE: "1" };
  delete appEnv.ELECTRON_RUN_AS_NODE;
  delete appEnv.NODE_OPTIONS;
  const child = spawn(executable, appArgs, { env: appEnv, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => log(`  [app] ${String(chunk).trimEnd()}`));
  child.stderr.on("data", (chunk) => log(`  [app:err] ${String(chunk).trimEnd()}`));

  let cdp;
  /** @type {string[]} */
  const consoleErrors = [];
  try {
    const target = await waitForPageTarget();
    if (target.webSocketDebuggerUrl === undefined)
      throw new Error("CDP 目标缺少 webSocketDebuggerUrl，无法连接");
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    cdp.on((message) => {
      if (message.method === "Runtime.exceptionThrown") {
        consoleErrors.push(
          message.params.exceptionDetails?.exception?.description ??
            message.params.exceptionDetails?.text ??
            "unknown exception",
        );
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        consoleErrors.push(
          message.params.args.map((item) => item.value ?? item.description ?? "").join(" "),
        );
      }
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    heading("① 校验 app:// 协议与页面加载");
    await waitFor(cdp, `document.readyState === "complete"`, "页面加载完成");
    const origin = await evaluate(cdp, "({ protocol: location.protocol, href: location.href })");
    if (origin.protocol !== "app:") throw new Error(`协议不对：${origin.protocol}`);
    pass(`页面来源 ${origin.href}`);
    await waitFor(cdp, `document.body.innerText.includes("导入名单")`, "应用外壳渲染");
    pass("应用外壳已渲染");

    heading("② 逐个渲染六个步骤页");
    for (const item of STEPS) {
      await evaluate(cdp, `location.hash = ${JSON.stringify(item.hash)}`);
      await waitFor(
        cdp,
        `document.body.innerText.includes(${JSON.stringify(item.marker)})`,
        item.hash,
      );
      pass(`${item.hash} 渲染正常`);
    }
    await evaluate(cdp, "location.hash = '#/import'");
    await waitFor(cdp, `document.body.innerText.includes("载入示例名单")`, "回到导入页");
    await screenshot(cdp, "01-import");

    heading("③ 导入 examples/job.sample.json 并真跑一次求解");
    const sampleJob = readFileSync(path.join(REPO_ROOT, "examples/job.sample.json"), "utf8");
    await evaluate(cdp, clickButton("粘贴导入"));
    await waitFor(cdp, `!!document.querySelector("textarea")`, "粘贴弹窗");
    await evaluate(
      cdp,
      `(() => {
        const textarea = document.querySelector("textarea");
        textarea.value = ${JSON.stringify(sampleJob)};
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`,
    );
    await sleep(200);
    await evaluate(cdp, clickButton("导入"));
    await waitFor(
      cdp,
      `document.body.innerText.includes("排布状态已导入")`,
      "排布状态导入成功",
      30_000,
    );
    pass("job.sample.json 导入成功（名单 / 考场 / 限定都进 store）");

    await evaluate(cdp, "location.hash = '#/solve'");
    await waitFor(cdp, `!!document.querySelector('[data-testid="solve"]')`, "求解按钮");
    const solveDisabled = await evaluate(
      cdp,
      `document.querySelector('[data-testid="solve"]').disabled`,
    );
    if (solveDisabled) throw new Error("求解按钮被禁用：预检判了 fatal");
    await evaluate(cdp, `document.querySelector('[data-testid="solve"]').click()`);
    await waitFor(
      cdp,
      `document.body.innerText.includes("查看结果名单")`,
      "求解完成（出现「查看结果名单」）",
      300_000,
    );
    pass("界面求解完成（走的就是模块 Worker）");
    await screenshot(cdp, "02-solved");

    heading("③b 直接构造模块 Worker 验证求解协议");
    const workerFile = readdirSync(path.join(APP_DIR, "web-dist/assets")).find((name) =>
      /^solver\.worker-.*\.js$/.test(name),
    );
    if (!workerFile) throw new Error("web-dist/assets 里找不到 solver.worker-*.js");
    await evaluate(cdp, `window.__smokeJob = ${sampleJob}`);
    const workerResult = await evaluate(
      cdp,
      `(async () => {
        const worker = new Worker(new URL("assets/${workerFile}", location.href), { type: "module" });
        const done = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("worker 120s 无响应")), 120_000);
          worker.onerror = (event) => {
            clearTimeout(timer);
            reject(new Error("worker 加载/执行失败：" + (event.message || "unknown")));
          };
          worker.onmessage = (event) => {
            const data = event.data;
            if (data?.type === "done") {
              clearTimeout(timer);
              resolve(data);
            } else if (data?.type === "error") {
              clearTimeout(timer);
              reject(new Error("求解器返回错误：" + data.message));
            }
          };
          worker.postMessage({ id: 1, job: window.__smokeJob, mode: "all" });
        });
        worker.terminate();
        return {
          mode: done.mode,
          ok: done.result.ok,
          seatings: done.result.seatings?.length ?? 0,
          students: done.result.byStudent?.length ?? 0,
        };
      })()`,
    );
    pass(
      `worker（assets/${workerFile}）返回：mode=${workerResult.mode} ok=${workerResult.ok} 座位方案=${workerResult.seatings} 考生=${workerResult.students}`,
    );

    heading("④ 结果页导出 Excel / ZIP");
    await evaluate(cdp, "location.hash = '#/result'");
    await waitFor(
      cdp,
      `document.body.innerText.includes("导出 按班级考场安排.xlsx")`,
      "结果页导出按钮",
    );
    await screenshot(cdp, "03-result");

    for (const button of ["导出 按班级考场安排.xlsx", "下载分班文件（ZIP）"]) {
      await evaluate(cdp, clickButton(button));
      await sleep(500);
      // 结果有冲突时会弹二次确认，点「仍然导出」
      await evaluate(cdp, clickButton("仍然导出"));
      const expectedExt = button.includes("ZIP") ? ".zip" : ".xlsx";
      const deadline = Date.now() + 30_000;
      let files = [];
      while (Date.now() < deadline) {
        files = readdirSync(DOWNLOAD_DIR).filter((name) => name.endsWith(expectedExt));
        if (files.length > 0) break;
        await sleep(300);
      }
      if (files.length === 0) throw new Error(`点击「${button}」后没有落盘 ${expectedExt}`);
      pass(`下载成功：${files.join("、")}`);
    }
  } finally {
    cdp?.close();
    child.kill("SIGTERM");
    await sleep(500);
    if (!child.killed) child.kill("SIGKILL");
  }

  heading("⑤ 校验产物与日志");
  const XLSX = requireFromRepo("xlsx");
  const xlsxFile = readdirSync(DOWNLOAD_DIR).find((name) => name.endsWith(".xlsx"));
  if (xlsxFile === undefined) throw new Error(`下载目录里没有 .xlsx：${DOWNLOAD_DIR}`);
  const book = XLSX.read(readFileSync(path.join(DOWNLOAD_DIR, xlsxFile)), { type: "buffer" });
  if (book.SheetNames.length === 0) throw new Error("导出的 xlsx 没有工作表");
  pass(
    `xlsx 可读：${xlsxFile} → ${book.SheetNames.length} 张表（${book.SheetNames.slice(0, 3).join(" / ")}…）`,
  );

  const zipFile = readdirSync(DOWNLOAD_DIR).find((name) => name.endsWith(".zip"));
  if (zipFile === undefined) throw new Error(`下载目录里没有 .zip：${DOWNLOAD_DIR}`);
  const zipBytes = readFileSync(path.join(DOWNLOAD_DIR, zipFile));
  if (zipBytes[0] !== 0x50 || zipBytes[1] !== 0x4b) throw new Error("导出的 ZIP 头不对");
  pass(`zip 可读：${zipFile}（${(zipBytes.length / 1024).toFixed(0)} KB）`);

  const workerErrors = consoleErrors.filter((message) => /worker|protocol|app:\/\//i.test(message));
  if (workerErrors.length > 0)
    throw new Error(`控制台出现 worker/协议错误：${workerErrors.join(" | ")}`);
  pass(`控制台无 worker / 协议报错（其它 console.error ${consoleErrors.length} 条）`);

  log("\n════════════════════════════════════════");
  log("✅ 桌面版烟雾测试通过");
  log(`  下载目录：${DOWNLOAD_DIR}`);
  log(`  截图目录：${OUT_DIR}`);
  log("════════════════════════════════════════");
}

try {
  await runSmoke();
} catch (error) {
  logError(`\n❌ 桌面版烟雾测试失败：${error instanceof Error ? error.message : String(error)}`);
  logError(`已完成步骤：\n${steps.map((item) => `  - ${item}`).join("\n")}`);
  process.exitCode = 1;
}
