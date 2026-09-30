# 未完成事项 / 议题清单

> 这里放**已经设计好、但还没实现**的事情。每条都写成可以直接交给子代理执行的任务：
> 现状 → 验收标准 → 约束。改完请把对应条目标记为「已解决（提交号）」或删掉。
>
> **状态（本轮收口）**：议题 1 / 2 / 3 已解决（见每条开头的 ✅ 说明与本轮验收证据）；
> 遗留 **议题 4**：多场次暂不支持 `constraints`（限定）——但已改为**显式告警**，不再静默忽略。

---

## 议题 1：表格虚拟滚动（Web）—— ✅ 已解决

**解决方式**：新增 `packages/web/src/components/VirtualTable.vue`（`el-table-v2` + `el-auto-resizer`），
第 ②④①⑥ 步的四张表（排除缺考主表 + 已排除抽屉、设置限定学生表、导入问题行、结果页主表）全部改为虚拟滚动；
考场配置表（行内编辑、行数少）按约束保留 `el-table` 并在 `docs/design.md` §10.4 写明理由。
**证据**：`web/test/virtual-table.test.ts`、`web/test/step-exclude-virtual.test.ts` —— 1000 行时 DOM 只渲染 24 行，
表头「全选当前结果」仍勾中全量 1000 人；搜索 56 人 → 全选 → 批量排除，一个不漏；`app-smoke` 六页仍全绿。

**原始现状（保留存档）**

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

**约束**

- 不引入新的 UI 库；优先用 Element Plus 自带的虚拟化能力（例如 `el-table-v2` + `el-auto-resizer`，
  注意它需要显式列定义与 `ResizeObserver`，jsdom 测试里要保留现有的 stub）。
- 搜索/筛选/选择的数据流保持「store 里的全量数据 + 计算属性过滤」，**虚拟滚动只影响渲染**，
  不要把「当前渲染的行」当成「当前结果集」，否则「全选当前结果」会静默漏人。
- 若某张表确实无法虚拟化（例如需要行内编辑的考场配置表），可以保留 `el-table` 并在文档里写明理由。

---

## 议题 2：Web 端「场次编排」（多场次）—— ✅ 已解决

**解决方式**：第 ⑤ 步名单带选科时默认走 `planAll`（`solver.worker` 增加 `mode`，`useSolver.run(job, overrides, mode)`），
结果写进 `result` store（`mode` / `planAll` / `slots` / `seatings` / `scheduleByStudent` / `emptyRoomIds` …）；
第 ⑥ 步展示「时段 → 考场 + 座位」、座位方案概览与校验摘要，并导出 `按班级考场安排.xlsx` 与 `考场监考表.xlsx`；
空置考场按**求解结果**列出并可一键移除。单场路径（无选科字段）行为不变。
**附带修复**：`useSolver.run()` 原来建好 Worker、挂完监听却从未 `postMessage`，第 ⑤ 步求解永远不会开始——已修复。
**证据**：`web/test/result-store-multi.test.ts`、`step-solve-multi.test.ts`、`step-result-multi.test.ts`、`session-export.test.ts`；
web 全量 123 项单测 + `vue-tsc` 0 报错；验收脚本新增多场次工作簿与硬规则断言。

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

## 议题 4：多场次暂不支持 `constraints`（限定）

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

## 议题 5：多场次结果的独立校验（`exam-seat validate`）

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
