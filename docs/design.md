# 排考场工具 · 设计方案 v5

> 状态：设计定稿，尚未实现。
> v2 重写流程｜v3 加入可行性诊断与降级｜v4 敲定编号与限定模型
> **v5：核心算法独立成 JS 包，新增 CLI 与项目级 Skill，支持 AI 直接调用**

---

## 0. 一句话方案

> **实现状态**：已完成，代码在 `~/projects/exam-seat`（公开仓库形态，带 CI）。
> 单测 109 项全过（core 25 / 校验器 7 / io 11 / cli 6 / web 60）；
> 一键验收 19 项硬指标全过（990 人 / 33 个考场，`strict` 零冲突，独立暴力复核 5874 组相邻零违规）。
> 实现与本文档的两处差异：§3 新增 `forceKing` 选项（班级数 < 9 时默认退化，置 true 可坚持 8 邻域）；
> `relax` 的 L2/L3 现在会**先把「限定太紧」降级为惩罚**，只有结构性错误（座位不够等）才判死。
> 工程化：oxlint + oxfmt、husky 提交钩子、`scripts/verifyCommit.ts` 校验提交信息、
> GitHub Actions（`ci.yml` / `codeql.yml`）、Renovate。

核心算法是一个**零依赖 JS 包**，网页和命令行都只是它的壳，两者用同一份 `job.json` 作为契约。

- 老师走**网页**：点选配置、看结果、导出名单。
- AI 走 **CLI**：把自然语言/Excel 变成 `job.json` → 调包 → 读结构化诊断 → 转述或修复重跑。

排不出来时不甩一句「失败」，而是给出**为什么 + 怎么放宽**的机器可读建议；要退让时**明确标注降级**，绝不静默。

---

## 1. 需求确认

| #   | 需求        | 说明                                                                            |
| --- | ----------- | ------------------------------------------------------------------------------- |
| 1   | Web 应用    | 导入 `.xlsx`，查询排除缺考，可视化配置                                          |
| 2   | 核心包      | 算法封装为独立 JS 包，浏览器 / Node 通用                                        |
| 3   | CLI         | agent 可通过命令行或 import 调用，传选项拿明确结果                              |
| 4   | Skill       | 项目级 skill，说明这个包能做什么、每个接口什么含义                              |
| 5   | AI 填参     | 用户口述需求 → AI 理解 → AI 填写参数 → 调包 → 返回结果                          |
| 6   | 限定规则    | **考场限定（单选）** + **行** + **列**，可只设一个也可叠加                      |
| 7   | 考场配置    | 手动设总数；每个考场「大（6×7=42）/ 小（5×6=30）/ 自定义 行×列」                |
| 8   | 编号规则    | 蛇形；门在右上角，1 号 = 右上角，逐列向左                                       |
| 9   | 列 / 行编号 | 列**从靠门侧起算**（第 1 列 = 靠门列 = 小号列，第 C 列 = 靠窗列）；行从讲台起算 |
| 10  | 硬约束      | 每人单桌，任意学生 8 邻域内不得有同班                                           |
| 11  | 班级数 < 9  | 自动退化到「前后左右 4 邻域」，明确提示已降级                                   |
| 12  | 无解反馈    | 必须说清为什么排不出来 + 怎么放宽（建议可一键应用）                             |
| 13  | 输出        | **不是座位图，是一份名单**：哪个班的哪个学生 → 第几考场、多少号                 |

---

## 2. 交付形态

```
exam-seat/                          仓库根 = 项目根
├── packages/
│   ├── core/       @exam-seat/core    纯算法，零依赖，浏览器/Node 通用（出 ESM + CJS + IIFE）
│   ├── io/         @exam-seat/io      Excel 读写（SheetJS），浏览器/Node 通用
│   ├── cli/        @exam-seat/cli     命令行，bin: exam-seat
│   └── web/        @exam-seat/web     Vue 3 单页应用（Vite）
├── .agents/skills/exam-seating/       ★ AI 用的项目级 skill（随项目打开生效）
│   ├── SKILL.md                       精简入口（渲染后 < 8192 字符）
│   ├── reference.md                   完整 JSON Schema + 诊断码表
│   └── examples/job.sample.json
├── examples/                          示例名单、验收与冒烟脚本（pnpm acceptance / pnpm smoke）
├── scripts/                           仓库脚本（verifyCommit 等）
└── docs/
    ├── design.md                      本文：整体设计
    ├── design-selection.md            选科与多场次排考设计（job.json v2 的新字段出处）
    └── issues.md                      未完成事项 / 议题清单（可直接派给子代理）
```

**分层原则**：`core` 不认识文件、不认识网络、不认识 DOM，只认内存里的对象。Excel 读写归 `io`，终端交互归 `cli`，界面归 `web`。所以同一份算法能在浏览器和 Node 里跑出**逐字节相同**的结果（同 seed 同输入）。

---

## 3. Job JSON：唯一契约

`job.json` 是 core / CLI / Web / AI 四者之间**唯一的交换格式**。老师可以在网页里配好再导出 job.json 交给 AI；AI 也可以生成 job.json 让老师在网页里打开复核、微调。

### 3.1 输入 `job.json`

