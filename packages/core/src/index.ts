export type * from "./types";

export {
  CORE_SUBJECTS,
  COMBINATION_ORDER,
  PREFERRED_SUBJECTS,
  SECONDARY_SUBJECTS,
  SUBJECT_LABELS,
  SUBJECT_SHORT,
  compareCombinationNames,
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
  columnSeatCounts,
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
  seatNoToRCIn,
  toPhysicalCol,
} from "./numbering";
export type { RoomGeometry, SeatRC } from "./numbering";

export { compileModel } from "./model";
export type { CompiledModel, CompiledRoom } from "./model";

export {
  buildConflictGraph,
  deriveTimeSlots,
  findSlotConflicts,
  normalizeSlots,
  subjectInSlot,
} from "./schedule";
export type { TimeSlot } from "./schedule";

export {
  checkSeatMatching,
  compileConstraintSeats,
  compileDomains,
  hasAnySelector,
  resolveConstraintStudents,
} from "./domain";
export type { ConstraintSeatSet, DomainBundle, StudentDomain } from "./domain";

export { evaluateDeliveryAll, findRoomSubjectClashes, planAll } from "./plan-all";
export type {
  BorrowedSeat,
  PlanAllResult,
  PlanAllUnmetConstraint,
  RoomSubjectClash,
  SeatingPlan,
  StudentRoomUsage,
  StudentSchedule,
  StudentSlotAssignment,
} from "./plan-all";

export {
  MIN_CLASSES_FOR_KING,
  describeRoomLoad,
  resolveAdjacency,
  runPrecheck,
  validateRoomGeometry,
} from "./precheck";
export type { PrecheckResult } from "./precheck";

export { collectConflicts, solve } from "./solver";
export type { SolveInput, SolveOutput } from "./solver";

export { validate, validateAll } from "./validate";
export type { PlanAllSeatingValidation, PlanAllValidation } from "./validate";

export {
  DEFAULT_SEED,
  DEFAULT_TIME_LIMIT_MS,
  RESULT_VERSION,
  blocksListExport,
  evaluateDelivery,
  isFatal,
  normalizeOptions,
  plan,
  planDelivery,
  precheckJob,
  validationIssueDiagnostics,
} from "./plan";
export type { PrecheckOutput } from "./plan";

export {
  canonicalJson,
  fingerprint,
  isSameClassRelaxed,
  mulberry32,
  relaxedClassLimit,
  roomCombination,
} from "./util";
