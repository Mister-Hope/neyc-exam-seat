<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { toast } from "vue-sonner";

import DiagnosticsPanel from "@/components/DiagnosticsPanel.vue";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useExamJob, usePrecheck } from "@/composables/useExamJob";
import { useSolver } from "@/composables/useSolver";
import { useOptionsStore } from "@/stores/options";
import { useResultStore } from "@/stores/result";
import type { SolverMode } from "@/workers/solver-protocol";
import { subjectLabel } from "@exam-seat/core";
import type { Adjacency, RelaxMode, Suggestion } from "@exam-seat/core";
import { CircleAlertIcon, CircleCheckIcon, TriangleAlertIcon } from "@lucide/vue";

/**
 * 第 ⑤ 步：排考场。
 *
 * 先跑 `precheckJob`：有致命问题就停在这一页，把 `diagnostic.message` 原样展示， 并把 `suggestions[].patch` 渲染成按钮（点了就应用到
 * job 再自动重跑预检）。 预检通过才进 Worker 求解，进度可取消；单场结果四态：完美 / 主动放宽 / 已降级 / 排不出来。
 *
 * 名单里带选科时默认走多场次（`planAll`，场次编排）：展示时段划分、座位方案数、 需要换考场人数与空置考场，并支持按**求解结果**一键移除空置考场；
 * 没有选科字段的名单仍走单场，行为不变。
 */
const router = useRouter();
const { job, applySuggestion } = useExamJob();
const precheck = usePrecheck();
const options = useOptionsStore();
const resultStore = useResultStore();
const {
  running,
  stage,
  progress,
  elapsedMs,
  error: solverError,
  run,
  cancel: cancelSolve,
} = useSolver();

const patchError = ref("");
const removedNotice = ref("");

/** 名单里带选科（`combination` / `subjects`）时默认多场次；没有选科字段时强制单场，行为与之前一致。 */
const hasSubjectSelection = computed(() =>
  job.value.students.some(
    (student) => Boolean(student.combination) || (student.subjects?.length ?? 0) > 0,
  ),
);

/** 求解模式开关只在带选科时才有意义；默认多场次，允许老师退回单场对照。 */
const solveMode = ref<SolverMode>("all");
const runMode = computed<SolverMode>(() =>
  hasSubjectSelection.value ? solveMode.value : "single",
);

const fatalDiagnostics = computed(() =>
  precheck.value.diagnostics.filter((d) => d.severity === "error"),
);
const levelText = computed(() => {
  const level = resultStore.result?.level;
  if (level === "strict") return "严格（8 邻域 + 限定硬约束）";
  if (level === "roomRelaxed") return "roomRelaxed（本考场已放宽同班相邻，其余考场规则不变）";
  if (level === "orthogonal") return "orthogonal（只要求前后左右不同班，对角允许同班）";
  if (level === "softConstraints") return "softConstraints（限定降为高权重惩罚）";
  if (level === "minConflicts") return "minConflicts（允许同班相邻，最小化冲突）";
  return "";
});

const degradeReason = computed(() => {
  const level = resultStore.result?.level;
  if (level === "roomRelaxed") {
    return "你在第 ③ 步给这个考场开了「放宽同班相邻」：这是主动放宽，不是求解失败，监考表上会标注";
  }
  if (level === "orthogonal") {
    return precheck.value.downgraded
      ? "班级数不足 9 个，算法自动退化为「前后左右不同班」"
      : "按你的设置使用了 4 邻域";
  }
  if (level === "softConstraints" || level === "minConflicts")
    return "你在高级选项里主动选择了降级模式";
  return "";
});

/* ---------- 多场次摘要 ---------- */

const multiSlots = computed(() =>
  resultStore.slots.map((slot) => ({
    id: slot.id,
    name: slot.name,
    subjectLabels: slot.subjects.map((subject) => subjectLabel(subject)),
  })),
);

