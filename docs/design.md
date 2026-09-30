# 排考场工具 · 设计方案 v6（合并版）

> **本文档是唯一的设计说明**：由原 `design.md`（v5.3）与 `design-selection.md`（选科与多场次，v3 草案）合并重写。
> 后续所有设计变更都改在这里；原来的 `design-selection.md` 已并入本文 §5，不再单独维护。
>
> **实现状态**：`pnpm verify` 全绿 —— lint:check / typecheck（core · io · cli · web）/ build / **177 项单测** / **26 项验收**。
> 单测分布：core 80 ｜ io 23 ｜ cli 6 ｜ web 68。验收场景：990 名考生 / 38 个考场，蛇形编号逐座核对，
> 独立暴力复核 6108 组相邻关系零违规，多场次路径同样逐项断言。
>
> **文档纪律**：文档与实现不一致时，**以代码为准**，并把本文档同步过来（有测试的以测试为准）。
> 没做的东西不许写成事实：要么删掉，要么显式标注「未实现 / 部分完成」，并登记到 `docs/issues.md`。
> `docs/issues.md` 是待办清单，每条都写成可直接交给子代理的任务（现状 → 验收标准 → 约束）。

---

## 0. 实现状态一览

| 能力                                           | 状态      | 证据                                                                                        |
| ---------------------------------------------- | --------- | ------------------------------------------------------------------------------------------- |
| 蛇形编号、行列换算、座位网格                   | ✅ 已完成 | `core/src/numbering.ts`；两张编号图与设计逐座一致（core 单测 + 验收「蛇形编号与设计一致」） |
| 预检 `precheckJob` + 诊断与建议（含 patch）    | ✅ 已完成 | `core/src/precheck.ts`、`core/src/plan.ts`                                                  |
| 单场求解 `plan`（贪心 + 模拟退火 + 独立校验）  | ✅ 已完成 | `core/src/solver.ts`、`core/src/validate.ts`                                                |
| Excel 名单导入 / 三种单场导出                  | ✅ 已完成 | `io/src/index.ts`、`io/src/node.ts`                                                         |
| CLI 七个子命令 + 分级退出码                    | ✅ 已完成 | `cli/src/cli.ts`、`examples/acceptance.mjs`                                                 |
| Web 六个步骤页 + job.json 双向互通             | ✅ 已完成 | `web/src/views/*.vue`、`web/test/*`                                                         |
| job.json v2：选科解析 + `Constraint` 选择器    | ✅ 已完成 | `core/src/subjects.ts`、`core/src/domain.ts`                                                |
| 时段推导 + 分组分房 + `planAll` 多场次         | ✅ 已完成 | `core/src/schedule.ts`、`core/src/plan-all.ts`                                              |
| 多场次两种输出（按班级 / 按考场）              | 🟡 部分   | `io` 两个工作簿已实现；「导出时自动剔除空置考场」未做 → `docs/issues.md`                    |
| CLI 多场次编排                                 | ✅ 已完成 | `plan` 检测到选科自动 `planAll`，`--single` 回退单场                                        |
| Web 场次编排界面                               | ⏳ 未实现 | 网页目前单场求解，界面已明确提示；`docs/issues.md` 议题 2                                   |
| Web 表格虚拟滚动                               | ⏳ 未实现 | 六页用普通 `el-table`；`docs/issues.md` 议题 1                                              |
| 同考场同组合排布倾向 `options.groupPreference` | ⏳ 未实现 | core 不读该字段，网页/CLI 只做「原样保留、往返不丢」                                        |
| AI Skill 覆盖 job.json v2 / 多场次             | ⏳ 未实现 | `SKILL.md` / `reference.md` 里选科 / `planAll` / 多场次 出现 0 次；`docs/issues.md` 议题 3  |

---

## 1. 目标与范围

### 1.1 一句话方案

核心算法是一个**零依赖 JS 包**，网页和命令行都只是它的壳，两者用同一份 `job.json` 作为契约。

- 老师走**网页**：导入名单 → 点选配置 → 看结果 → 导出名单。
- AI 走 **CLI**：把自然语言 / Excel 变成 `job.json` → 调包 → 读结构化诊断 → 转述或修复重跑。
- 排不出来时不甩一句「失败」，而是给出**为什么 + 怎么放宽**的机器可读建议；要退让时**明确标注降级**，绝不静默。

### 1.2 需求确认

| #   | 需求         | 说明                                                                               |
| --- | ------------ | ---------------------------------------------------------------------------------- |
| 1   | Web 应用     | 导入 `.xlsx`，查询排除缺考，可视化配置，导出名单                                   |
| 2   | 核心包       | 算法封装为独立 JS 包，浏览器 / Node 通用，零运行时依赖                             |
| 3   | CLI          | agent 可通过命令行或 import 调用，传选项拿明确结果                                 |
| 4   | Skill        | 项目级 skill，说明这个包能做什么、每个接口什么含义                                 |
| 5   | AI 填参      | 用户口述需求 → AI 理解 → AI 填写参数 → 调包 → 返回结果                             |
| 6   | 限定规则     | **考场限定（单选）** + **行** + **列** + v2 的**班级 / 组合 / 科目选择器**         |
| 7   | 考场配置     | 手动设总数；每个考场「大（6×7=42）/ 小（5×6=30）/ 自定义 行×列」，含地点与专用科目 |
| 8   | 编号规则     | 蛇形；门在右上角，1 号 = 右上角，逐列向左                                          |
| 9   | 列 / 行编号  | 列**从靠门侧起算**（第 1 列 = 靠门列 = 小号列，第 C 列 = 靠窗列）；行从讲台起算    |
| 10  | 硬约束       | 每人单桌，相邻（默认 8 邻域）不得同班                                              |
| 11  | 班级数 < 9   | 自动退化到「前后左右 4 邻域」，明确提示已降级                                      |
| 12  | 无解反馈     | 必须说清为什么排不出来 + 怎么放宽（建议可一键应用）                                |
| 13  | 输出         | **不是座位图，是一份名单**；单场一张名单，多场次按班级 / 按考场两种表              |
| 14  | 选科与多场次 | 名单带选科时自动推导时段、分组分房，常规组合不换考场、非常规组合换一次             |

### 1.3 明确不做（本期）

- **输出 C**（每人对照卡 / 独立校验报告出口）：只做「按班级」「按考场」两种输出。
  `planAll` 的返回值里仍然带 `byStudent` 与校验结论，以后想加只差一个导出函数。
- Core 不发布 npm 包，只在本仓库内由 pnpm workspace 互相 link。

---

## 2. 交付形态与分层

### 2.1 目录结构

```
exam-seat/                          仓库根 = 项目根
├── packages/
│   ├── core/       @exam-seat/core    纯算法，零依赖，浏览器/Node 通用（ESM + CJS + IIFE）
│   ├── io/         @exam-seat/io      Excel 读写（SheetJS），浏览器/Node 通用；Node 专属封装在 ./node
│   ├── cli/        @exam-seat/cli     命令行，bin: exam-seat
│   └── web/        @exam-seat/web     Vue 3 单页应用（Vite）
├── .agents/skills/exam-seating/       ★ AI 用的项目级 skill（随项目打开生效）
│   ├── SKILL.md                       精简入口（渲染后必须 < 8192 字符）
│   ├── reference.md                   完整字段表 + 诊断码表
│   └── examples/job.sample.json
├── examples/                          示例名单、一键验收与冒烟脚本（pnpm acceptance / pnpm smoke）
├── scripts/                           仓库脚本（verifyCommit 等）
└── docs/
    ├── design.md                      本文：唯一的设计说明
    └── issues.md                      未完成事项 / 议题清单（可直接派给子代理）
```