```jsonc
{
  "jobVersion": 2,
  "meta": { "title": "2026届高三一模", "createdAt": "2026-09-30T13:00:00+08:00" },

  "options": {
    "seed": 20260930, // 固定种子 → 结果可复现
    "adjacency": "king", // king = 8 邻域（默认）；orthogonal = 前后左右
    "forceKing": false, // 班级数 < 9 时默认自动退化；置 true 则坚持 8 邻域
    "relax": "none", // none | softConstraints | minConflicts
    "timeLimitMs": 10000,
  },

  "students": [
    { "id": "20240101", "name": "张三", "className": "高三(1)班", "included": true },
    // included: false 表示本次不参加考试（等价于在网页上排除）
    // v2 选科（可选）：原文给老师看，subjects 是 core 规范化后的科目 id
    {
      "id": "20240202",
      "name": "李四",
      "className": "高三(2)班",
      "combination": "物化政",
      "subjects": ["physics", "chemistry", "politics"],
    },
  ],

  "rooms": [
    { "id": "R1", "name": "第1考场", "rows": 6, "cols": 5, "doorSide": "right", "note": "张老师" },
    { "id": "R2", "name": "第2考场", "rows": 7, "cols": 6, "doorSide": "right", "note": "李老师" },
    { "id": "R3", "name": "第3考场", "rows": 6, "cols": 4, "doorSide": "right" },
    // v2：地点与「专用考场」标记（只接收考该科目的非常规组合考生，可兼多科）
    {
      "id": "R20",
      "name": "第20考场",
      "location": "生物实验室",
      "rows": 6,
      "cols": 5,
      "doorSide": "right",
      "dedicatedSubjects": ["politics", "geography"],
    },
  ],

  "constraints": [
    // 不限定考场 → 只能用「首/末/靠门/靠窗」语义值，按各考场实际行列数解析
    { "id": "C1", "note": "有作弊前科", "studentIds": ["20240101", "20240215"], "rows": ["first"] },

    // 限定了考场 → 才允许写绝对行列号（此处 = 第3考场第3排）
    {
      "id": "C2",
      "note": "班主任考场第3排",
      "studentIds": ["20240300"],
      "roomId": "R3",
      "rows": [3],
    },

    // 四角：全用语义值，大小考场都能正确解析
    {
      "id": "C3",
      "note": "四角",
      "studentIds": ["A", "B", "C", "D"],
      "roomId": "R5",
      "rows": ["first", "last"],
      "cols": ["door", "window"],
    },

    // v2 选择器：点名 / 班级 / 组合 / 科目，四者取并集命中学生；至少写一个
    { "id": "C4", "note": "物化政全体靠门", "combinations": ["物化政"], "cols": ["door"] },
    { "id": "C5", "note": "高三(3)班首排", "classes": ["高三(3)班"], "rows": ["first"] },
    { "id": "C6", "note": "考政治的考生靠窗", "subjects": ["politics"], "cols": ["window"] },
  ],
}
```

> v2 新增字段（选科 `combination` / `subjects`、考场 `location` / `dedicatedSubjects`、
> 限定的班级 / 组合 / 科目选择器）的来源与语义见 **`docs/design-selection.md`**；
> 本章只固定它们的 JSON 形状，两篇文档保持一致。

字段语义（**这是最容易搞错的三个地方，skill 里要重点写**）：

| 字段                                                   | 语义                                                                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `rows`                                                 | `"first"` 首排 ｜ `"last"` 末排 ｜ 数字 = 绝对排号（从**讲台**起算，**仅在指定考场时可用**）                                            |
| `cols`                                                 | `"door"` 靠门列（小号列）｜ `"window"` 靠窗列（大号列，= 该考场最后一列）｜ 数字 = 绝对列号（从**靠门侧**起算，**仅在指定考场时可用**） |
| `roomId`                                               | **单选**，不填 = 不限考场                                                                                                               |
| `studentIds` / `classes` / `combinations` / `subjects` | v2 选择器，取**并集**得到这条限定涉及的学生；至少写一个，否则报 `CONSTRAINT_NO_SELECTOR`                                                |
| 同校多规则                                             | 同一学生被多条规则命中时**取交集**，为空则报错                                                                                          |
| `location` / `dedicatedSubjects`                       | v2 考场字段：地点（出现在监考表与座位表表头）与专用科目标记                                                                             |

> ⚠️ 为什么 `last` / `window` 必须用语义值而不是数字：考场有 5×6 和 6×7 两种，**同一个数字在不同考场指向不同位置**。详见 §10.1。

### 3.2 输出 `plan.json`

```jsonc
{
  "resultVersion": 1,
  "ok": true,
  "level": "strict", // strict | orthogonal | softConstraints | minConflicts
  "stats": {
    "students": 982, // job 里的学生总数
    "participants": 970, // 实际参考（included !== false）
    "excluded": 12,
    "rooms": 25,
    "roomsUsed": 24,
    "emptyRooms": ["R25"], // 完全没用到的考场 id，可以不布置
    "seatsTotal": 1050,
    "seatsUsed": 970,
    "conflicts": 0,
    "unmetConstraints": 0,
    "classes": 18,
    "elapsedMs": 1840,
    "seed": 20260930,
    "adjacency": "king", // king | orthogonal
  },

  "entries": [
    {
      "studentId": "20240101",
      "name": "张三",
      "className": "高三(1)班",
      "roomId": "R1",
      "roomName": "第1考场",
      "seatNo": 1,
      "row": 1,
      "col": 5, // 业务列，从靠门侧起算
      "physicalCol": 1, // 物理列，面对讲台从左往右；只用于展示与打印
    },
  ],

  "conflicts": [], // { roomId, seatA, seatB, studentA, studentB, className }
  "unmetConstraints": [], // { constraintId, studentIds, reason }
  "diagnostics": [], // 见 §12
  "inputFingerprint": "sha256:...",
  "generatedAt": "2026-09-30T13:05:12+08:00",
}
```

