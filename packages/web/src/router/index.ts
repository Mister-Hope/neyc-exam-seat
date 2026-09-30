import { createRouter, createWebHashHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";

export interface StepDefinition {
  path: string;
  title: string;
  /** 步骤条上的短标题 */
  short: string;
  description: string;
  component: () => Promise<unknown>;
}

/** 六个步骤页。`el-steps` 的顺序、路由、标题都从这一份定义来，避免两处写重复。 用 hash 路由：纯前端无后端，丢到任何静态目录（甚至 file://）都能直接打开。 */
export const STEPS: StepDefinition[] = [
  {
    path: "/import",
    title: "导入名单",
    short: "导入名单",
    description: "上传 .xlsx，确认列映射，检查问题行",
    component: () => import("@/views/StepImport.vue"),
  },
  {
    path: "/exclude",
    title: "排除缺考",
    short: "排除缺考",
    description: "查询 → 全选结果 → 批量排除",
    component: () => import("@/views/StepExclude.vue"),
  },
  {
    path: "/rooms",
    title: "配置考场",
    short: "配置考场",
    description: "考场数量、大小、门的位置、监考老师，附座位编号缩略图",
    component: () => import("@/views/StepRooms.vue"),
  },
  {
    path: "/constraints",
    title: "设置限定",
    short: "设置限定",
    description: "考场（单选）+ 排 + 列，实时冲突检测",
    component: () => import("@/views/StepConstraints.vue"),
  },
  {
    path: "/solve",
    title: "排考场",
    short: "排考场",
    description: "预检 → Web Worker 求解 → 完美 / 已降级 / 排不出来",
    component: () => import("@/views/StepSolve.vue"),
  },
  {
    path: "/result",
    title: "结果名单",
    short: "结果名单",
    description: "考场 + 座位号的名单，校验报告，导出 xlsx",
    component: () => import("@/views/StepResult.vue"),
  },
];

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: STEPS[0]!.path },
  ...STEPS.map((step) => ({
    path: step.path,
    name: step.path.slice(1),
    component: step.component,
    meta: { title: step.title },
  })),
  { path: "/:pathMatch(.*)*", redirect: STEPS[0]!.path },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
