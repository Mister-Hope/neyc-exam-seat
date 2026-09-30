# exam-seat 参考手册

配套 `SKILL.md` 使用。这里放名单输入契约、完整字段表（含 job.json v2 的选科与多场次）、诊断码全表、CLI 全参数。
字段语义以 `docs/design.md` 为准。

---

## 0. 名单输入契约

### 0.1 必填列与列别名

| 字段          | 必填   | 列别名（识别用，至少含这些）                                                                                     |
| ------------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| `id`          | **是** | 准考证号、**考证号**、学号、考号、考生号、准考证、学籍号、考籍号、编号、id、studentid、studentno、examid、examno |
| `name`        | **是** | 姓名、学生姓名、考生姓名、名字、name、studentname                                                                |
| `className`   | **是** | 班级、行政班、所在班级、教学班、班、class、classname、grade                                                      |
| `absent`      | 否     | 缺考、是否缺考、缺考标记、缺考状态、缺考情况、不参加、不参加考试、缺席、isexcluded、absent                       |
| `combination` | 否     | 选科、选考、科目、组合                                                                                           |
| `gender`      | 否     | 性别、sex、gender                                                                                                |
| `note`        | 否     | 备注、说明、note、remark                                                                                         |

**表头识别是宽松的**：先把表头归一化（去掉**所有空白**含全角空格与 `\t`、全角 ASCII → 半角、
去掉 `_ - （） () ： :` 等分隔符、转小写）再匹配——所以 `班 级`、`姓 名`、`准 考 证 号` 都能认。
匹配顺序是**先全等、再包含**，且包含匹配要求别名长度 ≥ 2，所以 **`班主任` 不会被当成班级列**。
同一列只会被一个字段占用（优先级 `id → name → className → absent → combination → gender → note`）。

**不要手写列名 / 猜列位置**：用 `@exam-seat/io` 的 `readRoster`（以及 `parseRoster` / `normalizeHeader`），
拿不准就把输出的 `headers` 与 `mapping` 交给用户确认。

### 0.2 缺考路线 A：同一份名单里的「缺考」列

名单里若有 `absent` 列，这份文件就是**完整名单 + 标记**：

| 单元格内容（去空白、全角转半角后）                                                                   | 判定     |
| ---------------------------------------------------------------------------------------------------- | -------- |
| 空                                                                                                   | 不缺席   |
| `否` / `0` / `N` / `no` / `false` / `正常` / `参加` / `参加考试` / `不缺考` / `无` / `-` / `—` / `/` | 不缺席   |
| 其它任何内容（如 `是` / `1` / `Y` / `病假` / `缺考`）                                                | **缺席** |

缺席的学生置 `included: false`（等价于网页上的「排除缺考」），容量校验与统计都按**实际参考**算。

### 0.3 缺考路线 B：独立的缺考名单文件

```bash
exam-seat --json roster --file 全名单.xlsx --absent 缺考名单.xlsx > roster.json
exam-seat --json roster --file 全名单.xlsx --absent 缺考名单.xlsx --absent-sheet 缺考
```

匹配规则：

- 缺考名单里**有 `id` 列就优先用 `id`**（准考证号/考证号…）精确匹配；
- 没有 `id` 列时，必须**同时**有 `姓名 + 班级`，按 (班级, 姓名) 成对匹配；缺列 → error issue 说明缺哪列；
- 匹配键会归一化（去全部空白、全角转半角、字母数字转小写）；
- 命中者 `included: false`；**未命中的行会被报出来**（写出第几行与键值，warning），不能静默丢弃——要么让用户核对，要么说明这些行没匹配上；
- 如果「缺考名单」文件**自己带 `absent` 列**，就按 §0.2 的「完整名单 + 标记」处理，只取真正缺席的行。

CLI 应用后会打印「缺考名单命中 N 人 / 未匹配 M 行」（措辞以实际输出为准）。

### 0.4 在代码里怎么读

`@exam-seat/io` 根入口（浏览器 / Node 通用）：

| API                                           | 作用                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `readRoster(sheet, mapping?)` / `parseRoster` | 表 → `students`（含 `included`）+ `issues` + `headers` / `mapping`       |
| `readAbsentKeys(sheet, mapping?)`             | 缺考名单表 → `{ keys, issues }`（按 §0.3 规则）                          |
| `applyAbsentKeys(students, keys)`             | → `{ students, matched, unmatched, issues }`；**返回新数组，不改原数组** |

