import { describe, expect, it } from "vitest";
import { opportunitySlot } from "./publication";

describe("canonical opportunity slot publication", () => {
  it.each(["buyer", "seller"] as const)(
    "preserves %s canonical submission, hold and reveal facts without content",
    (author_role) => {
      for (const submission_state of ["allowed", "held", "expired"] as const) {
        for (const revealed of [false, true]) {
          const row = {
            author_role,
            eligible_at: "2026-04-01 00:00:00+00",
            effective_deadline_at: "2026-06-01 00:00:00+00",
            submission_state,
            held: submission_state === "held",
            active_review_id: "rev_1",
            active_review_revealed_at: revealed ? "2026-04-03 00:00:00+00" : null,
            feedback: "private",
            rating: 5,
            response: "private",
          };
          expect(opportunitySlot(row)).toEqual({
            authorRole: author_role,
            eligibleAt: "2026-04-01T00:00:00.000Z",
            effectiveDeadlineAt: "2026-06-01T00:00:00.000Z",
            submissionState: submission_state,
            held: submission_state === "held",
            activeReviewId: "rev_1",
            activeReviewRevealedAt: revealed ? "2026-04-03T00:00:00.000Z" : null,
          });
        }
      }
    },
  );
});
