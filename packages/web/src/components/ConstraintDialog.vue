<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { toast } from "vue-sonner";

import MultiSelect from "@/components/MultiSelect.vue";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NumberField,
  NumberFieldContent,
  NumberFieldDecrement,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/ui/number-field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  absoluteRangeHint,
  allowedCellsOnGrid,
  roomOptionLabel,
  semanticColHint,
  semanticRowHint,
  viewConstraintSeats,
} from "@/lib/constraint-view";
import type { ColRef, Constraint, RoomSpec, RowRef } from "@exam-seat/core";
import { CircleAlertIcon, InfoIcon, TriangleAlertIcon, WandSparklesIcon } from "@lucide/vue";

import SeatGridPreview from "./SeatGridPreview.vue";

/**
 * 限定弹窗。这里刻意做了两层防线（对应设计文档 §10.4）：
 *
 * 1. 没选考场时，排/列里**只有语义值**（首排/末排/靠门列/靠窗列），绝对号输入框整个隐藏—— 大小考场的行列数不同，同一个数字指向不同位置，填了没有意义。
 * 2. 选了考场后，才展开绝对号输入框，`max` 直接绑该考场的行数/列数，越界填不进去。
 *
 * 「四角」预设一律用语义值，所以大小考场混排也通吃。
 */
const props = defineProps<{
  modelValue: boolean;
  rooms: RoomSpec[];
  /** 表格里勾选的学生（点名选择器） */
  studentIds: string[];
  /** 可选班级，用于「按班级」选择器 */
  classNames?: string[];
  /** 可选组合（名单里出现过的），用于「按组合」选择器 */
  combinationOptions?: string[];
  /** 可选科目 */
  subjectOptions?: { value: string; label: string }[];
  /** 命中人数：由父组件用 core 的选择器语义算，避免两套实现 */
  resolveCount?: (constraint: Constraint) => number;
  editing?: Constraint | null;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void;
  (e: "submit", payload: Omit<Constraint, "id">, id?: string): void;
}>();

const note = ref("");
const classNameSelectors = ref<string[]>([]);
const combinationSelectors = ref<string[]>([]);
const subjectSelectors = ref<string[]>([]);
const roomId = ref<string | undefined>(undefined);
const rows = ref<RowRef[]>([]);
const cols = ref<ColRef[]>([]);
const absoluteRow = ref<number | undefined>(undefined);
const absoluteCol = ref<number | undefined>(undefined);
/** 「按组合」的 allow-create：名单里没有的组合可以手写（core 会规范化）。 */
const customCombination = ref("");

/** `Select` 的空值哨兵：选中它 = 不限考场。 */
const NO_ROOM = "__none__";

const selectedRoom = computed(() => props.rooms.find((room) => room.id === roomId.value));

function resetFrom(constraint: Constraint | null | undefined): void {
  note.value = constraint?.note ?? "";
  classNameSelectors.value = constraint?.classes ? [...constraint.classes] : [];
  combinationSelectors.value = constraint?.combinations ? [...constraint.combinations] : [];
  subjectSelectors.value = constraint?.subjects ? [...constraint.subjects] : [];
  roomId.value = constraint?.roomId;
  rows.value = constraint?.rows ? [...constraint.rows] : [];
  cols.value = constraint?.cols ? [...constraint.cols] : [];
  absoluteRow.value = undefined;
  absoluteCol.value = undefined;
  customCombination.value = "";
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) resetFrom(props.editing ?? null);
  },
  { immediate: true },
);

/** 「按组合」候选：名单里出现过的 + 已经手写进去的，保证自定义项也能取消。 */
const combinationPool = computed(() => {
  const known = props.combinationOptions ?? [];
  const extra = combinationSelectors.value.filter((item) => !known.includes(item));
  return [...known, ...extra];
});

const subjectLabelByValue = computed(
  () => new Map((props.subjectOptions ?? []).map((option) => [option.value, option.label])),
);
const subjectValueByLabel = computed(
  () => new Map((props.subjectOptions ?? []).map((option) => [option.label, option.value])),
);
const subjectLabels = computed<string[]>({
  get: () => subjectSelectors.value.map((value) => subjectLabelByValue.value.get(value) ?? value),
  set: (labels) => {
    subjectSelectors.value = labels.map((label) => subjectValueByLabel.value.get(label) ?? label);
  },
});

