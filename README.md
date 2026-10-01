# exam-seat · 排考场工具

把学生名单和老师的排座要求，排成一份「哪个班的哪个学生坐第几考场多少号」的名单。

- **硬约束**：每个学生周围 8 个人不能同班（单人独桌）。班级数少于 9 个时自动退化为「前后左右不能同班」，并明确提示。
- **限定**：可以点名要求某学生去哪个考场、坐第几排、坐第几列，也可以把 4 个学生放进同一个考场的 4 个角。
- **排不出来就说清楚**：给出「为什么排不出来 + 怎么放宽」，每条建议都能一键应用。
- **两种用法**：老师自己在网页上点，或者把需求口述给 AI 让它调命令行。

## 快速开始

需要 **Node ≥ 22.18** 与 **pnpm 12**（22.18 是下限：`.husky/commit-msg` 用 `node` 直接跑
`scripts/verifyCommit.ts`，依赖 Node 的 TypeScript type stripping，该能力 22.18 起默认开启）。

```bash
pnpm install
pnpm build          # 构建 core / io / cli / web
pnpm test           # 单元测试
pnpm verify         # 提交前全量门禁：lint + typecheck + build + test + 验收
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

其他命令：`numbering`（打印座位编号图，加座考场用 `--extra 2,4`）、`template`（job.json 模板）、`validate`（独立校验器重验）。

```bash
node packages/cli/bin/exam-seat.mjs numbering --rows 7 --cols 5 --extra 2,4
```

**多场次（名单里带选科）导出什么**：`--out-dir out` 下会生成

```
out/按班级考场安排.xlsx      # 总表（全班 706 人）+ 每个班一张 sheet
                             # 列：班级 / 姓名 / 准考证号 / 主考场 / 主座位号 /
                             #     单科考场1 / 座位号1 / 单科考场2 / 座位号2 …
                             # 考场列写「第N考场·地点」（地点为空就不带「·」）；
                             # 座位号是该生在那间考场各时段的号（去重升序，数字单元格可排序）
out/考场监考表.xlsx          # 每个考场一张 sheet：座位号 / 班级 / 姓名 / 准考证号 / 备注
                             # 备注只写两种：「不考：生物」（他的主考场在这里、但这场他不考）
                             #            「只考：生物」（他只是来这间单科借考）；其余留空
out/按班级考场安排/2501.xlsx …   # 每个班一个单独文件（发给班主任）
out/考场监考表/第一考场（语数外物化生）.xlsx …  # 每个考场一个单独文件（发给监考老师）
out/plan.json  out/job.json
```

两张表都按 **A4 横向、缩放到一页宽** 排好版（字号 / 对齐 / 合并标题 / 自动列宽都设好了），
冻结并每页重复打印表头，可以直接打印。

班级表里**每个考场占两列**：考场列 + 座位号列。**主考场列不带科目括号**，只有要换考场的学生才会写
「第十九考场（政治）」这样带科目的一格；考场列后面用「·」接地点（`第1考场·高二1班`）。
地点里的中点字符只在这个拼接处清理，`job.json` / `plan.json` 里的 `location` 原样不动。

### 网页

```bash
pnpm --filter @exam-seat/web dev
```

六个步骤：导入名单 → 排除缺考 → 配置考场 → 设置限定 → **考场排布** → 导出名单。网页里这份配置叫**「排布状态」**（文件 `排布状态.json`），就是命令行用的 `job.json`，两边完全互通；网页也可以导入命令行导出的 `job.json`。

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

小考场（网页 / CLI 预设 `small` = **5 列 × 7 排 = 35 座**），按物理列序显示：

```
     讲台 / 黑板
      c1  c2  c3  c4  c5
 r1  29  28  15  14   1
 r2  30  27  16  13   2
 r3  31  26  17  12   3
 r4  32  25  18  11   4
 r5  33  24  19  10   5
 r6  34  23  20   9   6
 r7  35  22  21   8   7
