---
name: exam-seating
description: 排考场（编排考试座位）。把学生名单和老师的口头要求整理成 job.json，再用 exam-seat 排出「哪个学生坐第几考场多少号」；名单带选科时自动编排多场次，含缺考处理。当用户提到排考场、考场安排、编排座位、分考场、考试座位表、蛇形编号、邻座不同班，或给出一份考试名单要求生成考场安排时使用。
---

# 排考场

## 能做什么

把一批考生分到若干个考场：**周围 8 个人不能同班**（单人独桌；班级数 < 9 自动退化为「前后左右不同班」）；
老师可以点名要求某学生去哪个考场、坐第几排第几列；输出是**名单**（考场 + 座位号 + 学号 + 姓名 + 班级），**不是座位图**；
排不出来时说清**为什么**、**怎么放宽**。

## 先确认命令怎么跑

项目根目录下用 `node packages/cli/bin/exam-seat.mjs <命令>`；PATH 里已有 `exam-seat` 时可直接用。下文统一写 `exam-seat`。

## 三步工作流

### 第 1 步：名单读成 JSON

```bash
exam-seat --json roster --file 高三名单.xlsx > roster.json
exam-seat --json roster --file 全名单.xlsx --absent 缺考名单.xlsx > roster.json   # 单独的缺考名单
```

输出含 `students`、`classCount`、`headers`、`mapping`、`issues`。**先看 `issues`**：重复学号之类的问题先跟用户确认，别闷头往下排。

必填三列：**准考证号 / 姓名 / 班级**。表头识别很宽松——空格、全角、`_ - （）` 都忽略，`班 级`、`姓 名`、`考证号` 都认，`班主任` 不算班级列；拿不准就把 `headers` / `mapping` 给用户确认，别猜位置。名单带选科列时读进 `combination` 与 `subjects`；有「缺考」列时缺考者自动标成 `included:false`。

**读 Excel 用 `@exam-seat/io` 的 `readRoster` / `readAbsentKeys` / `applyAbsentKeys`。**

### 第 2 步：拼 job.json

考场配置用紧凑语法（`small` 6×5=30 人，`large` 7×6=42 人，`NxM` = N 排 × M 列）：

```bash
exam-seat --json rooms --spec "1-20:small,21-25:large,26:6x4"
```

拼 job 只需 `students` + `rooms`（+ `constraints`），`students` 取上一步输出。字段表见 `reference.md`；最小 `constraints` 示例：

```json
[
  { "id": "C1", "note": "坐首排", "studentIds": ["2026010001"], "rows": ["first"] },
  { "id": "C2", "note": "考政治的靠窗", "subjects": ["politics"], "cols": ["window"] }
]
```

### 第 3 步：预检 → 求解 → 读诊断

```bash
exam-seat precheck --job job.json          # 很快，先判有没有解
exam-seat plan --job job.json --out-dir out --json
```

**用退出码分支，不要靠猜 stdout：**

| 退出码 | 含义                           | 你要做什么                             |
| ------ | ------------------------------ | -------------------------------------- |
| `0`    | 完美                           | 交付 `out/` 里的名单工作簿，附一句摘要 |
| `2`    | 排出来了，但有冲突或限定没满足 | **必须主动告诉用户**，列出没满足的部分 |
| `3`    | 预检失败，根本没解             | 把 `diagnostics` 的原因和建议讲用户听  |
| `1`    | 命令或文件错误                 | 修命令                                 |

`--json` 时 stdout 只有一个 JSON，日志都在 stderr，可放心 `| jq`。

每条 `diagnostic` 都有 `message`（中文人话，可直接念给用户）、`evidence`（具体数字）、
`suggestions[]`（每条带 `patch`：JSON Patch，可直接打到 job.json 上）。用户说「那你帮我改一下」时，就应用某条 `patch` 再重跑。

## 名单带选科 ⇒ 自动多场次

有学生带选科（`combination` / `subjects`）时，`plan` 自动走多场次（`planAll`）；`--single` 才回单场。

