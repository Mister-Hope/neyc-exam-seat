# 未完成事项 / 议题清单

> 这里放**已经设计好、但还没实现**的事情。每条都写成可以直接交给子代理执行的任务：
> 现状 → 验收标准 → 约束。改完请把对应条目标记为「已解决（提交号）」或删掉。
>
> **状态（本轮收口）**：议题 1–6、**9**、**11**、**12（迁移）**、**14** 已解决（见每条开头的 ✅ 说明与本轮验收证据）；
> 其中**议题 1 的底层实现在 2026-10 换过**（Element Plus → shadcn-vue，虚拟表格改自研），结论不变，见该条说明与 `docs/design.md` §10.5；
> 遗留 **议题 7**（`planningOnly`：参与时段推导 / 容量统计但不排座）、
> **议题 8**（加座的 `seatRef` 限定：目前限定点不到讲台侧加座）、
> **议题 10**（行高不按换行内容自适应）与 **议题 17**（验收/文档里若干「待办」待复核）；
> 议题 18（监考表备注 v3）**已在本轮定稿**。
> 议题 13（CLI `small` 口径）与议题 16（单场 `combination`）**已在本轮解决**。

---

## 议题 1：表格虚拟滚动（Web）—— ✅ 已解决

**解决方式**：新增 `packages/web/src/components/VirtualTable.vue`，
第 ①④⑤⑥ 步的四张表（导入问题行、排除缺考主表 + 已排除抽屉、设置限定学生表、结果页主表）全部改为虚拟滚动；
考场配置表（行内编辑、行数少）不做虚拟化，直接用 shadcn `Table`。
**证据**：`web/test/virtual-table.test.ts`、`web/test/step-exclude-virtual.test.ts` —— 1000 行时 DOM 只渲染 **19 行**（可视 10 + overscan 4×2 + 1；单测断言 `< 50`，与实现同口径），
表头「全选当前结果」仍勾中全量 1000 人；搜索 56 人 → 全选 → 批量排除，一个不漏；`app-smoke` 六页仍全绿。

**⚠️ 2026-10 迁移更新（本条结论不变，但实现换了底层）**

虚拟表格已**改为自研**：`VirtualTable.vue` 现在是**零第三方表格依赖**的实现（可视区 + 前后 `OVERSCAN = 4` 行），
不再基于 `el-table-v2` + `el-auto-resizer`——因为整个 Web 层在 2026-10 从 Element Plus 迁到了 **shadcn-vue**
（Tailwind v4 + reka-ui），而 shadcn-vue **没有官方虚拟表格**。
对外 props / emit / `cell-<key>` 插槽与迁移前**保持一致**，调用点无语义变化；
「虚拟滚动只影响渲染、`rows` 永远是筛选后全量」这条**判定标准也没变**（`web/test/virtual-table.test.ts` 仍在守）。
本次迁移的取舍清单与体积对照见 `docs/design.md` §10.5。

**⛔ 已被推翻的约束（历史）**：本条原文写的「**不引入新的 UI 库**；优先用 Element Plus 自带的虚拟化能力
（例如 `el-table-v2` + `el-auto-resizer`）」**已作废**——2026-10 这一轮恰恰是**整体引入 shadcn-vue / Tailwind v4 / reka-ui**
并自研表格。同类作废的还有「若某张表确实无法虚拟化…可以保留 `el-table`」：现在没有 `el-table` 了，
小数据表统一用 shadcn `Table`。保留原文只为可追溯。

**原始现状（保留存档 · 历史）**

> 以下描述的是 **Element Plus 时代**的代码，2026-10 迁移后 `el-table` 已全部移除，仅作可追溯留存。

**现状**

`packages/web` 的六个步骤页全部使用普通 `el-table`，一次渲染全部行：

| 位置                            | 行数规模              | 当前写法           |
| ------------------------------- | --------------------- | ------------------ |
| `src/views/StepExclude.vue`     | 名单全部（~1000 行）  | `height="440"`     |
| `src/views/StepConstraints.vue` | 应考学生（~1000 行）  | `height="360"`     |
| `src/views/StepImport.vue`      | 问题行（最多 100 行） | `max-height="320"` |
| `src/views/StepResult.vue`      | 结果名单（~1000 行）  | `height="480"`     |

1000 行规模下滚动与勾选会明显发顿。设计文档 §14 里「表格：虚拟滚动，1000 行流畅」这一条
**尚未实现**，在本文档登记为待办。

**验收标准**

1. 造一份 1000 人（18 个班）名单，在**排除缺考**页连续滚动、搜索、全选当前结果、批量排除、抽屉恢复全流程不卡（滚动不掉帧、输入无明显延迟）。
2. 现有行为**逐条不变**：
   - 勾选 + 「全选当前结果（N 人）」+ 批量排除/恢复；
   - 被排除行置灰 + 「不参加」标签 + 单条恢复；
   - 限定页的「按班级批量选 → 添加限定」与编辑回填；
   - 结果页按班级/考场筛选与「某人坐哪」搜索。
3. `pnpm verify` 全绿（lint:check → typecheck → build → test → acceptance），
   且 `packages/web/test/app-smoke.test.ts` 的六个页面挂载冒烟测试仍然通过。

**约束（原文 · ⛔ 第 1、3 条已作废）**

- ⛔ **（已作废，2026-10）** ~~不引入新的 UI 库；优先用 Element Plus 自带的虚拟化能力（例如 `el-table-v2` + `el-auto-resizer`，
  注意它需要显式列定义与 `ResizeObserver`，jsdom 测试里要保留现有的 stub）。~~
  → 实际做法：**引入 shadcn-vue（Tailwind v4 + reka-ui）并自研 `VirtualTable.vue`**。
- ✅ **（仍然有效，是这次迁移的验收底线）** 搜索/筛选/选择的数据流保持「store 里的全量数据 + 计算属性过滤」，
  **虚拟滚动只影响渲染**，不要把「当前渲染的行」当成「当前结果集」，否则「全选当前结果」会静默漏人。