### 2.2 分层原则

`core` 不认识文件、不认识网络、不认识 DOM，只认内存里的对象。Excel 读写归 `io`，终端交互归 `cli`，
界面归 `web`。所以同一份算法能在浏览器和 Node 里跑出**逐字节相同**的结果（同 seed 同输入）。

| 层   | 允许依赖                | 禁止                                 |
| ---- | ----------------------- | ------------------------------------ |
| core | 无（零运行时依赖）      | `node:*`、DOM、任何第三方运行时依赖  |
| io   | `@exam-seat/core`、xlsx | DOM（`./node` 子路径才碰 `node:fs`） |
| cli  | core、io、commander     | 业务规则（只做参数解析、调用、渲染） |
| web  | core、io、Vue 生态      | 自己重写算法语义（一律调 core）      |

### 2.3 唯一契约

`job.json` 是 core / CLI / Web / AI 四者之间**唯一**的交换格式。老师可以在网页里配好再导出交给 AI；
AI 也可以生成 job.json 让老师在网页里打开复核、微调。任何一端都不能私自扩展字段含义：
**新增字段必须在本文档登记**，`core` 是语义的唯一解释者。

---

## 3. job.json：唯一契约

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
    // ⚠️ groupPreference 是 S5 的设计目标，core 目前【不读】；网页与 CLI 会原样保留、往返不丢
    "groupPreference": "sameCombination",
  },

  "students": [
    { "id": "20240101", "name": "张三", "className": "高三(1)班", "included": true },
    // included: false = 本次不参加考试（等价于网页上「排除缺考」）
    // v2 选科（可选）：combination 是原文给老师看，subjects 是 core 规范化后的科目 id
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
    { "id": "R2", "name": "第2考场", "location": "高二一班", "rows": 7, "cols": 6 },
    // v2：专用考场，只接收非常规组合中考了该科目的学生；一个考场可以兼多科
    {
      "id": "R20",
      "name": "第20考场",
      "location": "生物实验室",
      "rows": 6,
      "cols": 5,
      "dedicatedSubjects": ["politics", "geography"],
    },
  ],

  "constraints": [
    // v2 选择器：点名 / 班级 / 组合 / 科目，四者取并集；一个都没写 → CONSTRAINT_NO_SELECTOR
    { "id": "C1", "note": "有作弊前科", "studentIds": ["20240101", "20240215"], "rows": ["first"] },
    { "id": "C2", "note": "物化政全体靠门", "combinations": ["物化政"], "cols": ["door"] },
    { "id": "C3", "note": "高三(3)班首排", "classes": ["高三(3)班"], "rows": ["first"] },
    { "id": "C4", "note": "考政治的靠窗", "subjects": ["politics"], "cols": ["window"] },
    // 限定了考场 → 才允许写绝对行列号（此处 = 第3考场第3排）
    {
      "id": "C5",
      "note": "班主任考场第3排",
      "studentIds": ["20240300"],
      "roomId": "R3",
      "rows": [3],
    },
    // 四角：全用语义值，大小考场都能正确解析
    {
      "id": "C6",
      "note": "四角",
      "studentIds": ["A", "B", "C", "D"],
      "roomId": "R5",
      "rows": ["first", "last"],
      "cols": ["door", "window"],
    },
  ],
}
```

### 3.2 字段语义

**最容易搞错的三个地方**（skill 里要重点写）：

| 字段                             | 语义                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `rows`                           | `"first"` 首排 ｜ `"last"` 末排 ｜ 数字 = 绝对排号（从**讲台**起算，**仅在指定考场时可用**）                                            |
| `cols`                           | `"door"` 靠门列（小号列）｜ `"window"` 靠窗列（大号列，= 该考场最后一列）｜ 数字 = 绝对列号（从**靠门侧**起算，**仅在指定考场时可用**） |
| `roomId`                         | **单选**，不填 = 不限考场                                                                                                               |
| 四个选择器                       | `studentIds` / `classes` / `combinations` / `subjects` 取**并集**；至少写一个                                                           |
| 同校多规则                       | 同一学生被多条规则命中时**取交集**，为空则报错                                                                                          |
| `combination` / `subjects`       | v2 选科：原文 + 规范化科目 id；名单里有选科即进入多场次模式                                                                             |
| `location` / `dedicatedSubjects` | v2 考场：地点（出现在监考表与座位表表头）与专用科目标记                                                                                 |
| `included: false`                | 本次不参加考试，容量校验按「实际参考」算                                                                                                |

> ⚠️ 为什么 `last` / `window` 必须用语义值而不是数字：考场有 5×6 和 6×7 两种，
> **同一个数字在不同考场指向不同位置**。详见 §4.2。

### 3.3 输出 `plan.json`（单场，`PlanResult`）

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
  "diagnostics": [], // 见 §7
  "inputFingerprint": "sha256:...",
  "generatedAt": "2026-09-30T13:05:12+08:00",
}
```

`stats` 与 `diagnostics` 是给 AI 读的；`entries` 是给人和 Excel 用的。
`inputFingerprint` 让网页能判断「当前配置还是不是这份结果对应的配置」。

### 3.4 输出 `planAll`（多场次，`PlanAllResult`）

```ts
interface PlanAllResult {
  ok: boolean;
  slots: TimeSlot[]; // 时段划分（见 §5.3）
  seatings: SeatingPlan[]; // 一套座位方案 = 一个考场里一批固定学生 + 一套固定座位
  byStudent: StudentSchedule[]; // 每人「时段 → 考场 + 座位」
  emptyRooms: string[]; // 一个学生都没安排的考场 → 可以取消
  overRoomLimit: { studentId: string; name: string; count: number }[]; // 考场数 > 3 的学生（正常为空）
  diagnostics: Diagnostic[];
}

interface TimeSlot {
  id: string;
  name: string; // 例如「T4 物理/历史」
  subjects: string[]; // 本时段并行开考的科目
}

interface SeatingPlan {
  subjects: string[]; // 这套座位服务的科目
  roomId: string;
  roomName: string;
  location?: string;
  note?: string; // 监考老师
  studentIds: string[];
  seatNoById: Record<string, number>;
  studentBySeatNo: Record<number, string>; // 监考表要用
  result: PlanResult; // 复用单场求解结果（含冲突、统计、诊断）
}

interface StudentSchedule {
  studentId: string;
  name: string;
  className: string;
  combination: string | null;
  slots: Record<string, StudentSlotAssignment | null>; // null = 这个时段他没考试
  rooms: StudentRoomUsage[]; // 用到的考场，按首次出现顺序
  distinctRooms: number; // 一共用了几个不同考场（硬上限 3）
}
```

`planAll` 内部对每个「座位方案」调用一次单场 `plan`——**没有第二套算法**（见 §6.2）。

---

