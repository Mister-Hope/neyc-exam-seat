<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { useExamJob } from "@/composables/useExamJob";
import { JSON_MIME, downloadText, pickFile, readFileText } from "@/lib/download";
import { jobFileName, parseJobText, serializeJob } from "@/lib/job";
import { clearExamSeatStorage } from "@/lib/persist";
import { STEPS } from "@/router";
import { useConstraintsStore } from "@/stores/constraints";
import { useOptionsStore } from "@/stores/options";
import { useResultStore } from "@/stores/result";
import { useRoomsStore } from "@/stores/rooms";
import { useRosterStore } from "@/stores/roster";

/** 应用外壳：步骤条 + job.json 双向互通（老师配一半导给 AI，AI 补完再导回来复核）。 */
const route = useRoute();
const router = useRouter();
const { job, loadJob } = useExamJob();

const roster = useRosterStore();
const rooms = useRoomsStore();
const constraints = useConstraintsStore();
const options = useOptionsStore();
const resultStore = useResultStore();

const pasteVisible = ref(false);
const pasteText = ref("");
const pasteError = ref("");

const active = computed(() => {
  const index = STEPS.findIndex((step) => step.path === route.path);
  return index === -1 ? 0 : index;
});

const currentStep = computed(() => STEPS[active.value]);

function applyImportedJob(text: string): void {
  const parsed = parseJobText(text);
  loadJob(parsed);
  resultStore.clear();
  ElMessage.success(
    `job.json 已导入：${parsed.students.length} 名学生 / ${parsed.rooms.length} 个考场`,
  );
}

async function importJobFile(): Promise<void> {
  const file = await pickFile(".json,application/json");
  if (!file) return;
  try {
    applyImportedJob(await readFileText(file));
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

function importFromPaste(): void {
  try {
    applyImportedJob(pasteText.value);
    pasteVisible.value = false;
    pasteText.value = "";
    pasteError.value = "";
  } catch (err) {
    pasteError.value = err instanceof Error ? err.message : String(err);
  }
}

function exportJob(): void {
  downloadText(serializeJob(job.value), jobFileName(job.value.meta?.title), JSON_MIME);
  ElMessage.success("已导出 job.json，可以交给 CLI / AI 接力");
}

async function clearAll(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      "会清空名单、考场、限定、结果，以及 localStorage 里的所有 exam-seat: 数据。确定吗？",
      "清空全部数据",
      { type: "warning", confirmButtonText: "清空", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  clearExamSeatStorage();
  roster.reset();
  rooms.reset();
  constraints.reset();
  options.reset();
  resultStore.clear();
  ElMessage.success("已清空");
  router.push("/import");
}
</script>

<template>
  <el-container class="app-shell">
    <el-header class="app-header">
      <div class="brand">
        <span class="brand__name">排考场</span>
        <span class="brand__sub">exam-seat</span>
      </div>
      <el-input
        v-model="options.title"
        class="title-input"
        placeholder="考试名称，例如 2026届高三一模"
      />
      <div class="header-actions">
        <el-button size="small" @click="importJobFile">导入 job.json</el-button>
        <el-button size="small" @click="pasteVisible = true">粘贴导入</el-button>
        <el-button size="small" type="primary" @click="exportJob">导出 job.json</el-button>
        <el-button size="small" type="danger" plain @click="clearAll">清空数据</el-button>
      </div>
    </el-header>

    <div class="summary-bar">
      <el-tag type="info">名单 {{ roster.total }} 人</el-tag>
      <el-tag type="info">实际参考 {{ roster.participants }} 人</el-tag>
      <el-tag type="info">考场 {{ rooms.rooms.length }} 个 / {{ rooms.totalSeats }} 座</el-tag>
      <el-tag type="info">限定 {{ constraints.count }} 条</el-tag>
      <el-tag :type="resultStore.hasResult ? 'success' : 'info'">
        {{ resultStore.hasResult ? "已有结果" : "未排考场" }}
      </el-tag>
      <span class="summary-bar__hint">{{ currentStep?.description }}</span>
    </div>

    <el-main>
      <el-steps class="step-bar" :active="active" align-center finish-status="success">
        <el-step
          v-for="step in STEPS"
          :key="step.path"
          :title="step.short"
          @click="router.push(step.path)"
        />
      </el-steps>

      <router-view />
    </el-main>

    <el-dialog v-model="pasteVisible" title="粘贴导入 job.json" width="640px">
      <el-input
        v-model="pasteText"
        type="textarea"
        :rows="14"
        placeholder="把 AI / CLI 生成的 job.json 粘到这里"
      />
      <el-alert
        v-if="pasteError"
        class="mt"
        type="error"
        :closable="false"
        show-icon
        :title="pasteError"
      />
      <template #footer>
        <el-button @click="pasteVisible = false">取消</el-button>
        <el-button
          type="primary"
          :disabled="pasteText.trim().length === 0"
          @click="importFromPaste"
        >
          导入
        </el-button>
      </template>
    </el-dialog>
  </el-container>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
}
.app-header {
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 1px solid var(--el-border-color);
  background: var(--el-bg-color);
  height: auto;
  padding: 10px 20px;
}
.brand {
  display: flex;
  align-items: baseline;
  gap: 6px;
  white-space: nowrap;
}
.brand__name {
  font-size: 18px;
  font-weight: 700;
}
.brand__sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.title-input {
  max-width: 360px;
}
.header-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.summary-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 20px;
  background: var(--el-fill-color-lighter);
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.summary-bar__hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.step-bar {
  cursor: pointer;
  margin-bottom: 8px;
}
:deep(.el-step) {
  cursor: pointer;
}
.mt {
  margin-top: 12px;
}
</style>