- ⛔ **（已作废，2026-10）** ~~若某张表确实无法虚拟化（例如需要行内编辑的考场配置表），可以保留 `el-table` 并在文档里写明理由。~~
  → 实际做法：小数据表统一用 shadcn `Table`，`el-*` 已全部移除。

---

## 议题 2：Web 端「场次编排」（多场次）—— ✅ 已解决

**解决方式**：第 ⑤ 步名单带选科时默认走 `planAll`（`solver.worker` 增加 `mode`，`useSolver.run(job, overrides, mode)`），
结果写进 `result` store（`mode` / `planAll` / `slots` / `seatings` / `scheduleByStudent` / `emptyRoomIds` …）；
第 ⑥ 步展示「时段 → 考场 + 座位」、座位方案概览与校验摘要，并导出 `按班级考场安排.xlsx` 与 `考场监考表.xlsx`；
空置考场按**求解结果**列出并可一键移除。单场路径（无选科字段）行为不变。
**附带修复**：`useSolver.run()` 原来建好 Worker、挂完监听却从未 `postMessage`，第 ⑤ 步求解永远不会开始——已修复。
**证据**：`web/test/result-store-multi.test.ts`、`step-solve-multi.test.ts`、`step-result-multi.test.ts`、`session-export.test.ts`；
web 全量单测（议题 2 时 123 项，本轮已达 158 项）+ `vue-tsc` 0 报错；验收脚本新增多场次工作簿与硬规则断言。

**原始现状（保留存档）**

**现状**

core / io / CLI 已经支持多场次（`planAll`、按班级与按考场的两种导出、`exam-seat plan` 自动识别选科），
但**网页第 ⑤ 步目前只跑单场 `plan`**：名单里带选科时，网页会在求解页显示一条提示，让老师改用 CLI。
设计见 `docs/design.md` §5（选科与多场次），实施进度见 §5.7 的 S7。

**验收标准**

1. 名单里带选科（`combination` / `subjects`）时，网页能完成多场次编排并展示「时段 → 考场 + 座位」。
2. 结果页能导出 `按班级考场安排.xlsx` 与 `考场监考表.xlsx`（`@exam-seat/io` 已有对应函数）。
3. 空置考场能被点名列出，并支持一键移除。
4. `pnpm verify` 全绿。

**约束**

- 单场路径（没有选科字段的名单）行为不能变。
- 第 ⑤ 步的预检 / 诊断 / 建议一键应用机制要复用，不要另起一套。

---

## 议题 3：Skill 还没跟上 job.json v2 / 多场次（S8）—— ✅ 已解决

**解决方式**：`SKILL.md`（7927 字节 < 8192）补齐 v2 最短路径与 10 条高频坑位（含「一个考场一个时段只能考一科」硬规则、
`groupPreference` 两取值、多场次不应用 constraints → `CONSTRAINTS_IGNORED_MULTI`、`--single` 才回单场）；
`reference.md` 补齐字段表（`combination` / `subjects` / `location` / `dedicatedSubjects` / `groupPreference`）、
T1–T7 时段推导表、`planAll` 返回结构、两份多场次工作簿、诊断码表（`ROOM_SUBJECT_CLASH`、`CONSTRAINTS_IGNORED_MULTI`）；
`examples/job.sample.json` 换成带选科样例（36 人四组合 + `dedicatedSubjects`），`exam-seat precheck` 通过。
**证据**：关键词计数（选科 9 / `combination` 2 / `planAll` 2 / 多场次 7 / `dedicatedSubjects` 2，原先全 0）；
`wc -c SKILL.md` = 7927；验收脚本内置 skill 断言。

**原始现状（保留存档）**

**现状**

`.agents/skills/exam-seating/SKILL.md` 与同目录 `reference.md` 里，
`选科` / `combination` / `planAll` / `多场次` / `dedicatedSubjects` 这些关键词出现 **0 次**。
也就是说：core / io / CLI 已经支持选科与多场次，但**项目级 skill 完全没写**——
AI 照 skill 办事时，不知道 job.json 已经是 v2，也不知道「名单带选科会自动走多场次、
交付物是 `按班级考场安排.xlsx` + `考场监考表.xlsx`」。

这是目前最容易让 AI 走错路的信息缺口（比代码缺口更紧急）。

**验收标准**

1. 只带这份 skill 的 agent，能完成这条链路：
   「名单在 `roster.xlsx`（含选科列），物化政的人政治去专用考场」→ 生成 v2 job.json →
   `exam-seat plan --job job.json --out-dir out` → 交付两个多场次工作簿，
   并说明「常规组合全程不换考场、非常规组合中途换一次」。
2. `SKILL.md` 渲染后仍 **< 8192 字符**（当前约 5.5 KB）；完整字段表与诊断码表放 `reference.md`。
3. `examples/job.sample.json` 里有一个**带选科**的样例（含 `combination` / `subjects` /
   `dedicatedSubjects`）。
4. 不改 core 行为，`pnpm verify` 全绿（当前基线 177 单测 / 26 验收）。

**约束**

- v2 的高频坑位至少写进 SKILL.md：名单带选科即多场次、`--single` 才回单场、
  专用考场用 `dedicatedSubjects` 手工指定（可兼多科）、空置考场会被上报可取消。
- 不要复制整份 JSON Schema 进 SKILL.md，指路到 `reference.md`。

---

## 议题 4：多场次支持 `constraints`（限定）—— ✅ 已解决

**解决方式**：`planAll` 为每套座位只下发「命中本座位学生 且 `roomId` 为空或等于本考场」的限定，
`rows` / `cols` 由该考场解析（`first` / `last` / `door` / `window` 与「指定考场后的绝对号」都生效）；
`roomId` 参与分房（被钉住的学生只能进那个考场）；装不下 / 冲突 / 指向不会去的考场 →
`CONSTRAINT_OVERSATURATED` / `RULE_INTERSECT_EMPTY` / `CONSTRAINT_EMPTY_DOMAIN`（error）且不导出名单。
各套座位未满足的限定汇总进 `PlanAllResult.unmetConstraints`，CLI 摘要单列「未满足的限定」。
`CONSTRAINTS_IGNORED_MULTI` 退场（仅保留历史枚举）。
**证据**：`core/src/plan-all.ts`；`core/test/plan-all.test.ts`（议题 4 时 +27 项；本轮已达 55 项）；
验收第 84–93 项（大/小考场首排、靠门/靠窗按考场行列解析、`roomId` 全时段同考场、交集、选择器、
不可满足时 error + 不导出、带限定结果硬规则独立复核 0 违规）。