## 4. 座位编号、行列与限定

### 4.1 座位编号（方案 A）

```
1 号 = 右上角（靠门前角）
→ 沿本列向后到底 → 左移一列 → 从后往前 → 再左移一列 → 从前往后 → …
```

`seatNoToRC` 只按「列」蛇形推进，**返回的是业务列号**（从靠门侧起算，1 = 靠门列）：

```ts
// 真实签名：rows = 排数，cols 只为形状一致，编号本身不需要它
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

> 两张图都是**物理列序**（c1 在最左、门在右），格子里的座位号与 `seatNoToRC` 的业务列是左右镜像关系；
> 网页的座位缩略图就是这么画的。core 单测逐座比对这两张图，验收脚本再核对一次。

### 4.2 为什么行列必须分「语义值」和「绝对号」

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

1. **不限定考场时，行 / 列只能用语义值** `first` / `last` / `door` / `window`。
   求解器按**每个候选考场自己的行列数**解析：「末排」在小考场是第 6 排、大考场是第 7 排；
   「靠窗列」在小考场是第 5 列、大考场是第 6 列。这才是老师真正想表达的意思。
2. **限定了考场时，才允许写绝对号**（`rows: [3]`、`cols: [2]`）。此时已知该考场是几行几列，
   绝对号含义确定，并且会校验越界。

> 这正好解释了为什么绝大多数限定都填「首 / 末」：只有首排、末排、靠门列、靠窗列这四个语义值
> 在大小考场混排时是稳定的。老师想指定「第 3 排第 2 列」时，心里通常已经有一个确定的考场了。

### 4.3 限定数据模型与编译规则

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

编译规则：

```
命中学生(constraint) = studentIds ∪ classes ∪ combinations ∪ subjects      // 并集
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

**越界处理**：绝对号在某考场越界 → 该考场从候选集剔除；所有候选考场都被剔除 → 报错
`CONSTRAINT_INDEX_OUT_OF_RANGE`。选择器解析结果为空 → `CONSTRAINT_NO_SELECTOR`。

### 4.4 UI 约束（不这么做老师一定会填错）

- **未选考场时，行 / 列下拉只列语义值**（首排 / 末排 / 靠门列 / 靠窗列），绝对号输入框直接隐藏；
- **选了考场之后**，才展开「第 N 排 / 第 N 列」，输入范围按该考场的行列数限制；
- 提供**四角一键预设**（自动填 `行=[首,末]`、`列=[靠门,靠窗]`，全是语义值，大小考场通吃）；
- 规则列表把语义值渲染成人话，悬浮提示写清它在各类考场的实际解析，例如：
  「靠窗列 → 5 列考场 = 第 5 列，6 列考场 = 第 6 列」。

典型用法：

| 场景                        | 配置                                                            |
| --------------------------- | --------------------------------------------------------------- |
| 只靠门，不在乎考场          | `cols: ["door"]`                                                |
| 强制到班主任监考的考场      | `roomId: "R3"`                                                  |
| 有作弊前科坐首排            | `rows: ["first"]`                                               |
| 4 人放同考场四角            | `roomId: "R5", rows: ["first","last"], cols: ["door","window"]` |
| 指定第 3 考场第 3 排第 2 列 | `roomId: "R3", rows: [3], cols: [2]`                            |
| 物化政全体靠门              | `combinations: ["物化政"], cols: ["door"]`                      |
| 考政治的考生靠窗            | `subjects: ["politics"], cols: ["window"]`                      |

---

## 5. 选科与多场次排考

> 本章由原 `design-selection.md` 并入。适用前提：名单里带选科（`combination` 或 `subjects`）。
> 没有选科的名单就是普通单场排考，完全不受这一章影响。

### 5.1 总原则

> **常规组合（物化生、政史地）整个考试期间不换考场；只有非常规组合（物化政、物化地）中途换一次。**

这条原则把「多场次耦合优化」退化成**分组 + 分房间**：

- 每个**常规考场 = 一个组合 + 一套座位**，用到底；
- 每个**非常规主考场**同样一套座位用到底（考语数外物化）；
- 再加**政治专用考场**、**地理专用考场**各一套座位。

结果就是：**座位方案的数量 = 考场数量**，一个考场只需要排一次座位。
求解器完全不用改，只是被喂了不同批次的「考生 + 考场 + 限定」。

### 5.2 考场角色与「每人去几个考场」

| 考场角色         | 容纳谁          | 用在哪几个时段                                | 座位方案      |
| ---------------- | --------------- | --------------------------------------------- | ------------- |
| **常规理考场**   | 纯物化生        | T1 语 / T2 数 / T3 外 / T4 物 / T5 化 / T6 生 | 1 套，用 6 次 |
| **常规文考场**   | 纯政史地        | T1 语 / T2 数 / T3 外 / T4 历 / T6 政 / T7 地 | 1 套，用 6 次 |
| **非常规主考场** | 物化政 + 物化地 | T1 语 / T2 数 / T3 外 / T4 物 / T5 化         | 1 套，用 5 次 |
| **政治专用考场** | 只有物化政      | T6 政                                         | 1 套          |
| **地理专用考场** | 只有物化地      | T7 地                                         | 1 套          |

| 组合               | 主考场                | 换考场                 | 合计  |
| ------------------ | --------------------- | ---------------------- | :---: |
| 物化生（常规理）   | 常规理考场，考 6 科   | 无                     | **1** |
| 政史地（常规文）   | 常规文考场，考 6 科   | 无                     | **1** |
| 物化政（非常规理） | 非常规主考场，考 5 科 | T6 政治 → 政治专用考场 | **2** |
| 物化地（非常规理） | 非常规主考场，考 5 科 | T7 地理 → 地理专用考场 | **2** |

「最多三个考场」作为**硬上限校验**：任何学生超过 3 个考场就报警（正常情况下永远触不到，
`planAll().overRoomLimit` 应为空）。

> 默认假设物化政与物化地共用一个非常规主考场（考语数外物化时在一起）；要分开只是配置不同，模型不用改。

### 5.3 时段推导（从冲突关系推导，7 段）

学校只有 4 种组合，「哪些科目能同时考」是能精确推导的，不用人拍脑袋。
**两科能否同时考 = 有没有学生同时选了两科。**

| 组合对                    | 能否同时 | 理由                                              |
| ------------------------- | :------: | ------------------------------------------------- |
| 物理 × 历史               |    ✅    | 首选互斥                                          |
| 生物 × 政治               |    ✅    | 生物只有物化生选，政治是政史地 + 物化政选，无交集 |
| 生物 × 地理               |    ✅    | 同上                                              |
| 政治 × 地理               |    ❌    | 政史地两科都选                                    |
| 化学 × 生物 / 政治 / 地理 |    ❌    | 物化生 / 物化政 / 物化地 分别两科都选             |
| 化学 × 物理               |    ❌    | 三种理科组合都两科选                              |
| 语数外 × 任何             |    ❌    | 全体都考                                          |

推导结果：

