<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";

import DiagnosticsPanel from "@/components/DiagnosticsPanel.vue";
import SeatGridPreview from "@/components/SeatGridPreview.vue";
import VirtualTable from "@/components/VirtualTable.vue";
import { useExamJob } from "@/composables/useExamJob";
import { XLSX_MIME, downloadBytes, downloadText } from "@/lib/download";
import { filterStudents } from "@/lib/search";
import type { SeatOccupant } from "@/lib/seat-grid";
import {
  buildScheduleTable,
  buildSeatingChecks,
  buildSeatingOverview,
  changedByClass,
  collectMultiDiagnostics,
  collectSeatingConflicts,
  collectSeatingUnmet,
  countChangedStudents,
  filterScheduleRows,
  makeRoomLookup,
} from "@/lib/session-export";
import type { ScheduleColumn } from "@/lib/session-export";
import { useResultStore } from "@/stores/result";
import { fingerprint } from "@exam-seat/core";
import type { PlanEntry } from "@exam-seat/core";
import {
  buildClassScheduleWorkbook,
  buildInvigilatorWorkbook,
  buildPlanWorkbook,
} from "@exam-seat/io";

/**
 * 第 ⑥ 步：结果名单。
 *
 * 单场：主输出就是这张表（考场 / 座位号 / 学号 / 姓名 / 班级），按「考场号 → 座位号」升序； 座位网格只作页面预览；导出前先看独立校验器 `validate()` 的报告。
 *
 * 多场次（名单带选科）：主输出是「每人：时段 → 考场 + 座位」，另出座位方案概览、校验摘要、 空置考场，并导出「按班级考场安排.xlsx」与「考场监考表.xlsx」（io 的两个多场次函数）。
 */
const resultStore = useResultStore();
const { job } = useExamJob();
const router = useRouter();

const query = ref("");
const classFilter = ref<string[]>([]);
const roomFilter = ref<string[]>([]);
const previewRoomId = ref<string>("");

const multiQuery = ref("");
const multiClassFilter = ref<string[]>([]);

/** 多场次结果（mode === "all"）走另一套展示。 */
const isMulti = computed(() => resultStore.hasMultiResult);
const hasAnything = computed(() => resultStore.hasResult || resultStore.hasMultiResult);

const roomNameById = computed(() => {
  const map = new Map<string, string>();
  for (const item of resultStore.roomList) map.set(item.id, item.name);
  return map;
});

/* ------------------------------------------------------------------ */
/* 单场：结果主表                                                       */
/* ------------------------------------------------------------------ */

/** 列定义固定，渲染交给 VirtualTable；数据仍是「store 全量 + 计算属性过滤」。 */
const entryColumns: ScheduleColumn[] = [
  { key: "room", title: "考场", width: 140 },
  { key: "seatNo", title: "座位号", width: 90 },
  { key: "studentId", title: "学号", width: 140 },
  { key: "name", title: "姓名", width: 110 },
  { key: "className", title: "班级", width: 140 },
  { key: "position", title: "位置", width: 160 },
];

function entryRowKey(row: unknown): string {
  const entry = row as PlanEntry;
  return `${entry.roomId}:${entry.seatNo}`;
}

/** VirtualTable 单元格默认渲染 store 里的字段；这里统一转成字符串。 */
function cellText(row: unknown, key: string): string {
  const value = (row as Record<string, unknown>)[key];
  return value == null ? "" : String(value);
}

function entryRoom(row: unknown): string {
  const entry = row as PlanEntry;
  return roomNameById.value.get(entry.roomId) ?? entry.roomName;
}

function entryPosition(row: unknown): string {
  const entry = row as PlanEntry;
  return `第${entry.row}排 · 靠门侧第${entry.col}列`;
}

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

/* ------------------------------------------------------------------ */
/* 多场次：展示数据（全部来自 session-export.ts 的纯函数）               */
/* ------------------------------------------------------------------ */