const roomSelect = computed<string>({
  get: () => roomId.value ?? NO_ROOM,
  set: (value) => {
    roomId.value = value === NO_ROOM ? undefined : value;
    onRoomChange();
  },
});
/** 已经不存在（被删掉）的考场：也给一个选项，否则触发器会显示成没选。 */
const missingRoomId = computed(() =>
  roomId.value && !props.rooms.some((room) => room.id === roomId.value) ? roomId.value : undefined,
);

const toRowRef = (value: string): RowRef =>
  /^\d+$/.test(value) ? Number(value) : (value as RowRef);
const toColRef = (value: string): ColRef =>
  /^\d+$/.test(value) ? Number(value) : (value as ColRef);

const toRefs = <T>(value: unknown, convert: (item: string) => T): T[] => {
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((item): item is string => typeof item === "string")
    .map((item) => convert(item));
};

const rowSelection = computed<string[]>({
  get: () => rows.value.map((ref) => `${ref}`),
  set: (value) => {
    rows.value = toRefs(value, toRowRef);
  },
});

const colSelection = computed<string[]>({
  get: () => cols.value.map((ref) => `${ref}`),
  set: (value) => {
    cols.value = toRefs(value, toColRef);
  },
});

function addCustomCombination(): void {
  const value = customCombination.value.trim();
  if (value && !combinationSelectors.value.includes(value)) {
    combinationSelectors.value = [...combinationSelectors.value, value];
  }
  customCombination.value = "";
}

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
  ...(props.studentIds.length > 0 ? { studentIds: props.studentIds } : {}),
  ...(classNameSelectors.value.length > 0 ? { classes: classNameSelectors.value } : {}),
  ...(combinationSelectors.value.length > 0 ? { combinations: combinationSelectors.value } : {}),
  ...(subjectSelectors.value.length > 0 ? { subjects: subjectSelectors.value } : {}),
  ...(roomId.value ? { roomId: roomId.value } : {}),
  ...(rows.value.length > 0 ? { rows: rows.value } : {}),
  ...(cols.value.length > 0 ? { cols: cols.value } : {}),
}));

/** 命中人数 = 点名 ∪ 班级 ∪ 组合 ∪ 科目，由 core 的选择器语义算出来 */
const hitCount = computed(() =>
  props.resolveCount ? props.resolveCount(draftConstraint.value) : props.studentIds.length,
);

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
  if (view.value.total < hitCount.value) {
    return `只有 ${view.value.total} 个可用座位，却命中了 ${hitCount.value} 人`;
  }
  return null;
});

const outOfRangeWarning = computed<string | null>(() => {
  if (roomId.value || view.value.droppedRooms.length === 0) return null;
  return `绝对号在 ${view.value.droppedRooms.join("、")} 里不存在，这些考场会被排除`;
});

