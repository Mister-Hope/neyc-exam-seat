# 独立验收记录（task-7）

> 验收人：verifier（不改业务实现，只改 `examples/acceptance.mjs` 与本文件）。
> 基线契约：`docs/design.md` §3.2 / §5.1（硬规则）/ §5.4（分房策略 + constraints 告警）/ §5.7 / §7.1 / §8.1（导出闸门）/ §9（退出码）；
> 待办：`docs/issues.md`（议题 1–4）。
> 原则：验收脚本里的硬规则断言**全部独立推导**（只看 CLI 输出与导出文件，不调用 core 的
> `findRoomSubjectClashes` / `validate` 等校验函数）。

## 0. 当前状态

| 项           | 值                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 验收脚本     | `examples/acceptance.mjs`，**71 项**（原有 26 项名称与语义不变，新增 45 项）                                             |
| 阶段         | 阶段 1（脚本扩展 + 待验清单）✅；阶段 2（全量重跑 + 对抗复核 + 结论）✅                                                  |
| 依赖         | CLI bin 走 `packages/cli/dist`：`packages/cli/bin/exam-seat.mjs` → `import { main } from "../dist/cli.mjs"`              |
| 最近一次运行 | **71/71 全绿**，exit 0，约 160ms（dist 19:07:33：core C12 + cli 退出码 3 契约 + cli C8）                                 |
| lint         | `npx oxlint examples/acceptance.mjs` = **0 error / 0 warning**（`max-lines` 由 Lead 加单文件覆盖）；`oxfmt --check` 通过 |
| 命令         | `node examples/acceptance.mjs`（只跑脚本与临时目录里的 CLI，不跑 `pnpm verify`）                                         |

> 阶段 1 在旧 dist 上观察到的失败在最终 build 后全部归零；其中 1 项是我自己的断言写错（`已排人数 < 总数`），
> 已按 design §5.4 的语义改成「应考时段未排满人数 > 0」，见 §4 第 16 条。

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

## 2. 断言清单（71 项）

| 段                     | 项        | 覆盖                                                                                                                                                                                                             |
| ---------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 基础契约             | 1–4       | 用法退出码、Excel 导入、选科列、四种组合解析                                                                                                                                                                     |
| 2 多场次               | 5–8       | 完成、7 时段、物/历 + 生/政 配对、座位方案零冲突                                                                                                                                                                 |
| 3 考场数               | 9–11      | 常规 1 个 / 非常规 2 个 / 无超 3                                                                                                                                                                                 |
| 4 专用考场             | 12–14     | 有座位方案、只装非常规、政治考场的选科正确                                                                                                                                                                       |
| 5 编号与邻接           | 15–16     | 蛇形编号逐座、6108 组相邻关系暴力复核                                                                                                                                                                            |
| 6 导出                 | 17–21     | 两份 xlsx、换考场记录、空置列出、同 seed 可复现                                                                                                                                                                  |
| 7–9 单场/失败路径/降级 | 22–26     | `--single`、无解退出码与原因、班级数 < 9 退化告知                                                                                                                                                                |
| 10 硬规则独立复核      | 27–34     | 逐考场×时段一科、subjects 一致、常规×非常规不共用、座位号一人一位、跨 seating 不重叠、无 `ROOM_SUBJECT_CLASH`、默认无 `ROOMS_SHARED`                                                                             |
| 11 考场不足/导出闸门   | 35–36、62 | 默认 `CAPACITY_INSUFFICIENT`、不偷偷混排、结构性 error 退出码 3 且不导出工作簿                                                                                                                                   |
| 11b 全部考场空置       | 37–38     | `job.json` 不被掏空、CLI 不谎报「已剔除」也不谎报排考完成、退出码 3                                                                                                                                              |
| 11c 单场导出闸门       | 63–64     | 单场结构性 error 退出码 3 且不导出名单；降级（orthogonal）退出码 0 照常导出                                                                                                                                      |
| 12 空置剔除            | 39–44     | 主 job / 小 job 导出剔除、stderr 提示、`--json` stdout 单一 JSON                                                                                                                                                 |
| 13 skill               | 45–49     | SKILL.md 字符数、关键词计数、SKILL.md 坑位、reference.md 字段、带选科样例                                                                                                                                        |
| 14 constraints 告警    | 50–55     | 恰一条 `CONSTRAINTS_IGNORED_MULTI`（warning）、evidence 条数/人数、无限定与单场无该码、warning 不阻塞、error 阻塞                                                                                                |
| 15 fillRooms           | 56–61     | 共用仍 ok、合并成一套座位、一人一位、只出一张监考表、默认同名单报 `CAPACITY_INSUFFICIENT` 且不混排                                                                                                               |
| 16 对抗用例（阶段 2）  | 65–71     | `--relax minConflicts` 仍导出（exit 2）、fillRooms 不合并冲突批次、非法 `groupPreference` 回退、无专用考场混合批次、fillRooms 可复现、选考科目全在专用考场时语数外不漏排、`validate` 喂多场次 plan.json 明确报错 |

