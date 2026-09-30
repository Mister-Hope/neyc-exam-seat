<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import type { TableInstance } from "element-plus";
import { computed, nextTick, ref } from "vue";
import { useRouter } from "vue-router";

import ConstraintDialog from "@/components/ConstraintDialog.vue";
import {
  indexDiagnosticsByConstraint,
  useConstraintResolver,
  useExamJob,
  usePrecheck,
} from "@/composables/useExamJob";
import {
  roomLabel,
  semanticColHint,
  semanticRowHint,
  viewConstraintSeats,
} from "@/lib/constraint-view";
import type { ConstraintSeatView } from "@/lib/constraint-view";
import { filterStudents, summarizeNames } from "@/lib/search";
import { useConstraintsStore } from "@/stores/constraints";
import { useRoomsStore } from "@/stores/rooms";
import { useRosterStore } from "@/stores/roster";
import {
  CORE_SUBJECTS,
  PREFERRED_SUBJECTS,
  SECONDARY_SUBJECTS,
  SUBJECT_LABELS,
  describeCols,
  describeRows,
} from "@exam-seat/core";
import type { Constraint, Diagnostic, Student, Suggestion } from "@exam-seat/core";

/** 第 ④ 步：设置限定。左边筛学生、勾学生，右边是规则列表； 规则列表用 `precheckJob` 做实时冲突检测，冲突项红字标出原因，并能一键应用 core 给的 patch。 */
const roster = useRosterStore();
const roomsStore = useRoomsStore();
const constraintsStore = useConstraintsStore();
const { applySuggestion } = useExamJob();
const { resolveCount, resolveStudentIds } = useConstraintResolver();
const precheck = usePrecheck();
const router = useRouter();

const query = ref("");
const classFilter = ref<string[]>([]);
const selected = ref<Student[]>([]);
const tableRef = ref<TableInstance>();
const dialogVisible = ref(false);
const editing = ref<Constraint | null>(null);

const participants = computed(() => roster.students.filter((s) => roster.isIncluded(s)));
const rows = computed(() =>
  filterStudents(participants.value, { text: query.value, classNames: classFilter.value }),
);

const byConstraint = computed(() => indexDiagnosticsByConstraint(precheck.value.diagnostics));

const nameById = computed(() => new Map(roster.students.map((s) => [s.id, s.name || s.id])));

/** 名单里真实出现过的选科组合，给「按组合」选择器做候选 */
const combinationOptions = computed(() =>
  [
    ...new Set(participants.value.map((s) => s.combination).filter((c): c is string => Boolean(c))),
  ].sort((a, b) => a.localeCompare(b, "zh")),
);

/** 可选的科目：语数外 + 首选 + 再选，统一给中文名 */
const subjectOptions = [...CORE_SUBJECTS, ...PREFERRED_SUBJECTS, ...SECONDARY_SUBJECTS].map(
  (value) => ({ value, label: SUBJECT_LABELS[value] ?? value }),
);

/** 限定列表一行的全部展示信息（含 core 实时编译出的可用座位）。 */
interface RuleRow {
  constraint: Constraint;
  view: ConstraintSeatView;
  diagnostics: Diagnostic[];
  hasError: boolean;
  reason: string;
  suggestion: Suggestion | null;
  roomText: string;
  rowsText: string;
  colsText: string;
  studentsText: string;
  studentCount: number;
  selectorTags: string[];
  rowHints: string[];
  colHints: string[];
}

const ruleRows = computed<RuleRow[]>(() =>
  constraintsStore.constraints.map((constraint) => {
    const view = viewConstraintSeats(roomsStore.rooms, constraint);
    const diagnostics = byConstraint.value.get(constraint.id) ?? [];
    const errors = diagnostics.filter((d) => d.severity === "error");
    const roomIndex = roomsStore.rooms.findIndex((r) => r.id === constraint.roomId);
    const hitIds = resolveStudentIds(constraint);
    const selectorTags: string[] = [];
    if ((constraint.classes ?? []).length > 0) {
      selectorTags.push(`班级：${(constraint.classes ?? []).join("、")}`);
    }
    if ((constraint.combinations ?? []).length > 0) {
      selectorTags.push(`组合：${(constraint.combinations ?? []).join("、")}`);
    }
    if ((constraint.subjects ?? []).length > 0) {
      selectorTags.push(
        `科目：${(constraint.subjects ?? [])
          .map((subject) => SUBJECT_LABELS[subject] ?? subject)
          .join("、")}`,
      );
    }
    return {
      constraint,
      view,
      diagnostics,
      hasError: errors.length > 0,
      reason: (errors[0] ?? diagnostics[0])?.message ?? "",
      suggestion: errors.find((d) => d.suggestions.length > 0)?.suggestions[0] ?? null,
      roomText: constraint.roomId
        ? roomIndex === -1
          ? `${constraint.roomId}（不存在）`
          : roomLabel(roomsStore.rooms[roomIndex]!, roomIndex)
        : "不限考场",
      rowsText: describeRows(constraint.rows),
      colsText: describeCols(constraint.cols),
      studentsText: summarizeNames(hitIds.map((id) => nameById.value.get(id) ?? id)),
      studentCount: hitIds.length,
      selectorTags,
      rowHints: (constraint.rows ?? []).map((ref) => semanticRowHint(ref, roomsStore.rooms)),
      colHints: (constraint.cols ?? []).map((ref) => semanticColHint(ref, roomsStore.rooms)),
    };
  }),
);

