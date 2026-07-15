/**
 * Feedback-into-resolution funnel policy and privacy-safe analytics.
 *
 * When a buyer is about to leave feedback that signals an unresolved order
 * problem, the review flow offers the order-resolution path first so payment
 * protections and remedy workflows can operate. The trigger threshold lives in
 * one named constant so a product change never fans out into ad hoc branches.
 */

/** Ratings at or below this value route a buyer into resolution first. */
export const LOW_RATING_RESOLUTION_THRESHOLD = 2;

/**
 * Structured problem indicators a buyer can select. Each maps to a canonical
 * order-issue intake flow; selecting any of them routes to resolution first
 * regardless of the star rating. Free-text sentiment is never inspected.
 */
export const REVIEW_PROBLEM_CATEGORIES = [
  "not-received",
  "damaged",
  "not-as-described",
  "missing-items",
  "authenticity",
  "other",
] as const;

export type ReviewProblemCategory = (typeof REVIEW_PROBLEM_CATEGORIES)[number];

/**
 * Problem category to order-issue intake flow. The flow strings are the intake
 * surface's public query contract (`/account/support?flow=...`); they are not
 * imported across contexts so the funnel stays a thin handoff.
 */
const PROBLEM_CATEGORY_INTAKE_FLOW: Readonly<Record<ReviewProblemCategory, string>> = {
  "not-received": "product-not-received",
  damaged: "product-damaged",
  "not-as-described": "product-not-as-described",
  "missing-items": "missing-products",
  authenticity: "authenticity-concern",
  other: "return-request",
};

export function isReviewProblemCategory(value: string): value is ReviewProblemCategory {
  return (REVIEW_PROBLEM_CATEGORIES as readonly string[]).includes(value);
}

export function intakeFlowForProblemCategory(category: ReviewProblemCategory): string {
  return PROBLEM_CATEGORY_INTAKE_FLOW[category];
}

/**
 * The routing decision: a low rating, or any structured problem indicator,
 * sends the buyer into resolution first. Sentiment in free text is ignored.
 */
export function shouldRouteToResolution(input: {
  rating: number;
  problemCategories: readonly ReviewProblemCategory[];
}): boolean {
  return input.rating <= LOW_RATING_RESOLUTION_THRESHOLD || input.problemCategories.length > 0;
}

/** Why the routing decision fired, for privacy-safe analytics only. */
export function resolutionTriggerReason(input: {
  rating: number;
  problemCategories: readonly ReviewProblemCategory[];
}): "low-rating" | "problem-indicator" | "low-rating-and-problem-indicator" | "none" {
  const lowRating = input.rating <= LOW_RATING_RESOLUTION_THRESHOLD;
  const hasProblem = input.problemCategories.length > 0;
  if (lowRating && hasProblem) {
    return "low-rating-and-problem-indicator";
  }
  if (lowRating) {
    return "low-rating";
  }
  if (hasProblem) {
    return "problem-indicator";
  }
  return "none";
}

/**
 * Privacy-safe funnel events. Names describe the step only; review text,
 * evidence, and private case facts are never included in properties.
 */
export const reviewResolutionEventNames = [
  "review_resolution_interstitial_shown",
  "review_resolution_resolve_first_selected",
  "review_resolution_feedback_only_selected",
  "review_resolution_case_routed",
  "review_resolution_existing_case_routed",
  "review_resolution_intake_unavailable",
  "review_resolution_draft_resumed",
  "review_resolution_abandoned",
] as const;

export type ReviewResolutionEventName = (typeof reviewResolutionEventNames)[number];

export type ReviewResolutionEventProperties = Readonly<Record<string, string | number | boolean | null | undefined>>;

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
  }
}

export const REVIEW_RESOLUTION_ANALYTICS_EVENT = "chase-sets:review-resolution-analytics";

/**
 * Emit a privacy-safe funnel event. Callers must pass only category labels,
 * booleans, and counts — never review content or private support information.
 */
export function trackReviewResolutionEvent(
  name: ReviewResolutionEventName,
  properties: ReviewResolutionEventProperties = {},
) {
  if (typeof window === "undefined") {
    return;
  }

  const detail = { event: name, ...properties };
  window.dispatchEvent(new CustomEvent(REVIEW_RESOLUTION_ANALYTICS_EVENT, { detail }));
  window.dataLayer?.push(detail);
}
