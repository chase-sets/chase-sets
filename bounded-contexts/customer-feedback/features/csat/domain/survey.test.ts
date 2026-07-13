import { describe, expect, it } from "vitest";
import {
  csatRatingScaleV1,
  findSurveyDefinition,
  legacyExperienceRatingV0,
  reservedFutureSurveyKinds,
  surveyDefinitionRegistry,
  surveyKinds,
  surveyVersionsCsatComparable,
  surveyVersionsEqual,
  transactionalCsatV1,
} from "./survey";

describe("survey kinds", () => {
  it("only transactional-csat and legacy-experience-rating are real kinds", () => {
    expect(surveyKinds).toEqual(["transactional-csat", "legacy-experience-rating"]);
  });

  it("keeps future instrument families out of the SurveyKind union", () => {
    for (const reserved of reservedFutureSurveyKinds) {
      expect((surveyKinds as readonly string[]).includes(reserved)).toBe(false);
    }
  });
});

describe("v1 CSAT instrument", () => {
  it("has a 1-5 scale, satisfied threshold 4, and NO default selection", () => {
    expect(csatRatingScaleV1.min).toBe(1);
    expect(csatRatingScaleV1.max).toBe(5);
    expect(csatRatingScaleV1.satisfiedThreshold).toBe(4);
    expect(csatRatingScaleV1.defaultSelection).toBeNull();
  });

  it("gives every value a semantic label key and both endpoints an anchor key", () => {
    expect(Object.keys(csatRatingScaleV1.valueLabelKeys)).toHaveLength(5);
    expect(csatRatingScaleV1.anchors.lowLabelKey).toContain("customer-feedback.csat.scale.anchor");
    expect(csatRatingScaleV1.anchors.highLabelKey).toContain("customer-feedback.csat.scale.anchor");
  });

  it("is CSAT-eligible", () => {
    expect(transactionalCsatV1.csatEligible).toBe(true);
  });
});

describe("survey version identity", () => {
  it("legacy instrument is never CSAT-eligible", () => {
    expect(legacyExperienceRatingV0.csatEligible).toBe(false);
  });

  it("resolves a definition by full version identity", () => {
    expect(findSurveyDefinition(transactionalCsatV1.id)).toEqual(transactionalCsatV1);
    expect(findSurveyDefinition(legacyExperienceRatingV0.id)).toEqual(legacyExperienceRatingV0);
  });

  it("treats different question versions as not equal and not CSAT-comparable", () => {
    const other = { ...transactionalCsatV1.id, questionVersion: "csat.q.v2" };
    expect(surveyVersionsEqual(transactionalCsatV1.id, other)).toBe(false);
    expect(surveyVersionsCsatComparable(transactionalCsatV1.id, other)).toBe(false);
  });

  it("never treats legacy versions as CSAT-comparable", () => {
    expect(surveyVersionsCsatComparable(legacyExperienceRatingV0.id, legacyExperienceRatingV0.id)).toBe(false);
  });

  it("registry contains exactly the v1 CSAT and legacy v0 instruments", () => {
    expect(surveyDefinitionRegistry).toEqual([transactionalCsatV1, legacyExperienceRatingV0]);
  });
});
