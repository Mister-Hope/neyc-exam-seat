/**
 * 3+1+2 选科模型。
 *
 * - 3 门必考：语文、数学、外语
 * - 1 门首选：物理 / 历史（二选一）
 * - 2 门再选：化学 / 生物 / 政治 / 地理（四选二）
 */

export const CORE_SUBJECTS = ["chinese", "math", "english"] as const;
export const PREFERRED_SUBJECTS = ["physics", "history"] as const;
export const SECONDARY_SUBJECTS = ["chemistry", "biology", "politics", "geography"] as const;

export type CoreSubject = (typeof CORE_SUBJECTS)[number];
export type PreferredSubject = (typeof PREFERRED_SUBJECTS)[number];
export type SecondarySubject = (typeof SECONDARY_SUBJECTS)[number];
export type SubjectId = CoreSubject | PreferredSubject | SecondarySubject;

/** 中文全名 */
export const SUBJECT_LABELS: Record<string, string> = {
  chinese: "语文",
  math: "数学",
  english: "外语",
  physics: "物理",
  history: "历史",
  chemistry: "化学",
  biology: "生物",
  politics: "政治",
  geography: "地理",
};

/** 单字简称，用来拼「物化政」这种组合名 */
export const SUBJECT_SHORT: Record<string, string> = {
  chinese: "语",
  math: "数",
  english: "外",
  physics: "物",
  history: "史",
  chemistry: "化",
  biology: "生",
  politics: "政",
  geography: "地",
};

/**
 * 组合名的展示顺序。
 *
 * 这个顺序不是随便定的——它必须能拼出约定俗成的四个名字： 物化生、物化政、物化地、政史地。 注意政治排在历史前面，否则「政史地」会被拼成「史政地」。
 */
export const COMBINATION_ORDER: readonly string[] = [
  "physics",
  "chemistry",
  "biology",
  "politics",
  "history",
  "geography",
  "chinese",
  "math",
  "english",
];

/** 识别选科文本用的别名表。最长匹配优先，所以「生物」不会被拆成「生 + 物」。 */
const ALIASES: Record<string, string> = {
  语文: "chinese",
  汉语: "chinese",
  语: "chinese",
  数学: "math",
  数: "math",
  外语: "english",
  英语: "english",
  英: "english",
  物理: "physics",
  物: "physics",
  历史: "history",
  历: "history",
  史: "history",
  化学: "chemistry",
  化: "chemistry",
  生物: "biology",
  生: "biology",
  政治: "politics",
  思想政治: "politics",
  思想品德: "politics",
  政: "politics",
  地理: "geography",
  地: "geography",
};

const MAX_ALIAS_LENGTH = 4;
const SEPARATOR = /[\s,，、;；/|·]/;

export interface ParsedCombination {
  /** 规范化后的组合名，例如「物化政」 */
  combination: string;
  /** 解析出的科目 id，按 COMBINATION_ORDER 排序 */
  subjects: string[];
  /** 没认出来的字，用于报错提示 */
  unknown: string[];
}

/** 解析选科文本。能吃下各种写法： `物化政`、`物理化学政治`、`物理、化学、政治`、`物理 化学 政治`。 */
export function parseCombination(text: string): ParsedCombination {
  const source = (text ?? "").trim();
  const subjects: string[] = [];
  const unknown: string[] = [];

  let i = 0;
  while (i < source.length) {
    let matched = false;
    const maxLen = Math.min(MAX_ALIAS_LENGTH, source.length - i);
    for (let len = maxLen; len >= 1; len -= 1) {
      const chunk = source.slice(i, i + len);
      const id = ALIASES[chunk];
      if (id !== undefined) {
        if (!subjects.includes(id)) subjects.push(id);
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      const ch = source[i]!;
      if (!SEPARATOR.test(ch)) unknown.push(ch);
      i += 1;
    }
  }

  const ordered = COMBINATION_ORDER.filter((s) => subjects.includes(s));
  return {
    combination: ordered.map((s) => SUBJECT_SHORT[s] ?? "?").join(""),
    subjects: ordered,
    unknown,
  };
}

/** 把科目集合拼成规范的组合名，例如 ['politics','history','geography'] → 「政史地」 */
export function formatCombination(subjects: readonly string[]): string {
  return COMBINATION_ORDER.filter((s) => subjects.includes(s))
    .map((s) => SUBJECT_SHORT[s] ?? "?")
    .join("");
}

/** 把任意写法的组合名规范化，用于比较，例如「物理化学政治」→「物化政」 */
export function normalizeCombination(text: string): string {
  return parseCombination(text).combination;
}

/** 校验是不是合法的 3+1+2 选科，返回问题列表（空数组 = 合规）。 */
export function validateSelection(subjects: readonly string[]): string[] {
  const problems: string[] = [];
  const preferred = subjects.filter((s) => (PREFERRED_SUBJECTS as readonly string[]).includes(s));
  const secondary = subjects.filter((s) => (SECONDARY_SUBJECTS as readonly string[]).includes(s));

  if (preferred.length !== 1) {
    problems.push(`首选科目应当恰好 1 门（物理/历史），实际 ${preferred.length} 门`);
  }
  if (secondary.length !== 2) {
    problems.push(`再选科目应当恰好 2 门（化学/生物/政治/地理），实际 ${secondary.length} 门`);
  }
  return problems;
}

/** 传统理科科目 */
export const SCIENCE_SUBJECTS: readonly string[] = ["physics", "chemistry", "biology"];
/** 传统文科科目 */
export const HUMANITIES_SUBJECTS: readonly string[] = ["history", "politics", "geography"];

/**
 * 是不是「常规组合」（老的文理分科）。
 *
 * 全部选考科目都落在理科一侧（物化生）或都落在文科一侧（政史地）→ 常规； 跨了文理两边（物化政、物化地）→ 非常规。
 *
 * 常规组合的学生整个考试期间**只在一个考场**；非常规组合会多跑一个专用考场。 判断不了的组合可以用 `options.regularCombinations` 手工覆盖。
 */
export function isRegularCombination(subjects: readonly string[]): boolean {
  const electives = subjects.filter(
    (s) => SCIENCE_SUBJECTS.includes(s) || HUMANITIES_SUBJECTS.includes(s),
  );
  if (electives.length === 0) return true;
  return (
    electives.every((s) => SCIENCE_SUBJECTS.includes(s)) ||
    electives.every((s) => HUMANITIES_SUBJECTS.includes(s))
  );
}

/** 该学生是否选了某门科目。 */
export function hasSubject(
  subjects: readonly string[] | undefined | null,
  subject: string,
): boolean {
  return subjects?.includes(subject) ?? false;
}

/** 科目的中文全名 */
export function subjectLabel(id: string): string {
  return SUBJECT_LABELS[id] ?? id;
}

/** 考场标题里科目的显示顺序：语数外在前，然后物化生政史地 */
const LABEL_ORDER: readonly string[] = [
  "chinese",
  "math",
  "english",
  "physics",
  "chemistry",
  "biology",
  "politics",
  "history",
  "geography",
];

/** 把一串科目渲染成紧凑的中文，用于考场标题，例如「语数外物化生」。 注意与 {@link formatCombination} 的区别：那个是拼组合名（物化生），这个是拼科目清单。 */
export function subjectListLabel(subjects: readonly string[]): string {
  return LABEL_ORDER.filter((s) => subjects.includes(s))
    .map((s) => SUBJECT_SHORT[s] ?? s)
    .join("");
}
