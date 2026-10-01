<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { toast } from "vue-sonner";

import MultiSelect from "@/components/MultiSelect.vue";
import SeatGridPreview from "@/components/SeatGridPreview.vue";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { confirmAction } from "@/composables/useConfirm";
import { ROOM_PRESETS, capacityWarning, inferRoomKind, roomKindLabel } from "@/lib/seat-grid";
import type { RoomKind } from "@/lib/seat-grid";
import { useRoomsStore } from "@/stores/rooms";
import { useRosterStore } from "@/stores/roster";
import { SECONDARY_SUBJECTS, SUBJECT_LABELS, roomCapacity } from "@exam-seat/core";
import type { DoorSide, RoomSpec } from "@exam-seat/core";
import { CalendarSearchIcon, TriangleAlertIcon } from "@lucide/vue";

/** 第 ③ 步：配置考场。类型（大 / 小 / 自定义 行×列）、门的位置、备注（监考老师）全在这张表里改， 每个考场都可以展开一张座位编号缩略图（按物理列序画，门在右侧，所见即所得）。 */
const rooms = useRoomsStore();
const roster = useRosterStore();
const router = useRouter();

const batchCount = ref(5);
const batchKind = ref<RoomKind>("large");
const expandAll = ref(false);
const expandedIds = ref<string[]>([]);

/** 表格列数（展开行 colspan 用）。 */
const COLUMN_COUNT = 14;

const plan = computed(() => rooms.capacityPlan(roster.participants));
const warning = computed(() => capacityWarning(plan.value));
const emptyRoomNames = computed(() => plan.value.emptyRooms.map((r) => r.name ?? r.id).join("、"));

/** 专用考场可标记的科目（再选科目：化学 / 生物 / 政治 / 地理） */
const dedicatedSubjectOptions = SECONDARY_SUBJECTS.map((value) => ({
  value,
  label: SUBJECT_LABELS[value] ?? value,
}));
const dedicatedLabels: Record<string, string> = Object.fromEntries(
  dedicatedSubjectOptions.map((option) => [option.value, option.label]),
);

const kindOptions: { value: RoomKind; label: string }[] = [
  { value: "large", label: ROOM_PRESETS.large.label },
  { value: "small", label: ROOM_PRESETS.small.label },
  { value: "custom", label: "自定义" },
];

function setDedicatedSubjects(room: RoomSpec, value: (string | number)[]): void {
  rooms.updateRoom(room.id, {
    dedicatedSubjects: value.length > 0 ? value.map(String) : undefined,
  });
}

/* ---------------- 讲台侧加座 / 放宽同班相邻 ---------------- */

/** 可选加座列 = 本考场的业务列（靠门侧起算）；每个考场的列数不同，选项要按考场算。 */
function extraSeatOptions(room: RoomSpec): number[] {
  return Array.from({ length: room.cols }, (_, index) => index + 1);
}

function extraSeatLabels(room: RoomSpec): Record<number, string> {
  return Object.fromEntries(
    Array.from({ length: room.cols }, (_, index) => [index + 1, `第${index + 1}列`]),
  );
}

function extraSeatValues(room: RoomSpec): (string | number)[] {
  return (room.extraFrontSeats ?? []).filter((col) => col <= room.cols);
}

function setExtraSeats(room: RoomSpec, value: (string | number)[]): void {
  rooms.setExtraFrontSeats(room.id, value.map(Number));
}

function isRelaxed(room: RoomSpec): boolean {
  const value = room.relaxSameClass;
  return value != null && value !== false;
}

/** 数字 = 同班上限；`true` / 缺省显示为空（不填 = 完全放开）。 */
function relaxLimit(room: RoomSpec): number | undefined {
  return typeof room.relaxSameClass === "number" ? room.relaxSameClass : undefined;
}

function toggleRelax(room: RoomSpec, enabled: boolean): void {
  rooms.setRelaxSameClass(room.id, enabled ? true : undefined);
}

function setRelaxLimit(room: RoomSpec, value: string | number): void {
  const limit = Math.trunc(Number(value));
  rooms.setRelaxSameClass(room.id, Number.isInteger(limit) && limit >= 1 ? limit : true);
}

function setRows(room: RoomSpec, value: string | number): void {
  const rowsCount = Math.trunc(Number(value));
  if (!Number.isInteger(rowsCount) || rowsCount < 1) return;
  rooms.updateRoom(room.id, { rows: rowsCount });
}