const fatalCount = computed(
  () => precheck.value.diagnostics.filter((d) => d.severity === "error").length,
);

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

function openCreate(): void {
  if (selected.value.length === 0) {
    ElMessage.warning("先在左边的表里勾选学生（可以先按班级筛选再「全选当前结果」）");
    return;
  }
  editing.value = null;
  dialogVisible.value = true;
}

async function openEdit(constraint: Constraint): Promise<void> {
  editing.value = constraint;
  // 编辑时把「点名」的学生回填到表格勾选；班级/组合/科目选择器在弹窗里改
  const ids = new Set(constraint.studentIds);
  await nextTick();
  const table = tableRef.value;
  if (table) {
    table.clearSelection();
    for (const student of participants.value) {
      if (ids.has(student.id)) table.toggleRowSelection(student, true);
    }
  }
  dialogVisible.value = true;
}

function submitConstraint(payload: Omit<Constraint, "id">, id?: string): void {
  if (id) {
    constraintsStore.updateConstraint(id, payload);
    ElMessage.success("限定已更新");
  } else {
    constraintsStore.addConstraint(payload);
    ElMessage.success("限定已添加");
  }
  clearSelection();
}

async function removeConstraint(constraint: Constraint): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定删除这条限定？${constraint.note ? `（${constraint.note}）` : ""}`,
      "删除限定",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
    );
    constraintsStore.removeConstraint(constraint.id);
  } catch {
    // 取消
  }
}

/** El-table 的作用域插槽把 row 推断成 DefaultRow，这里统一收窄回真实类型。 */
const asRuleRow = (row: unknown): RuleRow => row as RuleRow;

function applyFix(row: RuleRow): void {
  if (!row.suggestion) return;
  const outcome = applySuggestion(row.suggestion);
  if (outcome.ok) ElMessage.success(`已应用：${row.suggestion.label}`);
  else ElMessage.error(outcome.error ?? "应用失败");
}
</script>

<template>
  <div class="step-page">
    <el-alert
      v-if="fatalCount > 0"
      class="mb"
      type="error"
      :closable="false"
      show-icon
      :title="`预检发现 ${fatalCount} 个致命问题，先按下面的红字提示改掉，再去排考场`"
    />

    <el-card shadow="never">
      <template #header>
        <strong>选择学生</strong>
        <span class="muted">｜按班级筛选 → 全选当前结果 → 添加限定</span>
      </template>

      <el-form inline>
        <el-form-item label="查询">
          <el-input
            v-model="query"
            placeholder="学号 / 姓名 / 班级，空格分隔多个条件"
            clearable
            style="width: 360px"
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
            style="width: 300px"
          >
            <el-option v-for="name in roster.classNames" :key="name" :value="name" :label="name" />
          </el-select>
        </el-form-item>
      </el-form>

      <el-space wrap class="mb">
        <el-button @click="selectAllFiltered">全选当前结果（{{ rows.length }} 人）</el-button>
        <el-button @click="clearSelection">清空勾选</el-button>
        <el-button type="primary" :disabled="selected.length === 0" @click="openCreate">
          添加限定（已选 {{ selected.length }} 人）
        </el-button>
      </el-space>

      <el-table
        ref="tableRef"
        :data="rows"
        size="small"
        border
        height="360"
        row-key="id"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="44" />
        <el-table-column prop="id" label="学号" width="140" />
        <el-table-column prop="name" label="姓名" width="110" />
        <el-table-column prop="className" label="班级" min-width="130" />
        <el-table-column label="已有条件" min-width="200">
          <template #default="{ row }">
            <template v-if="constraintsStore.constraintsOfStudent(row.id).length > 0">
              <el-tag
                v-for="c in constraintsStore.constraintsOfStudent(row.id)"
                :key="c.id"
                size="small"
                class="mr"
                :type="
                  byConstraint.get(c.id)?.some((d) => d.severity === 'error') ? 'danger' : 'info'
                "
              >
                {{ c.note?.trim() || c.id }}
              </el-tag>
            </template>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="没有匹配的应考学生" :image-size="60" />
        </template>
      </el-table>
    </el-card>

    <el-card class="mt" shadow="never">
      <template #header>
        <strong>限定规则（{{ ruleRows.length }} 条）</strong>
        <span class="muted">
          ｜同一学生被多条命中时取交集；考场限定是单选；可用座位数用 core 的 compileConstraintSeats
          实时算
        </span>
      </template>

      <el-table :data="ruleRows" size="small" border>
        <el-table-column label="备注" min-width="140">
          <template #default="{ row }">
            <strong>{{ row.constraint.note?.trim() || row.constraint.id }}</strong>
            <div class="muted">{{ row.constraint.id }}</div>
          </template>
        </el-table-column>
        <el-table-column label="考场" min-width="130">
          <template #default="{ row }">{{ row.roomText }}</template>
        </el-table-column>
        <el-table-column label="排" min-width="120">
          <template #default="{ row }">
            <el-tooltip v-if="row.rowHints.length" placement="top">
              <template #content>
                <div v-for="(hint, i) in row.rowHints" :key="i">{{ hint }}</div>
              </template>
              <span>{{ row.rowsText }}</span>
            </el-tooltip>
            <span v-else>{{ row.rowsText }}</span>
          </template>
        </el-table-column>
        <el-table-column label="列" min-width="120">
          <template #default="{ row }">
            <el-tooltip v-if="row.colHints.length" placement="top">
              <template #content>
                <div v-for="(hint, i) in row.colHints" :key="i">{{ hint }}</div>
              </template>
              <span>{{ row.colsText }}</span>
            </el-tooltip>
            <span v-else>{{ row.colsText }}</span>
          </template>
        </el-table-column>
        <el-table-column label="命中学生" min-width="180">
          <template #default="{ row }">
            <el-tooltip placement="top" :content="row.studentsText">
              <el-tag :type="row.studentCount > 0 ? 'success' : 'danger'" size="small">
                {{ row.studentCount }} 人
              </el-tag>
            </el-tooltip>
            <div class="muted">{{ row.studentsText }}</div>
            <div v-if="row.selectorTags.length > 0" class="selector-tags">
              <el-tag v-for="tag in row.selectorTags" :key="tag" size="small" type="info">
                {{ tag }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="可用座位" width="180">
          <template #default="{ row }">
            <el-tooltip placement="top">
              <template #content>
                <div v-for="item in row.view.perRoom" :key="item.roomId">
                  {{ item.roomName }}：{{ item.seats }}/{{ item.capacity }}
                </div>
                <div v-if="row.view.droppedRooms.length">
                  被排除的考场：{{ row.view.droppedRooms.join("、") }}
                </div>
              </template>
              <el-tag :type="row.view.total > 0 ? 'success' : 'danger'"
                >{{ row.view.total }} 个</el-tag
              >
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="状态" min-width="220">
          <template #default="{ row }">
            <template v-if="row.reason">
              <div class="error-text">{{ row.reason }}</div>
              <el-button
                v-if="row.suggestion"
                size="small"
                link
                type="primary"
                @click="applyFix(asRuleRow(row))"
              >
                应用建议：{{ row.suggestion.label }}
              </el-button>
            </template>
            <el-tag v-else type="success" size="small">可行</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120">
          <template #default="{ row }">
            <el-button size="small" link @click="openEdit(row.constraint)">编辑</el-button>
            <el-button size="small" link type="danger" @click="removeConstraint(row.constraint)">
              删除
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="还没有限定规则，全部学生都能坐任意考场" :image-size="60" />
        </template>
      </el-table>
    </el-card>

    <div class="step-actions">
      <el-button @click="router.push('/rooms')">上一步</el-button>
      <el-button type="primary" @click="router.push('/solve')">下一步：排考场</el-button>
    </div>

    <ConstraintDialog
      v-model="dialogVisible"
      :rooms="roomsStore.rooms"
      :student-ids="editing ? (editing.studentIds ?? []) : selected.map((s) => s.id)"
      :class-names="roster.classNames"
      :combination-options="combinationOptions"
      :subject-options="subjectOptions"
      :resolve-count="resolveCount"
      :editing="editing"
      @submit="submitConstraint"
    />
  </div>
</template>

<style scoped>
.mb {
  margin-bottom: 10px;
}
.mt {
  margin-top: 12px;
}
.mr {
  margin-right: 4px;
}
.muted {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.selector-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
.error-text {
  color: var(--el-color-danger);
  font-size: 12px;
  line-height: 1.5;
}
.step-actions {
  margin-top: 16px;
  display: flex;
  justify-content: space-between;
}
</style>
