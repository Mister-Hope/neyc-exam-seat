export type * from "./types";

export {
  CORE_SUBJECTS,
  COMBINATION_ORDER,
  PREFERRED_SUBJECTS,
  SECONDARY_SUBJECTS,
  SUBJECT_LABELS,
  SUBJECT_SHORT,
  formatCombination,
  hasSubject,
  normalizeCombination,
  parseCombination,
  subjectLabel,
  subjectListLabel,
  validateSelection,
} from "./subjects";
export type {
  CoreSubject,
  ParsedCombination,
  PreferredSubject,
  SecondarySubject,
  SubjectId,
} from "./subjects";

export {
  describeCols,
  describeRows,
  maxSameClass,
  parseSeatId,
  rcToSeatNo,
  resolveColRef,
  resolveRowRef,
  roomCapacity,
  seatId,
  seatNoToRC,
  toPhysicalCol,
} from "./numbering";

export { compileModel } from "./model";
export type { CompiledModel, CompiledRoom } from "./model";

export { buildConflictGraph, deriveTimeSlots, findSlotConflicts, subjectInSlot } from "./schedule";
export type { TimeSlot } from "./schedule";

export {
  checkSeatMatching,
  compileConstraintSeats,
  compileDomains,
  hasAnySelector,
  resolveConstraintStudents,
} from "./domain";
export type { ConstraintSeatSet, DomainBundle, StudentDomain } from "./domain";

export { MIN_CLASSES_FOR_KING, describeRoomLoad, resolveAdjacency, runPrecheck } from "./precheck";
export type { PrecheckResult } from "./precheck";

export { collectConflicts, solve } from "./solver";
export type { SolveInput, SolveOutput } from "./solver";

export { validate } from "./validate";

export {
  DEFAULT_SEED,
  DEFAULT_TIME_LIMIT_MS,
  RESULT_VERSION,
  isFatal,
  normalizeOptions,
  plan,
  precheckJob,
} from "./plan";
export type { PrecheckOutput } from "./plan";

export { canonicalJson, fingerprint, mulberry32 } from "./util";