`stats` 与 `diagnostics` 是给 AI 读的；`entries` 是给人和 Excel 用的。

---

## 4. Core 包 API

```ts
import {
  // 主流程
  precheckJob,
  plan,
  planAll,
  validate,
  // 定义域与选择器
  compileDomains,
  compileConstraintSeats,
  hasAnySelector,
  resolveConstraintStudents,
  // 选科（job.json v2）
  parseCombination,
  normalizeCombination,
  validateSelection,
  SUBJECT_LABELS,
  CORE_SUBJECTS,
  PREFERRED_SUBJECTS,
  SECONDARY_SUBJECTS,
  // 场次推导（多场次）
  deriveTimeSlots,
  findSlotConflicts,
  buildConflictGraph,
  // 语义值解析（UI 解释、预检校验、导出说明共用）
  resolveRowRef,
  resolveColRef,
  // 编号换算：只依赖排数（列数由列号自身表达）
  seatNoToRC,
  rcToSeatNo,
  roomCapacity,
  toPhysicalCol,
  describeRows,
  describeCols,
} from "@exam-seat/core";

// 预检：不求解，只判定可行性并给出诊断与建议
function precheckJob(job: Job, overrides?: PlanOptions): PrecheckOutput;

// 主入口：同步、纯函数、同输入同 seed 必得同结果（单场）
function plan(job: Job, overrides?: PlanOptions): PlanResult;

// 多场次：名单里带选科时用，按组合分组分房，每人得到「时段 → 考场 + 座位」表
function planAll(job: Job, overrides?: PlanOptions): PlanAllResult;

// 独立校验器：拿最终方案重验全部硬约束（与求解器分开实现）
function validate(job: Job, result: PlanResult): ValidationReport;

// 限定编译：语义值按「每个候选考场自己的行列数」解析，
// 所以同一个 rows: ["last"] 在小考场 = 第6排、大考场 = 第7排。
function compileDomains(model: CompiledModel): DomainBundle;
function compileConstraintSeats(model: CompiledModel, constraint: Constraint): ConstraintSeatSet;

// v2 选择器：点名 / 班级 / 组合 / 科目取并集；一条都没有时返回空集并由预检报 CONSTRAINT_NO_SELECTOR
function hasAnySelector(constraint: Constraint): boolean;
function resolveConstraintStudents(model: CompiledModel, constraint: Constraint): number[];

function resolveRowRef(room: RoomSpec, ref: RowRef): number | null; // 'last' → room.rows；越界返回 null
function resolveColRef(room: RoomSpec, ref: ColRef): number | null; // 'window' → room.cols；越界返回 null

// 编号换算（真实签名；门的方向只在换算「物理列」时才需要）
function seatNoToRC(seatNo: number, rows: number, cols: number): { row: number; col: number };
function rcToSeatNo(row: number, col: number, rows: number, cols: number): number;
function toPhysicalCol(col: number, cols: number, doorSide?: DoorSide): number;
```

设计约束：

- **零运行时依赖**，不碰 `fs` / `path` / `document`，浏览器直接可用。
- 纯同步函数；超时通过 `options.timeLimitMs` 控制（**没有** `AbortSignal` 取消：`plan()` 是同步的，
  Web 端靠「终止 Worker」表达取消，见 §14）。
- `plan()` **不用抛异常表达业务失败**；失败信息一律走 `PlanResult.diagnostics`，异常只留给编程错误。
- 构建产出 **ESM + CJS + IIFE**（`packages/core/dist/index.iife.js`，`globalName: ExamSeat`），
  方便网页里 `<script>` 直接引入。

---

## 5. CLI 规约

```bash
exam-seat roster    --file roster.xlsx [--sheet 名称] [--out roster.json]
exam-seat rooms     --spec "1-20:small,21-25:large,26:6x4" [--json]
exam-seat numbering --rows 6 --cols 5 --door right
exam-seat template  [--out job.template.json]
exam-seat precheck  --job job.json [--json]
exam-seat plan      --job job.json [--out-dir out] [--json] [--single]
                    [--seed N] [--relax 模式] [--adjacency 模式] [--force-king]
                    [--time-limit ms] [--show N]
exam-seat validate  --job job.json --plan plan.json
```

约定（**为 agent 设计**）：

