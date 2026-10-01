<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { toast } from "vue-sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import VirtualTable from "@/components/VirtualTable.vue";
import type { VirtualTableColumn } from "@/components/VirtualTable.vue";
import { readFileBytes } from "@/lib/download";
import { columnLabel } from "@/lib/roster-import";
import { useRosterStore } from "@/stores/roster";
import { suggestMapping } from "@exam-seat/io";
import type { RosterIssue, RosterMapping } from "@exam-seat/io";
import {
  ArrowRightIcon,
  CircleAlertIcon,
  FileSpreadsheetIcon,
  InboxIcon,
  InfoIcon,
  TriangleAlertIcon,
  UploadIcon,
  XIcon,
} from "@lucide/vue";

/** 第 ① 步：导入名单。拖拽 / 选择 .xlsx → 自动选表 + 自动预填列映射，认不出的必填列标红； 名单里带「缺考」列时自动标记 `included:false`。 */
const roster = useRosterStore();
const router = useRouter();

const fileInput = ref<HTMLInputElement | null>(null);

const mappingFields: {
  key: keyof RosterMapping;
  label: string;
  required: boolean;
  hint?: string;
}[] = [
  { key: "id", label: "准考证号", required: true, hint: "学号 / 准考证号 / 考证号" },
  { key: "name", label: "姓名", required: true },
  { key: "className", label: "班级", required: true },
  { key: "combination", label: "选科", required: false, hint: "据此排多场次" },
  { key: "absent", label: "缺考", required: false, hint: "有内容即不参加" },
];

const headerOptions = computed(() =>
  roster.headers.map((header, index) => ({
    value: index,
    label: `${columnLabel(index)} 列：${header || "(空表头)"}`,
  })),
);

/** NativeSelect 用 -1 表示「没指定」，直接对应 store 里的空映射，省掉一层 undefined 转换。 */
const mappingValue = (key: keyof RosterMapping): number => roster.mapping?.[key] ?? -1;

/** 自动识别结果（可能被老师手动改过，页面上分别标注）。 */
const autoMapping = computed(() => suggestMapping(roster.headers).mapping);

/** 每个映射字段的展示信息：识别到了哪列、是自动还是手动、必填列缺没缺。 */
const fieldViews = computed(() =>
  mappingFields.map((field) => {
    const index = mappingValue(field.key);
    const autoIndex = autoMapping.value[field.key];
    return {
      ...field,
      value: index,
      mapped: index >= 0,
      missing: field.required && index < 0,
      column: index < 0 ? null : columnLabel(index),
      header: index < 0 ? "" : (roster.headers[index] ?? ""),
      auto: index >= 0 && autoIndex === index,
    };
  }),
);

const missingColumns = computed(() =>
  fieldViews.value.filter((field) => field.required && field.missing),
);
const recognizedRequired = computed(
  () => fieldViews.value.filter((field) => field.required && !field.missing).length,
);
const requiredCount = mappingFields.filter((field) => field.required).length;
const absentColumnMapped = computed(() => (roster.mapping?.absent ?? -1) >= 0);

const issuesSorted = computed(() =>
  [...roster.issues].sort((a, b) =>
    a.level === b.level ? a.row - b.row : a.level === "error" ? -1 : 1,
  ),
);
const issuePreview = computed(() => issuesSorted.value.slice(0, 100));

const issueColumns: VirtualTableColumn[] = [
  { key: "row", title: "Excel 行号", width: 110 },
  { key: "level", title: "级别", width: 90 },
  { key: "message", title: "说明", width: 520 },
];

/** 作用域插槽里的 row 是 unknown，统一收窄回真实类型。 */
const asIssue = (row: unknown): RosterIssue => row as RosterIssue;
/** 同一 Excel 行可能有多条问题，主键要带上序号。 */
const issueKey = (row: unknown, index: number): string => `${asIssue(row).row}-${index}`;

const hasCombination = computed(() => roster.combinationSizes.length > 0);

const classRows = computed(() =>
  [...roster.classSizes].sort((a, b) => a.className.localeCompare(b.className, "zh")),
);

function pickFile(): void {
  fileInput.value?.click();
}

