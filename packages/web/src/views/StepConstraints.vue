<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { toast } from "vue-sonner";

import ConstraintDialog from "@/components/ConstraintDialog.vue";
import MultiSelect from "@/components/MultiSelect.vue";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import VirtualTable from "@/components/VirtualTable.vue";
import type { VirtualTableColumn } from "@/components/VirtualTable.vue";
import { confirmAction } from "@/composables/useConfirm";
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
  compareText,
  describeCols,
  describeRows,
} from "@exam-seat/core";
import type { Constraint, Diagnostic, Student, Suggestion } from "@exam-seat/core";
import { CircleAlertIcon, InboxIcon } from "@lucide/vue";

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
/** 勾选只存学号：虚拟滚动只影响渲染，选中集始终对应「当前筛选结果」。 */
const selectedKeys = ref<string[]>([]);
const dialogVisible = ref(false);
const editing = ref<Constraint | null>(null);

const participants = computed(() => roster.students.filter((s) => roster.isIncluded(s)));
const rows = computed(() =>
  filterStudents(participants.value, { text: query.value, classNames: classFilter.value }),
);

const studentColumns: VirtualTableColumn[] = [
  { key: "id", title: "学号", width: 140 },
  { key: "name", title: "姓名", width: 110 },
  { key: "className", title: "班级", width: 150 },
  { key: "conditions", title: "已有条件", width: 260 },
];

const asStudent = (row: unknown): Student => row as Student;
const studentKey = (row: unknown): string => asStudent(row).id;

const byConstraint = computed(() => indexDiagnosticsByConstraint(precheck.value.diagnostics));

const nameById = computed(() => new Map(roster.students.map((s) => [s.id, s.name || s.id])));