英文/代号断言对应的命令统一是 `node examples/acceptance.mjs`；其中 35–38、56–71 使用脚本内
写到临时目录的小 job（`tight.json` / `zero.json` / `fill.json` / `fill-strict.json` /
`single-tight.json` / `relax.json` / `illegal-merge.json` / `bogus.json` / `mixed.json` /
`all-dedicated.json`）。

## 3. 待验清单与最终定级

| #   | 问题                                                                        | 最终定级                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | 参考人数 0 时 `planAll.ok` 真空为真、renderer 报成功、CLI 退出码却是 3      | **真 bug → 已修 + 已复验**（core `ok` 收紧 + `NO_STUDENTS`；io-cli renderer 改写）。第 38 项绿：❌「没有任何考场安排…所有学生都被排除」、exit 3、`job.json` 保留 3 个考场          |
| C2  | `findRoomSubjectClashes` 用 `seating.subjects` 并集判定，可能漏报/误报      | **已验证无问题**：`mixed.json` 场景 core 与独立推导一致；主 job 两边都为空。C12 修复后该场景两边同时归零                                                                           |
| C3  | `canShareRoom` 签名在 `combination` 同名但 `subjects` 不一致时的行为        | **已验证安全**：`combination:"物化生"` + `subjects:["physics","chemistry"]` → `ok=true`、无诊断、T6 正确为 null、无混排                                                            |
| C4  | error 结果仍无条件导出两份工作簿                                            | **真 bug → 已修 + 已复验**（按 §8.1 闸门、`writeWorkbooks`）。第 62/63 项绿：只留 `plan.json` + `job.json`，exit 3，stderr 逐条 error                                              |
| C5  | 非法 `groupPreference` 静默回退                                             | **非 bug（设计口径）**：回退 `sameCombination`、报 `CAPACITY_INSUFFICIENT`、不混排。第 67 项绿                                                                                     |
| C6  | `fillRooms` 合并后是否如实报 `ROOMS_SHARED`                                 | **已验证**：第 56 项绿 —— 诊断恰好 `ROOMS_SHARED`，R2 合并成 1 套座位 / 1 张监考表                                                                                                 |
| C7  | 部分排出来时 `job.json` 是否保留全部考场、有无误导提示                      | **已验证**：tight `job.json` 存在、无「已剔除」（两个考场都被物化生用到）                                                                                                          |
| C8  | `validate` 对多场次 `plan.json` 的行为                                      | **真 bug → 已修 + 已复验**（io-cli-eng：入口判别）。第 71 项绿：非 `--json` exit 1 + 明确提示；`--json` 输出 `{ok:false,error:"MULTI_PLAN_NOT_SUPPORTED"}`，无「内部错误」         |
| C9  | `SKILL.md` 字节余量                                                         | **提示（非 bug）**：8060 字节 / 4474 字符 → 按字节口径只剩 132 字节余量；按字符口径余量充足                                                                                        |
| C10 | 导出闸门两份实现（cli 本地副本 vs core `blocksListExport`）                 | **真 bug（契约重复）→ 已修 + 已复验**：`cli.ts` 只从 core import（`cli.ts:6`），单场 410 / 多场次 371 两处共用                                                                     |
| C11 | Web 多场次导出闸门用 `!planAll.ok \|\| conflicts > 0`，与 §8.1 唯一判据不同 | **非 bug（Lead 口径）**：网页「先二次确认、老师坚持仍可导出」，§8/§8.1 明确给网页留的口径；CLI 才是硬闸门                                                                          |
| C12 | 非常规批次无条件合并成一个 demand，未按逐时段科目签名拆分                   | **真 bug → 已修 + 已复验**（core-eng `groupIrregularDemands`）。手动复核：`ok=true`、R1=物化政 20 人、R2=物化地 20 人、`distinctRooms=1`、无诊断；第 68 项自动切到「合法拆房」分支 |

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
| 附加 | `validate` 喂多场次 `plan.json`              | 明确报错、不抛内部错误                                     | ✅ 第 71 项（C8 修复后）                                                                 |

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