**原始现状（保留存档）**

**现状**

`packages/core/src/plan-all.ts` 给每套座位方案构造 subJob 时写死 `constraints: []`，
即 `planAll` **静默忽略** job 里的全部限定。以前既没有实现、也没有在任何文档里标注，
老师 / AI 写了限定会以为生效。本轮已先补上 `CONSTRAINTS_IGNORED_MULTI`（warning）诊断，
让「没应用限定」变成显式告知（见 `docs/design.md` §5.4）；真正支持限定仍是待办。

**验收标准**

1. 多场次下限定能作用到对应学生与对应考场：`rows` / `cols` 按该学生实际坐的考场解析；
   `roomId` 限定要参与分房（否则该学生应被分到指定考场）；
2. 满足不了的限定按单场同样的方式进入 `unmetConstraints` / 诊断，不许静默丢弃；
3. 限定真正生效后删除 `CONSTRAINTS_IGNORED_MULTI` warning；
4. `pnpm verify` 全绿，验收脚本补「多场次 + 限定」断言。

**约束**

- 不能破坏 §5.1 硬规则（一个考场一个时段只能考一科）与「常规组合全程不换考场」；
- `roomId` 限定与分房冲突时要明确报错（`CONSTRAINT_*`），不要偷偷改成「不限考场」；
- 动手实现前先回写 `docs/design.md` §5 后再写代码。

---

## 议题 5：多场次结果的独立校验（`exam-seat validate`）—— ✅ 已解决

**解决方式**：core 新增 `validateAll(job, result: PlanAllResult): PlanAllValidation`，
逐 seating 重建子 job 调 `validate()`，并**独立**复核「限定是否满足」「同一考场同一时段最多一门科目」
「座位唯一 / 编号一致 / 应考却漏排」；`seatings` 为空报 `NO_STUDENTS`（不真空通过）。
CLI `exam-seat validate --job job.json --plan plan.json` 遇到多场次走 `validateAll`，`--json` 输出结构化结论，
退出码 ok → 0 / 不通过 → 3。
**证据**：`core/src/validate.ts`；`cli/test/validate-multi.test.ts`（8 项 e2e，含人为改坏 → 3）；
验收第 88–93 项（正常结果 exit 0 + 每套 seating 有结论、同址两人 → `ENTRY_DUPLICATE_SEAT`、
把受限学生挪出首排 → `CONSTRAINT_UNMET`）。

**原始现状（保留存档）**

**现状**

`exam-seat validate --job job.json --plan plan.json` 是**单场**语义（`validate(job, result)` 只认 `PlanResult`）。
多场次 `plan --out-dir` 写出的 `plan.json` 是 `PlanAllResult`（含 `seatings`），直接喂进去会抛内部错误。
本轮已先做成「明确报错」：判定为多场次结果时输出 `MULTI_PLAN_NOT_SUPPORTED`（退出码 1，`--json` 时 stdout 一个 JSON），
不会再出现内部异常（见 `docs/design.md` §9）。

**验收标准**

1. 对多场次 `plan.json` 能给出**逐 seating 的校验汇总**：每套座位按其 `studentIds` 与 `roomId` 重建子 job，
   跑一次单场 `validate()`，汇总冲突 / 未满足限定 / 编号一致性；
2. `--json` 输出结构稳定（例如 `{ ok, seatings: [{ roomId, subjects, ok, issues }] }`），退出码沿用 `0 / 3`；
3. 硬规则（同一考场同一时段最多一门科目，§5.1）也在校验范围内；
4. 保留「单场 plan.json 走原路径」的行为不变，`pnpm verify` 全绿。

**约束**

- 校验器仍要**独立于求解器**实现，不能复用 `findRoomSubjectClashes` 自证；
- 不引入新的 job.json 契约字段。

---

## 议题 6：考场级「加限制 / 放宽限制」（放宽 · 借考 · 加座 · 显式时段 · 分房游标）—— ✅ 已解决

**需求来源**：`docs/需求-考场级限制与放宽.md`；契约写在 `docs/design.md` §5.8，37 座编号规则见 §4.5。

**解决方式**（五件事，全部只加「考场级 / 学生级开关」，**不动红线**「一个考场一个时段只能发一张卷子」）：

1. **考场级放宽同班相邻** `RoomSpec.relaxSameClass`（`true` | 数字）：只对本考场生效；
   `ROOM_SAME_CLASS_RELAXED`（warning）+ `PlanAllResult.relaxedRooms` + 单场 `level = "roomRelaxed"`；
   独立校验器跳过该考场的相邻同班判定并报 `ADJACENCY_RELAXED`（warning，不计 `ok=false`）。
2. **按科目借考** `Student.subjectRoom`（科目 id → 考场 id）：该科到目标考场占一个空位，其余科目留在主考场；
   目标考场该时段**只能**开考这一科（否则 `SUBJECT_ROOM_CLASH`，error，不导出）；目标考场没有座位方案 / 没有空位报
   `SUBJECT_ROOM_NO_SEAT`；科目不在该生 `subjects` / 不在任何时段分别报 `SUBJECT_ROOM_UNKNOWN_SUBJECT` / `SUBJECT_ROOM_NO_SLOT`；
   成功逐条报 `SUBJECT_ROOM_APPLIED`（info），明细进 `PlanAllResult.borrowings` 与 `SeatingPlan.borrowedSubjects`；
   另有「被 `roomId` 钉在主考场、而主考场该时段本来就开考这一科 → 留在主考场」的自动优待。
