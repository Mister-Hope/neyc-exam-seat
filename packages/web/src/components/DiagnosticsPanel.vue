<script setup lang="ts">
import { computed } from "vue";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Diagnostic, Suggestion } from "@exam-seat/core";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "@lucide/vue";

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

type Level = "success" | "warning" | "error" | "info";

const levelOf = (diagnostic: Diagnostic): Level => {
  if (diagnostic.code === "OK") return "success";
  if (diagnostic.severity === "error") return "error";
  if (diagnostic.severity === "warning") return "warning";
  return "info";
};

/** 用 Badge 的语义变体表达严重级别，不写原始色值。 */
const badgeVariant: Record<Level, "default" | "secondary" | "destructive" | "outline"> = {
  success: "default",
  warning: "secondary",
  error: "destructive",
  info: "outline",
};

const levelText: Record<Level, string> = {
  success: "通过",
  warning: "提醒",
  error: "错误",
  info: "信息",
};

const iconOf = (level: Level): unknown => {
  if (level === "success") return CircleCheckIcon;
  if (level === "warning") return TriangleAlertIcon;
  if (level === "error") return CircleAlertIcon;
  return InfoIcon;
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
  <div class="flex flex-col gap-2">
    <Empty v-if="items.length === 0">
      <EmptyHeader>
        <EmptyTitle class="text-muted-foreground text-sm">{{ emptyText }}</EmptyTitle>
      </EmptyHeader>
    </Empty>

    <Alert
      v-for="(diagnostic, index) in items"
      :key="`${diagnostic.code}-${index}`"
      :variant="levelOf(diagnostic) === 'error' ? 'destructive' : 'default'"
    >
      <component :is="iconOf(levelOf(diagnostic))" />
      <AlertTitle class="flex flex-wrap items-center gap-1.5">
        <Badge :variant="badgeVariant[levelOf(diagnostic)]">{{
          levelText[levelOf(diagnostic)]
        }}</Badge>
        <span class="font-mono text-[11px] opacity-75">{{ diagnostic.code }}</span>
        {{ diagnostic.message }}
      </AlertTitle>
      <AlertDescription v-if="showEvidence && diagnostic.evidence" class="font-mono break-all">
        {{ evidenceText(diagnostic) }}
      </AlertDescription>
      <div v-if="diagnostic.suggestions.length > 0" class="mt-1.5 flex flex-wrap gap-1.5">
        <TooltipProvider v-for="suggestion in diagnostic.suggestions" :key="suggestion.id">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="outline"
                size="sm"
                :disabled="busy"
                @click="emit('apply', suggestion)"
              >
                {{ suggestion.label }}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ suggestion.effect ?? "应用这条修改" }}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </Alert>
  </div>
</template>

<style scoped>
/* 诊断里的等宽 code 片段统一用 Tailwind 写在了模板上，这里只保留一处细调 */
:deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
