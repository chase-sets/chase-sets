import { addReviewWindowDays, REVIEW_WINDOW_DAYS } from "./common";

export const REVIEW_RESUME_MINIMUM_DAYS = 14;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export type ReviewClockSubmissionState = "allowed" | "held" | "expired";

export type ReviewClockSnapshot = Readonly<{
  eligibleAt: string;
  effectiveDeadlineAt: string;
  submissionState: ReviewClockSubmissionState;
  holdStartedAt: string | null;
  pausedRemainingMs: number | null;
  reminderArmedAt: string;
  reminderNotifiedAt: string | null;
  holdCycle: number;
}>;

export type ReviewClockTransition = Readonly<{
  clock: ReviewClockSnapshot;
  resumed: boolean;
}>;

function remainingMilliseconds(deadlineAt: string, pausedAt: string): number {
  return Math.max(0, Date.parse(deadlineAt) - Date.parse(pausedAt));
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

export function transitionReviewClock(
  existing: ReviewClockSnapshot | null,
  input: Readonly<{ eligibleAt: string; directionHeld: boolean; transitionedAt: string }>,
): ReviewClockTransition {
  if (existing === null) {
    const effectiveDeadlineAt = addReviewWindowDays(input.eligibleAt, REVIEW_WINDOW_DAYS);
    const remaining = remainingMilliseconds(effectiveDeadlineAt, input.transitionedAt);
    if (input.directionHeld && remaining > 0) {
      return {
        clock: {
          eligibleAt: input.eligibleAt,
          effectiveDeadlineAt,
          submissionState: "held",
          holdStartedAt: input.transitionedAt,
          pausedRemainingMs: remaining,
          reminderArmedAt: input.eligibleAt,
          reminderNotifiedAt: null,
          holdCycle: 1,
        },
        resumed: false,
      };
    }

    return {
      clock: {
        eligibleAt: input.eligibleAt,
        effectiveDeadlineAt,
        submissionState: remaining === 0 ? "expired" : "allowed",
        holdStartedAt: null,
        pausedRemainingMs: null,
        reminderArmedAt: input.eligibleAt,
        reminderNotifiedAt: null,
        holdCycle: 0,
      },
      resumed: false,
    };
  }

  if (input.directionHeld) {
    if (existing.submissionState === "held" || existing.submissionState === "expired") {
      return { clock: existing, resumed: false };
    }

    const remaining = remainingMilliseconds(existing.effectiveDeadlineAt, input.transitionedAt);
    if (remaining === 0) {
      return {
        clock: {
          ...existing,
          submissionState: "expired",
          holdStartedAt: null,
          pausedRemainingMs: null,
        },
        resumed: false,
      };
    }

    return {
      clock: {
        ...existing,
        submissionState: "held",
        holdStartedAt: input.transitionedAt,
        pausedRemainingMs: remaining,
        holdCycle: existing.holdCycle + 1,
      },
      resumed: false,
    };
  }

  if (existing.submissionState !== "held") {
    const expired = Date.parse(input.transitionedAt) >= Date.parse(existing.effectiveDeadlineAt);
    return {
      clock: expired ? { ...existing, submissionState: "expired" } : existing,
      resumed: false,
    };
  }

  const remaining = existing.pausedRemainingMs ?? 0;
  if (remaining === 0) {
    return {
      clock: {
        ...existing,
        submissionState: "expired",
        holdStartedAt: null,
        pausedRemainingMs: null,
      },
      resumed: false,
    };
  }

  const minimumResponseWindowMs = REVIEW_RESUME_MINIMUM_DAYS * MILLISECONDS_PER_DAY;
  return {
    clock: {
      ...existing,
      effectiveDeadlineAt: addMilliseconds(input.transitionedAt, Math.max(remaining, minimumResponseWindowMs)),
      submissionState: "allowed",
      holdStartedAt: null,
      pausedRemainingMs: null,
      reminderArmedAt: input.transitionedAt,
      reminderNotifiedAt: null,
    },
    resumed: true,
  };
}
