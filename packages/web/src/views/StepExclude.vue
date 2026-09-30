<script setup lang="ts">
import { ElMessage } from "element-plus";
import type { TableInstance } from "element-plus";
import { computed, nextTick, ref } from "vue";
import { useRouter } from "vue-router";

import { filterStudents } from "@/lib/search";
import { useRosterStore } from "@/stores/roster";
import type { Student } from "@exam-seat/core";

/** 第 ② 步：排除缺考。主路径刻意做成「查询 → 全选当前结果 → 批量排除」， 被排除的学生留在表里（置灰 + 「不参加」标签），随时可以在抽屉里恢复。 */
const roster = useRosterStore();
const router = useRouter();

const query = ref("");
const classFilter = ref<string[]>([]);
const selected = ref<Student[]>([]);
const drawerVisible = ref(false);
const tableRef = ref<TableInstance>();

const rows = computed(() =>
  filterStudents(roster.students, { text: query.value, classNames: classFilter.value }),
);

const excludedRows = computed(() => roster.excludedStudents);

/** El-table 的作用域插槽把 row 推断成 DefaultRow，这里统一收窄回真实类型。 */
const asStudent = (row: unknown): Student => row as Student;

function rowClass({ row }: { row: Student }): string {
  return roster.isIncluded(row) ? "" : "row-excluded";
}

function onSelectionChange(value: Student[]): void {
  selected.value = value;
}

function selectAllFiltered(): void {
  const table = tableRef.value;
  if (!table) return;
  for (const row of rows.value) table.toggleRowSelection(row, true);
}

function clearSelection(): void {
  tableRef.value?.clearSelection();
  selected.value = [];
}

function excludeSelected(): void {
  if (selected.value.length === 0) {
    ElMessage.warning("先勾选学生，或用「全选当前结果」");
    return;
  }
  const count = roster.setIncluded(
    selected.value.map((s) => s.id),
    false,
  );
  clearSelection();
  ElMessage.success(`已把 ${count} 人标为「不参加」`);
}

function includeSelected(): void {
  if (selected.value.length === 0) {
    ElMessage.warning("先勾选学生");
    return;
  }
  const count = roster.setIncluded(
    selected.value.map((s) => s.id),
    true,
  );
  clearSelection();
  ElMessage.success(`已恢复 ${count} 人参加考试`);
}

function includeOne(id: string): void {
  roster.setIncluded([id], true);
}

async function openDrawer(): Promise<void> {
  drawerVisible.value = true;
  await nextTick();
}

function resetQuery(): void {
  query.value = "";
  classFilter.value = [];
}
</script>

<template>
  <div class="step-page">
    <el-card shadow="never">
      <template #header><strong>排除缺考</strong></template>

      <el-form inline>
        <el-form-item label="查询">
          <el-input
            v-model="query"
            placeholder="学号 / 姓名 / 班级，空格分隔多个条件，如：高三(1) 张"
            clearable
            style="width: 420px"
          />
        </el-form-item>
        <el-form-item label="班级">
          <el-select
            v-model="classFilter"
            multiple
            collapse-tags
            collapse-tags-tooltip
            clearable
            placeholder="全部班级"
            style="width: 320px"
          >
            <el-option v-for="name in roster.classNames" :key="name" :value="name" :label="name" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button @click="resetQuery">重置</el-button>
        </el-form-item>
      </el-form>

      <el-space wrap class="mb">
        <el-button type="primary" @click="selectAllFiltered"
          >全选当前结果（{{ rows.length }} 人）</el-button
        >
        <el-button type="danger" :disabled="selected.length === 0" @click="excludeSelected">
          批量排除（{{ selected.length }}）
        </el-button>
        <el-button :disabled="selected.length === 0" @click="includeSelected">
          恢复所选（{{ selected.length }}）
        </el-button>
        <el-button @click="clearSelection">清空勾选</el-button>
        <el-button @click="openDrawer">查看已排除（{{ roster.excludedCount }}）</el-button>
      </el-space>

      <el-table
        ref="tableRef"
        :data="rows"
        size="small"
        border
        height="440"
        row-key="id"
        :row-class-name="rowClass"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="44" />
        <el-table-column prop="id" label="学号" width="140" />
        <el-table-column prop="name" label="姓名" width="120" />
        <el-table-column prop="className" label="班级" min-width="140" />
        <el-table-column label="状态" width="160">
          <template #default="{ row }">
            <el-tag v-if="!roster.isIncluded(asStudent(row))" type="info" size="small"
              >不参加</el-tag
            >
            <el-tag v-else type="success" size="small">应考</el-tag>
            <el-button
              v-if="!roster.isIncluded(asStudent(row))"
              link
              type="primary"
              size="small"
              @click="includeOne(row.id)"
            >
              恢复
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="没有匹配的学生" :image-size="60" />
        </template>
      </el-table>

      <el-descriptions class="mt" :column="3" border>
        <el-descriptions-item label="应考"> {{ roster.total }} 人 </el-descriptions-item>
        <el-descriptions-item label="已排除">
          <span :class="{ 'text-danger': roster.excludedCount > 0 }"
            >{{ roster.excludedCount }} 人</span
          >
        </el-descriptions-item>
        <el-descriptions-item label="实际参考">
          <strong class="text-primary">{{ roster.participants }} 人</strong>
        </el-descriptions-item>
      </el-descriptions>
      <div class="hint">容量校验一律按「实际参考」人数算。</div>
    </el-card>

    <div class="step-actions">
      <el-button @click="router.push('/import')">上一步</el-button>
      <el-button type="primary" @click="router.push('/rooms')">下一步：配置考场</el-button>
    </div>

    <el-drawer v-model="drawerVisible" title="已排除的学生" size="480px">
      <el-empty
        v-if="excludedRows.length === 0"
        description="还没有排除任何学生"
        :image-size="60"
      />
      <template v-else>
        <el-button class="mb" @click="roster.includeAll()">全部恢复</el-button>
        <el-table :data="excludedRows" size="small" border max-height="600">
          <el-table-column prop="id" label="学号" width="130" />
          <el-table-column prop="name" label="姓名" width="100" />
          <el-table-column prop="className" label="班级" min-width="120" />
          <el-table-column label="操作" width="80">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="includeOne(row.id)"
                >恢复</el-button
              >
            </template>
          </el-table-column>
        </el-table>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.mb {
  margin-bottom: 10px;
}
.mt {
  margin-top: 12px;
}
.hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.text-danger {
  color: var(--el-color-danger);
}
.text-primary {
  color: var(--el-color-primary);
}
.step-actions {
  margin-top: 16px;
  display: flex;
  justify-content: space-between;
}
:deep(.row-excluded) {
  color: var(--el-text-color-disabled);
  background: var(--el-fill-color-lighter);
}
:deep(.row-excluded .el-table__cell) {
  background: var(--el-fill-color-lighter);
}
</style>
