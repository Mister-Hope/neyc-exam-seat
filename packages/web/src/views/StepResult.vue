<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";

import DiagnosticsPanel from "@/components/DiagnosticsPanel.vue";
import SeatGridPreview from "@/components/SeatGridPreview.vue";
import { useExamJob } from "@/composables/useExamJob";
import { XLSX_MIME, downloadBytes, downloadText } from "@/lib/download";
import { filterStudents } from "@/lib/search";
import type { SeatOccupant } from "@/lib/seat-grid";
import { useResultStore } from "@/stores/result";
import { fingerprint } from "@exam-seat/core";
import type { PlanEntry } from "@exam-seat/core";
import { buildPlanWorkbook } from "@exam-seat/io";

/**
 * 第 ⑥ 步：结果名单。主输出就是这张表（考场 / 座位号 / 学号 / 姓名 / 班级）， 按「考场号 → 座位号」升序；座位网格只作页面预览。 导出前先看独立校验器 `validate()`
 * 的报告，报告不过会拦一道。
 */
const resultStore = useResultStore();
const { job } = useExamJob();
const router = useRouter();

const query = ref("");
const classFilter = ref<string[]>([]);
const roomFilter = ref<string[]>([]);
const previewRoomId = ref<string>("");

const roomNameById = computed(() => {
  const map = new Map<string, string>();
  for (const item of resultStore.roomList) map.set(item.id, item.name);
  return map;
});

const rows = computed<PlanEntry[]>(() => {
  const matched = new Set(
    filterStudents(
      resultStore.sortedEntries.map((entry) => ({
        id: entry.studentId,
        name: entry.name,
        className: entry.className,
      })),
      { text: query.value, classNames: classFilter.value },
    ).map((item) => item.id),
  );
  const roomSet = roomFilter.value.length > 0 ? new Set(roomFilter.value) : null;
  return resultStore.sortedEntries.filter((entry) => {
    if (!matched.has(entry.studentId)) return false;
    if (roomSet && !roomSet.has(entry.roomId)) return false;
    return true;
  });
});

const previewRoom = computed(() =>
  (resultStore.job?.rooms ?? []).find((room) => room.id === previewRoomId.value),
);

const previewOccupants = computed(() => {
  const map = new Map<number, SeatOccupant>();
  for (const entry of resultStore.entries) {
    if (entry.roomId !== previewRoomId.value) continue;
    map.set(entry.seatNo, {
      studentId: entry.studentId,
      name: entry.name,
      className: entry.className,
    });
  }
  return map;
});

/** 当前配置与这份结果的数据指纹是否一致：改过名单/考场/限定就该重排。 */
const stale = computed(() => {
  const { result } = resultStore;
  if (!result) return false;
  try {
    return fingerprint(job.value) !== result.inputFingerprint;
  } catch {
    return false;
  }
});

const report = computed(() => resultStore.report);
const reportErrors = computed(() =>
  (report.value?.issues ?? []).filter((i) => i.severity === "error"),
);
const reportWarnings = computed(() =>
  (report.value?.issues ?? []).filter((i) => i.severity === "warning"),
);

const degradedBanner = computed(() => {
  const { result } = resultStore;
  if (!result) return null;
  if (!result.ok) return { type: "error" as const, title: "这份结果没有排满，请先看下面的诊断" };
  if (result.level !== "strict") {
    return {
      type: "warning" as const,
      title: `已降级：level = ${result.level}，导出的校验报告里会写明`,
    };
  }
  return { type: "success" as const, title: "完美：零冲突，全部限定满足" };
});

async function exportWorkbook(): Promise<void> {
  const { result } = resultStore;
  if (!result) return;
  if (report.value && !report.value.ok) {
    try {
      await ElMessageBox.confirm(
        `独立校验器报了 ${reportErrors.value.length} 个错误，按规矩不该导出。确实要导出这份仅供人工微调的名单吗？`,
        "校验未通过",
        { type: "warning", confirmButtonText: "仍然导出", cancelButtonText: "先修问题" },
      );
    } catch {
      return;
    }
  }
  const title = resultStore.job?.meta?.title ?? "考场安排";
  const bytes = buildPlanWorkbook(result, title);
  downloadBytes(bytes, `${title}-考场安排名单.xlsx`, XLSX_MIME);
  ElMessage.success("已导出：考场安排名单.xlsx（名单 / 按班级 / 校验报告）");
}