| 时段 | 并行科目        | 物化生 | 政史地 | 物化政 | 物化地 |
| ---- | --------------- | ------ | ------ | ------ | ------ |
| T1   | 语文            | 语文   | 语文   | 语文   | 语文   |
| T2   | 数学            | 数学   | 数学   | 数学   | 数学   |
| T3   | 外语            | 外语   | 外语   | 外语   | 外语   |
| T4   | **物理 / 历史** | 物理   | 历史   | 物理   | 物理   |
| T5   | 化学            | 化学   | —      | 化学   | 化学   |
| T6   | **生物 / 政治** | 生物   | 政治   | 政治   | —      |
| T7   | 地理            | —      | 地理   | —      | 地理   |

「—」就是缺考。**化学必须独占一段**：它和生物 / 政治 / 地理 / 物理全冲突，只剩历史不冲突，
而历史已与物理配对，所以 7 段是最少的。

**硬校验：同一个学生在同一个时段最多只能有一场考试。**

> 这个 7 段表由程序**自动推导**（按冲突关系做图着色，`deriveTimeSlots`），不写死；
> 学校以后新增组合，重新推导即可。也允许老师手工覆盖。

### 5.4 排考流程

```
① 读名单 → 解析选科 → 校验 3+1+2（首选 1 门、再选 2 门）
② 按组合把学生分组：物化生 / 政史地 / 物化政 / 物化地
③ 分组分房间：
     物化生 → 若干「常规理考场」（每组一套座位）
     政史地 → 若干「常规文考场」
     物化政 + 物化地 → 若干「非常规主考场」
   分组时优先让同一个行政班的学生分散（避免同班扎堆）
④ 每个房间排一次座位（现有求解器，输入 = 该房间的学生 + 该房间的全部时段科目）
⑤ 专用考场：
     物化政全体 → 政治专用考场（排一次座位）
     物化地全体 → 地理专用考场（排一次座位）
⑥ 汇总：每人一张「时段 → 考场 + 座位号」表
⑦ 校验：每人考场数 ≤ 3；同时段不撞场；8 邻域不同班
```

**关键点：每一步都只是「把一批考生喂给现有求解器」**，没有新算法。
第 ④ 步里「8 邻域不能同班」的约束，在跨组合混排时依然成立（同班同学可能选不同科）。

分房策略：优先让每个组合独占考场（监考表最干净）；考场不够时退让为「先填满当前考场再换下一个」，
尾房可能混两个组合 —— 该考场会拆成多张监考表，并给出 `ROOMS_SHARED` 警告。

### 5.5 考场的地点与专用科目

```ts
interface RoomSpec {
  id: string;
  name?: string; // 「第一考场」
  location?: string; // 「高二一班」「生物实验室」，老师自己填
  rows: number;
  cols: number;
  doorSide?: "left" | "right";
  note?: string; // 监考老师
  dedicatedSubjects?: string[]; // 专用科目，例如 ["politics", "geography"]
}
```

- `location` 出现在：监考表表头、座位网格表、网页考场配置页。
- **专用考场手工指定**：在考场配置里给考场打「专用科目」标记，工具把选了该科目的**非常规考生**
  整体安排进去。政治在 T6、地理在 T7，时间不冲突，**同一个房间可以既当政治专用又当地理专用**。
- **空考场取消**：排完之后如果某个考场一个学生都没安排上，`planAll` 会在 `emptyRooms` 里点名列出，
  CLI 也会打印「可取消的空置考场」。
  🟡 遗留：「导出时自动把它们从名单里去掉」与网页按结果的一键移除尚未实现（见 `docs/issues.md`）。

### 5.6 输出 A / 输出 B

**输出 A：按班级（给学生和班主任）** —— `按班级考场安排.xlsx`

| 班级      | 姓名 | 考场①                    | 考场②                | 考场③ |
| --------- | ---- | ------------------------ | -------------------- | ----- |
| 高三(1)班 | 张伟 | 第一考场（语数外物化生） |                      |       |
| 高三(7)班 | 李娜 | 第三考场（语数外物化）   | 第二十考场（政治）   |       |
| 高三(9)班 | 王强 | 第五考场（语数外物化）   | 第二十一考场（地理） |       |

- 三个「考场」列**按需出现**：全年级没人用到第③列就不输出第③列。
- 单元格 = `考场名（这个学生在该考场考的科目）`。
- **②③列只对需要换考场的人有值**，班主任一眼看到「我班哪几个人要换、换去哪」。
- 表尾附**按班级小计**：每班需要换考场的人数。

**输出 B：按考场（给监考老师）** —— `考场监考表.xlsx`

**分组规则：同一考场 × 同一批考生的时段合并成一张表。**

| 情形                   | 出几张                                                            |
| ---------------------- | ----------------------------------------------------------------- |
| 常规理考场（纯物化生） | **1 张**：「第一考场（语数外物化生）」                            |
| 常规文考场（纯政史地） | **1 张**：「第二考场（语数外历政地）」                            |
| 非常规主考场           | **1 张**：「第三考场（语数外物化）」                              |
| 政治专用考场           | **1 张**：「第二十考场（政治）」                                  |
| 地理专用考场           | **1 张**：「第二十一考场（地理）」                                |
| 万一某考场混了组合     | 按考生集合拆分，如「第一考场（语数外物化）」+「第一考场（生物）」 |

每张表的格式：

```
第一考场（语数外物化生）      地点：高二一班      监考：张老师
座位号 | 班级        | 姓名
  1    | 高三(1)班   | 张伟
  2    | 高三(5)班   | 李娜
  …
```

- 表头三行：`考场名（科目）` / 地点 / 监考；
- 正文三列：**座位号 | 班级 | 姓名**；
- 一个工作簿里每个 (考场, 考生集合) 一个 sheet。

**输出 C：本期不做**（每人对照卡 / 校验报告）。`planAll` 已经返回 `byStudent` 与校验结论，
以后想加只差一个导出函数。

### 5.7 实施进度（S1–S8）

> 核对时间：2026-09-30。基线：`pnpm verify` 全绿（**177 项单测 / 26 项验收**）。
> 「依据」一列是可以直接去核对的代码与测试文件。