| 项          | 约定                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--job -`   | 从 stdin 读 job.json，AI 可以不落临时文件直接管道传入                                                                                     |
| `--json`    | **stdout 只输出一个 JSON 对象**；进度与日志全部走 stderr                                                                                  |
| 退出码      | `0` 完美 ｜ `2` 已降级 ｜ `3` 预检失败 / 排不出来 ｜ `1` 用法或 IO 错误                                                                   |
| 幂等        | 同 `--job` + 同 seed → 同输出                                                                                                             |
| `--out-dir` | 单场写 `考场安排名单.xlsx` / `考场座位表.xlsx` / `plan.json` / `job.json`；多场写 `按班级考场安排.xlsx` / `考场监考表.xlsx` / `plan.json` |
| 单场 / 多场 | 名单里带选科（`combination` 或 `subjects`）自动走 `planAll` 多场次；`--single` 强制按单场处理                                             |

退出码让 agent 能直接分支：拿到 `3` 就去读 `diagnostics[].suggestions`，拿到 `2` 就把 `level` 明确告诉用户。

`--spec` 语法刻意做得紧凑，方便 AI 拼：`1-20:small`（5×6=30）、`21-25:large`（6×7=42）、`26:6x4`（自定义）。

---

## 6. Skill 设计

**位置（项目级，随项目打开生效）**：

```
<项目根>/.agents/skills/exam-seating/SKILL.md
```

DSH 的发现规则：扫描根目录下的**直接子项**，`<name>/SKILL.md` 目录包或 `<name>.md` 平铺文件，`name` 必须 kebab-case；嵌套 `**/SKILL.md` **不会**被发现。frontmatter 必填 `name` 与 `description`。

**容量约束**：`SKILL.md` 渲染后必须 < 8192 字符，所以：

- `SKILL.md` 只放**入口信息和最短路径**（何时用、三步工作流、CLI 速查、高频坑位）；
- 完整 JSON Schema、诊断码全表、边界规则放进同目录的 `reference.md`，由 SKILL.md 指路；
- 示例放进 `examples/job.sample.json`。

**SKILL.md 的核心内容（三步工作流）**：

1. **建模**：把用户的自然语言 / Excel 名单变成 `job.json`。名单用 office-xlsx skill 或 `@exam-seat/io` 读；需求翻译成 `rooms` 与 `constraints`。
2. **调用**：`exam-seat plan --job job.json --out-dir out --json`，读 stdout 的 JSON。
3. **解释与修复**：`diagnostics[]` 里每条都有中文 `message`、`evidence` 和 `suggestions[]`；**每条建议带可机器应用的 `patch`**，agent 可以直接应用后重跑。`ok:false` 或 `level != "strict"` 时**必须先告诉用户**，不能默默交付。

**必须在 skill 里写死的坑位**（这几条最容易出错）：

- 列号**从靠门侧**起算，第 1 列 = 靠门列；不是从左往右。
- 考场限定是**单选**，不能给一个学生配多个考场。
- 同一学生多条限定**取交集**，不是覆盖。
- 班级数 ≤ 8 会**自动降级**为 4 邻域，`level` 会变成 `orthogonal`，必须向用户说明。
- 输出是**名单**（考场 + 座位号），不是座位图。

---

## 7. 两种使用流程

### 7.1 网页（老师自己配）

```
导入 xlsx → 查询排除缺考 → 配考场 → 设限定 → 排考场 → 看名单 → 导出 xlsx
                                      ↕ 导入/导出 job.json
```

### 7.2 AI 驱动（口述 → 结果）

```
用户：「名单在 roster.xlsx，1–20 考场用小考场，21–25 用大考场，
       张三有作弊前科放第一排，李四那 4 个人放第 5 考场四个角」
  ↓
Agent：读 roster.xlsx → 拼 job.json
  ↓
Agent：exam-seat plan --job job.json --out-dir out --json
  ↓
Agent：读 diagnostics
        ├─ ok:true  → 交付 out/名单.xlsx + 一句话摘要
        ├─ ok:false → 转述 message，列出 suggestions 让用户挑
        └─ 用户确认 → 应用 suggestion.patch → 重跑 → 交付
```

**同一个 job.json 可以让两边接力**：老师网页上配一半导出给 AI，AI 补充后再导回网页复核。这是这套分层最大的好处。

---

## 8. Web 应用页面设计

### ① 导入名单

拖拽 `.xlsx`；多表选表；列映射向导（`学号` / `姓名` / `班级` 必填，`性别` / `选科` / `备注` 选填）；校验并列出问题行。顶部统计总人数 / 班级数 / 各班人数；名单里带选科时另外给出**选科组合分布**，并提示多场次编排的现状（见 §14 与 `docs/design-selection.md`）。

### ② 排除缺考

表格 + 搜索（学号 / 姓名 / 班级，多条件模糊匹配）。主路径：**查询 → 全选结果 → 批量排除**。被排除行置灰打标签，抽屉可恢复。实时显示「应考 / 已排除 / **实际参考**」，容量校验按实际参考算。

### ③ 配置考场

每行一个考场：类型（大 / 小 / 自定义 行×列）、门的位置（默认靠右）、**备注（填监考老师）**、**地点**与**专用科目**（v2，专用考场只接收考该科目的非常规组合考生，一个考场可兼多科）。容量不足红字告警「还缺 N 个座位」；容量过剩提示「第 26–30 考场将空置」。每个考场配**座位编号缩略图**，所见即所得。

### ④ 设置限定

筛选学生 → 勾选 → 添加限定：**考场**（单选下拉，显示「第3考场（张老师）」）+ **行** + **列**，三者独立可叠加。除在表格里点名勾选外，弹窗还支持 v2 的**按班级 / 按组合 / 按科目**选择器（与点名取并集，弹窗里实时显示「命中 N 人」，由 core 的选择器语义算出）。

**行列的可选项取决于有没有选考场**（见 §10.4）：

| 是否选了考场         | 行可选                                  | 列可选                                      |
| -------------------- | --------------------------------------- | ------------------------------------------- |
| **没选**（任意考场） | 首排 / 末排                             | 靠门列 / 靠窗列                             |
| **选了**             | 首排 / 末排 / 第 N 排（N ≤ 该考场排数） | 靠门列 / 靠窗列 / 第 N 列（N ≤ 该考场列数） |

没选考场时绝对号输入框**直接隐藏**——大小考场的行列数不同，同一个数字在不同考场指向不同位置，填了没有意义。提供**四角一键预设**（自动填 `行=[首,末]`、`列=[靠门,靠窗]`，全是语义值，大小考场通吃）。实时冲突检测见 §12.1。

### ⑤ 排考场

先跑预检，有致命问题就停在预检页给建议；通过后 Web Worker 求解，进度条可取消。结果三态：**完美** / **已降级**（标注原因）/ **排不出来**（诊断 + 建议）。

### ⑥ 结果名单

按 `考场号 → 座位号` 升序的表格：考场 / 座位号 / 学号 / 姓名 / 班级。可按班级、考场筛选，可搜「某人坐哪」。附校验报告。导出 `考场安排名单.xlsx`。座位网格只作页面预览。

---

## 9. 座位编号（方案 A）

```
1 号 = 右上角（靠门前角）
→ 沿本列向后到底 → 左移一列 → 从后往前 → 再左移一列 → 从前往后 → …
```

`seatNoToRC` 只按「列」蛇形推进，**返回的是业务列号**（从靠门侧起算，1 = 靠门列）：

```ts
// 真实签名（见 §4）：rows = 排数，cols 只是为了形状一致，编号本身不需要它
function seatNoToRC(seatNo: number, rows: number, cols: number): { row: number; col: number } {
  const k = Math.floor((seatNo - 1) / rows); // 第几列（从靠门侧数，0 基）
  const off = (seatNo - 1) % rows;
  const forward = k % 2 === 0; // 首列从前往后，次列从后往前
  const row = forward ? off + 1 : rows - off;
  return { row, col: k + 1 }; // 业务列
}