function exportPlanJson(): void {
  if (!resultStore.result) return;
  downloadText(JSON.stringify(resultStore.result, null, 2), "plan.json");
}
</script>

<template>
  <div class="step-page">
    <el-empty v-if="!resultStore.hasResult" description="还没有求解结果，先去「排考场」">
      <el-button type="primary" @click="router.push('/solve')">去排考场</el-button>
    </el-empty>

    <template v-else>
      <el-alert
        v-if="stale"
        class="mb"
        type="warning"
        :closable="false"
        show-icon
        title="当前配置已经改过，这份结果是旧配置算出来的；导出的名单还是旧结果，建议回「排考场」重跑一次"
      />

      <el-alert
        v-if="degradedBanner"
        class="mb"
        :type="degradedBanner.type === 'warning' ? 'warning' : degradedBanner.type"
        :closable="false"
        show-icon
        :title="degradedBanner.title"
      />

      <el-card shadow="never">
        <template #header>
          <strong>结果名单</strong>
          <span class="muted"
            >｜按考场号 → 座位号升序，共 {{ rows.length }} /
            {{ resultStore.entries.length }} 条</span
          >
        </template>

        <el-form inline>
          <el-form-item label="搜人 / 搜位">
            <el-input
              v-model="query"
              placeholder="学号 / 姓名 / 班级，空格分隔多个条件"
              clearable
              style="width: 320px"
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
              style="width: 260px"
            >
              <el-option
                v-for="name in resultStore.classNames"
                :key="name"
                :value="name"
                :label="name"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="考场">
            <el-select
              v-model="roomFilter"
              multiple
              collapse-tags
              collapse-tags-tooltip
              clearable
              placeholder="全部考场"
              style="width: 260px"
            >
              <el-option
                v-for="room in resultStore.roomList"
                :key="room.id"
                :value="room.id"
                :label="room.name"
              />
            </el-select>
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="exportWorkbook">导出 xlsx</el-button>
            <el-button @click="exportPlanJson">导出 plan.json</el-button>
          </el-form-item>
        </el-form>

        <el-table :data="rows" size="small" border height="480">
          <el-table-column label="考场" width="140">
            <template #default="{ row }">
              {{ roomNameById.get(row.roomId) ?? row.roomName }}
            </template>
          </el-table-column>
          <el-table-column prop="seatNo" label="座位号" width="90" />
          <el-table-column prop="studentId" label="学号" width="140" />
          <el-table-column prop="name" label="姓名" width="110" />
          <el-table-column prop="className" label="班级" min-width="140" />
          <el-table-column label="位置" width="160">
            <template #default="{ row }">第{{ row.row }}排 · 靠门侧第{{ row.col }}列</template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card class="mt" shadow="never">
        <template #header
          ><strong>校验报告</strong>（独立校验器 validate()，与求解器分开实现）</template
        >

        <el-alert
          v-if="report && report.ok && reportWarnings.length === 0"
          type="success"
          :closable="false"
          show-icon
          title="校验通过：容量、邻域、限定、编号一致性全部满足"
        />
        <el-alert
          v-else-if="report && report.ok"
          type="warning"
          :closable="false"
          show-icon
          :title="`校验通过，但有 ${reportWarnings.length} 条提醒`"
        />
        <el-alert
          v-else-if="report"
          type="error"
          :closable="false"
          show-icon
          :title="`校验未通过：${reportErrors.length} 个错误，${reportWarnings.length} 条提醒`"
        />

        <el-table
          v-if="report && report.issues.length > 0"
          class="mt"
          :data="report.issues"
          size="small"
          border
          max-height="240"
        >
          <el-table-column label="级别" width="90">
            <template #default="{ row }">
              <el-tag :type="row.severity === 'error' ? 'danger' : 'warning'" size="small">
                {{ row.severity === "error" ? "错误" : "提醒" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="code" label="代码" width="220" />
          <el-table-column prop="message" label="说明" />
        </el-table>

        <el-descriptions class="mt" :column="4" border>
          <el-descriptions-item label="考生">{{
            resultStore.result?.stats.participants
          }}</el-descriptions-item>
          <el-descriptions-item label="班级数">{{
            resultStore.result?.stats.classes
          }}</el-descriptions-item>
          <el-descriptions-item label="考场数">
            {{ resultStore.result?.stats.roomsUsed }} / {{ resultStore.result?.stats.rooms }}
          </el-descriptions-item>
          <el-descriptions-item label="座位数">
            {{ resultStore.result?.stats.seatsUsed }} / {{ resultStore.result?.stats.seatsTotal }}
          </el-descriptions-item>
          <el-descriptions-item label="冲突数">{{
            resultStore.result?.stats.conflicts
          }}</el-descriptions-item>
          <el-descriptions-item label="未满足限定">
            {{ resultStore.result?.stats.unmetConstraints }}
          </el-descriptions-item>
          <el-descriptions-item label="种子">{{
            resultStore.result?.stats.seed
          }}</el-descriptions-item>
          <el-descriptions-item label="耗时"
            >{{ resultStore.result?.stats.elapsedMs }} ms</el-descriptions-item
          >
        </el-descriptions>
      </el-card>

      <el-card v-if="(resultStore.result?.conflicts.length ?? 0) > 0" class="mt" shadow="never">
        <template #header><strong>冲突明细</strong>（同考场相邻同班）</template>
        <el-table :data="resultStore.result?.conflicts ?? []" size="small" border max-height="240">
          <el-table-column label="考场" width="140">
            <template #default="{ row }">{{ roomNameById.get(row.roomId) ?? row.roomId }}</template>
          </el-table-column>
          <el-table-column prop="seatA" label="座位A" width="90" />
          <el-table-column prop="seatB" label="座位B" width="90" />
          <el-table-column prop="studentA" label="学生A" width="140" />
          <el-table-column prop="studentB" label="学生B" width="140" />
          <el-table-column prop="className" label="班级" />
        </el-table>
      </el-card>

      <el-card
        v-if="(resultStore.result?.unmetConstraints.length ?? 0) > 0"
        class="mt"
        shadow="never"
      >
        <template #header><strong>未满足的限定</strong></template>
        <el-table :data="resultStore.result?.unmetConstraints ?? []" size="small" border>
          <el-table-column prop="constraintId" label="限定 ID" width="120" />
          <el-table-column label="涉及学生" min-width="200">
            <template #default="{ row }">{{ row.studentIds.length }} 人</template>
          </el-table-column>
          <el-table-column prop="reason" label="原因" />
        </el-table>
      </el-card>

      <el-card v-if="(resultStore.result?.diagnostics.length ?? 0) > 0" class="mt" shadow="never">
        <template #header><strong>诊断</strong></template>
        <DiagnosticsPanel :diagnostics="resultStore.result?.diagnostics ?? []" show-evidence />
      </el-card>

      <el-card class="mt" shadow="never">
        <template #header
          ><strong>座位网格预览</strong>（只作页面预览，正式交付是上面的名单）</template
        >
        <el-select
          v-model="previewRoomId"
          clearable
          placeholder="选一个考场看座位"
          style="width: 260px"
        >
          <el-option
            v-for="room in resultStore.roomList"
            :key="room.id"
            :value="room.id"
            :label="room.name"
          />
        </el-select>
        <div v-if="previewRoom" class="mt">
          <SeatGridPreview :room="previewRoom" :occupants="previewOccupants" />
        </div>
        <div v-else class="hint">选了考场后，这里会按物理列序画出每个座位上的学生。</div>
      </el-card>

      <div class="step-actions">
        <el-button @click="router.push('/solve')">上一步</el-button>
        <el-button type="primary" @click="exportWorkbook">导出 考场安排名单.xlsx</el-button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.mb {
  margin-bottom: 10px;
}
.mt {
  margin-top: 12px;
}
.muted {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.hint {
  margin-top: 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.step-actions {
  margin-top: 16px;
  display: flex;
  justify-content: space-between;
}
</style>