function submit(): void {
  if (hitCount.value === 0) {
    toast.warning("先在列表里勾选学生，或至少写一个选择器（班级 / 组合 / 科目）");
    return;
  }
  const payload: Omit<Constraint, "id"> = {
    ...(props.studentIds.length > 0 ? { studentIds: [...props.studentIds] } : {}),
    ...(classNameSelectors.value.length > 0 ? { classes: [...classNameSelectors.value] } : {}),
    ...(combinationSelectors.value.length > 0
      ? { combinations: [...combinationSelectors.value] }
      : {}),
    ...(subjectSelectors.value.length > 0 ? { subjects: [...subjectSelectors.value] } : {}),
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
  <Dialog :open="modelValue" @update:open="emit('update:modelValue', $event)">
    <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{{ editing ? "编辑限定" : "添加限定" }}</DialogTitle>
        <DialogDescription>
          学生的点名 / 班级 / 组合 / 科目取并集；考场是单选，排与列可以多选。
        </DialogDescription>
      </DialogHeader>

      <FieldGroup class="gap-4">
        <Field orientation="horizontal">
          <FieldLabel class="w-24 shrink-0 justify-end">涉及学生</FieldLabel>
          <FieldContent class="flex-row flex-wrap items-center gap-1.5">
            <Badge>命中 {{ hitCount }} 人</Badge>
            <Badge variant="secondary">点名 {{ studentIds.length }} 人</Badge>
            <span class="text-muted-foreground text-xs"
              >（在列表里勾选，或直接用下面的选择器）</span
            >
          </FieldContent>
        </Field>

        <Field orientation="horizontal">
          <FieldLabel class="w-24 shrink-0 justify-end">按班级</FieldLabel>
          <FieldContent>
            <MultiSelect
              v-model="classNameSelectors"
              :options="classNames ?? []"
              placeholder="留空则不限班级"
              trigger-class="w-full"
            />
          </FieldContent>
        </Field>

        <Field orientation="horizontal">
          <FieldLabel class="w-24 shrink-0 justify-end">按组合</FieldLabel>
          <FieldContent>
            <MultiSelect
              v-model="combinationSelectors"
              :options="combinationPool"
              placeholder="留空则不限组合，例如 物化政"
              trigger-class="w-full"
            />
            <div class="flex items-center gap-1.5">
              <Input
                v-model="customCombination"
                class="h-7 w-56"
                placeholder="自定义组合，例如 物化政"
                @keyup.enter="addCustomCombination"
              />
              <Button
                variant="outline"
                size="sm"
                :disabled="customCombination.trim().length === 0"
                @click="addCustomCombination"
              >
                加入
              </Button>
            </div>
            <FieldDescription> 组合写法随意：物化政 / 物理+化学+政治 都认。 </FieldDescription>
          </FieldContent>
        </Field>

        <Field orientation="horizontal">
          <FieldLabel class="w-24 shrink-0 justify-end">按科目</FieldLabel>
          <FieldContent>
            <MultiSelect
              v-model="subjectLabels"
              :options="(subjectOptions ?? []).map((option) => option.label)"
              placeholder="留空则不限科目，例如 政治"
              trigger-class="w-full"
            />
            <FieldDescription>命中「选了其中任意一门」的学生。</FieldDescription>
          </FieldContent>
        </Field>

        <Field orientation="horizontal">
          <FieldLabel class="w-24 shrink-0 justify-end">备注</FieldLabel>
          <FieldContent>
            <Input v-model="note" placeholder="例如：有作弊前科 / 班主任监考" />
          </FieldContent>
        </Field>

        <Field orientation="horizontal">
          <FieldLabel class="w-24 shrink-0 justify-end">考场限定</FieldLabel>
          <FieldContent>
            <Select v-model="roomSelect">
              <SelectTrigger class="w-full">
                <SelectValue placeholder="不限考场" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem :value="NO_ROOM">不限考场</SelectItem>
                  <SelectItem v-for="(room, index) in rooms" :key="room.id" :value="room.id">
                    {{ roomOptionLabel(room, index) }}
                  </SelectItem>
                  <SelectItem v-if="missingRoomId" :value="missingRoomId">
                    {{ missingRoomId }}（已不存在）
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              考场限定是单选：一个学生只能钉在一个考场。不选 = 任意考场。
            </FieldDescription>
          </FieldContent>
        </Field>

        <Field orientation="horizontal">
          <FieldLabel class="w-24 shrink-0 justify-end">排限定</FieldLabel>
          <FieldContent>
            <ToggleGroup
              type="multiple"
              variant="outline"
              size="sm"
              :spacing="1"
              class="max-w-full flex-wrap"
              v-model="rowSelection"
            >
              <ToggleGroupItem
                v-for="option in rowOptions"
                :key="`r-${option.value}`"
                :value="String(option.value)"
              >
                {{ option.label }}
              </ToggleGroupItem>
            </ToggleGroup>
          </FieldContent>
        </Field>

        <Field v-if="selectedRoom" orientation="horizontal">
          <FieldLabel class="w-24 shrink-0 justify-end">绝对排号</FieldLabel>
          <FieldContent class="flex-row flex-wrap items-center gap-2">
            <NumberField v-model="absoluteRow" :min="1" :max="selectedRoom.rows" class="w-32">
              <NumberFieldContent>
                <NumberFieldInput placeholder="第 N 排" />
                <NumberFieldIncrement />
                <NumberFieldDecrement />
              </NumberFieldContent>
            </NumberField>
            <Button
              variant="outline"
              size="sm"
              :disabled="absoluteRow === undefined"
              @click="addAbsoluteRow"
            >
              加入
            </Button>
            <span class="text-muted-foreground text-xs">{{ absoluteRangeHint(selectedRoom) }}</span>
          </FieldContent>
        </Field>

        <Field orientation="horizontal">
          <FieldLabel class="w-24 shrink-0 justify-end">列限定</FieldLabel>
          <FieldContent>
            <ToggleGroup
              type="multiple"
              variant="outline"
              size="sm"
              :spacing="1"
              class="max-w-full flex-wrap"
              v-model="colSelection"
            >
              <ToggleGroupItem
                v-for="option in colOptions"
                :key="`c-${option.value}`"
                :value="String(option.value)"
              >
                {{ option.label }}
              </ToggleGroupItem>
            </ToggleGroup>
          </FieldContent>
        </Field>

        <Field v-if="selectedRoom" orientation="horizontal">
          <FieldLabel class="w-24 shrink-0 justify-end">绝对列号</FieldLabel>
          <FieldContent class="flex-row flex-wrap items-center gap-2">
            <NumberField v-model="absoluteCol" :min="1" :max="selectedRoom.cols" class="w-32">
              <NumberFieldContent>
                <NumberFieldInput placeholder="第 N 列" />
                <NumberFieldIncrement />
                <NumberFieldDecrement />
              </NumberFieldContent>
            </NumberField>
            <Button
              variant="outline"
              size="sm"
              :disabled="absoluteCol === undefined"
              @click="addAbsoluteCol"
            >
              加入
            </Button>
            <span class="text-muted-foreground text-xs">列号从靠门侧起算：第 1 列 = 靠门列</span>
          </FieldContent>
        </Field>

        <Field v-else orientation="horizontal">
          <FieldLabel class="sr-only">绝对号说明</FieldLabel>
          <FieldContent>
            <Alert>
              <InfoIcon />
              <AlertTitle>
                没选考场时只能用语义值（首排 / 末排 / 靠门列 / 靠窗列），绝对号输入框已隐藏
              </AlertTitle>
              <AlertDescription>
                大考场 6×7、小考场 5×6，「第 5 列」在两种考场里位置不同。
              </AlertDescription>
            </Alert>
          </FieldContent>
        </Field>

        <Field orientation="horizontal">
          <FieldLabel class="sr-only">四角预设</FieldLabel>
          <FieldContent class="flex-row flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" @click="applyCorners">
              <WandSparklesIcon data-icon="inline-start" />
              一键四角（首排+末排 × 靠门列+靠窗列）
            </Button>
          </FieldContent>
        </Field>

        <Field orientation="horizontal">
          <FieldLabel class="w-24 shrink-0 justify-end">可用座位</FieldLabel>
          <FieldContent class="gap-1.5">
            <div class="flex flex-wrap items-center gap-1.5">
              <Badge :variant="view.total > 0 ? 'outline' : 'destructive'">
                共 {{ view.total }} 个座位
              </Badge>
              <Badge
                v-for="item in view.perRoom"
                :key="item.roomId"
                :variant="item.seats > 0 ? 'secondary' : 'destructive'"
              >
                {{ item.roomName }}：{{ item.seats }}/{{ item.capacity }}
              </Badge>
            </div>
            <Alert v-if="previewWarning" variant="destructive">
              <CircleAlertIcon />
              <AlertTitle>{{ previewWarning }}</AlertTitle>
            </Alert>
            <Alert v-if="outOfRangeWarning">
              <TriangleAlertIcon />
              <AlertTitle>{{ outOfRangeWarning }}</AlertTitle>
            </Alert>
            <div
              v-if="!selectedRoom && rows.length + cols.length > 0"
              class="text-muted-foreground flex flex-col gap-0.5 text-xs"
            >
              <div v-for="(ref, i) in rows" :key="`hr-${i}`">{{ semanticRowHint(ref, rooms) }}</div>
              <div v-for="(ref, i) in cols" :key="`hc-${i}`">{{ semanticColHint(ref, rooms) }}</div>
            </div>
            <SeatGridPreview
              v-if="selectedRoom"
              :room="selectedRoom"
              :highlight="highlight"
              compact
            />
          </FieldContent>
        </Field>
      </FieldGroup>

      <DialogFooter>
        <Button variant="outline" @click="emit('update:modelValue', false)">取消</Button>
        <Button @click="submit">{{ editing ? "保存" : "添加" }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
