<script setup lang="ts">
import { ElMessage } from "element-plus";
import type { UploadFile } from "element-plus";
import { computed } from "vue";
import { useRouter } from "vue-router";

import VirtualTable from "@/components/VirtualTable.vue";
import type { VirtualTableColumn } from "@/components/VirtualTable.vue";
import { readFileBytes } from "@/lib/download";
import { columnLabel } from "@/lib/roster-import";
import { useRosterStore } from "@/stores/roster";
import { suggestMapping } from "@exam-seat/io";
import type { RosterIssue, RosterMapping } from "@exam-seat/io";

/** 第 ① 步：导入名单。拖拽 / 选择 .xlsx → 自动选表 + 自动预填列映射，认不出的必填列标红； 名单里带「缺考」列时自动标记 `included:false`。 */
const roster = useRosterStore();
const router = useRouter();

const mappingFields: {
  key: keyof RosterMapping;
  label: string;
  required: boolean;
  hint?: string;
}[] = [
  { key: "id", label: "准考证号", required: true, hint: "学号 / 准考证号 / 考证号" },
  { key: "name", label: "姓名", required: true },
  { key: "className", label: "班级", required: true },
  { key: "absent", label: "缺考", required: false, hint: "有内容即不参加" },
  { key: "gender", label: "性别", required: false },
  { key: "combination", label: "选科", required: false },
  { key: "note", label: "备注", required: false },
];

const headerOptions = computed(() =>
  roster.headers.map((header, index) => ({
    value: index,
    label: `${columnLabel(index)} 列：${header || "(空表头)"}`,
  })),
);

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
      /** 没映射时给 undefined，让下拉显示 placeholder 而不是 "-1"。 */
      value: index < 0 ? undefined : index,
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

async function handleFile(file: File | undefined): Promise<void> {
  if (!file) return;
  if (!/\.(?:xlsx|xls)$/i.test(file.name)) {
    ElMessage.error("只支持 .xlsx / .xls 文件");
    return;
  }
  try {
    roster.importBytes(await readFileBytes(file), file.name);
    if (roster.total > 0) ElMessage.success(`读到 ${roster.total} 名学生`);
    else if (roster.errorMessage) ElMessage.warning(roster.errorMessage);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  }
}

function onUploadChange(file: UploadFile): void {
  void handleFile(file.raw);
}

function setMapping(key: keyof RosterMapping, value: number): void {
  roster.updateMapping({ [key]: value } as Partial<RosterMapping>);
}
</script>

