# exam-seat · 排考场工具

把学生名单和老师的排座要求，排成一份「哪个班的哪个学生坐第几考场多少号」的名单。

- **硬约束**：每个学生周围 8 个人不能同班（单人独桌）。班级数少于 9 个时自动退化为「前后左右不能同班」，并明确提示。
- **限定**：可以点名要求某学生去哪个考场、坐第几排、坐第几列，也可以把 4 个学生放进同一个考场的 4 个角。
- **排不出来就说清楚**：给出「为什么排不出来 + 怎么放宽」，每条建议都能一键应用。
- **两种用法**：老师自己在网页上点，或者把需求口述给 AI 让它调命令行。

## 快速开始

```bash
pnpm install
pnpm build          # 构建 core / io / cli
pnpm test           # 27 个单测
```

### 命令行

```bash
# 1) 读一份 Excel 名单
node packages/cli/bin/exam-seat.mjs --json roster --file 高三名单.xlsx > roster.json

# 2) 生成考场配置：20 个小考场 + 5 个大考场 + 1 个 6排×4列
node packages/cli/bin/exam-seat.mjs --json rooms --spec "1-20:small,21-25:large,26:6x4"

# 3) 拼好 job.json 之后，先预检
node packages/cli/bin/exam-seat.mjs precheck --job job.json

# 4) 正式排 + 导出 Excel
node packages/cli/bin/exam-seat.mjs plan --job job.json --out-dir out
```

`--json` 时 stdout 只输出一个 JSON 对象，日志走 stderr。退出码：`0` 完美 ｜ `2` 有冲突或限定没满足 ｜ `3` 根本没解 ｜ `1` 用法错误。

其他命令：`numbering`（打印座位编号图）、`template`（job.json 模板）、`validate`（独立校验器重验）。

```bash
node packages/cli/bin/exam-seat.mjs numbering --rows 6 --cols 5
```

### 网页

```bash
pnpm --filter @exam-seat/web dev
```

六个步骤：导入名单 → 排除缺考 → 配置考场 → 设置限定 → 排考场 → 导出名单。网页可以导出/导入 `job.json`，和命令行完全互通。

### 让 AI 来排

项目里带了 skill：`.agents/skills/exam-seating/`。在支持 skill 的 agent 里打开这个项目，直接用自然语言描述需求即可，agent 会自己读名单、拼 `job.json`、调 CLI、读诊断、按建议重跑。

## 包结构

```
packages/core   @exam-seat/core   零依赖算法包，浏览器 / Node 通用
packages/io     @exam-seat/io     Excel 读写（SheetJS 0.20.3，vendored）
packages/cli    @exam-seat/cli    命令行
packages/web    @exam-seat/web    Vue 3 单页应用
.agents/skills/exam-seating/      AI 用的项目级 skill
docs/design.md                    完整设计方案
vendor/                           SheetJS tarball
```

`core` 不认识文件、网络和 DOM，只认内存对象；Excel 归 `io`，终端归 `cli`，界面归 `web`。所以同一份算法在浏览器和 Node 里**同 seed 同输入必得同结果**。

`core` 出三种产物：ESM（`dist/index.js`）、CJS（`dist/index.cjs`）、以及一份**零依赖单文件** `dist/index.iife.js`。最后一份可以直接用 `<script>` 引入，全局名是 `ExamSeat`，不需要任何打包工具：

```html
<script src="packages/core/dist/index.iife.js"></script>
<script>
  const result = ExamSeat.plan({ students, rooms });
</script>
```

## 三条必须记住的约定

**1. 座位是蛇形编号的。** 1 号在靠门前角，沿本列向后排到底，左移一列，从后往前，再左移一列，从前往后，依次蛇形。

小考场（5 列 × 6 排 = 30），按物理列序显示：

