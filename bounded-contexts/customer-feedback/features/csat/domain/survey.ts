/**
 * Survey identity: KIND + VERSION.
 *
 * A survey response is only ever interpretable in the context of the exact
 * instrument version that produced it. Customer Feedback pins every response to
 * a (surveyKind, surveyVersion, questionVersion) identity so that:
 *   - CSAT is only ever computed over one comparable instrument version, and
 *   - other instrument families (legacy generic ratings, and future
 *     experience-pulse / CES / NPS / public-review kinds) can never be mixed in.
 *
 * This module is the canonical, versioned survey registry for the context and is
 * consumed by the invitation, recording/CSAT, and dashboard slices via the
 * `./server` barrel.
 */

/** The instrument family a response belongs to. Only `transactional-csat` feeds CSAT. */
export const surveyKinds = ["transactional-csat", "legacy-experience-rating"] as const;
export type SurveyKind = (typeof surveyKinds)[number];

/**
 * Instrument families reserved for future work and DELIBERATELY excluded from the
 * `SurveyKind` union so their data can never be typed into a CSAT calculation.
 * These are non-goals of the current capability: NPS, CES, public reviews, experience
 * pulse. Kept here as a documented allow-list, never as a `SurveyKind`.
 */
export const reservedFutureSurveyKinds = ["experience-pulse", "ces", "nps", "public-review"] as const;
export type ReservedFutureSurveyKind = (typeof reservedFutureSurveyKinds)[number];

/** Stable instrument version tag, e.g. `csat.v1`. Bumped on any answer-scale change. */
export type SurveyVersionTag = string;
/** Localized prompt/question copy version tag, e.g. `csat.q.v1`. Bumped on copy change. */
export type QuestionVersionTag = string;

/** The full identity of a survey instrument version. */
export type SurveyVersionId = Readonly<{
  surveyKind: SurveyKind;
  surveyVersion: SurveyVersionTag;
  questionVersion: QuestionVersionTag;
}>;

export type CsatRatingValue = 1 | 2 | 3 | 4 | 5;
export const csatRatingValues = [1, 2, 3, 4, 5] as const satisfies readonly CsatRatingValue[];

/**
 * The 1–5 answer scale contract. Encodes the accessibility/UX requirements as data
 * so the (later) design-system rating component renders from a single source of
 * truth: visible endpoint anchors, a semantic label for every value, and — the
 * critical anti-bias rule — no preselected answer (`defaultSelection: null`).
 * A submission is impossible until a value is deliberately chosen.
 */
export type CsatRatingScale = Readonly<{
  min: 1;
  max: 5;
  /** Ratings at or above this value count as "satisfied" (the CSAT numerator). */
  satisfiedThreshold: 4;
  /** The input starts unanswered; there is no default rating (AC5). */
  defaultSelection: null;
  /** Localization keys for the meaningful endpoint anchors (AC6). */
  anchors: Readonly<{ lowLabelKey: string; highLabelKey: string }>;
  /** Localization keys giving each of the five values an accessible semantic label (AC6). */
  valueLabelKeys: Readonly<Record<CsatRatingValue, string>>;
}>;

/** A fully-specified survey instrument definition owned by Customer Feedback. */
export type SurveyDefinition = Readonly<{
  id: SurveyVersionId;
  /** Localization key for the anchored, workflow-agnostic question copy. */
  questionCopyKey: string;
  ratingScale: CsatRatingScale;
  /**
   * Whether responses to this instrument are eligible for the CSAT calculation.
   * Only `transactional-csat` instruments are eligible; legacy and future kinds
   * are structurally excluded from the numerator and denominator.
   */
  csatEligible: boolean;
  /** Follow-up consent copy is versioned independently of the question (AC). */
  followUpConsentVersion: string;
  followUpConsentStatement: string;
  followUpConsentPurpose: "case-specific-follow-up";
  followUpConsentApplicability: "this-response-only";
}>;

export const csatRatingScaleV1: CsatRatingScale = {
  min: 1,
  max: 5,
  satisfiedThreshold: 4,
  defaultSelection: null,
  anchors: {
    lowLabelKey: "customer-feedback.csat.scale.anchor.low",
    highLabelKey: "customer-feedback.csat.scale.anchor.high",
  },
  valueLabelKeys: {
    1: "customer-feedback.csat.scale.value.1",
    2: "customer-feedback.csat.scale.value.2",
    3: "customer-feedback.csat.scale.value.3",
    4: "customer-feedback.csat.scale.value.4",
    5: "customer-feedback.csat.scale.value.5",
  },
};

/** The launch v1 transactional-CSAT instrument. This is the single CSAT question. */
export const transactionalCsatV1: SurveyDefinition = {
  id: { surveyKind: "transactional-csat", surveyVersion: "csat.v1", questionVersion: "csat.q.v1" },
  questionCopyKey: "customer-feedback.csat.question.v1",
  ratingScale: csatRatingScaleV1,
  csatEligible: true,
  followUpConsentVersion: "follow-up-consent.v1",
  followUpConsentStatement: "Chase Sets may contact me about this feedback response.",
  followUpConsentPurpose: "case-specific-follow-up",
  followUpConsentApplicability: "this-response-only",
};

/**
 * The synthetic, non-CSAT instrument that legacy generic 1–5 ratings are mapped
 * to. See `./legacy`. It exists so every legacy submission has an explicit,
 * inspectable survey identity that is `csatEligible: false` — legacy ratings can
 * never silently enter CSAT.
 */
export const legacyExperienceRatingV0: SurveyDefinition = {
  id: {
    surveyKind: "legacy-experience-rating",
    surveyVersion: "legacy-experience-rating.v0",
    questionVersion: "legacy.unversioned",
  },
  questionCopyKey: "customer-feedback.legacy.question.v0",
  ratingScale: csatRatingScaleV1,
  csatEligible: false,
  followUpConsentVersion: "legacy.unversioned",
  followUpConsentStatement: "No affirmative follow-up consent was captured.",
  followUpConsentPurpose: "case-specific-follow-up",
  followUpConsentApplicability: "this-response-only",
};

/** The canonical, versioned survey registry owned by Customer Feedback. */
export const surveyDefinitionRegistry = [transactionalCsatV1, legacyExperienceRatingV0] as const;

export function surveyVersionKey(id: SurveyVersionId): string {
  return `${id.surveyKind}:${id.surveyVersion}:${id.questionVersion}`;
}

export function surveyVersionsEqual(a: SurveyVersionId, b: SurveyVersionId): boolean {
  return surveyVersionKey(a) === surveyVersionKey(b);
}

export function findSurveyDefinition(id: SurveyVersionId): SurveyDefinition | null {
  return surveyDefinitionRegistry.find((definition) => surveyVersionsEqual(definition.id, id)) ?? null;
}

/**
 * Two survey versions may be combined in a single CSAT figure only when they are
 * the identical `transactional-csat` version. Different question versions or
 * different kinds are never comparable (epic metric contract).
 */
export function surveyVersionsCsatComparable(a: SurveyVersionId, b: SurveyVersionId): boolean {
  return a.surveyKind === "transactional-csat" && surveyVersionsEqual(a, b);
}
