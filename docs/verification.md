# 独立验收记录（task-7 / task-11 / task-14 / task-15 / task-16）

> 验收人：verifier（不改业务实现；task-7/11/14 只改 `examples/acceptance.mjs` 与本文件，
> task-15/16 只改本文件）。
> task-7：主链路（硬规则 / 分房策略 / 导出闸门 / 退出码 / skill）—— 已完结（§1–§5，71/71）。
> task-11：输入契约（表头宽容 / 缺考两路 / 未匹配不静默）—— 阶段 1 脚本已写（§6）。
> task-14：多场次限定 + 多场次校验 —— 阶段 1 脚本已写（§6）。
> task-15：考场级放宽 / 按科目借考 / 加座考场 / 显式时段 —— 已完结（§7，独立复核 0 反例；
> 含一次增量复验：验收 108 → **111**（新增 19h/19i/19j，收紧后复验通过），见 §7.9）。
> task-16：Excel 交付物重做（准考证号 / 标题 / 字号 / A4 横向 / 每班每考场单文件）—— 已完结（§8）。
> **隐私**：本文只写脱敏占位符（「某生」「同学甲」「`<借考生学号>`」），不抄 `inputs/`、`out/` 的真实姓名/学号。
> 基线契约：`docs/design.md` §3.2 / §4.5 / §5.1 / §5.4 / §5.8 / §7.1 / §8.1 / §9；
> `docs/需求-考场级限制与放宽.md`；`docs/issues.md`（议题 1–5）。
> 原则：硬规则与限定断言**全部独立推导**（只看 CLI 输出与导出文件，不调用 core 的
> `findRoomSubjectClashes` / `validate` / `validateAll` 自证）。

## 0. 当前状态

| 项           | 值                                                                                                                                                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 验收脚本     | `examples/acceptance.mjs`，**140 项**（第 21 节 10 条：专属组合含 21h 互为子串；第 20 节 19 条）                                                                                                                                                      |
| 阶段         | task-7 ✅ 71/71；task-11/14 ✅ 93/93；task-15 ✅ 111/111；task-16 ✅ 126/126；web 迁 shadcn-vue ✅ 130/130；专属组合/单场语义/预设统一 ✅ 140/140；「性别/备注」列不再解析 ✅ 140/140；**监考表备注 v3 ✅ 140/140**（见 §10–§12）                     |
| 单测         | `pnpm exec vitest run` = **617 passed / 45 files**（node 406 = core 191 + io 174 + cli 41；web 211），exit 0                                                                                                                                          |
| 依赖         | CLI bin 走 `packages/cli/dist`：`packages/cli/bin/exam-seat.mjs` → `import { main } from "../dist/cli.mjs"`                                                                                                                                           |
| 最近一次运行 | acceptance **140/140**（242ms，dist 18:05:02）；单测 **617/617**；task-33 的 M3 变异 174/174 全绿（未抓住）→ 见 §12.4                                                                                                                                 |
| lint         | ⚠️ **全仓 `pnpm lint:check` 当前失败**：未跟踪的 `packages/desktop/`（另一个桌面轮次的 WIP）里 `src/main.mjs` 有 2 个语法错误 → oxlint 2 error、oxfmt 无法检查；**本轮范围 `packages/` 干净**（oxlint 0 error / 2 warning、oxfmt 全合规），详见 §12.5 |
| 独立复核器   | `/tmp/vfy/check.mjs`（task-15）、`/private/tmp/vfy-r25-*.mjs`（task-25，见 §10）、`/private/tmp/vfy-r27-a.test.ts` + `base-io` + `io-vitest.config.mts`（task-27，见 §11）                                                                            |
| 命令         | `node examples/acceptance.mjs`、`exam-seat plan/validate/template/rooms`、`pnpm --filter @exam-seat/web build`（不跑 `pnpm verify`）                                                                                                                  |

> task-7 阶段 1 在旧 dist 上观察到的失败在最终 build 后全部归零；其中 1 项是我自己的断言写错
> （`已排人数 < 总数`），已按 design §5.4 改成「应考时段未排满人数 > 0」，见 §4 第 16 条。
> **task-11/14 引出的契约更新**：task-12 让多场次限定真正生效、`CONSTRAINTS_IGNORED_MULTI` 退场，
> 因此 §2 第 14 段原有的 3 条断言已按新契约改写（不再出现该码 + 限定确实作用到学生自己那套座位 +
> 限定满足时照常导出 + 用 `TOO_FEW_CLASSES` 守 warning 不阻塞），覆盖只增不减，详见 §6.3。

## 1. 方法与边界

- 验收目标：把 `docs/design.md` 的硬指标端到端跑一遍，重点覆盖**硬规则「一个考场、一个时段、
  只能考一科」**、分房策略 `groupPreference`、导出闸门（§8.1）、退出码契约（§9）、空置考场剔除、skill 覆盖。
- 数据来源：**只**从 CLI 的 `--json` stdout、stderr 提示、`--out-dir` 导出的 `job.json` /
  `plan.json` / 两份 xlsx、以及 skill 文件读取；不读 core 源码常量自证。
- 独立的硬规则校验器（脚本内自实现，逐条与 core 分开）：
  - `hardRuleViolations`：从 `byStudent[].slots` 摊平成「考场 × 时段 → 科目集合」，去重后 > 1 即违规；
  - `seatingSubjectViolations`：`seating.subjects` 必须覆盖该方案学生实际考的科目，且每时段仍 ≤ 1 科；
  - `roomCombinationMixViolations` / `roomCombinations`：常规组合（物化生/政史地）与非常规组合不得共用一个考场；并给出「考场 → 组合集合」；
  - `seatCollisions`：同一考场同一时段的座位号不重复；
  - `seatingSeatViolations`：同一套座位方案内一人一位、`seatNoById` / `studentBySeatNo` 一一对应；
  - `overlappingSeatings`：同一考场的多套座位方案，时段不允许重叠（`fillRooms` 共用必须合并成一套）；
  - `unarrangedStudents`：用 job 的选科 + `byStudent.slots` 推「应考时段」，应考却为 null（含完全没进 `byStudent`）= 未排满；
  - `studentSubjectViolations`：每人每时段实际科目必须是自己选的（复核 `byStudent` 科目映射）。
- `--json` 契约：整段 stdout 必须能被 `JSON.parse` 成单个对象；剔除提示只允许出现在 stderr
  （JSON 正文里的诊断 message 本来就可能含「空置」二字，所以只断言**提示整行**不在 stdout）。
- 退出码契约（§9）：结构性 error（`blocksListExport`）或没有任何座位方案 → `3`；只有 `SEARCH_FAILED`
  的 `--relax` 降级 → `2` 且名单照常导出；`0` 完美；`1` 用法 / IO。
- E2E 走 dist：脚本本身不 build；由 Lead 统一 build 后重跑。

## 2. 断言清单（93 项）

| 段                     | 项        | 覆盖                                                                                                                                                                                                                                              |
| ---------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 基础契约             | 1–4       | 用法退出码、Excel 导入、选科列、四种组合解析                                                                                                                                                                                                      |
| 2 多场次               | 5–8       | 完成、7 时段、物/历 + 生/政 配对、座位方案零冲突                                                                                                                                                                                                  |
| 3 考场数               | 9–11      | 常规 1 个 / 非常规 2 个 / 无超 3                                                                                                                                                                                                                  |
| 4 专用考场             | 12–14     | 有座位方案、只装非常规、政治考场的选科正确                                                                                                                                                                                                        |
| 5 编号与邻接           | 15–16     | 蛇形编号逐座、6108 组相邻关系暴力复核                                                                                                                                                                                                             |
| 6 导出                 | 17–21     | 两份 xlsx、换考场记录、空置列出、同 seed 可复现                                                                                                                                                                                                   |
| 7–9 单场/失败路径/降级 | 22–26     | `--single`、无解退出码与原因、班级数 < 9 退化告知                                                                                                                                                                                                 |
| 10 硬规则独立复核      | 27–34     | 逐考场×时段一科、subjects 一致、常规×非常规不共用、座位号一人一位、跨 seating 不重叠、无 `ROOM_SUBJECT_CLASH`、默认无 `ROOMS_SHARED`                                                                                                              |
| 11 考场不足/导出闸门   | 35–36、62 | 默认 `CAPACITY_INSUFFICIENT`、不偷偷混排、结构性 error 退出码 3 且不导出工作簿                                                                                                                                                                    |
| 11b 全部考场空置       | 37–38     | `job.json` 不被掏空、CLI 不谎报「已剔除」也不谎报排考完成、退出码 3                                                                                                                                                                               |
| 11c 单场导出闸门       | 63–64     | 单场结构性 error 退出码 3 且不导出名单；降级（orthogonal）退出码 0 照常导出                                                                                                                                                                       |
| 12 空置剔除            | 39–44     | 主 job / 小 job 导出剔除、stderr 提示、`--json` stdout 单一 JSON                                                                                                                                                                                  |
| 13 skill               | 45–49     | SKILL.md 字符数、关键词计数、SKILL.md 坑位、reference.md 字段、带选科样例                                                                                                                                                                         |
| 14 多场次限定生效      | 50–55     | 限定生效、不再出现 `CONSTRAINTS_IGNORED_MULTI`、点名/按班限定独立复核、无限定与单场无该码、限定满足照常导出、error/warning 分级                                                                                                                   |
| 15 fillRooms           | 56–61     | 共用仍 ok、合并成一套座位、一人一位、只出一张监考表、默认同名单报 `CAPACITY_INSUFFICIENT` 且不混排                                                                                                                                                |
| 16 对抗用例（阶段 2）  | 65–71     | `--relax minConflicts` 仍导出（exit 2）、fillRooms 不合并冲突批次、非法 `groupPreference` 回退、无专用考场混合批次、fillRooms 可复现、选考科目全在专用考场时语数外不漏排、`validate` 喂多场次 plan.json 走 validateAll（exit 0、逐 seating 结论） |
| 17 输入契约（task-11） | 72–83     | 空格/全角空格表头、`考证号` 别名、`班主任` 不误命中、缺考列 15 值矩阵、缺考名单按 id / 姓名+班级、未匹配必须可见、缺考名单自带缺考列、多疑似 id 列、两路并集、原文件不改动、缺 id 缺班级必须报错                                                  |
| 18 多场次限定+校验     | 84–93     | `first`（R2 大 / R1 小）、`door`/`window`（大 6 列 / 小 5 列）、`roomId` 全时段、交集、组合/科目选择器、不可满足必须诊断且不导出、`validate` 正常 exit 0 + 每套结论、改坏 plan → exit 3（同址两人 / 挪出首排）、带限定硬规则复核                  |

英文/代号断言对应的命令统一是 `node examples/acceptance.mjs`；其中 35–38、56–71 使用脚本内
写到临时目录的小 job（`tight.json` / `zero.json` / `fill.json` / `fill-strict.json` /
`single-tight.json` / `relax.json` / `illegal-merge.json` / `bogus.json` / `mixed.json` /
`all-dedicated.json`）；72–83 使用脚本内生成的临时 xlsx（`input-*.xlsx`）；84–93 使用
`multi-constraints.json` / `multi-constraints-unsat.json` 与两份人为改坏的 `plan.json`。

## 3. 待验清单与最终定级

| #   | 问题                                                                        | 最终定级                                                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | 参考人数 0 时 `planAll.ok` 真空为真、renderer 报成功、CLI 退出码却是 3      | **真 bug → 已修 + 已复验**（core `ok` 收紧 + `NO_STUDENTS`；io-cli renderer 改写）。第 38 项绿：❌「没有任何考场安排…所有学生都被排除」、exit 3、`job.json` 保留 3 个考场                                                                        |
| C2  | `findRoomSubjectClashes` 用 `seating.subjects` 并集判定，可能漏报/误报      | **已验证无问题**：`mixed.json` 场景 core 与独立推导一致；主 job 两边都为空。C12 修复后该场景两边同时归零                                                                                                                                         |
| C3  | `canShareRoom` 签名在 `combination` 同名但 `subjects` 不一致时的行为        | **已验证安全**：`combination:"物化生"` + `subjects:["physics","chemistry"]` → `ok=true`、无诊断、T6 正确为 null、无混排                                                                                                                          |
| C4  | error 结果仍无条件导出两份工作簿                                            | **真 bug → 已修 + 已复验**（按 §8.1 闸门、`writeWorkbooks`）。第 62/63 项绿：只留 `plan.json` + `job.json`，exit 3，stderr 逐条 error                                                                                                            |
| C5  | 非法 `groupPreference` 静默回退                                             | **非 bug（设计口径）**：回退 `sameCombination`、报 `CAPACITY_INSUFFICIENT`、不混排。第 67 项绿                                                                                                                                                   |
| C6  | `fillRooms` 合并后是否如实报 `ROOMS_SHARED`                                 | **已验证**：第 56 项绿 —— 诊断恰好 `ROOMS_SHARED`，R2 合并成 1 套座位 / 1 张监考表                                                                                                                                                               |
| C7  | 部分排出来时 `job.json` 是否保留全部考场、有无误导提示                      | **已验证**：tight `job.json` 存在、无「已剔除」（两个考场都被物化生用到）                                                                                                                                                                        |
| C8  | `validate` 对多场次 `plan.json` 的行为                                      | **真 bug → 已修，并被新契约取代**：io-cli-eng 先加入口判别（exit 1 + `MULTI_PLAN_NOT_SUPPORTED`，第 71 项曾守）；task-13 接上 core `validateAll` 后改为**逐 seating 校验**（exit 0/3）。第 71 项已按新契约改写，正常/改坏另由 §6 第 18g–18i 覆盖 |
| C9  | `SKILL.md` 字节余量                                                         | **提示（非 bug）**：8060 字节 / 4474 字符 → 按字节口径只剩 132 字节余量；按字符口径余量充足                                                                                                                                                      |
| C10 | 导出闸门两份实现（cli 本地副本 vs core `blocksListExport`）                 | **真 bug（契约重复）→ 已修 + 已复验**：`cli.ts` 只从 core import（`cli.ts:6`），单场 410 / 多场次 371 两处共用                                                                                                                                   |
| C11 | Web 多场次导出闸门用 `!planAll.ok \|\| conflicts > 0`，与 §8.1 唯一判据不同 | **非 bug（Lead 口径）**：网页「先二次确认、老师坚持仍可导出」，§8/§8.1 明确给网页留的口径；CLI 才是硬闸门                                                                                                                                        |
| C12 | 非常规批次无条件合并成一个 demand，未按逐时段科目签名拆分                   | **真 bug → 已修 + 已复验**（core-eng `groupIrregularDemands`）。手动复核：`ok=true`、R1=物化政 20 人、R2=物化地 20 人、`distinctRooms=1`、无诊断；第 68 项自动切到「合法拆房」分支                                                               |

> 汇总：真 bug 5 个（C1 / C4 / C8 / C10 / C12）**全部已修并复验**，无未修复 bug；非 bug 2 个（C5 / C11）；
> 提示 1 个（C9）；我自己的断言写错 1 处（已修）。

### 3.1 阶段 2 反例结果（E1–E7）