3. **显式时段** `options.slots`（给了就不自动推导，报 `SLOTS_PROVIDED`）与 `options.forbiddenSameSlot`（只补必须分开的科目对）；
   同一学生同一时段被排两科报 `SLOTS_CONFLICT`（error）。用于「名单被手工剔除后自动推导塌陷」的正式解法。
4. **非矩形加座考场** `RoomSpec.extraFrontSeats`：容量 = `rows × cols + 加座数`；加座是该列最后一个号、行号为 0；
   邻接与 `maxSameClass` 都按真实座位图算（37 座 4 邻域最大独立集 = **20**，不是 `⌈37/2⌉` = 19）；座位表多画一行加座。
5. **分房游标回卷**：`allocateDemands` 扫到末尾回卷到 0 再扫，且 `sameCombination` 下同一原始批次拆出的两段可共用同一考场。

**证据（可直接核对）**：

- 代码：`core/src/types.ts`（契约与 `DiagnosticCode`）、`core/src/numbering.ts` + `core/src/model.ts`（加座编号 / 邻接 / `maxSameClass`）、
  `core/src/plan-all.ts`（`relaxedRooms` / `borrowings` / `allocateDemands`）、`core/src/validate.ts`（`ADJACENCY_RELAXED`）、
  `core/src/plan.ts`（`roomRelaxed` 级别、`BLOCKING_EXPORT_CODES` 收 `SUBJECT_ROOM_*` / `SLOTS_CONFLICT`）、
  `core/src/schedule.ts`（`normalizeSlots` / `forbiddenSameSlot`）、`io/src/index.ts`（座位表加座行、监考表备注列与放宽标注）。
- 测试：`core/test/borrow-relax.test.ts`（11 项：放宽 / 借考 / 显式时段 / 游标回卷 / 可复现性，5 个 describe）、
  `core/test/nonrect.test.ts`（18 项：37 座编号逐号、逆运算、容量、`maxSameClass` 基准、邻接、纯矩形兼容）、
  `io/test/relax-extra-export.test.ts`（7 项：座位表加座行与监考表标注）。
- 验收 `examples/acceptance.mjs`：不放宽时 25 人同班进 35 座报 `CLASS_LIMIT_EXCEEDED` 且不导出；`true` → 30 人全有座、
  `level=roomRelaxed`、留 `ROOM_SAME_CLASS_RELAXED`；数字 30 通过 / 20 不够仍报错；37 座考场容量 37、15 与 30 号是
  `row=0` 的加座；借考 T6 落目标考场、其它时段在主考场、`validate` exit 0、监考表出现「借考」；借考目标时段另有一科 →
  `SUBJECT_ROOM_CLASH` 且不导出；时段塌陷 → 显式 `slots` 修复且留 `SLOTS_PROVIDED`；游标回卷 → 未钉住的 6 人回到 R3、
  不再 `CAPACITY_INSUFFICIENT`；监考表出现「已放宽同班相邻」；
  另加 3 条 CLI 级断言：`SLOTS_CONFLICT`（同一学生同一时段两科）、`SUBJECT_ROOM_NO_SEAT`（目标考场该时段满座）、
  `numbering --extra 2,4` 加座编号图（r0 只有 15/30、第 3 列从 16 开始，不传 `--extra` 时形状不变）。验收共 **111 项**（108/108 → 111/111）。

---

## 议题 7：`planningOnly`（参与时段推导 / 容量统计但不排座）—— 未解决

**现状**

`docs/需求-考场级限制与放宽.md` §3.4 建议的第三条出口还没做：目前「时段塌陷」只能靠
`options.slots` / `options.forbiddenSameSlot` 解决，没有「这个学生只在统计里、不自动排座」的开关。
本轮的退路是：把这类学生放进 job 参与推导，再用 `constraints` 手工钉位——不够直接。

**验收标准**

1. 学生支持 `planningOnly: true`：参与时段推导与容量校验，但**不进入任何 `SeatingPlan`**；
2. `byStudent` / 导出里能区分「没考试」与「不自动排座」，且**不因此**触发 `ENTRY_MISSING_STUDENT`；
3. `pnpm verify` 全绿，`docs/design.md` §3.2 与 `reference.md` 的 Student 字段表同步。

**约束**

- 不破坏「一个考场一个时段一科」硬规则与同输入同 seed 可复现；
- 字段名与语义先写进 `docs/design.md` 再动代码。

---

## 议题 8：加座的 `seatRef` 限定（限定点不到讲台侧加座）—— 未解决

**现状**

`RoomSpec.extraFrontSeats` 的加座行号是 `0`、且不属于第 1..rows 排，所以 `rows` / `cols` 限定**指不到加座**
（`rows: [0]` 越界、`cols` 只覆盖到第 `rows` 排的座位）。加座目前只由求解器自然填充，老师无法点名「谁坐讲台侧加座」。

**验收标准**

1. 限定能表达「第 2 列的讲台侧加座」（例如 `seatRef: "extra:2"` 之类，最终字段名以 `docs/design.md` 为准）；
2. 预检 / 求解 / 独立校验 / 座位表四处的解释一致，越界报 `CONSTRAINT_INDEX_OUT_OF_RANGE`；
3. `pnpm verify` 全绿。

**约束**

- 不改变现有 `RowRef` / `ColRef` 的语义与绝对号含义（加座仍不算第 0 排 / 第 8 排）；
- 先回写 `docs/design.md` §4.3 / §4.5.3 与 `reference.md` 再动手。

---

## 议题 9：导出表格不像能打印的正式表（样式 / 打印设置 / 分份文件）—— ✅ 已解决

**现状（用户反馈）**

导出给老师和班主任的 Excel 有四个毛病：**缺准考证号**（老师补涂 / 核对时要翻名单）、
表头与说明文案不对（还留着「监考：…」）、**完全没有字号 / 对齐 / 边框 / 合并标题**（看起来像数据导出而不是正式表）、
列宽不自适应且没做 **A4 横向**校验（打印时要么溢出到好几页宽，要么列被压成一团）。
根因之一是 **SheetJS 社区版写不出字体 / 字号 / 对齐**——`cell.s` 被忽略，生成的 `styles.xml` 只有默认字体。

**解决方式**

