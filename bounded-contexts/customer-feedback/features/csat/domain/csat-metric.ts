/**
 * The CSAT and response-rate calculation contract.
 *
 * This is the metric authority for the epic. It fixes:
 *   - CSAT = submitted ratings of 4 or 5 divided by ALL submitted ratings for the
 *     SAME survey version and filter set;
 *   - response rate = unique submitted invitations divided by unique presented
 *     invitations (the presentation denominator);
 *   - the trailing 7-day and 30-day operating windows;
 *   - the hard rule that other instrument kinds and incompatible question
 *     versions are NEVER mixed into the numerator or denominator.
 *
 * The analytics slice feeds projected submissions/presentations into these pure functions; the
 * exclusion of non-CSAT data is enforced structurally, not by convention.
 */
import type { SurveyVersionId } from "./survey";
import { surveyVersionsCsatComparable } from "./survey";

export const csatWindows = ["trailing-7d", "trailing-30d"] as const;
export type CsatWindow = (typeof csatWindows)[number];

/** A single submitted rating — the atom the CSAT calculation consumes. */
export type CsatSubmittedRating = Readonly<{
  surveyVersion: SurveyVersionId;
  /** Whether the instrument that produced this rating is CSAT-eligible. */
  csatEligible: boolean;
  rating: 1 | 2 | 3 | 4 | 5;
  submittedAt: string;
}>;

export type CsatScore = Readonly<{
  surveyVersion: SurveyVersionId;
  window: CsatWindow;
  /** Ratings of 4 or 5. */
  satisfiedCount: number;
  /** All CSAT-eligible submitted ratings for the same survey version (denominator). */
  submittedCount: number;
  /** `satisfiedCount / submittedCount`, or `null` when the denominator is 0. */
  csat: number | null;
  /** Whether the sample is large enough for the score to be trustworthy. */
  sampleSufficient: boolean;
}>;

export type CalculateCsatInput = Readonly<{
  surveyVersion: SurveyVersionId;
  window: CsatWindow;
  ratings: readonly CsatSubmittedRating[];
  /** Minimum submissions before the score is considered sufficient. */
  minimumSampleSize?: number;
}>;

export const csatSatisfiedThreshold = 4 as const;
export const csatDefaultMinimumSampleSize = 20 as const;

/**
 * Compute CSAT for one survey version over a window. Only ratings that are
 * `csatEligible` AND share the requested `transactional-csat` survey version are
 * counted; every other rating (legacy, future kinds, incompatible question
 * versions) is dropped from BOTH numerator and denominator. A zero denominator
 * yields `csat: null` (unknowable, never 0%).
 */
export function calculateCsat(input: CalculateCsatInput): CsatScore {
  const minimum = input.minimumSampleSize ?? csatDefaultMinimumSampleSize;
  const eligible = input.ratings.filter(
    (rating) => rating.csatEligible && surveyVersionsCsatComparable(rating.surveyVersion, input.surveyVersion),
  );
  const submittedCount = eligible.length;
  const satisfiedCount = eligible.filter((rating) => rating.rating >= csatSatisfiedThreshold).length;

  return {
    surveyVersion: input.surveyVersion,
    window: input.window,
    satisfiedCount,
    submittedCount,
    csat: submittedCount === 0 ? null : satisfiedCount / submittedCount,
    sampleSufficient: submittedCount >= minimum,
  };
}

/** The presentation denominator inputs for response rate. */
export type ResponseRateDenominator = Readonly<{
  /** Count of unique presented invitations. */
  presentedCount: number;
  /** Count of unique submitted invitations. */
  submittedCount: number;
}>;

export type ResponseRate = Readonly<{
  window: CsatWindow;
  presentedCount: number;
  submittedCount: number;
  /** `submittedCount / presentedCount`, or `null` when nothing was presented. */
  responseRate: number | null;
}>;

/** Response rate = unique submitted invitations / unique presented invitations. */
export function calculateResponseRate(window: CsatWindow, denominator: ResponseRateDenominator): ResponseRate {
  const { presentedCount, submittedCount } = denominator;
  return {
    window,
    presentedCount,
    submittedCount,
    responseRate: presentedCount === 0 ? null : submittedCount / presentedCount,
  };
}