| #    | 反例                                         | 期望                                                       | 结果                                                                                     |
| ---- | -------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| E1   | 物化生 + 政史地塞同一考场（60 人 / 2 考场）  | `CAPACITY_INSUFFICIENT`(error)、不产出同时段两科           | ✅ 第 35/36 项：`ok=false`、exit 3、未排满 40/60 人、独立复核违规 0                      |
| E2   | 非法 `groupPreference`                       | 安全回退、不混排                                           | ✅ 第 67 项                                                                              |
| E3   | 全部考场空置（参考人数 0，3 考场）           | `job.json` 保留 3 考场、无「已剔除」、不谎报完成、exit ≠ 0 | ✅ 第 37/38 项（exit 3）                                                                 |
| E4   | 名单带选科但只有 1 个考场（fillRooms）       | 不合并冲突批次、`CAPACITY_INSUFFICIENT`、不导表            | ✅ 第 66 项：R1 只装物化生、未排满 20 人、`考场监考表.xlsx` 不存在                       |
| E5   | fillRooms 合并不合法批次                     | 不合并                                                     | ✅ 第 66 项（同上）                                                                      |
| E6   | 单场 + 限定回归                              | `--single` 应用限定、无 `CONSTRAINTS_IGNORED_MULTI`        | ✅ 第 54 项（12 条名单）                                                                 |
| E7   | 同输入同 seed 复现                           | 座位方案 + `byStudent` 一致                                | ✅ 第 21 项（主 job）、第 69 项（fillRooms，排除 `elapsedMs` / `generatedAt` 易变字段）  |
| 附加 | 单场 `--relax minConflicts`（SEARCH_FAILED） | **必须仍然导出**、退出码 2                                 | ✅ 第 65 项：`OK,SEARCH_FAILED`、`ok=false`、exit 2、名单 34919 字节                     |
| 附加 | 结构性 error（单场 / 多场次）                | **必须不导出**、退出码 3                                   | ✅ 第 62/63 项                                                                           |
| 附加 | 无专用考场 + 政治/地理同段                   | 不静默：合法拆房 **或** clash 且不导出                     | ✅ 第 68 项：C12 修复后走「合法拆房」——`ok=true`、独立复核 0 违规、监考表 22510 字节导出 |
| 附加 | 选考科目全被专用考场接走                     | 语数外仍排上、无应考时段漏排                               | ✅ 第 70 项：`ok=true`、未排满 0 人、每人 2 个考场                                       |
| 附加 | `validate` 喂多场次 `plan.json`              | 逐 seating 独立校验（exit 0/3）                            | ✅ 第 71 项（task-13 接 `validateAll` 后改为逐 seating 结论；第 18g–18i 覆盖正常/改坏）  |

### 3.2 已知边界（记录，不判定为 bug）

| #   | 边界                                                                                                            | 依据                |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------- |
| B1  | `seatings=[]` 时 `NO_STUDENTS`(error) 属于 `BLOCKING_EXPORT_CODES` → 工作簿被拦                                 | C1 / §8.1           |
| B2  | `--relax` 下只有 `SEARCH_FAILED` 时不拦导出（L2/L3 是用户主动降级，要交付）                                     | §8.1 / §9           |
| B3  | 单场与多场次共用同一导出闸门与退出码判据（`cli.ts` 两处调用 core 的 `blocksListExport`）                        | §8.1；验收 62/63/64 |
| B4  | `groupPreference` 非法值 = 安全回退 `sameCombination`（不报错，但绝不混排）                                     | C5 / `plan.ts` 注释 |
| B5  | 分配失败时保留已成功批次的座位用于诊断，「已排人数 = 参考人数」不代表成功，判定只看 `ok` + 每人应考时段是否排满 | design §5.4         |

### 3.3 web 静态复核（只读，不作为验收门禁）

已核对、未发现问题：

- `StepSolve.vue`：名单带选科（`combination` / `subjects`）默认 `all`，无选科强制 `single`，与 CLI 口径一致；worker 协议 `mode` 缺省 `single`，老路径行为不变。
- `StepResult.vue`：多场次导出直接复用 `@exam-seat/io` 的 `buildClassScheduleWorkbook` / `buildInvigilatorWorkbook`，没有第二套算法；导出前二次确认后允许「仍然导出（仅供人工微调）」——即 C11，符合 §8/§8.1 的网页口径。
- `stores/result.ts`：`removeEmptyRooms()` 同时改 `rooms` store 与 job 快照，清空 `result` / `planAll` / `report` 并回到 `idle`（提示「配置已变，请回排考场重跑」）；持久化 watch 覆盖 `mode` / `planAll`；`emptyRoomIds` 按 `seatings` 实际用到的 roomId 推导，不用容量预测。
- `session-export.ts` 均为纯函数（表格 / 概览 / 冲突 / 诊断去重），无求解语义。

web 不参与 `acceptance.mjs` 的 E2E，其正确性由 `packages/web/test` 单测与 Lead 的 `pnpm verify` 覆盖。

## 4. 阶段 2 最终结果（dist 19:07:33）

| #   | 断言 / 场景                             | 命令                                                        | 实际输出摘要                                                                                                                                              | 通过       |
| --- | --------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | 全量验收（71 项）                       | `node examples/acceptance.mjs`                              | 71/71，exit 0，约 160ms                                                                                                                                   | ✅         |
| 2   | 硬规则独立复核                          | 同上（第 27–34 项）                                         | 主 job 205 个「考场 × 时段」格子；座位号一人一位；跨 seating 不重叠；5 个多场次场景 0 违规                                                                | ✅         |
| 3   | 多场次结构性 error：退出码 3 + 不导表   | tight `--out-dir`（第 62 项）                               | exit 3；`classBook=-1 invigilator=-1 plan=81875 job=13504`；stderr「结果未通过校验…」                                                                     | ✅         |
| 4   | 单场结构性 error：退出码 3 + 不导名单   | `single-tight --out-dir`（第 63 项）                        | exit 3；`list=-1 plan=3396 job=10252`                                                                                                                     | ✅         |
| 5   | 降级照常导出                            | `few --out-dir`（第 64 项）                                 | exit 0；名单 56830 字节                                                                                                                                   | ✅         |
| 6   | `--relax minConflicts`（SEARCH_FAILED） | 4 班 9/9/9/3 + `--force-king`（第 65 项）                   | `OK,SEARCH_FAILED`；`ok=false`；exit 2；名单 34919 字节                                                                                                   | ✅         |
| 7   | 空置考场剔除                            | 主 job / 小 job `--out-dir`（第 39–44 项）                  | 主：空置 2 → 导出 36（应为 36）；小：导出 R1；stderr「已剔除空置考场：第2考场、第3考场」                                                                  | ✅         |
| 8   | `--json` stdout 纯 JSON                 | 小 job（第 44 项）                                          | stdout 25989 字节整体 `JSON.parse`；提示只在 stderr                                                                                                       | ✅         |
| 9   | 多场次限定（**旧契约下的历史结果**）    | 12 人物化生 + 2 条限定（第 50/51 项）                       | 旧核心：恰好 1 条 `CONSTRAINTS_IGNORED_MULTI` warning、`evidence={constraints:2,students:5}`。task-12 后该码退场，断言已改写（见 §6.3），以新一轮运行为准 | ✅（历史） |
| 10  | fillRooms 合并 + 1 张监考表             | fill.json（第 56–59 项）                                    | `ROOMS_SHARED`；R2：座位方案 1 套 / 监考表 1 张「第2考场（语数外物化生）」                                                                                | ✅         |
| 11  | 反例：物化生 + 政史地 / 1 考场          | illegal-merge（第 66 项）                                   | `CAPACITY_INSUFFICIENT`；R1 只有物化生；未排满 20 人；监考表不存在                                                                                        | ✅         |
| 12  | 反例：非法 `groupPreference`            | bogus（第 67 项）                                           | 回退 `sameCombination`；`CAPACITY_INSUFFICIENT`；混排 0 处                                                                                                | ✅         |
| 13  | 反例：全部考场空置                      | zero.json（第 37/38 项）                                    | `seatings=0`；`job.json` 保留 R1/R2/R3；❌「没有任何考场安排」；exit 3                                                                                    | ✅         |
| 14  | 反例：无专用考场 + 政治/地理同段（C12） | mixed.json（第 68 项）                                      | `ok=true`；独立复核 0 违规；核心无 `ROOM_SUBJECT_CLASH`；监考表 22510 字节导出；手动复核 R1=物化政 20 / R2=物化地 20，`distinctRooms=1`                   | ✅         |
| 15  | 选考科目全被专用考场接走                | all-dedicated（第 70 项）                                   | `ok=true`；未排满 0 人；每人 2 个考场；4 套座位方案                                                                                                       | ✅         |
| 16  | `validate` 喂多场次 plan.json（C8）     | 小 job 的多场次 `plan.json`（第 71 项）                     | 非 `--json` exit 1 +「这份 plan.json 是多场次结果…只支持单场结果」；`--json` → `MULTI_PLAN_NOT_SUPPORTED`，无「内部错误」                                 | ✅         |
| 17  | 断言写错复盘                            | fillStrict（第 61 项）                                      | 「已排人数 60/60」被专用房 T6 影响；改用「应考时段未排满」后：未排满 20 人（缺 T1–T5），物化政只出现在 R3                                                 | ✅         |
| 18  | C3 手动探针                             | `combination:"物化生"` + `subjects:["physics","chemistry"]` | `ok=true`、无诊断、T6 为 null、无冲突                                                                                                                     | ✅         |
| 19  | 可复现性                                | 主 job（第 21 项）+ fillRooms（第 69 项）                   | `byStudent` / 座位方案投影逐字节一致                                                                                                                      | ✅         |

## 5. 最终结论

**环境与结果**：Lead 在 19:07:33 统一 `pnpm lint:check && pnpm typecheck && pnpm build` 全绿后，
`node examples/acceptance.mjs` **71/71 通过**（exit 0）；`oxlint` 0 error / 0 warning、`oxfmt --check` 通过。

**硬规则「一个考场、一个时段，只能考一科」**：三道防线齐备且**未发现任何绕过路径**——
分房期的逐时段兼容门控（含 `groupIrregularDemands` 对非常规批次的签名分组）、结果期的
`findRoomSubjectClashes`、导出期的 `blocksListExport`（§8.1）。验收脚本用**完全独立**的推导
（`byStudent[].slots` / `seatNoById` / seating 时段重叠 / 每人选科）在 6 个多场次场景逐格复核，
结论与 core 完全一致。

**定级（C1–C12 / E1–E7）**

- 真 bug 5 个，**全部已修并复验**：C1（零参考人成功话术）、C4（error 仍导出）、C8（`validate` 多场次内部错误）、C10（导出闸门判据重复）、C12（非常规批次未按签名拆分 → 可行排法被判死）。
- 非 bug 2 个：C5（非法 `groupPreference` 安全回退，设计有意）、C11（网页二次确认后仍可导出，§8/§8.1 口径）。
- 提示 1 个：C9（`SKILL.md` 8060 字节，字节口径余量 132）。
- 验收侧自查：1 处断言写错（`已排人数 < 总数`），已按 design §5.4 修正。
- E1–E7 全部通过；额外覆盖退出码契约（结构性 error → 3 且不导表；`SEARCH_FAILED` 降级 → 2 且照常导表）。

**未修复 / 残余风险**

1. 无阻塞发布的未修复 bug。
2. web 多场次链路只做静态复核，未纳入本脚本 E2E（靠 `packages/web/test` 与 `pnpm verify`）。
3. 建议把多场次 `validateAll` 的契约补进 `docs/design.md` §9：多场次 `plan.json` → 逐 seating 独立校验、exit 0/3、`--json` 输出 `{ ok, seatings[].report, hardRuleClashes, issues }`（task-13 已实现，文档待同步）。
4. `SKILL.md` 字节余量仅 132，后续追加内容请同时核对 `wc -c`。

**验收结论：task-7 通过。** 71/71 全绿，硬规则无绕过路径，导出闸门与退出码符合 §8.1 / §9。

---

## 6. task-11 / task-14（输入契约 + 多场次限定 / 校验）

### 6.1 方法与边界

- 只改 `examples/acceptance.mjs` 与本文档；不写业务实现、不 commit、不跑 `pnpm verify`。
- task-11 的 12 组断言（第 72–83 项）：用脚本内 `xlsx` 直接生成临时名单/缺考名单，只从
  `exam-seat --json roster …` 的 stdout、stderr、退出码推导；缺考判定一律用 `included === false`。
- task-14 的 10 组断言（第 84–93 项）：只从多场次 `plan --json` / `validate --json` 与 `--out-dir`
  的导出文件推导；行列用脚本内**独立实现**的 `seatNoToRowCol(room.rows, seatNo)` 解析，
  限定是否满足、硬规则、同址两人全部自己算，不调用 core 的 `validateAll` / `findRoomSubjectClashes`。
- 新增脚本内工具：`writeSheet`（aoa → xlsx）、`runRoster`（不抛异常地跑 roster）、
  `byStudentId`、`studentSeatAssignments`（学生 → 每次安排的行列）。

### 6.2 断言清单（第 72–93 项）

| #   | 断言                                                                          | 独立推导点                                       |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------ |
| 72  | 带空格 / 全角空格的 `准 考 证 号`·`姓　名`·`班 级` 三列表头都识别             | 逐学生核对 id/姓名/班级，`studentCount`          |
| 73  | `考证号` 别名识别为 id                                                        | id 列存在 + 逐学生班级正确                       |
| 74  | `班主任` 不会被当成班级列（`mapping.className !== 3`）                        | 解析出的班级值不含「老师」                       |
| 75  | 缺考列 15 值矩阵：只有 `病假/是/缺席` 视为缺席                                | `included === false` 的 id 集合 == 期望集合      |
| 76  | 缺考名单按准考证号匹配（命中 5/8）                                            | 逐 id 核对 + 输出含「命中」                      |
| 77  | 缺考名单按 `姓名+班级` 匹配（命中 3/8）                                       | 逐 id 核对                                       |
| 78  | 缺考名单未匹配必须报出来                                                      | 命中仍生效 + 输出含未匹配字样**且**含键值 `S99`  |
| 79  | 缺考名单自带「缺考」列 → 只取真正缺席的两行                                   | 6 人里恰好 A03/A04 为 false                      |
| 80  | 多个疑似 id 列（准考证号 + 学号）只认一列、不混用                             | ids 全来自同一列 + 姓名/班级对应正确             |
| 81  | 名单「缺考」列 + 缺考名单同时存在 → 取并集                                    | false 集合 == {S03, S05}                         |
| 82  | 读名单 / 应用缺考名单不改动原文件                                             | 运行前后原 xlsx 字节完全一致                     |
| 83  | 缺考名单既无 id 又缺班级 → 明确报错（不按姓名静默匹配）                       | exit≠0 或输出含「班级」+ 无人被误标              |
| 84  | `rows:["first"]`：R2 大考场（7×6）与 R1 小考场（6×5）各一例（另有物化地全体） | `seatNoToRowCol` 独立解析 + 钉住 roomId          |
| 85  | `cols:["door"]`=第 1 列；`cols:["window"]`=R2 第 6 列 / R1 第 5 列            | 按实际考场行列解析                               |
| 86  | `roomId:"R2"`：命中学生所有时段都在 R2，且 R2 是其组合批次                    | 逐时段房间 + seating 内组合全为物化生            |
| 87  | 同一学生两条规则取交集（首排 ∩ 靠门 → (1,1)）                                 | 逐时段行列                                       |
| 88  | `combinations` / `subjects` 选择器生效（政史地末排、物化政靠门、物化地首排）  | 按各考场实际 rows/cols 核对                      |
| 89  | 不可满足的限定：明确诊断 + 不静默 + 不导出名单                                | `ok=false` + 诊断/unmet + 输出可见 + 无工作簿    |
| 90  | `validate` 多场次正常：exit 0、每套 seating 有结论、文本含每个考场名          | `--json` 的 `seatings[].ok/seats` + 非 json 输出 |
| 91  | 人为造同址两人 → exit 3 且 issues 说清                                        | 直接改 plan.json 的 `entries`                    |
| 92  | 把受限学生（P01）挪出首排 → exit 3 且限定未满足被指出                         | 同步改 seatNo/row/col/physicalCol/两张映射表     |
| 93  | 带限定的多场次结果：硬规则独立复核零违规                                      | 现有四个独立校验器                               |