const planAll = computed(() => resultStore.planAll);
const scheduleTable = computed(() =>
  buildScheduleTable(resultStore.scheduleByStudent, resultStore.slots),
);
const multiRows = computed(() =>
  filterScheduleRows(scheduleTable.value.rows, {
    text: multiQuery.value,
    classNames: multiClassFilter.value,
  }),
);
const multiClassNames = computed(() =>
  [...new Set(resultStore.scheduleByStudent.map((student) => student.className))].sort((a, b) =>
    a.localeCompare(b, "zh"),
  ),
);
const seatingOverview = computed(() => buildSeatingOverview(resultStore.seatings));
const seatingChecks = computed(() => buildSeatingChecks(resultStore.seatings));
const seatingConflicts = computed(() => collectSeatingConflicts(resultStore.seatings));
const seatingUnmet = computed(() => collectSeatingUnmet(resultStore.seatings));
const multiDiagnostics = computed(() => collectMultiDiagnostics(planAll.value));
const changedCount = computed(() => countChangedStudents(resultStore.scheduleByStudent));
const changedClasses = computed(() => changedByClass(resultStore.scheduleByStudent));
const overRoomLimit = computed(() => planAll.value?.overRoomLimit ?? []);
const emptyRoomNames = computed(() => resultStore.emptyRoomNames);
const slotCount = computed(() => resultStore.slots.length);

const multiBanner = computed(() => {
  const result = planAll.value;
  if (!result) return { type: "error" as const, title: "没有多场次结果" };
  const conflicts = seatingConflicts.value.length;
  if (!result.ok || conflicts > 0) {
    return {
      type: "error" as const,
      title: `多场次结果没有排满：${conflicts} 条冲突、${seatingUnmet.value.length} 条未满足限定，请先看下面的校验摘要`,
    };
  }
  return {
    type: "success" as const,
    title: `多场次编排完成：${slotCount.value} 个时段 · ${result.seatings.length} 套座位方案 · ${changedCount.value} 人需要换考场`,
  };
});

function scheduleRowKey(row: unknown): string {
  return (row as { key: string }).key;
}