`included: false` 就是「本次不参加」，它是 `Student` 的字段，不是新字段。

### 0.5 网页侧

网页「导入名单」会自动预填列映射（可手改，改完立刻重解析并保住已排除状态），并支持「导入**缺考名单**」
走同一套匹配规则；页面上的「排除缺考」与 `included: false` 是同一件事，AI 给用户的说明要与之一致。

---

## 1. Job JSON 完整字段

### 顶层

| 字段          | 类型         | 必填   | 说明                                  |
| ------------- | ------------ | ------ | ------------------------------------- |
| `jobVersion`  | number       | 否     | 目前为 `2`；v2 才有选科与专用考场字段 |
| `meta`        | object       | 否     | `{ title, createdAt }`，只用于展示    |
| `options`     | object       | 否     | 见下表                                |
| `students`    | Student[]    | **是** | 全部学生                              |
| `rooms`       | RoomSpec[]   | **是** | 考场列表，顺序即「第1考场、第2考场…」 |
| `constraints` | Constraint[] | 否     | 限定规则；多场次同样生效（见 §2.6）   |

### options

| 字段                  | 默认                | 说明                                                                                                                                              |
| --------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seed`                | `20260930`          | 随机种子。**同 seed 同输入必得完全相同的结果**                                                                                                    |
| `adjacency`           | `"king"`            | `"king"` = 8 邻域（含对角）；`"orthogonal"` = 前后左右                                                                                            |
| `forceKing`           | `false`             | 班级数 < 9 时默认自动退化为 4 邻域；置 `true` 则坚持 8 邻域                                                                                       |
| `relax`               | `"none"`            | `"none"` 限定为硬约束；`"softConstraints"` 限定降为高权重惩罚；`"minConflicts"` 只求冲突最少                                                      |
| `timeLimitMs`         | `10000`             | 求解时间上限                                                                                                                                      |
| `groupPreference`     | `"sameCombination"` | 多场次分房倾向：`"sameCombination"` = 一个考场只放同一组合；`"fillRooms"` = 先把当前考场填满（见 §2.5）                                           |
| `regularCombinations` | 自动判定            | 手工指定哪些组合算「常规组合」（只在一个考场考完）。不填时按传统文理判定：选考科目全在理科侧或全在文科侧算常规，跨文理（物化政 / 物化地）算非常规 |
| `maxRoomsPerStudent`  | `3`                 | 一个学生最多允许用几个考场，超过进入 `overRoomLimit`                                                                                              |

### Student

| 字段            | 类型     | 说明                                                                  |
| --------------- | -------- | --------------------------------------------------------------------- |
| `id`            | string   | **必填**，学号，全局唯一                                              |
| `name`          | string   | 姓名                                                                  |
| `className`     | string   | **必填**，班级名。同名字符串视为同一个班                              |
| `gender`        | string   | 选填                                                                  |
| `included`      | boolean  | `false` = 本次不参加考试（等价于网页上「排除缺考」）。缺省视为 `true` |
| `combination`   | string   | v2 选科**原文**，给老师看，如 `"物化政"`                              |
| `subjects`      | string[] | v2 选科**规范化科目 id**，如 `["physics","chemistry","politics"]`     |
| `tags` / `meta` | —        | 选填，透传                                                            |

**名单里任意一个学生带 `combination` 或 `subjects` ⇒ 整份 job 进入多场次模式**（`planAll`）。

### 科目 id 全表

| id          | 科目 | 归属           |
| ----------- | ---- | -------------- |
| `chinese`   | 语文 | 必考（3）      |
| `math`      | 数学 | 必考（3）      |
| `english`   | 外语 | 必考（3）      |
| `physics`   | 物理 | 首选（1 选 1） |
| `history`   | 历史 | 首选（1 选 1） |
| `chemistry` | 化学 | 再选（4 选 2） |
| `biology`   | 生物 | 再选（4 选 2） |
| `politics`  | 政治 | 再选（4 选 2） |
| `geography` | 地理 | 再选（4 选 2） |

四类组合名：物化生（常规理）、政史地（常规文）、物化政（非常规理）、物化地（非常规理）。

### RoomSpec

| 字段                | 类型                  | 说明                                                                                                         |
| ------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `id`                | string                | **必填**，唯一。约束里用它引用考场                                                                           |
| `name`              | string                | 展示名，如「第3考场」。缺省用 `id`                                                                           |
| `location`          | string                | v2 地点，如「高二一班」「生物实验室」；出现在监考表表头、座位表、网页                                        |
| `rows`              | number                | **必填**，排数。行号从**讲台**起算：第 1 排 = 首排                                                           |
| `cols`              | number                | **必填**，列数。列号从**靠门侧**起算：第 1 列 = 靠门列                                                       |
| `doorSide`          | `"left"` \| `"right"` | 默认 `"right"`。只影响「靠门列/靠窗列」的解析和座位图的左右朝向                                              |
| `note`              | string                | 备注，例如监考老师                                                                                           |
| `dedicatedSubjects` | string[]              | v2 专用科目，如 `["politics","geography"]`。指定后该考场只接收非常规组合中考了这些科目的学生；**可以兼多科** |

常用规格：

| 名称     | rows × cols | 容量 |
| -------- | ----------- | ---- |
| 小考场   | 6 × 5       | 30   |
| 大考场   | 7 × 6       | 42   |
| 自定义例 | 6 × 4       | 24   |

容量 = `rows × cols`。单个考场内，同一个班的人数上限是 `⌈rows/2⌉ × ⌈cols/2⌉`（8 邻域下）。

### Constraint

| 字段           | 类型     | 说明                                 |
| -------------- | -------- | ------------------------------------ |
| `id`           | string   | **必填**，唯一                       |
| `note`         | string   | 备注，诊断信息里会用到               |
| `studentIds`   | string[] | 选择器：点名                         |
| `classes`      | string[] | 选择器：按班级名                     |
| `combinations` | string[] | 选择器：按组合原文，如 `["物化政"]`  |
| `subjects`     | string[] | 选择器：按科目 id，如 `["politics"]` |
| `roomId`       | string   | **单选**。缺省 = 不限考场            |
| `rows`         | RowRef[] | 见下                                 |
| `cols`         | ColRef[] | 见下                                 |

四个选择器（`studentIds` / `classes` / `combinations` / `subjects`）**取并集**；一个都不写 → 报 `CONSTRAINT_NO_SELECTOR`。

**RowRef**：`"first"`（首排）｜ `"last"`（末排）｜ 数字（绝对排号，**仅当同时给了 `roomId` 时才可靠**）

**ColRef**：`"door"`（靠门列）｜ `"window"`（靠窗列）｜ 数字（绝对列号，从靠门侧起算，**仅当同时给了 `roomId` 时才可靠**）

**为什么必须用语义值**：考场有大小之分。`"last"` 在 6 排考场是第 6 排、在 7 排考场是第 7 排；`"window"` 在 5 列考场是第 5 列、在 6 列考场是第 6 列。写死数字会在混合考场里指错位置。

**同一学生被多条规则命中时取交集**，交集为空 → 报 `RULE_INTERSECT_EMPTY`。

### 常用写法

| 需求                 | 写法                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| 只看靠门，不在乎考场 | `{ "cols": ["door"] }`                                                    |
| 强制到某考场         | `{ "roomId": "R3" }`                                                      |
| 有作弊前科坐首排     | `{ "rows": ["first"] }`                                                   |
| 4 人放同考场四角     | `{ "roomId": "R5", "rows": ["first","last"], "cols": ["door","window"] }` |
| 某考场第 3 排第 2 列 | `{ "roomId": "R3", "rows": [3], "cols": [2] }`                            |
| 物化政全体靠门       | `{ "combinations": ["物化政"], "cols": ["door"] }`                        |
| 考政治的靠窗         | `{ "subjects": ["politics"], "cols": ["window"] }`                        |
| 高三(3)班首排        | `{ "classes": ["高三(3)班"], "rows": ["first"] }`                         |

---

## 2. 选科与多场次（job.json v2）

### 2.1 触发与交付物

- 名单里**任意一个学生**有 `combination` 或 `subjects` ⇒ `exam-seat plan` 自动走多场次（`planAll`）。
- 没有选科的名单照旧单场，行为完全不变。
- `--single` 强制按单场处理（忽略选科）。
- 多场次交付物是**两份 xlsx**：`按班级考场安排.xlsx`（输出 A）+ `考场监考表.xlsx`（输出 B），另写 `plan.json`。
- 单场交付物是 `考场安排名单.xlsx`（名单 / 按班级 / 校验报告）+ `考场座位表.xlsx`。

### 2.2 硬规则：一个考场、一个时段、只能考一科

**任何时刻，同一个考场里只能有一门科目在考**（只能发一张卷子）：某时段坐在这个考场的学生必须全部答同一门科目；
没考试的学生就是不在这个考场，与规则无关。这条规则**不可降级、不可绕过**——排不出来时宁可报容量不足，
也不许把两门科目塞进同一个考场。

- 只有**逐时段科目完全一致**的批次才能共用一个考场（例：物化政 + 物化地共用非常规主考场，T1 语 / T2 数 / T3 外 / T4 物 / T5 化 完全相同）。
- 常规理（物化生）× 常规文（政史地）**绝对不能共用**：T4 一个考物理、一个考历史；T6 一个考生物、一个考政治。
- 违反时报 `ROOM_SUBJECT_CLASH`（error），该结果**不得导出**。

### 2.3 时段推导（T1–T7）

「两科能否同时考 = 有没有学生同时选了两科」，由程序按冲突关系图着色自动推导，不写死。

| 时段 | 并行科目        | 物化生 | 政史地 | 物化政 | 物化地 |
| ---- | --------------- | ------ | ------ | ------ | ------ |
| T1   | 语文            | 语文   | 语文   | 语文   | 语文   |
| T2   | 数学            | 数学   | 数学   | 数学   | 数学   |
| T3   | 外语            | 外语   | 外语   | 外语   | 外语   |
| T4   | **物理 / 历史** | 物理   | 历史   | 物理   | 物理   |
| T5   | 化学            | 化学   | —      | 化学   | 化学   |
| T6   | **生物 / 政治** | 生物   | 政治   | 政治   | —      |
| T7   | 地理            | —      | 地理   | —      | 地理   |

「—」= 该组合这个时段没有考试。**化学必须独占一段**，所以共 7 段。
硬校验：**同一个学生在同一个时段最多只能有一场考试**（`findSlotConflicts`）。

`TimeSlot` 形状：`{ id: "T1"…"T7", name: "第1时段"…, subjects: ["physics","history"] }`（`name` 是「第N时段」，不是科目名）。

### 2.4 考场角色与「每人去几个考场」

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

结论：**常规组合全程不换考场，非常规组合中途换一次**。每人最多 3 个考场；超出进入 `overRoomLimit`（正常为空）。

### 2.5 `groupPreference` 两种取值的区别

| 取值                | 含义                                                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"sameCombination"` | **默认**。每个批次（组合）独占若干考场，一个考场里只有一个组合 → 监考表最干净；考场不够时直接报 `CAPACITY_INSUFFICIENT`，不偷偷混排                                                                                                                  |
| `"fillRooms"`       | 先把当前考场填满再换下一个，省考场。只允许与**逐时段不冲突**的批次共用（同一时段最多一门科目），共用时报 `ROOMS_SHARED`（warning），并**合并成一套座位方案**（学生并集、一次 `plan()`、座位号唯一）；标题取**科目并集**，该考场仍只出 **1 张**监考表 |

