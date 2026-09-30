import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { loadState, saveState } from "@/lib/persist";
import { ROOM_PRESETS, planCapacity } from "@/lib/seat-grid";
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

/** 第 ③ 步：考场配置。容量与空置推算见 `@/lib/seat-grid` 的 planCapacity（纯函数，可测）。 */
export const useRoomsStore = defineStore("rooms", () => {
  const saved = loadState<PersistedRooms>(STORAGE_NAME, { rooms: [] });
  const rooms = ref<RoomSpec[]>(saved.rooms ?? []);

  const totalSeats = computed(() => rooms.value.reduce((sum, room) => sum + roomCapacity(room), 0));

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

  function updateRoom(id: string, patch: Partial<RoomSpec>): void {
    rooms.value = rooms.value.map((room) => (room.id === id ? { ...room, ...patch } : room));
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
    rooms.value = next.map((room) => ({ ...room }));
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
    capacityPlan,
    addRoom,
    addRooms,
    removeRoom,
    updateRoom,
    setDoorSide,
    move,
    roomById,
    renumber,
    replaceRooms,
    reset,
  };
});