| 阶段 | 内容                                                        | 状态      | 依据（代码 / 测试）                                                                                                                                                                                                                                                                                                                                |
| ---- | ----------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | 选科解析（`物化政` 简写）+ 3+1+2 校验 + `Constraint` 选择器 | ✅ 已完成 | `core/src/subjects.ts`；`core/src/domain.ts` 的 `hasAnySelector` / `resolveConstraintStudents`；`core/test/subjects.test.ts`（19 项）；网页 `web/test/constraint-selectors.test.ts`（4 项，与 core 语义逐条对齐）                                                                                                                                  |
| S2   | 预检 / 求解改用「选择器 → 学生集合」                        | ✅ 已完成 | `ConstraintSeatSet.studentIndices` → `compileDomains` 用它建定义域；预检新增 `CONSTRAINT_NO_SELECTOR`；`core/test/core.test.ts` 有多处选择器用例                                                                                                                                                                                                   |
| S3   | 时段自动推导（按冲突关系图着色）                            | ✅ 已完成 | `core/src/schedule.ts`（`buildConflictGraph` / `deriveTimeSlots` / `findSlotConflicts` / `subjectInSlot`）；`core/test/schedule.test.ts`（11 项）；验收断言「时段数 = 7」                                                                                                                                                                          |
| S4   | `location` / `dedicatedSubjects` + 分组分房 + `planAll`     | ✅ 已完成 | `core/src/plan-all.ts`、`core/src/types.ts`；`core/test/plan-all.test.ts`（18 项）；`io/test/schedule-export.test.ts`（12 项）；CLI `plan` 自动走多场次                                                                                                                                                                                            |
| S5   | 同考场同组合的排布倾向（`options.groupPreference`）         | ⏳ 未开始 | 全仓搜不到 core 读取 `groupPreference` 的代码；网页与 CLI 只是**原样保留**这个字段（往返不丢，见 `web/src/lib/job.ts` 的 `mergeOptions`）                                                                                                                                                                                                          |
| S6   | 输出 A / B（C 本期不做）+ 空考场取消                        | 🟡 部分   | 已有：`io/src/index.ts` 的 `buildClassScheduleWorkbook`（按班级考场安排.xlsx）与 `buildInvigilatorWorkbook`（考场监考表.xlsx）、`planAll().emptyRooms`、CLI 打印「可取消的空置考场」、验收断言「空置考场会被列出（便于取消）」。**缺**：导出时自动剔除空置考场；网页按**求解结果**的一键移除（网页现在只有排考前按容量预测的「删掉会空置的考场」） |
| S7   | CLI 场次编排 + Web 第 ⑤ 步「场次编排」                      | 🟡 部分   | 已有：CLI `plan` 在名单带选科时自动 `planAll`，`--single` 回退单场（验收有断言）。**缺**：网页的场次界面与两个多场次工作簿导出——网页目前按单场求解，并在求解页明确提示改用 CLI，见 `docs/issues.md` 议题 2                                                                                                                                         |
| S8   | Skill 更新（job.json v2 / 多场次）+ 验收脚本扩展            | 🟡 部分   | 已有：`examples/acceptance.mjs` 的 26 项里有约 16 项覆盖选科/多场次（四种组合、7 时段、专用考场、两个 xlsx 导出、空置考场列出、`--single` 回退）。**缺**：`SKILL.md` 与 `reference.md` 里 `选科` / `planAll` / `多场次` / `dedicatedSubjects` 出现 **0 次**——AI 走 skill 时不知道 job.json v2 的存在，见 `docs/issues.md` 议题 3                   |

---

## 6. 求解算法

### 6.1 单场：带定义域的分配问题

每个学生有可用座位集合，每座位至多 1 人，目标为「同考场内相邻（默认切比雪夫距离 1）的两个座位班级不同」。
规模约 1000 人 / 30 考场。

```
1. 建座位表（蛇形编号）
2. 算定义域：学生 → 可用座位集合（选择器 + rows/cols 编译出来的结果）
3. 贪心初始解：按定义域大小升序处理（MRV），挑邻居已用班级最少的座位
4. 模拟退火：
   move A 同考场内交换两人（主力）
   move B 跨考场交换两人（调整班级分布）
   交换后两人必须仍落在各自定义域内
5. 成本（增量维护，每次交换只重算两个座位的邻域，O(1)）：
   cost = 1000 × 相邻同班对数 + 10 × 单考场同班超限 + 1 × 考场人数不均衡
6. 按考场序号依次填满；末场可不满，其后考场整场空置
```

**可行性守卫**：容量合计 ≥ 参考人数；单考场单班上限 30 人场 ≤ 9、42 人场 ≤ 12、
自定义 = ⌈列/2⌉ × ⌈排/2⌉；每条限定可用座位数 ≥ 该组人数；交集非空。

> 数学背景：座位图是国王图，色数 4；退化到 4 邻域后是二分棋盘图，色数仅 2，**≤8 个班几乎必然可解**。

### 6.2 多场次 = 多次调用同一个求解器

`planAll` 不含新算法：它做的是「分组 → 分房 → 每个座位方案调一次 `plan` → 汇总 `byStudent`」。
所以单场的所有保证（可复现、诊断、独立校验）在多场次里同样成立，每个 `SeatingPlan.result` 都是一份完整 `PlanResult`。

### 6.3 可复现性

- `core` 全同步纯函数，**同输入同 seed 必得同结果**（验收脚本有「同 seed 结果可复现」断言）；
- 随机来源只有 `mulberry32(seed)`，不用 `Math.random`；
- `inputFingerprint`（canonical JSON 的 sha256）用于判断结果是否还对应当前输入。

---

## 7. 诊断与降级

### 7.1 诊断码全表

全部取值以 `packages/core/src/types.ts` 的 `DiagnosticCode` 为准；单场与多场次共用一个码表。

| 代码                            | 级别    | 触发条件                                          | 给老师的说法 / 建议动作                                      |
| ------------------------------- | ------- | ------------------------------------------------- | ------------------------------------------------------------ |
| `STUDENT_DUPLICATE_ID`          | error   | 名单里有重复学号                                  | 列出前几个重复学号，请先修名单                               |
| `STUDENT_MISSING_CLASS`         | error   | 学生没有班级                                      | 班级是相邻约束的基础，必须补                                 |
| `STUDENT_MISSING_NAME`          | warning | 学生没有姓名                                      | 名单里会显示为空                                             |
| `STUDENT_MISSING_SUBJECTS`      | warning | 多场次模式下有学生没有选科信息                    | 这些学生不会进入任何时段                                     |
| `UNKNOWN_ROOM_ID`               | error   | 限定引用了不存在的考场                            | 改为「不限考场」或选一个真实考场                             |
| `UNKNOWN_STUDENT_ID`            | warning | 限定点名了名单里不存在的学生                      | 修正 `studentIds` 或改用选择器                               |
| `INVALID_ROOM_SIZE`             | error   | 考场行列数不是 ≥1 的整数                          | 修正考场尺寸                                                 |
| `NO_ROOMS` / `NO_STUDENTS`      | error   | 没配考场 / 参考人数为 0                           | 加考场 / 取消排除                                            |
| `CAPACITY_INSUFFICIENT`         | error   | 参考人数 > 总座位                                 | 还缺 N 个座位：小场改大场(+12) / 加考场 / 多排除 N 人        |
| `CONSTRAINT_EMPTY_DOMAIN`       | error   | 可用座位集合为空                                  | 「第 3 考场是 6×4，没有第 5 排」→ 改考场 / 改行 / 改列       |
| `CONSTRAINT_INDEX_OUT_OF_RANGE` | error   | 绝对号在所有候选考场都越界                        | 改用「靠窗列」语义值 / 指定一个 6 列考场                     |
| `ABSOLUTE_ROWCOL_WITHOUT_ROOM`  | warning | 没指定考场却写了绝对号                            | 将在各类考场分别解析，建议改用语义值（不阻塞）               |
| `CONSTRAINT_NO_SELECTOR`        | error   | 一条限定没写任何选择器                            | 这条限定不会生效，补一个选择器或删掉                         |
| `CONSTRAINT_OVERSATURATED`      | error   | 限定可用座位数 < 该组人数（含座位唯一性匹配失败） | 多出的人改考场 / 放宽行或列                                  |
| `RULE_INTERSECT_EMPTY`          | error   | 同一学生多条规则交集为空                          | 「同时指定了第 3 和第 5 考场」→ 删其中一条                   |
| `SEAT_CONFLICT`                 | error   | 两人被指定到同一个座位                            | 改其一                                                       |
| `CLASS_LIMIT_EXCEEDED`          | error   | 某班超出可用考场容量上限                          | 「高三2班还差 N 个位置」→ 加考场                             |
| `ROOMS_OVERPROVISIONED`         | info    | 座位明显多于参考人数                              | 「第 26–30 考场将空置」→ 可少配考场                          |
| `ROOMS_SHARED`                  | warning | 多场次：普通考场不足，多个组合共用考场            | 该考场会拆成多张监考表                                       |
| `TOO_FEW_CLASSES`               | warning | 班级数 ≤ 8                                        | **非错误**：已自动退化为 4 邻域，`level` 会变成 `orthogonal` |
| `SEARCH_FAILED`                 | error   | 预检通过但退火后仍有冲突 / 未满足限定             | 见 §7.2，带 evidence 与可一键应用的 suggestions              |
| `OK`                            | info    | 预检通过                                          | 「预检通过：N 名考生、M 个班、K 个考场」                     |