const seatingCount = computed(() => resultStore.seatings.length);
const roomsUsedCount = computed(
  () => new Set(resultStore.seatings.map((seating) => seating.roomId)).size,
);
const transferStudents = computed(() =>
  resultStore.scheduleByStudent
    .filter((student) => student.distinctRooms > 1)
    .map((student) => student.name || student.studentId),
);
const overRoomLimit = computed(() => resultStore.planAll?.overRoomLimit ?? []);

const stageText = computed(() => {
  if (stage.value === "precheck") return "正在预检…";
  if (stage.value === "plan") {
    return runMode.value === "all" ? "正在多场次求解…" : "正在模拟退火求解…";
  }
  return "";
});

function setNumberOption(setter: (value: number) => void, value: string | number): void {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) setter(parsed);
}

function applyDiagnosticSuggestion(suggestion: Suggestion): void {
  const outcome = applySuggestion(suggestion);
  if (outcome.ok) {
    patchError.value = "";
    // 配置变了，旧的求解结果不再对应这份 job，清掉避免误导
    if (resultStore.hasResult) resultStore.clear();
    toast.success(`已应用：${suggestion.label}，请重新排考场`);
  } else {
    patchError.value = outcome.error ?? "应用失败";
    toast.error(patchError.value);
  }
}

async function start(): Promise<void> {
  if (precheck.value.fatal) {
    toast.error("预检没通过，先按诊断改掉致命问题");
    return;
  }
  const snapshot = job.value;
  const mode = runMode.value;
  removedNotice.value = "";
  resultStore.setRunning();
  const outcome = await run(snapshot, snapshot.options, mode);
  if (!outcome) {
    if (solverError.value) {
      resultStore.setError(solverError.value);
      // 例如请求体无法克隆 / Worker 报错：必须让老师看到原因，而不是无声失败
      toast.error(solverError.value);
    } else {
      resultStore.cancelRun();
    }
    return;
  }

  if (outcome.mode === "all") {
    resultStore.setAllResult(outcome.result, snapshot);
    if (outcome.result.ok)
      toast.success("多场次排好了：常规组合全程不换考场，非常规组合中途换一次");
    else toast.error("多场次没排出来，诊断里有原因和放宽建议");
    return;
  }

  resultStore.setResult(outcome.result, snapshot);
  if (outcome.result.ok && outcome.result.level === "strict")
    toast.success("排好了：零冲突、全部限定满足");
  else if (outcome.result.ok && outcome.result.level === "roomRelaxed")
    toast.info("排好了：有考场放宽了同班相邻（主动放宽，监考表会标注）");
  else if (outcome.result.ok) toast.warning("排好了，但已降级，请看黄色提示");
  else toast.error("没排出来，诊断里有原因和放宽建议");
}

function cancel(): void {
  cancelSolve();
  resultStore.cancelRun();
  toast.info("已取消本次求解");
}

/** 一键移除空置考场：同时改 rooms store 与结果，之后必须重排。 */
function removeEmptyRooms(): void {
  const { removed } = resultStore.removeEmptyRooms();
  if (removed.length === 0) {
    toast.info("没有需要移除的考场");
    return;
  }
  removedNotice.value = `已移除空置考场：${removed.join("、")}。配置已变，建议重排`;
  toast.success(removedNotice.value);
}

watch(
  () => options.options.seed,
  () => {
    if (resultStore.hasResult) resultStore.clear();
  },
);

watch(runMode, (next, previous) => {
  if (next !== previous && resultStore.hasResult) resultStore.clear();
});
</script>