// 要在界面上按「面对讲台从左往右」的物理列画座位图时，再换算一次：
// doorSide === "right" → physicalCol = cols - col + 1
function toPhysicalCol(col: number, cols: number, doorSide: DoorSide = "right"): number;
```

> 下面两张示意图都是**物理列序**（c1 在最左，门在右），所以格子里的座位号与 `seatNoToRC`
> 的业务列是左右镜像关系；网页的座位缩略图就是这么画的。

**小考场（5 列 × 6 排 = 30）**

```
            讲台 / 黑板
        c1   c2   c3   c4   c5 ←门
  r1    25   24   13   12    1
  r2    26   23   14   11    2
  r3    27   22   15   10    3
  r4    28   21   16    9    4
  r5    29   20   17    8    5
  r6    30   19   18    7    6
```

**大考场（6 列 × 7 排 = 42）**

```
            讲台 / 黑板
        c1   c2   c3   c4   c5   c6 ←门
  r1    42   29   28   15   14    1
  r2    41   30   27   16   13    2
  r3    40   31   26   17   12    3
  r4    39   32   25   18   11    4
  r5    38   33   24   19   10    5
  r6    37   34   23   20    9    6
  r7    36   35   22   21    8    7
```

---

## 10. 限定规则体系

### 10.1 为什么行列必须分「语义值」和「绝对号」

考场有大小之分（5 列 × 6 排 = 30 与 6 列 × 7 排 = 42），**同一个数字在不同考场指向不同位置**：

| 限定               | 在 5×6 考场（30 人）     | 在 6×7 考场（42 人）    |
| ------------------ | ------------------------ | ----------------------- |
| `rows: ["first"]`  | 第 1 排（5 个座）        | 第 1 排（6 个座）       |
| `rows: ["last"]`   | 第 6 排                  | 第 7 排                 |
| `rows: [3]`        | 第 3 排                  | 第 3 排                 |
| `cols: ["door"]`   | 第 1 列（靠门）          | 第 1 列（靠门）         |
| `cols: ["window"]` | 第 5 列                  | 第 6 列                 |
| `cols: [5]`        | 第 5 列（= 靠窗）        | 第 5 列（**不是**靠窗） |
| `cols: [6]`        | 该考场没有第 6 列 → 排除 | 第 6 列（= 靠窗）       |

由此定两条硬规则：

1. **不限定考场时，行 / 列只能用语义值** `first` / `last` / `door` / `window`。求解器按**每个候选考场自己的行列数**解析：「末排」在小考场是第 6 排、大考场是第 7 排；「靠窗列」在小考场是第 5 列、大考场是第 6 列。这才是老师真正想表达的意思。
2. **限定了考场时，才允许写绝对号**（`rows: [3]`、`cols: [2]`）。此时已知该考场是几行几列，绝对号含义确定，并且会校验越界。

> 这正好解释了为什么绝大多数限定都填「首 / 末」：只有首排、末排、靠门列、靠窗列这四个语义值在大小考场混排时是稳定的。老师想指定「第 3 排第 2 列」时，心里通常已经有一个确定的考场了。

### 10.2 数据模型

```ts
type RowRef = "first" | "last" | number;
type ColRef = "door" | "window" | number;

