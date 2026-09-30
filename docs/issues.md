# 未完成事项 / 议题清单

> 这里放**已经设计好、但还没实现**的事情。每条都写成可以直接交给子代理执行的任务：
> 现状 → 验收标准 → 约束。改完请把对应条目标记为「已解决（提交号）」或删掉。

---

## 议题 1：表格虚拟滚动（Web）

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

## 议题 2：Web 端「场次编排」（多场次）

**现状**

core / io / CLI 已经支持多场次（`planAll`、按班级与按考场的两种导出、`exam-seat plan` 自动识别选科），
但**网页第 ⑤ 步目前只跑单场 `plan`**：名单里带选科时，网页会在求解页显示一条提示，让老师改用 CLI。
设计见 `docs/design-selection.md` 的 S7，进度表见其 §10。

**验收标准**

1. 名单里带选科（`combination` / `subjects`）时，网页能完成多场次编排并展示「时段 → 考场 + 座位」。
2. 结果页能导出 `按班级考场安排.xlsx` 与 `考场监考表.xlsx`（`@exam-seat/io` 已有对应函数）。
3. 空置考场能被点名列出，并支持一键移除。
4. `pnpm verify` 全绿。

**约束**

- 单场路径（没有选科字段的名单）行为不能变。
- 第 ⑤ 步的预检 / 诊断 / 建议一键应用机制要复用，不要另起一套。

---

## 议题 3：Skill 还没跟上 job.json v2 / 多场次（S8）

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
