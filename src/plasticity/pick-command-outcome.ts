// Outcome classification for viewport-pick commands (runPickCommand / plasticity_set_driving_distance).
//
// The native source reports facts; this module classifies them. The result is exactly one of four kinds:
//   committed-verified  one Undo step, nothing of ours active, the post-commit geometry check passed: success.
//   committed-mismatch  one Undo step, a clean commit (execute() resolved, no error, nothing active), but the geometry
//                       check failed: a certain error, the document is in a known state and plasticity_undo restores it.
//   rejected-unchanged  finish() was never called and nothing changed; or finish() was called, Plasticity refused the
//                       commit with its no-effect rejection, nothing is active and nothing changed after the settle window.
//   undetermined        everything else: the runtime is marked uncertain and the caller must reconcile.
// INVARIANT: once finish() was called, "unchanged" is claimed only under the rejected-unchanged conditions above, so the
// tool never returns a certain non-success result while a commit of ours can still land.

export type PickOutcomeKind = "committed-verified" | "committed-mismatch" | "rejected-unchanged" | "undetermined";

/** How execute() / exec() ended. "rejected" means execute() threw (the 26.1.3 executor swallows it and resolves exec()). */
export type PickSettleKind = "resolved" | "rejected" | "never";

/** The kind of the native error, from its text and constructor name. */
export type PickErrorKind = "none" | "no-effect" | "cancel" | "abort" | "other";

export type PickCancelResult = "not-needed" | "ok" | "failed" | "threw";

export interface PickOutcomeFacts {
  /** The native record lacked a required fact (a malformed or foreign record): never trusted. */
  malformed?: string | null;
  /** The drive step called the dialog's finish(): from then on a commit may be running. */
  finishCalled: boolean;
  /** finish() was called after the drive step had returned (it was refused, but the contract was broken). */
  lateFinish: boolean;
  settle: PickSettleKind;
  errorText: string | null;
  errorName: string | null;
  /** Undo depth change when the command flow ended, before the settle window. */
  undoDeltaAtReturn: number;
  /** Undo depth change after the settle window (the last measurement). */
  undoDeltaAfterSettle: number;
  /** Our command (by identity) is still the executor's active command. */
  ourActive: boolean;
  /** Name of a different command that is active at the end, or null. */
  foreignActive: string | null;
  cancel: PickCancelResult;
  cleanup: "ok" | "threw";
  /** The body differs from its pre-edit snapshot; null when it could not be read. */
  bodyChanged: boolean | null;
  /** Post-commit geometry check; null when it did not run. */
  geometry: "pass" | "fail" | null;
}

export type PickOutcomeReason =
  | "malformed" | "late-finish" | "cleanup-failed" | "cancel-failed" | "never-settled" | "still-active"
  | "history-changed-before-finish" | "body-changed-before-finish" | "body-unknown"
  | "no-effect" | "interrupted" | "cancelled" | "failed"
  | "verified" | "mismatch" | "mismatch-unclean" | "readback-missing"
  | "too-many-steps" | "history-shrank" | "no-commit" | "body-changed-no-step" | "error-after-finish" | "no-effect-unclean";

export interface PickOutcome {
  kind: PickOutcomeKind;
  reason: PickOutcomeReason;
  errorKind: PickErrorKind;
}

// The only no-effect text the live probes recorded (discovery/probes-2026-11-*: "Operation has no effect", wrapped by the
// executor as "Exec.execute:rejected CommandExecutor  Operation has no effect"). Anchored to the exact phrase.
const NO_EFFECT = /(?:^|\s)Operation has no effect\s*$/;
// Cancel-type texts seen live after a cancel (probe-late-commit.json): "invalid state: cancelled", "Invalid state
// transition", and the stubs' "Cancelled". Interrupt and abort class names count too.
const CANCEL_LIKE = /\bcancell?ed\b|\binvalid state\b|\binterrupt(?:ed)?\b/i;
const ABORT_LIKE = /\bPK_ERROR_aborted\b|\babort(?:ed)?\b/i;

export function pickErrorKind(text: string | null, name: string | null): PickErrorKind {
  if (text === null || text === "") return name ? "other" : "none";
  if (NO_EFFECT.test(text)) return "no-effect";
  if (ABORT_LIKE.test(text) || /^Abort/.test(name ?? "")) return "abort";
  if (CANCEL_LIKE.test(text) || /^(Cancel|Interrupt)/.test(name ?? "")) return "cancel";
  return "other";
}