1. **新增零依赖的极小 xlsx 写出器** `packages/io/src/xlsx.ts`（纯函数、浏览器可用）：
   手写 OOXML（inlineStr，不写 sharedStrings）、自写 ZIP（**method 0 stored + CRC32**，不用 `node:zlib`）；
   样式档位 `title`(16pt 加粗居中) / `subtitle`(12pt 加粗) / `meta`(9pt 灰字) / `header`(11pt 加粗居中 + 浅灰底 + 细边框) /
   `body`(11pt 左对齐 + 边框) / `bodyCenter`(11pt 居中 + 边框) / `note`(9pt 灰字)，中文字体「等线」、颜色用 `rgb`；
   每个 sheet 固定打印设置：**A4（`paperSize="9"`）、横向、`fitToWidth="1"`**、页边距 0.3/0.3/0.4/0.4 英寸、
   水平居中、冻结前 3 行、`_xlnm.Print_Titles = "1:3"`（每页重复打印表头）；
   `planColumnWidths` 按内容算宽（CJK 记 2）、`fitToA4Landscape` 把总宽与 **A4 横向可用宽 ≈ 27.8cm** 比对后等比收窄。
2. **输出 A 重做**：合并工作簿（sheet 1「总表」+ 每班一张 sheet，sheet 名 = 班级名），
   列 `班级 | 姓名 | 准考证号 | 考场① | 考场② | 考场③`，班级每行都填；
   **主考场只写「第N考场」，只有换考场的那些才写「第N考场（科目、科目）」**。
3. **输出 B 重做**：每套座位一张 sheet，sheet 名 = `第N考场（语数外物化生）`（考场名去掉 job 里「（…）」后缀，
   科目多科用单字简称、单科用全名）；第二行小字 `地点：… ｜ 考场人数：N`（放宽的考场再补「本考场已放宽同班相邻」），
   **删除「监考：…」**；正文 `座位号 | 班级 | 姓名 | 准考证号 | 备注`。
4. **落盘分份**：`--out-dir` 除两份合并工作簿外，另写 `按班级考场安排/<班级>.xlsx` 与
   `考场监考表/<sheet 名>.xlsx` 两个子目录（文件名 sanitize 掉 `/ \ : * ? " < > |`）；
   CLI 日志从逐条刷屏改成「导出 N 个文件」+ 目录摘要。
5. 网页（第 ⑥ 步）同样能下载这两套**整包 ZIP**（`buildZip`）。

**证据**：实现 `packages/io/src/xlsx.ts`、`packages/io/src/index.ts`、`packages/io/src/node.ts`；
测试覆盖「写出器产物能用 SheetJS 读回、`styles.xml` 含自定义字号、`sheet1.xml` 含
`pageSetup paperSize="9" orientation="landscape" fitToWidth="1"` 与 `mergeCells`/`cols`、
`buildZip` 解压后 CRC 正确」「总表首列每行都有班级、主考场无括号、换考场带科目」
「监考表标题形如『第一考场（语数外物化生）』、含准考证号、**不含「监考：」**」
「`fitToA4Landscape` 后总宽 ≤ 27.8cm」「两个子目录及正确文件数」。
（具体测试文件名与断言以 `packages/io/test/**` 为准。）

---

## 议题 10：行高不按换行内容自适应 —— 未解决

**现状**

写出器支持 `rowHeights`，但两套交付表都**没有**按「单元格内容换行」自动算行高：
长班级名或长备注（例如备注 v3 的 `只考：生物、地理`，或班级表里的长班级名）会把行撑高才好看，
目前依赖 Excel 自己的自动行高，换行文本在部分阅读器里会被截断。

**验收标准**

1. 给定会自动换行的单元格时，行高按内容行数与字号算出来（不再依赖阅读器）；
2. 不影响既有 A4 横向与 `fitToWidth` 行为，正常内容行高保持默认；
3. `pnpm test` 全绿，`docs/design.md` §5.6 与 `reference.md` 同步。

**约束**

- 纯函数、零依赖，不引入 `node:*`；
- 先回写 `docs/design.md` §5.6 的打印设置表再动代码。

---

## 议题 11：班级表列名 / 地点列、姓名条件截断、正文居中（老师第三轮反馈）—— ✅ 已解决

**现状（老师反馈）**

1. 班级表的考场列写成「考场①/②/③」，**看不出哪个是主考场**，也**没有地点**——班主任拿到表还得自己去对教室；
2. 姓名列宽吃紧时会被挤（或反过来把整表撑出 A4），但**绝大多数姓名并不长**，不该一律截断；
3. 正文数据格左对齐、表头居中，**同一张表两种对齐混用**，打印出来不整齐。

**解决方式**

1. **列名与地点列**：改成 `班级 | 姓名 | 准考证号 | 主考场 | 主考场地点 | 单科考场1 | 单科考场1地点 | …`
   —— 第 0 个考场列是「主考场」，之后是「单科考场N」；**每个考场列后面紧跟一列它的地点**（`roomColumnHeaders`）。
   地点取 `byStudent[].rooms[].location`，缺失退回 `job.rooms[].location`，再缺留空（`roomLocation`）。
   主考场列仍只写「第N考场」，单科列才写「第N考场（科目、科目）」。
2. **姓名按 A4 宽度条件截断**：先按**完整姓名**算整表宽度（`exceedsA4Landscape`，只算表头 + 正文），
   **不超过 A4 横向可用宽（≈27.8cm）就一个字都不动**；超了才把所有超过 5 字的姓名按**码点**截成前 5 个字
   （`displayStudentName` / `DEFAULT_NAME_MAX_CHARS = 5`），仍超再由列宽等比收窄兜底。
   截断与否按**全年级**判断（`fitNamesToA4` + `withHeaderRow`），所以总表 / 每班 sheet / 单班文件口径一致；
   `buildClassScheduleRows` 返回 `truncatedNames` 告知调用方；监考表用自己的姓名列下标独立判断。
3. **正文居中**：`xlsx.ts` 的正文只保留一档 `body`（11pt **居中** + 细边框），去掉原来的左对齐档，
   避免同一张表混用两种对齐；`meta` 小字是唯一左对齐的档位。