两者都必须满足 §2.2 的硬规则；违反时报 `ROOM_SUBJECT_CLASH`。

`SEARCH_FAILED` 不一样：它是 `--relax` / 降级后的**主动选择**，结果**照常导出**（见 §3.4）。

### 2.6 多场次也支持 `constraints`（限定）

多场次（`planAll`）**会应用** job 里的限定，规则如下：

- 每套座位只下发「命中该座位学生 **且** `roomId` 为空或等于本考场」的规则；
- `rows` / `cols` 按**该学生实际坐的那套座位的考场**解析：`first` / `last` / `door` / `window`，
  以及指定考场后的绝对行列号，都生效；
- `roomId` **参与分房**：被钉到某考场的学生只能进那个考场（所在批次优先排进去）。

**满足不了就是失败，绝不静默放宽**：装不下 / 与其它限定冲突 / `roomId` 指向学生不会去的考场，
一律报 error（`CONSTRAINT_OVERSATURATED` / `RULE_INTERSECT_EMPTY` / `CONSTRAINT_EMPTY_DOMAIN`），
**不导出名单**，也不会偷偷改成「不限考场」。

**未满足的限定 = 结果失败**：`PlanAllResult.unmetConstraints` 非空即 `ok=false`
（每项带 `roomId` / `roomName`）；CLI 多场次摘要里单列一段「未满足的限定：<id> · <考场> ｜ 涉及 N 人 ｜ 原因」。
`CONSTRAINTS_IGNORED_MULTI` 只是**历史码**（正常路径不再产生），见到它说明数据来自旧版本。

