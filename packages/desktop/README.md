# packages/desktop · 「考场排布」桌面版

Electron 外壳，加载 `packages/web` 的构建产物。**不属于**根 `pnpm verify` 的构建 / 类型检查范围
（根 `build` 与 `typecheck` 用 `--filter '!./packages/desktop'` 显式排除），所以日常验证与 CI 的
verify job 不会连带安装 / 打包 Electron。

不过它的**类型**仍然有门禁：`pnpm typecheck:desktop`（`tsc --checkJs`，见 `tsconfig.json`），
CI 里单独跑一步（纯 `tsc`，不需要 Electron 二进制）；单测用 `pnpm --filter @exam-seat/desktop test`。

## 为什么用 `app://` 而不是 `file://`

Vite 产物里求解器是 **ES module Web Worker**（`packages/web/src/workers/solver.worker.ts`）。
Chromium 把 `file://` 当成不透明来源，`new Worker()` 会被直接拦掉，求解不可用。
主进程因此注册特权协议 `app://bundle/…` 并用 `protocol.handle` 从 `resources/web` 读文件，
页面与 worker 跑在同一个安全来源下（`standard + secure + supportFetchAPI`）。

## 常用命令

```bash
# 安装（根目录）：electron 的二进制不会下载 —— pnpm-workspace.yaml 里 electron: false
pnpm install

# 1) 同步网页产物：packages/web 构建 + 拷贝到 packages/desktop/web-dist
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
src/main.mjs            主进程：app:// 协议（含 CSP）、窗口、导航拦截、下载落盘
src/download-path.mjs   下载去重的纯逻辑（`nextAvailablePath`，可单测）
test/download-dedup.test.mjs  下载去重单测（`node --test`）
scripts/prepare-web.mjs 同步 packages/web/dist → packages/desktop/web-dist
scripts/build.mjs       electron-builder 封装（版本注入 / 不签名 / --target）
scripts/smoke.mjs       CDP 驱动的端到端验收（协议 / 六步 / 真求解 / 导出）
build/icon.svg          图标源文件（icon.png / icon.icns / icon.ico 由它导出）
electron-builder.yml    打包配置（productName「考场排布」，产物名 exam-seat-desktop-…）
```

## 首次打开的放行步骤（未签名产物）

产物**不做代码签名 / 公证**（没有开发者证书），所以两个系统都会拦一下——这是预期行为，不是文件坏了：

**macOS（Gatekeeper）**

- 双击若提示「无法打开，因为 Apple 无法检查其是否包含恶意软件」：到「访达」里**右键（或 Control + 点击）图标 → 打开**，
  在弹窗里再点一次「打开」即可（此后该应用不再询问）；
- 若已被系统隔离、右键打开仍不放行，去掉隔离属性再开：

  ```bash
  xattr -dr com.apple.quarantine /Applications/考场排布.app     # 或 dmg 里拖出来的路径
  ```

- 仍然提示损坏时，先在「系统设置 → 隐私与安全性」里点「仍要打开」，再重试。

**Windows（SmartScreen）**

- 运行安装包或 exe 时出现蓝色「Windows 已保护你的电脑」：点「**更多信息**」→「**仍要运行**」；
- 若被浏览器标记（Edge 下载栏显示「不常下载」），在下载项上选「保留」即可。

> 想彻底免掉这些提示，需要购买代码签名证书并做公证（macOS 还要 notarization）——属于发布流程的后续工作。

## 图标

`build/icon.svg` 是源文件；`icon.icns`（macOS）与 `icon.ico`（Windows）是导出产物，
`electron-builder.yml` 里的 `mac.icon` / `win.icon` 指向它们。改图标时重导这三个文件即可
（macOS 可用 `iconutil -c icns`，Windows 用任意 ico 导出工具）。
