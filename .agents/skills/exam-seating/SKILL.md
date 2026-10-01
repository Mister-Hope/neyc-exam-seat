---
name: exam-seating
description: 排考场（编排考试座位）。把学生名单和老师的口头要求整理成 job.json，再用 exam-seat 排出「哪个学生坐第几考场多少号」；名单带选科时自动编排多场次，支持考场级放宽、借考、加座与显式时段。当用户提到排考场、考场安排、编排座位、分考场、考试座位表、蛇形编号、邻座不同班，或给出一份考试名单要求生成考场安排时使用。
---

# 排考场

把考生分到若干考场：**周围 8 人不能同班**（单人独桌；班级数 < 9 自动退化为 4 邻域）；老师可点名要某生去哪个考场、坐第几排第几列。输出是**名单**（考场 + 座位号 + 学号 + 姓名 + 班级），**不是座位图**；排不出来要说清原因与放宽办法。

命令在项目根目录跑 `node packages/cli/bin/exam-seat.mjs <命令>`，下文写 `exam-seat`。

## 三步工作流

**① 名单读成 JSON**：`exam-seat --json roster --file 名单.xlsx > roster.json`（另给缺考名单加 `--absent 缺考.xlsx`）。
输出含 `students` / `classCount` / `headers` / `mapping` / `issues`；**先看 `issues`**。必填三列 **准考证号 / 姓名 / 班级**，表头识别宽松（空格、全角忽略；`班主任` 不算班级列），拿不准把 `headers` / `mapping` 给用户确认。带选科列时读进 `combination` / `subjects`；有「缺考」列时缺考者自动 `included:false`。读 Excel 用 `@exam-seat/io` 的 `readRoster` / `readAbsentKeys` / `applyAbsentKeys`。

**② 拼 job.json**：`exam-seat --json rooms --spec "1-20:small,21-25:large,26:6x4"`（`large` 7×6=42、`NxM` = N 排×M 列；`small` 见坑位 12）。拼 job 只需 `students` + `rooms`（+ `constraints`），字段表见 `reference.md`。**改过源码要先 `pnpm build` 再跑 CLI**（`bin/exam-seat.mjs` 走 `dist/`）。

**③ 预检 → 求解**：`exam-seat precheck --job job.json` 先判有没有解，再 `plan --job job.json --out-dir out --json`。

**用退出码分支，别猜 stdout：**

| 退出码 | 含义               | 你要做什么                      |
| ------ | ------------------ | ------------------------------- |
| `0`    | 完美               | 交付 `out/` 的名单工作簿 + 摘要 |
| `2`    | 有冲突或限定没满足 | **必须主动告诉用户**哪里没满足  |
| `3`    | 预检失败，根本没解 | 把 `diagnostics` 的原因讲给用户 |
| `1`    | 命令或文件错误     | 修命令                          |

`--json` 时 stdout 只有一个 JSON，日志在 stderr，可放心 `| jq`。每条 `diagnostic` 都有 `message`（中文人话）、`evidence`（数字）、`suggestions[]`（带 `patch`，可直接打到 job.json 重跑）。

## 名单带选科 ⇒ 自动多场次

有学生带选科（`combination` / `subjects`）时 `plan` 自动走多场次（`planAll`）；`--single` 才回单场。

- **交付两份 xlsx**：`按班级考场安排.xlsx`（每班一张 sheet + 总表，列含 `主考场|主考场地点|单科考场N|单科考场N地点`）+ `考场监考表.xlsx`（每套座位一张）。**监考表备注只写 `不考：X`/`只考：X`，不带时段**。
- **换考场**：常规组合全程不换；非常规组合中途换一次；每人最多 3 个。
- **时段**：自动推导 T1 语文 / T2 数学 / T3 外语 / T4 物理·历史 / T5 化学 / T6 生物·政治 / T7 地理；也可 `slots` 写死。
- **专用考场**：`dedicatedSubjects: ["politics"]` 可兼多科，只收非常规组合里考了该科的学生；空置考场见 `emptyRooms`。
- **专属组合考场**：想把某组合**整批**集中到一个考场（如政史地老文科考场），考场写 `"combination": "史地政"`——等价于限定里钉过去（连座位号一致）；可多间钉同一组合。单场下被忽略并给警告（仍 ok）。
- **`groupPreference`**：`"sameCombination"`（默认）一个考场只放同一组合；`"fillRooms"` 先填满考场。

## 考场级放宽 / 借考 / 加座 / 显式时段

都是考场级 / 学生级开关，互不影响；**每次放宽都留痕**（`relaxedRooms` / `borrowings`）。

