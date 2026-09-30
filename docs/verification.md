# 独立验收记录（task-7 / task-11 / task-14）

> 验收人：verifier（不改业务实现，只改 `examples/acceptance.mjs` 与本文件）。
> task-7：主链路（硬规则 / 分房策略 / 导出闸门 / 退出码 / skill）—— 已完结（§1–§5，71/71）。
> task-11：输入契约（表头宽容 / 缺考两路 / 未匹配不静默）—— 阶段 1 脚本已写（§6）。
> task-14：多场次限定 + 多场次校验 —— 阶段 1 脚本已写（§6）。
> 基线契约：`docs/design.md` §3.2 / §5.1 / §5.4 / §7.1 / §8.1 / §9；`docs/issues.md`（议题 1–5）。
> 原则：硬规则与限定断言**全部独立推导**（只看 CLI 输出与导出文件，不调用 core 的
> `findRoomSubjectClashes` / `validate` / `validateAll` 自证）。

## 0. 当前状态

| 项           | 值                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 验收脚本     | `examples/acceptance.mjs`，**93 项**（原 26 项语义不变；task-7 增 45、task-11 增 12、task-14 增 10）                     |
| 阶段         | task-7 阶段 1+2 ✅（71/71 全绿）；task-11/14 阶段 1+2 ✅（93/93 全绿）                                                   |
| 依赖         | CLI bin 走 `packages/cli/dist`：`packages/cli/bin/exam-seat.mjs` → `import { main } from "../dist/cli.mjs"`              |
| 最近一次运行 | **93/93 全绿**（dist 19:45:19：task-8/12/13 全部落地），exit 0，约 180ms                                                 |
| lint         | `npx oxlint examples/acceptance.mjs` = **0 error / 0 warning**（`max-lines` 由 Lead 加单文件覆盖）；`oxfmt --check` 通过 |
| 命令         | `node examples/acceptance.mjs`（只跑脚本与临时目录里的 CLI，不跑 `pnpm verify`）                                         |

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
