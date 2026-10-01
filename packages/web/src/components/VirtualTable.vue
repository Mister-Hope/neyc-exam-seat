<script lang="ts">
/** 虚拟表格的列定义。`key` 同时是取值字段名，与 `cell-<key>` 插槽名。 */
export interface VirtualTableColumn {
  key: string;
  title: string;
  width: number;
  align?: "left" | "center" | "right";
  /** 传入 true 表示固定宽度（保留字段，虚拟表格里所有列都是固定宽度）。 */
  fixed?: boolean;
}
</script>

<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

/**
 * 通用虚拟滚动表格（自研，替代 `el-table-v2`）。
 *
 * 只渲染可视区域 + 前后 overscan 的行：1000 行名单在浏览器里也只有几十个 DOM 节点。 表头勾选框 = 全选当前
 * `rows`（**当前筛选结果的全量**），绝不会退化成「只选已渲染的那几行」。
 *
 * 关键约定与旧实现一致：
 *
 * - `rows` 是当前筛选结果的全量，虚拟化只影响渲染；
 * - 选择状态以 `rowKey` 算出的 id 为准，emit 完整的新 keys 数组；
 * - `cell-<key>` 插槽拿得到**原始 row**（不是内部包装对象）与全量下标。
 */
const props = withDefaults(
  defineProps<{
    /** 已过滤后的全量数据（不是渲染行）。 */
    rows: readonly unknown[];
    /** 行主键：id 必须稳定且唯一。 */
    rowKey: (row: unknown, index: number) => string;
    columns: readonly VirtualTableColumn[];
    /** 表格可视高度。 */
    height?: number;
    rowHeight?: number;
    selectable?: boolean;
    /** 受控的选中 keys（以 rowKey 为准）。 */
    selectedKeys?: readonly string[];
    stripe?: boolean;
    /** 行附加 class（例如给「已排除」的行置灰）。 */
    rowClass?: (row: unknown, index: number) => string;
  }>(),
  {
    height: 440,
    rowHeight: 44,
    selectable: false,
    selectedKeys: () => [],
    stripe: false,
  },
);

const emit = defineEmits<{
  "update:selected-keys": [keys: string[]];
  "row-click": [row: unknown];
}>();

/** 上下各多渲染几行，滚动时不会看到空白。 */
const OVERSCAN = 4;

const viewport = ref<HTMLElement | null>(null);
const scrollTop = ref(0);

/** 当前 rows 的主键列表：所有「全选 / 半选」判断都基于它，而不是渲染出来的行。 */
const rowKeys = computed(() => props.rows.map((row, index) => props.rowKey(row, index)));
const selectedKeySet = computed(() => new Set(props.selectedKeys));

const selectedCount = computed(
  () => rowKeys.value.filter((key) => selectedKeySet.value.has(key)).length,
);
const allSelected = computed(
  () => rowKeys.value.length > 0 && selectedCount.value === rowKeys.value.length,
);
const indeterminate = computed(
  () => selectedCount.value > 0 && selectedCount.value < rowKeys.value.length,
);

const tableColumns = computed(() =>
  props.selectable
    ? [
        { key: "__vt_selection__", title: "", width: 44, align: "center" as const },
        ...props.columns,
      ]
    : [...props.columns],
);

const gridTemplate = computed(() =>
  tableColumns.value.map((column) => `${column.width}px`).join(" "),
);
const totalWidth = computed(() =>
  tableColumns.value.reduce((sum, column) => sum + column.width, 0),
);
const bodyHeight = computed(() => props.rows.length * props.rowHeight);

const startIndex = computed(() =>
  Math.max(0, Math.floor(scrollTop.value / props.rowHeight) - OVERSCAN),
);
const endIndex = computed(() =>
  Math.min(
    props.rows.length,
    startIndex.value + Math.ceil(props.height / props.rowHeight) + OVERSCAN * 2 + 1,
  ),
);

const visibleRows = computed(() => {
  const out: { index: number; row: unknown; top: number }[] = [];
  for (let index = startIndex.value; index < endIndex.value; index += 1) {
    out.push({ index, row: props.rows[index], top: index * props.rowHeight });
  }
  return out;
});

function onScroll(event: Event): void {
  scrollTop.value = (event.currentTarget as HTMLElement).scrollTop;
}