// The table: rows are checked in order, the first matching row decides. Each row reads one condition of the spec.
type Row = { when: (facts: PickOutcomeFacts, errorKind: PickErrorKind) => boolean; kind: PickOutcomeKind; reason: PickOutcomeReason };

const delta = (facts: PickOutcomeFacts) => facts.undoDeltaAfterSettle;

export const PICK_OUTCOME_TABLE: readonly Row[] = Object.freeze([
  // Facts that make every claim unsafe, before or after finish().
  { when: (f) => Boolean(f.malformed), kind: "undetermined", reason: "malformed" },
  { when: (f) => f.lateFinish, kind: "undetermined", reason: "late-finish" },
  { when: (f) => f.cleanup !== "ok", kind: "undetermined", reason: "cleanup-failed" },
  { when: (f) => f.cancel === "failed" || f.cancel === "threw", kind: "undetermined", reason: "cancel-failed" },
  { when: (f) => f.settle === "never", kind: "undetermined", reason: "never-settled" },
  { when: (f) => f.ourActive, kind: "undetermined", reason: "still-active" },
  { when: (f) => !Number.isInteger(f.undoDeltaAtReturn) || !Number.isInteger(f.undoDeltaAfterSettle) || f.undoDeltaAfterSettle < f.undoDeltaAtReturn, kind: "undetermined", reason: "history-shrank" },
  // finish() never called: no commit of ours can land. Unchanged when the history and the body are unchanged.
  { when: (f) => !f.finishCalled && delta(f) !== 0, kind: "undetermined", reason: "history-changed-before-finish" },
  { when: (f) => !f.finishCalled && f.bodyChanged === true, kind: "undetermined", reason: "body-changed-before-finish" },
  { when: (f) => !f.finishCalled && f.bodyChanged === null, kind: "undetermined", reason: "body-unknown" },
  { when: (f, e) => !f.finishCalled && f.settle === "rejected" && e === "no-effect", kind: "rejected-unchanged", reason: "no-effect" },
  { when: (f, e) => !f.finishCalled && f.settle === "rejected" && (e === "cancel" || e === "abort" || f.foreignActive !== null) && f.cancel === "not-needed", kind: "rejected-unchanged", reason: "interrupted" },
  { when: (f) => !f.finishCalled && f.cancel === "ok", kind: "rejected-unchanged", reason: "cancelled" },
  { when: (f) => !f.finishCalled, kind: "rejected-unchanged", reason: "failed" },
  // finish() called, one Undo step after the settle window.
  { when: (f) => delta(f) === 1 && f.geometry === "pass", kind: "committed-verified", reason: "verified" },
  { when: (f) => delta(f) === 1 && f.geometry === null, kind: "undetermined", reason: "readback-missing" },
  { when: (f, e) => delta(f) === 1 && f.geometry === "fail" && f.settle === "resolved" && e === "none" && f.foreignActive === null && f.cancel === "not-needed", kind: "committed-mismatch", reason: "mismatch" },
  { when: (f) => delta(f) === 1, kind: "undetermined", reason: "mismatch-unclean" },
  { when: (f) => delta(f) !== 0, kind: "undetermined", reason: "too-many-steps" },
  // finish() called, no Undo step after the settle window.
  { when: (f) => f.bodyChanged !== false, kind: "undetermined", reason: "body-changed-no-step" },
  { when: (f, e) => f.settle === "rejected" && e === "no-effect" && f.foreignActive === null && f.cancel === "not-needed", kind: "rejected-unchanged", reason: "no-effect" },
  { when: (f, e) => f.settle === "rejected" && e === "no-effect", kind: "undetermined", reason: "no-effect-unclean" },
  { when: (f) => f.settle === "resolved" && f.errorText === null, kind: "undetermined", reason: "no-commit" },
  { when: () => true, kind: "undetermined", reason: "error-after-finish" },
] satisfies Row[]);

/** Classifies a pick-command run. Pure: the same facts always give the same outcome. */
export function classifyPickOutcome(facts: PickOutcomeFacts): PickOutcome {
  const errorKind = pickErrorKind(facts.errorText, facts.errorName);
  const row = PICK_OUTCOME_TABLE.find((candidate) => candidate.when(facts, errorKind))!;
  return { kind: row.kind, reason: row.reason, errorKind };
}

/** True when the outcome lets the tool say the document is unchanged. */
export const claimsUnchanged = (outcome: PickOutcome) => outcome.kind === "rejected-unchanged";