<template>
  <div class="step-page">
    <el-card shadow="never">
      <template #header><strong>导入名单</strong>（.xlsx，第一行为表头）</template>

      <el-upload
        drag
        accept=".xlsx,.xls"
        :auto-upload="false"
        :show-file-list="false"
        :on-change="onUploadChange"
      >
        <div class="upload-inner">
          <div class="upload-title">把 Excel 名单拖到这里，或点击选择</div>
          <div class="upload-sub">
            需要包含「准考证号（学号 / 考证号）/ 姓名 / 班级」三列，其余列自动忽略；列映射会自动预填
          </div>
        </div>
      </el-upload>

      <div class="row-actions">
        <el-button @click="roster.loadDemo()">载入示例名单（18 个班 × 54 人）</el-button>
        <el-button v-if="roster.total > 0" @click="roster.reset()">清空名单</el-button>
      </div>

      <el-alert
        v-if="roster.errorMessage"
        class="mt"
        type="warning"
        :closable="false"
        show-icon
        :title="roster.errorMessage"
      />
    </el-card>

    <el-card v-if="roster.total > 0 || roster.headers.length > 0" class="mt" shadow="never">
      <template #header>
        <strong>列映射</strong>
        <span class="muted">
          ｜已自动识别 {{ recognizedRequired }}/{{ requiredCount }} 个必填列，认错了就在这里改（{{
            roster.fileName || "未命名文件"
          }}）
        </span>
      </template>

      <el-form label-width="96px" class="mapping-form">
        <el-form-item v-if="roster.sheetNames.length > 1" label="工作表">
          <el-select
            :model-value="roster.sheetName"
            style="width: 360px"
            @update:model-value="roster.selectSheet($event)"
          >
            <el-option v-for="name in roster.sheetNames" :key="name" :value="name" :label="name" />
          </el-select>
          <span class="ml muted">已优先选能识别出必填列的工作表</span>
        </el-form-item>

        <el-form-item
          v-for="field in fieldViews"
          :key="field.key"
          :label="field.label"
          :error="field.missing ? '没认出来，请手动指定' : undefined"
        >
          <el-select
            :model-value="field.value"
            :placeholder="field.required ? '还没认出来，请手动指定' : '不使用'"
            clearable
            style="width: 360px"
            @update:model-value="setMapping(field.key, $event ?? -1)"
          >
            <el-option
              v-for="option in headerOptions"
              :key="option.value"
              :value="option.value"
              :label="option.label"
            />
          </el-select>
          <el-tag v-if="field.required" type="info" class="ml">必填</el-tag>
          <div v-if="field.column" class="mapping-hint">
            {{ field.auto ? "自动识别" : "手动指定" }}：{{ field.header || "(空表头)" }} →
            {{ field.column }} 列<template v-if="field.hint">（{{ field.hint }}）</template>
          </div>
        </el-form-item>
      </el-form>

      <el-alert
        v-if="missingColumns.length > 0"
        type="error"
        :closable="false"
        show-icon
        :title="`没认出来这些必填列：${missingColumns
          .map((field) => field.label)
          .join('、')}，请在下面手动指定`"
        description="准考证号列叫「学号 / 准考证号 / 考证号」都能认；表头带空格（如「班 级」「姓 名」）也会自动归一化识别。"
      />
    </el-card>

    <el-card v-if="roster.total > 0" class="mt" shadow="never">
      <template #header><strong>名单概况</strong></template>
      <el-row :gutter="12">
        <el-col :span="6"><el-statistic title="总人数" :value="roster.total" /></el-col>
        <el-col :span="6"><el-statistic title="班级数" :value="roster.classCount" /></el-col>
        <el-col :span="6">
          <el-statistic title="问题行（错误）" :value="roster.issueCount.errors" />
        </el-col>
        <el-col :span="6">
          <el-statistic title="问题行（提醒）" :value="roster.issueCount.warnings" />
        </el-col>
      </el-row>

      <el-alert
        v-if="absentColumnMapped"
        class="mt"
        type="warning"
        :closable="false"
        show-icon
        title="识别到缺考列"
        :description="`${roster.absentMarked} 人已标记为不参加（可在第 ② 步恢复）`"
      />

      <template v-if="hasCombination">
        <el-divider content-position="left">
          选科组合分布（{{ roster.subjectCount }} 人带选科）
        </el-divider>
        <el-space wrap>
          <el-tag v-for="row in roster.combinationSizes" :key="row.combination" type="success">
            {{ row.combination }}：{{ row.count }} 人
          </el-tag>
        </el-space>
        <el-alert
          class="mt"
          type="info"
          :closable="false"
          show-icon
          title="名单里有选科：会自动按多场次编排（时段 → 考场 + 座位），结果页可导出按班级 / 按考场两份表"
        />
      </template>

      <el-divider content-position="left">各班人数</el-divider>
      <el-space wrap>
        <el-tag v-for="row in classRows" :key="row.className" type="info">
          {{ row.className }}：{{ row.count }} 人
        </el-tag>
      </el-space>

      <template v-if="issuesSorted.length > 0">
        <el-divider content-position="left">
          问题行（共 {{ issuesSorted.length }} 条，最多展示 100 条）
        </el-divider>
        <VirtualTable
          :rows="issuePreview"
          :row-key="issueKey"
          :columns="issueColumns"
          :height="320"
          :row-height="36"
        >
          <template #cell-level="{ row }">
            <el-tag :type="asIssue(row).level === 'error' ? 'danger' : 'warning'" size="small">
              {{ asIssue(row).level === "error" ? "错误" : "提醒" }}
            </el-tag>
          </template>
          <template #empty>
            <el-empty description="没有问题行" :image-size="60" />
          </template>
        </VirtualTable>
      </template>
    </el-card>

    <div class="step-actions">
      <el-button type="primary" :disabled="roster.total === 0" @click="router.push('/exclude')">
        下一步：排除缺考
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.upload-inner {
  padding: 18px 0;
}
.upload-title {
  font-size: 15px;
  color: var(--el-text-color-primary);
}
.upload-sub {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.mapping-form {
  max-width: 720px;
}
.mapping-hint {
  flex-basis: 100%;
  margin-top: 2px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.row-actions {
  margin-top: 12px;
}
.muted {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.ml {
  margin-left: 8px;
}
.mt {
  margin-top: 12px;
}
.step-actions {
  margin-top: 16px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
