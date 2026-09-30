---
name: exam-seating
description: 排考场（编排考试座位）。把学生名单和老师的口头要求整理成 job.json，再用 exam-seat 命令排出「哪个学生坐第几考场多少号」；名单带选科时自动编排多场次。当用户提到排考场、考场安排、编排座位、分考场、考试座位表、蛇形编号、邻座不同班，或者给出一份考试名单要求生成考场安排时使用。
---

# 排考场

## 能做什么

把一批考生分到若干个考场，满足：

- **周围 8 个人不能同班**（单人独桌）。班级数少于 9 个时自动退化为「前后左右不能同班」。
- 老师可以点名要求某个学生：去哪个考场、坐第几排、坐第几列。
- 输出是**名单**（考场 + 座位号 + 学号 + 姓名 + 班级），**不是座位图**。
- 排不出来时，明确说清**为什么**、**怎么放宽**。

## 先确认命令怎么跑

在项目根目录下，用：

```bash
node packages/cli/bin/exam-seat.mjs <命令>
```

PATH 里已有 `exam-seat` 时可直接用；下文统一写 `exam-seat`。

## 三步工作流

### 第 1 步：把 Excel 名单读成 JSON

```bash
exam-seat --json roster --file 高三名单.xlsx > roster.json
```

输出里有 `students`、`classCount`、`headers`、`mapping`、`issues`。
**先看 `issues`**：重复学号之类的问题要先跟用户确认，别闷头往下排。

自动认列。如果认不出来会报错并告诉你表头长什么样，这时让用户说明哪列是学号/姓名/班级，或用网页版手动指定。
**名单带选科列时，读进每个学生的 `combination`（原文，如「物化政」）与 `subjects`（科目 id）。**

### 第 2 步：拼 job.json

考场配置可以用紧凑语法生成：

```bash
exam-seat --json rooms --spec "1-20:small,21-25:large,26:6x4"
```

`small` = 6 排 × 5 列 = 30 人；`large` = 7 排 × 6 列 = 42 人；`NxM` = **N 排 × M 列**。

然后把 `students`、`rooms` 和一个 `constraints` 数组拼成 job.json。完整字段表见 `reference.md`，可运行样例见 `examples/job.sample.json`（带选科，自动多场次）。

一个最小的 `constraints` 示例：

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

| 退出码 | 含义                           | 你要做什么                                |
| ------ | ------------------------------ | ----------------------------------------- |
| `0`    | 完美                           | 交付 `out/` 里的名单工作簿，附一句摘要    |
| `2`    | 排出来了，但有冲突或限定没满足 | **必须主动告诉用户**，列出没满足的部分    |
| `3`    | 预检失败，根本没解             | 把 `diagnostics` 里的原因和建议讲给用户听 |
| `1`    | 命令或文件错误                 | 修命令                                    |

`--json` 时 **stdout 只有一个 JSON 对象**，日志都在 stderr，可以放心 `| jq`。

每条 `diagnostic` 都有 `message`（中文人话，可以直接念给用户）、`evidence`（具体数字）、
`suggestions[]`（可选方案，每条带 `patch`：标准 JSON Patch，可直接打到 job.json 上）。
用户说「那你帮我改一下」时，就应用某条 `suggestion.patch` 再重跑。

## 名单带选科 ⇒ 自动多场次

有学生带选科（`combination` / `subjects`）时，`plan` 自动走多场次（`planAll`）；`--single` 才回单场。

