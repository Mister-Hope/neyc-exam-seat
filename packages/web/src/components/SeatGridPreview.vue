<script setup lang="ts">
import { computed } from "vue";

import { buildSeatGrid } from "@/lib/seat-grid";
import type { SeatCell, SeatOccupant } from "@/lib/seat-grid";
import { roomCapacity } from "@exam-seat/core";
import type { RoomSpec } from "@exam-seat/core";

/** 座位编号缩略图：按**物理列序**（面对讲台从左往右）画，门在右侧，所见即所得。 格子里的数字是座位号（蛇形编号的结果），不是行列坐标。 */
const props = withDefaults(
  defineProps<{
    room: RoomSpec;
    /** 座位号 → 该座位的考生（结果预览用） */
    occupants?: Map<number, SeatOccupant>;
    /** 高亮格子集合，键为 `排:物理列`（限定预览用） */
    highlight?: Set<string>;
    compact?: boolean;
  }>(),
  {
    occupants: () => new Map<number, SeatOccupant>(),
    highlight: () => new Set<string>(),
    compact: false,
  },
);

const grid = computed(() => buildSeatGrid(props.room));
const capacity = computed(() => roomCapacity(props.room));

const extraCount = computed(() => grid.value.frontCells.filter((cell) => cell != null).length);

const template = computed(() => {
  const width = props.compact ? "34px" : "52px";
  return `auto repeat(${grid.value.cols}, minmax(${width}, 1fr))`;
});

const doorPhysicalCol = computed(() => (grid.value.doorSide === "right" ? grid.value.cols : 1));
const windowPhysicalCol = computed(() => (grid.value.doorSide === "right" ? 1 : grid.value.cols));

function isHighlighted(row: number, physicalCol: number): boolean {
  return props.highlight.has(`${row}:${physicalCol}`);
}

function occupantOf(seatNo: number): SeatOccupant | undefined {
  if (seatNo < 1) return undefined;
  return props.occupants.get(seatNo);
}

function frontCell(physicalCol: number): SeatCell | null {
  return grid.value.frontCells[physicalCol - 1] ?? null;
}

function sideLabel(physicalCol: number): string {
  if (physicalCol === doorPhysicalCol.value) return "门";
  if (physicalCol === windowPhysicalCol.value) return "窗";
  return "";
}
</script>

<template>
  <div class="seat-preview" :class="{ 'seat-preview--compact': compact }">
    <div class="seat-preview__head">
      <strong>{{ room.name ?? room.id }}</strong>
      <span class="seat-preview__meta">
        {{ grid.cols }} 列 × {{ grid.rows }} 排 = {{ capacity }} 座<template v-if="grid.hasExtra"
          >（含 {{ extraCount }} 个讲台侧加座）</template
        >
        ｜ 门靠{{ grid.doorSide === "right" ? "右" : "左" }}
      </span>
    </div>
    <div class="seat-grid" :style="{ gridTemplateColumns: template }">
      <div class="seat-grid__board">讲台 / 黑板</div>
      <div class="seat-grid__corner"></div>
      <div
        v-for="physicalCol in grid.cols"
        :key="`h-${physicalCol}`"
        class="seat-grid__head"
        :class="{ 'seat-grid__head--door': physicalCol === doorPhysicalCol }"
      >
        {{ sideLabel(physicalCol) || `第${physicalCol}列` }}
      </div>

      <template v-if="grid.hasExtra">
        <div class="seat-grid__rowhead seat-grid__rowhead--extra">加座</div>
        <div
          v-for="physicalCol in grid.cols"
          :key="`x-${physicalCol}`"
          class="seat-grid__cell"
          :class="{
            'seat-grid__cell--extra': frontCell(physicalCol) != null,
            'seat-grid__cell--void': frontCell(physicalCol) == null,
            'seat-grid__cell--hit': isHighlighted(0, physicalCol),
          }"
        >
          <template v-if="frontCell(physicalCol)">
            <span class="seat-grid__no">{{ frontCell(physicalCol)?.seatNo }}</span>
            <span v-if="occupantOf(frontCell(physicalCol)?.seatNo ?? -1)" class="seat-grid__who">
              {{ occupantOf(frontCell(physicalCol)?.seatNo ?? -1)?.name }}
            </span>
          </template>
        </div>
      </template>

      <template v-for="row in grid.rows" :key="`r-${row}`">
        <div class="seat-grid__rowhead">第{{ row }}排</div>
        <div
          v-for="physicalCol in grid.cols"
          :key="`c-${row}-${physicalCol}`"
          class="seat-grid__cell"
          :class="{ 'seat-grid__cell--hit': isHighlighted(row, physicalCol) }"
        >
          <span class="seat-grid__no">{{
            grid.cells[row - 1]?.[physicalCol - 1]?.seatNo ?? ""
          }}</span>
          <span
            v-if="occupantOf(grid.cells[row - 1]?.[physicalCol - 1]?.seatNo ?? -1)"
            class="seat-grid__who"
          >
            {{ occupantOf(grid.cells[row - 1]?.[physicalCol - 1]?.seatNo ?? -1)?.name }}
          </span>
        </div>
      </template>
    </div>
    <div class="seat-preview__foot">
      列号从靠门侧起算；座位号按蛇形推进（1 号在靠门前角）。左 = 窗，右 = 门。
    </div>
  </div>
</template>

<style scoped>
.seat-preview {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  background: var(--card);
  overflow-x: auto;
}
.seat-preview__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}
.seat-preview__meta {
  font-size: 12px;
  color: var(--muted-foreground);
}
.seat-grid {
  display: grid;
  gap: 4px;
  min-width: fit-content;
}
.seat-grid__board {
  grid-column: 1 / -1;
  text-align: center;
  font-size: 12px;
  letter-spacing: 4px;
  color: var(--muted-foreground);
  border-bottom: 1px dashed var(--border);
  padding-bottom: 2px;
}
.seat-grid__corner {
  width: 100%;
}
.seat-grid__head {
  font-size: 11px;
  text-align: center;
  color: var(--muted-foreground);
}
.seat-grid__head--door {
  color: var(--primary);
  font-weight: 700;
}
.seat-grid__rowhead {
  font-size: 11px;
  color: var(--muted-foreground);
  display: flex;
  align-items: center;
  white-space: nowrap;
}
.seat-grid__cell {
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--muted);
  min-height: 34px;
  padding: 2px 4px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  line-height: 1.15;
}
.seat-grid__cell--hit {
  background: var(--accent);
  border-color: var(--primary);
}
.seat-grid__cell--extra {
  border-color: var(--ring);
  background: var(--accent);
}
.seat-grid__cell--void {
  border-style: dashed;
  background: transparent;
}
.seat-grid__rowhead--extra {
  color: var(--primary);
  font-weight: 700;
}
.seat-grid__no {
  font-weight: 700;
  font-size: 13px;
}
.seat-grid__who {
  font-size: 11px;
  color: var(--foreground);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.seat-preview--compact .seat-grid__cell {
  min-height: 26px;
}
.seat-preview--compact .seat-grid__no {
  font-size: 11px;
}
.seat-preview__foot {
  margin-top: 6px;
  font-size: 11px;
  color: var(--muted-foreground);
}
</style>
