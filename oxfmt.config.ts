import { defineHopeConfig } from "oxc-config-hope/oxfmt";
import type { OxfmtConfig } from "oxc-config-hope/oxfmt";

const oxfmtConfig: OxfmtConfig = defineHopeConfig({
  // `.agents/skills/shadcn-vue/**` 是 `skills add unovue/shadcn-vue` 装进来的上游内容
  // （skills-lock.json 记了 hash），格式化它会和上游产生无意义的 diff；
  // 本仓自己写的 `.agents/skills/exam-seating/**` 照常格式化。
  ignorePatterns: [".agents/skills/shadcn-vue/**"],
  sortImports: {
    internalPattern: ["@exam-seat", "@"],
  },
});

export default oxfmtConfig;
