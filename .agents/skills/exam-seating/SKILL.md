---
name: exam-seating
description: 排考场（编排考试座位）。把学生名单和老师的口头要求整理成 job.json，再用 exam-seat 命令排出「哪个学生坐第几考场多少号」。当用户提到排考场、考场安排、编排座位、分考场、考试座位表、蛇形编号、邻座不同班，或者给出一份考试名单要求生成考场安排时使用。
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

如果 `exam-seat` 已经在 PATH 里（`exam-seat --help` 有输出），直接用 `exam-seat` 即可。下文统一写 `exam-seat`。

## 三步工作流

### 第 1 步：把 Excel 名单读成 JSON

```bash
exam-seat --json roster --file 高三名单.xlsx > roster.json
```

输出里有 `students`、`classCount`、`headers`、`mapping`、`issues`。
**先看 `issues`**：重复学号之类的问题要先跟用户确认，别闷头往下排。

自动认列。如果认不出来会报错并告诉你表头长什么样，这时让用户说明哪列是学号/姓名/班级，或用网页版手动指定。

### 第 2 步：拼 job.json

考场配置可以用紧凑语法生成：

```bash
exam-seat --json rooms --spec "1-20:small,21-25:large,26:6x4"
```

`small` = 6 排 × 5 列 = 30 人；`large` = 7 排 × 6 列 = 42 人；`NxM` = **N 排 × M 列**。

然后把 `students`、`rooms` 和一个 `constraints` 数组拼成 job.json。完整字段表见 `reference.md`，可运行样例见 `examples/job.sample.json`。

一个最小的 `constraints` 示例：

```json
[
  { "id": "C1", "note": "有作弊前科，坐首排", "studentIds": ["2026010001"], "rows": ["first"] },
  { "id": "C2", "note": "班主任监考的考场", "studentIds": ["2026020001"], "roomId": "R1" },
  { "id": "C3", "note": "靠门坐", "studentIds": ["2026030001"], "cols": ["door"] },
  {
    "id": "C4",
    "note": "四人四角",
    "studentIds": ["A", "B", "C", "D"],
    "roomId": "R5",
    "rows": ["first", "last"],
    "cols": ["door", "window"]
  }
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
| `0`    | 完美                           | 交付 `out/考场安排名单.xlsx`，附一句摘要  |
| `2`    | 排出来了，但有冲突或限定没满足 | **必须主动告诉用户**，列出没满足的部分    |
| `3`    | 预检失败，根本没解             | 把 `diagnostics` 里的原因和建议讲给用户听 |
| `1`    | 命令或文件错误                 | 修命令                                    |

`--json` 时 **stdout 只有一个 JSON 对象**，日志都在 stderr，可以放心 `| jq`。

每条 `diagnostic` 都有：

- `message`：中文人话，**可以直接念给用户**
- `evidence`：具体数字（差多少座位、哪几个学生）
- `suggestions[]`：可选方案，每条带 `patch`（标准 JSON Patch，可直接打到 job.json 上）

所以当用户说「那你帮我改一下」，就应用某条 `suggestion.patch`，再重跑。

## 最容易搞错的五件事

1. **列号从靠门侧起算**。第 1 列 = 靠门列 = 小号列；最后一列 = 靠窗列 = 大号列。**不是**从左往右。
2. **不指定考场时，行列只能用语义值**：`"first"` / `"last"` / `"door"` / `"window"`。因为小考场 5 列、大考场 6 列，「靠窗列」在两者里是不同的数字。绝对号（`"rows": [3]`）只在同时给了 `roomId` 时才可靠。
3. **考场限定是单选**。一个学生只能指定一个考场，不能给数组。
4. **同一学生多条限定取交集**，不是覆盖。交集为空会报 `RULE_INTERSECT_EMPTY`。
5. **班级数 < 9 会自动退化**为 4 邻域，结果的 `level` 会变成 `orthogonal`。**必须主动告诉用户**「对角允许同班了」，不能默默交付。想坚持 8 邻域就加 `--force-king`。

## 交付要求

- 一定导出 Excel：`--out-dir out` 会写 `考场安排名单.xlsx`（名单 / 按班级 / 校验报告三张表）和 `考场座位表.xlsx`（逐考场网格，方便贴门口）。
- 结果 `ok:false` 或 `level != "strict"` 时，**先说清哪里没满足**，再问用户是降级还是调整考场。
- **不要自己编造座位号**，一切以 CLI 输出的 `entries` 为准。
- 用户如果只想看看，不想改文件，用 `--show 30` 在终端看前 30 条，或 `--json | jq` 自己挑。

## 更多

- 完整字段表、诊断码全表、CLI 全参数：见同目录 `reference.md`
- 可运行样例：`examples/job.sample.json`

如果用户想自己在网页上点着配，项目里有 `packages/web`（`pnpm --filter @exam-seat/web dev`）；网页导出的 job.json 和这里完全兼容，可以互相接力。