### 2.7 空置考场

排完后一个学生都没安排到的考场会在结果的 `emptyRooms` 里点名（CLI 也会打印「可取消的空置考场」）。
提醒用户可以取消；不要自己改动结果文件。

---

## 3. 输出 plan.json

### 3.1 单场 `PlanResult`

| 字段                                   | 说明                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ok`                                   | **是否零冲突且全部限定满足**。交付前必看                                                                                  |
| `level`                                | `strict` / `orthogonal` / `softConstraints` / `minConflicts`。非 `strict` 都要告诉用户                                    |
| `stats.adjacency`                      | 实际生效的相邻规则                                                                                                        |
| `stats.conflicts`                      | 冲突数                                                                                                                    |
| `stats.unmetConstraints`               | 没坐上限定位置的人数                                                                                                      |
| `stats.roomsUsed` / `stats.emptyRooms` | 实际用了几个考场、哪些空置                                                                                                |
| `entries[]`                            | **名单**。`roomName` / `seatNo` / `studentId` / `name` / `className` / `row` / `col`（业务列，靠门侧起算）/ `physicalCol` |
| `conflicts[]`                          | 冲突明细                                                                                                                  |
| `unmetConstraints[]`                   | 未满足的限定                                                                                                              |
| `diagnostics[]`                        | 诊断与建议                                                                                                                |

### 3.2 多场次 `PlanAllResult`

| 字段               | 类型                                                       | 说明                                                      |
| ------------------ | ---------------------------------------------------------- | --------------------------------------------------------- |
| `ok`               | boolean                                                    | 所有座位方案都 ok、没有 error、且 `unmetConstraints` 为空 |
| `slots`            | `TimeSlot[]`                                               | 时段划分（`id` / `name` / `subjects`，见 §2.3）           |
| `seatings`         | `SeatingPlan[]`                                            | 一套座位方案 = 一个考场里一批固定学生 + 一套固定座位      |
| `byStudent`        | `StudentSchedule[]`                                        | 每人「时段 → 考场 + 座位」                                |
| `emptyRooms`       | string[]                                                   | 一个学生都没安排的考场 id → 可以取消                      |
| `overRoomLimit`    | `{ studentId, name, count }[]`                             | 考场数超过 `maxRoomsPerStudent` 的学生（正常为空）        |
| `unmetConstraints` | `{ constraintId, studentIds, reason, roomId, roomName }[]` | 各套座位汇总的未满足限定；**非空即 `ok=false`**           |
| `diagnostics`      | `Diagnostic[]`                                             | 诊断与建议                                                |

`SeatingPlan`：

| 字段                                        | 说明                                            |
| ------------------------------------------- | ----------------------------------------------- |
| `subjects`                                  | 这套座位服务的科目                              |
| `roomId` / `roomName` / `location` / `note` | 考场与地点、监考老师                            |
| `studentIds`                                | 这批学生的学号                                  |
| `seatNoById`                                | 学号 → 座位号                                   |
| `studentBySeatNo`                           | 座位号 → 学号（监考表要用）                     |
| `result`                                    | 该考场的单场 `PlanResult`（含冲突、统计、诊断） |

`StudentSchedule`：

| 字段                                               | 说明                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `studentId` / `name` / `className` / `combination` | 学生信息；`combination` 可为 `null`                                                                                 |
| `slots`                                            | `Record<slotId, { subject, subjectLabel, roomId, roomName, location?, seatNo } \| null>`；`null` = 这个时段他没考试 |
| `rooms`                                            | 用到的考场，按首次出现顺序（`roomId` / `roomName` / `location?` / `subjects`）                                      |
| `distinctRooms`                                    | 一共用了几个不同考场（硬上限 3）                                                                                    |

`planAll` 内部对每个「座位方案」调用一次单场 `plan`——**没有第二套算法**。

### 3.3 两份多场次工作簿

**输出 A：`按班级考场安排.xlsx`（给学生和班主任）**

| 班级      | 姓名 | 考场①                    | 考场②                | 考场③ |
| --------- | ---- | ------------------------ | -------------------- | ----- |
| 高三(1)班 | 张伟 | 第一考场（语数外物化生） |                      |       |
| 高三(7)班 | 李娜 | 第三考场（语数外物化）   | 第二十考场（政治）   |       |
| 高三(9)班 | 王强 | 第五考场（语数外物化）   | 第二十一考场（地理） |       |

- 三个「考场」列按需出现：没人用到第③列就不输出；
- 单元格 = `考场名（这个学生在该考场考的科目）`；
- ②③列只对需要换考场的人有值；表尾附**按班级小计**（每班需要换考场的人数）。

**输出 B：`考场监考表.xlsx`（给监考老师）**

分组规则：**同一考场 × 同一批考生**的时段合并成一张 sheet，每张表头三行：

```
第一考场（语数外物化生）      地点：高二一班      监考：张老师
座位号 | 班级        | 姓名
  1    | 高三(1)班   | 张伟
  2    | 高三(5)班   | 李娜