每条 `Diagnostic` 都带 `code` / `severity` / `message`（中文人话）/ `evidence` / `suggestions[]`，
其中每条 `Suggestion` 带**可机器应用的 `patch`**（JSON Patch：add / remove / replace）——
这是让 AI 能「自己修好再重跑」的关键，也是网页「一键应用建议」的实现方式。

### 7.2 搜不出来时

报告指出**最紧的地方**：哪个考场哪个班超了多少、冲突座位号、涉及班级，
然后给出可一键应用的建议（把该考场改成大考场 / 调走 N 人 / 放宽限定 / 降级重排）。
`SEARCH_FAILED` 的 `evidence` 里给 `bottleneck`（逐考场的班级负载）、`conflicts`、`unmetConstraints`。

### 7.3 降级阶梯（必须显式确认）

| 级别              | 内容                           | 触发                            |
| ----------------- | ------------------------------ | ------------------------------- |
| **L0 严格**       | 8 邻域 + 限定硬约束            | 默认                            |
| **L1 四邻域**     | 只要求前后左右不同班           | **班级数 ≤ 8 自动**；否则需确认 |
| **L2 限定软化**   | 限定降为高权重惩罚，求违反最少 | 老师确认                        |
| **L3 最少冲突**   | 允许同班相邻，最小化冲突并标红 | 老师确认                        |
| **L4 结构性建议** | 不降级，改给容量/布局建议      | 自动兜底                        |

降级结果页挂**黄色横幅**，写进 `level` 字段和导出的「校验报告」表，CLI 用退出码 `2` 表达。
L2/L3 **只把「限定太紧」降级为惩罚**；结构性错误（座位不够等）仍然判死。

### 7.4 校验器的码（`ValidationIssue.code`，字符串）

独立校验器与求解器**分开实现**，它的码不在 `DiagnosticCode` 里：

- `ADJACENCY_CONFLICT`、`CONSTRAINT_UNMET`
- `ENTRY_*`：`ENTRY_DUPLICATE_SEAT`、`ENTRY_DUPLICATE_STUDENT`、`ENTRY_MISSING_STUDENT`、
  `ENTRY_NUMBERING_MISMATCH`、`ENTRY_PHYSICAL_COL_MISMATCH`、`ENTRY_SEAT_OUT_OF_RANGE`、
  `ENTRY_UNKNOWN_ROOM`、`ENTRY_UNKNOWN_STUDENT`

---

## 8. 校验与导出

- **独立校验器**（`validate(job, result)`，与求解器分开实现）：重验容量、邻域约束、每条限定、编号一致性。
  任何一条不过 → 拒绝导出。
- **单场导出**（`@exam-seat/io`）：
  - `buildPlanWorkbook()` → `考场安排名单.xlsx`，三张表：`考场安排名单`（考场 / 座位号 / 学号 / 姓名 / 班级）、
    `按班级`、`校验报告`（含是否降级、诊断、冲突与未满足限定）；
  - `buildRoomSheets()` → `考场座位表.xlsx`，逐考场一张网格表，方便贴门口。
- **多场次导出**：
  - `buildClassScheduleWorkbook()` → `按班级考场安排.xlsx`（见 §5.6 输出 A）；
  - `buildInvigilatorWorkbook()` → `考场监考表.xlsx`（见 §5.6 输出 B）。
- 导出前强制跑一次 `validate()`，这是 CLI 与 Web 共用的安全闸门。CLI 的 `exam-seat validate` 不过就退出码 `3`；
  网页会先拦一道，老师坚持时只能「仍然导出（仅供人工微调）」并在界面上说清楚。

---

## 9. CLI

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
| 单场 / 多场 | 名单里带选科（`combination` 或 `subjects`）自动走 `planAll`；`--single` 强制按单场处理                                                    |

退出码让 agent 能直接分支：拿到 `3` 就去读 `diagnostics[].suggestions`，拿到 `2` 就把 `level` 明确告诉用户。

`--spec` 语法刻意做得紧凑，方便 AI 拼：`1-20:small`（5×6=30）、`21-25:large`（6×7=42）、`26:6x4`（自定义）。

---

## 10. Web 应用

### 10.1 步骤条与数据流

六个步骤页由 `el-steps` 串起来，路由用 **hash**（纯静态托管甚至 `file://` 都能打开）：

```
导入名单 → 排除缺考 → 配置考场 → 设置限定 → 排考场 → 结果名单
                          ↕ 导入 / 导出 / 粘贴 job.json
```

状态用 Pinia 分成五个 store：`roster`（名单 + 排除）、`rooms`（考场）、`constraints`（限定）、
`options`（标题 / seed / 邻接 / 降级 / 时间上限）、`result`（结果 + 校验报告）。
每个 store 自己 `watch` 到 localStorage（键名前缀 `exam-seat:`），刷新不丢。

### 10.2 六个步骤页

**① 导入名单**
拖拽 / 选择 `.xlsx` → `readRoster` 解析；多表选表；列映射向导（`学号` / `姓名` / `班级` 必填，
`性别` / `选科` / `备注` 选填，可随时手改，改完立刻重解析，并保住已排除状态）；
列出问题行（重复学号、缺班级等）；顶部统计总人数 / 班级数 / 各班人数；
名单里带选科时另外给出**选科组合分布**，并提示多场次编排的现状。

**② 排除缺考**
表格 + 搜索（学号 / 姓名 / 班级，多条件模糊匹配，支持 `班级:高三(1)班` 这种字段限定）。
主路径：**查询 → 全选当前结果 → 批量排除**。被排除行置灰打「不参加」标签，抽屉可单条 / 全部恢复。
底部实时显示「应考 / 已排除 / **实际参考**」，容量校验一律按实际参考算。
排除状态就是 `Student.included = false`。

**③ 配置考场**
每行一个考场：名称、类型（大 6×7=42 / 小 5×6=30 / 自定义 行×列）、门的位置（默认靠右）、
备注（监考老师）、**地点**、**专用科目**（v2，可兼多科）。支持批量新建、上下移、重排考场号。
容量不足红字告警「还缺 N 个座位」并给「补 N 个大考场」按钮；容量过剩提示哪些考场会整场空置，
给「删掉会空置的考场」按钮。每个考场配**座位编号缩略图**（按物理列序画、门在右侧，所见即所得）。

