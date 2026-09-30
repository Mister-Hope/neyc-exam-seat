<script setup lang="ts">
import { computed } from "vue";

import type { Diagnostic, Suggestion } from "@exam-seat/core";

/** 诊断面板：直接把 core 给的 `message`（中文人话）显示出来， `suggestions[]` 渲染成一键按钮——每条建议都带可机器应用的 `patch`，点了就应用并重跑。 */
const props = withDefaults(
  defineProps<{
    diagnostics: Diagnostic[];
    /** 是否显示 evidence 原始证据（默认收起，点开可看） */
    showEvidence?: boolean;
    emptyText?: string;
    busy?: boolean;
  }>(),
  {
    showEvidence: false,
    emptyText: "没有诊断信息",
    busy: false,
  },
);

const emit = defineEmits<{
  (e: "apply", suggestion: Suggestion): void;
}>();

const alertType = (diagnostic: Diagnostic): "success" | "warning" | "error" | "info" => {
  if (diagnostic.code === "OK") return "success";
  if (diagnostic.severity === "error") return "error";
  if (diagnostic.severity === "warning") return "warning";
  return "info";
};

const items = computed(() => props.diagnostics);

function evidenceText(diagnostic: Diagnostic): string {
  const { evidence } = diagnostic;
  if (!evidence) return "";
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(evidence)) {
    compact[key] =
      Array.isArray(value) && value.length > 8
        ? [...value.slice(0, 8), `…共 ${value.length} 项`]
        : value;
  }
  return JSON.stringify(compact);
}
</script>

<template>
  <div class="diagnostics">
    <el-empty v-if="items.length === 0" :description="emptyText" :image-size="60" />
    <el-alert
      v-for="(diagnostic, index) in items"
      :key="`${diagnostic.code}-${index}`"
      :type="alertType(diagnostic)"
      :closable="false"
      show-icon
      class="diagnostics__item"
    >
      <template #title>
        <span class="diagnostics__code">{{ diagnostic.code }}</span>
        {{ diagnostic.message }}
      </template>
      <div v-if="showEvidence && diagnostic.evidence" class="diagnostics__evidence">
        <code>{{ evidenceText(diagnostic) }}</code>
      </div>
      <div v-if="diagnostic.suggestions.length > 0" class="diagnostics__actions">
        <el-tooltip
          v-for="suggestion in diagnostic.suggestions"
          :key="suggestion.id"
          :content="suggestion.effect ?? '应用这条修改'"
          placement="top"
        >
          <el-button size="small" :disabled="busy" @click="emit('apply', suggestion)">
            {{ suggestion.label }}
          </el-button>
        </el-tooltip>
      </div>
    </el-alert>
  </div>
</template>

<style scoped>
.diagnostics {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.diagnostics__item :deep(.el-alert__content) {
  width: 100%;
}
.diagnostics__code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  opacity: 0.75;
  margin-right: 6px;
}
.diagnostics__evidence {
  margin-top: 4px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  word-break: break-all;
}
.diagnostics__actions {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