/** 列数改小时必须重新收口加座（越界列会被丢掉），所以不直接改 row.cols。 */
function setCols(room: RoomSpec, value: string | number): void {
  const cols = Math.trunc(Number(value));
  if (!Number.isInteger(cols) || cols < 1) return;
  rooms.updateRoom(room.id, { cols });
}

function setBatchCount(value: string | number): void {
  const count = Math.trunc(Number(value));
  if (Number.isInteger(count) && count >= 1) batchCount.value = Math.min(60, count);
}

function toggleExpandAll(value: boolean): void {
  expandAll.value = value;
  expandedIds.value = value ? rooms.rooms.map((room) => room.id) : [];
}

function toggleExpand(room: RoomSpec): void {
  expandedIds.value = expandedIds.value.includes(room.id)
    ? expandedIds.value.filter((id) => id !== room.id)
    : [...expandedIds.value, room.id];
}

function applyKind(room: RoomSpec, kind: RoomKind | undefined): void {
  if (kind === "large") rooms.updateRoom(room.id, { rows: 7, cols: 6 });
  else if (kind === "small") rooms.updateRoom(room.id, { rows: 6, cols: 5 });
}

function setDoorSide(room: RoomSpec, value: unknown): void {
  const side = Array.isArray(value) ? value[0] : value;
  if (side === "left" || side === "right") rooms.setDoorSide(room.id, side satisfies DoorSide);
}

function addBatch(): void {
  rooms.addRooms(batchCount.value, batchKind.value);
  toast.success(`加了 ${batchCount.value} 个考场`);
}

async function removeRoom(room: RoomSpec): Promise<void> {
  const confirmed = await confirmAction({
    title: `确定删掉「${room.name ?? room.id}」？`,
    confirmText: "删除",
    danger: true,
  });
  if (confirmed) rooms.removeRoom(room.id);
}

function fixDeficit(): void {
  const count = Math.max(1, Math.ceil(plan.value.deficit / 42));
  rooms.addRooms(count, "large");
  toast.success(`补了 ${count} 个大考场`);
}

async function dropEmptyRooms(): Promise<void> {
  const confirmed = await confirmAction({
    title: "精简考场",
    description: `确定删掉这些会空置的考场？${emptyRoomNames.value}`,
    confirmText: "删掉",
    danger: true,
  });
  if (!confirmed) return;
  for (const room of plan.value.emptyRooms) rooms.removeRoom(room.id);
}
</script>