### 6.3 契约更新说明（旧断言的处理）

task-12 让多场次限定真正生效并让 `CONSTRAINTS_IGNORED_MULTI` 退场，因此第 14 段原来的
3 条断言（旧第 50/51/55 项）按新契约改写，**覆盖只增不减**：

| 旧断言                                    | 新断言                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| 恰有一条 `CONSTRAINTS_IGNORED_MULTI`      | 不再出现该码 + `ok=true`（第 50 项）                                                   |
| 该诊断的 evidence 条数/人数               | 限定真的落到「学生自己那套座位」：点名两人首排、按班三人靠门（第 51 项，独立解析行列） |
| `warning` 不阻塞导出                      | 限定满足时照常导出（ok/exit 0/写名单，第 53 项）                                       |
| `error` 阻塞 / `warning` 不阻塞（用旧码） | 改用仍然存在的 `TOO_FEW_CLASSES`(warning) 守「warning 不阻塞 ok」（第 55 项）          |
| （第 71 项）多场次 `validate` 报错        | task-13 接 `validateAll` 后改为「逐 seating 结论、exit 0」（第 71 项）                 |

### 6.4 阶段 1 试跑（历史记录：旧 dist 19:21:02，task-8/12/13 尚未 build）

`node examples/acceptance.mjs` → **72/89**：18 个新项按预期失败，其余 71 项全绿（第 71 项因
契约切换暂时失败）。失败项与归属：

| 归属              | 失败项         | 说明                                                                                     |
| ----------------- | -------------- | ---------------------------------------------------------------------------------------- |
| task-8（io/cli）  | 73–79          | `考证号` 未识别、缺考列未处理、`--absent` 未知选项（stderr `unknown option '--absent'`） |
| task-12（core）   | 83–85          | 限定仍被忽略（`CONSTRAINTS_IGNORED_MULTI`、`roomId` 未参与分房、交集变 (4,1)）           |
| task-12/13        | 80–82、84      | 多场次限定未生效（P01/P02 落在 R1 而不是 R2）                                            |
| task-13（cli）    | 71、86–88      | `validateAll` 未接线（旧 dist 仍走入口判别/内部错误）                                    |
| task-11/14 已可过 | 72、74、75、89 | 表头空格识别、`班主任` 不误命中、缺考列矩阵在旧核心已正确；带限定硬规则本就为零违规      |

> 其中第 85 项在旧核心下的表现值得记录：**不可满足的限定只报 warning 且 `ok=true`、名单照常导出**
> —— 正是用户说的「没有验证就绝对不能使用」；task-12 落地后该项必须变成「诊断 + 不导出」。

### 6.5 阶段 2 原计划（历史记录，均已完成）

1. `node examples/acceptance.mjs` 跑到 **89/89**（或把失败项按真 bug / 断言写错定级）。
2. `git diff` 通读 io/cli/core/web 的输入链路与限定链路，找绕过路径：多个疑似 id 列时选哪个、
   缺考列 + 缺考名单是否取并集、未匹配是否被吞、原名单是否被原地改、`validateAll` 是否拿
   `planAll` 中间结果自证、`unmetConstraints` 是否被吞。
3. 反例写进本文件（每条：断言 / 命令 / 实际输出 / 结论）；发现真问题发 lead + owner。
4. 收尾 `npx oxfmt docs/verification.md examples/acceptance.mjs`。

### 6.6 阶段 2 最终结果（dist 19:45:19，93/93 全绿）

`node examples/acceptance.mjs` → **93/93**（exit 0，约 180ms）；`npx oxlint examples/acceptance.mjs`
0 error / 0 warning、`npx oxfmt --check` 通过。

| 断言组             | 命令                            | 实际输出摘要                                                                                                                                                                                           | 通过 |
| ------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 72–74 表头宽容     | `roster --json`                 | `准 考 证 号`/`姓　名`/`班 级` → 3 人字段全对（mapping 0/1/2）；`考证号` → id 列 0；`班主任` → `mapping.className=2`、班级=高三(3)班                                                                   | ✅   |
| 75 缺考列矩阵      | `roster --json`                 | 15 个取值里恰好 M13(病假)/M14(是)/M15(缺席) `included=false`                                                                                                                                           | ✅   |
| 76–77 缺考名单两路 | `roster --absent`               | 按 id 命中 5/8（S02/S04/S05/S07/S08，stderr「命中 5 人 / 未匹配 0 行」）；按 姓名+班级 命中 3/8（S02/S05/S08）                                                                                         | ✅   |
| 78 未匹配不静默    | `roster --absent`               | S02 生效，输出含「未匹配」且含键值 `S99`                                                                                                                                                               | ✅   |
| 79 缺考名单自带列  | `roster --absent`               | 6 人里恰好 A03/A04 为 false                                                                                                                                                                            | ✅   |
| 80 多疑似 id 列    | 准考证号 + 学号                 | `mapping.id=0`（准考证号 Z1/Z2），姓名/班级对应正确，未串列                                                                                                                                            | ✅   |
| 81 两路并集        | 名单缺考列(S03) + 缺考名单(S05) | `included=false` = S03、S05                                                                                                                                                                            | ✅   |
| 82 原文件不变      | 跑 `roster --absent` 前后       | 16930 → 16930 字节，字节级一致                                                                                                                                                                         | ✅   |
| 83 缺考名单缺班级  | 只有「姓名」列的缺考名单        | exit 1 + `ABSENT_LIST_INVALID`「…没有能识别的准考证号/学号列，也没有『班级』…」，无人被误标                                                                                                            | ✅   |
| 84–88 多场次限定   | `plan --json`                   | R2 首排 12 次、R1 首排 6 次、物化地首排 24 次；靠门 30 次列=1；R2 靠窗=6、R1 靠窗=5；P01/P02 全时段在 R2（R2 批次 4 人）；P04 交集 (1,1)；选择器：政史地末排 30 次、物化政靠门 24 次、物化地首排 24 次 | ✅   |
| 89 不可满足限定    | `plan --json --out-dir`         | `ok=false`、exit 3、`CONSTRAINT_EMPTY_DOMAIN`「有 1 名学生被 roomId 限定到他们不会去的考场…」、无名单导出                                                                                              | ✅   |
| 90–92 多场次校验   | `validate --json`               | 正常：exit 0、6/6 seating 结论、issues 0；同址两人：exit 3 + `ENTRY_DUPLICATE_SEAT`；挪出首排：exit 3 + `CONSTRAINT_UNMET`                                                                             | ✅   |
| 93 带限定硬规则    | 独立复核                        | 6 套座位方案，硬规则 / 座位号 / 科目映射违规 0                                                                                                                                                         | ✅   |

**对抗复核结论（阶段 2 清单）**

- 多个疑似 id 列：稳定选第一个命中的（`准考证号`），不混用、姓名/班级不被串列。
- 缺考列 + 缺考名单：取**并集**（S03 与 S05 都 false），不互相覆盖。
- 未匹配：id 模式输出键值 `S99`；缺考名单既无 id 又缺班级时直接 `ABSENT_LIST_INVALID` 报错，不按姓名静默匹配。
- 原名单：运行前后字节一致（CLI 只读）。
- 多场次限定：`first/door/window`、`roomId`、交集、组合/科目选择器全部独立复核通过；小考场靠窗=第 5 列、大考场=第 6 列。
- 不可满足限定：`CONSTRAINT_EMPTY_DOMAIN`（error）+ 不导出名单，**不静默**（对照阶段 1：旧核心只报 warning 且 `ok=true` 照常导出）。
- `validateAll`：正常结果 6/6 seating 有结论、issues 0；两处人为改坏都 exit 3，`CONSTRAINT_UNMET` / `ENTRY_DUPLICATE_SEAT` 指向真实原因，未发现「拿 planAll 中间结果自证」。

**夹具修正记录（我的问题，非产品 bug）**：task-14 首版夹具只给 3 个普通考场（R3 是专用政治房），
而 `roomId` 把物化生拆成 2 批 + 政史地 + 物化政主批 + 物化地主批 → `CAPACITY_INSUFFICIENT`（缺 8 座），
6 项失败。按 Lead 建议补 R5/R6 并把大小考场观测改成「显式钉 R2/R1」后全绿。同时确认：
`planAll` 只对排上的学生产出 `byStudent`，完全没排上的要靠 error 诊断或 `validateAll` 的
`ENTRY_MISSING_STUDENT` 判定。

### 6.7 结论

- **task-11（输入契约）通过**：12 项全绿；表头宽容（含 `考证号`、空格/全角空格、`班主任` 不误命中）、
  缺考两路（名单内缺考列 15 值矩阵 + 独立缺考名单按 id / 姓名+班级）、未匹配不静默、原文件不改动，
  均符合冻结契约。
- **task-14（多场次限定 + 校验）通过**：10 项全绿；`first/door/window`（小 5 列 / 大 6 列）、
  `roomId` 全时段、两条规则交集、组合/科目选择器都经独立推导确认；不可满足的限定明确
  `CONSTRAINT_EMPTY_DOMAIN` 且拒绝导出；`validateAll` 对正常 / 两处改坏分别 exit 0 / 3 且原因可读。
- **无未修复 bug**；发现的问题只有我自己的夹具不可行（已修正）与 task-7 的 C8 契约切换
  （多场次 validate 改为 `validateAll`，见 §3 C8 / §6.3）。
- 建议：把多场次 `validateAll` 契约补进 `docs/design.md` §9（见 §5 残余项 3）。

---

## 7. task-15（考场级放宽 / 按科目借考 / 加座考场 / 显式时段）

### 7.1 验收环境与前置

| 项       | 值                                                                                                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| git      | `4e73e59`，工作区 **dirty（47 项，本轮 4 个能力未 commit）**；验收对象就是这份工作区                                                                                                                                                                                             |
| 构建     | 我 23:42 先 `pnpm build`；io-cli 的 task-7 之后重建一次（dist 23:49:04–23:49:05），§7.2–§7.7 的数字取自这次。Lead 补 19h/19i/19j 后我又 `pnpm build`（dist 00:01:38–00:01:39）；Lead 收紧这 3 条断言后第三次 `pnpm build`（dist 00:07:08–00:07:09），§7.6 与 §7.9/§7.10 取自这次 |
| 工具     | node v24.21.0 / pnpm 12.7.0                                                                                                                                                                                                                                                      |
| 独立复核 | `/tmp/vfy/check.mjs`（临时脚本，**不 import `@exam-seat/core`**）：自实现座位编号（含加座）、4/8 邻域、硬规则、座位冲突、限定解析、放宽邻接                                                                                                                                      |

**必须先 build，而且要等最后一次 build 落地**。第一次 `node examples/acceptance.mjs`（23:47 启动）正好撞上
io-cli 重建 `packages/*/dist`，跑出 **101/108**，7 个新项清一色 `exit=1 / ok=undefined / 无诊断`——
那是**并发构建的假失败**；dist 稳定（23:49:05）后复跑即 **108/108**。CLI 走 `packages/cli/dist` 这条纪律，
要延伸到「确认最后一次 build 已经落地」。

### 7.2 真实 job：`out/job.accept.json`（706 人 / 19 考场 / 12×42 + 7×35 = 749 座）

```bash
node packages/cli/bin/exam-seat.mjs plan     --job out/job.accept.json --out-dir /tmp/vfy/final --json
node packages/cli/bin/exam-seat.mjs validate --job out/job.accept.json --plan /tmp/vfy/final/plan.json --json
```

`plan` exit 0（导出 4 个文件）、`validate` exit 0；`ok=true`、`emptyRooms=[]`、19 个考场全部用上、
706 人全部进 `byStudent`。实测人数与 `docs/design.md` §5.8.6 逐项一致：

| 考场   | 实测                               | 我的独立推导（只读 plan.json / job.accept.json）                                           |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------ |
| R1–R16 | **644**（4×35 + 12×42 = 644 满座） | 由 `studentIds`/`entries` 直接计数；全是物化生                                             |
| R17    | **29**                             | 2518:22 + 2517 史地政 6 + 某生；`relaxedRooms=["R17"]`，`ROOM_SAME_CLASS_RELAXED`(warning) |
| R18    | **34**（33 + 某生借考）            | 物化政 13 + 物化地 9 + 物化生 11 + 某生；`borrowedSubjects={"<借考生学号>":["biology"]}`   |
| R19    | 政治 **13** / 地理 **9**           | 两套 seating（13 / 9），`dedicatedSubjects:["politics","geography"]`                       |
| 合计   | 706 人（借考 1 人跨两房）          | `byStudent` 706 人，distinct 学生 706；R18 的 34 含借考生，与文档写明的差异一致            |

**我自己推的硬规则与限定（不调用 core 的 `validate` / `findRoomSubjectClashes`）**：

- 把 `byStudent[].slots` 摊平成 19×7 个「考场 × 时段」格子：**每格科目集合 size ≤ 1**；
  每格座号无重复（同一座号可在不同时段复用，例如 R18 的 1 号：T1–T5 是同学甲、T6 是某生）。
- 706 人每人**应考时段无空**（语数外人人必考；选考科目 ∩ 该时段科目非空 ⇒ 必须有座）。
- 限定：C1 三个学号所有时段 `row=1`；C2 2517 全部时段 `col=1`（含某生在 R18 的借考座 1 号，
  由座号→行列**自己解**出来）；C3 史地政只在 R17；C3b 某生除借考外都在 R17；C4 物化政/物化地
  只出现在 R18（主考场）与 R19（专用考场）。
- 放宽只对 R17 生效：**除 R17 外，每个考场在它实际使用的邻接模式下同班相邻对数都是 0**；
  R17 = **40 对**（`orthogonal`，2517/2518 两班）——与 `validate` 的
  `ADJACENCY_RELAXED：跳过了 40 处` 数字一致（两条独立实现互相印证；我自己的复核器一开始把
  4 邻域的「同行左右」漏了，只数出 24，修正后 = 40）。
- 借考：某生 `T6 → R18 座 1，subject=biology`；`R18|T6` 科目集合恰为 `{biology}`；该座该时段只他一人。

### 7.3 37 座非矩形（`out/job.accept37.json`：R1/R6/R7/R12 加 `extraFrontSeats:[2,4]`）

`plan` exit 0、`validate` exit 0。实测：R1/R6/R7/R12 各 **37** 人（用满 37 座），R18 = **26**
（13 + 9 + 物化生溢出 3 + 借考 1），R17 = 29，R19 = 13/9，R1–R16 = 652，706 人全部有座。

