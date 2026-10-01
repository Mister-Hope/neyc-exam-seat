<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { toast } from "vue-sonner";

import DiagnosticsPanel from "@/components/DiagnosticsPanel.vue";
import MultiSelect from "@/components/MultiSelect.vue";
import SeatGridPreview from "@/components/SeatGridPreview.vue";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import VirtualTable from "@/components/VirtualTable.vue";
import { confirmAction } from "@/composables/useConfirm";
import { useExamJob } from "@/composables/useExamJob";
import { XLSX_MIME, ZIP_MIME, downloadBytes } from "@/lib/download";
import { exportTitle } from "@/lib/job";
import { filterStudents } from "@/lib/search";
import type { SeatOccupant } from "@/lib/seat-grid";
import {
  buildBorrowingRows,
  buildClassFilesZip,
  buildInvigilatorFilesZip,
  buildScheduleTable,
  buildSeatingChecks,
  buildSeatingOverview,
  changedByClass,
  collectMultiDiagnostics,
  collectSeatingConflicts,
  collectSeatingUnmet,
  countChangedStudents,
  filterScheduleRows,
  makeRoomLayout,
  relaxedRoomLabels,
} from "@/lib/session-export";
import type { ScheduleColumn } from "@/lib/session-export";
import { useResultStore } from "@/stores/result";
import { compareText, fingerprint } from "@exam-seat/core";
import type { PlanEntry } from "@exam-seat/core";
import {
  buildClassScheduleWorkbook,
  buildInvigilatorWorkbook,
  buildPlanWorkbook,
  buildRoomSheets,
} from "@exam-seat/io";
import {
  CalendarSearchIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  TriangleAlertIcon,
} from "@lucide/vue";

/**
 * 第 ⑥ 步：结果名单。
 *
 * 单场：主输出就是这张表（考场 / 座位号 / 学号 / 姓名 / 班级），按「考场号 → 座位号」升序； 座位网格只作页面预览；导出前先看独立校验器 `validate()` 的报告。
 *
 * 多场次（名单带选科）：主输出是「每人：时段 → 考场 + 座位」，另出座位方案概览、校验摘要、 空置考场，并导出「按班级考场安排.xlsx」与「考场监考表.xlsx」（io 的两个多场次函数）；
 * 另可整包下载「分班文件.zip」「分考场文件.zip」——用同一批 sheet 逐张写成单表工作簿再压缩，方便分别发人。
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

const singleRelaxedRoomNames = computed(() =>
  (resultStore.job?.rooms ?? [])
    .filter((room) => room.relaxSameClass != null && room.relaxSameClass !== false)
    .map((room) => room.name ?? room.id),
);

/** 结果级别的人话（不暴露内部关键字）。 */
function levelLabel(level: string): string {
  if (level === "roomRelaxed") return "已放宽：本考场内同班相邻不算冲突";
  if (level === "orthogonal") return "已降级：只要求前后左右不同班";
  if (level === "softConstraints") return "已降级：限定为违反最少";
  if (level === "minConflicts") return "已降级：相邻同班最少";
  return "严格：相邻不同班";
}

