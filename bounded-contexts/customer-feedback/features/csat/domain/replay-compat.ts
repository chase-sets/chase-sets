/**
 * Versioned event / replay-compatibility base for the Customer Feedback context.
 *
 * This codebase has no event-envelope schema-version field or upcaster registry;
 * event versioning is done at the codec `decode` seam and with additive-optional
 * payload fields. This module is the shared classifier that the downstream
 * invitation and recording aggregates wrap into their
 * codecs so that, on replay:
 *
 *   - native `customer-feedback.*` events are recognized and carry an explicit
 *     `eventSchemaVersion` (defaulting to v1 for events written before the field
 *     existed);
 *   - legacy `experience.platform-feedback.*` events are mapped to the non-CSAT
 *     `legacy-experience-rating` classification (the migrate-not-reset decision),
 *     so they replay safely and can never enter CSAT;
 *   - anything else is surfaced as `unrecognized` rather than silently dropped,
 *     which keeps deploy-skew failures visible instead of corrupting metrics.
 */
import {
  classifyLegacyExperienceRating,
  isLegacyExperienceFeedbackEventType,
  type LegacyExperienceRatingClassification,
} from "./legacy";
import { customerFeedbackEventSchemaVersion } from "./invitation";

/** The minimal stored-event shape the classifier needs (matches the codec seam). */
export type StoredFeedbackEventInput = Readonly<{
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export type ReplayClassification =
  | Readonly<{ kind: "native"; eventType: string; eventSchemaVersion: number }>
  | Readonly<{
      kind: "legacy-experience-rating";
      eventType: string;
      classification: LegacyExperienceRatingClassification;
    }>
  | Readonly<{ kind: "unrecognized"; eventType: string }>;

export const customerFeedbackNativeEventPrefix = "customer-feedback." as const;

export function classifyStoredFeedbackEvent(stored: StoredFeedbackEventInput): ReplayClassification {
  if (stored.eventType.startsWith(customerFeedbackNativeEventPrefix)) {
    const version = stored.payload.eventSchemaVersion;
    return {
      kind: "native",
      eventType: stored.eventType,
      eventSchemaVersion: typeof version === "number" ? version : customerFeedbackEventSchemaVersion,
    };
  }

  if (isLegacyExperienceFeedbackEventType(stored.eventType)) {
    const rawRating = stored.payload.rating;
    return {
      kind: "legacy-experience-rating",
      eventType: stored.eventType,
      classification: classifyLegacyExperienceRating(typeof rawRating === "number" ? rawRating : null),
    };
  }

  return { kind: "unrecognized", eventType: stored.eventType };
}