**真实数据实测**：706 人、31 个姓名超过 5 字、最长 13 字，但总表「表头 + 正文」只有 **19.24cm ≤ 27.8cm**，
所以 **`truncatedNames === false`**（默认不截断）。
⚠️ **同名风险**：一旦真的截到 5 字，可能出现重名（该数据集里截断后有 1 组同名），**必须靠准考证号列区分**。

**证据**：`packages/io/src/schedule-export.ts`（`roomColumnHeaders` / `roomLocation` / `displayStudentName` /
`fitNamesToA4` / `buildClassScheduleRows.truncatedNames`）、`packages/io/src/xlsx.ts`
（`body` 居中、`columnsWidthCm` / `exceedsA4Landscape`）；测试 `packages/io/test/name-fit.test.ts`
（`DEFAULT_NAME_MAX_CHARS`、按码点截断、只在超宽时截）+ `packages/io/test/schedule-export.test.ts`。

---

## 议题 12：Web 组件库迁移 Element Plus → shadcn-vue —— ✅ 已解决（2026-10）

**现状（迁移前）**

`packages/web` 用 Element Plus 2 + `el-table-v2`：体积大（迁移前约 2.4M / CSS 480K / JS 1.9M，约值口径），
且 `el-table-v2` 的列定义与 `ResizeObserver` 在 jsdom 里要专门 stub。本轮整体换成 **shadcn-vue**。

**解决方式**

1. **组件库换成 shadcn-vue**（Tailwind v4 + reka-ui）：组件在 `web/src/components/ui/`（CLI 生成，勿手改），
   主题变量在 `web/src/styles.css`（Tauri 风格 oklch CSS 变量 + `@custom-variant dark`），
   `web/components.json` 定 style `reka-nova` / base `neutral` / icon `lucide`；图标用 `@lucide/vue`。
2. **虚拟表格改自研**：`web/src/components/VirtualTable.vue` 不再依赖第三方表格件，只渲染可视区 + 前后 `OVERSCAN = 4` 行；
   对外 props / emit / `cell-<key>` 插槽与迁移前一致，调用点无语义变化。
3. **缺件自研 / 换写法**（取舍清单）：
   - shadcn-vue **没有官方虚拟表格** → 自研 `VirtualTable.vue`；
   - `Select` **只支持单选**（reka-ui `SelectRoot` 无 multiple）→ 自研 `MultiSelect.vue`（按钮 + Popover + 复选框）；
   - 数字输入直接用 `Input` + `type="number"`（第 ③⑤ 步）；
   - reka-ui `SelectValue` **首屏不出 label** → 第 ① 步「列映射」改用 `NativeSelect`（原生 `<select>`）规避；
   - 小数据表（第 ③ 步考场配置，几十行、要行内编辑）用 shadcn `Table`，不做虚拟化。
4. **体积**（实测精确值）：**dist 1,282,728 B（≈1.22 MiB）｜CSS 98,157 B / 4 文件（≈96 KiB）｜JS 1,184,009 B / 28 文件（≈1.13 MiB）**；
   对照迁移前约 2.4M / 480K / 1.9M（约值口径）。

**证据**：`packages/web/package.json`（reka-ui / tailwindcss / `@lucide/vue`，**无 element-plus**）、
`web/components.json`、`web/src/styles.css`、`web/src/components/{VirtualTable,MultiSelect}.vue`、
`web/src/views/{StepImport,StepResult,StepExclude,StepConstraints,StepRooms}.vue`；
测试 `web/test/virtual-table.test.ts`（1000 行 → 19 个 `.vt-row`）、`app-smoke.test.ts` 六页挂载；
`pnpm test` = **548**（node 353 / web 195）+ 验收 **130**。设计与取舍清单见 `docs/design.md` §10.5。

**约束**

- 判定标准不变：虚拟化只影响渲染，`rows` 永远是「筛选后全量」，「全选当前结果」不许漏人；
- `packages/web/src/components/ui/**` 是 CLI 生成物，业务改动不要直接改它。

---

## 议题 13：CLI `rooms --spec` 的 `small` 与网页预设不一致（30 vs 35）—— ✅ 已解决

**解决方式**

CLI 的 `small` 从 **6 排 × 5 列 = 30 座** 改成 **7 排 × 5 列 = 35 座**，与网页预设（`ROOM_PRESETS.small`）和
`template` 的默认考场**三处统一**；`large` 仍是 7 排 × 6 列 = 42 座，`NxM` 自定义语法不变。
`rooms --help` 与参数错误文案都写明了尺寸：「`small = 5 列 × 7 排 = 35 座，large = 6 列 × 7 排 = 42 座`」。

实测：`exam-seat --json rooms --spec "1:small,2:large"` → `R1 = 7×5 = 35 座`、`R2 = 7×6 = 42 座`；
`exam-seat template` 的前两个考场同样是 `7×5` 与 `7×6`。

> ⚠️ **行为变更，既有脚本要注意**：以前写 `small` 得到 30 座，现在得到 **35 座（+5）**。
> 依赖原尺寸的脚本 / job 请显式写 **`6x5`**；反过来，想要 35 座现在直接写 `small` 即可（不必再写 `7x5`）。

**证据**：`cli/src/cli.ts`（`small` 分支 `rows = 7; cols = 5`）、`cli/src/cli.ts` 的 help 文案、`template` 默认考场；
`cli/test/*` 对应断言。

**原始现状（保留存档 · 已修复）**

网页「小考场」预设本轮已按老师学校的真实规格改成 **5 列 × 7 排 = 35 座**（`web/src/lib/seat-grid.ts` 的 `ROOM_PRESETS.small`），
但 CLI `rooms --spec "1-20:small"` 仍然输出 **6 排 × 5 列 = 30 座**（`cli/src/cli.ts` 里 `small` 分支写死 `rows = 6; cols = 5`）。
实测：`exam-seat --json rooms --spec "1:small,2:large"` → `R1 = 6×5 = 30 座`、`R2 = 7×6 = 42 座`。

