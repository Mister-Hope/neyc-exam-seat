<script lang="ts">
/** 虚拟表格的列定义。`key` 同时是取值字段名，与 `cell-<key>` 插槽名。 */
export interface VirtualTableColumn {
  key: string;
  title: string;
  width: number;
  align?: "left" | "center" | "right";
  /** 传入 true 表示固定在左侧（等价 el-table 的 fixed）。 */
  fixed?: boolean;
}

/** 选择列的内部 key，业务列不应使用这个名字。 */
const SELECTION_KEY = "__vt_selection__";
/** 写进 TableV2 data 的内部主键字段：TableV2 的 rowKey 只接受字段名，不接受函数。 */
const ROW_KEY_FIELD = "__vtKey";
</script>

<script setup lang="ts">
import { ElAutoResizer, ElCheckbox, ElEmpty, ElTableV2 } from "element-plus";
import { computed, watch } from "vue";

/**
 * 通用虚拟滚动表格（el-table-v2 + el-auto-resizer）。
 *
 * 关键约定：`rows` 是**当前筛选结果的全量**，虚拟化只影响渲染。 表头勾选框 = 全选当前 `rows`，绝不会退化成「只选已渲染的那十几行」。 选择状态以 `rowKey` 算出的
 * id 为准，emit 的是完整的新 keys 数组。
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

// 与 el-table 的 cleanSelection 语义一致：筛选条件变化后，选中集里已经不在当前 rows 的 key 要丢掉。
watch(
  () => props.rows,
  () => {
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

/** TableV2 的 data 只用来算主键与行数；真正给插槽的永远是原始的 `props.rows[index]`。 */
const tableData = computed(() =>
  props.rows.map((row, index) => ({ [ROW_KEY_FIELD]: props.rowKey(row, index) })),
);

const tableColumns = computed(() => [
  ...(props.selectable
    ? [{ key: SELECTION_KEY, title: "", width: 44, align: "center" as const, fixed: true as const }]
    : []),
  ...props.columns.map((column) => ({
    key: column.key,
    title: column.title,
    width: column.width,
    align: column.align,
    fixed: column.fixed ? (true as const) : undefined,
  })),
]);

/** AutoResizer 量不到宽度时（隐藏容器 / jsdom）退回到列宽总和，避免宽度 0 渲染不出内容。 */
const columnsWidth = computed(() => tableColumns.value.reduce((sum, item) => sum + item.width, 0));

const rowEventHandlers = {
  onClick: ({ rowIndex }: { rowIndex: number }): void => {
    emit("row-click", props.rows[rowIndex]);
  },
};

function rowClassOf({ rowIndex }: { rowIndex: number }): string {
  const classes: string[] = [];
  if (props.stripe && rowIndex % 2 === 1) classes.push("vt-stripe");
  const extra = props.rowClass?.(props.rows[rowIndex], rowIndex);
  if (extra) classes.push(extra);
  return classes.join(" ");
}

const sourceRow = (index: number): unknown => props.rows[index];

function cellText(index: number, key: string): string {
  const value = (sourceRow(index) as Record<string, unknown> | undefined)?.[key];
  return value == null ? "" : String(value);
}
</script>

<template>
  <div class="virtual-table" :style="{ height: `${height}px` }">
    <el-auto-resizer>
      <template #default="{ width }">
        <el-table-v2
          :columns="tableColumns"
          :data="tableData"
          :width="width > 0 ? width : columnsWidth"
          :height="height"
          :header-height="40"
          :row-height="rowHeight"
          :row-key="ROW_KEY_FIELD"
          :row-class="rowClassOf"
          :row-event-handlers="rowEventHandlers"
          :cache="2"
        >
          <template #header-cell="{ column }">
            <el-checkbox
              v-if="column.key === SELECTION_KEY"
              class="vt-select-all"
              :model-value="allSelected"
              :indeterminate="indeterminate"
              :aria-label="`全选当前 ${rows.length} 行`"
              @change="toggleAll($event === true)"
            />
            <span v-else>{{ column.title }}</span>
          </template>

          <template #cell="{ column, rowIndex }">
            <el-checkbox
              v-if="column.key === SELECTION_KEY"
              class="vt-row-checkbox"
              :model-value="isSelected(rowIndex)"
              :aria-label="`选择第 ${rowIndex + 1} 行`"
              @change="toggleRow(rowIndex, $event === true)"
              @click.stop
            />
            <slot
              v-else
              :name="`cell-${String(column.key)}`"
              :row="sourceRow(rowIndex)"
              :index="rowIndex"
            >
              {{ cellText(rowIndex, String(column.key)) }}
            </slot>
          </template>

          <template #empty>
            <slot name="empty">
              <el-empty description="暂无数据" :image-size="60" />
            </slot>
          </template>
        </el-table-v2>
      </template>
    </el-auto-resizer>
  </div>
</template>

<style scoped>
.virtual-table {
  width: 100%;
}
:deep(.vt-stripe) {
  background: var(--el-fill-color-lighter);
}
:deep(.vt-row-checkbox),
:deep(.vt-select-all) {
  height: auto;
}
</style>