我的复核器用**自己按 §4.5 实现**的按列蛇形编号（`n=[7,8,7,8,7]`，加座永远是本列最后一个号、行号 0）
逐座对照 `entries.row/col/physicalCol`：**37 个座号全部一致**，`15 号=(0,2)`、`30 号=(0,4)` 都是加座，
`physicalCol` 与 `cols+1-col` 互逆。`numbering --rows 7 --cols 5 --extra 2,4` 输出的 r0 行也是
`c2=30 / c4=15`，与 design §4.5.1 的图逐格相同；不传 `--extra` 时 5×7 输出与 §4.1 一致。

### 7.4 对抗用例（手改 plan.json / job.json，喂 `exam-seat validate`）

| #   | 改法（在真实 job 的 plan 上）                               | 期望           | 实测                                                                                  |
| --- | ----------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| C1  | 借考生 T6 座号改成 R18\|T6 已被别人占的 6 号                | exit 3         | ✅ `ENTRY_DUPLICATE_SEAT`「6 号在第6时段被安排了 2 个人」                             |
| C2  | 借考生 T6 科目改成化学（制造第二张卷子）                    | exit 3         | ✅ `ROOM_SUBJECT_CLASH`「R18 第6时段同时安排了 biology / chemistry」                  |
| C3  | 借考座号改成 R18 第 2 列（违反 C2 `cols:["door"]`）         | exit 3         | ✅ `CONSTRAINT_UNMET`「借考座位…不在限定要求的范围内」                                |
| C4a | **job** 删 R17.`relaxSameClass`（plan 不动）                | exit 3         | ✅ `ADJACENCY_CONFLICT`（R17）                                                        |
| C4b | **job** R17.`relaxSameClass=30`（数字上限）                 | exit 0         | ✅ 与 `true` 同样放开相邻                                                             |
| C4c | **plan** 删 `relaxedRooms`（job 仍 `true`）                 | —（观察项）    | exit 0；校验器以 **job** 为准，plan 自带标记未被交叉核对                              |
| C4d | **plan** 删 `relaxedRooms` + R17 `seating.relaxedSameClass` | —（观察项）    | exit 0；同上                                                                          |
| C5  | **job** R19 `dedicatedSubjects` 只留政治                    | exit 3（我猜） | exit 0 —— **我的期望不成立**：`dedicatedSubjects` 是排考期的用途声明，不是校验规则    |
| C6  | 把借考挪回 R17（R17\|T6 已是地理）                          | exit 3         | ✅ `ENTRY_DUPLICATE_SEAT` + `ROOM_SUBJECT_CLASH` + `ENTRY_UNKNOWN_ROOM`               |
| C7  | 真实 job `relaxSameClass=21` / `=22`（2518 有 22 人）       | 3 / 0          | ✅ 21 → `CLASS_LIMIT_EXCEEDED`「最多只能容纳该班 21 人」，exit 3、不导表；22 → exit 0 |
| C8  | `plan` 用删掉 relax 的 job（真实 706 人规模）               | exit 3 不导表  | ✅ `CLASS_LIMIT_EXCEEDED`，只留 `plan.json` + `job.json`                              |

### 7.5 显式时段 / 禁止同段 / 游标回卷

用 `out/job.tool.json`（677 人、剔除文科生后的旧 fixture，正是「时段塌陷」场景）：

| 场景                                                                     | 实测                                                                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 原样（自动推导）                                                         | `T6 = biology+politics+geography` → `ROOM_SUBJECT_CLASH`（R19），exit 3、不导表                       |
| `options.slots` 给死 7 段（§1.1 那张表）                                 | `ok=true`、7 段原样、`SLOTS_PROVIDED`(info)、exit 0、导出 4 个文件；政治/地理不再同段                 |
| `options.forbiddenSameSlot`（化学×生物/地理/政治、生物×政治、地理×政治） | 推导出 `T5=chemistry` 单独、`T7=politics` 单独、`T6=biology+geography`，exit 0；不报 `SLOTS_PROVIDED` |
| 两者同时给                                                               | **以 `slots` 为准**（给了 9 段就出 9 段，`forbiddenSameSlot` 不再影响）                               |
| `slots` 不给 id/name                                                     | 自动补 `T1..Tn` / 第 n 时段                                                                           |
| `slots` 把一人的两科排进同段（physics+chemistry）                        | `SLOTS_CONFLICT`（error，报 1354 处）+ 不导表，exit 3；**19h 已在验收脚本里固化**（见 §7.9）          |
| 借考目标考场该时段满座（42 座 42 人，借考生 T6 无空位）                  | `SUBJECT_ROOM_NO_SEAT`（error）+ 不导表，exit 3；**19i 已在验收脚本里固化**（见 §7.9）                |

**游标回卷（`allocateDemands`）**：验收第 19f 项是干净用例——整批钉考场后未钉住的 6 人回到本批次
考场，`ok=true`、无 `CAPACITY_INSUFFICIENT`。旧 fixture `out/job.intent.json`（**没有** `relaxSameClass`、
也**没有** `subjectRoom`）仍然 exit 3，但原因已经换人：R17 里 2518 的 22 人 + 未钉住的 2517 六人
（`studentIds` 实测 = {2518:22, 2517:6}），只剩 `CAPACITY_INSUFFICIENT：还缺 1 个座位` +
`CLASS_LIMIT_EXCEEDED`；给某生补上 `subjectRoom:{biology:"R18"}` 后**缺座那条消失**，只剩
`CLASS_LIMIT_EXCEEDED`——即那 1 座就是他的生物。所以「还缺 7 座」的旧症状已不复现，但
`job.intent.json` 已不适合单独充当本轮验收门禁，见 §7.8。

### 7.6 单测与验收脚本

| 命令                           | 结果                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run`         | **479 passed / 36 files**，exit 0（含本轮新增 `core/test/borrow-relax.test.ts`、`core/test/nonrect.test.ts`、`io/test/relax-extra-export.test.ts`、`web/test/seat-extra-ui.test.ts`） |
| `node examples/acceptance.mjs` | **111/111**，exit 0，266ms（dist 00:07:09；首轮 108/108 与增量过程见 §7.9）                                                                                                           |
| `pnpm exec oxlint`             | 0 error / **2 warning**（都是既有 `max-lines`，非本轮新增）                                                                                                                           |

### 7.7 导出物抽查（xlsx / 编号）

- `考场监考表.xlsx`：R17 表头多一行「**本考场已放宽同班相邻**」；**全工作簿只有 1 个数据行有备注**——
  第十八考场座位 1 的某生「**借考（第6时段 生物）**」；同一座号 1 的同学甲（T1–T5 在那）备注为空，
  证实「借考座可跨时段复用座号」。
- `按班级考场安排.xlsx`：某生 考场① = 第十七考场（语数外政史），考场② = 第十八考场（生物）。
- `numbering --extra 2,4`：见 §7.3。

### 7.8 没验证到 / 存疑（诚实标注）

1. **web 未做 E2E**：座位图 / 第③步考场配置只由 `packages/web/test` 单测覆盖，我没有浏览器级验证。
2. **plan 自带的放宽标记未被 `validate` 交叉核对**（C4c/C4d exit 0）。校验器以 job 的 `RoomSpec` 为准，
   语义上说得通（座位排布没变、job 允许放宽），但「plan 自己声明 relaxedRooms」这条信息目前不进校验判据；
   若以后要让 plan 自证，需要补契约。
3. **`SeatingPlan` 里借考生的表示是「半套」**：`studentIds` / `seatNoById` 含他（R18 = 34），
   `entries` / `studentBySeatNo` 不含他（33）；区分靠 `borrowedSubjects` / `borrowings`。
   这是 design §5.8.2 写明的口径，监考表实物也正确；但任何**按 `entries` 数人**的消费方都会少 1，
   我没有逐个核 web worker / 预览组件是否都走 borrowings。
4. **`out/job.intent.json` 是过时 fixture**：缺 `relaxSameClass` 与 `subjectRoom`，本轮只能用它观察
   游标回卷的副作用（缺座 7→1），不能当门禁；正例请用 `out/job.accept.json` / `out/job.accept37.json`。
5. **未跑 `pnpm verify`**（会重建 dist，Lead 已跑）；我的门禁是 vitest 479 + acceptance 111/111 + oxlint。
6. **复现性只抽了两处**：`out/job.accept.json` 两次 plan（递归剔除 `generatedAt`/`elapsedMs` 后逐字节一致）
   与验收脚本里的借考小 job；`accept37` 未单独跑两次。
7. **验收脚本的覆盖（3 条「写松」已按建议收紧并复验通过；历史说明保留）**：
   - `SLOTS_CONFLICT`（19h）、`SUBJECT_ROOM_NO_SEAT`（19i）、`numbering --extra`（19j）均已进 acceptance，
     且按 §7.9 的建议收紧完毕。
   - **收紧前的三处问题（历史记录，已不复现）**：19h 的 `plan?.entries?.length === 0` 在多场次下是空断言
     （多场次 `plan.json` 没有顶层 `entries`，`?? []` 恒为 0）；19i 标题写「不导出名单」但只验 exit 3 + 诊断码；
     19j 只拿常量验脚本自算公式、没和 CLI 输出比对（`numbering --json` 的 `seats` 没有 seatNo，真实座号只在
     `preview` 文本里）。
   - 仍未在 acceptance 断言：`forbiddenSameSlot`、`SUBJECT_ROOM_UNKNOWN_ROOM` / `UNKNOWN_SUBJECT` / `NO_SLOT`
     （core `borrow-relax.test.ts` 有）。
8. **真实 706/19 job 不在 acceptance 里**（`out/` 不是仓库 fixture），它的数字只在本文与 design §5.8.6 留痕。

### 7.9 增量复验（验收 108 → 111；19h/19i/19j 收紧后复验通过）

时间线：Lead 补 3 条断言（108 → 111）→ 我指出 3 处「写松」（§7.8-7 历史记录）→ Lead 按建议收紧 →
我做最后一轮复验（第三次 `pnpm build`，dist 00:07:08–00:07:09）。

| 项  | 收紧前的问题                                       | 收紧后的做法                                                                                                                                                              | 我的独立复核（dist 00:07:09）                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 19h | 「不导名单」是空断言（多场次无顶层 `entries`）     | 改为断言两份工作簿 `fileSize(...) < 0`（不存在）                                                                                                                          | ✅ 复跑 exit 3、诊断含 `SLOTS_CONFLICT`、输出 `名单文件=-1`；我另用同 job 直读文件系统：outDir 只有 `job.json` + `plan.json`                                                                                                                                                                                                                                                          |
| 19i | 标题写「不导出名单」，断言只验 exit 3 + 诊断码     | 同样补两份工作簿不存在                                                                                                                                                    | ✅ 复跑 exit 3、`SUBJECT_ROOM_NO_SEAT`、`名单文件=-1`；前提成立：R1 = 42/42、`R1\|T6` 占座 42、借考生 T6 = null，诊断证据 `{roomId:R1,slot:T6,subject:biology}`；文件系统同样只有 job/plan                                                                                                                                                                                            |
| 19j | 只拿常量验脚本自算公式，没和 CLI 输出（preview）比 | 解析 `preview` 文本逐排取 CLI 打印的座号，与脚本独立重算（物理列 pc → 业务列 cols−pc+1、列内蛇形、加座为该列最后一个号）比对；另保留 37 席 / r0 恰 2 席 / 矩形 35 席无 r0 | ✅ 我把验收的 `previewRow`/`expectedRow`/`seatNoInRoom` **逐字复制**出来独立跑：r0=[30,15]、r1=[31,29,16,14,1]、r3=[33,27,18,12,3]、r7=[37,23,22,8,7]，preview 与自算**全等**；并做 5 组 preview 变异（删 r0 行 / 30↔15 对调 / r1 的 16→17 / preview 置空 / r7 的 37→38）+ 3 组形状变异（`extraFrontSeats=[]`、`seats` 少一个、纯矩形也带 extra）→ 断言**全部翻假**，既不恒真也没写死 |

**复跑**：`pnpm exec vitest run` → **479 passed / 36 files**，exit 0；`node examples/acceptance.mjs` →
**111/111**，exit 0，266ms；`pnpm exec oxlint examples/acceptance.mjs` = 0 warning / 0 error，
`pnpm exec oxlint`（全仓库）= 0 error / 2 warning（既有 `max-lines`，非本轮新增）。

结论：三条收紧后的断言**判据正确、可失效（非自证、非恒真）**；19h/19i 的「不导名单」现在真的守住了，
19j 的编号已由 CLI 的 `preview` 输出与脚本独立重算逐排互证。未发现新问题。

### 7.10 结论

**task-15 通过（有保留，保留项见 §7.8）。**

- 4 个能力在**真实 job** 上都跑通：放宽只对 R17 生效（其余考场同班相邻 0 处）、借考不产生第二张卷子
  （R18|T6 = {biology}）、37 座编号与容量逐座正确、显式时段/禁止同段/`SLOTS_CONFLICT` 行为符合 §5.8。
- 硬规则与限定全部由**独立推导**复核：706 人 × 7 时段逐格 ≤ 1 科、座位号同段不撞、限定逐条满足。
- 对抗用例 8 组里 7 组按预期 exit 3/0（C5 是我的期望写错）；`validate` 只导 plan/job、不导名单，闸门有效。
- 未发现实现 bug；发现的都是口径/文档级观察项（§7.8 的 2、3）与旧 fixture 过时（第 4 条）。
- 增量复验（§7.9）：111/111 + 479 单测；3 条新断言曾被指出「写松」，Lead 收紧后我复验通过——
  19h/19i 的「不导名单」已由「工作簿不存在」守住，19j 已改为 `preview` 逐排与独立重算比对
  （5 组变异测试均可翻假），不存在自证或恒真。
- 环境教训：**验收必须在最后一次 build 落地后跑**，否则会出现 101/108 式的假失败。

---

## 8. task-16（Excel 交付物重做：准考证号 / 标题 / 字号 / A4 横向 / 单文件）

### 8.1 验收环境与前置

- 对象：io 新增零依赖 xlsx 写出器（`packages/io/src/xlsx.ts` + `zip.ts`）与 `schedule-export.ts`；
  `writeMultiPlanFiles` 的落盘形态（4 个主文件 + 两个子目录）。
- 环境：git `4e73e59`，工作区 dirty 56 项（本轮未 commit）。首轮 build 在 dist `01:14:34–01:14:35`；
  复验（14 条版）重新 build → `01:32:46`；快复验（15 条版）再 build → **01:41:36** 并重新复跑全部检查；
  node v24.21.0 / pnpm 12.7.0。
- 命令：`node packages/cli/bin/exam-seat.mjs plan --job out/job.accept.json --out-dir /tmp/vfy-r3 --json`（exit 0）。
- 判据来源：只读 `/tmp/vfy-r3` 的 42 个产物文件——openpyxl、`unzip -p` XML、LibreOffice `convert`
  （PDF / CSV）、自写变异脚本；不拿 io 源码常量自证（`xlsx.ts` 只当被验对象，字号一律以产物为准）。
- **隐私**：真实姓名/学号只在内存/终端比对，本文只用占位符（「某生」「`<借考生学号>`」）。

### 8.2 A 产物清单（42 个文件）

| 组         | 数量 | 实测                                                                                                                               |
| ---------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 合并工作簿 | 2    | `按班级考场安排.xlsx`（总表 + 18 班 = 19 sheet）、`考场监考表.xlsx`（20 sheet = 20 套座位）                                        |
| 单班文件   | 18   | `按班级考场安排/<班级>.xlsx`：各 1 张 sheet、sheet 名 = 文件名，且与合并版对应 sheet **逐格相等**                                  |
| 单考场文件 | 20   | `考场监考表/<第N考场（科目）>.xlsx`：同上；R19 拆成「第十九考场（政治）」「第十九考场（地理）」，与 plan 的 20 套 seating 一一对应 |
| 求解产物   | 2    | `plan.json`、`job.json`                                                                                                            |

### 8.3 B openpyxl 逐条（55/55 通过）

| 检查项       | 实测                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| sheet 结构   | 班级表 19 张（第一张「总表」+ 18 班，集合与 job 一致）；监考表 20 张、名字皆 `第N考场（科目）`、不重复                                   |
| A1 标题      | **39 张表逐个**：A1 已合并（`A1:…1`）、16pt 加粗居中、字体「等线」                                                                       |
| 字号分层     | A2 小字 9pt 灰字（meta 档）；第 3 行表头 11pt 加粗 + 浅灰填充；正文 11pt（body 档）                                                      |
| 页面设置     | 每张表 landscape / paperSize=9 / fitToWidth=1 / `pageSetUpPr.fitToPage` / freeze `A4` / `print_title_rows` 1:3                           |
| 列宽         | **每张表**总宽 ≤ 27.8cm；班级表最大 13.88cm（5 列 75 字符宽），监考表各表 6.66–13.13cm                                                   |
| 总表内容     | 706 行数据；班级列 706/706 非空；准考证号集合 == job 参考学生 id 集合（706/706）                                                         |
| 主/换考场    | 主考场列 706 行全部无括号；换考场列 23 行全部 `第N考场（科目）`（= 物化政 13 + 物化地 9 + 某生）                                         |
| 与 plan 交叉 | 每人考场列数 = plan 房间数，首列 = 该生**时段数最多**的主考场（逐人对照，0 例外）                                                        |
| 监考表内容   | A1 = sheet 名（20/20）；A2 全部匹配 `地点：… ｜ 考场人数：N`；第 3 行 5 列表头齐全；全簿无「监考：」；各表人数合计 729 = plan 座位数合计 |
| 放宽标注     | 只出现在 R17 那一张（「本考场已放宽同班相邻」）                                                                                          |
| 借考备注     | 全簿只有 1 条备注 = 某生的「借考（第6时段 生物）」                                                                                       |
| 座位号映射   | 每张表「座位号 → 准考证号」与 plan 的 `seatNoById` 逐表全等（20/20）                                                                     |

> 自查记录（**我的脚本 bug，不是产品问题**）：首轮 5 条「失败」全是我的脚本错——把空单元格 `str(None)`
> 当成内容、A2 字号预期误写 12（实际 meta 档就是 9pt）、`print_title_rows` 的 `$1:$3` 未归一化、
> `seatNoById` 的映射方向写反。修正后 55/55。写进记录是提醒后来者别把这些当产品缺陷。

### 8.4 C XML（`unzip -p` 直读）

| 检查     | 实测                                                                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 字号字体 | `xl/styles.xml` 恰有 `<sz val="9"｜"11"｜"12"｜"16">` 四档（9/11 各 3 次、12/16 各 1 次）；字体名「等线」出现 6 次（6 个字型）                                                      |
| 页面     | `<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>`、`<pageSetUpPr fitToPage="1"/>`、`<pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4"/>` |
| 冻结     | `<pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/>`                                                                                                        |
| 合并     | `<mergeCell ref="A1:E1"/>`                                                                                                                                                          |
| 行高     | 前 3 行 `ht="26" / "16" / "20"` + `customHeight="1"`，正文行**不写 ht**（交给 Excel 自适应）                                                                                        |
| 样式引用 | 班级表 sheet1：s=1 标题×1、s=3 小字×1、s=4 表头×5、s=5 正文×706、s=6 居中×2824                                                                                                      |
| 打印标题 | `xl/workbook.xml` 每个 sheet 一条 `_xlnm.Print_Titles`（班级 19、监考 20），值均为 `'<sheet 名>'!$1:$3`                                                                             |
| 打包     | `unzip -v` 全部 `Stored`（method 0）+ CRC32；`unzip -t` 无错误；ZIP 时间戳固定 1980-01-01                                                                                           |

