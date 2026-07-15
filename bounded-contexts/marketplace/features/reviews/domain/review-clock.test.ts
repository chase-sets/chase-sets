import { describe, expect, it } from "vitest";
import { transitionReviewClock, type ReviewClockSnapshot } from "./review-clock";

function clock(overrides: Partial<ReviewClockSnapshot> = {}): ReviewClockSnapshot {
  return {
    eligibleAt: "2026-07-01T00:00:00.000Z",
    effectiveDeadlineAt: "2026-08-30T00:00:00.000Z",
    submissionState: "allowed",
    holdStartedAt: null,
    pausedRemainingMs: null,
    reminderArmedAt: "2026-07-01T00:00:00.000Z",
    reminderNotifiedAt: null,
    holdCycle: 0,
    ...overrides,
  };
}

describe("review clock", () => {
  it("pauses once across concurrent requests and resumes with its remaining time", () => {
    const held = transitionReviewClock(clock(), {
      eligibleAt: "2026-07-01T00:00:00.000Z",
      directionHeld: true,
      transitionedAt: "2026-08-01T00:00:00.000Z",
    }).clock;
    const stillHeld = transitionReviewClock(held, {
      eligibleAt: held.eligibleAt,
      directionHeld: true,
      transitionedAt: "2026-08-10T00:00:00.000Z",
    }).clock;
    const resumed = transitionReviewClock(stillHeld, {
      eligibleAt: held.eligibleAt,
      directionHeld: false,
      transitionedAt: "2026-08-20T00:00:00.000Z",
    });

    expect(stillHeld).toEqual(held);
    expect(resumed.resumed).toBe(true);
    expect(resumed.clock.effectiveDeadlineAt).toBe("2026-09-18T00:00:00.000Z");
  });

  it("grants a 14-day minimum when less time remained", () => {
    const held = transitionReviewClock(clock({ effectiveDeadlineAt: "2026-07-10T00:00:00.000Z" }), {
      eligibleAt: "2026-07-01T00:00:00.000Z",
      directionHeld: true,
      transitionedAt: "2026-07-09T00:00:00.000Z",
    }).clock;
    const resumed = transitionReviewClock(held, {
      eligibleAt: held.eligibleAt,
      directionHeld: false,
      transitionedAt: "2026-07-20T00:00:00.000Z",
    }).clock;

    expect(resumed.effectiveDeadlineAt).toBe("2026-08-03T00:00:00.000Z");
    expect(resumed.reminderArmedAt).toBe("2026-07-20T00:00:00.000Z");
  });

  it("does not revive a window that expired before the hold opened", () => {
    const held = transitionReviewClock(clock({ effectiveDeadlineAt: "2026-07-10T00:00:00.000Z" }), {
      eligibleAt: "2026-05-11T00:00:00.000Z",
      directionHeld: true,
      transitionedAt: "2026-07-11T00:00:00.000Z",
    }).clock;
    const afterTerminal = transitionReviewClock(held, {
      eligibleAt: held.eligibleAt,
      directionHeld: false,
      transitionedAt: "2026-07-20T00:00:00.000Z",
    }).clock;

    expect(held.submissionState).toBe("expired");
    expect(afterTerminal.submissionState).toBe("expired");
    expect(afterTerminal.effectiveDeadlineAt).toBe("2026-07-10T00:00:00.000Z");
  });

  it("uses the then-current remaining time for a reopened hold", () => {
    const firstHold = transitionReviewClock(clock(), {
      eligibleAt: "2026-07-01T00:00:00.000Z",
      directionHeld: true,
      transitionedAt: "2026-07-11T00:00:00.000Z",
    }).clock;
    const firstResume = transitionReviewClock(firstHold, {
      eligibleAt: firstHold.eligibleAt,
      directionHeld: false,
      transitionedAt: "2026-07-20T00:00:00.000Z",
    }).clock;
    const secondHold = transitionReviewClock(firstResume, {
      eligibleAt: firstResume.eligibleAt,
      directionHeld: true,
      transitionedAt: "2026-08-01T00:00:00.000Z",
    }).clock;

    expect(secondHold.holdCycle).toBe(2);
    expect(secondHold.pausedRemainingMs).toBe(38 * 24 * 60 * 60 * 1000);
  });
});