```jsonc
"rooms": [{ "id": "R17", "rows": 7, "cols": 5,
  "relaxSameClass": true,       // 本考场放开同班相邻；数字 = 本考场同班上限
  "extraFrontSeats": [2, 4] }], // 讲台侧第 2、4 列各加 1 座 → 37 座
"students": [{ "subjects": ["history", "biology", "politics"],
  "subjectRoom": { "biology": "R18" } }],              // 生物去 R18 借考
"options": { "slots": [{ "id": "T1", "subjects": ["chinese"] }] }  // 给了就不再自动推导
```

- **放宽**：`relaxSameClass` 只对本考场；报 `ROOM_SAME_CLASS_RELAXED`（warning），`level` 变 `roomRelaxed`。
- **借考**：`subjectRoom` 让某生某科换到指定考场坐一个空位，**不产生第二张卷子**（目标考场该时段只能开考这一科，否则 `SUBJECT_ROOM_CLASH`）。
- **加座**：`extraFrontSeats` 是讲台侧**业务列号**，容量 = `rows × cols + 加座数`；加座行号为 0，**不能被限定点名**（看图：`numbering --rows 7 --cols 5 --extra 2,4`）。
- **显式时段**：`forbiddenSameSlot` 只补「必须分开」的科目对；自动推导塌陷时用 `slots`。

## 最容易搞错的坑位

1. **列号从靠门侧起算**：第 1 列 = 靠门列，末列 = 靠窗列，**不是**从左往右。
2. **不指定考场时行列只能用语义值**：`first`/`last`/`door`/`window`；写数字会在大小考场指错，绝对号只在给了 `roomId` 时可靠。
3. **考场限定是单选**；多条限定取**交集**（不是覆盖），交集空报 `RULE_INTERSECT_EMPTY`。
4. **班级数 < 9 会自动退化**为 4 邻域（`level` = `orthogonal`），**必须告诉用户**「对角允许同班了」；想坚持 8 邻域加 `--force-king`。
5. **缺考别自己猜**：「缺考」列里 `否/0/N/no/false/正常/参加/无/-` 不算缺席；另给缺考名单用 `--absent`，未匹配的行必须报出来。
6. **带选科的名单不是单场**，要单场必须 `--single`。
7. **多场次照样吃 `constraints`**：`roomId` 参与分房；满足不了报 error 且**不导出名单**。
8. **多场次结果要跑 `validate`**：走 `validateAll()` 独立复核限定、硬规则、座位唯一，exit 0/3。
9. **一个考场、一个时段、只能考一科**（硬规则**不可降级**）：违反报 `ROOM_SUBJECT_CLASH`，排不下宁报考场不足。
10. **借考不产生第二张卷子**；`relaxSameClass` 只对本考场；**加座不加行号**；**时段塌陷用 `options.slots`**。
11. **交付表已按打印设计**：A4 横向 + 宽压一页 + 重复表头，列宽自动收缩；别自己再加列。
12. **`small` 已统一为 7×5=35 座**（网页/CLI/`template` 一致）；`large`=7×6=42。⚠️ 既有脚本 `small` 比过去 **+5 座**，要 30 座写 `6x5`。

## 交付要求

- **单场**：`--out-dir out` 写 `考场安排名单.xlsx`（名单/按班级/校验报告）+ `考场座位表.xlsx` + `plan.json` + `job.json`。
- **多场次**：写 `按班级考场安排.xlsx` + `考场监考表.xlsx` + `plan.json` + `job.json`，**外加两个子目录** `按班级考场安排/<班级>.xlsx` 与 `考场监考表/<sheet 名>.xlsx`。两份都是**可打印正式表**（合并大标题、A4 横向、重复前 3 行、正文居中；姓名默认不截断，超 A4 才截 5 字）；用 `byStudent` 说清每人「时段 → 考场 + 座位」，交付前跑 `validate --plan out/plan.json`。
- **结构性错误**（`ROOM_SUBJECT_CLASH` / `CAPACITY_INSUFFICIENT` / `SUBJECT_ROOM_*` / `SLOTS_CONFLICT`）只写 `plan.json` + `job.json`，不写名单；`SEARCH_FAILED` 降级照常导出但要告知。
- `ok:false` 或 `level != "strict"` 时**先说清哪里没满足**，再问用户降级还是调整考场；**不要编造座位号**，以 `entries` 为准。

## 更多

字段表（选科、专用/专属考场、加座、放宽、借考、`planAll` 输出）、名单输入契约、诊断码全表、CLI 参数见 `reference.md`。
