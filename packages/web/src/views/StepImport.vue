<script setup lang="ts">
import { ElMessage } from "element-plus";
import type { UploadFile } from "element-plus";
import { computed } from "vue";
import { useRouter } from "vue-router";

import { readFileBytes } from "@/lib/download";
import { useRosterStore } from "@/stores/roster";
import type { RosterMapping } from "@exam-seat/io";

/** 第 ① 步：导入名单。拖拽 / 选择 .xlsx → readRoster 解析 → 展示自动列映射，允许手动改列。 */
const roster = useRosterStore();
const router = useRouter();

const mappingFields: { key: keyof RosterMapping; label: string; required: boolean }[] = [
  { key: "id", label: "学号", required: true },
  { key: "name", label: "姓名", required: true },
  { key: "className", label: "班级", required: true },
  { key: "gender", label: "性别", required: false },
  { key: "combination", label: "选科", required: false },
  { key: "note", label: "备注", required: false },
];

const columnLetter = (index: number): string => {
  let value = index;
  let label = "";
  do {
    label = String.fromCodePoint(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return label;
};

const headerOptions = computed(() =>
  roster.headers.map((header, index) => ({
    value: index,
    label: `${columnLetter(index)} 列：${header || "(空表头)"}`,
  })),
);

const mappingValue = (key: keyof RosterMapping): number => roster.mapping?.[key] ?? -1;

const issuesSorted = computed(() =>
  [...roster.issues].sort((a, b) =>
    a.level === b.level ? a.row - b.row : a.level === "error" ? -1 : 1,
  ),
);
const issuePreview = computed(() => issuesSorted.value.slice(0, 100));

const hasCombination = computed(() => roster.combinationSizes.length > 0);

const classRows = computed(() =>
  [...roster.classSizes].sort((a, b) => a.className.localeCompare(b.className, "zh")),
);

const missingColumns = computed(() => {
  const { mapping } = roster;
  if (roster.total > 0) return [] as string[];
  return ["id", "name", "className"].filter((key) => {
    const value = mapping?.[key as keyof RosterMapping];
    return value == null || value < 0;
  });
});

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
            需要包含「学号 / 姓名 / 班级」三列，其余列自动忽略；性别、备注可选
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
          ｜自动识别结果，认错了就在这里改（{{ roster.fileName || "未命名文件" }}）
        </span>
      </template>

      <el-form label-width="88px" class="mapping-form">
        <el-form-item v-if="roster.sheetNames.length > 1" label="工作表">
          <el-select
            :model-value="roster.sheetName"
            style="width: 320px"
            @update:model-value="roster.selectSheet($event)"
          >
            <el-option v-for="name in roster.sheetNames" :key="name" :value="name" :label="name" />
          </el-select>
        </el-form-item>

        <el-form-item v-for="field in mappingFields" :key="field.key" :label="field.label">
          <el-select
            :model-value="mappingValue(field.key)"
            :placeholder="field.required ? '必须指定' : '不使用'"
            clearable
            style="width: 320px"
            @update:model-value="setMapping(field.key, $event ?? -1)"
          >
            <el-option
              v-for="option in headerOptions"
              :key="option.value"
              :value="option.value"
              :label="option.label"
            />
          </el-select>
          <el-tag v-if="field.required && mappingValue(field.key) < 0" type="danger" class="ml">
            必填
          </el-tag>
        </el-form-item>
      </el-form>

      <el-alert
        v-if="missingColumns.length > 0"
        type="error"
        :closable="false"
        show-icon
        :title="`还认不出这些必填列：${missingColumns
          .map((k) => mappingFields.find((f) => f.key === k)?.label)
          .join('、')}，请手动指定`"
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
          title="名单里有选科：core 已经能按时段冲突推导场次（多场次排考）。网页第 ⑤ 步的「场次编排」界面仍在实施中（见 docs/design.md §5.7），当前网页按单场求解；需要多场次请用 CLI 的 exam-seat plan（加 --single 可强制单场）。"
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
        <el-table :data="issuePreview" size="small" border max-height="320">
          <el-table-column prop="row" label="Excel 行号" width="110" />
          <el-table-column label="级别" width="90">
            <template #default="{ row }">
              <el-tag :type="row.level === 'error' ? 'danger' : 'warning'" size="small">
                {{ row.level === "error" ? "错误" : "提醒" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="message" label="说明" />
        </el-table>
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
  max-width: 640px;
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