同一个词 `small` 在两端含义不同，AI 按 skill 写 `small` 排出来的考场会比老师预期小 5 个座位。

**验收标准**

1. CLI `small` 与网页预设一致（都 = 5 列 × 7 排 = 35 座），或明确改名避免歧义；
2. `--help` / 文档 / skill 里的说明同步（`small` 的尺寸写清楚）；
3. `pnpm test` 全绿，`cli/test/*` 补一条断言钉死 `small` 的尺寸。

**约束**

- 改动会让既有脚本的 `small` 变大 5 座，属于**行为变更**——需要先确认老师的既有 job 是否依赖 30 座；
- `large`（6×7=42）与 `NxM` 自定义语法不动。

---

## 议题 14：专属组合考场 `RoomSpec.combination` —— ✅ 已解决

**现状（本轮之前）**

想把「考政史地（或物化生）的整批学生集中到一个指定考场」，只能在第 ④ 步用限定写
`{ combinations: ["史地政"], roomId: "R9" }`——对老师来说是绕的（考场的属性要写在「限定」里）。

**解决方式**

`RoomSpec` 新增 `combination?: string`：该考场只接收 `students[].combination` 等于该值的**常规组合批次**
（整批进、全程不换考场，仍守 §5.1 硬规则）。

- 写法任意（`史地政` / `政史地` 等价），内部 `normalizeCombination` 归一（`util.ts` 的 `roomCombination`）；
- **允许多间钉同一组合**：超容量时按 `rooms` 顺序依次吃下，仍装不下走既有 `CAPACITY_INSUFFICIENT`（绝不混排）；
- 与 `dedicatedSubjects` 同时出现时**组合优先**，报 `ROOM_COMBINATION_IGNORED_DEDICATED`（warning）；
- **与「限定」等价**：与「把该组合 `roomId` 钉到同一考场」写法结果一致，**连座位号都相同**（测试钉死）；
  显式 `roomId` 限定优先于专属组合。
- 诊断：`ROOM_COMBINATION_APPLIED`（info）、`ROOM_COMBINATION_UNKNOWN`（warning，名单没有该组合 → 考场空置但结果仍 `ok`）。

**独立校验**（`validate` / `validateAll`，与求解器分开实现，都是 error）：
`ROOM_COMBINATION_MISMATCH`（专属考场里坐了别组合的人）、
`ROOM_COMBINATION_UNMET`（该组合的学生主考场不在钉住的考场里；被显式 `roomId` 钉走的学生放行）。

**证据**：`core/src/types.ts`、`core/src/util.ts`、`core/src/plan-all.ts`、`core/src/validate-combination.ts`；
`core/test/room-combination.test.ts`；`examples/acceptance.mjs` 第 21 节的 9 条断言
（专属组合生效 / 诊断文案 / `validate` 通过 / 与限定写法一致 / 未知组合警告+空置 / 与专用科目互斥 /
多间分流 / 装不下不导出 / 预检动态建议）。

---

## 议题 15：小考场规格与「改成大考场」建议的去硬编码 —— ✅ 已解决

**现状**

1. 网页「小考场」预设是 5 列 × 6 排 = 30 座，与老师学校的真实规格（5 列 × 7 排 = 35 座，见需求单）不符；
2. `precheck` 的「小考场改大考场」建议原先**写死 30 座**，预设一变动就失效。

**解决方式**

1. 网页预设 `ROOM_PRESETS.small` 改成 **5 列 × 7 排 = 35 座**（`web/src/lib/seat-grid.ts`），大考场仍 6 列 × 7 排 = 42；
2. `precheck` 的升级建议改为**动态**：以**本 job 里最大的考场**为基准，任何更小的考场都可建议改大，
   `gain = 最大 − 该考场`；按 gain 从大到小挑（同 gain 按考场顺序，保证同输入同建议），凑够缺口才给建议。
   文案形如「**第一考场 35 座 → 改成 42 座可多放 7 人**」（多个考场并列时给「把 A、B 改成最大考场那样大」）。
   代码里也留了注释说明「预设会变，所以不能硬编码」。

**证据**：`web/src/lib/seat-grid.ts`（`ROOM_PRESETS`）、`core/src/precheck.ts`（`upgrade-small-rooms` 建议）。

**后续**：本条当初留的「CLI `small` 仍是 30 座」这个尾巴，已在**议题 13** 里一并解决——
CLI 的 `small` 现在也是 **7 排 × 5 列 = 35 座**，与网页预设一致。

---

## 议题 16：`RoomSpec.combination` 在单场（`--single`）下不生效 —— ✅ 已解决

**解决方式**

采纳了「明确告知」这条路线（不改单场求解语义）：单场模式下专属组合是**多场次概念**——单场所有人考同一份卷子，
没有「按组合分流」可言——所以单场 `plan()` **忽略该字段但绝不静默**，逐考场报
**`ROOM_COMBINATION_IGNORED_SINGLE`（warning）**：

```
⚠️ 单场模式下所有考生考同一份卷子，第一考场的专属组合「政史地」不生效（按普通考场处理）
   证据：roomId=R1  combination=政史地
```

- 结果仍然 `ok`、**退出码 `0`**，不再出现误导性的 `SEARCH_FAILED`；
- `planAll` 的每套房求解带 `fromPlanAll` 标记，所以这条 warning **不会**混进多场次结果；
- 单场 `validate` 也不因为该字段报 `ROOM_COMBINATION_MISMATCH` / `_UNMET`（那两个码只在多场次判定）；
- CLI **成功时也会把这条 warning 打到终端**（不是只在 `--json` 里）；
- 多场次行为**完全不变**（专属组合照常生效并报 `ROOM_COMBINATION_APPLIED`）。

实测：同一份带 `combination` 的 job，`plan --single` → exit `0` + 上述 warning + 三人都排上；
不加 `--single` 走多场次 → `ROOM_COMBINATION_APPLIED`「第一考场 专属组合：政史地（2 人）」，R1 = 该组合、R2 = 其余。

