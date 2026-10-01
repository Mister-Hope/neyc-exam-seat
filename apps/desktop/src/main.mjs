/**
 * 「考场排布」桌面版主进程。
 *
 * 为什么不用 `file://` 直接 loadFile： Chromium 把 `file://` 当成不透明来源，Vite 产物里的 **ES module Web Worker** （求解器
 * solver.worker.ts）会被拦（`Failed to construct 'Worker'`），求解直接不可用。 所以这里注册一个特权自定义协议 `app://bundle/…`，用
 * `protocol.handle` 从磁盘读文件， 让页面与 worker 都跑在同一个安全来源下。
 */
import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { BrowserWindow, Menu, app, protocol, session, shell } from "electron";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const log = (message) => process.stdout.write(`${message}\n`);
const logError = (message) => process.stderr.write(`${message}\n`);

/** 打包后：`resources/web`；开发时：`apps/desktop/web-dist`（由 `pnpm prepare-web` 生成）。 */
const WEB_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "web")
  : path.join(APP_DIR, "web-dist");

const SCHEME = "app";
const HOST = "bundle";
const ENTRY_URL = `${SCHEME}://${HOST}/index.html`;
const WINDOW_TITLE = "考场排布";

/** 读取 `--exam-seat-xxx=value` 形式的自有开关（不认识的 Chromium 开关原样忽略）。 */
function switchValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

/** 自动化烟雾测试模式：出错只打日志、不弹系统对话框（免得打断正在用电脑的人）。 环境变量与 `--exam-seat-smoke` 开关都认（`open --args` 启动时传不了环境变量）。 */
const SMOKE = process.env["EXAM_SEAT_SMOKE"] === "1" || process.argv.includes("--exam-seat-smoke");
/** 导出文件落盘目录；默认「下载」目录，自动化时用开关指定，避免污染老师的下载文件夹。 */
const DOWNLOAD_DIR =
  process.env["EXAM_SEAT_DOWNLOAD_DIR"] ??
  switchValue("exam-seat-download-dir") ??
  app.getPath("downloads");

log(
  `[exam-seat] 主进程启动 pid=${process.pid} packaged=${app.isPackaged} userData=${app.getPath("userData")}`,
);

if (SMOKE) {
  process.on("uncaughtException", (error) => {
    logError(`[exam-seat] 主进程未捕获异常：${error?.stack ?? error}`);
    app.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logError(`[exam-seat] 主进程未处理的 Promise 拒绝：${reason}`);
  });
}

/** 自定义协议必须在 app ready 之前登记特权，才能当成「安全 + 标准」来源（Worker / fetch 都依赖它）。 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function mimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * 把 `app://bundle/<相对路径>` 映射到 `WEB_ROOT` 下的文件。
 *
 * - 只允许 `WEB_ROOT` 内部的文件（`path.resolve` 后越界一律 403），避免自定义协议变成任意文件读取；
 * - 未知的**无扩展名**路径回落到 `index.html`（hash 路由本身不需要，但更稳）。
 */
async function handleAppRequest(request) {
  const url = new URL(request.url);
  if (url.host !== HOST) return new Response("Not Found", { status: 404 });

  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const filePath = path.resolve(WEB_ROOT, relative);
  if (filePath !== WEB_ROOT && !filePath.startsWith(`${WEB_ROOT}${path.sep}`)) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const body = await readFile(filePath);
    return new Response(body, {
      status: 200,
      headers: { "content-type": mimeType(filePath), "cache-control": "no-cache" },
    });
  } catch {
    if (path.extname(filePath) === "") {
      const fallback = await readFile(path.join(WEB_ROOT, "index.html"));
      return new Response(fallback, {
        status: 200,
        headers: { "content-type": MIME_TYPES[".html"] },
      });
    }
    return new Response("Not Found", { status: 404 });
  }
}

/** 把渲染进程的 console 原样转出来，便于本地/CI 抓 worker、协议类报错。 */
function forwardConsole(window) {
  window.webContents.on("console-message", (...args) => {
    const [, details] = args;
    // Electron 36+ 传 (event, details 对象)；旧签名是 (event, level, message, line, sourceId)
    if (details && typeof details === "object" && "message" in details) {
      log(
        `[renderer:${String(details.level)}] ${String(details.message)} (${details.sourceId ?? "?"}:${details.lineNumber ?? 0})`,
      );
      return;
    }
    log(`[renderer:${String(args[1])}] ${String(args[2])} (${String(args[4])}:${String(args[3])})`);
  });
  window.webContents.on("did-fail-load", (_event, code, description, url) => {
    logError(`[exam-seat] 页面加载失败 ${code} ${description} ${url}`);
  });
  window.webContents.on("render-process-gone", (_event, gone) => {
    logError(`[exam-seat] 渲染进程退出：${gone.reason}`);
  });
}

/** 导出 Excel 时不让系统弹「另存为」：直接落到 `DOWNLOAD_DIR`（默认「下载」目录）。 */
function configureDownloads() {
  const dir = DOWNLOAD_DIR;
  mkdirSync(dir, { recursive: true });
  session.defaultSession.on("will-download", (_event, item) => {
    const target = path.join(dir, item.getFilename());
    item.setSavePath(target);
    item.once("done", (_event, state) => {
      log(`[download] ${state} ${target}`);
    });
  });
  log(`[exam-seat] 下载目录 ${dir}`);
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    title: WINDOW_TITLE,
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // 页面里的 <title> 不允许覆盖窗口标题
  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(WINDOW_TITLE);
  });
  // 外链一律交给系统浏览器，不在应用内开新窗口
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  forwardConsole(window);
  window.once("ready-to-show", () => window.show());

  if (!existsSync(path.join(WEB_ROOT, "index.html"))) {
    logError(
      `[exam-seat] 找不到网页产物：${WEB_ROOT}/index.html。先跑 \`pnpm --filter @exam-seat/desktop prepare-web\`。`,
    );
  }
  log(`[exam-seat] 加载 ${ENTRY_URL}（web root: ${WEB_ROOT}）`);
  await window.loadURL(ENTRY_URL);
}

/** Ready 之后：注册自定义协议、下载目录与主窗口。 */
async function setupWindow() {
  try {
    log("[exam-seat] app ready");
    // 开发模式（非打包）Dock 上是 Electron 默认图标，这里换成自己的
    if (process.platform === "darwin" && !app.isPackaged) {
      const devIcon = path.join(APP_DIR, "build/icon.png");
      if (existsSync(devIcon)) app.dock?.setIcon(devIcon);
    }
    protocol.handle(SCHEME, handleAppRequest);
    configureDownloads();
    if (process.platform !== "darwin") Menu.setApplicationMenu(null);
    await createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  } catch (error) {
    logError(`[exam-seat] 启动失败：${error?.stack ?? error}`);
    app.exit(1);
  }
}

/**
 * 启动入口。**不要**在顶层 `await app.whenReady()`： main 是 ESM 时 Electron 会等模块求值结束才继续初始化，顶层 await 会和 ready
 * 互相等待（应用永远起不来）。
 */
function boot() {
  const isPrimaryInstance = app.requestSingleInstanceLock();
  log(`[exam-seat] 单实例锁：${isPrimaryInstance ? "已获得" : "未获得"}`);
  if (!isPrimaryInstance) {
    app.quit();
    return;
  }

  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  if (app.isReady()) void setupWindow();
  else app.once("ready", () => void setupWindow());
}

boot();
