# 考场排布 · AI 客户端技能包（exam-seat agent bundle）

> 这个压缩包给「人 + 国产 AI 客户端（千问 / 豆包 / 扣子 / 元宝 等）」用：
> 解压后里面有一个**不依赖 Node.js 的可执行文件**（`bin/`）和一份**技能说明**（`skills/exam-seating/`）。
> 模型读懂说明、用户提供 Excel 名单，就能排出「谁坐第几考场多少号」并导出可直接打印的 Excel。

排考场不是「把名单均分」那么简单：真正的规则是 **每个学生周围 8 个座位不能有同班同学**（单人独桌；
班级数不足 9 个时自动退化为「前后左右不同班」），同时还要满足老师点名的各种限定（某人去某考场、
坐第几排第几列等）。`exam-seat` 用模拟退火求解，并用一个**独立实现的校验器**复核结果。

---

## 0. 包内有什么

```
exam-seat-agent-bundle/
├── README.md                     ← 你正在读的文件（给人 + 给 AI 客户端）
├── bin/
│   ├── exam-seat-macos-arm64     ← macOS（Apple 芯片 M1/M2/M3/M4…）可执行文件
│   └── exam-seat-windows-x64.exe ← Windows 64 位可执行文件
├── skills/exam-seating/
│   ├── SKILL.md                  ← 给模型看的技能说明（三步工作流 + 12 个坑位）
│   ├── reference.md              ← job.json 字段表、诊断码全表、输入契约
│   └── examples/job.sample.json  ← 一份完整的合成示例（36 人 / 五种组合）
└── examples/
    ├── job.sample.json           ← 同上（方便直接跑命令）
    └── make-roster.mjs           ← 造一份假名单 .xlsx（只在装了 Node 的机器上用）
```

**包里没有任何真实学生数据**：所有示例都是程序生成的合成名单。

---

## 1. 怎么把它当作「技能/知识」交给 AI 客户端

不同客户端入口不一样，思路一致——**把说明文档挂到模型的上下文里**：

| 客户端                  | 做法                                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 千问 / 通义             | 新建「智能体」或「知识库」→ 上传 `README.md` + `skills/exam-seating/SKILL.md` + `skills/exam-seating/reference.md` → 在系统提示里写：「用户要排考场时，按 `SKILL.md` 的三步工作流执行：先 `roster` 读名单，再拼 job.json，再 `plan`，按退出码判断结果。」 |
| 豆包                    | 新建「扣子/智能体」→ 知识库里上传同样三份文档；工具箱里加「本地命令/代码执行」能力（若客户端支持），把 `bin/` 下的可执行文件路径填进去。                                                                                                                  |
| 其它支持 MCP / 本地工具 | 让工具层封装一条命令：`<bin> plan --job job.json --out-dir out --json`，把 stdout 的 JSON 原样回给模型。                                                                                                                                                  |

要点：

1. **先让模型读 `SKILL.md`**，里面写清了「必须用退出码分支，不要猜 stdout」和 12 个最容易搞错的坑位。
2. 模型不需要联网：所有计算都在本机可执行文件里完成。
3. 名单文件由用户提供；**模型不要自己编造学生姓名或准考证号**。

---

## 2. 可执行文件怎么调

### macOS（Apple 芯片）

```bash
chmod +x bin/exam-seat-macos-arm64
./bin/exam-seat-macos-arm64 --help
```

第一次打开可能被 Gatekeeper 拦（「无法打开，因为 Apple 无法检查其是否包含恶意软件」），
因为**这个可执行文件没有做代码签名与公证**。解除方式（任选其一）：

- 终端里去掉隔离标记：`xattr -d com.apple.quarantine bin/exam-seat-macos-arm64`
- 或：系统设置 → 隐私与安全性 → 底部「仍要打开」；
- 或：右键点文件 → 打开 → 再确认一次。

### Windows 64 位

```powershell
bin\exam-seat-windows-x64.exe --help
```

若被 SmartScreen 拦（「Windows 已保护你的电脑」）：点「更多信息」→「仍要运行」。
没有代码签名证书，所以浏览器下载的包一定会带拦截提示，这是预期行为。

> 这两条限制只影响「第一次打开」；之后系统会记住你的选择。

---

## 3. 三步工作流（模型照这个顺序做）

```bash
# ① 把 Excel 名单读成 JSON（先看 issues 有没有问题行）
exam-seat --json roster --file 名单.xlsx > roster.json

# ② 生成考场配置（可选：让用户确认考场数量与大小）
exam-seat --json rooms --spec "1-20:small,21-25:large,26:6x4"
#   small = 7 排 × 5 列 = 35 座，large = 7 排 × 6 列 = 42 座，NxM = N 排 × M 列

# ③ 预检 → 求解 → 导出（--out-dir 里就是交付给老师的 Excel）
exam-seat precheck --job job.json
exam-seat plan --job job.json --out-dir out --json
```

全部命令（`exam-seat --help` 为准）：