**证据**：`core/src/plan.ts`（`ROOM_COMBINATION_IGNORED_SINGLE`）、`core/src/types.ts`、`core/src/validate.ts`
（注释明写单场与多场次的分工）、`cli/src/**`（成功路径打印 warning）。

**原始现状（保留存档 · 已修复）**

「专属组合考场」的分房逻辑只写在 `planAll`（`core/src/plan-all.ts:441,789`），
单场 `plan()` 路径**完全不认识** `RoomSpec.combination`。后果：

- 用 `--single`（或名单里没有任何选科信息、因而不进多场次）跑带 `combination` 的 job 时，
  别组合的学生照样会被排进专属考场；
- 然后独立校验器（`validate-combination.ts`）正确判它违规，最终以
  `SEARCH_FAILED`：「**丙（物化生）被安排在『政史地』专属考场 第一考场**」收场。
- 实测：`exam-seat plan --job <带 combination 的 job> --single` → `ok=false` + 上述 error；
  同一 job 去掉 `--single` 走多场次 → `ok=true`，`ROOM_COMBINATION_APPLIED`（第一考场 专属组合：政史地 2 人），R1 = 该组合、R2 = 其余。

**为什么算问题**

老师/AI 如果只在网页配了专属组合、又用 CLI 单场跑（或名单恰好没选科），会拿到一个**看起来像实现 bug 的
`SEARCH_FAILED`**，而不是「专属组合需要多场次」这类可操作的提示。

**验收标准**

二选一：

1. 单场 `plan()` 也遵守 `combination`（把它当作该考场的准入约束，`precheck` 同步参与可行性判断）；
   或
2. 至少在 `precheck` / `plan` 阶段明确报一条**可操作**的提示（例如
   `ROOM_COMBINATION_NEEDS_MULTI`：专属组合考场只在名单带选科的多场次模式生效，请去掉 `--single`），
   而不是让它走到 `SEARCH_FAILED`。

两条路都要：`pnpm test` 全绿、`core/test/room-combination.test.ts` 补一条单场用例、
`docs/design.md` §5.5.1 与 `reference.md` 同步。

**约束**

- 不改多场次既有语义与等价性（与「限定钉考场」连座位号一致）；
- 先回写 `docs/design.md` §5.5.1 再动代码。

---

## 议题 18：监考表备注规则的 v1 → v3 演进 —— ✅ 已解决（v3 定稿）

**背景**

监考表的「备注」列被老师连续三轮反馈推翻重做。这条记的是**最终口径**与两条「为什么不这样」，
避免以后有人又把它改回中间版本。

### 三代规则对比

| 版本           | 写法                                                                                         | 为什么被推翻                                           |
| -------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| v1             | 借考行写 `借考（生物）`                                                                      | 老师：**表上没有「借考」这个概念**，监考老师看不懂这词 |
| v2             | `借考（第6时段 生物）`（补时段）                                                             | 写是写清了，但**时段是噪音**（见下）                   |
| **v3（定稿）** | 主考场缺科 → `不考：生物`；外来单科 → `只考：生物`；**不带时段、不带「借考」字样、不带括号** | —                                                      |

### v3 规则

- **主考场 = 该生考「语数外」的那间考场**（老师原话：「毕竟语数外算是一个学生的主考场」）；
  取不到语数外信息时（单场 / 数据缺失）退回「座位时段最多的那间」。
- 本考场是主考场、但该生缺其中某科 → `不考：<科目>`（多科用「、」，按 core 科目固定顺序）；
- 本考场不是主考场（外来单科借考）→ `只考：<科目>`；
- 外来但**考满该考场全部科目** → 不写；正常全考 → 不写。

### 为什么去掉时段（老师原话的意思）

> **监考老师是提前知道自己哪一场有监考任务才来的**，不需要从表上获取时间；学生自己也知道考试时间。
> 表上写时段只会让备注变长、挤占列宽。

### 为什么「外来但考满整间」不写

例：政治单科房间里坐着物化政的学生——他在这间**考的科目 = 这间的全部科目**，
`只考：政治` 这句话**没有任何信息量**（这间本来就只考政治），只会给每行都加一样的噪音。
所以规则是「有信息量才写」。这条也顺带避免了「只考」出现在整间都一样的表里。

### 判定为什么必须数据驱动

用 `byStudent[].slots[].roomId` 反推「他在这间实际考了哪几科」，
**不能**拿 `students[].subjects` 相减——那份**只有 3 门选科，不含语数外**，
相减会把语文/数学/外语全判成「不考」。

### 真实数据实测（706 人 / 20 张 sheet）

只有 **2 张** sheet 出现备注：

| 考场                              | 行数 | 备注                                   |
| --------------------------------- | ---- | -------------------------------------- |
| 第十八考场（语数外物化生）        | 34   | 22 行 `不考：生物` + 1 行 `只考：生物` |
| 第十七考场（语数外政史地）        | 29   | 1 行 `不考：地理`                      |
| 第十九考场（政治 / 地理）、R1–R16 | —    | **0 备注**                             |

> 第十七考场那行 `不考：地理` 的学生组合是 **史生政**——他**地理在任何考场都没考**，
> 所以他在主考场（语数外政史地那间）确实「不考地理」。**这是正确行为，不是 bug**：
> 备注描述的是「这间考场里他要不要考某科」，不是「他选了没选」。

备注列宽 11.65cm / 10.54cm，都 ≤ A4 横向可用宽 27.8cm。

### ⚠️ 唯一的差异点：CLI / 网页的「借考明细」仍保留时段

监考表备注去掉了时段，**但 CLI 摘要与网页里的「借考明细」没有**——
那里仍然写「某生 **T6** 生物 → 第十八考场」，因为那是**给人看走位**的（老师要据此知道什么时候去哪个考场），
和监考表「给监考老师现场点名」的用途不同。**别以为全局都去掉了时段。**

**证据**：`io/src/schedule-export.ts`（`seatingRemark` / `seatingAttendance` / `studentMainRoomId`）；
`cli/src/render.ts`（借考明细，保留时段）；`io/test/*`；`docs/design.md` §5.6「备注列规则（v3）」。
