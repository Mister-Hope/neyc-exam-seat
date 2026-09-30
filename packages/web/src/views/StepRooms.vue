<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, ref } from "vue";

import SeatGridPreview from "@/components/SeatGridPreview.vue";
import { ROOM_PRESETS, capacityWarning, inferRoomKind, roomKindLabel } from "@/lib/seat-grid";
import type { RoomKind } from "@/lib/seat-grid";
import { useRoomsStore } from "@/stores/rooms";
import { useRosterStore } from "@/stores/roster";
import { SECONDARY_SUBJECTS, SUBJECT_LABELS } from "@exam-seat/core";
import type { DoorSide, RoomSpec } from "@exam-seat/core";

/** 第 ③ 步：配置考场。类型（大 / 小 / 自定义 行×列）、门的位置、备注（监考老师）全在这张表里改， 每个考场都带一张座位编号缩略图（按物理列序画，门在右侧，所见即所得）。 */
const rooms = useRoomsStore();
const roster = useRosterStore();

const batchCount = ref(5);
const batchKind = ref<RoomKind>("large");
const expandAll = ref(false);
const expandKeys = ref<string[]>([]);

const plan = computed(() => rooms.capacityPlan(roster.participants));
const warning = computed(() => capacityWarning(plan.value));
const emptyRoomNames = computed(() => plan.value.emptyRooms.map((r) => r.name ?? r.id).join("、"));

/** El-table 的作用域插槽把 row 推断成 DefaultRow，这里统一收窄回真实类型。 */
const asRoom = (row: unknown): RoomSpec => row as RoomSpec;

/** 专用考场可标记的科目（再选科目：化学 / 生物 / 政治 / 地理） */
const dedicatedSubjectOptions = SECONDARY_SUBJECTS.map((value) => ({
  value,
  label: SUBJECT_LABELS[value] ?? value,
}));

function setDedicatedSubjects(row: unknown, value: string[]): void {
  rooms.updateRoom(asRoom(row).id, {
    dedicatedSubjects: value.length > 0 ? value : undefined,
  });
}

function toggleExpandAll(value: boolean): void {
  expandKeys.value = value ? rooms.rooms.map((room) => room.id) : [];
  expandAll.value = value;
}

function applyKind(room: RoomSpec, kind: RoomKind): void {
  if (kind === "large") rooms.updateRoom(room.id, { rows: 7, cols: 6 });
  else if (kind === "small") rooms.updateRoom(room.id, { rows: 6, cols: 5 });
}

function addBatch(): void {
  rooms.addRooms(batchCount.value, batchKind.value);
  ElMessage.success(`加了 ${batchCount.value} 个考场`);
}

async function removeRoom(room: RoomSpec): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删掉「${room.name ?? room.id}」？`, "删除考场", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消",
    });
    rooms.removeRoom(room.id);
  } catch {
    // 取消
  }
}

function fixDeficit(): void {
  const count = Math.max(1, Math.ceil(plan.value.deficit / 42));
  rooms.addRooms(count, "large");
  ElMessage.success(`补了 ${count} 个大考场`);
}

async function dropEmptyRooms(): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删掉这些会空置的考场？${emptyRoomNames.value}`, "精简考场", {
      type: "warning",
      confirmButtonText: "删掉",
      cancelButtonText: "取消",
    });
    const emptyIds = plan.value.emptyRooms.map((room) => room.id);
    for (const id of emptyIds) rooms.removeRoom(id);
  } catch {
    // 取消
  }
}
</script>