```

常规考场各 1 张；非常规主考场 1 张；政治 / 地理专用考场各 1 张。万一某考场混了批次（只在 `fillRooms` 且两批逐时段不冲突时），
合并成一套座位后仍出 **1 张**，标题 = 考场名（**科目并集**）。

### 3.4 导出闸门：`--out-dir` 到底写哪些文件

默认写全：

- 单场：`考场安排名单.xlsx` + `考场座位表.xlsx` + `plan.json` + `job.json`
- 多场次：`按班级考场安排.xlsx` + `考场监考表.xlsx` + `plan.json` + `job.json`

其中 `job.json` 是**自动剔除空置考场后**的配置（空置考场为 0 时照常写；一个考场都没用到时保留原配置，不把 job 掏空）。

只有**结构性** error 才拒绝写名单 / 监考表（此时 `plan.json` + `job.json` 照写留痕）：

- **阻止导出**：`ROOM_SUBJECT_CLASH`、`CAPACITY_INSUFFICIENT`、`NO_STUDENTS`、`NO_ROOMS`、`INVALID_ROOM_SIZE`、
  `STUDENT_DUPLICATE_ID`、`STUDENT_MISSING_CLASS`、`CLASS_LIMIT_EXCEEDED`、`SEAT_CONFLICT`、`UNKNOWN_ROOM_ID`、
  `CONSTRAINT_*`、`RULE_INTERSECT_EMPTY`
- **不阻止导出**：`SEARCH_FAILED`、`TOO_FEW_CLASSES`、`ROOMS_SHARED`、`ROOMS_OVERPROVISIONED`、
  `STUDENT_MISSING_NAME` / `STUDENT_MISSING_SUBJECTS`、`UNKNOWN_STUDENT_ID`、`ABSOLUTE_ROWCOL_WITHOUT_ROOM`
  （`CONSTRAINTS_IGNORED_MULTI` 是历史码，正常不再产生）

CLI 拦下时会在 stderr 说明「结果未通过校验，已只导出 plan.json / job.json，未导出名单与监考表」并逐条列出 error；
判据来自 core 的 `blocksListExport(diagnostics)`（码表 `BLOCKING_EXPORT_CODES`）。
降级结果（`level != "strict"`，退出码 2）**照常导出**，但必须向用户说明哪里被降级了。

---

## 4. 诊断码全表

单场与多场次共用一个码表；每条 `Diagnostic` 都带 `code` / `severity` / `message`（中文人话）/ `evidence` / `suggestions[]`。

| 代码                            | 级别    | 含义                                               | 给用户的说法 / 处理                                                                |
| ------------------------------- | ------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `OK`                            | info    | 预检通过                                           | 正常往下走                                                                         |
| `STUDENT_DUPLICATE_ID`          | error   | 学号重复                                           | 让用户先修名单                                                                     |
| `STUDENT_MISSING_CLASS`         | error   | 有学生没班级                                       | 班级是相邻约束的基础，必须补                                                       |
| `STUDENT_MISSING_NAME`          | warning | 有学生没姓名                                       | 名单里显示为空                                                                     |
| `STUDENT_MISSING_SUBJECTS`      | warning | 多场次下有人没有选科信息                           | 这些学生不会进入任何时段，请补选科                                                 |
| `INVALID_ROOM_SIZE`             | error   | 考场行列数不是 ≥1 的整数                           | 修正考场尺寸                                                                       |
| `NO_ROOMS` / `NO_STUDENTS`      | error   | 没配考场 / 参考人数为 0                            | 加考场 / 取消排除                                                                  |
| `CAPACITY_INSUFFICIENT`         | error   | 座位总数 < 考生数；或 `sameCombination` 下考场不够 | 「还差 N 个座位」，建议里会给「小考场改大考场」「加考场」「少排 N 人」，各带 patch |
| `CLASS_LIMIT_EXCEEDED`          | error   | 某班人数超过所有考场的容纳上限                     | 「这个班还差 N 个位置」，需要加考场或改大考场                                      |
| `CONSTRAINT_EMPTY_DOMAIN`       | error   | 某条限定在任何考场都匹配不到座位                   | 检查行列是否写错                                                                   |
| `CONSTRAINT_INDEX_OUT_OF_RANGE` | error   | 绝对行列号在候选考场里都不存在                     | 改用 `"window"` / `"last"` 语义值，或指定一个够大的考场                            |
| `ABSOLUTE_ROWCOL_WITHOUT_ROOM`  | warning | 用了绝对号却没指定考场                             | 会按每个考场各自的行列数分别解析，通常应该改成语义值                               |
| `CONSTRAINT_NO_SELECTOR`        | error   | 一条限定没写任何选择器                             | 这条限定不会生效，补一个选择器或删掉                                               |
| `CONSTRAINT_OVERSATURATED`      | error   | 一条限定的可用座位数少于它管的人数                 | 典型是「5 个人抢 4 个角」，把多出的人移走或分散到别的考场                          |
| `RULE_INTERSECT_EMPTY`          | error   | 同一学生的多条限定交集为空                         | 通常是同时指定了两个不同考场，删掉其中一条                                         |
| `SEAT_CONFLICT`                 | error   | 两个人被钉到同一个座位                             | 改掉其中一个                                                                       |
| `UNKNOWN_ROOM_ID`               | error   | 限定引用了不存在的考场                             | 修正 `roomId`                                                                      |
| `UNKNOWN_STUDENT_ID`            | warning | 限定点名了名单里不存在的学生                       | 修正 `studentIds`                                                                  |
| `ROOMS_OVERPROVISIONED`         | info    | 座位远多于考生，靠后的考场会空置                   | 提示可减少考场数                                                                   |
| `ROOMS_SHARED`                  | warning | 多场次：`fillRooms` 下多个批次共用考场             | 合并成一套座位（学生并集），标题 = 考场名（科目并集），仍出 1 张监考表             |
| `ROOM_SUBJECT_CLASH`            | error   | 同一考场同一时段出现两门科目（违反硬规则）         | 调整分房或加考场；该结果**不得导出**                                               |
| `CONSTRAINTS_IGNORED_MULTI`     | warning | **历史码**：多场次曾忽略限定                       | 现已支持限定（§2.6），正常路径不再产生；见到说明数据来自旧版本                     |
| `TOO_FEW_CLASSES`               | warning | 班级数 < 9，已自动退化到 4 邻域                    | **不算错误**，但必须告诉用户「对角允许同班了」                                     |
| `SEARCH_FAILED`                 | error   | 预检通过但求解没做到零冲突                         | 读 `evidence.bottleneck` 定位瓶颈，再决定降级还是调整考场                          |

每条 `Suggestion` 带 `patch`（JSON Patch：add / remove / replace），可直接打到 job.json 后重跑。

### SEARCH_FAILED 的建议（suggestions）长这样

| suggestion.id         | 做什么                           |
| --------------------- | -------------------------------- |
| `relax-orthogonal`    | 降级到 4 邻域，通常立刻能排满    |
| `relax-soft`          | 限定不再强制，改成「违反最少」   |
| `relax-min-conflicts` | 只求冲突最少，冲突标红交人工微调 |
| `add-rooms`           | 加一个考场                       |

---

## 5. CLI 全参数

```
exam-seat [--json] <命令> [选项]