### 8.5 D 打印（LibreOffice）

- `convert` 两本为 PDF，均 **无 missingFonts**。
- MediaBox：两本都是 `[0,0,841.889763779528,595.303937007874]` → **841.89 × 595.30pt = A4 横向** ✓。
- 页数（PDF 页树 `/Count`）：班级表 **57 页**、监考表 **37 页**。`fitToHeight="0"` 表示只锁一页宽、纵向不限，
  长表跨页是预期行为；页数都明显多于 sheet 数，未逐表核对各占几页（见 8.9）。
- CSV（`convert --sheet`）：`总表` → 709 行 = 3 行表头 + 706 行数据（第 4 列 706 行无括号、第 5 列 23 行带括号）；
  `第十八考场（语数外物化生）` → 37 行 = 3 + 34，借考备注「借考（第6时段 生物）」可读。
  LibreOffice 能完整读出大标题 / 小字 / 表头 / 正文 / 备注。
- **视觉检查不可用（按 office-xlsx 技能规则处理）**：只 `render` 了一次（`第十九考场（政治）` A1:E20 @144dpi），
  Pillow 复核合成白底后 `589×634`、通道极值 255、**标准差 0、非白像素 0 / 373426** → 渲染器故障，
  不是工作簿缺陷。随即停止全部视觉检查，**未换范围 / DPI / sheet**，改用 PDF 几何 + CSV + XML/openpyxl 作证据。

### 8.6 E 反例：23 组 XML 变异 —— 收紧后的第 20 节 **23/23 全抓住**

做法：直接改产物 xlsx 内部 XML（openpyxl 只用于读），再用**逐条复刻**的第 20 节判据判定。
三次收紧的轨迹（同一批 23 组变异）：

| 第 20 节版本            | 判据数 | 抓住      | 漏网（原 6 组）        |
| ----------------------- | ------ | --------- | ---------------------- |
| 首轮（只看 `sheet1`）   | 11     | 4/10      | M4 M5 M7 M8 M9 M10     |
| 第二轮（逐张 sheet 等） | 14     | 17/23     | M8 P12 P15 P19 P21 P22 |
| **第三轮（本次）**      | **15** | **23/23** | **无**                 |

基线：复刻的 §20 判据 **15/15 全绿**（不是靠「必然失败」抓变异）。

**上一轮 6 组漏网点，本轮各自被哪条判据抓住**（改动见 `examples/acceptance.mjs` §20）：

| 上一轮漏网                 | 本轮抓住它的判据                                                               |
| -------------------------- | ------------------------------------------------------------------------------ |
| M8 同座号两行对调准考证号  | 20e-2：备注的 `(roomId｜studentId)` 与 `plan.borrowings` **双向**比对          |
| P12 备注挪到非借考行       | 20e-2：同上（漏标 / 错挂都算错）                                               |
| P15 A2 人数 +1             | 20d-1：`考场人数：N` 断言 `N === 该表数据行数`                                 |
| P19 只留 1 条 Print_Titles | 20f-1：两个工作簿的 `_xlnm.Print_Titles` 条数分别 == 各自 sheet 数             |
| P21 去掉某张表全部样式引用 | 20f-1：每张 worksheet 必须同时有 `s="1"`(标题) / `s="3"`(小字) / `s="4"`(表头) |
| P22 单班文件内容改坏       | 20h-3：18 个班文件 + 37 个考场文件与合并版对应 sheet **逐格 JSON 相等**        |

本轮 23 组实测（J1 = 新 §20 15 条）：**M1–M10、M8b、P11–P22 全部被判负**，无一漏网；
其中原 10 组从 4/10 → 9/10 → **10/10**，13 组探针从 0（当年未跑）→ 8/13 → **13/13**。

**两点如实记录**：

1. **20h-3 是个「兜底放大镜」**：单文件与合并版逐格比对后，任何只改合并工作簿的变异会连带被它抓住
   （例如 M3/M4/M7/P15 同时命中目标判据与 20h-3）。这是好事，但解释覆盖时要知道：某些项不是靠
   「专用判据」单独抓到的。
2. **数字口径**：本轮 §20 实际是 **15 条** `check()`（`grep -cE '^\s+check\('` 计数；验收总数
   126 = 111 + 15），不是「17 条」；建议同步。
3. 我自己的辅助判据 J2（15 条，本次为快复验做过裁剪）在本次仍漏 P18/P19/P20/P21 四项，
   属于我的判据不全，不影响 §20 的结论。

### 8.7 F 单测与验收

| 命令                           | 结果                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `pnpm exec vitest run`         | **529 passed / 38 files**，exit 0                                                    |
| `node examples/acceptance.mjs` | **126/126**，exit 0，123ms（第 20 节 15 条全绿，dist 01:41:36 上复跑）               |
| `pnpm exec oxlint`             | 0 error / **2 warning**（既有 `max-lines`，非本轮新增）；单文件 `acceptance.mjs` 0/0 |

### 8.8 复现性（附）

- `考场监考表.xlsx` 两次导出 **sha256 完全一致**（该表不含时间戳）。
- `按班级考场安排.xlsx` 两次导出只差 `xl/worksheets/sheet1.xml`，逐字符 diff **仅「生成时间 HH:MM」一处**
  （01:32 → 01:34），其余 24 个 ZIP 成员逐字节相同 → 写出器本身确定性，班级表按设计记录导出时刻。

### 8.9 没验证到 / 存疑

1. **视觉检查不可用**：`render` 全白（渲染器故障），没做像素级版面检查；「打印出来好不好看」只有 PDF 几何 + CSV/XML 证据。
2. **只在 LibreOffice + openpyxl 上验过**，没在真 Excel / WPS 打开；Excel 对 `fitToHeight="0"`、`_xlnm.Print_Titles`、「等线」的解释未实测。
3. **页数分配未逐表核对**：只确认总页数 57/37 与 MediaBox，未验证「哪张表占几页 / 断行位置」。
4. **列宽换算口径**：用 1 字符宽 = 0.185cm（与实现同一约定，也是 7px@96dpi 的标准近似）；换别的字体度量结论可能变，但总表实测 13.88cm、余量很大。
5. **第 20 节覆盖已闭环**（8.6）：首轮「抽样」问题经三轮收紧后，23 组变异 **23/23 全抓住**
   （原 10 组 10/10、探针 13/13）；本轮起 20h-3 还充当「单文件 vs 合并版」的兜底放大镜。
   产品侧由我的独立检查（openpyxl 55/55、XML、PDF/CSV）确认无误。
6. **未复跑 `pnpm verify`**（Lead 已跑）；本轮门禁 = vitest 529 + acceptance **126/126** + oxlint + 8.2–8.6 的独立检查。
7. 隐私：`inputs/`、`out/` 的真实数据未抄入本文，全部用占位符。

### 8.10 结论

**task-16 通过（有保留，保留项见 8.9）。**

- 结构：42 个文件齐全；合并工作簿 + 每班/每考场单文件，单文件 1 张 sheet 且与合并版逐格一致。
- 内容：准考证号 706/706 与名单一致、班级列每行都填、主考场无括号且与该生主考场一致、换考场带科目；
  监考表 5 列齐全、无「监考：」、借考备注带时段、座位号映射与 plan 全等。
- 打印：A4 横向（PDF MediaBox 841.89×595.30pt）+ fitToWidth/fitToPage + 冻结 3 行 + 每页重复 1–3 行 + 列宽每表 ≤ 27.8cm + 字号 16/12/11/9 + 等线，XML 与 PDF 双侧证据一致。
- 反例 23 组：**产品侧 0 反例**（J1/J2 基线、8.3–8.5 全绿）；收紧后的第 20 节（15 条）**23/23 全抓住**
  （原 10 组 10/10、探针 13/13，轨迹见 8.6）。
- 预览不可用（render 全白）按技能规则如实记录，未据此做任何版面判定。

---

## 9. `packages/web` 迁移到 shadcn-vue（web-ui 轮次）

> 任务板 id 是 task-15，但文档 §7 已有一个历史的「task-15（考场级放宽）」。为避免混淆，本节按内容命名。
> 本轮最大风险是「web 测试被重写还是被删弱」，所以 §9.3 是重点。

### 9.1 环境与范围

- git `4e73e59`，工作区 dirty 88 项；本轮对象：`packages/web` 由 Element Plus 全量换成
  shadcn-vue（Tailwind v4 + reka-ui）+ 自研 `VirtualTable`，并重写一批 web 测试。
- 顺带改动（不在「web 迁移」标题内，但必须记录）：`packages/io` 的班级表格式 + 工具化配置 → 见 §9.8 / §9.9。
- 工具：node v24.21.0 / pnpm 12.7.0。判据：只读测试/源码 diff 与产物，自己跑构建、探针与变异；不改实现。

### 9.2 A：Element Plus 是否真的没了

| 检查                                                                                                                       | 结果                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `grep -rn "element-plus｜ElementPlus｜ElMessage｜<el-｜--el-" packages/web/{src,test,package.json,tsconfig.json,env.d.ts}` | 只有 **3 处注释**提到历史（`useConfirm.ts`「替代 ElMessageBox.confirm」、`VirtualTable.vue`「替代 el-table-v2」、一处测试注释），**无代码依赖**  |
| `grep -rl element-plus packages/web`（排除 node_modules）                                                                  | **0 个文件**                                                                                                                                     |
| `grep element-plus pnpm-lock.yaml`                                                                                         | **0 命中**                                                                                                                                       |
| `packages/web/node_modules`                                                                                                | 无 `element-plus` / `@element-plus` 软链                                                                                                         |
| `packages/web/package.json`                                                                                                | 依赖改为 reka-ui、@lucide/vue、class-variance-authority、clsx、tailwind-merge、vue-sonner（dev：tailwindcss、@tailwindcss/vite、tw-animate-css） |
| `main.ts`                                                                                                                  | 只有 `createApp(App).use(createPinia()).use(router).mount("#app")`，无 EP 注册                                                                   |
| `styles.css`                                                                                                               | `@import "tailwindcss"` + shadcn 主题变量，无 `--el-*`                                                                                           |

**结论：代码 / 依赖 / lock / 软链 0 残留**，剩下的仅是有意保留的历史注释。

### 9.3 B：测试有没有被写弱（重点）

**diff 规模**：`git diff --stat packages/web/test/` = 12 个文件改 + 2 个新文件，**+1040 / −107 行**。
**expect 总量**：HEAD 544 → 现在 **753（+209，+38%）**；且**每个改动文件的 expect 与 it 数都不少于改前**：

| 文件 | expect | it | | 文件 | expect | it |
| ----------------- | ------ | --- | | --------------------- | ------ | --- |
| import-mapping | 53→64 | 15→16 | | step-result-multi | 42→68 | 10→15 |
| job-contract | 48→77 | 12→17 | | step-solve-multi | 43→52 | 5→7 |
| result-store-multi| 56→67 | 8→11 | | stores | 31→52 | 6→8 |
| seat-grid | 35→70 | 10→17 | | virtual-table | 22→24 | 9→10 |
| session-export | 36→64 | 18→25 | | absent-import/app-smoke | 31/2 不变 | 不变 |
| step-exclude-virtual | 22→24 | 5→6 | | 新文件 | seat-extra-ui 18 / session-export-zip 17 | 4 / 6 |