const degradedBanner = computed(() => {
  const { result } = resultStore;
  if (!result) return null;
  if (!result.ok) return { type: "error" as const, title: "这份结果没有排满，请先看下面的诊断" };
  if (result.level === "roomRelaxed") {
    return {
      type: "warning" as const,
      title: `已按考场放宽同班相邻：${
        singleRelaxedRoomNames.value.join("、") || "（见第 ③ 步的考场配置）"
      }；其余考场仍是严格规则，监考表会标注`,
    };
  }
  if (result.level !== "strict") {
    return {
      type: "warning" as const,
      title: `${levelLabel(result.level)}，导出的校验报告里会写明`,
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
  [...new Set(resultStore.scheduleByStudent.map((student) => student.className))].sort(compareText),
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
/** 借考明细（借考人 + 时段 + 科目 + 目标考场 / 座位）。 */
const borrowingRows = computed(() => buildBorrowingRows(planAll.value));
/** 放宽了同班相邻的考场（`PlanAllResult.relaxedRooms`）。 */
const relaxedRooms = computed(() => relaxedRoomLabels(planAll.value, roomNameById.value));
/** 放宽考场提示（拼在 script 里，保证文案是连续字符串）。 */
const relaxedRoomsTitle = computed(
  () =>
    `${relaxedRooms.value.length} 个考场已放宽同班相邻：${relaxedRooms.value
      .map((room) => room.roomName)
      .join("、")}（监考表表头会标注）`,
);

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
  const extras: string[] = [];
  if (relaxedRooms.value.length > 0)
    extras.push(`${relaxedRooms.value.length} 个考场已放宽同班相邻`);
  if (borrowingRows.value.length > 0) extras.push(`${borrowingRows.value.length} 人次借考`);
  return {
    type: "success" as const,
    title: `多场次编排完成：${slotCount.value} 个时段 · ${result.seatings.length} 套座位方案 · ${changedCount.value} 人需要换考场${
      extras.length > 0 ? ` · ${extras.join(" · ")}` : ""
    }`,
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
function confirmRiskyExport(message: string): Promise<boolean> {
  return confirmAction({
    title: "校验未通过",
    description: message,
    confirmText: "仍然导出",
    cancelText: "先修问题",
    danger: true,
  });
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
  const title = exportTitle(resultStore.job?.meta?.title);
  const bytes = buildPlanWorkbook(result, title);
  downloadBytes(bytes, `${title}-考场安排名单.xlsx`, XLSX_MIME);
  toast.success("已导出：考场安排名单.xlsx（名单 / 按班级 / 校验报告）");
}

/** 多场次结果的冲突 / 未排满检查（导出前拦一道）。 */
function multiRisky(): boolean {
  const result = planAll.value;
  return result != null && (!result.ok || seatingConflicts.value.length > 0);
}

/** 当前 job 的考场配置：io 的导出函数按考场数组取「地点 / 监考」。 */
const jobRooms = computed(() => job.value?.rooms ?? []);

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
  downloadBytes(
    buildClassScheduleWorkbook(result, jobRooms.value),
    "按班级考场安排.xlsx",
    XLSX_MIME,
  );
  toast.success("已导出：按班级考场安排.xlsx（按班级 + 各班换考场人数）");
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
  downloadBytes(buildInvigilatorWorkbook(result, jobRooms.value), "考场监考表.xlsx", XLSX_MIME);
  toast.success("已导出：考场监考表.xlsx（每个考场一套座位一张表）");
}

/** 分班文件整包：总表 + 每班各一个 `.xlsx`，打成一个 ZIP。 */
async function exportClassFilesZip(): Promise<void> {
  const result = planAll.value;
  if (!result) return;
  if (
    multiRisky() &&
    !(await confirmRiskyExport(
      `这份多场次结果有 ${seatingConflicts.value.length} 条冲突、${seatingUnmet.value.length} 条未满足限定，确实要下载「分班文件.zip」吗？`,
    ))
  ) {
    return;
  }
  downloadBytes(buildClassFilesZip(result, jobRooms.value), "分班文件.zip", ZIP_MIME);
  toast.success("已下载：分班文件.zip（总表 + 每个班一个 .xlsx）");
}

/** 分考场文件整包：每个考场（每套座位）各一个 `.xlsx`，打成一个 ZIP。 */
async function exportInvigilatorFilesZip(): Promise<void> {
  const result = planAll.value;
  if (!result) return;
  if (
    multiRisky() &&
    !(await confirmRiskyExport(
      `这份多场次结果有 ${seatingConflicts.value.length} 条冲突、${seatingUnmet.value.length} 条未满足限定，确实要下载「分考场文件.zip」吗？`,
    ))
  ) {
    return;
  }
  downloadBytes(buildInvigilatorFilesZip(result, jobRooms.value), "分考场文件.zip", ZIP_MIME);
  toast.success("已下载：分考场文件.zip（每个考场一套座位一个 .xlsx）");
}

/** 单场：逐考场座位表。有讲台侧加座的考场由 io 在网格最上面多画一行「加座」。 */
async function exportRoomSheets(): Promise<void> {
  const { result } = resultStore;
  if (!result) return;
  if (
    report.value &&
    !report.value.ok &&
    !(await confirmRiskyExport(
      `独立校验器报了 ${reportErrors.value.length} 个错误，座位表是照这份结果画的。确实要导出吗？`,
    ))
  ) {
    return;
  }
  const layout = makeRoomLayout(job.value?.rooms ?? []);
  downloadBytes(buildRoomSheets(result, layout), "考场座位表.xlsx", XLSX_MIME);
  toast.success("已导出：考场座位表.xlsx（逐考场网格，含讲台侧加座）");
}

/** 按求解结果移除空置考场（同时改 job 与考场 store，之后需要重排）。 */
async function removeEmptyRooms(): Promise<void> {
  const names = emptyRoomNames.value;
  if (names.length === 0) return;
  const confirmed = await confirmAction({
    title: "移除空置考场",
    description: `有 ${names.length} 个考场一个学生都没安排：${names.join("、")}。移除后这份结果就作废了，需要回「考场排布」重跑，确认移除？`,
    confirmText: "移除",
    cancelText: "保留",
    danger: true,
  });
  if (!confirmed) return;
  const { removed } = resultStore.removeEmptyRooms();
  if (removed.length > 0) {
    toast.success(`已移除空置考场：${removed.join("、")}；配置已变，请回「考场排布」重跑`);
  } else {
    toast.info("没有需要移除的考场");
  }
}

/**
 * 座位网格预览的单选：空串表示没选。
 *
 * 传 `null` 而不是 `undefined`：reka-ui 的 Select 在初始 `modelValue === undefined` 时会走 passive 模式、不再跟随外部
 * props， 这里要保持「清空」按钮能把选择清掉，所以用 `null`（同样是空值，placeholder 正常显示）。
 */
function previewRoomModel(): string | null {
  return previewRoomId.value === "" ? null : previewRoomId.value;
}

function updatePreviewRoom(value: unknown): void {
  previewRoomId.value = value == null ? "" : String(value);
}
</script>

<template>
  <div class="mx-auto flex max-w-[1360px] flex-col gap-4 pb-10">
    <Empty v-if="!hasAnything">
      <EmptyHeader>
        <EmptyMedia variant="icon"><CalendarSearchIcon /></EmptyMedia>
        <EmptyTitle>还没有求解结果，先去「考场排布」</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <Button @click="router.push('/solve')">去排考场</Button>
      </EmptyContent>
    </Empty>

    <template v-else>
      <!-- ============================ 多场次结果 ============================ -->
      <template v-if="isMulti">
        <Alert v-if="multiBanner?.type === 'error'" variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>{{ multiBanner.title }}</AlertTitle>
        </Alert>
        <Alert v-else-if="multiBanner">
          <TriangleAlertIcon />
          <AlertTitle>{{ multiBanner.title }}</AlertTitle>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle>
              多场次总览
              <span class="text-muted-foreground text-xs font-normal">
                ｜{{ slotCount }} 个时段 · {{ seatingOverview.length }} 套座位方案 · 需要换考场
                {{ changedCount }} 人
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent class="flex flex-col gap-3">
            <dl class="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div class="flex flex-col gap-0.5">
                <dt class="text-muted-foreground text-xs">时段数</dt>
                <dd>{{ slotCount }}</dd>
              </div>
              <div class="flex flex-col gap-0.5">
                <dt class="text-muted-foreground text-xs">座位方案</dt>
                <dd>{{ seatingOverview.length }}</dd>
              </div>
              <div class="flex flex-col gap-0.5">
                <dt class="text-muted-foreground text-xs">考生</dt>
                <dd>{{ resultStore.scheduleByStudent.length }}</dd>
              </div>
              <div class="flex flex-col gap-0.5">
                <dt class="text-muted-foreground text-xs">需要换考场</dt>
                <dd>{{ changedCount }} 人</dd>
              </div>
            </dl>

            <div class="flex flex-wrap gap-1.5">
              <Badge v-for="slot in resultStore.slots" :key="slot.id" variant="secondary">
                {{ slot.name }}
              </Badge>
            </div>

            <template v-if="changedClasses.length > 0">
              <strong class="text-sm">需要换考场的人（按班）</strong>
              <div class="max-h-60 overflow-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>班级</TableHead>
                      <TableHead class="w-40">需要换考场人数</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow v-for="item in changedClasses" :key="item.className">
                      <TableCell>{{ item.className }}</TableCell>
                      <TableCell>{{ item.count }}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </template>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              时段 → 考场 + 座位
              <span class="text-muted-foreground text-xs font-normal">
                ｜共 {{ multiRows.length }} /
                {{ scheduleTable.rows.length }} 人，可按班级筛选或搜「某人坐哪」
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent class="flex flex-col gap-3">
            <div class="flex flex-wrap items-end gap-3">
              <div class="flex flex-col gap-1.5">
                <Label for="multi-query">搜人 / 搜位</Label>
                <Input
                  id="multi-query"
                  v-model="multiQuery"
                  placeholder="学号 / 姓名 / 班级 / 考场，空格分隔多个条件"
                  class="h-8 w-80 max-w-full"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label>班级</Label>
                <MultiSelect
                  v-model="multiClassFilter"
                  :options="multiClassNames"
                  placeholder="全部班级"
                  trigger-class="w-64"
                />
              </div>
            </div>

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
              <template #cell-combination="{ row }">{{
                cellText(row, "combinationLabel")
              }}</template>
              <template
                v-for="slot in resultStore.slots"
                :key="slot.id"
                #[`cell-${slot.id}`]="{ row }"
              >
                {{ scheduleCellText(row, slot.id) }}
              </template>
              <template #empty>
                <div class="text-muted-foreground text-xs">没有匹配的考生。</div>
              </template>
            </VirtualTable>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              座位方案概览
              <span class="text-muted-foreground text-xs font-normal">
                ｜考场 × 科目 × 人数（一套座位 = 一个考场里一批固定学生）
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div class="max-h-80 overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead class="w-40">考场</TableHead>
                    <TableHead class="w-40">科目</TableHead>
                    <TableHead class="w-24">人数</TableHead>
                    <TableHead class="w-40">地点</TableHead>
                    <TableHead class="w-32">放宽同班相邻</TableHead>
                    <TableHead class="w-24">借考</TableHead>
                    <TableHead>监考</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="row in seatingOverview" :key="row.key">
                    <TableCell>{{ row.roomName }}</TableCell>
                    <TableCell>{{ row.subjectsLabel }}</TableCell>
                    <TableCell>{{ row.studentCount }}</TableCell>
                    <TableCell>{{ row.location }}</TableCell>
                    <TableCell>
                      <Badge v-if="row.relaxed" variant="outline">已放宽</Badge>
                      <span v-else class="text-muted-foreground text-xs">否</span>
                    </TableCell>
                    <TableCell>
                      <span v-if="row.borrowedCount > 0">{{ row.borrowedCount }} 人</span>
                      <span v-else class="text-muted-foreground text-xs">—</span>
                    </TableCell>
                    <TableCell>{{ row.note }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              借考与放宽
              <span class="text-muted-foreground text-xs font-normal">
                ｜考场级放宽「同班相邻」与按科目借考的落位明细
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent class="flex flex-col gap-3">
            <Alert v-if="relaxedRooms.length === 0 && borrowingRows.length === 0">
              <CircleCheckIcon />
              <AlertTitle>本场没有考场放宽同班相邻，也没有借考学生</AlertTitle>
            </Alert>
            <Alert v-else-if="relaxedRooms.length > 0">
              <TriangleAlertIcon />
              <AlertTitle>{{ relaxedRoomsTitle }}</AlertTitle>
            </Alert>

            <div v-if="borrowingRows.length > 0" class="max-h-60 overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead class="w-32">时段</TableHead>
                    <TableHead class="w-36">学号</TableHead>
                    <TableHead class="w-24">姓名</TableHead>
                    <TableHead class="w-32">班级</TableHead>
                    <TableHead class="w-24">科目</TableHead>
                    <TableHead class="w-36">借考考场</TableHead>
                    <TableHead class="w-24">座位</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="row in borrowingRows" :key="row.key">
                    <TableCell>{{ row.slotName }}</TableCell>
                    <TableCell>{{ row.studentId }}</TableCell>
                    <TableCell>{{ row.name }}</TableCell>
                    <TableCell>{{ row.className }}</TableCell>
                    <TableCell>{{ row.subjectLabel }}</TableCell>
                    <TableCell>{{ row.roomName }}</TableCell>
                    <TableCell>{{ row.seatNo }} 号</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
            <div v-else-if="relaxedRooms.length > 0" class="text-muted-foreground text-xs">
              没有借考学生。
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              校验摘要
              <span class="text-muted-foreground text-xs font-normal">
                ｜各套 result 的冲突汇总、未满足限定、考场数超限与诊断
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent class="flex flex-col gap-3">
            <Alert
              v-if="
                seatingConflicts.length === 0 &&
                seatingUnmet.length === 0 &&
                overRoomLimit.length === 0
              "
            >
              <CircleCheckIcon />
              <AlertTitle>校验通过：各套座位方案零冲突、限定全满足、无人超过 3 个考场</AlertTitle>
            </Alert>
            <Alert v-else variant="destructive">
              <CircleAlertIcon />
              <AlertTitle>
                冲突 {{ seatingConflicts.length }} 条 · 未满足限定 {{ seatingUnmet.length }} 条 ·
                超考场限制 {{ overRoomLimit.length }} 人
              </AlertTitle>
            </Alert>

            <div class="max-h-60 overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead class="w-40">考场</TableHead>
                    <TableHead class="w-36">科目</TableHead>
                    <TableHead class="w-20">人数</TableHead>
                    <TableHead class="w-28">状态</TableHead>
                    <TableHead class="w-20">冲突</TableHead>
                    <TableHead class="w-28">未满足限定</TableHead>
                    <TableHead class="w-20">诊断</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="row in seatingChecks" :key="row.key">
                    <TableCell>{{ row.roomName }}</TableCell>
                    <TableCell>{{ row.subjectsLabel }}</TableCell>
                    <TableCell>{{ row.studentCount }}</TableCell>
                    <TableCell>
                      <Badge :variant="row.ok ? 'default' : 'destructive'">
                        {{ row.ok ? "零冲突" : row.level }}
                      </Badge>
                    </TableCell>
                    <TableCell>{{ row.conflicts }}</TableCell>
                    <TableCell>{{ row.unmetConstraints }}</TableCell>
                    <TableCell>{{ row.diagnostics }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>

            <div
              v-if="seatingConflicts.length > 0"
              class="max-h-60 overflow-auto rounded-lg border"
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead class="w-36">考场</TableHead>
                    <TableHead class="w-32">科目</TableHead>
                    <TableHead class="w-20">座位A</TableHead>
                    <TableHead class="w-20">座位B</TableHead>
                    <TableHead class="w-32">学生A</TableHead>
                    <TableHead class="w-32">学生B</TableHead>
                    <TableHead>班级</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="row in seatingConflicts" :key="row.key">
                    <TableCell>{{ row.roomName }}</TableCell>
                    <TableCell>{{ row.subjectsLabel }}</TableCell>
                    <TableCell>{{ row.seatA }}</TableCell>
                    <TableCell>{{ row.seatB }}</TableCell>
                    <TableCell>{{ row.studentA }}</TableCell>
                    <TableCell>{{ row.studentB }}</TableCell>
                    <TableCell>{{ row.className }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>

            <div v-if="seatingUnmet.length > 0" class="max-h-60 overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead class="w-36">考场</TableHead>
                    <TableHead class="w-28">限定 ID</TableHead>
                    <TableHead class="w-24">涉及学生</TableHead>
                    <TableHead>原因</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="row in seatingUnmet" :key="row.key">
                    <TableCell>{{ row.roomName }}</TableCell>
                    <TableCell>{{ row.constraintId }}</TableCell>
                    <TableCell>{{ row.studentCount }}</TableCell>
                    <TableCell>{{ row.reason }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>

            <div v-if="overRoomLimit.length > 0" class="max-h-60 overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead class="w-36">学号</TableHead>
                    <TableHead class="w-28">姓名</TableHead>
                    <TableHead class="w-28">用到考场数</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="row in overRoomLimit" :key="row.studentId">
                    <TableCell>{{ row.studentId }}</TableCell>
                    <TableCell>{{ row.name }}</TableCell>
                    <TableCell>{{ row.count }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>

            <DiagnosticsPanel v-if="multiDiagnostics.length > 0" :diagnostics="multiDiagnostics" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              空置考场
              <span class="text-muted-foreground text-xs font-normal">
                ｜排完之后一个学生都没安排的考场
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent class="flex flex-col gap-3">
            <template v-if="emptyRoomNames.length > 0">
              <Alert>
                <TriangleAlertIcon />
                <AlertTitle>
                  有 {{ emptyRoomNames.length }} 个空置考场：{{
                    emptyRoomNames.join("、")
                  }}，可以取消
                </AlertTitle>
              </Alert>
              <div>
                <Button variant="outline" @click="removeEmptyRooms">一键移除空置考场</Button>
              </div>
            </template>
            <div v-else class="text-muted-foreground text-xs">
              没有空置考场，所有配置的考场都有安排。
            </div>
          </CardContent>
        </Card>

        <div class="text-muted-foreground text-xs">
          导出交付物：两个 .xlsx 合并工作簿（按班级考场安排 / 考场监考表）适合整体存档；
          「分班文件（ZIP）」「分考场文件（ZIP）」把总表与每个班 / 每个考场各拆成一个单独的
          .xlsx，方便分别发给班主任和监考老师。
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2">
          <Button variant="outline" @click="router.push('/solve')">上一步</Button>
          <div class="flex flex-wrap gap-2">
            <Button @click="exportClassSchedule">导出 按班级考场安排.xlsx</Button>
            <Button @click="exportInvigilator">导出 考场监考表.xlsx</Button>
            <Button variant="outline" @click="exportClassFilesZip">下载分班文件（ZIP）</Button>
            <Button variant="outline" @click="exportInvigilatorFilesZip"
              >下载分考场文件（ZIP）</Button
            >
          </div>
        </div>
      </template>

      <!-- ============================ 单场结果（行为不变） ============================ -->
      <template v-else>
        <Alert v-if="stale" variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>
            当前配置已经改过，这份结果是旧配置算出来的；导出的名单还是旧结果，建议回「考场排布」重跑一次
          </AlertTitle>
        </Alert>

        <Alert
          v-if="degradedBanner"
          :variant="degradedBanner.type === 'error' ? 'destructive' : 'default'"
        >
          <CircleCheckIcon v-if="degradedBanner.type === 'success'" />
          <TriangleAlertIcon v-else-if="degradedBanner.type === 'warning'" />
          <CircleAlertIcon v-else />
          <AlertTitle>{{ degradedBanner.title }}</AlertTitle>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle>
              结果名单
              <span class="text-muted-foreground text-xs font-normal">
                ｜按考场号 → 座位号升序，共 {{ rows.length }} / {{ resultStore.entries.length }} 条
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent class="flex flex-col gap-3">
            <div class="flex flex-wrap items-end gap-3">
              <div class="flex flex-col gap-1.5">
                <Label for="single-query">搜人 / 搜位</Label>
                <Input
                  id="single-query"
                  v-model="query"
                  placeholder="学号 / 姓名 / 班级，空格分隔多个条件"
                  class="h-8 w-80 max-w-full"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label>班级</Label>
                <MultiSelect
                  v-model="classFilter"
                  :options="resultStore.classNames"
                  placeholder="全部班级"
                  trigger-class="w-64"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label>考场</Label>
                <MultiSelect
                  v-model="roomFilter"
                  :options="resultStore.roomList.map((room) => room.id)"
                  :option-labels="
                    Object.fromEntries(resultStore.roomList.map((room) => [room.id, room.name]))
                  "
                  placeholder="全部考场"
                  trigger-class="w-64"
                />
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <Button @click="exportWorkbook">导出 xlsx</Button>
              </div>
            </div>

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
                <div class="text-muted-foreground text-xs">没有匹配的座位。</div>
              </template>
            </VirtualTable>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle> 校验报告 </CardTitle>
          </CardHeader>
          <CardContent class="flex flex-col gap-3">
            <Alert v-if="report && report.ok && reportWarnings.length === 0">
              <CircleCheckIcon />
              <AlertTitle>校验通过：容量、邻域、限定、编号一致性全部满足</AlertTitle>
            </Alert>
            <Alert v-else-if="report && report.ok">
              <TriangleAlertIcon />
              <AlertTitle>校验通过，但有 {{ reportWarnings.length }} 条提醒</AlertTitle>
            </Alert>
            <Alert v-else-if="report" variant="destructive">
              <CircleAlertIcon />
              <AlertTitle>
                校验未通过：{{ reportErrors.length }} 个错误，{{ reportWarnings.length }} 条提醒
              </AlertTitle>
            </Alert>

            <div
              v-if="report && report.issues.length > 0"
              class="max-h-60 overflow-auto rounded-lg border"
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead class="w-24">级别</TableHead>
                    <TableHead class="w-56">代码</TableHead>
                    <TableHead>说明</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="(row, index) in report.issues" :key="`${row.code}:${index}`">
                    <TableCell>
                      <Badge :variant="row.severity === 'error' ? 'destructive' : 'secondary'">
                        {{ row.severity === "error" ? "错误" : "提醒" }}
                      </Badge>
                    </TableCell>
                    <TableCell>{{ row.code }}</TableCell>
                    <TableCell>{{ row.message }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>

            <dl class="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div class="flex flex-col gap-0.5">
                <dt class="text-muted-foreground text-xs">考生</dt>
                <dd>{{ resultStore.result?.stats.participants }}</dd>
              </div>
              <div class="flex flex-col gap-0.5">
                <dt class="text-muted-foreground text-xs">班级数</dt>
                <dd>{{ resultStore.result?.stats.classes }}</dd>
              </div>
              <div class="flex flex-col gap-0.5">
                <dt class="text-muted-foreground text-xs">考场数</dt>
                <dd>
                  {{ resultStore.result?.stats.roomsUsed }} / {{ resultStore.result?.stats.rooms }}
                </dd>
              </div>
              <div class="flex flex-col gap-0.5">
                <dt class="text-muted-foreground text-xs">座位数</dt>
                <dd>
                  {{ resultStore.result?.stats.seatsUsed }} /
                  {{ resultStore.result?.stats.seatsTotal }}
                </dd>
              </div>
              <div class="flex flex-col gap-0.5">
                <dt class="text-muted-foreground text-xs">冲突数</dt>
                <dd>{{ resultStore.result?.stats.conflicts }}</dd>
              </div>
              <div class="flex flex-col gap-0.5">
                <dt class="text-muted-foreground text-xs">未满足限定</dt>
                <dd>{{ resultStore.result?.stats.unmetConstraints }}</dd>
              </div>
              <div class="flex flex-col gap-0.5">
                <dt class="text-muted-foreground text-xs">种子</dt>
                <dd>{{ resultStore.result?.stats.seed }}</dd>
              </div>
              <div class="flex flex-col gap-0.5">
                <dt class="text-muted-foreground text-xs">耗时</dt>
                <dd>{{ resultStore.result?.stats.elapsedMs }} ms</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card v-if="(resultStore.result?.conflicts.length ?? 0) > 0">
          <CardHeader>
            <CardTitle>
              冲突明细
              <span class="text-muted-foreground text-xs font-normal">（同考场相邻同班）</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div class="max-h-60 overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead class="w-32">考场</TableHead>
                    <TableHead class="w-24">座位A</TableHead>
                    <TableHead class="w-24">座位B</TableHead>
                    <TableHead class="w-36">学生A</TableHead>
                    <TableHead class="w-36">学生B</TableHead>
                    <TableHead>班级</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow
                    v-for="(row, index) in resultStore.result?.conflicts ?? []"
                    :key="`${row.roomId}:${row.seatA}:${row.seatB}:${index}`"
                  >
                    <TableCell>{{ roomNameById.get(row.roomId) ?? row.roomId }}</TableCell>
                    <TableCell>{{ row.seatA }}</TableCell>
                    <TableCell>{{ row.seatB }}</TableCell>
                    <TableCell>{{ row.studentA }}</TableCell>
                    <TableCell>{{ row.studentB }}</TableCell>
                    <TableCell>{{ row.className }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card v-if="(resultStore.result?.unmetConstraints.length ?? 0) > 0">
          <CardHeader>
            <CardTitle>未满足的限定</CardTitle>
          </CardHeader>
          <CardContent>
            <div class="overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead class="w-32">限定 ID</TableHead>
                    <TableHead class="w-56">涉及学生</TableHead>
                    <TableHead>原因</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow
                    v-for="(row, index) in resultStore.result?.unmetConstraints ?? []"
                    :key="`${row.constraintId}:${index}`"
                  >
                    <TableCell>{{ row.constraintId }}</TableCell>
                    <TableCell>{{ row.studentIds.length }} 人</TableCell>
                    <TableCell>{{ row.reason }}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card v-if="(resultStore.result?.diagnostics.length ?? 0) > 0">
          <CardHeader>
            <CardTitle>诊断</CardTitle>
          </CardHeader>
          <CardContent>
            <DiagnosticsPanel :diagnostics="resultStore.result?.diagnostics ?? []" show-evidence />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle> 座位网格预览 </CardTitle>
          </CardHeader>
          <CardContent class="flex flex-col gap-3">
            <div class="flex flex-wrap items-center gap-2">
              <Select
                v-bind="{ modelValue: previewRoomModel() }"
                @update:modelValue="updatePreviewRoom"
              >
                <SelectTrigger class="h-8 w-64 max-w-full" size="sm">
                  <SelectValue placeholder="选一个考场看座位" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem
                      v-for="room in resultStore.roomList"
                      :key="room.id"
                      :value="room.id"
                    >
                      {{ room.name }}
                    </SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button v-if="previewRoomId" variant="ghost" size="sm" @click="previewRoomId = ''">
                清空
              </Button>
            </div>
            <SeatGridPreview v-if="previewRoom" :room="previewRoom" :occupants="previewOccupants" />
            <div v-else class="text-muted-foreground text-xs">
              选了考场后，这里会按物理列序画出每个座位上的学生。
            </div>
          </CardContent>
        </Card>

        <div class="flex flex-wrap items-center justify-between gap-2">
          <Button variant="outline" @click="router.push('/solve')">上一步</Button>
          <div class="flex flex-wrap gap-2">
            <Button variant="outline" @click="exportRoomSheets">导出 考场座位表.xlsx</Button>
            <Button @click="exportWorkbook">导出 考场安排名单.xlsx</Button>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>