命令：
  roster     --file <xlsx> [--sheet <名|下标>] [--absent <xlsx>] [--absent-sheet <名|下标>] [--out <file>]
  rooms      --spec "1-20:small,21-25:large,26:6x4"
  numbering  [--rows 6] [--cols 5] [--door right|left]
  template   [--out job.json]
  precheck   --job <file|->
  plan       --job <file|-> [--out-dir <dir>] [--single] [--seed N] [--relax M]
             [--adjacency king|orthogonal] [--force-king] [--time-limit ms] [--show N]
  validate   --job <file|-> --plan <file|->
```

- `--job -` / `--plan -` 从 **stdin** 读，不用落临时文件。
- `--json` 时 **stdout 只输出一个 JSON 对象**，所有日志走 stderr。
- `roster --absent <缺考名单.xlsx>` 应用缺考名单（见 §0.3），并打印命中 / 未匹配统计。
- `plan` 在名单带选科时自动走多场次；`--single` 强制单场。
- `validate` **单场与多场次都能校验**：多场次（`plan.json` 里含 `seatings`）走 `validateAll()`，
  逐 seating 重建子 job 重验并**独立复核**「限定是否真的满足」「同一考场同一时段只有一科」「座位唯一」，
  输出每套座位结论 + 汇总，`ok` → 退出码 `0`，否则 `3`。交付前跑一次。
- `--out-dir` 单场写出：`考场安排名单.xlsx`、`考场座位表.xlsx`、`plan.json`、`job.json`；
  **多场次写出：`按班级考场安排.xlsx`、`考场监考表.xlsx`、`plan.json`、`job.json`**（`job.json` 已剔除空置考场；结构性 error 时只写 `plan.json` + `job.json`，见 §3.4）。

退出码：

| 码  | 含义                                         |
| --- | -------------------------------------------- |
| 0   | 完美：零冲突，全部限定满足                   |
| 2   | 排出来了，但有冲突或限定没满足（`ok:false`） |
| 3   | 预检失败，根本没解；或 `validate` 未通过     |
| 1   | 用法错误或文件读写失败                       |

---

## 6. 端到端例子

单场（名单没有选科）：

```bash
# 1) 读名单
exam-seat --json roster --file 高三名单.xlsx > roster.json

