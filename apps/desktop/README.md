# apps/desktop · 「考场排布」桌面版

Electron 外壳，加载 `packages/web` 的构建产物。**不属于**根 `pnpm verify` 的范围（在 `apps/*` 而不是
`packages/*`），所以日常验证与 CI 的 verify job 不会连带安装 / 打包 Electron。

## 为什么用 `app://` 而不是 `file://`

Vite 产物里求解器是 **ES module Web Worker**（`packages/web/src/workers/solver.worker.ts`）。
Chromium 把 `file://` 当成不透明来源，`new Worker()` 会被直接拦掉，求解不可用。
主进程因此注册特权协议 `app://bundle/…` 并用 `protocol.handle` 从 `resources/web` 读文件，
页面与 worker 跑在同一个安全来源下（`standard + secure + supportFetchAPI`）。

## 常用命令

```bash
# 安装（根目录）：electron 的二进制不会下载 —— pnpm-workspace.yaml 里 electron: false
pnpm install

# 1) 同步网页产物：packages/web 构建 + 拷贝到 apps/desktop/web-dist
pnpm --filter @exam-seat/desktop prepare-web

# 2) 打包（不签名）
HOME="$PWD/.cache/home" pnpm --filter @exam-seat/desktop build:mac            # dmg + zip
HOME="$PWD/.cache/home" pnpm --filter @exam-seat/desktop build:mac --dir      # 只要解包 .app，最快
HOME="$PWD/.cache/home" pnpm --filter @exam-seat/desktop build:mac --target zip
pnpm --filter @exam-seat/desktop build:win --target nsis                      # Windows 安装包

# 3) 端到端烟雾测试（会在屏幕上报一个窗口，跑完自动退出）
pnpm --filter @exam-seat/desktop smoke              # 普通机器
pnpm --filter @exam-seat/desktop smoke -- --no-sandbox   # 受限 shell 里 Chromium 起不了沙箱时
```

环境变量：

| 变量 / 开关                                                 | 作用                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| `EXAM_SEAT_VERSION` / `--version x.y.z`                     | 注入版本号（release workflow 从 tag 取）                               |
| `EXAM_SEAT_DOWNLOAD_DIR` / `--exam-seat-download-dir=<dir>` | 导出文件落盘目录（默认系统「下载」）                                   |
| `--exam-seat-smoke`                                         | 烟雾模式：未捕获异常只写日志 + 退出，不弹系统对话框                    |
| `--no-sandbox`                                              | **仅本地受限环境**用；不进任何打包配置，交付产物保持 Chromium 沙箱开启 |

## 目录

```
src/main.mjs            主进程：app:// 协议、窗口、下载落盘
scripts/prepare-web.mjs 同步 packages/web/dist → apps/desktop/web-dist
scripts/build.mjs       electron-builder 封装（版本注入 / 不签名 / --target）
scripts/smoke.mjs       CDP 驱动的端到端验收（协议 / 六步 / 真求解 / 导出）
build/icon.svg          图标源文件（icon.png / icon.icns / icon.ico 由它导出）
electron-builder.yml    打包配置（productName「考场排布」，产物名 exam-seat-desktop-…）
```

## 图标

`build/icon.svg` 是源文件；`icon.icns`（macOS）与 `icon.ico`（Windows）是导出产物，
`electron-builder.yml` 里的 `mac.icon` / `win.icon` 指向它们。改图标时重导这三个文件即可
（macOS 可用 `iconutil -c icns`，Windows 用任意 ico 导出工具）。