**④ 设置限定**
筛选学生（复用同一套搜索）→ 勾选 → 添加限定。弹窗里：

- 考场限定（**单选**下拉，显示「第3考场（张老师）」）；
- 排 / 列：**没选考场时只列语义值，绝对号输入框整个隐藏**；选了考场才展开绝对号，`max` 绑该考场行列数；
- 「一键四角」预设（`行=[首,末]`、`列=[靠门,靠窗]`）；
- v2 选择器：**按班级 / 按组合 / 按科目**，与点名取并集，实时显示「命中 N 人」；
- 实时预览：可用座位总数、逐考场分布、语义值在各类考场的解析、选中考场的座位网格高亮。

规则列表可编辑 / 删除，用 `precheckJob` 做实时冲突检测，冲突项红字标出原因，
带建议的冲突可以「应用建议」直接改配置。

**⑤ 排考场**
先 `precheckJob`：有致命问题就停在这一页，原样展示 `diagnostic.message`，
并把 `suggestions[]` 渲染成按钮（点了就把其中的 JSON Patch 应用到 job 再自动重跑预检）。
预检通过后用 **Web Worker** 跑 `plan`，显示进度与已用时间，可取消；结果三态：
**完美**（`ok && level === "strict"`）/ **已降级**（黄色横幅标注 `level` 与原因）/ **排不出来**（诊断 + 建议）。
名单带选科时页面明确提示：多场次界面仍在实施中，本页按单场求解，需要多场次请用 CLI。

**⑥ 结果名单**
主输出就是名单表格：考场 / 座位号 / 学号 / 姓名 / 班级，按 `考场号 → 座位号` 升序；
可按班级、考场筛选，可搜「某人坐哪」；附**校验报告**摘要（`validate()` 的结论、冲突明细、未满足限定、诊断）；
导出 `考场安排名单.xlsx`（导出前校验不过会拦一道，只能二次确认强制导出）。
当配置改过、与结果的数据指纹不一致时，页面顶部提示「这份结果是旧配置算出来的，建议重排」。
座位网格只作页面预览。

### 10.3 job.json 双向互通与持久化

- **导出 job.json**：把当前配置拼成完整 v2 job（`jobVersion: 2`，含选科、地点、专用科目、选择器）；
- **导入 job.json**：文件选择或直接粘贴（方便把 AI 生成的 job 贴回来复核），解析失败给中文原因；
- **无损**：v2 字段、甚至 core 还不认识的 `options` 字段（如 `groupPreference`）都原样保留，往返不丢；
- **回灌**：诊断建议应用后会把整份 job 写回各个 store，保证「界面看到的 = 求解器看到的」；
- **持久化**：`localStorage`，键名前缀 `exam-seat:`；清空数据会把本应用的键全删掉（不动同域其它键）。

### 10.4 未实现（指向 `docs/issues.md`）

- **表格虚拟滚动**（议题 1）：六页目前用普通 `el-table`，1000 行时会偏重；
- **场次编排界面**（议题 2）：多场次目前在网页上只能靠 CLI 完成。

---

## 11. AI Skill

**位置（项目级，随项目打开生效）**：`.agents/skills/exam-seating/SKILL.md`

DSH 的发现规则：扫描根目录下的**直接子项**，`<name>/SKILL.md` 目录包或 `<name>.md` 平铺文件，
`name` 必须 kebab-case；嵌套 `**/SKILL.md` **不会**被发现。frontmatter 必填 `name` 与 `description`。

**容量约束**：`SKILL.md` 渲染后必须 < 8192 字符（当前约 5.5 KB），所以：

- `SKILL.md` 只放**入口信息和最短路径**（何时用、三步工作流、CLI 速查、高频坑位）；
- 完整字段表、诊断码全表、边界规则放进同目录 `reference.md`，由 SKILL.md 指路；
- 示例放进 `examples/job.sample.json`。

**三步工作流**：

1. **建模**：把用户的自然语言 / Excel 名单变成 `job.json`。名单用 office-xlsx skill 或 `@exam-seat/io` 读；
   需求翻译成 `rooms` 与 `constraints`。
2. **调用**：`exam-seat plan --job job.json --out-dir out --json`，读 stdout 的 JSON。
3. **解释与修复**：读 `diagnostics[]`（中文 `message` + `evidence` + 可应用的 `suggestions[].patch`）；
   `ok:false` 或 `level != "strict"` 时**必须先告诉用户**，不能默默交付。

**必须写死的坑位**：

- 列号**从靠门侧**起算，第 1 列 = 靠门列；不是从左往右。
- 考场限定是**单选**，不能给一个学生配多个考场。
- 同一学生多条限定**取交集**，不是覆盖。
- 班级数 ≤ 8 会**自动降级**为 4 邻域，`level` 变成 `orthogonal`，必须向用户说明。
- 输出是**名单**（考场 + 座位号），不是座位图。
- 名单带选科 ⇒ 自动多场次；交付物是「按班级考场安排.xlsx + 考场监考表.xlsx」；
  常规组合全程不换考场，非常规组合中途换一次；`--single` 才回到单场。
- 专用考场用 `dedicatedSubjects` 手工指定（可兼多科），只收非常规组合中考了该科目的学生。

> 🟡 **现状**：`SKILL.md` 与 `reference.md` 里还没有任何 v2 / 多场次内容
> （`选科`、`planAll`、`多场次`、`dedicatedSubjects` 出现 0 次）。这是目前最容易让 AI 走错路的信息缺口，
> 已登记为 `docs/issues.md` 议题 3。

---

## 12. Core API 参考

`packages/core/src/index.ts` 的对外导出（分组列出）：

```ts
// 主流程
precheckJob(job, overrides?)                     // 预检：只判定可行性 + 诊断 + 建议
plan(job, overrides?)                            // 单场求解：同步纯函数
planAll(job, overrides?)                         // 多场次：分组分房 + 逐房间求解
validate(job, result)                            // 独立校验器（与求解器分开实现）
isFatal(diagnostics)                             // 有没有 error 级诊断
normalizeOptions(options?)                       // 补齐默认选项
DEFAULT_SEED / DEFAULT_TIME_LIMIT_MS / RESULT_VERSION

// 选科（v2）
parseCombination(text) / normalizeCombination(text) / formatCombination(subjects)
validateSelection(subjects) / hasSubject(...) / subjectLabel(id) / subjectListLabel(subjects)
CORE_SUBJECTS / PREFERRED_SUBJECTS / SECONDARY_SUBJECTS / SUBJECT_LABELS / SUBJECT_SHORT / COMBINATION_ORDER

// 时段推导（多场次）
buildConflictGraph(combinations) / deriveTimeSlots(...) / findSlotConflicts(...) / subjectInSlot(...)

// 模型与定义域
compileModel(job, adjacency?)                    // Job → 扁平结构（座位表、邻接表、班级编号）
compileDomains(model)                            // 选择器与限定 → 每个学生的可用座位集合
compileConstraintSeats(model, constraint)        // 单条限定 → 座位集合 + 命中的学生
hasAnySelector(constraint) / resolveConstraintStudents(model, constraint)
checkSeatMatching(domains, seatCount)            // 只用匈牙利算法查「座位唯一性」能否满足

// 编号与布局
seatNoToRC(seatNo, rows, cols) / rcToSeatNo(row, col, rows, cols)
toPhysicalCol(col, cols, doorSide?) / roomCapacity(room) / maxSameClass(room, adjacency?)
resolveRowRef(room, ref) / resolveColRef(room, ref)
seatId(roomId, seatNo) / parseSeatId(id) / describeRows(rows) / describeCols(cols)

// 预检内部（也对外，便于 UI 复用）
runPrecheck(model, ctx) / resolveAdjacency(job, requested?, forceKing?) / describeRoomLoad(model, seatOwner)
MIN_CLASSES_FOR_KING

// 求解器底层（一般不用直接调）
solve(input) / collectConflicts(...)

// 工具
canonicalJson(value) / fingerprint(job) / mulberry32(seed)
```

