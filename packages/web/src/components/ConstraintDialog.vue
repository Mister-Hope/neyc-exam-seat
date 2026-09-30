<script setup lang="ts">
import { ElMessage } from "element-plus";
import { computed, ref, watch } from "vue";

import {
  allowedCellsOnGrid,
  absoluteRangeHint,
  roomOptionLabel,
  semanticColHint,
  semanticRowHint,
  viewConstraintSeats,
} from "@/lib/constraint-view";
import type { ColRef, Constraint, RoomSpec, RowRef } from "@exam-seat/core";

import SeatGridPreview from "./SeatGridPreview.vue";

/**
 * 限定弹窗。这里刻意做了两层防线（对应设计文档 §10.4）：
 *
 * 1. 没选考场时，排/列下拉里**只有语义值**（首排/末排/靠门列/靠窗列），绝对号输入框整个隐藏—— 大小考场的行列数不同，同一个数字指向不同位置，填了没有意义。
 * 2. 选了考场后，才展开绝对号输入框，`max` 直接绑该考场的行数/列数，越界填不进去。
 *
 * 「四角」预设一律用语义值，所以大小考场混排也通吃。
 */
const props = defineProps<{
  modelValue: boolean;
  rooms: RoomSpec[];
  studentIds: string[];
  editing?: Constraint | null;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "submit", payload: Omit<Constraint, "id">, id?: string): void;
}>();

const note = ref("");
const roomId = ref<string | undefined>(undefined);
const rows = ref<RowRef[]>([]);
const cols = ref<ColRef[]>([]);
const absoluteRow = ref<number | undefined>(undefined);
const absoluteCol = ref<number | undefined>(undefined);

const selectedRoom = computed(() => props.rooms.find((room) => room.id === roomId.value));

function resetFrom(constraint: Constraint | null | undefined): void {
  note.value = constraint?.note ?? "";
  roomId.value = constraint?.roomId;
  rows.value = constraint?.rows ? [...constraint.rows] : [];
  cols.value = constraint?.cols ? [...constraint.cols] : [];
  absoluteRow.value = undefined;
  absoluteCol.value = undefined;
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) resetFrom(props.editing ?? null);
  },
  { immediate: true },
);

const rowOptions = computed(() => {
  const options: { value: RowRef; label: string }[] = [
    { value: "first", label: "首排" },
    { value: "last", label: "末排" },
  ];
  const room = selectedRoom.value;
  // 只有选定了考场，绝对号才有确定含义，才展开
  if (room) {
    for (let row = 1; row <= room.rows; row += 1) options.push({ value: row, label: `第${row}排` });
  }
  const known = new Set(options.map((o) => o.value));
  for (const ref of rows.value) {
    if (!known.has(ref))
      options.push({
        value: ref,
        label: typeof ref === "number" ? `第${ref}排（越界）` : String(ref),
      });
  }
  return options;
});

const colOptions = computed(() => {
  const options: { value: ColRef; label: string }[] = [
    { value: "door", label: "靠门列" },
    { value: "window", label: "靠窗列" },
  ];
  const room = selectedRoom.value;
  if (room) {
    for (let col = 1; col <= room.cols; col += 1) options.push({ value: col, label: `第${col}列` });
  }
  const known = new Set(options.map((o) => o.value));
  for (const ref of cols.value) {
    if (!known.has(ref))
      options.push({
        value: ref,
        label: typeof ref === "number" ? `第${ref}列（越界）` : String(ref),
      });
  }
  return options;
});

/** 四角：全是语义值，大小考场都能正确解析。 */
function applyCorners(): void {
  rows.value = ["first", "last"];
  cols.value = ["door", "window"];
  absoluteRow.value = undefined;
  absoluteCol.value = undefined;
}

function addAbsoluteRow(): void {
  const { value } = absoluteRow;
  if (value === undefined || rows.value.includes(value)) return;
  rows.value = [...rows.value, value];
  absoluteRow.value = undefined;
}

function addAbsoluteCol(): void {
  const { value } = absoluteCol;
  if (value === undefined || cols.value.includes(value)) return;
  cols.value = [...cols.value, value];
  absoluteCol.value = undefined;
}

function onRoomChange(): void {
  // 换了考场：数字型取值可能越界，直接清掉，避免留下无意义的绝对号
  rows.value = rows.value.filter((ref) => typeof ref !== "number");
  cols.value = cols.value.filter((ref) => typeof ref !== "number");
}

const draftConstraint = computed<Constraint>(() => ({
  id: props.editing?.id ?? "preview",
  note: note.value,
  studentIds: props.studentIds,
  ...(roomId.value ? { roomId: roomId.value } : {}),
  ...(rows.value.length > 0 ? { rows: rows.value } : {}),
  ...(cols.value.length > 0 ? { cols: cols.value } : {}),
}));

const view = computed(() => viewConstraintSeats(props.rooms, draftConstraint.value));

const highlight = computed(() => {
  const room = selectedRoom.value;
  if (!room) return new Set<string>();
  const nos = view.value.perRoom.find((item) => item.roomId === room.id)?.seatNos ?? [];
  return allowedCellsOnGrid(room, nos);
});

const previewWarning = computed<string | null>(() => {
  if (view.value.unknownRoomId) return `考场 ${view.value.unknownRoomId} 已经不存在了，请重新选择`;
  if (view.value.total === 0) return "这条限定没有任何可用座位，求解器会直接判定无解";
  if (view.value.total < props.studentIds.length) {
    return `只有 ${view.value.total} 个可用座位，却要安排 ${props.studentIds.length} 人`;
  }
  return null;
});