/** 名单里真实出现过的选科组合，给「按组合」选择器做候选 */
const combinationOptions = computed(() =>
  [
    ...new Set(participants.value.map((s) => s.combination).filter((c): c is string => Boolean(c))),
  ].sort(compareText),
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

/** 数量类标签的配色：有值走中性 outline，空值走 destructive（对应原来信息色 / 危险色两种标签）。 */
function countVariant(ok: boolean): "outline" | "destructive" {
  return ok ? "outline" : "destructive";
}

function errorVariant(hasError: boolean): "secondary" | "destructive" {
  return hasError ? "destructive" : "secondary";
}

function selectAllFiltered(): void {
  selectedKeys.value = rows.value.map((student) => student.id);
}

function clearSelection(): void {
  selectedKeys.value = [];
}

function resetQuery(): void {
  query.value = "";
  classFilter.value = [];
}

function openCreate(): void {
  if (selectedKeys.value.length === 0) {
    toast.warning("先勾选学生");
    return;
  }
  editing.value = null;
  dialogVisible.value = true;
}

function openEdit(constraint: Constraint): void {
  editing.value = constraint;
  // 编辑时把「点名」的学生回填到表格勾选；班级/组合/科目选择器在弹窗里改
  const ids = new Set(constraint.studentIds);
  selectedKeys.value = participants.value
    .filter((student) => ids.has(student.id))
    .map((student) => student.id);
  dialogVisible.value = true;
}

function submitConstraint(payload: Omit<Constraint, "id">, id?: string): void {
  if (id) {
    constraintsStore.updateConstraint(id, payload);
    toast.success("限定已更新");
  } else {
    constraintsStore.addConstraint(payload);
    toast.success("限定已添加");
  }
  clearSelection();
}

async function removeConstraint(constraint: Constraint): Promise<void> {
  const confirmed = await confirmAction({
    title: "删除限定",
    description: `确定删除这条限定？${constraint.note ? `（${constraint.note}）` : ""}`,
    confirmText: "删除",
    danger: true,
  });
  if (!confirmed) return;
  constraintsStore.removeConstraint(constraint.id);
}

function applyFix(row: RuleRow): void {
  if (!row.suggestion) return;
  const outcome = applySuggestion(row.suggestion);
  if (outcome.ok) toast.success(`已应用：${row.suggestion.label}`);
  else toast.error(outcome.error ?? "应用失败");
}
</script>

<template>
  <div class="mx-auto max-w-[1360px] pb-10">
    <Alert v-if="fatalCount > 0" variant="destructive" class="mb-3">
      <CircleAlertIcon />
      <AlertTitle>
        预检发现 {{ fatalCount }} 个致命问题，先按下面的红字提示改掉，再到「考场排布」重新排
      </AlertTitle>
    </Alert>

    <Card>
      <CardHeader>
        <CardTitle>选择学生</CardTitle>
        <CardDescription>选学生 → 设条件 → 添加规则</CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-3">
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex flex-col gap-1.5">
            <Label for="constraint-query">搜索</Label>
            <Input
              id="constraint-query"
              v-model="query"
              class="w-[22rem] max-w-full"
              placeholder="学号 / 姓名 / 班级，空格分隔多个条件"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label>班级</Label>
            <MultiSelect
              v-model="classFilter"
              :options="roster.classNames"
              placeholder="全部班级"
              trigger-class="w-80"
            />
          </div>
          <Button variant="outline" size="sm" @click="resetQuery">重置</Button>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" @click="selectAllFiltered">
            全选（{{ rows.length }} 人）
          </Button>
          <Button variant="ghost" size="sm" @click="clearSelection">清空勾选</Button>
          <Button size="sm" :disabled="selectedKeys.length === 0" @click="openCreate">
            添加限定（已选 {{ selectedKeys.length }} 人）
          </Button>
        </div>

        <VirtualTable
          :rows="rows"
          :row-key="studentKey"
          :columns="studentColumns"
          :height="360"
          selectable
          :selected-keys="selectedKeys"
          @update:selected-keys="selectedKeys = $event"
        >
          <template #cell-conditions="{ row }">
            <div
              v-if="constraintsStore.constraintsOfStudent(asStudent(row).id).length > 0"
              class="flex flex-wrap items-center gap-1"
            >
              <Badge
                v-for="c in constraintsStore.constraintsOfStudent(asStudent(row).id)"
                :key="c.id"
                :variant="
                  errorVariant(byConstraint.get(c.id)?.some((d) => d.severity === 'error') === true)
                "
              >
                {{ c.note?.trim() || c.id }}
              </Badge>
            </div>
            <span v-else class="text-muted-foreground">—</span>
          </template>
          <template #empty>
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><InboxIcon /></EmptyMedia>
                <EmptyTitle>没有匹配的应考学生</EmptyTitle>
                <EmptyDescription>换个关键词，或清空班级筛选</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </template>
        </VirtualTable>
      </CardContent>
    </Card>

    <Card class="mt-4">
      <CardHeader>
        <CardTitle>限定规则（{{ ruleRows.length }} 条）</CardTitle>
        <CardDescription>同一学生被多条命中时取交集；考场限定是单选。</CardDescription>
      </CardHeader>
      <CardContent>
        <TooltipProvider>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>备注</TableHead>
                <TableHead>考场</TableHead>
                <TableHead>排</TableHead>
                <TableHead>列</TableHead>
                <TableHead>命中学生</TableHead>
                <TableHead>可用座位</TableHead>
                <TableHead>状态</TableHead>
                <TableHead class="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableEmpty v-if="ruleRows.length === 0" :colspan="8">
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><InboxIcon /></EmptyMedia>
                    <EmptyTitle>还没有限定规则，全部学生都能坐任意考场</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              </TableEmpty>
              <TableRow v-for="row in ruleRows" :key="row.constraint.id">
                <TableCell>
                  <div class="font-medium">
                    {{ row.constraint.note?.trim() || row.constraint.id }}
                  </div>
                  <div class="text-muted-foreground text-xs">{{ row.constraint.id }}</div>
                </TableCell>
                <TableCell>{{ row.roomText }}</TableCell>
                <TableCell>
                  <Tooltip v-if="row.rowHints.length">
                    <TooltipTrigger as-child>
                      <span>{{ row.rowsText }}</span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div v-for="(hint, i) in row.rowHints" :key="i">{{ hint }}</div>
                    </TooltipContent>
                  </Tooltip>
                  <span v-else>{{ row.rowsText }}</span>
                </TableCell>
                <TableCell>
                  <Tooltip v-if="row.colHints.length">
                    <TooltipTrigger as-child>
                      <span>{{ row.colsText }}</span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div v-for="(hint, i) in row.colHints" :key="i">{{ hint }}</div>
                    </TooltipContent>
                  </Tooltip>
                  <span v-else>{{ row.colsText }}</span>
                </TableCell>
                <TableCell class="max-w-[16rem]">
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <Badge :variant="countVariant(row.studentCount > 0)">
                        {{ row.studentCount }} 人
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>{{ row.studentsText }}</TooltipContent>
                  </Tooltip>
                  <div class="text-muted-foreground truncate text-xs">{{ row.studentsText }}</div>
                  <div v-if="row.selectorTags.length > 0" class="mt-0.5 flex flex-wrap gap-1">
                    <Badge v-for="tag in row.selectorTags" :key="tag" variant="secondary">
                      {{ tag }}
                    </Badge>
                  </div>
                </TableCell>
                <TableCell>
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <Badge :variant="countVariant(row.view.total > 0)">
                        {{ row.view.total }} 个
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div v-for="item in row.view.perRoom" :key="item.roomId">
                        {{ item.roomName }}：{{ item.seats }}/{{ item.capacity }}
                      </div>
                      <div v-if="row.view.droppedRooms.length">
                        被排除的考场：{{ row.view.droppedRooms.join("、") }}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                <TableCell class="max-w-[18rem] whitespace-normal">
                  <template v-if="row.reason">
                    <div class="text-destructive text-xs leading-relaxed">{{ row.reason }}</div>
                    <Button
                      v-if="row.suggestion"
                      variant="link"
                      size="xs"
                      class="h-auto px-0"
                      @click="applyFix(row)"
                    >
                      应用建议：{{ row.suggestion.label }}
                    </Button>
                  </template>
                  <Badge v-else variant="default">可行</Badge>
                </TableCell>
                <TableCell class="text-right">
                  <div class="flex justify-end gap-1">
                    <Button variant="link" size="xs" @click="openEdit(row.constraint)">编辑</Button>
                    <Button
                      variant="link"
                      size="xs"
                      class="text-destructive"
                      @click="removeConstraint(row.constraint)"
                    >
                      删除
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TooltipProvider>
      </CardContent>
    </Card>

    <div class="mt-4 flex justify-between">
      <Button variant="outline" @click="router.push('/rooms')">上一步</Button>
      <Button @click="router.push('/solve')">下一步：考场排布</Button>
    </div>

    <ConstraintDialog
      v-model="dialogVisible"
      :rooms="roomsStore.rooms"
      :student-ids="editing ? (editing.studentIds ?? []) : selectedKeys"
      :class-names="roster.classNames"
      :combination-options="combinationOptions"
      :subject-options="subjectOptions"
      :resolve-count="resolveCount"
      :editing="editing"
      @submit="submitConstraint"
    />
  </div>
</template>
