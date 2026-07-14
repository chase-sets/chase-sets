/**
 * Legacy platform-feedback migrate-vs-reset decision — IMPLEMENTED.
 *
 * Decision: MIGRATE (transform), do NOT reset.
 *
 * The pre-existing `experience.platform-feedback.*` events remain in place and
 * replayable (event-sourced systems never delete events, and the migration must not break
 * their replay). Rather than discard them, Customer Feedback classifies every
 * legacy generic 1–5 rating under an explicit, inspectable survey kind —
 * `legacy-experience-rating` (v0) — which is `csatEligible: false`.
 *
 * Because `calculateCsat` only counts CSAT-eligible `transactional-csat`
 * submissions of a matching survey version, a legacy rating is STRUCTURALLY unable
 * to enter the CSAT numerator or denominator. The exclusion is enforced by the
 * type/data model, not by convention.
 */
import type { SurveyVersionId } from "./survey";
import { legacyExperienceRatingV0 } from "./survey";

/** The legacy generic-feedback event type strings (owned by platform-operations). */
export const legacyExperienceFeedbackEventTypes = [
  "experience.platform-feedback.submitted",
  "experience.platform-feedback.prompt-dismissed",
  "experience.platform-feedback.reviewed",
  "experience.platform-feedback.archived",
  "experience.platform-feedback.operator-note-recorded",
] as const;
export type LegacyExperienceFeedbackEventType = (typeof legacyExperienceFeedbackEventTypes)[number];

export function isLegacyExperienceFeedbackEventType(type: string): type is LegacyExperienceFeedbackEventType {
  return (legacyExperienceFeedbackEventTypes as readonly string[]).includes(type);
}

/**
 * The result of classifying a legacy rating: it always carries the non-CSAT
 * `legacy-experience-rating` survey version and `csatEligible: false`. The rating
 * is preserved when it is a valid 1–5 integer, otherwise `null`.
 */
export type LegacyExperienceRatingClassification = Readonly<{
  surveyVersion: SurveyVersionId;
  csatEligible: false;
  rating: 1 | 2 | 3 | 4 | 5 | null;
}>;

export function classifyLegacyExperienceRating(
  legacyRating: number | null | undefined,
): LegacyExperienceRatingClassification {
  const rating =
    typeof legacyRating === "number" && Number.isInteger(legacyRating) && legacyRating >= 1 && legacyRating <= 5
      ? (legacyRating as 1 | 2 | 3 | 4 | 5)
      : null;

  return {
    surveyVersion: legacyExperienceRatingV0.id,
    csatEligible: false,
    rating,
  };
}
