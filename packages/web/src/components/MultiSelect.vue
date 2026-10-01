<script setup lang="ts">
import { computed } from "vue";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ChevronDownIcon } from "@lucide/vue";

/**
 * 多选下拉（替代 `el-select multiple`）：按钮 + Popover 里的复选框列表。
 *
 * Shadcn-vue 的 Select 是单选（reka-ui 的 SelectRoot 不支持 multiple），班级 / 考场这种多选过滤统一用这个组件。
 */
const props = withDefaults(
  defineProps<{
    modelValue: readonly (string | number)[];
    options: readonly (string | number)[];
    placeholder?: string;
    /** 选项显示名（缺省直接用值）。 */
    optionLabels?: Record<string | number, string>;
    /** 触发按钮宽度 class，例如 `w-72`。 */
    triggerClass?: string;
  }>(),
  { placeholder: "全部", triggerClass: "w-64" },
);

const emit = defineEmits<{ "update:modelValue": [(string | number)[]] }>();

const label = computed(() =>
  props.modelValue.length === 0 ? props.placeholder : `已选 ${props.modelValue.length} 项`,
);

function optionText(option: string | number): string {
  return props.optionLabels?.[option] ?? String(option);
}

function toggle(value: string | number, checked: boolean): void {
  const next = checked
    ? props.modelValue.includes(value)
      ? [...props.modelValue]
      : [...props.modelValue, value]
    : props.modelValue.filter((item) => item !== value);
  emit("update:modelValue", next);
}
</script>

<template>
  <Popover>
    <PopoverTrigger as-child>
      <Button
        variant="outline"
        size="sm"
        :class="triggerClass"
        class="justify-between font-normal"
        data-testid="multi-select-trigger"
      >
        <span class="truncate">{{ label }}</span>
        <ChevronDownIcon data-icon="inline-end" class="opacity-60" />
      </Button>
    </PopoverTrigger>
    <PopoverContent class="w-64 p-1.5" align="start">
      <div class="flex max-h-72 flex-col gap-0.5 overflow-auto">
        <label
          v-for="item in options"
          :key="item"
          class="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm"
        >
          <Checkbox
            :model-value="modelValue.includes(item)"
            @update:model-value="toggle(item, $event === true)"
          />
          <span class="truncate">{{ optionText(item) }}</span>
        </label>
        <div v-if="options.length === 0" class="text-muted-foreground px-2 py-2 text-xs">
          暂无可选项
        </div>
      </div>
      <Button
        v-if="modelValue.length > 0"
        variant="ghost"
        size="sm"
        class="mt-1 w-full"
        @click="emit('update:modelValue', [])"
      >
        清空
      </Button>
    </PopoverContent>
  </Popover>
</template>