type ConstraintGroup = {
  id: string;
  note?: string;
  // v2 选择器：四者取并集，至少写一个（否则 CONSTRAINT_NO_SELECTOR）
  studentIds?: string[]; // 按学号点名
  classes?: string[]; // 按班级，例如 ['高三(3)班']
  combinations?: string[]; // 按选科组合，例如 ['物化政']（写法可任选，内部规范化）
  subjects?: string[]; // 按所选科目，例如 ['politics']（命中选了其中任意一门的学生）
  roomId?: string; // 单选：undefined = 不限考场
  rows?: RowRef[];
  cols?: ColRef[];
};
```

### 10.3 编译规则

```
allowedSeats(student) =
  对每个候选考场 R（roomId ? 就是它 : 全部考场）：
    行集合 = rows 里每个值按 R 解析出的行（rows 为空 → R 的全部行）
    列集合 = cols 里每个值按 R 解析出的列（cols 为空 → R 的全部列）
    R 的候选座位 = 行集合 × 列集合
  把所有候选考场的座位并起来
  ∩ 该学生命中的每一条规则        // 多规则取交集
```

| 语义值     | 解析                                                             |
| ---------- | ---------------------------------------------------------------- |
| `'first'`  | 第 1 排                                                          |
| `'last'`   | 第 R 排（R = 该考场的排数）                                      |
| `'door'`   | 第 1 列（靠门侧起算）                                            |
| `'window'` | 第 C 列（C = 该考场的列数）                                      |
| 数字 n     | 第 n 排 / 第 n 列；要求 n ≤ 该考场对应维度，否则**该考场被剔除** |

**越界处理**：绝对号在某考场越界 → 该考场从候选集剔除；所有候选考场都被剔除 → 报错 `CONSTRAINT_INDEX_OUT_OF_RANGE`。

### 10.4 UI 约束（不这么做老师一定会填错）

- **未选考场时，行 / 列下拉只列语义值**（首排 / 末排 / 靠门列 / 靠窗列），绝对号输入框直接隐藏；
- **选了考场之后**，才展开「第 N 排 / 第 N 列」，输入范围按该考场的行列数限制；
- 规则列表把语义值渲染成人话，悬浮提示写清它在各类考场的实际解析，例如：
  「靠窗列 → 5 列考场 = 第 5 列，6 列考场 = 第 6 列」。

### 10.5 典型用法

| 场景                        | 配置                                                            |
| --------------------------- | --------------------------------------------------------------- |
| 只靠门，不在乎考场          | `cols: ["door"]`                                                |
| 强制到班主任监考的考场      | `roomId: "R3"`                                                  |
| 有作弊前科坐首排            | `rows: ["first"]`                                               |
| 4 人放同考场四角            | `roomId: "R5", rows: ["first","last"], cols: ["door","window"]` |
| 指定第 3 考场第 3 排第 2 列 | `roomId: "R3", rows: [3], cols: [2]`                            |

---

## 11. 求解算法

带**定义域**的分配问题：每个学生有可用座位集合，每座位至多 1 人，目标为「同考场内切比雪夫距离 1 的两个座位班级不同」。规模约 1000 人 / 30 考场 → **贪心初始化 + 模拟退火 + 增量评估**。

```
1. 建座位表（蛇形编号）
2. 算定义域：学生 → 可用座位集合
3. 贪心初始解：按定义域大小升序处理（MRV），挑邻居已用班级最少的座位
4. 模拟退火：
   move A 同考场内交换两人（主力）
   move B 跨考场交换两人（调整班级分布）
   交换后两人必须仍落在各自定义域内
5. 成本（增量维护，每次交换只重算两个座位的邻域，O(1)）：
   cost = 1000 × 相邻同班对数 + 10 × 单考场同班超限 + 1 × 考场人数不均衡
