<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { toast } from "vue-sonner";

import MultiSelect from "@/components/MultiSelect.vue";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import VirtualTable from "@/components/VirtualTable.vue";
import type { VirtualTableColumn } from "@/components/VirtualTable.vue";
import { readFileBytes } from "@/lib/download";
import type { AbsentImportReport } from "@/lib/roster-import";
import { filterStudents } from "@/lib/search";
import { useRosterStore } from "@/stores/roster";
import type { Student } from "@exam-seat/core";
import { CircleAlertIcon, InboxIcon, UploadIcon } from "@lucide/vue";

/** 第 ② 步：排除缺考。主路径刻意做成「查询 → 全选当前结果 → 批量排除」， 被排除的学生留在表里（置灰 + 「不参加」标签），随时可以在抽屉里恢复。 */
const roster = useRosterStore();
const router = useRouter();

const query = ref("");
const classFilter = ref<string[]>([]);
/** 勾选只存学号：表格是虚拟滚动的，选中状态必须挂在「当前筛选结果」上，不能挂在已渲染的行上。 */
const selectedKeys = ref<string[]>([]);
const drawerVisible = ref(false);
/** 最近一次「导入缺考名单」的结果（命中 / 未匹配）。 */
const absentReport = ref<AbsentImportReport | null>(null);
const absentInput = ref<HTMLInputElement | null>(null);

const rows = computed(() =>
  filterStudents(roster.students, { text: query.value, classNames: classFilter.value }),
);

const columns: VirtualTableColumn[] = [
  { key: "id", title: "学号", width: 140 },
  { key: "name", title: "姓名", width: 120 },
  { key: "className", title: "班级", width: 180 },
  { key: "status", title: "状态", width: 220 },
];

const excludedColumns: VirtualTableColumn[] = [
  { key: "id", title: "学号", width: 130 },
  { key: "name", title: "姓名", width: 100 },
  { key: "className", title: "班级", width: 140 },
  { key: "action", title: "操作", width: 80 },
];

const selectedCount = computed(() => selectedKeys.value.length);

const excludedRows = computed(() => roster.excludedStudents);

const asStudent = (row: unknown): Student => row as Student;

const studentKey = (row: unknown): string => asStudent(row).id;

function rowClass(row: unknown): string {
  return roster.isIncluded(asStudent(row)) ? "" : "row-excluded";
}

function selectAllFiltered(): void {
  selectedKeys.value = rows.value.map((student) => student.id);
}

function clearSelection(): void {
  selectedKeys.value = [];
}

function excludeSelected(): void {
  if (selectedKeys.value.length === 0) {
    toast.warning("先勾选学生，或用「全选当前结果」");
    return;
  }
  const count = roster.setIncluded(selectedKeys.value, false);
  clearSelection();
  toast.success(`已把 ${count} 人标为「不参加」`);
}

function includeSelected(): void {
  if (selectedKeys.value.length === 0) {
    toast.warning("先勾选学生");
    return;
  }
  const count = roster.setIncluded(selectedKeys.value, true);
  clearSelection();
  toast.success(`已恢复 ${count} 人参加考试`);
}

function includeOne(id: string): void {
  roster.setIncluded([id], true);
}

function resetQuery(): void {
  query.value = "";
  classFilter.value = [];
}

function pickAbsentFile(): void {
  absentInput.value?.click();
}

/** 导入缺考名单：准考证号优先，没有准考证号列才用 姓名+班级；未匹配的行要报出来。 */
async function onAbsentFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (!/\.(?:xlsx|xls)$/i.test(file.name)) {
    toast.error("只支持 .xlsx / .xls 文件");
    return;
  }
  try {
    const report = roster.importAbsentBytes(await readFileBytes(file));
    absentReport.value = report;
    if (!report.ok) {
      toast.error(report.error ?? "缺考名单导入失败");
      return;
    }
    if (report.unmatched > 0) {
      toast.warning(`缺考名单：命中 ${report.matched} 人，未匹配 ${report.unmatched} 行`);
    } else {
      toast.success(`缺考名单：命中 ${report.matched} 人，全部匹配成功`);
    }
  } catch (err) {
    absentReport.value = null;
    toast.error(err instanceof Error ? err.message : String(err));
  }
}
</script>