<template>
  <div class="mx-auto max-w-[1360px]">
    <Card>
      <CardHeader>
        <CardTitle>配置考场</CardTitle>
      </CardHeader>
      <CardContent class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-muted-foreground text-xs">批量新建：</span>
          <Input
            :model-value="batchCount"
            type="number"
            min="1"
            max="60"
            class="h-7 w-20"
            aria-label="批量新建数量"
            @input="setBatchCount(($event.target as HTMLInputElement).value)"
          />
          <Select :model-value="batchKind" @update:model-value="batchKind = $event as RoomKind">
            <SelectTrigger class="h-7 w-56" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="large">{{ ROOM_PRESETS.large.label }}</SelectItem>
                <SelectItem value="small">{{ ROOM_PRESETS.small.label }}</SelectItem>
                <SelectItem value="custom">自定义（先建 6 列 × 6 排，再逐行改）</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button size="sm" @click="addBatch">添加</Button>
          <Button variant="outline" size="sm" @click="rooms.renumber()">重排考场号 / 名称</Button>
          <label class="flex items-center gap-1.5 text-sm">
            <Checkbox
              :model-value="expandAll"
              @update:model-value="toggleExpandAll($event === true)"
            />
            展开全部座位缩略图
          </label>
        </div>

        <Empty v-if="rooms.rooms.length === 0">
          <EmptyHeader>
            <EmptyMedia variant="icon"><CalendarSearchIcon /></EmptyMedia>
            <EmptyTitle>还没有考场</EmptyTitle>
            <EmptyDescription>先用上面的「批量新建」加几个</EmptyDescription>
          </EmptyHeader>
        </Empty>

        <div v-else class="w-full overflow-x-auto">
          <Table class="min-w-[1500px]">
            <TableHeader>
              <TableRow>
                <TableHead class="w-12">#</TableHead>
                <TableHead class="w-40">考场名称</TableHead>
                <TableHead class="w-36">地点</TableHead>
                <TableHead class="w-48">类型</TableHead>
                <TableHead class="w-24">排数</TableHead>
                <TableHead class="w-24">列数</TableHead>
                <TableHead class="w-20">容量</TableHead>
                <TableHead class="w-40">讲台侧加座</TableHead>
                <TableHead class="w-52">放宽同班相邻</TableHead>
                <TableHead class="w-28">门的位置</TableHead>
                <TableHead class="w-36">备注（监考老师）</TableHead>
                <TableHead class="w-40">专用科目</TableHead>
                <TableHead class="w-40">操作</TableHead>
                <TableHead class="w-20">座位图</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <template v-for="(room, index) in rooms.rooms" :key="room.id">
                <TableRow>
                  <TableCell class="text-muted-foreground text-xs">{{ index + 1 }}</TableCell>
                  <TableCell>
                    <Input
                      :model-value="room.name ?? ''"
                      class="h-7"
                      @input="room.name = ($event.target as HTMLInputElement).value"
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      :model-value="room.location ?? ''"
                      class="h-7"
                      placeholder="例如：高二一班"
                      @input="room.location = ($event.target as HTMLInputElement).value"
                    />
                  </TableCell>
                  <TableCell>
                    <div class="flex items-center gap-1.5">
                      <Select
                        :model-value="inferRoomKind(room)"
                        @update:model-value="applyKind(room, $event as RoomKind)"
                      >
                        <SelectTrigger class="h-7 w-28" size="sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem
                              v-for="option in kindOptions"
                              :key="option.value"
                              :value="option.value"
                            >
                              {{ option.label }}
                            </SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                      <Badge variant="secondary">{{ roomKindLabel(room) }}</Badge>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Input
                      :model-value="room.rows"
                      type="number"
                      min="1"
                      max="30"
                      class="h-7 w-20"
                      :aria-label="`${room.name ?? room.id} 排数`"
                      @input="setRows(room, ($event.target as HTMLInputElement).value)"
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      :model-value="room.cols"
                      type="number"
                      min="1"
                      max="30"
                      class="h-7 w-20"
                      :aria-label="`${room.name ?? room.id} 列数`"
                      @input="setCols(room, ($event.target as HTMLInputElement).value)"
                    />
                  </TableCell>
                  <TableCell class="font-medium">{{ roomCapacity(room) }}</TableCell>
                  <TableCell>
                    <MultiSelect
                      :model-value="extraSeatValues(room)"
                      :options="extraSeatOptions(room)"
                      :option-labels="extraSeatLabels(room)"
                      placeholder="无加座"
                      trigger-class="w-full"
                      @update:model-value="setExtraSeats(room, $event)"
                    />
                    <div class="text-muted-foreground mt-1 text-[11px] leading-snug">
                      选中的业务列在讲台前各加 1 座；容量按「排 × 列 + 加座数」算
                    </div>
                  </TableCell>
                  <TableCell>
                    <div class="flex items-center gap-2">
                      <Switch
                        :model-value="isRelaxed(room)"
                        size="sm"
                        :aria-label="`${room.name ?? room.id} 放宽同班相邻`"
                        @update:model-value="toggleRelax(room, $event === true)"
                      />
                      <Input
                        v-if="isRelaxed(room)"
                        :model-value="relaxLimit(room) ?? ''"
                        type="number"
                        min="1"
                        max="999"
                        placeholder="不填 = 完全放开"
                        class="h-7 w-32"
                        :aria-label="`${room.name ?? room.id} 同班上限`"
                        @input="setRelaxLimit(room, ($event.target as HTMLInputElement).value)"
                      />
                    </div>
                    <div class="text-muted-foreground mt-1 text-[11px] leading-snug">
                      只影响本考场：同班相邻不再算冲突；数字 = 同班学生数上限
                    </div>
                  </TableCell>
                  <TableCell>
                    <ToggleGroup
                      type="single"
                      :model-value="room.doorSide ?? 'right'"
                      variant="outline"
                      size="sm"
                      @update:model-value="setDoorSide(room, $event)"
                    >
                      <ToggleGroupItem value="left" class="px-2">左</ToggleGroupItem>
                      <ToggleGroupItem value="right" class="px-2">右</ToggleGroupItem>
                    </ToggleGroup>
                  </TableCell>
                  <TableCell>
                    <Input
                      :model-value="room.note ?? ''"
                      class="h-7"
                      placeholder="例如：张老师"
                      @input="room.note = ($event.target as HTMLInputElement).value"
                    />
                  </TableCell>
                  <TableCell>
                    <MultiSelect
                      :model-value="room.dedicatedSubjects ?? []"
                      :options="dedicatedSubjectOptions.map((option) => option.value)"
                      :option-labels="dedicatedLabels"
                      placeholder="通用考场"
                      trigger-class="w-full"
                      @update:model-value="setDedicatedSubjects(room, $event)"
                    />
                    <div class="text-muted-foreground mt-1 text-[11px] leading-snug">
                      只接收考该科目的非常规组合考生；一个考场可兼多科
                    </div>
                  </TableCell>
                  <TableCell>
                    <div class="flex flex-wrap gap-1">
                      <Button
                        variant="link"
                        size="xs"
                        :disabled="index === 0"
                        @click="rooms.move(room.id, -1)"
                      >
                        上移
                      </Button>
                      <Button
                        variant="link"
                        size="xs"
                        :disabled="index === rooms.rooms.length - 1"
                        @click="rooms.move(room.id, 1)"
                      >
                        下移
                      </Button>
                      <Button
                        variant="link"
                        size="xs"
                        class="text-destructive"
                        @click="removeRoom(room)"
                      >
                        删除
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Button variant="outline" size="xs" @click="toggleExpand(room)">
                      {{ expandedIds.includes(room.id) ? "收起" : "查看" }}
                    </Button>
                  </TableCell>
                </TableRow>
                <TableRow v-if="expandedIds.includes(room.id)">
                  <TableCell :colspan="COLUMN_COUNT" class="bg-muted/40">
                    <SeatGridPreview :room="room" compact />
                  </TableCell>
                </TableRow>
              </template>
            </TableBody>
          </Table>
        </div>

        <Separator />

        <dl class="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
          <div>
            <dt class="text-muted-foreground text-xs">考场数</dt>
            <dd>{{ rooms.rooms.length }} 个</dd>
          </div>
          <div>
            <dt class="text-muted-foreground text-xs">座位合计</dt>
            <dd>{{ plan.totalSeats }} 个</dd>
          </div>
          <div>
            <dt class="text-muted-foreground text-xs">实际参考</dt>
            <dd class="text-primary font-semibold">{{ roster.participants }} 人</dd>
          </div>
          <div>
            <dt class="text-muted-foreground text-xs">有加座的考场</dt>
            <dd>{{ rooms.extraSeatRooms }} 个</dd>
          </div>
          <div>
            <dt class="text-muted-foreground text-xs">放宽同班相邻的考场</dt>
            <dd>
              {{ rooms.relaxedRooms.length }} 个<template v-if="rooms.relaxedRooms.length > 0"
                >（{{
                  rooms.relaxedRooms.map((room) => room.name ?? room.id).join("、")
                }}）</template
              >
            </dd>
          </div>
          <div>
            <dt class="text-muted-foreground text-xs">提示</dt>
            <dd class="text-muted-foreground">
              放宽考场会在监考表上标注；借考（subjectRoom）请用 job.json 导入
            </dd>
          </div>
        </dl>

        <Alert v-if="warning" :variant="plan.deficit > 0 ? 'destructive' : 'default'">
          <TriangleAlertIcon />
          <AlertTitle>{{ warning }}</AlertTitle>
          <AlertDescription>
            <Button v-if="plan.deficit > 0" size="sm" class="mt-1" @click="fixDeficit">
              补 {{ Math.max(1, Math.ceil(plan.deficit / 42)) }} 个大考场
            </Button>
            <Button v-else variant="outline" size="sm" class="mt-1" @click="dropEmptyRooms">
              删掉会空置的考场
            </Button>
          </AlertDescription>
        </Alert>
        <p v-else class="text-muted-foreground text-xs">
          座位刚好够用：{{ plan.totalSeats }} 个座位 / {{ roster.participants }} 人参考，多出
          {{ plan.spare }} 个。
        </p>
      </CardContent>
    </Card>

    <div class="mt-4 flex justify-between">
      <Button variant="outline" @click="router.push('/exclude')">上一步</Button>
      <Button :disabled="rooms.rooms.length === 0" @click="router.push('/constraints')">
        下一步：设置限定
      </Button>
    </div>
  </div>
</template>