| #   | 断言 / 场景                             | 命令                                                        | 实际输出摘要                                                                                                                            | 通过 |
| --- | --------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1   | 全量验收（71 项）                       | `node examples/acceptance.mjs`                              | 71/71，exit 0，约 160ms                                                                                                                 | ✅   |
| 2   | 硬规则独立复核                          | 同上（第 27–34 项）                                         | 主 job 205 个「考场 × 时段」格子；座位号一人一位；跨 seating 不重叠；5 个多场次场景 0 违规                                              | ✅   |
| 3   | 多场次结构性 error：退出码 3 + 不导表   | tight `--out-dir`（第 62 项）                               | exit 3；`classBook=-1 invigilator=-1 plan=81875 job=13504`；stderr「结果未通过校验…」                                                   | ✅   |
| 4   | 单场结构性 error：退出码 3 + 不导名单   | `single-tight --out-dir`（第 63 项）                        | exit 3；`list=-1 plan=3396 job=10252`                                                                                                   | ✅   |
| 5   | 降级照常导出                            | `few --out-dir`（第 64 项）                                 | exit 0；名单 56830 字节                                                                                                                 | ✅   |
| 6   | `--relax minConflicts`（SEARCH_FAILED） | 4 班 9/9/9/3 + `--force-king`（第 65 项）                   | `OK,SEARCH_FAILED`；`ok=false`；exit 2；名单 34919 字节                                                                                 | ✅   |
| 7   | 空置考场剔除                            | 主 job / 小 job `--out-dir`（第 39–44 项）                  | 主：空置 2 → 导出 36（应为 36）；小：导出 R1；stderr「已剔除空置考场：第2考场、第3考场」                                                | ✅   |
| 8   | `--json` stdout 纯 JSON                 | 小 job（第 44 项）                                          | stdout 25989 字节整体 `JSON.parse`；提示只在 stderr                                                                                     | ✅   |
| 9   | constraints 忽略告警                    | 12 人物化生 + 2 条限定（第 50/51 项）                       | 恰好 1 条 warning，`evidence={constraints:2,students:5}`，`ok=true`、exit 0、名单导出                                                   | ✅   |
| 10  | fillRooms 合并 + 1 张监考表             | fill.json（第 56–59 项）                                    | `ROOMS_SHARED`；R2：座位方案 1 套 / 监考表 1 张「第2考场（语数外物化生）」                                                              | ✅   |
| 11  | 反例：物化生 + 政史地 / 1 考场          | illegal-merge（第 66 项）                                   | `CAPACITY_INSUFFICIENT`；R1 只有物化生；未排满 20 人；监考表不存在                                                                      | ✅   |
| 12  | 反例：非法 `groupPreference`            | bogus（第 67 项）                                           | 回退 `sameCombination`；`CAPACITY_INSUFFICIENT`；混排 0 处                                                                              | ✅   |
| 13  | 反例：全部考场空置                      | zero.json（第 37/38 项）                                    | `seatings=0`；`job.json` 保留 R1/R2/R3；❌「没有任何考场安排」；exit 3                                                                  | ✅   |
| 14  | 反例：无专用考场 + 政治/地理同段（C12） | mixed.json（第 68 项）                                      | `ok=true`；独立复核 0 违规；核心无 `ROOM_SUBJECT_CLASH`；监考表 22510 字节导出；手动复核 R1=物化政 20 / R2=物化地 20，`distinctRooms=1` | ✅   |
| 15  | 选考科目全被专用考场接走                | all-dedicated（第 70 项）                                   | `ok=true`；未排满 0 人；每人 2 个考场；4 套座位方案                                                                                     | ✅   |
| 16  | `validate` 喂多场次 plan.json（C8）     | 小 job 的多场次 `plan.json`（第 71 项）                     | 非 `--json` exit 1 +「这份 plan.json 是多场次结果…只支持单场结果」；`--json` → `MULTI_PLAN_NOT_SUPPORTED`，无「内部错误」               | ✅   |
| 17  | 断言写错复盘                            | fillStrict（第 61 项）                                      | 「已排人数 60/60」被专用房 T6 影响；改用「应考时段未排满」后：未排满 20 人（缺 T1–T5），物化政只出现在 R3                               | ✅   |
| 18  | C3 手动探针                             | `combination:"物化生"` + `subjects:["physics","chemistry"]` | `ok=true`、无诊断、T6 为 null、无冲突                                                                                                   | ✅   |
| 19  | 可复现性                                | 主 job（第 21 项）+ fillRooms（第 69 项）                   | `byStudent` / 座位方案投影逐字节一致                                                                                                    | ✅   |

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
3. 建议把「`validate` 遇到多场次 `plan.json` 的行为」（C8 已实现：exit 1 / `MULTI_PLAN_NOT_SUPPORTED`）补进 `docs/design.md` §9，避免「多场次也写 plan.json」这一契约边界再次咬人。
4. `SKILL.md` 字节余量仅 132，后续追加内容请同时核对 `wc -c`。

**验收结论：task-7 通过。** 71/71 全绿，硬规则无绕过路径，导出闸门与退出码符合 §8.1 / §9。