/** 与 el-table 的 cleanSelection 语义一致：筛选条件变化后，选中集里已经不在当前 rows 的 key 要丢掉。 */
watch(
  () => props.rows,
  () => {
    scrollTop.value = 0;
    if (viewport.value) viewport.value.scrollTop = 0;
    if (!props.selectable) return;
    const alive = new Set(rowKeys.value);
    const next = props.selectedKeys.filter((key) => alive.has(key));
    if (next.length !== props.selectedKeys.length) emit("update:selected-keys", next);
  },
);

function toggleAll(checked: boolean): void {
  const keys = rowKeys.value;
  const current = new Set(keys);
  const rest = props.selectedKeys.filter((key) => !current.has(key));
  emit("update:selected-keys", checked ? [...rest, ...keys] : rest);
}

function toggleRow(index: number, checked: boolean): void {
  const key = props.rowKey(props.rows[index], index);
  const next = checked
    ? props.selectedKeys.includes(key)
      ? [...props.selectedKeys]
      : [...props.selectedKeys, key]
    : props.selectedKeys.filter((item) => item !== key);
  emit("update:selected-keys", next);
}

const isSelected = (index: number): boolean => selectedKeySet.value.has(rowKeys.value[index]!);

function alignClass(align: VirtualTableColumn["align"]): string {
  if (align === "center") return "justify-center text-center";
  if (align === "right") return "justify-end text-right";
  return "";
}

function rowClassOf(index: number): string {
  const classes: string[] = [];
  if (props.stripe && index % 2 === 1) classes.push("vt-stripe");
  const extra = props.rowClass?.(props.rows[index], index);
  if (extra) classes.push(extra);
  return classes.join(" ");
}

function cellText(index: number, key: string): string {
  const value = (props.rows[index] as Record<string, unknown> | undefined)?.[key];
  return value == null ? "" : String(value);
}

const selectionKey = "__vt_selection__";
</script>

<template>
  <div class="virtual-table w-full" data-testid="virtual-table">
    <template v-if="rows.length === 0">
      <div class="vt-empty text-muted-foreground rounded-lg border border-dashed p-6 text-center">
        <slot name="empty">暂无数据</slot>
      </div>
    </template>
    <template v-else>
      <div
        class="vt-header bg-muted/40 text-muted-foreground grid border-b text-xs font-medium"
        :style="{ gridTemplateColumns: gridTemplate, minWidth: `${totalWidth}px` }"
      >
        <div
          v-for="column in tableColumns"
          :key="`h-${column.key}`"
          :class="cn('flex items-center px-2 py-2', alignClass(column.align))"
        >
          <Checkbox
            v-if="column.key === selectionKey"
            class="vt-select-all"
            :model-value="indeterminate ? 'indeterminate' : allSelected"
            :aria-label="`全选当前 ${rows.length} 行`"
            @update:model-value="toggleAll($event === true)"
          />
          <span v-else>{{ column.title }}</span>
        </div>
      </div>

      <div
        ref="viewport"
        class="vt-viewport overflow-y-auto"
        data-testid="vt-viewport"
        :style="{ height: `${height}px` }"
        @scroll="onScroll"
      >
        <div class="relative" :style="{ height: `${bodyHeight}px`, minWidth: `${totalWidth}px` }">
          <div
            v-for="item in visibleRows"
            :key="rowKeys[item.index]"
            class="vt-row absolute inset-x-0 grid items-center border-b text-sm"
            :class="rowClassOf(item.index)"
            :data-row-index="item.index"
            :style="{
              top: `${item.top}px`,
              height: `${rowHeight}px`,
              gridTemplateColumns: gridTemplate,
            }"
            @click="emit('row-click', item.row)"
          >
            <div
              v-for="column in tableColumns"
              :key="`c-${column.key}`"
              :class="cn('flex min-w-0 items-center px-2', alignClass(column.align))"
            >
              <Checkbox
                v-if="column.key === selectionKey"
                class="vt-row-checkbox"
                :model-value="isSelected(item.index)"
                :aria-label="`选择第 ${item.index + 1} 行`"
                @update:model-value="toggleRow(item.index, $event === true)"
                @click.stop
              />
              <slot v-else :name="`cell-${column.key}`" :row="item.row" :index="item.index">
                <span class="truncate">{{ cellText(item.index, column.key) }}</span>
              </slot>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