async function handleFile(file: File | undefined): Promise<void> {
  if (!file) return;
  if (!/\.(?:xlsx|xls)$/i.test(file.name)) {
    toast.error("只支持 .xlsx / .xls 文件");
    return;
  }
  try {
    roster.importBytes(await readFileBytes(file), file.name);
    if (roster.total > 0) toast.success(`读到 ${roster.total} 名学生`);
    else if (roster.errorMessage) toast.warning(roster.errorMessage);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // 清空 input，老师重新选同一个文件时也能再触发一次 change
  input.value = "";
  await handleFile(file);
}

async function onDrop(event: DragEvent): Promise<void> {
  await handleFile(event.dataTransfer?.files?.[0]);
}

function setMapping(key: keyof RosterMapping, value: number): void {
  roster.updateMapping({ [key]: value } as Partial<RosterMapping>);
}

/** NativeSelect 的 modelValue 会退化成字符串，统一转回列号（-1 = 不使用）。 */
function onMappingChange(key: keyof RosterMapping, value: unknown): void {
  const index = Number(value);
  setMapping(key, Number.isFinite(index) ? index : -1);
}

/** NativeSelect 的 emit 类型会退化成无参签名，这里统一用可选参数接收。 */
function onSheetChange(value?: unknown): void {
  roster.selectSheet(String(value));
}
</script>

<template>
  <div class="mx-auto flex max-w-[1360px] flex-col gap-4">
    <Card>
      <CardHeader>
        <CardTitle>导入名单</CardTitle>
        <CardDescription>.xlsx，第一行为表头</CardDescription>
      </CardHeader>

      <CardContent class="flex flex-col gap-3">
        <div
          class="border-border bg-muted/30 hover:bg-muted/50 flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center transition-colors"
          @click="pickFile"
          @dragover.prevent
          @drop.prevent="onDrop"
        >
          <FileSpreadsheetIcon class="text-muted-foreground size-8" />
          <p class="text-sm font-medium">把 Excel 名单拖到这里，或点击选择</p>
          <p class="text-muted-foreground text-xs">
            至少要「准考证号（学号 / 考证号）/ 姓名 /
            班级」三列；有「选科」列会自动读取（据此排多场次），有「缺考」列会自动排除；其它列忽略
          </p>
          <Button variant="outline" size="sm" @click.stop="pickFile">
            <UploadIcon data-icon="inline-start" />
            选择文件
          </Button>
          <input
            ref="fileInput"
            type="file"
            accept=".xlsx,.xls"
            class="hidden"
            @change="onFileChange"
          />
        </div>

        <Alert v-if="roster.errorMessage" variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>{{ roster.errorMessage }}</AlertTitle>
        </Alert>
      </CardContent>

      <CardFooter class="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" @click="roster.loadDemo()">
          载入示例名单（3 个班 × 24 人，带选科）
        </Button>
        <Button v-if="roster.total > 0" variant="outline" size="sm" @click="roster.reset()">
          清空名单
        </Button>
      </CardFooter>
    </Card>

    <Card v-if="roster.total > 0 || roster.headers.length > 0">
      <CardHeader>
        <CardTitle>列映射</CardTitle>
        <CardDescription>
          已自动识别 {{ recognizedRequired }}/{{ requiredCount }} 个必填列，认错了就在这里改（{{
            roster.fileName || "未命名文件"
          }}）
        </CardDescription>
      </CardHeader>

      <CardContent class="flex flex-col gap-4">
        <FieldGroup class="max-w-[760px] gap-4">
          <Field v-if="roster.sheetNames.length > 1" orientation="horizontal">
            <FieldLabel for="roster-sheet" class="w-20 shrink-0">工作表</FieldLabel>
            <FieldContent>
              <NativeSelect
                id="roster-sheet"
                class="w-[22rem] max-w-full"
                :modelValue="roster.sheetName"
                @update:modelValue="onSheetChange"
              >
                <NativeSelectOption v-for="name in roster.sheetNames" :key="name" :value="name">
                  {{ name }}
                </NativeSelectOption>
              </NativeSelect>
              <FieldDescription>已优先选能识别出必填列的工作表</FieldDescription>
            </FieldContent>
          </Field>

          <Field
            v-for="field in fieldViews"
            :key="field.key"
            orientation="horizontal"
            :data-invalid="field.missing ? 'true' : undefined"
          >
            <FieldLabel :for="`mapping-${field.key}`" class="flex w-28 shrink-0 items-center gap-1">
              {{ field.label }}
              <Badge v-if="field.required" variant="secondary">必填</Badge>
            </FieldLabel>
            <FieldContent>
              <div class="flex flex-wrap items-center gap-1.5">
                <NativeSelect
                  :id="`mapping-${field.key}`"
                  class="w-[22rem] max-w-full"
                  :modelValue="field.value"
                  :aria-invalid="field.missing || undefined"
                  @update:modelValue="onMappingChange(field.key, $event)"
                >
                  <NativeSelectOption :value="-1" disabled>
                    {{ field.required ? "识别失败，请手动指定" : "不使用" }}
                  </NativeSelectOption>
                  <NativeSelectOption
                    v-for="option in headerOptions"
                    :key="option.value"
                    :value="option.value"
                  >
                    {{ option.label }}
                  </NativeSelectOption>
                </NativeSelect>
                <Button
                  v-if="field.mapped"
                  variant="ghost"
                  size="icon-sm"
                  :aria-label="`清除「${field.label}」的列映射`"
                  @click="setMapping(field.key, -1)"
                >
                  <XIcon />
                </Button>
              </div>

              <FieldDescription v-if="field.column">
                {{ field.auto ? "自动识别" : "手动指定" }}：{{ field.header || "(空表头)" }} →
                {{ field.column }} 列<template v-if="field.hint">（{{ field.hint }}）</template>
              </FieldDescription>
              <FieldError v-if="field.missing">识别失败，请手动指定</FieldError>
            </FieldContent>
          </Field>
        </FieldGroup>

        <Alert v-if="missingColumns.length > 0" variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>
            这些必填列需要手动指定：{{
              missingColumns.map((field) => field.label).join("、")
            }}，请在下面手动指定
          </AlertTitle>
          <AlertDescription>
            准考证号列叫「学号 / 准考证号 / 考证号」都能认；表头带空格（如「班 级」「姓
            名」）也会自动归一化识别。
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>

    <Card v-if="roster.total > 0">
      <CardHeader>
        <CardTitle>名单概况</CardTitle>
      </CardHeader>

      <CardContent class="flex flex-col gap-4">
        <dl class="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div class="bg-muted/40 flex flex-col gap-0.5 rounded-lg border px-3 py-2">
            <dt class="text-muted-foreground text-xs">总人数</dt>
            <dd class="text-lg font-semibold">{{ roster.total }}</dd>
          </div>
          <div class="bg-muted/40 flex flex-col gap-0.5 rounded-lg border px-3 py-2">
            <dt class="text-muted-foreground text-xs">班级数</dt>
            <dd class="text-lg font-semibold">{{ roster.classCount }}</dd>
          </div>
          <div class="bg-muted/40 flex flex-col gap-0.5 rounded-lg border px-3 py-2">
            <dt class="text-muted-foreground text-xs">问题行（错误）</dt>
            <dd
              class="text-lg font-semibold"
              :class="roster.issueCount.errors > 0 ? 'text-destructive' : undefined"
            >
              {{ roster.issueCount.errors }}
            </dd>
          </div>
          <div class="bg-muted/40 flex flex-col gap-0.5 rounded-lg border px-3 py-2">
            <dt class="text-muted-foreground text-xs">问题行（提醒）</dt>
            <dd class="text-lg font-semibold">{{ roster.issueCount.warnings }}</dd>
          </div>
        </dl>

        <Alert v-if="absentColumnMapped">
          <TriangleAlertIcon />
          <AlertTitle>识别到缺考列</AlertTitle>
          <AlertDescription>
            {{ roster.absentMarked }} 人已标记为不参加（可在第 ② 步恢复）
          </AlertDescription>
        </Alert>

        <template v-if="hasCombination">
          <div class="flex items-center gap-3">
            <h3 class="text-sm font-medium">选科组合分布（{{ roster.subjectCount }} 人带选科）</h3>
            <Separator class="flex-1" />
          </div>
          <div class="flex flex-wrap gap-1.5">
            <Badge
              v-for="row in roster.combinationSizes"
              :key="row.combination"
              variant="secondary"
            >
              {{ row.combination }}：{{ row.count }} 人
            </Badge>
          </div>
          <Alert>
            <InfoIcon />
            <AlertTitle>
              名单里有选科：会自动按多场次编排（时段 → 考场 + 座位），结果页可导出按班级 /
              按考场两份表
            </AlertTitle>
          </Alert>
        </template>

        <div class="flex items-center gap-3">
          <h3 class="text-sm font-medium">各班人数</h3>
          <Separator class="flex-1" />
        </div>
        <div class="flex flex-wrap gap-1.5">
          <Badge v-for="row in classRows" :key="row.className" variant="outline">
            {{ row.className }}：{{ row.count }} 人
          </Badge>
        </div>

        <template v-if="issuesSorted.length > 0">
          <div class="flex items-center gap-3">
            <h3 class="text-sm font-medium">
              问题行（共 {{ issuesSorted.length }} 条，最多展示 100 条）
            </h3>
            <Separator class="flex-1" />
          </div>
          <VirtualTable
            :rows="issuePreview"
            :row-key="issueKey"
            :columns="issueColumns"
            :height="320"
            :row-height="36"
          >
            <template #cell-level="{ row }">
              <Badge :variant="asIssue(row).level === 'error' ? 'destructive' : 'secondary'">
                {{ asIssue(row).level === "error" ? "错误" : "提醒" }}
              </Badge>
            </template>
            <template #empty>
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon"><InboxIcon /></EmptyMedia>
                  <EmptyTitle>没有问题行</EmptyTitle>
                  <EmptyDescription>名单里没发现缺列或重复的学号</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </template>
          </VirtualTable>
        </template>
      </CardContent>
    </Card>

    <div class="flex justify-end">
      <Button :disabled="roster.total === 0" @click="router.push('/exclude')">
        下一步：排除缺考
        <ArrowRightIcon data-icon="inline-end" />
      </Button>
    </div>
  </div>
</template>