```

大考场预设 `large` = **6 列 × 7 排 = 42 座**（`large`）。用
`node packages/cli/bin/exam-seat.mjs numbering --rows 7 --cols 5` 可以自己核对这张图。

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

### 个别考场加限制 / 放宽

都是**考场级 / 学生级**的开关，互不影响；每一次放宽都会在 `plan.json` 里留一条诊断，并在监考表上标注。
**红线不变：一个考场、一个时段、只能有一张卷子。**

```jsonc
{
  "options": {
    // 时段表可以直接填死（老师按考务表给），不再自动推导：
    "slots": [{ "id": "T6", "name": "第6时段", "subjects": ["biology", "geography"] }],
    // 或者只补「必须分开」的科目对：
    "forbiddenSameSlot": [["chemistry", "biology"]],
  },
  "students": [
    // 这个学生的「生物」去第十八考场借考（其它科目仍在自己的主考场）：
    {
      "id": "<借考生学号>",
      "name": "某生",
      "className": "2517",
      "subjects": ["biology", "politics", "history"],
      "subjectRoom": { "biology": "R18" },
    },
  ],
  "rooms": [
    // 只放宽这一个考场的「同班相邻」（true = 完全放开；数字 = 该考场同班人数上限）：
    { "id": "R16", "name": "第十六考场", "rows": 7, "cols": 6, "relaxSameClass": true },
    // 讲台一侧加座：5 列 × 7 排 + 第 2、4 列各加 1 张桌 = 37 座：
    { "id": "R1", "name": "第一考场", "rows": 7, "cols": 5, "extraFrontSeats": [2, 4] },
    // 专属组合考场：这间只收「政史地」的整批学生（写法「史地政」等价；人数多可以给多间都写上）：
    { "id": "R17", "name": "第十七考场", "rows": 7, "cols": 5, "combination": "政史地" },
  ],
}
```

借考只占目标考场**该时段的一个空位**，不产生第二张卷子；目标考场该时段若另有别的科目，会明确报
`SUBJECT_ROOM_CLASH` 并且不导出名单。

## 开发

```bash
pnpm verify        # 一条命令跑完 CI 的全套：lint + 类型 + 构建 + 测试 + 验收
pnpm lint          # oxlint --fix + oxfmt（自动修 + 格式化）
pnpm lint:check    # 只检查，不改文件（CI 用这个）
pnpm typecheck     # 类型检查（core/io/cli 用 tsc，web 用 vue-tsc）
pnpm test          # 单元测试
pnpm build         # 全部构建
pnpm acceptance     # 一键验收：143 项硬指标（990 人端到端 + 独立暴力复核 + 专属组合/放宽/借考/加座）
node examples/smoke.mjs      # 990 人 / 33 考场 冒烟测试
node examples/make-roster.mjs /tmp/roster.xlsx 18 55   # 造一份假名单
```

### 工具链

| 用途       | 用什么                                                                 |
| ---------- | ---------------------------------------------------------------------- |
| 代码检查   | **oxlint**（配置 `oxlint.config.ts`，基于 `oxc-config-hope` 预设）     |
| 代码格式化 | **oxfmt**（配置 `oxfmt.config.ts`）                                    |
| 提交前     | husky + nano-staged：只对改动的文件跑 oxfmt / oxlint                   |
| 提交信息   | `scripts/verifyCommit.ts`，由 `.husky/commit-msg` 调用                 |
| CI         | `.github/workflows/ci.yml`（Node **22 / 24 / 26** 矩阵）、`codeql.yml` |
| 依赖更新   | `.github/renovate.json`                                                |

### 提交信息规范

```
<type>(<scope>): <subject>
```

- `type`：`feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `workflow` / `build` / `ci` / `chore` / `types` / `release`
- `scope`：可选；给了就必须是包名（`core` / `io` / `cli` / `web` / `desktop`）或 `deps` / `release`
  （`desktop` 在 `scripts/verifyCommit.ts` 的 `extraScopes` 里显式列出，所以 `feat(desktop): …` 能过）
- `subject`：1–50 字符，只校验第一行，正文随意

例：`feat(core): 支持把 4 个学生放进同考场四角`

本地可用 `pnpm commit:verify .git/COMMIT_EDITMSG` 手动校验。

## 授权（请先读）

**本项目源码公开，但不是开源软件**：允许非商业使用，**禁止商用**，**未经授权禁止二次开发与对外发布修改版**。

| 你可以（无需申请）                              | 你不可以（需书面授权）                               |
| ----------------------------------------------- | ---------------------------------------------------- |
| 学校 / 教育机构 / 非营利组织**非商业**使用      | **商业使用**（出售、出租、收费服务、集成进商业产品） |
| 复制分发**原始未修改**副本（保留版权与条款）    | **二次开发**后对外发布、分发修改版或衍生作品         |
| 修改 `job.json`、考场配置、名单等**数据与配置** | 移除版权声明，或声称本项目为你所有                   |
| 为**自身非商业使用**修改源码（不对外发布）      | 以本项目为基础提供**收费服务**（含 SaaS）            |

- 校内使用、教学、个人学习、公益考试组织 —— 全部允许；
- 学校**内部**改源码自用可以，只是**不能对外发布**；
- 商业使用或想获得二次开发授权 → 通过 [GitHub](https://github.com/Mister-Hope) 联系作者。

完整条款见 [LICENSE](./LICENSE)（自定义许可，SPDX 标记 `LicenseRef-Proprietary-NonCommercial`）。
排考结果仅供考务参考，**使用前请自行核对**。

版本约定写在 [AGENTS.md](./AGENTS.md)：TypeScript 必须 6.x（不要升 7）、构建用 tsdown（不要用 tsup）、SheetJS 用 vendored 的 0.20.3（不要用 npm 上那个停在 0.18.5 的）。
