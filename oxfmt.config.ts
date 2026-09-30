import { defineHopeConfig } from "oxc-config-hope/oxfmt";
import type { OxfmtConfig } from "oxc-config-hope/oxfmt";

const oxfmtConfig: OxfmtConfig = defineHopeConfig({
  sortImports: {
    internalPattern: ["@exam-seat", "@"],
  },
});

export default oxfmtConfig;