- **交付两份 xlsx**：`按班级考场安排.xlsx`（给学生/班主任，「考场①②③」列，②③仅对要换考场的人有值）+ `考场监考表.xlsx`（给监考老师，每张 sheet = 一个「考场 × 同一批考生」：座位号 | 班级 | 姓名）。
- **换不换考场**：常规组合（物化生、政史地）**全程不换**；非常规组合（物化政、物化地）**中途换一次**（政治/地理去专用考场）。每人最多 3 个考场（`overRoomLimit` 正常为空）。
- **时段**：T1 语文 / T2 数学 / T3 外语 / T4 物理·历史 / T5 化学 / T6 生物·政治 / T7 地理（自动推导）。
- **专用考场**：写 `dedicatedSubjects: ["politics"]`，可兼多科（`["politics","geography"]`，T6/T7 不冲突）；只收非常规组合里考了该科目的学生。
- **空置考场**：没安排到学生的考场在 `emptyRooms` 里点名（CLI 打印「可取消的空置考场」）——提醒用户可取消。
- **`groupPreference`**：`"sameCombination"`（默认）一个考场只放同一组合；`"fillRooms"` 先填满当前考场。

## 最容易搞错的坑位

1. **列号从靠门侧起算**：第 1 列 = 靠门列，最后一列 = 靠窗列，**不是**从左往右。
2. **不指定考场时行列只能用语义值**：`"first"` / `"last"` / `"door"` / `"window"`（考场列数不同，写数字会指错）；绝对号只在给了 `roomId` 时可靠。
3. **考场限定是单选**，一个学生只能指定一个考场；多条限定取**交集**（不是覆盖），交集空报 `RULE_INTERSECT_EMPTY`。
4. **班级数 < 9 会自动退化**为 4 邻域，`level` 变成 `orthogonal`。**必须主动告诉用户**「对角允许同班了」；想坚持 8 邻域加 `--force-king`。
5. **缺考别自己猜**：只有一列「缺考」时按标记判（`否/0/N/no/false/正常/参加/无/-` 不缺席，其余算缺席）；另给一份缺考名单时用 `--absent`（有准考证号优先，否则要 姓名+班级；未匹配的行必须报出来）。
6. **带选科的名单不是单场**：要单场必须显式 `--single`，否则交付多场次两份名单，并说明谁要换考场。
7. **多场次照样吃 `constraints`**：按学生实际坐的考场解析行列，`roomId` 参与分房；满足不了报 error 且**不导出名单**，`unmetConstraints` 非空即 `ok=false`（不是警告），绝不悄悄放宽成「不限考场」。
8. **多场次结果要跑 `validate`**：多场次走 `validateAll()`，独立复核限定、硬规则、座位唯一，exit 0/3；`ok` 不等于已校验。
9. **一个考场、一个时段、只能考一科**（硬规则，**不可降级**）：同一考场同时段必须答同一张卷子；排不下宁报考场不足，也不许两门科目塞进同一考场，违反时报 `ROOM_SUBJECT_CLASH`。
10. **专用考场不能靠猜**：用 `dedicatedSubjects` 手工指定，只收非常规组合里考了该科目的学生。
11. **空置考场要汇报**：`emptyRooms` 非空时提醒用户可取消。

## 交付要求

- **单场**：`--out-dir out` 写 `考场安排名单.xlsx`（名单 / 按班级 / 校验报告）+ `考场座位表.xlsx` + `plan.json` + `job.json`。
- **多场次**：写 `按班级考场安排.xlsx` + `考场监考表.xlsx` + `plan.json` + `job.json`；**两份名单都要给**，用 `byStudent` 说清每人「时段 → 考场 + 座位」；交付前跑 `validate --plan out/plan.json`。
- **结构性错误**（`ROOM_SUBJECT_CLASH` / `CAPACITY_INSUFFICIENT` 等）只写 `plan.json` + `job.json`，**不写名单**，先修配置；`SEARCH_FAILED` 降级结果照常导出，但要告知用户。
- `ok:false` 或 `level != "strict"` 时**先说清哪里没满足**，再问用户是降级还是调整考场。
- **不要编造座位号**，一切以 CLI 输出的 `entries` 为准；只想看看用 `--show 30` 或 `--json | jq`。

## 更多

- 字段表（v2 选科、专用考场、`planAll` 输出）、**名单输入契约与缺考列判定**、诊断码全表、CLI 全参数：见同目录 `reference.md`
- 样例：`examples/job.sample.json`（36 人、四种组合、政治/地理共用一个专用考场）

网页（`packages/web`）导出的 job.json 与这里兼容，可互相接力。
