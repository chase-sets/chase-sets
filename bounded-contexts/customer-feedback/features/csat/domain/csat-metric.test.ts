import { describe, expect, it } from "vitest";
import { calculateCsat, calculateResponseRate, csatSatisfiedThreshold, type CsatSubmittedRating } from "./csat-metric";
import { legacyExperienceRatingV0, transactionalCsatV1, type SurveyVersionId } from "./survey";

const csatV1: SurveyVersionId = transactionalCsatV1.id;

function csatRating(rating: 1 | 2 | 3 | 4 | 5): CsatSubmittedRating {
  return { surveyVersion: csatV1, csatEligible: true, rating, submittedAt: "2026-07-13T00:00:00.000Z" };
}

describe("calculateCsat", () => {
  it("counts ratings of 4 or 5 as satisfied over all submitted ratings for the version", () => {
    const score = calculateCsat({
      surveyVersion: csatV1,
      window: "trailing-7d",
      ratings: [csatRating(5), csatRating(4), csatRating(3), csatRating(1)],
      minimumSampleSize: 2,
    });

    expect(score.satisfiedCount).toBe(2);
    expect(score.submittedCount).toBe(4);
    expect(score.csat).toBe(0.5);
    expect(score.sampleSufficient).toBe(true);
  });

  it("returns null CSAT (not zero) when the denominator is empty", () => {
    const score = calculateCsat({ surveyVersion: csatV1, window: "trailing-30d", ratings: [] });
    expect(score.submittedCount).toBe(0);
    expect(score.csat).toBeNull();
    expect(score.sampleSufficient).toBe(false);
  });

  it("uses 4 as the satisfied threshold", () => {
    expect(csatSatisfiedThreshold).toBe(4);
  });

  it("EXCLUDES legacy-experience-rating submissions from both numerator and denominator", () => {
    const legacyRating: CsatSubmittedRating = {
      surveyVersion: legacyExperienceRatingV0.id,
      csatEligible: false,
      rating: 5,
      submittedAt: "2026-07-13T00:00:00.000Z",
    };

    const score = calculateCsat({
      surveyVersion: csatV1,
      window: "trailing-7d",
      ratings: [csatRating(5), legacyRating, legacyRating, legacyRating],
      minimumSampleSize: 1,
    });

    // Only the single transactional-csat rating counts; the three legacy 5s never enter CSAT.
    expect(score.submittedCount).toBe(1);
    expect(score.satisfiedCount).toBe(1);
    expect(score.csat).toBe(1);
  });

  it("never mixes an incompatible question version into the same figure", () => {
    const incompatibleVersion: CsatSubmittedRating = {
      surveyVersion: { surveyKind: "transactional-csat", surveyVersion: "csat.v1", questionVersion: "csat.q.v2" },
      csatEligible: true,
      rating: 1,
      submittedAt: "2026-07-13T00:00:00.000Z",
    };

    const score = calculateCsat({
      surveyVersion: csatV1,
      window: "trailing-7d",
      ratings: [csatRating(5), incompatibleVersion],
      minimumSampleSize: 1,
    });

    expect(score.submittedCount).toBe(1);
    expect(score.csat).toBe(1);
  });
});

describe("calculateResponseRate", () => {
  it("divides unique submitted invitations by unique presented invitations", () => {
    const rate = calculateResponseRate("trailing-7d", { presentedCount: 200, submittedCount: 50 });
    expect(rate.responseRate).toBe(0.25);
  });

  it("returns null when nothing was presented", () => {
    const rate = calculateResponseRate("trailing-30d", { presentedCount: 0, submittedCount: 0 });
    expect(rate.responseRate).toBeNull();
  });
});
