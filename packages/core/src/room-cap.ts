import type { CompiledModel } from "./model";
import { sameClassLimit } from "./util";

/**
 * `relaxSameClass` 为数字时的「考场 × 班级 人数上限」计数器（`docs/design.md` §5.8.1，task-59）。
 *
 * 语义：数字 = **该考场同班人数上限**（`true` = 不限人数，普通考场由相邻规则约束）。 这里维护增量计数，把「超出上限的人次」作为一个**可最小化的违规量**交给退火：
 * 装得下时结果里一间考场都不会超上限；装不下时也不会漏排学生，而是如实留下违规量。
 */
export class RoomClassCaps {
  /** 每间考场的同班人数上限（0 = 不限） */
  private readonly caps: Int32Array;
  private readonly counts: Int32Array;
  private readonly classCount: number;
  /** 有没有任何一间考场设了数字上限（false 时所有方法都是空操作） */
  readonly active: boolean;

  constructor(private readonly model: CompiledModel) {
    this.classCount = Math.max(1, model.classNames.length);
    this.caps = new Int32Array(model.rooms.length);
    model.rooms.forEach((room, index) => {
      this.caps[index] = sameClassLimit(room.spec, room.maxSameClass, room.capacity) ?? 0;
    });
    this.active = this.caps.some((cap) => cap > 0);
    this.counts = new Int32Array(model.rooms.length * this.classCount);
  }

  private index(seat: number, student: number): number {
    return this.model.seatRoom[seat]! * this.classCount + this.model.classOfStudent[student]!;
  }

  /** 某考场超出同班上限的「多出来的人次」之和 */
  private debtOf(roomIndex: number): number {
    const cap = this.caps[roomIndex]!;
    if (cap <= 0) return 0;
    let debt = 0;
    const base = roomIndex * this.classCount;
    for (let c = 0; c < this.classCount; c += 1) {
      const over = this.counts[base + c]! - cap;
      if (over > 0) debt += over;
    }
    return debt;
  }

  /** 所有考场的超出量之和 */
  debtTotal(): number {
    if (!this.active) return 0;
    let total = 0;
    for (let r = 0; r < this.model.rooms.length; r += 1) total += this.debtOf(r);
    return total;
  }

  /** 贪心初始化：把一个学生放到座位上时记账 */
  add(student: number, seat: number): void {
    if (!this.active) return;
    this.counts[this.index(seat, student)]! += 1;
  }

  /** 贪心初始化里的软性避让：坐到这个座位会不会让考场超出同班上限 */
  penalty(student: number, seat: number): number {
    if (!this.active) return 0;
    const room = this.model.seatRoom[seat]!;
    const cap = this.caps[room]!;
    if (cap <= 0) return 0;
    const count = this.counts[room * this.classCount + this.model.classOfStudent[student]!]!;
    return count >= cap ? 1 : 0;
  }

  /** 按当前座位重算全部计数（`restoreBest()` 之后必须调用） */
  rebuild(studentAtSeat: Int32Array): void {
    if (!this.active) return;
    this.counts.fill(0);
    for (let seat = 0; seat < studentAtSeat.length; seat += 1) {
      const student = studentAtSeat[seat]!;
      if (student < 0) continue;
      this.counts[this.index(seat, student)]! += 1;
    }
  }

  /**
   * 把「两个人互换座位」的计数变更落账，返回超出量的变化（0 = 不受影响）。
   *
   * 取值为 0 的常见情形：两人在**同一间**考场互换（计数不变）、有空位参与（空位只在同考场内换）。
   */
  apply(s1: number, s2: number, u: number, v: number): number {
    if (!this.active || u < 0 || v < 0) return 0;
    const roomA = this.model.seatRoom[s1]!;
    const roomB = this.model.seatRoom[s2]!;
    if (roomA === roomB) return 0;
    const before = this.debtOf(roomA) + this.debtOf(roomB);
    const classU = this.model.classOfStudent[u]!;
    const classV = this.model.classOfStudent[v]!;
    this.counts[roomA * this.classCount + classU]! -= 1;
    this.counts[roomB * this.classCount + classU]! += 1;
    this.counts[roomB * this.classCount + classV]! -= 1;
    this.counts[roomA * this.classCount + classV]! += 1;
    return this.debtOf(roomA) + this.debtOf(roomB) - before;
  }

  /** 这一步被拒绝时把 `apply()` 的计数变更原样回滚 */
  revert(s1: number, s2: number, u: number, v: number): void {
    if (!this.active || u < 0 || v < 0) return;
    const roomA = this.model.seatRoom[s1]!;
    const roomB = this.model.seatRoom[s2]!;
    if (roomA === roomB) return;
    const classU = this.model.classOfStudent[u]!;
    const classV = this.model.classOfStudent[v]!;
    this.counts[roomA * this.classCount + classU]! += 1;
    this.counts[roomB * this.classCount + classU]! -= 1;
    this.counts[roomB * this.classCount + classV]! += 1;
    this.counts[roomA * this.classCount + classV]! -= 1;
  }
}