**设计约束**：

- 零运行时依赖，不碰 `fs` / `path` / `document`，浏览器直接可用；
- 纯同步函数；超时通过 `options.timeLimitMs` 控制（**没有** `AbortSignal`：`plan()` 是同步的，
  Web 端靠「终止 Worker」表达取消，见 §13）；
- `plan()` / `planAll()` **不用抛异常表达业务失败**；失败信息一律走 `diagnostics`，异常只留给编程错误；
- 构建产出 **ESM + CJS + IIFE**（`packages/core/dist/index.iife.js`，`globalName: ExamSeat`），
  方便网页里 `<script>` 直接引入。

---

## 13. 技术选型与工程化

| 层     | 选型                                                | 说明                                                                     |
| ------ | --------------------------------------------------- | ------------------------------------------------------------------------ |
| 语言   | TypeScript 6.0.x（**不要升 7**）                    | 全仓统一；`core` 出 ESM + CJS + IIFE + `.d.ts`（IIFE 全局名 `ExamSeat`） |
| 构建   | **tsdown**（core / io / cli）+ Vite 8（web）        | 全仓**不用 tsup**                                                        |
| 包管理 | pnpm 12 workspace                                   | 本地互相 link；Node ≥ 22.12                                              |
| Web    | Vue 3.5 + Vue Router 5 + Pinia 4 + Element Plus 2   | 纯前端无后端；**localStorage** 持久化（键前缀 `exam-seat:`）；hash 路由  |
| 表格   | 目前用 `el-table`                                   | 🟡 **虚拟滚动尚未实现**（1000 行会偏重），议题见 `docs/issues.md`        |
| Excel  | SheetJS 0.20.3（`vendor/xlsx-0.20.3.tgz` vendored） | 只在 `@exam-seat/io` 依赖，core 保持零依赖                               |
| CLI    | Node ≥ 22.12，`bin: exam-seat`                      | 七个子命令，自带 `--help`，`--json` 时 stdout 只有一个 JSON 对象         |
| 并发   | core 同步；web 放 Web Worker                        | 取消 = `worker.terminate()`；进度 = 阶段 + 已用时间 / 上限               |
| 质量   | oxlint + oxfmt + Vitest 5                           | `pnpm verify` = `lint:check → typecheck → build → test → acceptance`     |

工程化细节：

- `examples/acceptance.mjs`（26 项）是**端到端验收**：真的调 CLI、读 Excel、跑多场次、核对相邻关系、比对导出文件；
- husky 钩子：`pre-commit` 跑 `nano-staged`（oxfmt + oxlint --fix），`commit-msg` 跑 `scripts/verifyCommit.ts`
  校验提交信息格式（`<type>(<scope>): <subject>`，type 见脚本，scope 必须是包名或 deps / release，标题 ≤ 50 字符）；
- GitHub Actions：`ci.yml`（lint / typecheck / build / test / acceptance）与 `codeql.yml`；Renovate 管依赖。

---

## 14. 里程碑与进度总表

| 里程碑 | 内容                                            | 验收                                          | 状态                |
| ------ | ----------------------------------------------- | --------------------------------------------- | ------------------- |
| M1     | `core`：模型 + 编号 + 定义域 + 预检 + 校验器    | 单测覆盖，纯函数、零依赖                      | ✅ 已完成           |
| M2     | `core`：贪心 + 模拟退火求解器                   | 18 班 1000 人零冲突 < 3 秒                    | ✅ 已完成           |
| M3     | `io` + `cli`                                    | 子命令可用，退出码正确                        | ✅ 已完成           |
| M4     | `.agents/skills/exam-seating/`                  | AI 能凭 skill 独立完成 口述 → job.json → 结果 | ✅ 已完成           |
| M5     | `web` 六个步骤页                                | 网页上完成全流程并导出 xlsx                   | ✅ 已完成           |
| M6     | job.json 双向互通 + 降级横幅 + 诊断建议一键应用 | 网页 ↔ CLI ↔ AI 三方接力无信息损失            | ✅ 已完成           |
| M7     | job.json v2：选科、时段、分组分房、`planAll`    | 见 §5.7 的 S1–S8                              | S1–S4 ✅ / S5–S8 🟡 |

**待办（按建议执行顺序）**：① S8 skill 补 v2（`docs/issues.md` 议题 3）→
② Web 表格虚拟滚动（议题 1）→ ③ Web 场次编排（议题 2）→ ④ S5 `groupPreference` → ⑤ S6 空考场取消。

---

## 15. 已定事项

1. **Core 不发 npm**，只在本仓库内由 pnpm workspace 互相 link。
2. **AI 读 Excel 走 `@exam-seat/io`**，Node 与浏览器同一套代码，不依赖 Python。
3. **输出只做两种**：按班级（学生 / 班主任）、按考场（监考老师）；第三种本期不做。
4. **专用考场手工指定**：在考场配置里给考场打「专用科目」标记（`dedicatedSubjects`），可兼多科。
5. **常规组合全程不换考场**；只有非常规组合中途换一次（§5.1）。
6. **空考场自动上报可取消**（`planAll().emptyRooms`）。
7. **job.json 是唯一契约**，字段语义只由 core 解释；网页与 CLI 不得私自扩展含义。

---

## 16. 变更记录

| 版本 | 变更                                                                                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v5   | 核心包 / CLI / 项目级 Skill 三层交付；job.json 作为唯一契约                                                                                                                         |
| v5.1 | **行列限定拆成「语义值」与「绝对号」**：不指定考场时只能用 `first` / `last` / `door` / `window`，由每个考场按自身行列数解析；指定考场后才允许绝对号                                 |
| v5.2 | **job.json v2 + 选科与多场次**：选科解析（`combination` / `subjects`）、时段推导、分组分房与 `planAll`；限定新增班级 / 组合 / 科目选择器；考场新增 `location` / `dedicatedSubjects` |
| v5.3 | **文档与实现对齐**：API / CLI / `plan.json` / 编号签名 / 诊断码 / 技术选型全部按代码校正；虚拟滚动等未实现项显式标注                                                                |
| v5.4 | 实施进度表按代码逐条核对（S1–S8），发现 skill 未覆盖 v2 并登记议题                                                                                                                  |
| v6   | **合并版**：`design.md` + `design-selection.md` 合并重写为本文档（单一事实来源），原 `design-selection.md` 删除；新增「实现状态一览」，全篇按当前代码核对一遍                       |