**逐条核对 107 行删除**（没有发现被删掉的旧断言）：

1. `import ElementPlus` + `app.use(ElementPlus)`（4 个文件）→ 迁移必需。
2. EP 选择器 → 新 DOM 选择器，**语义等价或更强**：
   `.el-table-v2__row`→`.vt-row`；`.el-input__inner`→`#exclude-query`；`.el-checkbox__input.is-indeterminate`→`.vt-select-all[aria-checked="mixed"]`；
   `.el-form-item.is-error`→`[data-invalid='true']`。import-mapping 更是从「没有错误样式」加强为
   「三个下拉的值 == 0/1/2，且必填未识别时 id 下拉停在 -1」。
3. `describe("makeRoomLookup 纯函数")` 4 条删除：**函数本身已从源码移除**（只剩 `makeRoomLayout`），
   其职责（把 location/note 交给 io）改由 io 直接读 `RoomSpec`/`seating`；新测试用**真实 io 往返**
   （`buildClassScheduleSheets`/`buildInvigilatorSheets` + 自解 ZIP + SheetJS 读回）覆盖产物内容。
4. 两条 mock 断言（`buildClassScheduleWorkbook` 的调用参数）→ 换成真实工作簿/ZIP 内容断言。
5. `ElMessageBox.confirm` spy → `useConfirm` 回调断言；「一键移除空置考场」的 title/description、
   rooms store 删除、结果作废回到空状态**全部保留**。
6. VirtualTable 的 `ResizeObserver` stub 删除（自研组件不再需要），并**新增**「滚动后窗口移动」一条
   （原来只断言第一屏）。
7. 模式切换由 EP radio `input` 改为 `[data-testid="solve-mode"] button`，仍断言 worker `mode=single` 与 `store.mode`。

**任务列出的关键覆盖点逐项在不在**（关键词计数 HEAD→现在）：
虚拟滚动 3→3、全选 11→11、缺考 29→33、列映射 4→4、job.json 往返 7→10、多场次 18→21、
ZIP 0→18、空置 18→19、加座 0→34、放宽 0→31、借考 0→23、诊断 2→2、冲突 5→5、六页挂载 6→6、
准考证号 16→20。**唯一下降的是「监考」5→4**：删掉的是 `makeRoomLookup 按考场 id 取地点与监考`
（载体消失，见第 3 条），其余 4 处保留。

**我认为丢掉的覆盖点（很少，均为「载体下沉」而非删弱）**：

1. web 层不再断「把 location/note 传给 io」；且 exported 监考表「不含监考老师」现在只有 io/acceptance
   级断言，web 结果页概览**仍展示** `seating.note`（含监考老师）——两者口径不同，若要防回归建议在
   web 侧补一条「导出的监考表不含『监考：』」。
2. `app-smoke` 仍只断言「能挂载 + innerHTML>200 + 含排考场」，不点交互（与改前一致，非本轮退化）。
3. `worker-e2e.test.ts` 只有 1 条（既有）。

**结论：没有发现被删弱或删掉的旧断言**；新增覆盖（job-contract 的默认值/非法值过滤/错误分支、
session-export 的借考放宽 + 真实 ZIP、seat-extra-ui 的加座 DOM、virtual-table 的滚动窗口）明显多于删除。

### 9.4 C：独立行为探针（我自己的，7/7 通过）

探针在 `/private/tmp/vfy-web/probe.test.ts`，用独立 vitest 配置（alias 指向仓库源码，不进仓库），
数据用 `out/job.accept.json` + 当场导出的真实 plan：

| 探针                 | 断言                                                                                                                                                                                                                        | 结果 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| C1 导出层（706 人）  | 总表 706 行「班级」「准考证号」非空；`主考场` 列不带括号、`单科考场N` 列 = `第N考场（科目）`；每个考场列后紧跟 `…地点` 且与 job 的 location 一一对应（19 个房间）；不再出现 `考场①`                                         | ✅   |
| C1b 监考表（20 张）  | A1 = sheet 名、A2 = `地点：… ｜ 考场人数：N`、表头五列、**全簿无「监考：」**；R19 拆「政治」「地理」两张；唯一借考备注 = `借考（第6时段 生物）`                                                                             | ✅   |
| C1c ZIP              | `buildClassFilesZip` = 19 个条目（总表 + 18 班）、`buildInvigilatorFilesZip` = 20 个条目，条目名 = sheet 名 + `.xlsx`；Python `zipfile` 读出中文名正常、解出的单表工作簿 openpyxl 可开（详见 §9.10-7 的 `unzip` 6.00 限制） | ✅   |
| C2 StepResult 挂载   | 真实多场次结果下「借考与放宽」卡片 + 「1 个考场已放宽同班相邻：第十七考场」+ 导出按钮都在；虚拟表渲染行 >0 且 <80                                                                                                           | ✅   |
| C3 加座预览          | `5 列 × 7 排 = 37 座`、`含 2 个讲台侧加座`、第 0 排两格 = `30` / `15`、空位列 3 个                                                                                                                                          | ✅   |
| C4 自研 VirtualTable | 1000 行只渲染 <50 行；`scrollTop = 44 × 500` 后首行不再是 0001 且页内出现 0501                                                                                                                                              | ✅   |

**口径差异（记录，不是缺陷）**：页面「座位方案概览」仍显示 `监考：…`（取 `seating.note`），
而 Excel 监考表按上一轮契约**不含**监考老师——评价「监考表没有监考老师」时只能指导出物。

### 9.5 D：体积与构建（口径差异）

命令：`pnpm --filter @exam-seat/web exec vite build --outDir /tmp/webdist-check`（不动仓库 `dist/`）。

| 口径                       | 我的实测（字节）                                              |
| -------------------------- | ------------------------------------------------------------- |
| dist 全部（html + assets） | **1,282,728 B = 1.223 MiB**（十进制 1.28 MB）                 |
| CSS                        | 4 个文件 **98,157 B = 95.9 KiB**；最大 `index-*.css` 96,003 B |
| JS                         | 28 个文件 **1,184,009 B = 1.129 MiB**                         |
| 主 chunk                   | `index-*.js` **108,041 B**                                    |
| 最大 JS                    | `roster-*.js` **695,112 B**（SheetJS 等被拆成独立 chunk）     |

与 web-ui 报的对照：

| 项       | web-ui        | 我的实测                     | 说明                                                                                                               |
| -------- | ------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| dist     | 2.4M → 1.3M   | 1.223 MiB（≈1.28 MB）**✓**   | 「后」一致；**「前」我没能独立复现**（见下）                                                                       |
| CSS      | 480K → 108K   | **98,157 B（95.9 KiB）**     | **「后」对不上**：98,157 B ≈ 98 KB，而 `108,041 B` 恰好是主 chunk `index-*.js` —— 疑似把 JS 主 chunk 当成 CSS 报了 |
| 主 chunk | 955.8K → 108K | `index-*.js` **108,041 B** ✓ | 一致；代码分割后主 chunk 只剩框架 + 外壳，xlsx 进 `roster` chunk                                                   |

**为什么「前」不可独立复现**：HEAD 的 web 依赖 element-plus，但本轮已把它从 pnpm store **prune**
（`node_modules/.pnpm/element-plus@*` 不存在、`packages/web/node_modules` 也无软链）；离线重建 HEAD
需要重新 install（会改 lockfile/工作区，超出验收范围）。所以 2.4M / 480K / 955.8K 三个「前」值是
**实现者口径，未独立复核**——按你的要求，以我的实测为准。

### 9.6 E：反例（4 组变异，全部被现有测试抓住）

做法：`cp -R packages/web/src /private/tmp/mut-web/src`，只改**副本**，把仓库自带 web 测试的 `@` alias
指向副本再跑——这样能真答「现有测试抓不抓得住」，又不碰仓库。

| #   | 变异                                                       | 结果                                                                      |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| E1  | `VirtualTable` 改成渲染全部行（start=0 / end=rows.length） | ✅ 2 个文件失败、**5 条断言失败**（virtual-table + step-exclude-virtual） |
| E2  | `safeExportFileName` 不清洗（直接 return name）            | ✅ 2 个文件失败、**3 条失败**（session-export + session-export-zip）      |
| E3  | `StepResult` 空置考场列表恒为 `[]`                         | ✅ 1 个文件失败、**1 条失败**（「空置考场被点名列出…」）                  |
| E4  | `VirtualTable` 表头全选只选「渲染行」而非全部 rowKey       | ✅ 1 个文件失败、**2 条失败**（「全选当前 rows 全量」）                   |

基线（未变异）4 个文件 **56/56 通过**。→ 这四处最容易写弱的行为都还有牙；**没有抓不住的**。

### 9.7 F：复跑

| 命令                           | 结果                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `pnpm exec vitest run`         | **548 passed / 39 files**（node 353 / 18 files、web 195 / 21 files），exit 0 |
| `node examples/acceptance.mjs` | **130/130**，exit 0，380ms（§20 已扩到 19 条）                               |
| `pnpm exec oxlint`             | **0 error / 2 warning**（既有 `max-lines`）                                  |
| `pnpm lint:check`              | ❌ **失败**：`oxfmt --check` 报 **`AGENTS.md`** 有格式问题                   |

`AGENTS.md` 的 `git diff` 只有 1 行（Web 技术栈改成 shadcn-vue），但它没过 oxfmt：当前工作区
`pnpm exec oxfmt --check AGENTS.md` 可稳定复现。**这与你说的「pnpm verify exit 0 / oxfmt 全合规」不一致**——
`AGENTS.md` 不在我的写权限里，留给你们 `oxfmt AGENTS.md` 修一下即可。

### 9.8 G：工具化配置评审

| 改动                                                                 | 判断                                        | 依据                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| oxlint `import/max-dependencies` → 40（`packages/web/src/**`，warn） | ✅ 合理                                     | HEAD 无此 override（走预设默认）；Vue SFC 会把模板里的子组件算成 import（App.vue 23、StepExclude 18）；warn 级不阻塞                                                                                                                                                                                                                                                                                                                                                   |
| oxlint 对 `components/ui/**` 关 6 条                                 | ✅ 合理且必要                               | 我用独立配置重开这 6 条实测：`ui/**`（181 个 `.vue` + 38 个 `index.ts`）报 **38 条 `import/no-cycle`** + 9 条其它（no-negated-condition ×6、no-implicit-coercion、no-else-return、array-type）；6 条全是风格/架构规则，**无 correctness 规则**，且范围只覆盖上游生成目录                                                                                                                                                                                               |
| oxfmt 忽略 `.agents/skills/shadcn-vue/**`                            | ✅ 合理                                     | 上游 skill（`skills-lock.json` 记 hash），本仓自己的 `.agents/skills/exam-seating/**` 仍格式化                                                                                                                                                                                                                                                                                                                                                                         |
| .gitignore 加 `.claude/`、`.continue/`                               | ✅ 合理                                     | skills CLI 给别的 agent 生成的副本                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| .gitignore 另加 `inputs/`、`out/`、`docs/需求-*.md`                  | ⚠️ 隐私动机对，但 `docs/需求-*.md` 值得再想 | `inputs/`、`out/` 含真实姓名，必须忽略；但 `docs/需求-考场级限制与放宽.md` 是被 `design.md` 引用的**设计输入**，整文件 ignore 会让干净检出丢掉需求单。更小的做法：保留文件、把真实姓名/学号换成占位符后入库                                                                                                                                                                                                                                                            |
| `pnpm-workspace.yaml` `allowBuilds: vue-demi: true`                  | ⚠️ 字段选对，但有残留死键                   | 实测 pnpm 12.5.1 / 12.8.1 的 dist 只有 `allowBuilds`、没有 `onlyBuiltDependencies`（11.15.1 两者都有）→ 12.x 下 `allowBuilds` 才是生效字段；但文件里还留着 `onlyBuiltDependencies: []`（pnpm 11 语义 = 只允许列表内构建），在 12 下是死键且语义打架，**建议删**。必要性：vue-demi 0.14.10 的 postinstall 只切换 shim，而出货的 `lib/index.mjs` 已经是 Vue 3 shim（`isVue3 = true`），所以大概率可不加；加上无害、能消掉「ignored build scripts」提示，属可接受但非最小 |

### 9.9 本轮顺带的 io 交付物变更（不在「web 迁移」标题内，但必须记录）

- `packages/io/src/schedule-export.ts`（本任务里仍是未跟踪新增文件）在本轮又被改过：班级表列名由
  `考场① | 考场②` 换成 **`主考场 | 主考场地点 | 单科考场1 | 单科考场1地点 | …`**，新增**地点列**与
  **姓名按宽度截断**（`displayStudentName` / `fitNamesToA4`，默认 5 个字）。我用 CLI 复现过
  （12:48 导出的表头就是新格式），`docs/design.md` 也同步写了新列定义与「主考场不带括号、单科考场才带科目」。
- 影响：**§8（task-16）里「考场①/②」的原文已被本轮取代**；验收 §20 从 15 条扩到 **19 条**
  （新增：地点列一一对应、不再出现旧列名、正文居中、姓名整表不超宽时不截断），130/130 通过；
  我的 §9.4 C1 探针即按新格式独立核对。
- **提醒**：这是跨包改动，任务标题写的是「web 迁移」，却改了 CLI 交付物格式。后续再动这里时，
  记得同步 §8 的段落（或给 §8 加一条「已被 §9.9 取代」的指针）。

### 9.10 没验证到 / 存疑

1. 迁移**前**的体积（2.4M / CSS 480K / 主 chunk 955.8K）**没能独立复现**：element-plus 已从 store prune，离线重建 HEAD 不可行。
2. web 只跑了单测 + 自写探针，**没有浏览器级 E2E/真机视觉**；shadcn 组件的观感（间距、暗色、响应式）未看。
3. `components/ui/**` 181 个上游组件按约定不写测试，我也没逐个审源码（只审了 lint 豁免范围与来源）。
4. `app-smoke` 只做挂载冒烟；跨页交互没有 E2E。
5. `pnpm lint:check` 当前失败（AGENTS.md 未过 oxfmt）；`pnpm verify` 我未复跑。
6. 隐私：本文与探针都没把真实姓名/学号写进文档，探针只在内存里使用真实 plan。
7. **ZIP 中文名的「疑似乱码」是 macOS `unzip` 的限制，不是产品缺陷**：我一度以为 `buildZip` 没写 UTF-8
   标志位（macOS `unzip` 6.00 打印的是乱码、还拒绝解压中文名），但复核 ZIP 头：本地头与中央目录的
   general purpose flag 都是 **0x0800（UTF-8 位已置）**，Python `zipfile` 读出 `总表.xlsx` /
   `第一考场（语数外物化生）.xlsx` 等名字全部正常，解出的工作簿 openpyxl 也能打开。
   即：标准合规，Apple 版 Info-ZIP 6.00（2009）是已知旧工具限制。教学场景用 Windows 资源管理器 /
   macOS 归档实用工具一般没问题，但用老 `unzip` 命令行会看到乱码——记在这里免得以后重复踩。

### 9.11 结论

**通过（有保留，保留项见 §9.10）。**