<template>
  <div class="mx-auto max-w-[1360px]">
    <Card>
      <CardHeader>
        <CardTitle>排除缺考</CardTitle>
      </CardHeader>
      <CardContent class="flex flex-col gap-3">
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex flex-col gap-1.5">
            <Label for="exclude-query">查询</Label>
            <Input
              id="exclude-query"
              v-model="query"
              class="w-[26rem] max-w-full"
              placeholder="学号 / 姓名 / 班级，空格分隔多个条件，如：高三(1) 张"
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
          <Button size="sm" @click="selectAllFiltered">
            全选当前结果（{{ rows.length }} 人）
          </Button>
          <Button
            variant="destructive"
            size="sm"
            :disabled="selectedCount === 0"
            @click="excludeSelected"
          >
            批量排除（{{ selectedCount }}）
          </Button>
          <Button
            variant="outline"
            size="sm"
            :disabled="selectedCount === 0"
            @click="includeSelected"
          >
            恢复所选（{{ selectedCount }}）
          </Button>
          <Button variant="ghost" size="sm" @click="clearSelection">清空勾选</Button>
          <Button variant="outline" size="sm" @click="drawerVisible = true">
            查看已排除（{{ roster.excludedCount }}）
          </Button>
          <Button variant="secondary" size="sm" @click="pickAbsentFile">
            <UploadIcon data-icon="inline-start" />
            导入缺考名单
          </Button>
          <span class="text-muted-foreground text-xs">（班级+姓名 / 准考证号）</span>
          <input
            ref="absentInput"
            type="file"
            accept=".xlsx,.xls"
            class="hidden"
            data-testid="absent-file"
            @change="onAbsentFile"
          />
        </div>

        <Alert v-if="absentReport" variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>
            {{
              absentReport.ok
                ? `缺考名单：命中 ${absentReport.matched} 人，未匹配 ${absentReport.unmatched} 行`
                : `缺考名单导入失败：${absentReport.error ?? ""}`
            }}
          </AlertTitle>
          <AlertDescription v-if="absentReport.unmatchedSamples.length > 0">
            未匹配示例：{{ absentReport.unmatchedSamples.join("；")
            }}<template v-if="absentReport.unmatched > absentReport.unmatchedSamples.length">
              …等 {{ absentReport.unmatched }} 行</template
            >
          </AlertDescription>
          <div class="absolute top-2 right-2">
            <Button variant="ghost" size="xs" @click="absentReport = null">关闭</Button>
          </div>
        </Alert>

        <VirtualTable
          :rows="rows"
          :row-key="studentKey"
          :columns="columns"
          :height="440"
          selectable
          :selected-keys="selectedKeys"
          :row-class="rowClass"
          @update:selected-keys="selectedKeys = $event"
        >
          <template #cell-status="{ row }">
            <div class="flex items-center gap-2">
              <Badge v-if="!roster.isIncluded(asStudent(row))" variant="secondary">不参加</Badge>
              <Badge v-else variant="outline">应考</Badge>
              <Button
                v-if="!roster.isIncluded(asStudent(row))"
                variant="link"
                size="xs"
                @click.stop="includeOne(asStudent(row).id)"
              >
                恢复
              </Button>
            </div>
          </template>
          <template #empty>
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><InboxIcon /></EmptyMedia>
                <EmptyTitle>没有匹配的学生</EmptyTitle>
                <EmptyDescription>换个关键词，或清空班级筛选</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </template>
        </VirtualTable>

        <Separator />

        <dl class="grid grid-cols-3 gap-2 text-sm">
          <div class="flex flex-col gap-0.5">
            <dt class="text-muted-foreground text-xs">应考</dt>
            <dd>{{ roster.total }} 人</dd>
          </div>
          <div class="flex flex-col gap-0.5">
            <dt class="text-muted-foreground text-xs">已排除</dt>
            <dd :class="{ 'text-destructive': roster.excludedCount > 0 }">
              {{ roster.excludedCount }} 人
            </dd>
          </div>
          <div class="flex flex-col gap-0.5">
            <dt class="text-muted-foreground text-xs">实际参考</dt>
            <dd class="text-primary font-semibold">{{ roster.participants }} 人</dd>
          </div>
        </dl>
        <p class="text-muted-foreground text-xs">容量校验一律按「实际参考」人数算。</p>
      </CardContent>
    </Card>

    <div class="mt-4 flex justify-between">
      <Button variant="outline" @click="router.push('/import')">上一步</Button>
      <Button @click="router.push('/rooms')">下一步：配置考场</Button>
    </div>

    <Sheet v-model:open="drawerVisible">
      <SheetContent side="right" class="w-[480px] max-w-full overflow-y-auto sm:max-w-[480px]">
        <SheetHeader>
          <SheetTitle>已排除的学生</SheetTitle>
          <SheetDescription>这些学生不参加本次考试；可以随时恢复。</SheetDescription>
        </SheetHeader>
        <div class="flex flex-col gap-3 px-4 pb-6">
          <Empty v-if="excludedRows.length === 0">
            <EmptyHeader>
              <EmptyTitle>还没有排除任何学生</EmptyTitle>
            </EmptyHeader>
          </Empty>
          <template v-else>
            <Button variant="outline" size="sm" class="self-start" @click="roster.includeAll()">
              全部恢复
            </Button>
            <VirtualTable
              :rows="excludedRows"
              :row-key="studentKey"
              :columns="excludedColumns"
              :height="600"
            >
              <template #cell-action="{ row }">
                <Button variant="link" size="xs" @click.stop="includeOne(asStudent(row).id)">
                  恢复
                </Button>
              </template>
            </VirtualTable>
          </template>
        </div>
      </SheetContent>
    </Sheet>
  </div>
</template>

<style scoped>
:deep(.row-excluded) {
  color: var(--muted-foreground);
  background: var(--muted);
  opacity: 0.75;
}
</style>
