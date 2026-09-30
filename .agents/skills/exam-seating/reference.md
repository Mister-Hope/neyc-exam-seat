# exam-seat 参考手册

配套 `SKILL.md` 使用。这里放完整字段表、诊断码全表、CLI 全参数。

---

## 1. Job JSON 完整字段

### 顶层

| 字段          | 类型         | 必填   | 说明                                  |
| ------------- | ------------ | ------ | ------------------------------------- |
| `jobVersion`  | number       | 否     | 目前为 `2`                            |
| `meta`        | object       | 否     | `{ title, createdAt }`，只用于展示    |
| `options`     | object       | 否     | 见下表                                |
| `students`    | Student[]    | **是** | 全部学生                              |
| `rooms`       | RoomSpec[]   | **是** | 考场列表，顺序即「第1考场、第2考场…」 |
| `constraints` | Constraint[] | 否     | 限定规则                              |

### options

| 字段          | 默认       | 说明                                                                                         |
| ------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `seed`        | `20260930` | 随机种子。**同 seed 同输入必得完全相同的结果**                                               |
| `adjacency`   | `"king"`   | `"king"` = 8 邻域（含对角）；`"orthogonal"` = 前后左右                                       |
| `forceKing`   | `false`    | 班级数 < 9 时默认自动退化为 4 邻域；置 `true` 则坚持 8 邻域                                  |
| `relax`       | `"none"`   | `"none"` 限定为硬约束；`"softConstraints"` 限定降为高权重惩罚；`"minConflicts"` 只求冲突最少 |
| `timeLimitMs` | `10000`    | 求解时间上限                                                                                 |

### Student

| 字段            | 类型    | 说明                                                                  |
| --------------- | ------- | --------------------------------------------------------------------- |
| `id`            | string  | **必填**，学号，全局唯一                                              |
| `name`          | string  | 姓名                                                                  |
| `className`     | string  | **必填**，班级名。同名字符串视为同一个班                              |
| `gender`        | string  | 选填                                                                  |
| `included`      | boolean | `false` = 本次不参加考试（等价于网页上「排除缺考」）。缺省视为 `true` |
| `tags` / `meta` | —       | 选填，透传                                                            |

### RoomSpec

| 字段       | 类型                  | 说明                                                            |
| ---------- | --------------------- | --------------------------------------------------------------- |
| `id`       | string                | **必填**，唯一。约束里用它引用考场                              |
| `name`     | string                | 展示名，如「第3考场」。缺省用 `id`                              |
| `rows`     | number                | **必填**，排数。行号从**讲台**起算：第 1 排 = 首排              |
| `cols`     | number                | **必填**，列数。列号从**靠门侧**起算：第 1 列 = 靠门列          |
| `doorSide` | `"left"` \| `"right"` | 默认 `"right"`。只影响「靠门列/靠窗列」的解析和座位图的左右朝向 |
| `note`     | string                | 备注，例如监考老师                                              |

常用规格：

| 名称     | rows × cols | 容量 |
| -------- | ----------- | ---- |
| 小考场   | 6 × 5       | 30   |
| 大考场   | 7 × 6       | 42   |
| 自定义例 | 6 × 4       | 24   |

容量 = `rows × cols`。单个考场内，同一个班的人数上限是 `⌈rows/2⌉ × ⌈cols/2⌉`（8 邻域下）。

### Constraint

| 字段         | 类型     | 说明                         |
| ------------ | -------- | ---------------------------- |
| `id`         | string   | **必填**，唯一               |
| `note`       | string   | 备注，诊断信息里会用到       |
| `studentIds` | string[] | **必填**，这条规则管哪些学生 |
| `roomId`     | string   | **单选**。缺省 = 不限考场    |
| `rows`       | RowRef[] | 见下                         |
| `cols`       | ColRef[] | 见下                         |

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

---

## 2. 输出 plan.json

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

---

## 3. 诊断码全表