<template>
  <div class="step-page">
    <el-card shadow="never">
      <template #header><strong>配置考场</strong></template>

      <el-space wrap class="mb">
        <span class="muted">批量新建：</span>
        <el-input-number v-model="batchCount" :min="1" :max="60" />
        <el-select v-model="batchKind" style="width: 200px">
          <el-option value="large" :label="ROOM_PRESETS.large.label" />
          <el-option value="small" :label="ROOM_PRESETS.small.label" />
          <el-option value="custom" label="自定义（先建 6 列 × 6 排，再逐行改）" />
        </el-select>
        <el-button type="primary" @click="addBatch">添加</el-button>
        <el-button @click="rooms.renumber()">重排考场号 / 名称</el-button>
        <el-checkbox :model-value="expandAll" @update:model-value="toggleExpandAll(!!$event)">
          展开全部座位缩略图
        </el-checkbox>
      </el-space>

      <el-table :data="rooms.rooms" row-key="id" border size="small" :expand-row-keys="expandKeys">
        <el-table-column type="expand">
          <template #default="{ row }">
            <SeatGridPreview :room="asRoom(row)" compact />
          </template>
        </el-table-column>
        <el-table-column label="#" width="56" type="index" />
        <el-table-column label="考场名称" min-width="150">
          <template #default="{ row }">
            <el-input v-model="row.name" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="地点" min-width="140">
          <template #default="{ row }">
            <el-input v-model="row.location" size="small" placeholder="例如：高二一班" />
          </template>
        </el-table-column>
        <el-table-column label="类型" width="200">
          <template #default="{ row }">
            <el-select
              :model-value="inferRoomKind(asRoom(row))"
              size="small"
              @update:model-value="applyKind(asRoom(row), $event as RoomKind)"
            >
              <el-option value="large" :label="ROOM_PRESETS.large.label" />
              <el-option value="small" :label="ROOM_PRESETS.small.label" />
              <el-option value="custom" label="自定义" />
            </el-select>
            <el-tag size="small" type="info" class="ml">{{ roomKindLabel(asRoom(row)) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="排数" width="120">
          <template #default="{ row }">
            <el-input-number
              v-model="row.rows"
              :min="1"
              :max="30"
              size="small"
              controls-position="right"
            />
          </template>
        </el-table-column>
        <el-table-column label="列数" width="120">
          <template #default="{ row }">
            <el-input-number
              v-model="row.cols"
              :min="1"
              :max="30"
              size="small"
              controls-position="right"
            />
          </template>
        </el-table-column>
        <el-table-column label="容量" width="80">
          <template #default="{ row }">{{ row.rows * row.cols }}</template>
        </el-table-column>
        <el-table-column label="门的位置" width="150">
          <template #default="{ row }">
            <el-radio-group
              :model-value="row.doorSide ?? 'right'"
              size="small"
              @update:model-value="rooms.setDoorSide(asRoom(row).id, $event as DoorSide)"
            >
              <el-radio-button value="left">左</el-radio-button>
              <el-radio-button value="right">右</el-radio-button>
            </el-radio-group>
          </template>
        </el-table-column>
        <el-table-column label="备注（监考老师）" min-width="160">
          <template #default="{ row }">
            <el-input v-model="row.note" size="small" placeholder="例如：张老师" />
          </template>
        </el-table-column>
        <el-table-column label="专用科目" min-width="170">
          <template #default="{ row }">
            <el-select
              :model-value="asRoom(row).dedicatedSubjects ?? []"
              multiple
              clearable
              size="small"
              placeholder="通用考场"
              style="width: 100%"
              @update:model-value="setDedicatedSubjects(row, $event)"
            >
              <el-option
                v-for="option in dedicatedSubjectOptions"
                :key="option.value"
                :value="option.value"
                :label="option.label"
              />
            </el-select>
            <div class="cell-hint">只接收考该科目的非常规组合考生；一个考场可兼多科</div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170">
          <template #default="{ $index, row }">
            <el-button size="small" link :disabled="$index === 0" @click="rooms.move(row.id, -1)"
              >上移</el-button
            >
            <el-button
              size="small"
              link
              :disabled="$index === rooms.rooms.length - 1"
              @click="rooms.move(row.id, 1)"
            >
              下移
            </el-button>
            <el-button size="small" link type="danger" @click="removeRoom(asRoom(row))"
              >删除</el-button
            >
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="还没有考场，先用上面的「批量新建」加几个" :image-size="60" />
        </template>
      </el-table>

      <el-descriptions class="mt" :column="3" border>
        <el-descriptions-item label="考场数">{{ rooms.rooms.length }} 个</el-descriptions-item>
        <el-descriptions-item label="座位合计">{{ plan.totalSeats }} 个</el-descriptions-item>
        <el-descriptions-item label="实际参考">
          <strong class="text-primary">{{ roster.participants }} 人</strong>
        </el-descriptions-item>
      </el-descriptions>

      <el-alert
        v-if="warning"
        class="mt"
        :type="plan.deficit > 0 ? 'error' : 'warning'"
        :closable="false"
        show-icon
        :title="warning"
      >
        <div class="row-actions">
          <el-button v-if="plan.deficit > 0" size="small" type="primary" @click="fixDeficit">
            补 {{ Math.max(1, Math.ceil(plan.deficit / 42)) }} 个大考场
          </el-button>
          <el-button v-else size="small" @click="dropEmptyRooms">删掉会空置的考场</el-button>
        </div>
      </el-alert>
      <div v-else class="hint">
        座位刚好够用：{{ plan.totalSeats }} 个座位 / {{ roster.participants }} 人参考，多出
        {{ plan.spare }} 个。
      </div>
    </el-card>

    <div class="step-actions">
      <el-button @click="$router.push('/exclude')">上一步</el-button>
      <el-button
        type="primary"
        :disabled="rooms.rooms.length === 0"
        @click="$router.push('/constraints')"
      >
        下一步：设置限定
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.mb {
  margin-bottom: 10px;
}
.mt {
  margin-top: 12px;
}
.ml {
  margin-left: 6px;
}
.cell-hint {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  line-height: 1.4;
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
.text-primary {
  color: var(--el-color-primary);
}
.row-actions {
  margin-top: 6px;
}
.step-actions {
  margin-top: 16px;
  display: flex;
  justify-content: space-between;
}
</style>