6. 按考场序号依次填满；末场可不满，其后考场整场空置
```

**可行性守卫**：容量合计 ≥ 参考人数；单考场单班上限 30 人场 ≤ 9、42 人场 ≤ 12、自定义 = ⌈列/2⌉ × ⌈排/2⌉；每条限定可用座位数 ≥ 该组人数；交集非空。

> 数学背景：座位图是国王图，色数 4；退化到 4 邻域后是二分棋盘图，色数仅 2，**≤8 个班几乎必然可解**。

---

## 12. 可行性诊断与降级

### 12.1 诊断项

全部取值以 `packages/core/src/types.ts` 的 `DiagnosticCode` 为准。单场预检 / 求解（`plan`）与多场次（`planAll`）共用一个码表：

| 代码                            | 级别    | 触发条件                                          | 给老师的说法 / 建议动作                                                   |
| ------------------------------- | ------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| `STUDENT_DUPLICATE_ID`          | error   | 名单里有重复学号                                  | 列出前几个重复学号，请先修名单                                            |
| `STUDENT_MISSING_CLASS`         | error   | 学生没有班级                                      | 班级是 8 邻域约束的基础，必须补                                           |
| `STUDENT_MISSING_NAME`          | warning | 学生没有姓名                                      | 名单里会显示为空                                                          |
| `STUDENT_MISSING_SUBJECTS`      | warning | 多场次模式下有学生没有选科信息                    | 这些学生不会进入任何时段                                                  |
| `UNKNOWN_ROOM_ID`               | error   | 限定引用了不存在的考场                            | 改为「不限考场」或选一个真实考场                                          |
| `UNKNOWN_STUDENT_ID`            | warning | 限定点名了名单里不存在的学生                      | 修正 `studentIds` 或改用选择器                                            |
| `INVALID_ROOM_SIZE`             | error   | 考场行列数不是 ≥1 的整数                          | 修正考场尺寸                                                              |
| `NO_ROOMS` / `NO_STUDENTS`      | error   | 没配考场 / 参考人数为 0                           | 加考场 / 取消排除                                                         |
| `CAPACITY_INSUFFICIENT`         | error   | 参考人数 > 总座位                                 | 还缺 N 个座位：小场改大场(+12) / 加考场 / 多排除 N 人                     |
| `CONSTRAINT_EMPTY_DOMAIN`       | error   | 可用座位集合为空                                  | 「第 3 考场是 6×4，没有第 5 排」→ 改考场 / 改行 / 改列                    |
| `CONSTRAINT_INDEX_OUT_OF_RANGE` | error   | 绝对号在所有候选考场都越界                        | 「第 6 列在候选考场里都不存在」→ 改用「靠窗列」语义值 / 指定一个 6 列考场 |
| `ABSOLUTE_ROWCOL_WITHOUT_ROOM`  | warning | 没指定考场却写了绝对号                            | 将在各类考场分别解析，建议改用语义值（不阻塞）                            |
| `CONSTRAINT_NO_SELECTOR`        | error   | 一条限定没写任何选择器（点名/班级/组合/科目）     | 这条限定不会生效，补一个选择器或删掉                                      |
| `CONSTRAINT_OVERSATURATED`      | error   | 限定可用座位数 < 该组人数（含座位唯一性匹配失败） | 多出的人改考场 / 放宽行或列                                               |
| `RULE_INTERSECT_EMPTY`          | error   | 同一学生多条规则交集为空                          | 「同时指定了第 3 和第 5 考场」→ 删其中一条                                |
| `SEAT_CONFLICT`                 | error   | 两人被指定到同一个座位                            | 「张三和李四都被指定到 2 考场 7 号」→ 改其一                              |
| `CLASS_LIMIT_EXCEEDED`          | error   | 某班超出可用考场容量上限                          | 「高三2班还差 N 个位置」→ 加考场                                          |
| `ROOMS_OVERPROVISIONED`         | info    | 座位明显多于参考人数                              | 「第 26–30 考场将空置」→ 可少配考场                                       |
| `ROOMS_SHARED`                  | warning | 多场次：普通考场不足，多个组合共用考场            | 该考场会拆成多张监考表                                                    |
| `TOO_FEW_CLASSES`               | warning | 班级数 ≤ 8                                        | **非错误**：已自动退化为 4 邻域，`level` 会变成 `orthogonal`              |
| `SEARCH_FAILED`                 | error   | 预检通过但退火后仍有冲突 / 未满足限定             | 见 §12.2，带 evidence 与可一键应用的 suggestions                          |
| `OK`                            | info    | 预检通过                                          | 「预检通过：N 名考生、M 个班、K 个考场」                                  |

每条 `Diagnostic` 都带 `code` / `severity` / `message`（中文人话）/ `evidence` / `suggestions[]`，其中每条 `Suggestion` 带**可机器应用的 `patch`**——这是让 AI 能「自己修好再重跑」的关键。

> 独立校验器 `validate()` 另有一套 `ValidationIssue.code`（字符串，不在 `DiagnosticCode` 里）：
> `ADJACENCY_CONFLICT` / `CONSTRAINT_UNMET` / `ENTRY_*`（座位号、物理列、重复座位/学生、未知考场与考生等）。
> 它是**与求解器分开实现**的第二道防线，导出前必须过。

### 12.2 搜不出来时

报告指出**最紧的地方**：哪个考场哪个班超了多少、冲突座位号、涉及班级，然后给出可一键应用的建议（把该考场改成大考场 / 调走 N 人 / 放宽限定 / 降级重排）。

### 12.3 降级阶梯（必须显式确认）

| 级别              | 内容                           | 触发                            |
| ----------------- | ------------------------------ | ------------------------------- |
| **L0 严格**       | 8 邻域 + 限定硬约束            | 默认                            |
| **L1 四邻域**     | 只要求前后左右不同班           | **班级数 ≤ 8 自动**；否则需确认 |
| **L2 限定软化**   | 限定降为高权重惩罚，求违反最少 | 老师确认                        |
| **L3 最少冲突**   | 允许同班相邻，最小化冲突并标红 | 老师确认                        |
| **L4 结构性建议** | 不降级，改给容量/布局建议      | 自动兜底                        |

降级结果页挂**黄色横幅**，写进 `level` 字段和导出的「校验报告」表，CLI 用退出码 `2` 表达。

---

## 13. 校验与导出

- **独立校验器**（`validate()`，与求解器分开实现）：重验容量、邻域约束、每条限定、编号一致性。任何一条不过 → 拒绝导出。
- **`@exam-seat/io` 单场导出**：
  - `buildPlanWorkbook()` → `考场安排名单.xlsx`，三张表：`考场安排名单`（考场 / 座位号 / 学号 / 姓名 / 班级）、`按班级`、`校验报告`（含是否降级、诊断、冲突与未满足限定）。
  - `buildRoomSheets()` → `考场座位表.xlsx`，逐考场一张网格表，方便贴门口。
- **`@exam-seat/io` 多场次导出**：`buildClassScheduleWorkbook()` → `按班级考场安排.xlsx`（每人一条，考场①②③按需出现，单元格写成「考场名（该生意考的科目）」）；`buildInvigilatorWorkbook()` → `考场监考表.xlsx`（每个「考场 × 考生集合」一张表，表头三行：考场名（科目）/ 地点 / 监考，正文三列：座位号 / 班级 / 姓名）。
- 导出前强制跑一次 `validate()`，这是 CLI 与 Web 共用的安全闸门。CLI 的 `exam-seat validate` 不过就退出码 `3`；网页会先拦一道，老师坚持时只能「仍然导出（仅供人工微调）」并在界面上说清楚。

---

## 14. 技术选型

| 层     | 选型                                                        | 说明                                                                                              |
| ------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 语言   | TypeScript 6.0.x（**不要升 7**）                            | 全仓统一；`core` 出 ESM + CJS + IIFE + `.d.ts`（IIFE 全局名 `ExamSeat`）                          |
| 构建   | **tsdown**（core/io/cli）+ Vite 8（web）                    | `core` 额外出 `index.iife.js`；全仓**不用 tsup**                                                  |
| 包管理 | pnpm 12 workspace                                           | 本地互相 link                                                                                     |
| Web    | Vue 3.5 + Vue Router 5 + Pinia 4 + Element Plus 2           | 纯前端无后端；**localStorage** 持久化，键名前缀 `exam-seat:`；hash 路由                           |
| 表格   | 目前用 `el-table`                                           | **虚拟滚动尚未实现**（1000 行会偏重），议题见 `docs/issues.md`                                    |
| Excel  | SheetJS 0.20.3（`vendor/xlsx-0.20.3.tgz` vendored）         | 只在 `@exam-seat/io` 依赖，core 保持零依赖                                                        |
| CLI    | Node ≥ 22.12（根 `package.json` engines），`bin: exam-seat` | 七个子命令，自带 `--help`，`--json` 时 stdout 只有一个 JSON 对象                                  |
| 并发   | core 同步；web 放 Web Worker                                | 取消 = `worker.terminate()`（`plan()` 是同步纯函数，无法协作式中断）；进度 = 阶段 + 已用时间/上限 |
| 质量   | oxlint + oxfmt + Vitest 5                                   | `pnpm verify` = `lint:check → typecheck → build → test → acceptance`                              |

> 网页端目前只实现**单场**求解（`plan`）。名单带选科时的多场次编排（`planAll`）已经在 core / io / CLI 落地，
> 网页的「场次编排」界面按 `docs/design-selection.md` 的 S7 实施；在此之前网页会在求解页明确提示这一点。

---

## 15. 里程碑

| 阶段 | 内容                                                    | 验收                                          | 状态                    |
| ---- | ------------------------------------------------------- | --------------------------------------------- | ----------------------- |
| M1   | `@exam-seat/core`：模型 + 编号 + 定义域 + 预检 + 校验器 | 单测覆盖，纯函数、零依赖                      | ✅                      |
| M2   | `@exam-seat/core`：贪心 + 模拟退火求解器                | 18 班 1000 人零冲突 < 3 秒                    | ✅                      |
| M3   | `@exam-seat/io` + `@exam-seat/cli`                      | CLI 子命令可用，退出码正确                    | ✅                      |
| M4   | `.agents/skills/exam-seating/`                          | AI 能凭 skill 独立完成 口述 → job.json → 结果 | ✅                      |
| M5   | `@exam-seat/web` 六个步骤页                             | 网页上完成全流程并导出 xlsx                   | ✅                      |
| M6   | job.json 双向互通 + 降级横幅 + 诊断建议一键应用         | 网页 ↔ CLI ↔ AI 三方接力无信息损失            | ✅                      |
| M7   | job.json v2：选科解析、时段推导、分组分房、`planAll`    | 见 `docs/design-selection.md` 的 S1–S8        | S1–S4 ✅ / S5–S8 进行中 |

---

## 16. 已定事项

1. **Core 不发 npm**，只在本仓库内由 pnpm workspace 互相 link。
2. **AI 读 Excel 走 `@exam-seat/io`**，Node 与浏览器同一套代码，不依赖 Python。

---

## 17. 变更记录

| 版本 | 变更                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v5   | 核心包 / CLI / 项目级 Skill 三层交付；job.json 作为唯一契约                                                                                                                                                                                                                                                                                                                |
| v5.1 | **行列限定拆成「语义值」与「绝对号」**：不指定考场时只能用 `first` / `last` / `door` / `window`，由每个考场按自身行列数解析；指定考场后才允许绝对号。新增 §10.1 对照表、§10.4 UI 约束、两个诊断码                                                                                                                                                                          |
| v5.2 | **job.json v2 + 选科与多场次**：新增选科解析（`combination` / `subjects`）、时段推导、分组分房与 `planAll`；限定新增班级 / 组合 / 科目选择器；考场新增 `location` / `dedicatedSubjects`。字段与流程的详细设计见 `docs/design-selection.md`，实施进度见其 §10 与本文 §15 的 M7                                                                                              |
| v5.3 | **文档与实现对齐**：§4 改为真实 API（含 `planAll` / 选科 / 时段，去掉不存在的 `AbortSignal`，UMD 更正为 IIFE）；§5 改为真实子命令与选项（`roster`、`plan --single`、`validate --plan`、`--out-dir` 产物）；§3.2 `plan.json` 按真实类型补全；§9 编号伪代码更正为真实签名；§12.1 补齐全部诊断码；§14 技术选型改为 tsdown / localStorage / Node ≥ 22.12，虚拟滚动标注为未实现 |