- **A（EP 清除）**：代码/依赖/lock/软链 **0 残留**，仅 3 处历史注释。
- **B（测试是否被写弱）**：**没有发现被删弱或删掉**——web expect 544→753（+38%），每个改动文件的
  expect/it 都不少于改前；107 行删除全部有等价或更强替代；4 组针对性变异 4/4 被现有测试抓住。
  唯一「丢掉的覆盖」是 location/note 传递的 web 级断言（职责下沉到 io，io 级仍覆盖）。
- **C（行为等价）**：7/7 独立探针通过（706 人总表口径、监考表无监考老师、加座第 0 排、VirtualTable 窗口移动）。
- **D（体积）**：当前 dist **1,282,728 B（1.223 MiB）**、CSS 98,157 B、JS 1,184,009 B、主 chunk 108,041 B；
  「CSS 108K」对不上（疑似与主 chunk 混淆），三个「前」值未独立复核。
- **E（反例）**：4/4 被抓。
- **F（复跑）**：548 单测 + 130 验收通过；⚠️ `pnpm lint:check` 当前失败于 `AGENTS.md` 的 oxfmt 格式。
- **G（配置）**：6 条 lint 豁免与 max-dependencies 40 有实测依据、范围合理；`onlyBuiltDependencies: []`
  在 pnpm 12 下是死键建议删；`docs/需求-*.md` 整文件 ignore 建议改成脱敏后入库。

---

## 10. 专属组合考场 / 单场语义修正 / 预设统一（task-25）

### 10.1 环境与范围

- git `fd01850`，工作区 dirty 42 项；dist 构建时间 **14:36:46–14:36:48**（`pnpm build`）；node v24.21.0 / pnpm 12.7.0。
- 本轮对象：core 新增 `RoomSpec.combination`（专属组合考场）、单场下忽略该字段并给 warning、`precheck` 建议动态化；
  cli `small` 预设统一成 5 列 × 7 排 = 35 座、单场终端也打印 warning；web 的 `combination` 往返 + 「专属组合」列 + 一批文案/交互。
- 判据：只读源码 diff 与产物，自己写探针/变异；不改实现（写权限仅本文档）。

### 10.2 A：契约与事实（我逐个触发过，没有死码）

