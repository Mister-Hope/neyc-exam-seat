<script setup lang="ts">
import { computed } from "vue";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Diagnostic, Suggestion } from "@exam-seat/core";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "@lucide/vue";

/** 诊断面板：只给人话（core 的 `message` 原样展示），不显示内部代码名与原始数据； `suggestions[]` 渲染成一键按钮，点了就应用并重排。 */
const props = withDefaults(
  defineProps<{
    diagnostics: Diagnostic[];
    emptyText?: string;
    busy?: boolean;
  }>(),
  {
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

/** 用 Badge 的语义变体 + 中文级别名表达严重程度。 */
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
      <AlertTitle class="flex flex-wrap items-baseline gap-1.5">
        <Badge :variant="badgeVariant[levelOf(diagnostic)]">{{
          levelText[levelOf(diagnostic)]
        }}</Badge>
        <span>{{ diagnostic.message }}</span>
      </AlertTitle>
      <AlertDescription
        v-if="diagnostic.suggestions.length > 0"
        class="mt-1.5 flex flex-wrap gap-1.5"
      >
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
      </AlertDescription>
    </Alert>
  </div>
</template>
