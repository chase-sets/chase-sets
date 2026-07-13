import { describe, expect, it } from "vitest";
import { calculateCsat, type CsatSubmittedRating } from "./csat-metric";
import { transactionalCsatV1 } from "./survey";
import { classifyStoredFeedbackEvent } from "./replay-compat";

describe("classifyStoredFeedbackEvent (versioned replay-compat base)", () => {
  it("recognizes native customer-feedback events and reads their schema version", () => {
    const result = classifyStoredFeedbackEvent({
      eventType: "customer-feedback.invitation.issued",
      payload: { eventSchemaVersion: 1, invitationId: "csatinv_1" },
    });
    expect(result.kind).toBe("native");
    if (result.kind === "native") {
      expect(result.eventSchemaVersion).toBe(1);
    }
  });

  it("defaults native events with no explicit version to v1 (replay of pre-field events)", () => {
    const result = classifyStoredFeedbackEvent({
      eventType: "customer-feedback.survey.submitted",
      payload: { invitationId: "csatinv_1" },
    });
    expect(result.kind).toBe("native");
    if (result.kind === "native") {
      expect(result.eventSchemaVersion).toBe(1);
    }
  });

  it("maps legacy platform-feedback submissions to the non-CSAT legacy kind (migrate, not reset)", () => {
    const result = classifyStoredFeedbackEvent({
      eventType: "experience.platform-feedback.submitted",
      payload: { feedbackId: "fb_1", rating: 5 },
    });
    expect(result.kind).toBe("legacy-experience-rating");
    if (result.kind === "legacy-experience-rating") {
      expect(result.classification.csatEligible).toBe(false);
      expect(result.classification.surveyVersion.surveyKind).toBe("legacy-experience-rating");
      expect(result.classification.rating).toBe(5);
    }
  });

  it("guarantees a migrated legacy 5 can never enter CSAT", () => {
    const result = classifyStoredFeedbackEvent({
      eventType: "experience.platform-feedback.submitted",
      payload: { rating: 5 },
    });
    if (result.kind !== "legacy-experience-rating") {
      throw new Error("expected legacy classification");
    }
    const migrated: CsatSubmittedRating = {
      surveyVersion: result.classification.surveyVersion,
      csatEligible: result.classification.csatEligible,
      rating: result.classification.rating ?? 5,
      submittedAt: "2026-07-13T00:00:00.000Z",
    };

    const score = calculateCsat({
      surveyVersion: transactionalCsatV1.id,
      window: "trailing-30d",
      ratings: [migrated],
      minimumSampleSize: 1,
    });

    expect(score.submittedCount).toBe(0);
    expect(score.csat).toBeNull();
  });

  it("surfaces unknown event types instead of silently dropping them", () => {
    const result = classifyStoredFeedbackEvent({ eventType: "ordering.order.created", payload: {} });
    expect(result.kind).toBe("unrecognized");
  });
});