| 代码                            | 级别    | 含义                               | 给用户的说法 / 处理                                                                      |
| ------------------------------- | ------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `OK`                            | info    | 预检通过                           | 正常往下走                                                                               |
| `CAPACITY_INSUFFICIENT`         | error   | 座位总数 < 考生数                  | 「还差 N 个座位」，建议里会给出「小考场改大考场」「加考场」「少排 N 人」三种，各带 patch |
| `CLASS_LIMIT_EXCEEDED`          | error   | 某班人数超过所有考场的容纳上限     | 「这个班还差 N 个位置」，需要加考场或改大考场                                            |
| `CONSTRAINT_EMPTY_DOMAIN`       | error   | 某条限定在任何考场都匹配不到座位   | 检查行列是否写错                                                                         |
| `CONSTRAINT_INDEX_OUT_OF_RANGE` | error   | 绝对行列号在候选考场里都不存在     | 改用 `"window"` / `"last"` 语义值，或指定一个够大的考场                                  |
| `ABSOLUTE_ROWCOL_WITHOUT_ROOM`  | warning | 用了绝对号却没指定考场             | 会按每个考场各自的行列数分别解析，通常应该改成语义值                                     |
| `CONSTRAINT_OVERSATURATED`      | error   | 一条限定的可用座位数少于它管的人数 | 典型是「5 个人抢 4 个角」，把多出的人移走或分散到别的考场                                |
| `RULE_INTERSECT_EMPTY`          | error   | 同一学生的多条限定交集为空         | 通常是同时指定了两个不同考场，删掉其中一条                                               |
| `SEAT_CONFLICT`                 | error   | 两个人被钉到同一个座位             | 改掉其中一个                                                                             |
| `TOO_FEW_CLASSES`               | warning | 班级数 < 9，已自动退化到 4 邻域    | **不算错误**，但必须告诉用户「对角允许同班了」                                           |
| `ROOMS_OVERPROVISIONED`         | info    | 座位远多于考生，靠后的考场会空置   | 提示可减少考场数                                                                         |
| `SEARCH_FAILED`                 | error   | 预检通过但求解没做到零冲突         | 读 `evidence.bottleneck` 定位瓶颈，再决定降级还是调整考场                                |
| `STUDENT_DUPLICATE_ID`          | error   | 学号重复                           | 让用户先修名单                                                                           |
| `STUDENT_MISSING_CLASS`         | error   | 有学生没班级                       | 让用户先修名单                                                                           |
| `UNKNOWN_ROOM_ID`               | error   | 限定引用了不存在的考场             | 修正 `roomId`                                                                            |

### SEARCH_FAILED 的建议（suggestions）长这样

| suggestion.id         | 做什么                           |
| --------------------- | -------------------------------- |
| `relax-orthogonal`    | 降级到 4 邻域，通常立刻能排满    |
| `relax-soft`          | 限定不再强制，改成「违反最少」   |
| `relax-min-conflicts` | 只求冲突最少，冲突标红交人工微调 |
| `add-rooms`           | 加一个考场                       |

每条都带 `patch`（标准 JSON Patch，指向 job.json）。

---

## 4. CLI 全参数

```
exam-seat [--json] <命令> [选项]

命令：
  roster     --file <xlsx> [--sheet <名|下标>] [--out <file>]
  rooms      --spec "1-20:small,21-25:large,26:6x4"
  numbering  [--rows 6] [--cols 5] [--door right|left]
  template   [--out job.json]
  precheck   --job <file|->
  plan       --job <file|-> [--out-dir <dir>] [--seed N] [--relax M]
             [--adjacency king|orthogonal] [--force-king] [--time-limit ms] [--show N]
  validate   --job <file|-> --plan <file|->
```

- `--job -` / `--plan -` 从 **stdin** 读，不用落临时文件。
- `--json` 时 **stdout 只输出一个 JSON 对象**，所有日志走 stderr。
- `--out-dir` 写出：`考场安排名单.xlsx`（名单 / 按班级 / 校验报告三张表）、`考场座位表.xlsx`（逐考场网格，可贴门口）、`plan.json`、`job.json`。

退出码：

| 码  | 含义                                         |
| --- | -------------------------------------------- |
| 0   | 完美：零冲突，全部限定满足                   |
| 2   | 排出来了，但有冲突或限定没满足（`ok:false`） |
| 3   | 预检失败，根本没解；或 `validate` 未通过     |
| 1   | 用法错误或文件读写失败                       |

---

## 5. 端到端例子

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

用 stdio 免落盘：

```bash
cat job.json | exam-seat --json plan --job - | jq '.ok, .stats.conflicts'
```
