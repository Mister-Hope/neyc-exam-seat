import { ref } from "vue";

/**
 * Promise 化的确认框（替代 `ElMessageBox.confirm`）。
 *
 * 用法：`if (!(await confirmAction({ title: "确定删除？" }))) return;` 页面里挂一个 `<ConfirmDialog />`（App
 * 外壳已经挂好了）。
 */
export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作用红色按钮（删除 / 清空）。 */
  danger?: boolean;
}

const open = ref(false);
const options = ref<ConfirmOptions>({ title: "" });
let resolver: ((confirmed: boolean) => void) | null = null;

export async function confirmAction(next: ConfirmOptions): Promise<boolean> {
  // 上一个还没关就被新请求顶掉：旧的按「取消」处理，避免 Promise 永远悬着
  resolver?.(false);
  resolver = null;
  options.value = next;
  open.value = true;
  return new Promise<boolean>((resolve) => {
    resolver = resolve;
  });
}

export function resolveConfirm(confirmed: boolean): void {
  open.value = false;
  const done = resolver;
  resolver = null;
  done?.(confirmed);
}

export function confirmState(): { open: typeof open; options: typeof options } {
  return { open, options };
}