| 命令        | 作用                       | 关键参数                                                                                                                                                                     |
| ----------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roster`    | 读 Excel 名单 → JSON       | `--file`（必填）、`--sheet`、`--absent`（另给缺考名单）、`--absent-sheet`、`--out`                                                                                           |
| `rooms`     | 按紧凑语法生成考场         | `--spec "1-20:small,26:6x4"`                                                                                                                                                 |
| `numbering` | 打印座位编号图             | `--rows`、`--cols`、`--door left\|right`、`--extra 2,4`                                                                                                                      |
| `template`  | 输出 job.json 模板         | `--out`                                                                                                                                                                      |
| `precheck`  | 只判断有没有解、为什么没解 | `--job`                                                                                                                                                                      |
| `plan`      | 正式排考场                 | `--job`、`--out-dir`、`--seed`、`--relax none\|softConstraints\|minConflicts`、`--adjacency king\|orthogonal`、`--force-king`、`--time-limit <ms>`、`--show <n>`、`--single` |
| `validate`  | 用独立校验器重验结果       | `--job`、`--plan`                                                                                                                                                            |

全局参数：`--json`（stdout 只有一个 JSON，日志走 stderr，可安全 `| jq`）、`--version`、`--help`。

### 退出码（一定要按这个分支，不要靠猜文本）

| 退出码 | 含义                                 | 模型该做什么                                               |
| ------ | ------------------------------------ | ---------------------------------------------------------- |
| `0`    | 完美（零冲突、限定全满足）           | 交付 `out/` 里的 Excel，并复述摘要                         |
| `2`    | 有冲突或有限定没满足（降级但仍可用） | **必须主动告诉用户哪里没满足**，再问是否接受               |
| `3`    | 预检失败 / 校验不通过（根本没解）    | 把 `diagnostics[].message` 的原因与 `suggestions` 讲给用户 |
| `1`    | 命令或文件错误                       | 修命令（路径、参数、表头识别）                             |

---

## 4. job.json 长什么样

最小可用：

```jsonc
{
  "jobVersion": 2,
  "meta": { "title": "2026 届高三一模" },
  "options": { "seed": 20260930, "adjacency": "king", "groupPreference": "sameCombination" },
  "students": [
    { "id": "2026010001", "name": "张三", "className": "高三(1)班" },
    {
      "id": "2026010002",
      "name": "李四",
      "className": "高三(2)班",
      "combination": "物化政",
      "subjects": ["physics", "chemistry", "politics"],
    },
  ],
  "rooms": [
    {
      "id": "R1",
      "name": "第一考场",
      "rows": 7,
      "cols": 5,
      "doorSide": "right",
      "location": "高二一班",
      "note": "张老师",
    },
  ],
  "constraints": [
    { "id": "C1", "note": "有作弊前科，坐首排", "studentIds": ["2026010001"], "rows": ["first"] },
  ],
}
```

字段全表（选科、专用 / 专属组合考场、加座、考场级放宽、借考、显式时段、多场次输出）见
`skills/exam-seating/reference.md`；一份能直接跑的完整示例见 `examples/job.sample.json`。

几个必须知道的约定：

- **列号从靠门侧起算**：第 1 列 = 靠门列，末列 = 靠窗列（不是从左往右）。
- **不指定考场时，行/列只能用语义值** `first` / `last` / `door` / `window`；写数字只在该条限定给了 `roomId` 时才可靠。
- **考场限定是单选，多条限定取交集**（不是覆盖）。
- **班级数 < 9 会自动退化为「前后左右不同班」**，必须告诉用户；想坚持 8 邻域加 `--force-king`。
- **名单里有人带选科 → 自动走多场次**（每个时段一套座位）；要单场加 `--single`。

---

## 5. `plan --out-dir` 会产出什么

**单场**（名单没有选科，或加了 `--single`）：

```
out/
├── 考场安排名单.xlsx      名单 / 按班级 / 校验报告 三张 sheet
├── 考场座位表.xlsx        逐考场座位网格（贴门口用）
├── plan.json             求解结果（entries 里是「谁坐哪」，以它为准）
└── job.json              这次求解用的输入快照
```

**多场次**（名单带选科）：

```
out/
├── 按班级考场安排.xlsx        总表 + 每班一张（含准考证号、主考场、单科考场与地点）
├── 按班级考场安排/<班级>.xlsx 每个班一个文件，可直接发班主任
├── 考场监考表.xlsx            每个考场一套座位一张
├── 考场监考表/<考场>.xlsx     每个考场一个文件，可直接发监考老师
├── plan.json
└── job.json
```

两份工作簿都是**按打印设计**的正式表：A4 横向、缩放到一页宽、冻结表头、每页重复前 3 行标题。
排不出来（结构性错误）时只写 `plan.json` + `job.json`，**不会**生成名单，别把空表当结果交付。

---

## 6. 给 AI 客户端的使用提醒

1. **先跑 `validate`**：`exam-seat validate --job job.json --plan out/plan.json`（校验器与求解器是分开实现的，这是刻意的）。
2. **不要编造座位号**：一切以 `plan.json` 的 `entries` / `byStudent` 为准。
3. **缺考别自己猜**：Excel 里「缺考」列写 `否 / 0 / N / no / false / 正常 / 参加 / 无 / -` 都不算缺席；另有名单就传 `--absent`，未匹配的行要让用户确认。
4. **隐私**：名单里有真实姓名与准考证号，只在本机处理，不要上传到聊天记录里；本包不含任何真实学生数据。
5. 想自己造测试数据（需要 Node.js）：`node examples/make-roster.mjs 假名单.xlsx 6 40`。

---

## 7. 常见问题

**Q：为什么 macOS / Windows 都要点「仍要打开」？**
A：包里的可执行文件没有代码签名证书，属于常见的分发未签名工具，见 §2 的解除方式。

**Q：`bin/` 里的文件可以直接双击吗？**
A：不建议。它是命令行工具，双击会一闪而过。请在终端 / PowerShell 里带参数运行。

**Q：能不能只跑网页版？**
A：可以，仓库的 `packages/web` 是同一套算法的网页版，桌面版外壳见 `packages/desktop`（本包不带）。

**Q：排不出来怎么办？**
A：看 `precheck` 的 `diagnostics[].suggestions`——里面会给出「加几个考场 / 把某个考场改大 / 哪些学生改坐别处」的具体建议，其中 `patch` 可以直接回写到 job.json 重跑。
