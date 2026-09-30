/** LocalStorage 持久化。所有键统一带 `exam-seat:` 前缀，方便一键清理， 也避免和同域下别的应用撞键。刷新页面后老师的手工配置不丢。 */
export const STORAGE_PREFIX = "exam-seat:";

export function storageKey(name: string): string {
  return `${STORAGE_PREFIX}${name}`;
}

function getStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function saveState(name: string, value: unknown): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.setItem(storageKey(name), JSON.stringify(value));
    return true;
  } catch {
    // 配额爆了或存了不可序列化的东西：不打断老师操作
    return false;
  }
}

export function loadState<T>(name: string, fallback: T): T {
  const storage = getStorage();
  if (!storage) return fallback;
  const raw = storage.getItem(storageKey(name));
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function removeState(name: string): void {
  getStorage()?.removeItem(storageKey(name));
}

/** 清掉本应用写在 localStorage 里的所有键。 */
export function clearExamSeatStorage(): string[] {
  const storage = getStorage();
  if (!storage) return [];
  const removed: string[] = [];
  for (let i = storage.length - 1; i >= 0; i -= 1) {
    const key = storage.key(i);
    if (key && key.startsWith(STORAGE_PREFIX)) {
      storage.removeItem(key);
      removed.push(key);
    }
  }
  return removed;
}
