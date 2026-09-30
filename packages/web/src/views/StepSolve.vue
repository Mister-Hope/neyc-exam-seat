<script setup lang="ts">
import { ElMessage } from "element-plus";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";

import DiagnosticsPanel from "@/components/DiagnosticsPanel.vue";
import { useExamJob, usePrecheck } from "@/composables/useExamJob";
import { useSolver } from "@/composables/useSolver";
import { useOptionsStore } from "@/stores/options";
import { useResultStore } from "@/stores/result";
import type { SolverMode } from "@/workers/solver-protocol";
import { subjectLabel } from "@exam-seat/core";
import type { Suggestion } from "@exam-seat/core";

/**
 * 第 ⑤ 步：排考场。
 *
 * 先跑 `precheckJob`：有致命问题就停在这一页，把 `diagnostic.message` 原样展示， 并把 `suggestions[].patch` 渲染成按钮（点了就应用到
 * job 再自动重跑预检）。 预检通过才进 Worker 求解，进度可取消；单场结果三态：完美 / 已降级 / 排不出来。
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
  if (level === "orthogonal") return "orthogonal（只要求前后左右不同班，对角允许同班）";
  if (level === "softConstraints") return "softConstraints（限定降为高权重惩罚）";
  if (level === "minConflicts") return "minConflicts（允许同班相邻，最小化冲突）";
  return "";
});

const degradeReason = computed(() => {
  const level = resultStore.result?.level;
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

const progressStatus = computed(() => (progress.value >= 100 ? "success" : undefined));

const stageText = computed(() => {
  if (stage.value === "precheck") return "正在预检…";
  if (stage.value === "plan") {
    return runMode.value === "all" ? "正在多场次求解…" : "正在模拟退火求解…";
  }
  return "";
});

function applyDiagnosticSuggestion(suggestion: Suggestion): void {
  const outcome = applySuggestion(suggestion);
  if (outcome.ok) {
    patchError.value = "";
    // 配置变了，旧的求解结果不再对应这份 job，清掉避免误导
    if (resultStore.hasResult) resultStore.clear();
    ElMessage.success(`已应用：${suggestion.label}，请重新排考场`);
  } else {
    patchError.value = outcome.error ?? "应用失败";
    ElMessage.error(patchError.value);
  }
}

async function start(): Promise<void> {
  if (precheck.value.fatal) {
    ElMessage.error("预检没通过，先按诊断改掉致命问题");
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
      ElMessage.error(solverError.value);
    } else {
      resultStore.cancelRun();
    }
    return;
  }

  if (outcome.mode === "all") {
    resultStore.setAllResult(outcome.result, snapshot);
    if (outcome.result.ok)
      ElMessage.success("多场次排好了：常规组合全程不换考场，非常规组合中途换一次");
    else ElMessage.error("多场次没排出来，诊断里有原因和放宽建议");
    return;
  }

  resultStore.setResult(outcome.result, snapshot);
  if (outcome.result.ok && outcome.result.level === "strict")
    ElMessage.success("排好了：零冲突、全部限定满足");
  else if (outcome.result.ok) ElMessage.warning("排好了，但已降级，请看黄色提示");
  else ElMessage.error("没排出来，诊断里有原因和放宽建议");
}

function cancel(): void {
  cancelSolve();
  resultStore.cancelRun();
  ElMessage.info("已取消本次求解");
}

/** 一键移除空置考场：同时改 rooms store 与结果，之后必须重排。 */
function removeEmptyRooms(): void {
  const { removed } = resultStore.removeEmptyRooms();
  if (removed.length === 0) {
    ElMessage.info("没有空置考场");
    return;
  }
  removedNotice.value = `已移除空置考场：${removed.join("、")}。配置已变，建议重排`;
  ElMessage.success(removedNotice.value);
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
  <div class="step-page">
    <el-alert
      v-if="hasSubjectSelection"
      class="mb"
      type="info"
      :closable="false"
      show-icon
      title="名单里有选科：本页按场次编排（多场次）求解——常规组合（物化生 / 政史地）全程不换考场，非常规组合（物化政 / 物化地）中途换一次"
    />

    <el-alert
      v-if="removedNotice"
      class="mb"
      type="warning"
      :closable="false"
      show-icon
      :title="removedNotice"
    />

    <el-card shadow="never">
      <template #header>
        <strong>预检</strong>
        <span class="muted">｜先判定可行性并给出「为什么排不出来 + 怎么放宽」，再决定是否求解</span>
      </template>

      <el-alert
        v-if="precheck.fatal"
        class="mb"
        type="error"
        :closable="false"
        show-icon
        :title="`预检未通过：${fatalDiagnostics.length} 个致命问题，修好后本页会自动重新预检`"
      />
      <el-alert
        v-else
        class="mb"
        type="success"
        :closable="false"
        show-icon
        title="预检通过，可以开始排考场"
      />

      <el-alert
        v-if="patchError"
        class="mb"
        type="warning"
        :closable="false"
        show-icon
        :title="patchError"
      />

      <DiagnosticsPanel
        :diagnostics="precheck.diagnostics"
        :busy="running"
        empty-text="没有诊断信息"
        @apply="applyDiagnosticSuggestion"
      />
    </el-card>

    <el-card class="mt" shadow="never">
      <template #header><strong>高级选项</strong>（写进 job.json 的 options）</template>
      <el-form label-width="140px" class="options-form">
        <el-form-item label="随机种子">
          <el-input-number v-model="options.options.seed" :min="0" :max="2147483647" />
          <span class="hint">同输入同种子必得同结果，方便复现</span>
        </el-form-item>
        <el-form-item label="相邻判定">
          <el-radio-group v-model="options.options.adjacency">
            <el-radio-button value="king">8 邻域（含对角）</el-radio-button>
            <el-radio-button value="orthogonal">4 邻域（前后左右）</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="班级少也坚持 8 邻域">
          <el-switch v-model="options.options.forceKing" />
          <span class="hint">班级数 &lt; 9 时默认自动退化为 4 邻域</span>
        </el-form-item>
        <el-form-item label="降级模式">
          <el-select v-model="options.options.relax" style="width: 320px">
            <el-option value="none" label="none：不降级（推荐）" />
            <el-option value="softConstraints" label="softConstraints：限定改为违反最少" />
            <el-option value="minConflicts" label="minConflicts：只求冲突最少" />
          </el-select>
        </el-form-item>
        <el-form-item label="时间上限">
          <el-input-number
            v-model="options.options.timeLimitMs"
            :min="1000"
            :max="60000"
            :step="1000"
          />
          <span class="hint">毫秒，默认 10000</span>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card class="mt" shadow="never">
      <template #header><strong>求解</strong></template>

      <el-form v-if="hasSubjectSelection" label-width="100px" class="options-form">
        <el-form-item label="求解模式">
          <el-radio-group v-model="solveMode" :disabled="running" data-testid="solve-mode">
            <el-radio-button value="all">多场次（场次编排）</el-radio-button>
            <el-radio-button value="single">单场</el-radio-button>
          </el-radio-group>
          <span class="hint">带选科的名单默认按多场次编排，可退回单场对照</span>
        </el-form-item>
      </el-form>

      <el-space wrap>
        <el-button
          type="primary"
          size="large"
          data-testid="solve"
          :disabled="precheck.fatal || running"
          @click="start"
        >
          开始排考场
        </el-button>
        <el-button v-if="running" type="danger" @click="cancel">取消</el-button>
        <el-button v-if="resultStore.hasResult" @click="router.push('/result')">
          查看结果名单
        </el-button>
      </el-space>

      <div v-if="running" class="progress-box">
        <el-progress :percentage="Math.round(progress)" :status="progressStatus" />
        <div class="hint">
          {{ stageText }} 已用 {{ (elapsedMs / 1000).toFixed(1) }} 秒（上限
          {{ (options.options.timeLimitMs / 1000).toFixed(0) }} 秒，到点会返回当前最好结果）
        </div>
      </div>

      <!-- 多场次结果：时段 → 考场 + 座位 -->
      <template v-if="resultStore.hasMultiResult && resultStore.planAll">
        <el-alert
          v-if="resultStore.planAll.ok"
          class="mt"
          type="success"
          :closable="false"
          show-icon
          title="场次编排完成：常规组合全程不换考场，非常规组合中途换一次"
        >
          <div data-testid="multi-summary">
            共 {{ resultStore.slots.length }} 个时段、{{ seatingCount }} 套座位方案，用到
            {{ roomsUsedCount }} 个考场。
          </div>
        </el-alert>
        <el-alert
          v-else
          class="mt"
          type="error"
          :closable="false"
          show-icon
          title="多场次没排出来：下面是原因和放宽建议，点按钮可直接改配置重跑"
        />

        <el-descriptions class="mt" :column="4" border>
          <el-descriptions-item label="时段">{{ resultStore.slots.length }}</el-descriptions-item>
          <el-descriptions-item label="座位方案">{{ seatingCount }}</el-descriptions-item>
          <el-descriptions-item label="用到考场">
            {{ roomsUsedCount }} / {{ resultStore.job?.rooms.length ?? 0 }}
          </el-descriptions-item>
          <el-descriptions-item label="需要换考场">
            {{ transferStudents.length }} 人
          </el-descriptions-item>
        </el-descriptions>

        <div class="mt">
          <strong>时段划分</strong>
          <div class="slot-list" data-testid="multi-slots">
            <el-tag v-for="slot in multiSlots" :key="slot.id" class="slot-tag" type="info">
              {{ slot.name }}：{{ slot.subjectLabels.join(" / ") || "—" }}
            </el-tag>
          </div>
        </div>

        <div v-if="transferStudents.length > 0" class="mt hint" data-testid="multi-transfer">
          需要换考场（{{ transferStudents.length }} 人）：{{
            transferStudents.slice(0, 10).join("、")
          }}{{ transferStudents.length > 10 ? " 等" : "" }}
        </div>

        <div class="mt" data-testid="multi-empty-rooms">
          <strong>空置考场</strong>
          <template v-if="resultStore.emptyRoomNames.length === 0">
            <span class="hint">无</span>
          </template>
          <template v-else>
            <span class="hint">{{ resultStore.emptyRoomNames.join("、") }}</span>
            <el-button
              class="ml"
              type="warning"
              plain
              :disabled="running"
              data-testid="remove-empty-rooms"
              @click="removeEmptyRooms"
            >
              一键移除空置考场
            </el-button>
          </template>
        </div>

        <el-alert
          v-if="overRoomLimit.length > 0"
          class="mt"
          type="error"
          :closable="false"
          show-icon
          :title="`有 ${overRoomLimit.length} 名学生用到的考场数超过上限（正常应为空，请检查考场分组）`"
        />

        <DiagnosticsPanel
          v-if="resultStore.planAll.diagnostics.length > 0"
          class="mt"
          :diagnostics="resultStore.planAll.diagnostics"
          show-evidence
          @apply="applyDiagnosticSuggestion"
        />
      </template>

      <!-- 单场结果：行为与之前完全一致 -->
      <template v-if="resultStore.result">
        <!-- 三态：完美 / 已降级 / 排不出来 -->
        <el-alert
          v-if="resultStore.result.ok && !resultStore.isDegraded"
          class="mt"
          type="success"
          :closable="false"
          show-icon
          title="完美：零冲突，全部限定都满足"
        >
          <div>
            {{ resultStore.result.stats.participants }} 名考生坐进
            {{ resultStore.result.stats.roomsUsed }} 个考场，用了
            {{ resultStore.result.stats.elapsedMs }} 毫秒。
          </div>
        </el-alert>

        <el-alert
          v-else-if="resultStore.result.ok"
          class="mt"
          type="warning"
          :closable="false"
          show-icon
          :title="`已降级：level = ${resultStore.result.level}`"
        >
          <div>{{ levelText }}</div>
          <div v-if="degradeReason">{{ degradeReason }}</div>
          <div>降级结果也会写进导出的「校验报告」表，请务必向相关老师说明。</div>
        </el-alert>

        <el-alert
          v-else
          class="mt"
          type="error"
          :closable="false"
          show-icon
          title="没排出来：下面是原因和放宽建议，点按钮可直接改配置重跑"
        />

        <el-descriptions v-if="resultStore.result.ok" class="mt" :column="4" border>
          <el-descriptions-item label="考生">{{
            resultStore.result.stats.participants
          }}</el-descriptions-item>
          <el-descriptions-item label="班级">{{
            resultStore.result.stats.classes
          }}</el-descriptions-item>
          <el-descriptions-item label="用到考场">
            {{ resultStore.result.stats.roomsUsed }} / {{ resultStore.result.stats.rooms }}
          </el-descriptions-item>
          <el-descriptions-item label="冲突">{{
            resultStore.result.stats.conflicts
          }}</el-descriptions-item>
          <el-descriptions-item label="未满足限定">
            {{ resultStore.result.stats.unmetConstraints }}
          </el-descriptions-item>
          <el-descriptions-item label="空置考场">
            {{
              resultStore.result.stats.emptyRooms
                .map((id) => resultStore.job?.rooms.find((r) => r.id === id)?.name ?? id)
                .join("、") || "无"
            }}
          </el-descriptions-item>
          <el-descriptions-item label="实测耗时">
            {{ resultStore.result.stats.elapsedMs }} ms
          </el-descriptions-item>
          <el-descriptions-item label="种子">{{
            resultStore.result.stats.seed
          }}</el-descriptions-item>
        </el-descriptions>

        <DiagnosticsPanel
          v-if="resultStore.result.diagnostics.length > 0"
          class="mt"
          :diagnostics="resultStore.result.diagnostics"
          show-evidence
          @apply="applyDiagnosticSuggestion"
        />
      </template>
    </el-card>

    <div class="step-actions">
      <el-button @click="router.push('/constraints')">上一步</el-button>
      <el-button type="primary" :disabled="!resultStore.hasResult" @click="router.push('/result')">
        下一步：结果名单
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.mb {
  margin-bottom: 10px;
}
.mt {
  margin-top: 12px;
}
.muted {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-left: 8px;
  line-height: 1.6;
}
.ml {
  margin-left: 8px;
}
.options-form {
  max-width: 720px;
}
.progress-box {
  margin-top: 14px;
}
.slot-list {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.slot-tag {
  white-space: normal;
  height: auto;
  padding: 4px 8px;
}
.step-actions {
  margin-top: 16px;
  display: flex;
  justify-content: space-between;
}
</style>