| 码                                   | 级别    | 我如何触发                                                              | 结果                                                                       |
| ------------------------------------ | ------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ROOM_COMBINATION_APPLIED`           | info    | 合成分房：房钉「史地政」且名单有该组合                                  | ✅ 带上 `roomIds`（多间时含全部钉住考场）                                  |
| `ROOM_COMBINATION_IGNORED_DEDICATED` | warning | 同一房同时设 `combination` 与 `dedicatedSubjects`                       | ✅ 组合优先，分配结果与「只有组合」逐条相同                                |
| `ROOM_COMBINATION_IGNORED_SINGLE`    | warning | `plan --single`                                                         | ✅ 有该 warning、**无** `SEARCH_FAILED`、exit 0                            |
| `ROOM_COMBINATION_UNKNOWN`           | warning | 房钉「物化政」但名单没有该组合                                          | ✅ warning + 该房空置（`emptyRooms` 里是**考场名**），导出不阻断（exit 0） |
| `ROOM_COMBINATION_MISMATCH`          | error   | 用 `validateAll` 校一份被我篡改的结果（把物化生的人塞进史地政专属考场） | ✅ 独立复算报 error                                                        |
| `ROOM_COMBINATION_UNMET`             | error   | 同上，把史地政学生的主考场改出专属考场                                  | ✅ 独立复算报 error                                                        |

- **归一化**：房写「政史地」与写「史地政」→ 分配（含座位号）逐条相同 ✅。
- **多间同组合**：6 人 / 两间 → 全进第一间、第二间空置；40 人 / 两间各 35 座 → 按 `rooms` 顺序分流、第一间先吃满 35 ✅。
- **容量失败不混排**：40 人史地政 + 专属房 35 座、另有 6 人物化生在普通房 → exit 3、`CAPACITY_INSUFFICIENT`(error)，普通房仍只有那 6 人，专属组合的人**没有被偷偷混排** ✅。
- **独立校验器**：`validate-combination.ts` 只吃 `job` + 最终结果自己重算（不复用 `planAll` 中间结论）；干净 plan 0 issue，两类篡改各自报 error ✅。
- **precheck 建议真的动态**（不再写死 30/42）：`max=35` → 「B 30 座 → 改成 35 座可多放 5 人」+「加 1 个考场（5 列 × 7 排，35 座）」；`max=49` → 「30 座 → 49 座可多放 19 人」+「加 1 个考场（7 列 × 7 排，49 座）」✅。
- **两端同义**：CLI `template` 出的 R1 = 7 排 × 5 列 = 35；`rooms --help`/错误文案都写「5 列 × 7 排 = 35 座」；web `ROOM_PRESETS.small` 也是 `{rows:7, cols:5}` ✅。

### 10.3 B：等价性与复现（自己写的合成 job + 真实 job 只读对拍）

合成 job（18 人 / 2 房，`/private/tmp/vfy-r25-check.mjs`，**18/18 通过**）：

1. `rooms[].combination='史地政'` 与「限定 `{combinations:['史地政'], roomId:'R2'}`」→ **分配（学生×时段×考场×座位号×科目）逐条相等**、各自 `seatNoById`/科目集合相等；两者诊断差一条 `ROOM_COMBINATION_APPLIED`（组合写法多一条，限定写法没有）。
2. 写法归一化 → 同样相等。
3. 同 job 同 seed 跑两次，剔除 `generatedAt`/`elapsedMs` 后 plan.json 逐字节相同（复现性）。

真实 job 只读对拍（706 人 / 19 房，`/private/tmp/vfy-r25-real.mjs`）：把约束 `C3-文科整批在高二18班`（`combinations:['史地政'] → roomId R17`）换成 `rooms[R17].combination='史地政'`：

- 分配哈希 `59fdf9c8…` 两次相同、seating 哈希 `d3078ece…` 两次相同；每考场人数逐个相同（R17 29 / R18 34 / R19 9 …）。
- 剔除 `generatedAt` / `elapsedMs` / `diagnostics` / `inputFingerprint` 后**整文件相等**；差异只有 `+ROOM_COMBINATION_APPLIED`、`inputFingerprint`（输入本身变了，理应不同）与时间戳。
- 结论：**「新字段写法 == 限定写法（连座位号）」成立**，且是逐字段可复算的，而不只是抽样相同。

> 我自己的两个脚本 bug（记下来免得再踩）：`plan.emptyRooms` 给的是**考场名**（「第二考场」）不是 id；`byStudent[].combination` 是**归一后**的写法（「政史地」）。两次比错都出在这里，不是产品问题。

### 10.4 C：反例（5 组，1 组抓不住）

做法：`cp -R packages/core/src packages/core/test` / `cli` 到 `/private/tmp/base-core|base-cli`，只改副本，
用独立 vitest 配置（alias `@exam-seat/core` → 副本）跑**仓库自带的 229 条 core/cli/node 测试**；仓库文件不动。

| #   | 变异                                                          | 现有测试                                                  | 失败用例（前 2 条）                                                                                                        |
| --- | ------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| M1  | `combination` 比较从「相等」放宽成「包含」（双向 `includes`） | ✅ **抓住（补测后 2 失败）**；补测前 229/229 全绿（见下） | 「① 房钉「史地」+ 名单里是「史地政」…不收人、UNKNOWN、房空置、ok」「② 反向：房钉「史地政」+ 名单里是「史地」→ 同样不匹配」 |
| M2  | 多间钉同一组合只认第一间（`requiredRoomIds.slice(0,1)`）      | ✅ 抓住（2 失败）                                         | 「两个考场钉同一组合、人数超过单室 → 按考场顺序分流」「正常结果都通过独立校验」                                            |
| M3  | 单场静默忽略（删掉 `ROOM_COMBINATION_IGNORED_SINGLE`）        | ✅ 抓住（2 失败）                                         | 「单场 plan：ok、有 warning、不再有 SEARCH_FAILED」「带 combination 的考场在单场成功时，终端能看到 warning」               |
| M4a | CLI `small` 改回 6 排 × 5 列 = 30 座                          | ✅ 抓住（3 失败）                                         | 「small / large 展开成 35 人与 42 人的考场」「中文别名和别的乘号也能认」「混合规格的总容量算得对」                         |
| M4b | `NxM` 解析成「N 列 × M 排」（行列互换）                       | ✅ 抓住（2 失败）                                         | 「自定义 NxM 按「N 排 × M 列」解析」「中文别名和别的乘号也能认」                                                           |

**M1 缺口已补测并复验通过（task-26 快复验）**：原有测试没有任何 fixture 让两个组合串互为子串
（都是 `物化生`/`史地政`/`物化政` 这种等长互不包含的写法），所以第一轮 M1 能溜过去；我当时另写探针证明了它**有害**
（房钉 `史地`、名单是 `史地政` 时，变异会把 6 人整批错误收进该房）。现在 `room-combination.test.ts` 补了 3 条 fixture：

- ① 房 `史地` + 学生 `史地政`（互为子串但不相等）→ 不收人 + `UNKNOWN` warning + 房空置 + 结果 ok + `validateAll` ok；
- ② 反向：房 `史地政` + 学生 `史地` → 同样不匹配；
- ③ 正例对照：房 `史地政` + 学生 `政史地`（写法不同、归一化相等）→ 必须匹配 + `APPLIED`。

我**重新跑了 M1 变异**（副本实现，仓库文件未动）：基线 232/232 全绿；把相等放宽成 `includes` 后
**①② FAIL、③ 仍 ✓**（`2 failed | 230 passed`）——既抓住了这类变异，又没有把「归一化相等」的正例一起否掉。
实现侧也确实未动：`packages/core/src` 整个目录与我 task-25 时的快照逐文件 `diff` 一致（`plan-all.ts` 仅 mtime 变了）。
验收第 21h 条做了同样的互为子串断言（现为 140/140）。

### 10.5 D：网页层（我自己的 4 条探针 + 源码核对）

探针 `/private/tmp/vfy-r25-web.test.ts`（独立配置，alias 指向仓库 `packages/web/src`），**4/4 通过**：

1. `combination` 往返保留原写法（房写 `史地政`，导出→导入仍是 `史地政`）；草稿改字段不污染原 job；**把这份 job 交给 core `planAll`，「史地政」仍能钉住名单里写「政史地」的整批**（跨包一致）。
2. 非法值过滤：`" 物化生 "`→`物化生`、`" "`/`42`/`null` → 字段消失。
3. 导出标题/文件名：空标题退回「考场排布」；脏标题 → `exam-seat.状态.json`；`serializeJob` 顶层就是 job（没有 `{job:...}` 包装）。
4. 诊断面板只给人话：`ROOM_COMBINATION_APPLIED` 的诊断显示原文 + 「信息」，**不出现** code 名、`roomId`、`{`。

源码核对（配合仓库自带 `job-contract.test.ts` / `seat-extra-ui.test.ts` / `diagnostics-panel.test.ts`，这三处已有等价断言）：
品牌「考场排布」、导出/导入按钮文案例「排布状态.json」、App.vue 里**没有** plan.json 导出；下拉选项额外并入该行原值，保证非归一写法能回显，清空 → `combination: undefined`（字段消失）；同时设专用科目 → 「设了专属组合后，本考场不再走专用科目」提示。

### 10.6 E：复跑

| 命令                                               | 结果                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pnpm exec vitest run`                             | **593 passed / 43 files**（node 382 = core 191 + io 150 + cli 41；web 211），exit 0                      |
| `node examples/acceptance.mjs`                     | **140/140**，exit 0，315ms（第 21 节 10 条，含 21h 互为子串断言）                                        |
| `pnpm lint:check`                                  | **全绿**：oxlint 0 error / 2 warning（既有 `max-lines`）；oxfmt 362 文件全合规                           |
| `exam-seat template` / `rooms --spec "1:5x"`       | R1 = 7×5 = 35 座；错误文案「可用 small（5 列 × 7 排）/ large（6 列 × 7 排）/ 6x4（6 排 × 4 列）」        |
| `exam-seat plan --single`（带 combination 的 job） | exit 0，终端打印「单场模式下所有考生考同一份卷子，第二考场的专属组合「政史地」不生效（按普通考场处理）」 |

### 10.7 边界与存疑

1. ~~**M1 是真实的测试缺口**~~ → **已补测**：task-26 在 `room-combination.test.ts` 加了 3 条互为子串 fixture，我复跑 M1 变异已能抓住（①② FAIL、③ ✓），实现未动（`core/src` 与我 task-25 快照逐文件一致）。
2. 变异只做了 core/cli 的 5 处；**web 层没做变异**（本轮 web 改动是往返/列/文案，风险低，且上轮已做过 4 组）。
3. 真实 job 对拍只换了 C3 一处；`C3b`/`C4` 与专属组合的交互没逐一对拍（合成 job 覆盖了互斥/多间/容量）。
4. 没做浏览器 E2E；网页文案是源码 + DOM 断言，**观感/布局未看**。
5. 我只跑了 vitest / acceptance / lint:check，**没有复跑 `pnpm verify`**（typecheck 未由我复核）。
6. 隐私：全部用占位姓名（同学甲/乙、甲0/乙0…）；真实 job 只读对拍只输出哈希与人数，没有把姓名/学号写进本文。

### 10.8 结论

**通过（M1 已补测并复核；无遗留缺口）。**

- **A 契约**：6 个码全部真实可达、级别符合预期（3 warning + 1 info + 2 error）；归一化、多间分流、互斥、未知组合、容量不混排、单场忽略、precheck 动态建议都独立复现。
- **B 等价性**：合成 job 18/18；真实 706 人 job 的 `combination` 与限定写法**分配/座位号逐条一致**，同 seed 可复现。
- **C 反例**：M2/M3/M4a/M4b 原本就被抓住；**M1（相等→包含）在补测后也被抓住**（我重跑变异：`2 failed | 230 passed`，且归一化正例仍 ✓）。首轮报出的缺口已闭环。
- **D 网页层**：4/4 独立探针通过（往返、非法值、文件名、面板不泄露）；「专属组合」列的已有测试也覆盖回显/清空/互斥。
- **E 复跑**：**593 单测 + 140 验收** + lint 全绿。

---

## 11. 名单「性别 / 备注」列不再解析（task-27 窄轮）

### 11.1 范围

名单里的「性别」「备注」列**不再解析**（解析进 job 后没有任何排考/校验/导出逻辑使用）；导入说明文案改准。
io 侧删掉 `RosterMapping.gender/note`、别名与 `FIELD_PRIORITY` 项，`parseRoster` 不再产出 `student.gender/meta`；
**core 的 `Student.gender` / `Student.meta` 类型字段保留**（老 job.json 兼容），web `job.ts` 的 job 往返也不动。
本节只做窄复验：真实 xlsx 行为、全局残留、2 组反例、复跑数字。

### 11.2 A：真实 xlsx 夹具（我写的探针，2/2 通过）

夹具：合成 `名单` 表，列 = `学号 | 姓名 | 班级 | 性别 | 备注 | 选科 | 缺考`，4 行占位学生（同学甲…丁），
其中两行带「是 / 病假」缺考标记。走 `@exam-seat/io` 源码的 `readRoster(bytes)`：

- 列映射 = `{id:0, name:1, className:2, combination:5, absent:6}`；**没有** `gender` / `note` 键；
  「性别」「备注」两列被跳过、没有抢占任何字段（缺考排在选科前，`否` 不会被当成「选科」）。
- `students[0..3]` 每个对象都**没有** `gender`、**没有** `meta`（`every(!("gender" in s) && !("meta" in s))`）。
- 「选科」照常：`['物化生','史地政','物化政', undefined]`；「缺考」照常：`included` = `[undefined,false,undefined,false]`。
- 备注文本（`班长`/`转学生`/`学委`）与性别值（`男`/`女`）在整个 `students` JSON 里都搜不到。
- 只读对照 `out/roster.json`：学生字段集合里没有 `gender` / `meta`（真实名单不打印姓名/学号）。

> 我自己踩的坑：`included` 的缺省是 **`undefined`（= 参加）**，只有缺考标记才显式 `false`；
> 第一版断言写成 `[true,false,true,false]` 误判成失败，已改对。

### 11.3 B：全局残留

`grep -rn "性别|gender" packages/*/src` 只剩三类、都在预期内：

| 位置                                                  | 内容                                                                | 判断                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------- |
| `packages/core/src/types.ts:66`                       | `gender?: string` 类型字段                                          | ✅ 保留（老 job.json 兼容），类型注释也说明了 |
| `packages/web/src/lib/job.ts:181`                     | `if (typeof item.gender === "string") student.gender = item.gender` | ✅ job.json 往返读照写，未动                  |
| `packages/io/src/index.ts`（2 处注释 + 1 处表头说明） | 「性别/备注一律忽略」的文档说明                                     | ✅ 只是注释                                   |

`parseRoster` 里不再有任何写 `student.meta` / `student.gender` 的代码（只有一行注释说明为什么不再产生）；
web `demo.ts` 不再生成 gender；列映射面板（`StepImport.vue`）恰好 **5 项**：准考证号\*、姓名\*、班级\*、选科（据此排多场次）、缺考（有内容即不参加）；
页面导入说明与行为一致：「至少要「准考证号（学号 / 考证号）/ 姓名 / 班级」三列；有「选科」列会自动读取（据此排多场次），有「缺考」列会自动排除；其它列忽略」。

### 11.4 C：反例 2 组

做法同前几轮：`packages/io/{src,test}` 复制到 `/private/tmp/base-io`，只改副本，独立 vitest alias 指向副本；仓库文件不动。

| #   | 变异                                                          | io 单测（153）                                       | web 全套（211）                     | 结论                        |
| --- | ------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------- | --------------------------- |
| C2  | `parseRoster` 又把「备注」塞进 `student.meta`                 | ✅ 抓住（1 失败：「备注列不会被读进 student.meta」） | ——                                  | 补测已生效                  |
| C1  | 把「选科」列也一起忽略（`FIELD_PRIORITY` 去掉 `combination`） | ✅ **抓住（补测后 2 失败                             | 151 passed）**；补测前 151/151 全绿 | ❌ 211/211 绿（补测前也绿） | 已补测并复核 |

**C1 缺口已补测并复核（task-27 收尾复验）**：首轮我报出「选科自动识别」没有单测兜底——变异后
`readRoster` 的 `mapping.combination` 变 `undefined`、4 个学生的 `combination` 全丢（多场次排考就不会触发），
当时只有验收的 `check("识别出选科列", …)` 会失败（我把 CLI 的 `readRosterFile` 指向变异 io 复现过）。
现在新增 `packages/io/test/roster-mapping-regression.test.ts`（2 条，表头 `学号|姓名|班级|性别|选科|缺考|备注`，
断言 `combination===4`、`absent===5`、映射值不含性别/备注列、combination 原文 + `subjects` 规范序、缺考生效、
学生对象无 `gender`/`meta`）。我**重跑 C1 变异**：基线 153/153 全绿；去掉 `combination` 自动识别后
**正好新加的那 2 条失败、其余 151 条仍绿**（`2 failed | 151 passed`）——单测层已经能抓住，闭环。
io 实现未动：仓库 `FIELD_PRIORITY` 仍是 5 项，`packages/io/src/index.ts` mtime（15:21）早于新测试（15:28）。

### 11.5 D：复跑

| 命令                           | 结果                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `pnpm exec vitest run`         | **596 passed / 44 files**（node 385 = core 191 + io 153 + cli 41；web 211），exit 0 |
| `node examples/acceptance.mjs` | **140/140**，exit 0，288ms                                                          |
| `pnpm lint:check`              | 全绿（oxlint 0 error / 2 warning；oxfmt 363 文件全合规）                            |

### 11.6 存疑

1. ~~**C1 的单测缺口**~~ → **已补测并复核**（见 11.4）：新增 2 条 io 单测，C1 变异在单测层就失败。
2. 我只跑了上述三条命令，**没复跑 `pnpm verify`**（typecheck 未由我复核）。
3. 真实名单只做了 `out/roster.json` 的字段名只读对照（不打印任何姓名/学号）。
4. 「其它列忽略」我按**行为**验证（性别/备注文本不出现在结果里）；没有穷举所有可能的表头别名组合。

### 11.7 结论

**通过（C1 已补测并复核；无遗留缺口）。**

- **A**：真实 xlsx 下「性别/备注」确实不再进学生对象，「选科」「缺考」照常解析（我的探针 2/2，含 `out/roster.json` 只读对照）。
- **B**：全局无意外残留——`gender` 只剩 core 类型字段与 web job 往返（都是有意保留），io 只剩注释；列映射面板 5 项、说明文案与行为一致。
- **C**：C2（备注偷偷进 meta）早被抓住；**C1（连选科一起忽略）补测后也被抓住**（我重跑变异：`2 failed | 151 passed`，正好是新增那 2 条）。首轮报出的缺口已闭环。
- **D**：**596 单测 + 140 验收** + lint 全绿。

---

## 12. 监考表备注 v3（主考场判定 / 不考·只考 / 无时段）（task-33）

### 12.1 规则与范围

- **主考场** = 该生考**语数外**的那间（`studentMainRoomId`）；取不到语数外信息时退回「座位时段最多的那间」。
  班级表「主考场」列与监考表备注**共用**这一个函数。
- **本考场是主考场**且该间会考、他没在这里考的科 → `不考：生物`；
  **不是**主考场（外来单科/多科） → `只考：生物` / `只考：生物、地理`；
  **外来但正好考满整间全部科目**（如政治单科房）→ **不写**；正常全考 → 不写。
- 文案**只有科目**：不带时段、不带「借考」字样、不带括号；判定完全数据驱动
  （`byStudent[].slots[].roomId` 反推），**不看** `students[].subjects`（那份只有 3 门选科、不含语数外）。
- io 的 `borrowRemark` 已删除；CLI 终端摘要与网页结果页的「借考明细」**仍带时段**——这是**有意差异**（我复核过：
  CLI 仍打印 `借考：1 人（… T6 生物 → …）`，网页 `buildBorrowingRows` 仍补时段字段，`grep borrowRemark packages/*/src` = 0 命中）。

### 12.2 A：合成 job 端到端（我自己的探针，13/13 通过）

探针 `/private/tmp/vfy-r33-{a,dbg,m3}.test.ts`（独立 vitest 配置，alias 指向仓库 io/src）。合成 job 照真实形态复刻：
25 人（物化生 10 / 物化政 8 / 史地政 6 / 史生政 1）、19 间房、`C3` 史地政→R17、`C3b` 史生政→R17、`C4` 物化政→R18、
史生政学生带 `subjectRoom: {biology: "R18"}`、R19 = 政治+地理专用房。

| 断言                                                                                                | 结果 |
| --------------------------------------------------------------------------------------------------- | ---- |
| 主考场 = 语数外所在考场（即使另一间时段更多）                                                       | ✅   |
| R18（含生物）：物化政整批每行 `不考：生物`；外来借考生那一行 `只考：生物`                           | ✅   |
| R17（文科房）：史地政整批**不写**；史生政学生缺地理 → `不考：地理`                                  | ✅   |
| R19（政治单科）：外来但考满整间 → **不写**                                                          | ✅   |
| 全表备注只可能 空 / `不考：X` / `只考：X`；无「时段」「借考」「（」，也没有把语数外标成不考         | ✅   |
| 同一张表内座位号唯一（备注不按时段分块）                                                            | ✅   |
| `seatingRemark` 与 `studentMainRoomId` 口径一致（同一学生两间房里分别 `不考：地理` / `只考：生物`） | ✅   |

单场（`--single`）：单场产物只有 `考场安排名单.xlsx` + `考场座位表.xlsx`，**没有监考表**，因此也没有备注——
符合「单场没有主考场/借考概念」的预期，未发现异常。

### 12.3 B：真实产物只读复核（`out/最终-考场级放宽与借考/**`）

| 项                             | 我的实测                                                                                                                                                                                                              | 与自述         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 合并工作簿 `考场监考表.xlsx`   | **20 张 sheet**                                                                                                                                                                                                       | ✓              |
| 有备注的 sheet                 | **2 / 20**：`第十七考场（语数外政史地）`、`第十八考场（语数外物化生）`                                                                                                                                                | ✓              |
| 第十八考场                     | 34 行，非空 23 行 = **22 × `不考：生物` + 1 × `只考：生物`**（11 行空）                                                                                                                                               | ✓              |
| 第十七考场                     | 29 行，非空 1 行 = **1 × `不考：地理`**                                                                                                                                                                               | ✓              |
| 其余 18 张                     | 0 条备注                                                                                                                                                                                                              | ✓              |
| 备注含「时段」/「借考」/「（」 | **0 / 0 / 0**                                                                                                                                                                                                         | ✓              |
| 备注格式                       | 24 条全部匹配 `^(不考\|只考)：[中文、]+$`，无例外                                                                                                                                                                     | ✓              |
| 单考场文件 vs 合并版           | 20 个单文件，逐格比对 **0 处不一致**                                                                                                                                                                                  | ✓              |
| 班级表「主考场」列 vs 备注口径 | 24 条备注行**全部自洽**（`不考` 的该行主考场 = 本间；`只考` 的那行主考场 = 第十七考场）                                                                                                                               | ✓              |
| 备注列宽                       | ⚠️ **口径差异**：`11.65 / 10.54 cm` 是**整表 A–E 合计宽**（第十八 / 第十七考场，= 63 / 57 字符宽 × 0.185），**不是备注列宽**；备注列（E）本身是 **12 字符 ≈ 2.22cm**（无备注的表 6 字符 ≈ 1.11cm）。两者都 ≤ 27.8cm ✓ | 数字对、标签错 |

### 12.4 C：反例 4 组（1 组抓不住）

做法：`packages/io/{src,test}` 复制到 `/private/tmp/base-io`，只改副本，独立 vitest alias 指向副本；仓库文件不动。

| #   | 变异                                       | io 单测（174）                        | 失败用例（前几条）                                                                                             |
| --- | ------------------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| M1  | 判定改成 `students[].subjects`（选科）相减 | ✅ 抓住（**9 failed \| 165 passed**） | 「主考场全考 → 空字符串」「主考场缺生物 → 不考：生物」「主考场缺 3 科…语数外不会被误判」「34 行里恰好 22 行…」 |
| M2  | 去掉「外来考满整间不写」的例外             | ✅ 抓住（**2 failed**）               | 「外来但正好考满全场 → 不写」「政治单科房间里的 13 个物化政学生 → 全部不写」                                   |
| M3  | 主考场判定改回「座位时段最多的那间」       | ❌ **抓不住（174/174 全绿）**         | ——                                                                                                             |
| M4  | 把时段 / 「借考」加回备注                  | ✅ 抓住（**7 failed**）               | 「主考场缺生物 → 不考：生物」「外来单科借考 → 只考：生物（无时段/无借考/无括号）」等                           |

**M3 的缺口是真的、也有害**（我另写探针证明）：构造「语文+数学在 R1（2 个时段）、英语+物理+化学+生物在 R2（4 个时段）」——
正确实现 `studentMainRoomId` = **R1**（语数外优先，`不考：外语、物理、化学、生物` / `只考：…`）；
变异后返回 **R2**（最忙那间），主考场判定与两张表的备注一起翻。现有 174 条 io 测试里没有任何 fixture 让
「非主考场的时段数 > 语数外所在考场的时段数」（现有用例是 R18 5 个时段 vs R20 1 个，两者判定一致）。
**建议补一条**：`studentMainRoomId` 用手工 slots（R1 两个语数外、R2 四个其它）断言取 R1；再配一条 `seatingRemark` 断言两间的文案。

### 12.5 D：复跑

| 命令                                                                           | 结果                                                                                |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `pnpm exec vitest run`                                                         | **617 passed / 45 files**（node 406 = core 191 + io 174 + cli 41；web 211），exit 0 |
| `node examples/acceptance.mjs`                                                 | **140/140**，exit 0，242ms（dist 18:05:02 上复跑）                                  |
| `pnpm lint:check`                                                              | ⚠️ **失败**，原因**不在本轮**                                                       |
| `pnpm exec oxlint packages` / `pnpm exec oxfmt --check packages docs examples` | ✅ 0 error（2 条既有 `max-lines` 警告）/ 全部格式正确                               |

**lint 失败的具体情况**（如实记录）：仓库里多了一个**未跟踪**的 `packages/desktop/`（另一个桌面轮次的 WIP），
其中 `packages/desktop/src/main.mjs` 有 2 个**语法错误**（oxlint：`Missing initializer in const declaration` /
`Expected a semicolon…`），导致全仓 `oxlint` 报 2 error、`oxfmt --check` 也因该文件无法格式化而中止。
把范围限定到本轮涉及的 `packages/`、`docs/`、`examples/` 后全部干净。等桌面轮的 WIP 修好，全仓 `lint:check` 应恢复。

### 12.6 存疑 / 未验证

1. **M3 的单测缺口**（见 12.4）——建议按上面补一条；在补测前，「语数外优先」这条规则只由实现注释与我的探针兜着。
2. 全仓 `pnpm lint:check` 当前红（原因见 12.5，属桌面轮 WIP，不是本轮实现问题）；我**没复跑 `pnpm verify`**（typecheck 未复核）。
3. 真实产物只读复核覆盖了备注文案、单文件逐格一致、主考场列自洽、列宽；**没有**在真实 Excel/WPS 里看渲染。
4. 单场模式只确认了「不产出监考表」，没有断言单场座位表是否需要备注（按设计不需要）。
5. 隐私：合成 job 全用占位姓名；真实产物只输出计数与文案，没有把姓名/学号写进本文。

### 12.7 结论

**通过（1 个单测缺口，见 12.4 的 M3；规则行为本身正确）。**

- **A**：合成 job 13/13 通过，覆盖主考场缺科 / 外来单科 / 外来多科 / 外来考满整间 / 正常全考 / 座位号复用 / 单场无监考表；
  文案一律无时段、无「借考」、无括号，语数外不会被误判成不考。
- **B**：真实产物与自述**完全吻合**（2/20 张 sheet 有备注；22+1 / 1 条文案；其余 18 张干净），单文件与合并版 0 处不一致，
  备注与班级表「主考场」列 24/24 自洽；唯一修正是列宽口径（11.65/10.54cm 是整表总宽，不是备注列宽）。
- **C**：M1 / M2 / M4 全被现有测试抓住；**M3（主考场改回「最忙那间」）抓不住**，我用探针证明会造成判定翻转 → 建议补一条 fixture。
- **D**：**617 单测 + 140 验收**通过；`packages/` 范围 lint 干净，全仓 lint 被未跟踪的 `packages/desktop` WIP 拖红。
