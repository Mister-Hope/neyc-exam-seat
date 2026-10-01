<script setup lang="ts">
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { confirmState, resolveConfirm } from "@/composables/useConfirm";

/** 全局唯一的确认框；`confirmAction()` 返回 Promise<boolean>。 */
const { open, options } = confirmState();

function onOpenChange(value: boolean): void {
  // Esc / 点遮罩关闭 = 取消
  if (!value) resolveConfirm(false);
}
</script>

<template>
  <AlertDialog :open="open" @update:open="onOpenChange">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ options.title }}</AlertDialogTitle>
        <AlertDialogDescription>{{ options.description ?? "" }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel @click="resolveConfirm(false)">
          {{ options.cancelText ?? "取消" }}
        </AlertDialogCancel>
        <AlertDialogAction
          :variant="options.danger ? 'destructive' : 'default'"
          @click="resolveConfirm(true)"
        >
          {{ options.confirmText ?? "确定" }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