```
     讲台 / 黑板
      c1  c2  c3  c4  c5
 r1  25  24  13  12   1
 r2  26  23  14  11   2
 r3  27  22  15  10   3
 r4  28  21  16   9   4
 r5  29  20  17   8   5
 r6  30  19  18   7   6
```

**2. 列号从靠门侧起算。** 第 1 列 = 靠门列 = 小号列；最后一列 = 靠窗列 = 大号列。行号从讲台起算，第 1 排 = 首排。

**3. 不指定考场时，行列只能用语义值。** 小考场 5 列、大考场 6 列，「靠窗列」在两者里是不同的数字，所以只能用 `"first"` / `"last"` / `"door"` / `"window"`；绝对号（`"rows": [3]`）只在同时指定了 `roomId` 时才可靠。

## job.json 是唯一契约

`core`、`cli`、网页、AI 四方用同一份 `job.json` 交换数据。老师可以在网页上配一半导出给 AI，AI 补完再导回网页复核。

```jsonc
{
  "jobVersion": 2,
  "options": { "seed": 20260930, "adjacency": "king", "relax": "none" },
  "students": [{ "id": "2026010001", "name": "张伟", "className": "高三(1)班" }],
  "rooms": [
    { "id": "R1", "name": "第1考场", "rows": 6, "cols": 5, "doorSide": "right", "note": "张老师" },
  ],
  "constraints": [
    { "id": "C1", "studentIds": ["2026010001"], "rows": ["first"] },
    {
      "id": "C2",
      "studentIds": ["A", "B", "C", "D"],
      "roomId": "R5",
      "rows": ["first", "last"],
      "cols": ["door", "window"],
    },
  ],
}
```

完整字段表见 `.agents/skills/exam-seating/reference.md`。

## 开发

```bash
pnpm verify        # 一条命令跑完 CI 的全套：lint + 类型 + 构建 + 测试 + 验收
pnpm lint          # oxlint --fix + oxfmt（自动修 + 格式化）
pnpm lint:check    # 只检查，不改文件（CI 用这个）
pnpm typecheck     # 类型检查（core/io/cli 用 tsc，web 用 vue-tsc）
pnpm test          # 单元测试
pnpm build         # 全部构建
pnpm acceptance     # 一键验收：19 项硬指标（990 人端到端 + 独立暴力复核）
node examples/smoke.mjs      # 990 人 / 33 考场 冒烟测试
node examples/make-roster.mjs /tmp/roster.xlsx 18 55   # 造一份假名单
```

### 工具链

| 用途       | 用什么                                                             |
| ---------- | ------------------------------------------------------------------ |
| 代码检查   | **oxlint**（配置 `oxlint.config.ts`，基于 `oxc-config-hope` 预设） |
| 代码格式化 | **oxfmt**（配置 `oxfmt.config.ts`）                                |
| 提交前     | husky + nano-staged：只对改动的文件跑 oxfmt / oxlint               |
| 提交信息   | `scripts/verifyCommit.ts`，由 `.husky/commit-msg` 调用             |
| CI         | `.github/workflows/ci.yml`（Node 22 / 24 矩阵）、`codeql.yml`      |
| 依赖更新   | `.github/renovate.json`                                            |

### 提交信息规范

```
<type>(<scope>): <subject>
```

- `type`：`feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `workflow` / `build` / `ci` / `chore` / `types` / `release`
- `scope`：可选；给了就必须是包名（`core` / `io` / `cli` / `web`）或 `deps` / `release`
- `subject`：1–50 字符，只校验第一行，正文随意

例：`feat(core): 支持把 4 个学生放进同考场四角`

本地可用 `pnpm commit:verify .git/COMMIT_EDITMSG` 手动校验。

版本约定写在 [AGENTS.md](./AGENTS.md)：TypeScript 必须 6.x（不要升 7）、构建用 tsdown（不要用 tsup）、SheetJS 用 vendored 的 0.20.3（不要用 npm 上那个停在 0.18.5 的）。