- **交付两份 xlsx**：`按班级考场安排.xlsx`（给学生/班主任，「考场①②③」列，②③仅对要换考场的人有值）+ `考场监考表.xlsx`（给监考老师，每个「考场 × 同一批考生」一张 sheet：座位号 | 班级 | 姓名）。
- **换不换考场**：常规组合（物化生、政史地）**全程不换**；非常规组合（物化政、物化地）**中途换一次**（政治/地理去专用考场）。每人最多 3 个考场（`overRoomLimit` 正常为空）。
- **时段**：T1 语文 / T2 数学 / T3 外语 / T4 物理·历史 / T5 化学 / T6 生物·政治 / T7 地理（自动推导）。
- **专用考场**：考场配置里写 `dedicatedSubjects: ["politics"]`，可兼多科（如 `["politics","geography"]`，T6/T7 不冲突）；只收非常规组合中考了该科目的学生。
- **空置考场**：没安排到学生的考场会在 `emptyRooms` 里点名，CLI 打印「可取消的空置考场」——提醒用户可以取消，别自己改结果。
- **`options.groupPreference`**：`"sameCombination"`（默认）= 一个考场只放同一组合；`"fillRooms"` = 先填满当前考场。区别见 `reference.md`。

## 最容易搞错的坑位

1. **列号从靠门侧起算**。第 1 列 = 靠门列 = 小号列；最后一列 = 靠窗列 = 大号列。**不是**从左往右。
2. **不指定考场时行列只能用语义值**：`"first"` / `"last"` / `"door"` / `"window"`（小考场 5 列、大考场 6 列，写数字会指错）。绝对号（`"rows": [3]`）只在同时给了 `roomId` 时才可靠。
3. **考场限定是单选**。一个学生只能指定一个考场，不能给数组。
4. **同一学生多条限定取交集**，不是覆盖。交集为空会报 `RULE_INTERSECT_EMPTY`。
5. **班级数 < 9 会自动退化**为 4 邻域，结果的 `level` 会变成 `orthogonal`。**必须主动告诉用户**「对角允许同班了」，不能默默交付。想坚持 8 邻域就加 `--force-king`。
6. **带选科的名单不是单场**：要单场必须显式 `--single`，否则交付的是多场次那两份名单，还要说明谁要换考场。
7. **多场次不应用 `constraints`**：名单带选科时限定会被忽略，结果里必有 `CONSTRAINTS_IGNORED_MULTI`（warning）；需要限定就改用 `--single` 单场排，或先去掉限定。
8. **一个考场、一个时段、只能考一科**（硬规则，**不可降级**）：同一考场同时段的学生必须答同一张卷子。排不下宁可报考场不足，也不许把两门科目塞进同一个考场；违反时报 `ROOM_SUBJECT_CLASH`，该结果不得交付。
9. **专用考场不能靠猜**：必须用 `dedicatedSubjects` 在考场配置里手工指定，且只收非常规组合里考了该科目的学生；常规组合不会被塞进专用考场。
10. **空置考场要汇报**：`emptyRooms` 非空时提醒用户可取消。

## 交付要求

- **单场**（名单没有选科）：`--out-dir out` 写 `考场安排名单.xlsx`（名单 / 按班级 / 校验报告）+ `考场座位表.xlsx`（逐考场网格）+ `plan.json` + `job.json`。
- **多场次**：写 `按班级考场安排.xlsx` + `考场监考表.xlsx` + `plan.json` + `job.json`；**名单两份都要给**，用 `byStudent` 说清每人「时段 → 考场 + 座位」；`job.json` 已自动剔除空置考场。
- **结构性错误**（如 `ROOM_SUBJECT_CLASH` / `CAPACITY_INSUFFICIENT`）时只写 `plan.json` + `job.json`，**不写名单**——先修配置再交付；`SEARCH_FAILED` 这类降级结果照常导出，但要告知用户。
- 结果 `ok:false` 或 `level != "strict"` 时，**先说清哪里没满足**，再问用户是降级还是调整考场。
- **不要自己编造座位号**，一切以 CLI 输出的 `entries` 为准。
- 只想看看不想改文件：`--show 30` 或 `--json | jq`。

## 更多

- 完整字段表（含 v2 选科、专用考场、多场次输出结构 `planAll`）、诊断码全表、CLI 全参数：见同目录 `reference.md`
- 可运行样例：`examples/job.sample.json`（36 人、四种组合、政治/地理共用一个专用考场）

网页（`packages/web`）导出的 job.json 与这里完全兼容，可互相接力。
