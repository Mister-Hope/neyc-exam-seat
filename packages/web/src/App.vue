<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { toast } from "vue-sonner";

import ConfirmDialog from "@/components/ConfirmDialog.vue";
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
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Toaster } from "@/components/ui/sonner";
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from "@/components/ui/stepper";
import { Textarea } from "@/components/ui/textarea";
import { confirmAction } from "@/composables/useConfirm";
import { useExamJob } from "@/composables/useExamJob";
import { JSON_MIME, downloadText, pickFile, readFileText } from "@/lib/download";
import { parseJobText, serializeJob } from "@/lib/job";
import { clearExamSeatStorage } from "@/lib/persist";
import { STEPS } from "@/router";
import { useConstraintsStore } from "@/stores/constraints";
import { useOptionsStore } from "@/stores/options";
import { useResultStore } from "@/stores/result";
import { useRoomsStore } from "@/stores/rooms";
import { useRosterStore } from "@/stores/roster";

/** 应用外壳：步骤条 + job.json 双向互通（老师配一半导给 AI，AI 补完再导回来复核）。 */
const route = useRoute();
const router = useRouter();
const { job, loadJob } = useExamJob();

const roster = useRosterStore();
const rooms = useRoomsStore();
const constraints = useConstraintsStore();
const options = useOptionsStore();
const resultStore = useResultStore();

const pasteVisible = ref(false);
const pasteText = ref("");
const pasteError = ref("");

const active = computed(() => {
  const index = STEPS.findIndex((step) => step.path === route.path);
  return index === -1 ? 0 : index;
});

const currentStep = computed(() => STEPS[active.value]);

function goToStep(step: number | undefined): void {
  if (step == null) return;
  const target = STEPS[step - 1];
  if (target) router.push(target.path);
}

function applyImportedJob(text: string): void {
  const parsed = parseJobText(text);
  loadJob(parsed);
  resultStore.clear();
  toast.success(`排布状态已导入：${parsed.students.length} 名学生 / ${parsed.rooms.length} 个考场`);
}

async function importJobFile(): Promise<void> {
  const file = await pickFile(".json,application/json");
  if (!file) return;
  try {
    applyImportedJob(await readFileText(file));
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

function importFromPaste(): void {
  try {
    applyImportedJob(pasteText.value);
    pasteVisible.value = false;
    pasteText.value = "";
    pasteError.value = "";
  } catch (err) {
    pasteError.value = err instanceof Error ? err.message : String(err);
  }
}

function exportJob(): void {
  downloadText(serializeJob(job.value), "排布状态.json", JSON_MIME);
  toast.success("已导出排布状态，下次可以直接导入继续");
}

async function clearAll(): Promise<void> {
  const confirmed = await confirmAction({
    title: "清空全部数据",
    description: "会清空名单、考场、限定、结果，以及 localStorage 里的所有 exam-seat: 数据。",
    confirmText: "清空",
    danger: true,
  });
  if (!confirmed) return;
  clearExamSeatStorage();
  roster.reset();
  rooms.reset();
  constraints.reset();
  options.reset();
  resultStore.clear();
  toast.success("已清空");
  router.push("/import");
}
</script>

<template>
  <div class="bg-background text-foreground flex min-h-screen flex-col">
    <header
      class="bg-background/95 supports-backdrop-filter:backdrop-blur sticky top-0 z-20 border-b"
    >
      <div class="flex flex-wrap items-center gap-3 px-5 py-2.5">
        <div class="flex items-baseline gap-1.5 whitespace-nowrap">
          <span class="text-lg font-bold">考场排布</span>
        </div>
        <div class="flex flex-col gap-0.5">
          <Input
            v-model="options.title"
            class="h-8 w-[22rem] max-w-[60vw]"
            placeholder="考试名称，例如 2026届高三一模"
          />
          <span class="text-muted-foreground text-[11px] leading-none">
            会作为导出表格的总标题，可以留空
          </span>
        </div>
        <div class="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" size="sm" @click="importJobFile">导入排布状态</Button>
          <Button variant="outline" size="sm" @click="pasteVisible = true">粘贴导入</Button>
          <Button size="sm" @click="exportJob">导出排布状态</Button>
          <Button variant="destructive" size="sm" @click="clearAll">清空数据</Button>
        </div>
      </div>
      <Separator />
      <div class="bg-muted/40 flex flex-wrap items-center gap-2 px-5 py-2">
        <Badge variant="secondary">名单 {{ roster.total }} 人</Badge>
        <Badge variant="secondary">实际参考 {{ roster.participants }} 人</Badge>
        <Badge variant="secondary"
          >考场 {{ rooms.rooms.length }} 个 / {{ rooms.totalSeats }} 座</Badge
        >
        <Badge variant="secondary">限定 {{ constraints.count }} 条</Badge>
        <Badge :variant="resultStore.hasResult ? 'default' : 'secondary'">
          {{ resultStore.hasResult ? "已有结果" : "未排考场" }}
        </Badge>
        <span class="text-muted-foreground text-xs">{{ currentStep?.description }}</span>
      </div>
    </header>

    <main class="flex-1 px-5 pb-12">
      <Stepper
        :model-value="active + 1"
        :linear="false"
        class="mx-auto my-3 w-full max-w-5xl"
        @update:model-value="goToStep"
      >
        <StepperItem
          v-for="(step, index) in STEPS"
          :key="step.path"
          :step="index + 1"
          class="min-w-0 flex-1"
        >
          <StepperTrigger class="w-full cursor-pointer" :data-testid="`step-${index + 1}`">
            <StepperIndicator>{{ index + 1 }}</StepperIndicator>
            <StepperTitle class="text-xs whitespace-nowrap">{{ step.short }}</StepperTitle>
          </StepperTrigger>
          <StepperSeparator
            v-if="index < STEPS.length - 1"
            class="bg-border mx-1 h-px min-w-4 flex-1"
          />
        </StepperItem>
      </Stepper>

      <RouterView />
    </main>

    <Dialog v-model:open="pasteVisible">
      <DialogContent class="max-w-2xl">
        <DialogHeader>
          <DialogTitle>粘贴导入排布状态</DialogTitle>
          <DialogDescription
            >把之前导出的排布状态内容整段粘到这里，导入后可继续核对。</DialogDescription
          >
        </DialogHeader>
        <Textarea v-model="pasteText" :rows="14" placeholder="粘贴排布状态内容" />
        <p v-if="pasteError" class="text-destructive text-sm">{{ pasteError }}</p>
        <DialogFooter>
          <Button variant="outline" @click="pasteVisible = false">取消</Button>
          <Button :disabled="pasteText.trim().length === 0" @click="importFromPaste">导入</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <ConfirmDialog />
    <Toaster position="top-center" rich-colors />
  </div>
</template>
