import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { loadState, saveState } from "@/lib/persist";
import { ROOM_PRESETS, normalizeExtraFrontSeats, planCapacity } from "@/lib/seat-grid";
import type { RoomKind } from "@/lib/seat-grid";
import { roomCapacity } from "@exam-seat/core";
import type { DoorSide, RoomSpec } from "@exam-seat/core";

const STORAGE_NAME = "rooms";

interface PersistedRooms {
  rooms: RoomSpec[];
}

function defaultRoom(index: number, kind: RoomKind = "large"): RoomSpec {
  const preset = kind === "small" ? ROOM_PRESETS.small : ROOM_PRESETS.large;
  return {
    id: `R${index}`,
    name: `第${index}考场`,
    rows: kind === "custom" ? 6 : preset.rows,
    cols: kind === "custom" ? 6 : preset.cols,
    doorSide: "right",
    note: "",
  };
}

function nextIndex(rooms: readonly RoomSpec[], start = 1): number {
  const used = new Set(rooms.map((r) => r.id));
  let index = start;
  while (used.has(`R${index}`)) index += 1;
  return index;
}

/**
 * 归一化一个考场：加座列去重、排序、丢掉越界值（列数改小后必须重新收口，否则容量与座位图会各算各的）。
 *
 * 缺省 / 空数组一律删掉字段，导出的 job.json 保持干净（与 `dedicatedSubjects` 的既有写法一致）。
 */
function normalizeRoom(room: RoomSpec): RoomSpec {
  const extra = normalizeExtraFrontSeats(room);
  const raw = room.extraFrontSeats;
  if (extra.length === 0 && raw == null) return room;
  if (extra.length > 0 && raw?.length === extra.length && extra.every((col, i) => col === raw[i])) {
    return room;
  }
  const next: RoomSpec = { ...room };
  if (extra.length > 0) next.extraFrontSeats = extra;
  else delete next.extraFrontSeats;
  return next;
}

/** 第 ③ 步：考场配置。容量与空置推算见 `@/lib/seat-grid` 的 planCapacity（纯函数，可测）。 */
export const useRoomsStore = defineStore("rooms", () => {
  const saved = loadState<PersistedRooms>(STORAGE_NAME, { rooms: [] });
  const rooms = ref<RoomSpec[]>(saved.rooms ?? []);

  const totalSeats = computed(() => rooms.value.reduce((sum, room) => sum + roomCapacity(room), 0));
  /** 有讲台侧加座的考场数（第 ③ 步摘要用）。 */
  const extraSeatRooms = computed(
    () => rooms.value.filter((room) => (room.extraFrontSeats?.length ?? 0) > 0).length,
  );
  /** 放宽了「同班相邻」的考场数。 */
  const relaxedRooms = computed(() =>
    rooms.value.filter((room) => room.relaxSameClass != null && room.relaxSameClass !== false),
  );

  function capacityPlan(participants: number) {
    return planCapacity(rooms.value, participants);
  }

  /** 批量新建：老师配 30 个考场时最常用的入口。 */
  function addRooms(count = 1, kind: RoomKind = "large"): RoomSpec[] {
    const created: RoomSpec[] = [];
    for (let i = 0; i < Math.max(1, Math.floor(count)); i += 1) {
      const index = nextIndex(rooms.value);
      const room = defaultRoom(index, kind);
      rooms.value.push(room);
      created.push(room);
    }
    return created;
  }

  function addRoom(kind: RoomKind = "large"): RoomSpec {
    return addRooms(1, kind)[0]!;
  }

  function removeRoom(id: string): void {
    rooms.value = rooms.value.filter((room) => room.id !== id);
  }

  /** 按 id 批量移除（第 ⑤ 步「一键移除空置考场」用）。 */
  function removeRooms(ids: readonly string[]): void {
    const removing = new Set(ids);
    rooms.value = rooms.value.filter((room) => !removing.has(room.id));
  }

  function updateRoom(id: string, patch: Partial<RoomSpec>): void {
    rooms.value = rooms.value.map((room) =>
      room.id === id ? normalizeRoom({ ...room, ...patch }) : room,
    );
  }

  /** 讲台侧加座（业务列号数组）；传空数组 = 取消加座。 */
  function setExtraFrontSeats(id: string, cols: readonly number[]): void {
    const room = roomById(id);
    if (!room) return;
    updateRoom(id, {
      extraFrontSeats: normalizeExtraFrontSeats({ cols: room.cols, extraFrontSeats: [...cols] }),
    });
  }

  /**
   * 放宽「同班相邻」：`true` = 完全放开；数字 = 本考场同班上限；`undefined` / `false` = 回到原规则。
   *
   * 非法的数字（0、负数、小数）按「完全放开」处理，避免界面传出脏值。
   */
  function setRelaxSameClass(id: string, value: boolean | number | undefined): void {
    const room = roomById(id);
    if (!room) return;
    const next = { ...room };
    if (value === true) next.relaxSameClass = true;
    else if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
      next.relaxSameClass = value;
    } else if (typeof value === "number") {
      // 0 / 负数 / 小数：上限没有意义，但「放宽」这个意图是明确的，按完全放开处理
      next.relaxSameClass = true;
    } else delete next.relaxSameClass;
    rooms.value = rooms.value.map((item) => (item.id === id ? next : item));
  }

  function setDoorSide(id: string, doorSide: DoorSide): void {
    updateRoom(id, { doorSide });
  }

  function move(id: string, delta: number): void {
    const at = rooms.value.findIndex((room) => room.id === id);
    const to = at + delta;
    if (at === -1 || to < 0 || to >= rooms.value.length) return;
    const next = [...rooms.value];
    const [item] = next.splice(at, 1);
    if (!item) return;
    next.splice(to, 0, item);
    rooms.value = next;
  }

  function roomById(id: string): RoomSpec | undefined {
    return rooms.value.find((room) => room.id === id);
  }

  /** 重排考场号 / 名称（改名后一键恢复「第N考场」）。 */
  function renumber(): void {
    rooms.value = rooms.value.map((room, index) => ({
      ...room,
      id: `R${index + 1}`,
      name: `第${index + 1}考场`,
    }));
  }

  function replaceRooms(next: readonly RoomSpec[]): void {
    rooms.value = next.map((room) => normalizeRoom({ ...room }));
  }

  function reset(): void {
    rooms.value = [];
  }

  watch(rooms, () => saveState(STORAGE_NAME, { rooms: rooms.value } satisfies PersistedRooms), {
    deep: true,
  });

  return {
    rooms,
    totalSeats,
    extraSeatRooms,
    relaxedRooms,
    capacityPlan,
    addRoom,
    addRooms,
    removeRoom,
    removeRooms,
    updateRoom,
    setDoorSide,
    setExtraFrontSeats,
    setRelaxSameClass,
    move,
    roomById,
    renumber,
    replaceRooms,
    reset,
  };
});