function scheduleCellText(row: unknown, slotId: string): string {
  const { cells } = row as { cells: Record<string, string> };
  return cells?.[slotId] ?? "—";
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

/** 校验不过时的二次确认，返回 true = 用户坚持导出。 */
async function confirmRiskyExport(message: string): Promise<boolean> {
  try {
    await ElMessageBox.confirm(message, "校验未通过", {
      type: "warning",
      confirmButtonText: "仍然导出",
      cancelButtonText: "先修问题",
    });
    return true;
  } catch {
    return false;
  }
}

async function exportWorkbook(): Promise<void> {
  const { result } = resultStore;
  if (!result) return;
  if (
    report.value &&
    !report.value.ok &&
    !(await confirmRiskyExport(
      `独立校验器报了 ${reportErrors.value.length} 个错误，按规矩不该导出。确实要导出这份仅供人工微调的名单吗？`,
    ))
  ) {
    return;
  }
  const title = resultStore.job?.meta?.title ?? "考场安排";
  const bytes = buildPlanWorkbook(result, title);
  downloadBytes(bytes, `${title}-考场安排名单.xlsx`, XLSX_MIME);
  ElMessage.success("已导出：考场安排名单.xlsx（名单 / 按班级 / 校验报告）");
}

/** 多场次结果的冲突 / 未排满检查（导出前拦一道）。 */
function multiRisky(): boolean {
  const result = planAll.value;
  return result != null && (!result.ok || seatingConflicts.value.length > 0);
}

async function exportClassSchedule(): Promise<void> {
  const result = planAll.value;
  if (!result) return;
  if (
    multiRisky() &&
    !(await confirmRiskyExport(
      `这份多场次结果有 ${seatingConflicts.value.length} 条冲突、${seatingUnmet.value.length} 条未满足限定，确实要导出「按班级考场安排.xlsx」吗？`,
    ))
  ) {
    return;
  }
  downloadBytes(buildClassScheduleWorkbook(result), "按班级考场安排.xlsx", XLSX_MIME);
  ElMessage.success("已导出：按班级考场安排.xlsx（按班级 + 各班换考场人数）");
}

async function exportInvigilator(): Promise<void> {
  const result = planAll.value;
  if (!result) return;
  if (
    multiRisky() &&
    !(await confirmRiskyExport(
      `这份多场次结果有 ${seatingConflicts.value.length} 条冲突、${seatingUnmet.value.length} 条未满足限定，确实要导出「考场监考表.xlsx」吗？`,
    ))
  ) {
    return;
  }
  const roomLookup = makeRoomLookup(job.value?.rooms ?? []);
  downloadBytes(buildInvigilatorWorkbook(result, roomLookup), "考场监考表.xlsx", XLSX_MIME);
  ElMessage.success("已导出：考场监考表.xlsx（每个考场一套座位一张表）");
}

function exportPlanJson(): void {
  const payload = resultStore.result ?? resultStore.planAll;
  if (!payload) return;
  downloadText(JSON.stringify(payload, null, 2), "plan.json");
}

/** 按求解结果移除空置考场（同时改 job 与考场 store，之后需要重排）。 */
async function removeEmptyRooms(): Promise<void> {
  const names = emptyRoomNames.value;
  if (names.length === 0) return;
  try {
    await ElMessageBox.confirm(
      `有 ${names.length} 个考场一个学生都没安排：${names.join("、")}。移除后这份结果就作废了，需要回「排考场」重跑，确认移除？`,
      "移除空置考场",
      { type: "warning", confirmButtonText: "移除", cancelButtonText: "保留" },
    );
  } catch {
    return;
  }
  const { removed } = resultStore.removeEmptyRooms();
  if (removed.length > 0) {
    ElMessage.success(`已移除空置考场：${removed.join("、")}；配置已变，请回「排考场」重跑`);
  } else {
    ElMessage.info("没有需要移除的考场");
  }
}
</script>

<template>
  <div class="step-page">
    <el-empty v-if="!hasAnything" description="还没有求解结果，先去「排考场」">
      <el-button type="primary" @click="router.push('/solve')">去排考场</el-button>
    </el-empty>

    <template v-else>
      <!-- ============================ 多场次结果 ============================ -->
      <template v-if="isMulti">
        <el-alert
          v-if="multiBanner"
          class="mb"
          :type="multiBanner.type"
          :closable="false"
          show-icon
          :title="multiBanner.title"
        />

        <el-card shadow="never">
          <template #header>
            <strong>多场次总览</strong>
            <span class="muted"
              >｜{{ slotCount }} 个时段 · {{ seatingOverview.length }} 套座位方案 · 需要换考场
              {{ changedCount }} 人</span
            >
          </template>

          <el-descriptions :column="4" border>
            <el-descriptions-item label="时段数">{{ slotCount }}</el-descriptions-item>
            <el-descriptions-item label="座位方案">{{
              seatingOverview.length
            }}</el-descriptions-item>
            <el-descriptions-item label="考生">{{
              resultStore.scheduleByStudent.length
            }}</el-descriptions-item>
            <el-descriptions-item label="需要换考场">{{ changedCount }} 人</el-descriptions-item>
          </el-descriptions>

          <div class="mt slot-tags">
            <el-tag v-for="slot in resultStore.slots" :key="slot.id" type="info" size="small">
              {{ slot.name }}
            </el-tag>
          </div>

          <div v-if="changedClasses.length > 0" class="mt">
            <strong>需要换考场的人（按班）</strong>
          </div>
          <el-table
            v-if="changedClasses.length > 0"
            class="mt"
            :data="changedClasses"
            size="small"
            border
            max-height="240"
          >
            <el-table-column prop="className" label="班级" />
            <el-table-column prop="count" label="需要换考场人数" width="160" />
          </el-table>
        </el-card>

        <el-card class="mt" shadow="never">
          <template #header>
            <strong>时段 → 考场 + 座位</strong>
            <span class="muted"
              >｜共 {{ multiRows.length }} /
              {{ scheduleTable.rows.length }} 人，可按班级筛选或搜「某人坐哪」</span
            >
          </template>

          <el-form inline>
            <el-form-item label="搜人 / 搜位">
              <el-input
                v-model="multiQuery"
                placeholder="学号 / 姓名 / 班级 / 考场，空格分隔多个条件"
                clearable
                style="width: 320px"
              />
            </el-form-item>
            <el-form-item label="班级">
              <el-select
                v-model="multiClassFilter"
                multiple
                collapse-tags
                collapse-tags-tooltip
                clearable
                placeholder="全部班级"
                style="width: 260px"
              >
                <el-option
                  v-for="name in multiClassNames"
                  :key="name"
                  :value="name"
                  :label="name"
                />
              </el-select>
            </el-form-item>
          </el-form>

          <VirtualTable
            :rows="multiRows"
            :row-key="scheduleRowKey"
            :columns="scheduleTable.columns"
            :height="480"
            :row-height="40"
          >
            <template #cell-className="{ row }">{{ cellText(row, "className") }}</template>
            <template #cell-name="{ row }">{{ cellText(row, "name") }}</template>
            <template #cell-studentId="{ row }">{{ cellText(row, "studentId") }}</template>
            <template #cell-combination="{ row }">{{ cellText(row, "combinationLabel") }}</template>
            <template
              v-for="slot in resultStore.slots"
              :key="slot.id"
              #[`cell-${slot.id}`]="{ row }"
            >
              {{ scheduleCellText(row, slot.id) }}
            </template>
            <template #empty>
              <div class="hint">没有匹配的考生。</div>
            </template>
          </VirtualTable>
        </el-card>

        <el-card class="mt" shadow="never">
          <template #header>
            <strong>座位方案概览</strong>
            <span class="muted">｜考场 × 科目 × 人数（一套座位 = 一个考场里一批固定学生）</span>
          </template>
          <el-table :data="seatingOverview" size="small" border max-height="320">
            <el-table-column prop="roomName" label="考场" width="160" />
            <el-table-column prop="subjectsLabel" label="科目" width="160" />
            <el-table-column prop="studentCount" label="人数" width="90" />
            <el-table-column prop="location" label="地点" width="160" />
            <el-table-column prop="note" label="监考" />
          </el-table>
        </el-card>

        <el-card class="mt" shadow="never">
          <template #header>
            <strong>校验摘要</strong>
            <span class="muted">｜各套 result 的冲突汇总、未满足限定、考场数超限与诊断</span>
          </template>

          <el-alert
            v-if="
              seatingConflicts.length === 0 &&
              seatingUnmet.length === 0 &&
              overRoomLimit.length === 0
            "
            type="success"
            :closable="false"
            show-icon
            title="校验通过：各套座位方案零冲突、限定全满足、无人超过 3 个考场"
          />
          <el-alert
            v-else
            type="error"
            :closable="false"
            show-icon
            :title="`冲突 ${seatingConflicts.length} 条 · 未满足限定 ${seatingUnmet.length} 条 · 超考场限制 ${overRoomLimit.length} 人`"
          />

          <el-table class="mt" :data="seatingChecks" size="small" border max-height="240">
            <el-table-column prop="roomName" label="考场" width="160" />
            <el-table-column prop="subjectsLabel" label="科目" width="150" />
            <el-table-column prop="studentCount" label="人数" width="80" />
            <el-table-column label="状态" width="110">
              <template #default="{ row }">
                <el-tag :type="row.ok ? 'success' : 'danger'" size="small">
                  {{ row.ok ? "零冲突" : row.level }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="conflicts" label="冲突" width="80" />
            <el-table-column prop="unmetConstraints" label="未满足限定" width="110" />
            <el-table-column prop="diagnostics" label="诊断" width="80" />
          </el-table>

          <el-table
            v-if="seatingConflicts.length > 0"
            class="mt"
            :data="seatingConflicts"
            size="small"
            border
            max-height="240"
          >
            <el-table-column prop="roomName" label="考场" width="150" />
            <el-table-column prop="subjectsLabel" label="科目" width="130" />
            <el-table-column prop="seatA" label="座位A" width="80" />
            <el-table-column prop="seatB" label="座位B" width="80" />
            <el-table-column prop="studentA" label="学生A" width="130" />
            <el-table-column prop="studentB" label="学生B" width="130" />
            <el-table-column prop="className" label="班级" />
          </el-table>

          <el-table
            v-if="seatingUnmet.length > 0"
            class="mt"
            :data="seatingUnmet"
            size="small"
            border
            max-height="240"
          >
            <el-table-column prop="roomName" label="考场" width="150" />
            <el-table-column prop="constraintId" label="限定 ID" width="120" />
            <el-table-column prop="studentCount" label="涉及学生" width="100" />
            <el-table-column prop="reason" label="原因" />
          </el-table>

          <el-table
            v-if="overRoomLimit.length > 0"
            class="mt"
            :data="overRoomLimit"
            size="small"
            border
            max-height="240"
          >
            <el-table-column prop="studentId" label="学号" width="140" />
            <el-table-column prop="name" label="姓名" width="120" />
            <el-table-column prop="count" label="用到考场数" width="120" />
          </el-table>

          <div v-if="multiDiagnostics.length > 0" class="mt">
            <DiagnosticsPanel :diagnostics="multiDiagnostics" show-evidence />
          </div>
        </el-card>

        <el-card class="mt" shadow="never">
          <template #header>
            <strong>空置考场</strong>
            <span class="muted">｜排完之后一个学生都没安排的考场</span>
          </template>
          <template v-if="emptyRoomNames.length > 0">
            <el-alert
              type="warning"
              :closable="false"
              show-icon
              :title="`有 ${emptyRoomNames.length} 个空置考场：${emptyRoomNames.join('、')}，可以取消`"
            />
            <el-button class="mt" type="warning" @click="removeEmptyRooms"
              >一键移除空置考场</el-button
            >
          </template>
          <div v-else class="hint">没有空置考场，所有配置的考场都有安排。</div>
        </el-card>

        <div class="step-actions">
          <el-button @click="router.push('/solve')">上一步</el-button>
          <div>
            <el-button @click="exportPlanJson">导出 plan.json</el-button>
            <el-button type="primary" @click="exportClassSchedule"
              >导出 按班级考场安排.xlsx</el-button
            >
            <el-button type="primary" @click="exportInvigilator">导出 考场监考表.xlsx</el-button>
          </div>
        </div>
      </template>

      <!-- ============================ 单场结果（行为不变） ============================ -->
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

          <VirtualTable
            :rows="rows"
            :row-key="entryRowKey"
            :columns="entryColumns"
            :height="480"
            :row-height="40"
          >
            <template #cell-room="{ row }">{{ entryRoom(row) }}</template>
            <template #cell-seatNo="{ row }">{{ cellText(row, "seatNo") }}</template>
            <template #cell-studentId="{ row }">{{ cellText(row, "studentId") }}</template>
            <template #cell-name="{ row }">{{ cellText(row, "name") }}</template>
            <template #cell-className="{ row }">{{ cellText(row, "className") }}</template>
            <template #cell-position="{ row }">{{ entryPosition(row) }}</template>
            <template #empty>
              <div class="hint">没有匹配的座位。</div>
            </template>
          </VirtualTable>
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
              {{ resultStore.result?.stats.seatsUsed }} /
              {{ resultStore.result?.stats.seatsTotal }}
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
          <el-table
            :data="resultStore.result?.conflicts ?? []"
            size="small"
            border
            max-height="240"
          >
            <el-table-column label="考场" width="140">
              <template #default="{ row }">{{
                roomNameById.get(row.roomId) ?? row.roomId
              }}</template>
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
.slot-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.step-actions {
  margin-top: 16px;
  display: flex;
  justify-content: space-between;
}
</style>