<template>
  <div class="mx-auto max-w-[1360px] flex flex-col gap-3">
    <Alert v-if="hasSubjectSelection">
      <CircleAlertIcon />
      <AlertTitle>
        名单里有选科：本页按场次编排（多场次）求解——常规组合（物化生 /
        政史地）全程不换考场，非常规组合（物化政 / 物化地）中途换一次
      </AlertTitle>
    </Alert>

    <Alert v-if="removedNotice" variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>{{ removedNotice }}</AlertTitle>
    </Alert>

    <Card>
      <CardHeader>
        <CardTitle>
          预检
          <span class="text-muted-foreground text-xs font-normal">
            ｜先判定可行性并给出「为什么排不出来 + 怎么放宽」，再决定是否求解
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent class="flex flex-col gap-2">
        <Alert v-if="precheck.fatal" variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>
            预检未通过：{{ fatalDiagnostics.length }} 个致命问题，修好后本页会自动重新预检
          </AlertTitle>
        </Alert>
        <Alert v-else>
          <CircleCheckIcon />
          <AlertTitle>预检通过，可以开始排考场</AlertTitle>
        </Alert>

        <Alert v-if="patchError" variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>{{ patchError }}</AlertTitle>
        </Alert>

        <DiagnosticsPanel
          :diagnostics="precheck.diagnostics"
          :busy="running"
          empty-text="没有诊断信息"
          @apply="applyDiagnosticSuggestion"
        />
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle
          >高级选项
          <span class="text-muted-foreground text-xs font-normal"
            >（写进 job.json 的 options）</span
          ></CardTitle
        >
      </CardHeader>
      <CardContent class="flex max-w-3xl flex-col gap-3">
        <div class="flex flex-wrap items-center gap-3">
          <Label class="w-32 shrink-0">随机种子</Label>
          <Input
            :model-value="options.options.seed"
            type="number"
            min="0"
            max="2147483647"
            class="h-8 w-44"
            aria-label="随机种子"
            @input="setNumberOption(options.setSeed, ($event.target as HTMLInputElement).value)"
          />
          <span class="text-muted-foreground text-xs">同输入同种子必得同结果，方便复现</span>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <Label class="w-32 shrink-0">相邻判定</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            :model-value="options.options.adjacency"
            @update:model-value="options.setAdjacency($event as Adjacency)"
          >
            <ToggleGroupItem value="king">8 邻域（含对角）</ToggleGroupItem>
            <ToggleGroupItem value="orthogonal">4 邻域（前后左右）</ToggleGroupItem>
          </ToggleGroup>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <Label class="w-32 shrink-0">班级少也坚持 8 邻域</Label>
          <Switch
            :model-value="options.options.forceKing"
            aria-label="班级少也坚持 8 邻域"
            @update:model-value="options.setForceKing($event === true)"
          />
          <span class="text-muted-foreground text-xs">班级数 &lt; 9 时默认自动退化为 4 邻域</span>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <Label class="w-32 shrink-0">降级模式</Label>
          <Select
            :model-value="options.options.relax"
            @update:model-value="options.setRelax($event as RelaxMode)"
          >
            <SelectTrigger class="h-8 w-80" size="sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="none">none：不降级（推荐）</SelectItem>
                <SelectItem value="softConstraints">softConstraints：限定改为违反最少</SelectItem>
                <SelectItem value="minConflicts">minConflicts：只求冲突最少</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <Label class="w-32 shrink-0">时间上限</Label>
          <Input
            :model-value="options.options.timeLimitMs"
            type="number"
            min="1000"
            max="60000"
            step="1000"
            class="h-8 w-44"
            aria-label="时间上限（毫秒）"
            @input="
              setNumberOption(options.setTimeLimit, ($event.target as HTMLInputElement).value)
            "
          />
          <span class="text-muted-foreground text-xs">毫秒，默认 10000</span>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>求解</CardTitle>
      </CardHeader>
      <CardContent class="flex flex-col gap-3">
        <div v-if="hasSubjectSelection" class="flex flex-wrap items-center gap-3">
          <Label class="w-24 shrink-0">求解模式</Label>
          <ToggleGroup
            v-model="solveMode"
            type="single"
            variant="outline"
            size="sm"
            data-testid="solve-mode"
            :disabled="running"
          >
            <ToggleGroupItem value="all">多场次（场次编排）</ToggleGroupItem>
            <ToggleGroupItem value="single">单场</ToggleGroupItem>
          </ToggleGroup>
          <span class="text-muted-foreground text-xs"
            >带选科的名单默认按多场次编排，可退回单场对照</span
          >
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <Button
            size="lg"
            data-testid="solve"
            :disabled="precheck.fatal || running"
            @click="start"
          >
            开始排考场
          </Button>
          <Button v-if="running" variant="destructive" @click="cancel">取消</Button>
          <Button v-if="resultStore.hasResult" variant="outline" @click="router.push('/result')">
            查看结果名单
          </Button>
        </div>

        <div v-if="running" class="flex flex-col gap-1">
          <Progress :model-value="Math.round(progress)" />
          <div class="text-muted-foreground text-xs">
            {{ stageText }} 已用 {{ (elapsedMs / 1000).toFixed(1) }} 秒（上限
            {{ (options.options.timeLimitMs / 1000).toFixed(0) }} 秒，到点会返回当前最好结果）
          </div>
        </div>

        <!-- 多场次结果：时段 → 考场 + 座位 -->
        <template v-if="resultStore.hasMultiResult && resultStore.planAll">
          <Alert v-if="resultStore.planAll.ok">
            <CircleCheckIcon />
            <AlertTitle>场次编排完成：常规组合全程不换考场，非常规组合中途换一次</AlertTitle>
            <AlertDescription data-testid="multi-summary">
              共 {{ resultStore.slots.length }} 个时段、{{ seatingCount }} 套座位方案，用到
              {{ roomsUsedCount }} 个考场。
            </AlertDescription>
          </Alert>
          <Alert v-else variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>多场次没排出来：下面是原因和放宽建议，点按钮可直接改配置重跑</AlertTitle>
          </Alert>

          <dl class="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div>
              <dt class="text-muted-foreground text-xs">时段</dt>
              <dd>{{ resultStore.slots.length }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">座位方案</dt>
              <dd>{{ seatingCount }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">用到考场</dt>
              <dd>{{ roomsUsedCount }} / {{ resultStore.job?.rooms.length ?? 0 }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">需要换考场</dt>
              <dd>{{ transferStudents.length }} 人</dd>
            </div>
          </dl>

          <div
            v-if="resultStore.relaxedRoomIds.length > 0 || resultStore.borrowings.length > 0"
            class="text-muted-foreground text-xs"
            data-testid="multi-relax-borrow"
          >
            放宽同班相邻：{{ resultStore.relaxedRoomNames.join("、") || "无" }}；借考
            {{ resultStore.borrowings.length }} 人次（详见结果页）
          </div>

          <div>
            <strong class="text-sm">时段划分</strong>
            <div class="mt-1 flex flex-wrap gap-2" data-testid="multi-slots">
              <Badge v-for="slot in multiSlots" :key="slot.id" variant="secondary">
                {{ slot.name }}：{{ slot.subjectLabels.join(" / ") || "—" }}
              </Badge>
            </div>
          </div>

          <div
            v-if="transferStudents.length > 0"
            class="text-muted-foreground text-xs"
            data-testid="multi-transfer"
          >
            需要换考场（{{ transferStudents.length }} 人）：{{
              transferStudents.slice(0, 10).join("、")
            }}{{ transferStudents.length > 10 ? " 等" : "" }}
          </div>

          <div data-testid="multi-empty-rooms" class="flex flex-wrap items-center gap-2 text-sm">
            <strong>空置考场</strong>
            <span
              v-if="resultStore.emptyRoomNames.length === 0"
              class="text-muted-foreground text-xs"
            >
              无
            </span>
            <template v-else>
              <span class="text-muted-foreground text-xs">
                {{ resultStore.emptyRoomNames.join("、") }}
              </span>
              <Button
                variant="outline"
                size="sm"
                :disabled="running"
                data-testid="remove-empty-rooms"
                @click="removeEmptyRooms"
              >
                一键移除空置考场
              </Button>
            </template>
          </div>

          <Alert v-if="overRoomLimit.length > 0" variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>
              有 {{ overRoomLimit.length }} 名学生用到的考场数超过上限（正常应为空，请检查考场分组）
            </AlertTitle>
          </Alert>

          <DiagnosticsPanel
            v-if="resultStore.planAll.diagnostics.length > 0"
            :diagnostics="resultStore.planAll.diagnostics"
            show-evidence
            @apply="applyDiagnosticSuggestion"
          />
        </template>

        <!-- 单场结果：行为与之前完全一致 -->
        <template v-if="resultStore.result">
          <!-- 四态：完美 / 主动放宽 / 已降级 / 排不出来 -->
          <Alert
            v-if="resultStore.result.ok && !resultStore.isDegraded && !resultStore.isRoomRelaxed"
          >
            <CircleCheckIcon />
            <AlertTitle>完美：零冲突，全部限定都满足</AlertTitle>
            <AlertDescription>
              {{ resultStore.result.stats.participants }} 名考生坐进
              {{ resultStore.result.stats.roomsUsed }} 个考场，用了
              {{ resultStore.result.stats.elapsedMs }} 毫秒。
            </AlertDescription>
          </Alert>

          <Alert v-else-if="resultStore.result.ok && !resultStore.isDegraded">
            <TriangleAlertIcon />
            <AlertTitle>已按考场放宽：level = {{ resultStore.result.level }}</AlertTitle>
            <AlertDescription>
              <div>{{ levelText }}</div>
              <div v-if="degradeReason">{{ degradeReason }}</div>
              <div>放宽只影响开了开关的考场；监考表表头会标注「本考场已放宽同班相邻」。</div>
            </AlertDescription>
          </Alert>

          <Alert v-else-if="resultStore.result.ok">
            <TriangleAlertIcon />
            <AlertTitle>已降级：level = {{ resultStore.result.level }}</AlertTitle>
            <AlertDescription>
              <div>{{ levelText }}</div>
              <div v-if="degradeReason">{{ degradeReason }}</div>
              <div>降级结果也会写进导出的「校验报告」表，请务必向相关老师说明。</div>
            </AlertDescription>
          </Alert>

          <Alert v-else variant="destructive">
            <CircleAlertIcon />
            <AlertTitle>没排出来：下面是原因和放宽建议，点按钮可直接改配置重跑</AlertTitle>
          </Alert>

          <dl v-if="resultStore.result.ok" class="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div>
              <dt class="text-muted-foreground text-xs">考生</dt>
              <dd>{{ resultStore.result.stats.participants }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">班级</dt>
              <dd>{{ resultStore.result.stats.classes }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">用到考场</dt>
              <dd>
                {{ resultStore.result.stats.roomsUsed }} / {{ resultStore.result.stats.rooms }}
              </dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">冲突</dt>
              <dd>{{ resultStore.result.stats.conflicts }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">未满足限定</dt>
              <dd>{{ resultStore.result.stats.unmetConstraints }}</dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">空置考场</dt>
              <dd>
                {{
                  resultStore.result.stats.emptyRooms
                    .map((id) => resultStore.job?.rooms.find((r) => r.id === id)?.name ?? id)
                    .join("、") || "无"
                }}
              </dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">实测耗时</dt>
              <dd>{{ resultStore.result.stats.elapsedMs }} ms</dd>
            </div>
            <div>
              <dt class="text-muted-foreground text-xs">种子</dt>
              <dd>{{ resultStore.result.stats.seed }}</dd>
            </div>
          </dl>

          <DiagnosticsPanel
            v-if="resultStore.result.diagnostics.length > 0"
            :diagnostics="resultStore.result.diagnostics"
            show-evidence
            @apply="applyDiagnosticSuggestion"
          />
        </template>
      </CardContent>
    </Card>

    <Separator />

    <div class="flex justify-between">
      <Button variant="outline" @click="router.push('/constraints')">上一步</Button>
      <Button :disabled="!resultStore.hasResult" @click="router.push('/result')">
        下一步：结果名单
      </Button>
    </div>
  </div>
</template>
