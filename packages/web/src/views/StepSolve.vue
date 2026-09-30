<script setup lang="ts">
import { ElMessage } from "element-plus";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";

import DiagnosticsPanel from "@/components/DiagnosticsPanel.vue";
import { useExamJob, usePrecheck } from "@/composables/useExamJob";
import { useSolver } from "@/composables/useSolver";
import { useOptionsStore } from "@/stores/options";
import { useResultStore } from "@/stores/result";
import type { Suggestion } from "@exam-seat/core";

/**
 * 第 ⑤ 步：排考场。
 *
 * 先跑 `precheckJob`：有致命问题就停在这一页，把 `diagnostic.message` 原样展示， 并把 `suggestions[].patch` 渲染成按钮（点了就应用到
 * job 再自动重跑预检）。 预检通过才进 Worker 求解，进度可取消；结果三态：完美 / 已降级 / 排不出来。
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

const progressStatus = computed(() => (progress.value >= 100 ? "success" : undefined));

const stageText = computed(() => {
  if (stage.value === "precheck") return "正在预检…";
  if (stage.value === "plan") return "正在模拟退火求解…";
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
  resultStore.setRunning();
  const snapshot = job.value;
  const result = await run(snapshot, snapshot.options);
  if (!result) {
    if (solverError.value) resultStore.setError(solverError.value);
    else resultStore.cancelRun();
    return;
  }
  resultStore.setResult(result, snapshot);
  if (result.ok && result.level === "strict") ElMessage.success("排好了：零冲突、全部限定满足");
  else if (result.ok) ElMessage.warning("排好了，但已降级，请看黄色提示");
  else ElMessage.error("没排出来，诊断里有原因和放宽建议");
}

function cancel(): void {
  cancelSolve();
  resultStore.cancelRun();
  ElMessage.info("已取消本次求解");
}

watch(
  () => options.options.seed,
  () => {
    if (resultStore.hasResult) resultStore.clear();
  },
);
</script>

<template>
  <div class="step-page">
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

      <el-space wrap>
        <el-button type="primary" size="large" :disabled="precheck.fatal || running" @click="start">
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
.options-form {
  max-width: 720px;
}
.progress-box {
  margin-top: 14px;
}
.step-actions {
  margin-top: 16px;
  display: flex;
  justify-content: space-between;
}
</style>