const outOfRangeWarning = computed<string | null>(() => {
  if (roomId.value || view.value.droppedRooms.length === 0) return null;
  return `绝对号在 ${view.value.droppedRooms.join("、")} 里不存在，这些考场会被排除`;
});

function submit(): void {
  if (props.studentIds.length === 0) {
    ElMessage.warning("先选学生，再添加限定");
    return;
  }
  const payload: Omit<Constraint, "id"> = {
    studentIds: [...props.studentIds],
    ...(note.value.trim() ? { note: note.value.trim() } : {}),
    ...(roomId.value ? { roomId: roomId.value } : {}),
    ...(rows.value.length > 0 ? { rows: [...rows.value] } : {}),
    ...(cols.value.length > 0 ? { cols: [...cols.value] } : {}),
  };
  emit("submit", payload, props.editing?.id);
  emit("update:modelValue", false);
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="editing ? '编辑限定' : '添加限定'"
    width="720px"
    append-to-body
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-form label-width="96px">
      <el-form-item label="涉及学生">
        <el-tag type="info" size="small">已选 {{ studentIds.length }} 人</el-tag>
        <span class="dialog-hint">（在列表里勾选学生，可先按班级批量选）</span>
      </el-form-item>

      <el-form-item label="备注">
        <el-input v-model="note" placeholder="例如：有作弊前科 / 班主任监考" clearable />
      </el-form-item>

      <el-form-item label="考场限定">
        <el-select
          v-model="roomId"
          placeholder="不限考场"
          clearable
          style="width: 100%"
          @change="onRoomChange"
        >
          <el-option
            v-for="(room, index) in rooms"
            :key="room.id"
            :value="room.id"
            :label="roomOptionLabel(room, index)"
          />
        </el-select>
        <div class="dialog-hint">考场限定是单选：一个学生只能钉在一个考场。不选 = 任意考场。</div>
      </el-form-item>

      <el-form-item label="排限定">
        <el-select v-model="rows" multiple clearable placeholder="任意排" style="width: 100%">
          <el-option
            v-for="option in rowOptions"
            :key="`r-${option.value}`"
            :value="option.value"
            :label="option.label"
          />
        </el-select>
      </el-form-item>

      <el-form-item v-if="selectedRoom" label="绝对排号">
        <el-input-number
          v-model="absoluteRow"
          :min="1"
          :max="selectedRoom.rows"
          placeholder="第 N 排"
        />
        <el-button
          style="margin-left: 8px"
          :disabled="absoluteRow === undefined"
          @click="addAbsoluteRow"
        >
          加入
        </el-button>
        <span class="dialog-hint">{{ absoluteRangeHint(selectedRoom) }}</span>
      </el-form-item>

      <el-form-item label="列限定">
        <el-select v-model="cols" multiple clearable placeholder="任意列" style="width: 100%">
          <el-option
            v-for="option in colOptions"
            :key="`c-${option.value}`"
            :value="option.value"
            :label="option.label"
          />
        </el-select>
      </el-form-item>

      <el-form-item v-if="selectedRoom" label="绝对列号">
        <el-input-number
          v-model="absoluteCol"
          :min="1"
          :max="selectedRoom.cols"
          placeholder="第 N 列"
        />
        <el-button
          style="margin-left: 8px"
          :disabled="absoluteCol === undefined"
          @click="addAbsoluteCol"
        >
          加入
        </el-button>
        <span class="dialog-hint">列号从靠门侧起算：第 1 列 = 靠门列</span>
      </el-form-item>

      <el-form-item v-else label=" ">
        <el-alert type="info" :closable="false" show-icon>
          没选考场时只能用语义值（首排 / 末排 / 靠门列 / 靠窗列），绝对号输入框已隐藏： 大考场
          6×7、小考场 5×6，「第 5 列」在两种考场里位置不同。
        </el-alert>
      </el-form-item>

      <el-form-item label=" ">
        <el-button @click="applyCorners">一键四角（首排+末排 × 靠门列+靠窗列）</el-button>
      </el-form-item>

      <el-form-item label="可用座位">
        <div class="preview-box">
          <div>
            <el-tag :type="view.total > 0 ? 'success' : 'danger'"
              >共 {{ view.total }} 个座位</el-tag
            >
            <el-tag
              v-for="item in view.perRoom"
              :key="item.roomId"
              style="margin-left: 6px"
              :type="item.seats > 0 ? 'info' : 'warning'"
            >
              {{ item.roomName }}：{{ item.seats }}/{{ item.capacity }}
            </el-tag>
          </div>
          <el-alert
            v-if="previewWarning"
            type="error"
            :closable="false"
            show-icon
            :title="previewWarning"
          />
          <el-alert
            v-if="outOfRangeWarning"
            type="warning"
            :closable="false"
            show-icon
            :title="outOfRangeWarning"
          />
          <div v-if="!selectedRoom && rows.length + cols.length > 0" class="dialog-hint">
            <div v-for="(ref, i) in rows" :key="`hr-${i}`">{{ semanticRowHint(ref, rooms) }}</div>
            <div v-for="(ref, i) in cols" :key="`hc-${i}`">{{ semanticColHint(ref, rooms) }}</div>
          </div>
          <SeatGridPreview
            v-if="selectedRoom"
            :room="selectedRoom"
            :highlight="highlight"
            compact
          />
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" @click="submit">{{ editing ? "保存" : "添加" }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.dialog-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.6;
}
.preview-box {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