# 2) 生成考场配置：20 个小考场 + 5 个大考场 + 1 个 6排×4列
exam-seat --json rooms --spec "1-20:small,21-25:large,26:6x4" > rooms.json

# 3) 手工拼 job.json（就是把上面两份塞进一个对象，再加 constraints）

# 4) 先预检
exam-seat precheck --job job.json

# 5) 正式排 + 导出
exam-seat plan --job job.json --out-dir out
```

多场次（名单带选科）：

```bash
# job 里每个学生带 combination / subjects，考场里给专用考场写 dedicatedSubjects
exam-seat precheck --job job.multi.json
exam-seat plan --job job.multi.json --out-dir out
# → out/按班级考场安排.xlsx + out/考场监考表.xlsx + out/plan.json + out/job.json（job.json 已剔除空置考场）

# 交付前独立校验多场次结果（限定满足 / 硬规则 / 座位唯一）
exam-seat validate --job job.multi.json --plan out/plan.json
```

用 stdio 免落盘：

```bash
cat job.json | exam-seat --json plan --job - | jq '.ok, .stats.conflicts'
```

可运行样例：`examples/job.sample.json`（36 人、四种组合、政治/地理共用一个专用考场）。
它带 4 条 `constraints`（首排 / 按科目与班级选择器 / 四角），多场次下这些限定会**真正生效**；
跑完记得用 `exam-seat validate --job … --plan out/plan.json` 复核。
